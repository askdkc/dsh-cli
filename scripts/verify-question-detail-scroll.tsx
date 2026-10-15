/**
 * Bounded generic question detail, through real Chat routing and QuestionStore.
 * Fullscreen + inline, normal + short terminals; newline and wide/CJK overflow,
 * keyboard/mouse ownership, custom-answer caret, fold, and fresh remounts.
 * Run: node --import tsx/esm scripts/verify-question-detail-scroll.tsx
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ComponentProps } from 'react'

// No project import may precede HOME isolation: preferences resolve at import.
const home = mkdtempSync(join(tmpdir(), 'verify-question-detail-scroll-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'
process.env.DSH_CLI_LANG = 'en'
const cleanupHome = () => rmSync(home, { recursive: true, force: true })
after(cleanupHome)
process.once('exit', cleanupHome)

const [React, { Terminal }, { render, ThemeProvider, AlternateScreen }, { Chat },
  { PageMargin }, { QuestionStore }, { ApprovalStore }, { TuiDialogStore },
  { settled, sleep, viewportLines, findText }, { getScrollDrainNode },
] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/components/PageMargin.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/dialogs.js'), import('./lib/term-test.mjs'),
  import('../src/ink/render-node-to-output.js'),
])

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const HOME = '\x1b[H'
const END = '\x1b[F'
const FOLD = '\x0b'
const ENTER = '\r'
const ESC = '\x1b'
const TAB = '\t'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const options = [{ label: 'APPROVE' }, { label: 'REVISE' }, { label: 'DECLINE' }]
const longMarkers = Array.from({ length: 97 }, (_, n) => `DETAIL-${String(n).padStart(3, '0')}`)
const longDetail = longMarkers.map(marker => `  "${marker}": "review this exact change",`).join('\n')
const wideMarkers = [...Array.from({ length: 240 }, (_, n) => `W${String(n).padStart(3, '0')}`), 'WEND']
const wideDetail = wideMarkers.slice(0, -1).map(marker => `${marker}${'漢字かな'.repeat(2)}`).join('') + 'WEND'

type Question = Parameters<InstanceType<typeof QuestionStore>['ask']>[0]['questions'][number]
function observe<T>(promise: Promise<T>) {
  const result: { done: boolean; value?: T; error?: unknown } = { done: false }
  void promise.then(
    value => { result.value = value; result.done = true },
    error => { result.error = error; result.done = true },
  )
  return result
}

async function mount(fullscreen: boolean, cols: number, rows: number) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  let pendingWrites = 0
  let synchronizedOutputOpen = false
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      pendingWrites++
      const data = String(chunk)
      term.write(data, () => {
        for (const match of data.matchAll(/\x1b\[\?2026([hl])/gu)) synchronizedOutputOpen = match[1] === 'h'
        pendingWrites--
        callback()
      })
    },
  }), { columns: cols, rows, isTTY: true })
  const stderr = Object.assign(new Writable({
    write(_chunk, _encoding, callback) { callback() },
  }), { isTTY: true })
  const questions = new QuestionStore()
  const approvals = new ApprovalStore()
  const dialogs = new TuiDialogStore()
  const channel = {
    version: 0,
    rows: Array.from({ length: 80 }, (_, id) => ({
      id, kind: 'assistant', text: `TRANSCRIPT-${String(id).padStart(3, '0')}`, fresh: false,
    })),
    status: 'idle', sessionTitle: 'question-detail-probe', agentId: 'question-detail-probe',
    model: 'deepseek-v4-flash', provider: 'deepseek',
    tokens: { input: 0, output: 0 }, cwd: home, displayCwd: home,
    working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    activityEnabled: false, contextBarEnabled: false, statusBar: {},
    turnStart: 0, lastUserText: '', pending: [], notifications: [],
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [], commandCompletions: () => [], subscribe: () => () => {},
    submit() {}, cancel() {}, clear() {}, notify() {}, pushLocal() {},
    listModels: async () => [], listSessions: async () => [], setResumeTarget() {},
    settingsHost: () => undefined, settingsSections: () => [],
    subscribeSettingsSections: () => () => {}, runExternalCommand: async () => undefined,
  } as unknown as ComponentProps<typeof Chat>['channel']
  const chat = React.createElement(Chat, {
    channel, questionStore: questions, approvalStore: approvals,
    extensionDialogs: dialogs, fullscreen, trajectorySeen: true, onExit() {},
  })
  const page = React.createElement(PageMargin, null, chat)
  const app = await render(React.createElement(ThemeProvider, {
    children: fullscreen ? React.createElement(AlternateScreen, null, page) : page,
  }), {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  const screen = () => viewportLines(term).join('\n')
  const compact = () => screen().replace(/\s/gu, '')
  const has = (text: string) => compact().includes(text.replace(/\s/gu, ''))
  const press = (key: string) => { stdin.write(key) }
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12000) => {
    // A page is drained across frames; wait for its final parsed frame.
    assert.ok(await settled(() => pendingWrites === 0 && !synchronizedOutputOpen && getScrollDrainNode() === null && predicate(), { timeoutMs }), `${label}\n${screen()}`)
  }
  const footerVisible = () => has('Custom answer') && has('Enter submit') && has('Esc cancel') && has('to fold')
  const controlsVisible = () => options.every(option => has(option.label)) && footerVisible()
  const assertControls = () => assert.ok(controlsVisible(), `options, custom field, and footer stay visible\n${screen()}`)
  const detailSnapshot = () => viewportLines(term).filter(line => /DETAIL-\d{3}/u.test(line)).join('\n')
  return {
    term, questions, screen, compact, has, press, waitFor, controlsVisible, footerVisible, assertControls, detailSnapshot,
    async open(detail?: string, extra: Partial<Question> = {}) {
      const result = observe(questions.ask({ questions: [{
        id: 'detail-question', question: 'QUESTION-BODY', options,
        ...(detail === undefined ? {} : { detail }), ...extra,
      }] }))
      await waitFor(() => has('QUESTION-BODY'), 'question appears', 180000)
      await waitFor(controlsVisible, 'detail must not push options or footer outside the viewport')
      return result
    },
    wheelAt(text: string, down: boolean, count = 1) {
      const point = findText(term, text)
      assert.ok(point, `wheel target ${text} must be visible\n${screen()}`)
      press(`\x1b[<${down ? 65 : 64};${point.col + 1};${point.row + 1}M`.repeat(count))
    },
    async dispose() {
      await app.unmount()
      questions.rejectAll()
      dialogs.settleAll()
      term.dispose()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    },
  }
}

type Harness = Awaited<ReturnType<typeof mount>>
async function pageThrough(h: Harness, markers: string[], down: boolean) {
  const seen = new Set<string>()
  const pages: string[] = []
  const markerPattern = markers[0]!.startsWith('DETAIL-') ? /DETAIL-\d{3}/gu : /W(?:\d{3}|END)/gu
  const visibleMarkers = () => h.compact().match(markerPattern)?.join(',') ?? ''
  const collect = () => {
    const current = h.compact()
    const visible = markers.filter(marker => current.includes(marker))
    pages.push(`${visible[0] ?? 'none'}..${visible.at(-1) ?? 'none'}`)
    for (const marker of visible) seen.add(marker)
  }
  const target = down ? markers.at(-1)! : markers[0]!
  collect()
  for (let page = 0; !h.has(target) && page < markers.length * 3; page++) {
    const before = visibleMarkers()
    h.press(down ? PAGE_DOWN : PAGE_UP)
    await h.waitFor(() => visibleMarkers() !== before, `${down ? 'PageDown' : 'PageUp'} advances detail`)
    h.assertControls()
    collect()
  }
  assert.ok(h.has(target), `paging reaches ${target}\n${h.screen()}`)
  assert.deepEqual(markers.filter(marker => !seen.has(marker)), [], `every detail marker is reachable without gaps (${down ? 'down' : 'up'}: ${pages.join(' -> ')})\n${h.screen()}`)
}

for (const fullscreen of [false, true]) {
  for (const [cols, rows] of [[110, 34], [60, 20]]) {
    const mode = `${fullscreen ? 'fullscreen' : 'inline'} ${cols}x${rows}`
    await test(`${mode}: all 97 detail lines page both ways; Home/End reach boundaries`, async t => {
      const h = await mount(fullscreen, cols, rows)
      t.after(() => h.dispose())
      const ask = await h.open(longDetail)
      assert.ok(h.has(longMarkers[0]!))
      assert.equal(h.has(longMarkers.at(-1)!), false)
      await pageThrough(h, longMarkers, true)
      await pageThrough(h, longMarkers, false)
      h.press(END)
      await h.waitFor(() => h.has(longMarkers.at(-1)!), 'End reaches final detail line')
      h.assertControls()
      h.press(HOME)
      await h.waitFor(() => h.has(longMarkers[0]!), 'Home reaches first detail line')
      h.assertControls()
      assert.equal(ask.done, false, 'navigation never resolves the ask')
      h.press(ENTER)
      await h.waitFor(() => ask.done, 'visible approval remains usable after scrolling')
      assert.deepEqual(ask.value, { answers: [{ id: 'detail-question', selected: ['APPROVE'] }] })
    })

    await test(`${mode}: one hard-wrapped CJK line is fully reachable`, async t => {
      const h = await mount(fullscreen, cols, rows)
      t.after(() => h.dispose())
      const ask = await h.open(wideDetail)
      assert.ok(h.has(wideMarkers[0]!))
      await pageThrough(h, wideMarkers, true)
      h.press(HOME)
      await h.waitFor(() => h.has(wideMarkers[0]!), 'Home restores wrapped detail start')
      h.press(END)
      await h.waitFor(() => h.has(wideMarkers.at(-1)!), 'End reaches wrapped detail tail')
      h.assertControls()
      h.press(ESC)
      await h.waitFor(() => ask.done, 'cancel remains reachable')
      assert.equal((ask.error as { code?: string })?.code, 'ASK_CANCELLED')
    })

    await test(`${mode}: focused input keeps Home/End editing, paging and fold preserve correction`, async t => {
      const h = await mount(fullscreen, cols, rows)
      t.after(() => h.dispose())
      const ask = await h.open(longDetail)
      h.press(DOWN)
      await h.waitFor(() => viewportLines(h.term).some(line => line.includes('REVISE') && line.includes('●')), 'revise option selected')
      h.press('DRAFT')
      await h.waitFor(() => h.has('DRAFT'), 'correction text entered on revise option')
      h.press(TAB)
      await h.waitFor(() => h.has('Type answer'), 'custom field focused')
      h.press(HOME + 'BEGIN-')
      await h.waitFor(() => h.has('BEGIN-DRAFT'), 'Home moves the custom caret to the start')
      h.press(END + '-END')
      await h.waitFor(() => h.has('BEGIN-DRAFT-END'), 'End moves the custom caret to the end')
      assert.ok(h.has(longMarkers[0]!), 'text Home/End do not move the detail')
      h.press(PAGE_DOWN)
      await h.waitFor(() => !h.has(longMarkers[0]!), 'PageDown scrolls detail while editing')
      assert.ok(h.footerVisible(), `editing keeps the custom answer and footer visible\n${h.screen()}`)
      h.press(PAGE_UP)
      await h.waitFor(() => h.has(longMarkers[0]!), 'PageUp scrolls detail while editing')
      // The attached draft can window choices on a short terminal. Every
      // choice must remain reachable, and navigating must preserve the draft.
      for (const label of ['DECLINE', 'REVISE', 'APPROVE']) {
        h.press(UP)
        await h.waitFor(() => viewportLines(h.term).some(line => line.includes(label) && line.includes('●')), `editing still permits reaching ${label}`)
        assert.ok(h.footerVisible())
      }
      h.press(TAB)
      await h.waitFor(() => h.has('Type answer') && h.has('BEGIN-DRAFT-END'), 'return to the unchanged custom field')
      h.press(FOLD)
      await h.waitFor(() => h.has('Waiting for your answer') && !h.has('BEGIN-DRAFT-END'), 'question folds')
      h.press(ESC)
      await h.waitFor(() => !h.has('Waiting for your answer') && h.footerVisible() && h.has('BEGIN-DRAFT-END'), 'question unfolds')
      assert.ok(h.has('BEGIN-DRAFT-END'), 'fold preserves exact correction')
      assert.equal(ask.done, false, 'unfold is not cancel')
      h.press(ENTER)
      await h.waitFor(() => ask.done, 'correction submits')
      assert.deepEqual(ask.value, { answers: [{ id: 'detail-question', selected: ['REVISE'], custom: 'BEGIN-DRAFT-END' }] })
    })

    await test(`${mode}: short and absent detail retain ordinary answer behavior after remount`, async t => {
      const h = await mount(fullscreen, cols, rows)
      t.after(() => h.dispose())
      for (const detail of ['SHORT-DETAIL', undefined]) {
        const ask = await h.open(detail)
        if (detail !== undefined) assert.ok(h.has(detail))
        h.press(DOWN + DOWN)
        await h.waitFor(() => viewportLines(h.term).some(line => line.includes('DECLINE') && line.includes('●')), 'ordinary selection moves to decline')
        h.press(ENTER)
        await h.waitFor(() => ask.done, 'ordinary question submits')
        assert.deepEqual(ask.value, { answers: [{ id: 'detail-question', selected: ['DECLINE'] }] })
        await h.waitFor(() => !h.has('QUESTION-BODY'), 'resolved question unmounts before successor')
      }
    })
  }
}

await test('fullscreen 110x34: wheel targets detail, transcript, and decision-control fallback', async t => {
  const h = await mount(true, 110, 34)
  t.after(() => h.dispose())
  const ask = await h.open(longDetail)
  h.wheelAt(longMarkers[0]!, true)
  await h.waitFor(() => !h.has(longMarkers[0]!), 'wheel inside detail scrolls detail')
  h.assertControls()
  const detailAfterWheel = h.detailSnapshot()
  h.wheelAt('APPROVE', true, 3)
  await h.waitFor(() => h.detailSnapshot() !== detailAfterWheel, 'wheel over decision controls scrolls detail')
  h.wheelAt('APPROVE', false, 10)
  await h.waitFor(() => h.has(longMarkers[0]!), 'upward decision-control wheel returns detail to start')
  h.assertControls()
  // A maximally expanded detail may consume the transcript's entire height.
  // Fold to expose its real ScrollBox before testing position-first routing.
  h.press(FOLD)
  await h.waitFor(() => h.has('Waiting for your answer') && !h.has('APPROVE') && h.has('TRANSCRIPT-079'), 'fold exposes transcript')
  const transcript = () => viewportLines(h.term).filter(line => line.includes('TRANSCRIPT-')).join('\n')
  const originalTranscript = transcript()
  h.wheelAt('TRANSCRIPT-079', false, 3)
  await h.waitFor(() => transcript() !== originalTranscript, 'wheel over transcript scrolls transcript')
  assert.equal(h.has('APPROVE'), false, 'transcript wheel leaves questionnaire folded')
  // 固定窗:探针 Wheel routing must not settle a pending question after rendering.
  await sleep(60)
  assert.equal(ask.done, false)
})
