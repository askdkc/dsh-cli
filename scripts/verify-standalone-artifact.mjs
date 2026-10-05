/** Smoke the real executable, with isolated profiles/cache and no external Node/pnpm. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { x as extractTar } from 'tar'
import xterm from '@xterm/headless'
import { settled } from './lib/term-test.mjs'

const directory = resolve(process.argv[2] ?? 'dist-standalone')
const platform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const archive = join(directory, `dsh-tui-standalone-${platform}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-artifact-'))
const env = {
  SystemRoot: process.env.SystemRoot, HOME: scratch, USERPROFILE: scratch,
  DSH_TUI_STANDALONE_HOME: join(scratch, 'home'),
  DSH_TUI_STANDALONE_CACHE: join(scratch, 'cache'),
  DSH_TELEMETRY_MODE: 'DISABLED', NODE_ENV: 'production',
}
try {
  if (process.platform === 'win32') {
    assert.ok(process.env.SystemRoot, 'SystemRoot is required to locate Windows ZIP extraction')
    const windowsTar = join(process.env.SystemRoot, 'System32', 'tar.exe')
    const extract = spawnSync(windowsTar, ['-xf', archive, '-C', scratch], { encoding: 'utf8' })
    assert.equal(extract.status, 0, extract.stderr)
  } else {
    await extractTar({ file: archive, cwd: scratch, strict: true, preservePaths: false })
  }
  const executable = join(scratch, process.platform === 'win32' ? 'dsh-tui.exe' : 'dsh-tui')
  const run = args => {
    const started = performance.now()
    const timeout = process.env.DSH_STANDALONE_DIAGNOSTIC === '1' ? 180000 : 60000
    const result = spawnSync(executable, args, { env: { ...env, PATH: '' }, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
    const elapsed = Math.round(performance.now() - started)
    assert.equal(result.status, 0, `Standalone ${args.join(' ')} failed after ${elapsed} ms: status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}\n${result.stderr}`)
    console.log(`standalone ${args.join(' ')} OK (${elapsed} ms)`)
    return result
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const config = run(['--dump-config'])
    assert.equal(config.status, 0, config.stderr)
    assert.match(config.stdout, /# == @askdkc\/dsh-cli/u)
  }
  const manifestPath = join(env.DSH_TUI_STANDALONE_HOME, 'profiles/dsh-cli/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@askdkc/dsh-cli'])
  manifest.custom = 'preserved'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const patch = join(dirname(manifestPath), 'cordis.patch.yml')
  writeFileSync(patch, '# user overlay\n[]\n')
  const config = run(['--dump-config'])
  assert.equal(config.status, 0, config.stderr)
  assert.match(config.stdout, /dsh-tui/u)
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).custom, 'preserved')
  assert.equal(readFileSync(patch, 'utf8'), '# user overlay\n[]\n')
  const cacheName = readdirSync(env.DSH_TUI_STANDALONE_CACHE).find(name => name.startsWith('tui-'))
  assert.ok(cacheName, 'runtime cache was populated')
  const runtime = join(env.DSH_TUI_STANDALONE_CACHE, cacheName)
  const dshRoot = join(runtime, 'node_modules/@deepseek-ai/dsh')
  const dsh = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
  const entry = join(dshRoot, typeof dsh.bin === 'string' ? dsh.bin : dsh.bin.dsh)
  writeFileSync(entry, 'throw new Error("damaged runtime")\n')
  const repaired = run(['--dump-config'])
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.match(repaired.stdout, /# == @askdkc\/dsh-cli/u, 'real executable repairs its cached entry')

  const pty = createRequire(join(dshRoot, 'package.json'))('node-pty')
  const terminal = new xterm.Terminal({ cols: 100, rows: 32, allowProposedApi: true })
  const child = pty.spawn(executable, [], {
    name: 'xterm-256color', cols: 100, rows: 32, cwd: scratch,
    env: { ...env, PATH: '', TERM: 'xterm-256color', DSH_TUI_PRESET: 'liangshen', DSH_TUI_SESSION_ROOT: join(scratch, 'sessions') },
  })
  let exit
  let output = ''
  child.onExit(event => { exit = event })
  child.onData(data => { output = (output + data).slice(-65536); terminal.write(data) })
  terminal.onData(data => { if (exit === undefined) child.write(data) })
  const screen = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: 32 }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
  }
  try {
    const ready = () => screen().includes('dsh-CLI') && screen().includes('❯')
    assert.ok(await settled(() => ready() || exit !== undefined, { timeoutMs: 30000 }), `TUI startup timed out: ${screen()}`)
    assert.equal(exit, undefined, `TUI exited before mounting: ${output}`)
    assert.ok(ready(), `TUI prompt missing: ${screen()}`)
    child.write('/quit')
    assert.ok(await settled(() => screen().includes('/quit')), 'TUI must accept /quit')
    child.write('\r')
    assert.ok(await settled(() => exit !== undefined, { timeoutMs: 20000 }), '/quit must terminate the TUI')
    assert.equal(exit.exitCode, 0)
  } finally {
    if (exit === undefined) {
      child.kill()
      if (!await settled(() => exit !== undefined)) child.kill('SIGKILL')
    }
    terminal.dispose()
  }
  console.log(`standalone artifact OK (${platform}; cold/warm start, config, preserved profile, cache repair, TUI /quit)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
// ConPTY can retain a native handle after its child exits. All assertions and
// owned cleanup have completed here; a thrown failure never reaches this line.
process.exit(0)
