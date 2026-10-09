import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-lisp-input-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_CLI_LANG = 'en'
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal }, { Box, render, AlternateScreen },
  { PromptInput }, { PromptEditorLayer }, { LOCAL_COMMANDS }, { createCommandCompletions }, { sleep, settled, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/PromptInput.js'), import('../src/components/PromptEditor.js'),
  import('../src/commands.js'), import('../src/dsh-adapter/channel/command-completions.js'), import('./lib/term-test.mjs'),
])
import type { PromptController } from '../src/components/PromptInput.js'

const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
class Output extends Writable {
  columns = 100; rows = 30; isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new Input()
const commands: string[] = []
const model: string[] = []
const notifications: string[] = []
const controller = { current: null as PromptController | null }
let generation = 0
let completionsEnabled = false
let outcome: () => boolean | Promise<boolean> = () => Promise.resolve(true)
const channel = {
  mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
  commandList: [...LOCAL_COMMANDS, { name: 'kioku-lisp', description: 'Lisp controls', external: true }],
  commandCompletions: (input: string) => completionsEnabled ? complete(input) : [], stagedImageGeneration: () => generation, notifications: [], pending: [], working: true,
  notify(text: string) { notifications.push(text) },
  submit(text: string) { model.push(text) }, steer(text: string) { model.push(text) },
  interruptAndDeliver(items: { text: string }[]) { model.push(...items.map(x => x.text)); return items.length },
  removePending() { return false }, listFiles: async () => [], sessionColor: '',
}
const complete = createCommandCompletions({ state: () => channel as never, themeHost: undefined as never, workspaceCommands: () => [], model: { warmModelNodes() {}, modelNodes: () => [], warmPresetOptions() {}, presetOptions: () => [], warmEffortLevels() {} } })
const app = await render(<AlternateScreen><Box height={30} justifyContent="flex-end" flexDirection="column">
  <PromptInput channel={channel as never} helpOpen={false} onToggleHelp={() => {}}
    onRunCommand={(name, raw) => { commands.push(name + raw); return outcome() }}
    selectionActive={false} controllerRef={controller} />
  <PromptEditorLayer />
</Box></AlternateScreen>, { stdout: new Output(), stderr: new Output(), stdin, exitOnCtrlC: false, patchConsole: false })

try {
  assert.ok(await settled(() => controller.current !== null))
  controller.current!.append('/kioku-lisp cancel')
  assert.ok(await settled(() => controller.current!.text() === '/kioku-lisp cancel'))
  stdin.write('\r')
  assert.ok(await settled(() => commands.length + model.length > 0))
  assert.deepEqual(model, [], 'running cancel must never be delivered to the model')
  assert.deepEqual(commands, ['kioku-lisp cancel'], 'running cancel must execute exactly once')
  assert.ok(await settled(() => !controller.current!.hasText()))
  console.log('PASS: running cancel executes once without model input')

  const draft = async (text: string) => {
    controller.current!.clear()
    controller.current!.append(text)
    assert.ok(await settled(() => controller.current!.text() === text))
    await sleep(100) // 固定窗:墙钟 Enter debounce and completion repaint
  }
  const send = async (text: string, key = '\r') => {
    const n = commands.length
    await draft(text)
    stdin.write(key)
    assert.ok(await settled(() => commands.length === n + 1), text)
    assert.ok(await settled(() => !controller.current!.hasText()), text)
    assert.deepEqual(model, [], text)
  }
  for (const action of ['', 'status', 'diagnostics op-id', 'hot', 'cancel', 'recover']) {
    await send('/kioku-lisp' + (action ? ' ' + action : ''))
  }
  await send('/kioku-lisp cancel', '\x1b[13;5u')
  await send('/kioku-lisp cancel', '\x1b[13;9u')
  await draft('/kioku-lisp cancel')
  stdin.write('\x1b[69;6u')
  assert.ok(await settled(() => viewportLines(term).some(x => x.includes('Draft editor'))))
  const beforeEditor = commands.length
  stdin.write('\x1b[13;5u')
  assert.ok(await settled(() => commands.length === beforeEditor + 1))
  assert.ok(await settled(() => !controller.current!.hasText()))

  // The expanded Send button shares command routing for both allowed and blocked actions.
  for (const action of ['cancel', 'disable']) {
    await draft('/kioku-lisp ' + action)
    assert.ok(await settled(() => !viewportLines(term).some(x => x.includes('Draft editor'))))
    stdin.write('\x1b[69;6u')
    assert.ok(await settled(() => viewportLines(term).some(x => x.includes('Draft editor'))))
    await sleep(600) // 固定窗:墙钟 separate clicks beyond the terminal multi-click selection window
    const editorLines = viewportLines(term)
    const buttonRow = editorLines.findIndex(x => x.includes('Send'))
    assert.ok(buttonRow >= 0)
    const buttonCol = editorLines[buttonRow]!.indexOf('Send')
    const count = commands.length, notices = notifications.length
    stdin.write(`\x1b[<0;${buttonCol + 1};${buttonRow + 1}M\x1b[<0;${buttonCol + 1};${buttonRow + 1}m`)
    if (action === 'cancel') {
      assert.ok(await settled(() => commands.length === count + 1))
      assert.ok(await settled(() => !controller.current!.hasText()))
    } else {
      assert.ok(await settled(() => notifications.length > notices), JSON.stringify({ commands: commands.slice(-3), model, screen: viewportLines(term), draft: controller.current!.text() }))
      assert.equal(commands.length, count)
      assert.equal(controller.current!.text(), '/kioku-lisp disable')
    }
    assert.deepEqual(model, [])
  }
  controller.current!.clear()

  for (const action of ['enable', 'enable-task', 'disable', 'abandon', 'restore', 'unknown']) {
    for (const key of ['\r', '\x1b[13;5u']) {
      await draft('/kioku-lisp ' + action)
      const n = commands.length, notices = notifications.length
      stdin.write(key)
      assert.ok(await settled(() => notifications.length > notices))
      assert.equal(commands.length, n)
      assert.equal(controller.current!.text(), '/kioku-lisp ' + action)
      assert.deepEqual(model, [])
    }
  }
  // Piped complete lines preserve rejected input and use the command route.
  controller.current!.clear()
  stdin.write('/kioku-lisp disable\n')
  assert.ok(await settled(() => controller.current!.text() === '/kioku-lisp disable'))
  await sleep(150) // 固定窗:探针 rejected operation must have no delayed effects
  assert.deepEqual(model, [])
  controller.current!.clear()
  const beforePipe = commands.length
  stdin.write('/kioku-lisp cancel\n')
  assert.ok(await settled(() => commands.length === beforePipe + 1))
  assert.ok(await settled(() => !controller.current!.hasText()))

  // Completion selection and pointer use exactly the same guard.
  completionsEnabled = true
  assert.deepEqual(complete('/kioku-lisp c').map(x => x.commandLine), ['/kioku-lisp cancel'])
  assert.equal(complete('/kioku-lisp diagnostics op-id').length, 0)
  const registeredCommands = channel.commandList
  channel.commandList = [...LOCAL_COMMANDS]
  assert.equal(complete('/kioku-lisp c').length, 0, 'absent plugins receive no Lisp subcommands')
  channel.commandList = [...LOCAL_COMMANDS, { name: 'kioku-lisp', description: 'Unrelated local command', external: false }]
  assert.equal(complete('/kioku-lisp c').length, 0, 'local names receive no Lisp subcommands')
  channel.commandList = registeredCommands
  await send('/kioku-lisp c')
  await draft('/kioku-lisp disable')
  const blockedCompletion = commands.length
  stdin.write('\r')
  await sleep(150) // 固定窗:探针 completion must not execute an idle-only action
  assert.equal(commands.length, blockedCompletion)
  assert.equal(controller.current!.text(), '/kioku-lisp disable')
  await draft('/kioku-lisp c')
  assert.ok(await settled(() => viewportLines(term).some(x => x.includes('Stop the current Lisp operation'))))
  const lines = viewportLines(term)
  const row = lines.findIndex(x => x.includes('Stop the current Lisp operation'))
  const col = lines[row]!.indexOf('Stop the current Lisp operation')
  const beforeClick = commands.length
  stdin.write(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
  assert.ok(await settled(() => commands.length === beforeClick + 1))
  assert.ok(await settled(() => !controller.current!.hasText()))

  // Admission failure keeps the draft, with no model fallback.
  outcome = () => Promise.resolve(false)
  await draft('/kioku-lisp cancel')
  const denied = commands.length
  stdin.write('\r')
  assert.ok(await settled(() => commands.length === denied + 1))
  await sleep(150) // 固定窗:探针 denial must preserve the draft
  assert.equal(controller.current!.text(), '/kioku-lisp cancel')
  assert.deepEqual(model, [])

  let finish!: (consume: boolean) => void
  outcome = () => new Promise(resolve => { finish = resolve })
  await draft('/kioku-lisp cancel')
  const duplicate = commands.length
  stdin.write('\r')
  assert.ok(await settled(() => commands.length === duplicate + 1))
  await sleep(100) // 固定窗:墙钟 debounce expires while the command is pending
  const noticeCount = notifications.length
  stdin.write('\x1b[13;5u')
  assert.ok(await settled(() => notifications.length > noticeCount))
  assert.equal(commands.length, duplicate + 1)
  // A replacement session's draft cannot be cleared by the old success.
  generation++
  await draft('replacement session draft')
  finish(true)
  await sleep(150) // 固定窗:探针 stale success must not clear the replacement draft
  assert.equal(controller.current!.text(), 'replacement session draft')
  assert.deepEqual(model, [])
  console.log('PASS: safe controls, all keyboard/pointer routes, idle guard, denial, duplicate and session fence')

} finally {
  await app.unmount()
  term.dispose()
  rmSync(home, { recursive: true, force: true })
}
