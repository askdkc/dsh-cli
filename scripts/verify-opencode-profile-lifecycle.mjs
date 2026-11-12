/** Installed profile: real PTY input, cancellation, recovery and clean exit. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import xterm from '@xterm/headless'
import { settled } from './lib/term-test.mjs'
const [host, cli] = process.argv.slice(2)
assert(host && cli, 'requires the exact installed host and CLI entry')
const pty = createRequire(join(host, 'package.json'))('node-pty')
const overlay = join(host, 'lifecycle.patch.yml'), events = join(host, 'lifecycle-events.jsonl')
writeFileSync(events, '')
writeFileSync(overlay, JSON.stringify([
  { id: 'dsh-cli', config: { provider: 'opencode', model: 'fixture-profile', preset: 'minimal', fullscreen: true } },
  { id: 'dsh-cli-auth', config: { providers: ['opencode'] } },
]))
const terminal = new xterm.Terminal({ cols: 110, rows: 35, allowProposedApi: true })
const fixture = fileURLToPath(new URL('./opencode-profile-fetch.mjs', import.meta.url))
const child = pty.spawn(process.execPath, [cli, '--profile', 'dsh-cli', '--patch', overlay], {
  name: 'xterm-256color', cols: 110, rows: 35, cwd: host,
  env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: `--import=${fixture}`, TERM: 'xterm-256color', DSH_CLI_LANG: 'en', DSH_AUTH_PROFILE_EVENTS: events },
})
let exit, output = ''
child.onExit(event => { exit = event })
child.onData(data => { output = (output + data).slice(-65536); terminal.write(data) })
terminal.onData(data => { if (exit === undefined) child.write(data) })
const screen = () => Array.from({ length: 35 }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n')
const observed = () => readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const wait = async (predicate, label, timeoutMs = 30000) => {
  assert(await settled(() => predicate() || exit !== undefined, { timeoutMs }), `${label}: ${screen()}\n${output}`)
  assert.equal(exit, undefined, `${label}: exited early\n${output}`)
  assert(predicate(), `${label}: ${screen()}`)
}
try {
  await wait(() => screen().includes('❯'), 'profile prompt', 60000)
  child.write('profile-first\r')
  await wait(() => screen().includes('PROFILE_FIRST_OK'), 'first response')
  child.write('profile-cancel\r')
  await wait(() => screen().includes('PROFILE_WAITING'), 'stream before cancel')
  child.write('\x1b')
  await wait(() => observed().some(event => event.type === 'abort'), 'cancel reaches transport')
  child.write('profile-next\r')
  await wait(() => screen().includes('PROFILE_NEXT_OK'), 'next input after cancel')
  assert.deepEqual(observed().filter(event => event.type === 'request' && event.phase !== 'title').map(event => event.phase), ['first', 'cancel', 'next'], 'no resend after cancellation')
  child.write('/quit\r')
  assert(await settled(() => exit !== undefined, { timeoutMs: 20000 }), `/quit did not terminate: ${screen()}`)
  assert.equal(exit.exitCode, 0)
  console.log('installed profile lifecycle OK (PTY start, input, cancel, next input, /quit; exactly three generation calls; auxiliary title requests separate)')
} finally {
  if (exit === undefined) { child.kill(); if (!await settled(() => exit !== undefined)) child.kill('SIGKILL') }
  terminal.dispose()
}
