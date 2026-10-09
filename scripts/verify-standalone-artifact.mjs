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
const archive = join(directory, `dsh-cli-standalone-${platform}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-artifact-'))
const env = {
  SystemRoot: process.env.SystemRoot, HOME: scratch, USERPROFILE: scratch,
  DSH_CLI_STANDALONE_HOME: join(scratch, 'home'),
  DSH_CLI_STANDALONE_CACHE: join(scratch, 'cache'),
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
  const executable = join(scratch, process.platform === 'win32' ? 'dsh-cli.exe' : 'dsh-cli')
  const run = (phase, timeout = 60000) => {
    const args = ['--dump-config']
    const started = performance.now()
    const result = spawnSync(executable, args, { env: { ...env, PATH: '' }, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
    const elapsed = Math.round(performance.now() - started)
    assert.equal(result.status, 0, `Standalone ${phase} failed after ${elapsed} ms (budget ${timeout} ms): status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}\n${result.stderr}`)
    console.log(`standalone ${phase} OK (${elapsed} ms; budget ${timeout} ms)`)
    return result
  }
  // Cold install extracts the full dependency tree; repair also deletes the
  // damaged tree. Intel macOS CI repair has taken 57.6s before runner variance.
  const extractionTimeout = 180000
  for (let attempt = 0; attempt < 2; attempt++) {
    const config = attempt === 0 ? run('cold startup', extractionTimeout) : run('warm startup')
    assert.equal(config.status, 0, config.stderr)
    assert.match(config.stdout, /# == @askdkc\/dsh-cli/u)
  }
  const manifestPath = join(env.DSH_CLI_STANDALONE_HOME, 'profiles/dsh-cli/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@askdkc/dsh-cli'])
  manifest.custom = 'preserved'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const patch = join(dirname(manifestPath), 'cordis.patch.yml')
  writeFileSync(patch, '# user overlay\n[]\n')
  const config = run('preserved profile')
  assert.equal(config.status, 0, config.stderr)
  assert.match(config.stdout, /dsh-cli/u)
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).custom, 'preserved')
  assert.equal(readFileSync(patch, 'utf8'), '# user overlay\n[]\n')
  const cacheName = readdirSync(env.DSH_CLI_STANDALONE_CACHE).find(name => name.startsWith('cli-'))
  assert.ok(cacheName, 'runtime cache was populated')
  const runtime = join(env.DSH_CLI_STANDALONE_CACHE, cacheName)
  const dshRoot = join(runtime, 'node_modules/@deepseek-ai/dsh')
  const dsh = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
  const entry = join(dshRoot, typeof dsh.bin === 'string' ? dsh.bin : dsh.bin.dsh)
  writeFileSync(entry, 'throw new Error("damaged runtime")\n')
  const repaired = run('cache repair', extractionTimeout)
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.match(repaired.stdout, /# == @askdkc\/dsh-cli/u, 'real executable repairs its cached entry')

  const pty = createRequire(join(dshRoot, 'package.json'))('node-pty')
  const terminal = new xterm.Terminal({ cols: 100, rows: 32, allowProposedApi: true })
  const child = pty.spawn(executable, [], {
    name: 'xterm-256color', cols: 100, rows: 32, cwd: scratch,
    env: { ...env, PATH: '', TERM: 'xterm-256color', DSH_CLI_PRESET: 'liangshen', DSH_CLI_SESSION_ROOT: join(scratch, 'sessions') },
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
