/** Current TUI event registration and unsupported-format rejection. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-current-storage-'))
process.env.DSH_CLI_SESSION_ROOT = root
process.env.HOME = root
process.env.USERPROFILE = root
const { readPersistedSession } = await import('../lib/types/dsh-adapter/compat/persistence.js')
const { readSessionEventsFromFile, appendSessionTitle } = await import('../lib/types/dsh-adapter/compat/sessionLog.js')
const ctx = new Context()
ctx.plugin(SessionStore)
const plugin = ctx.plugin(Jsonl, { root })
const write = (id, version, type) => {
  const dir = join(root, '--tmp--', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`)
  const header = { type: 'session', version, id, createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0 }
  const bytes = Buffer.concat([header, { type, seq: 0, time: 2, data: { color: 'blue' } }].map(record => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n'))))
  writeFileSync(path, bytes)
  return { path, bytes }
}
try {
  assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
  const color = write('color', SESSION_FORMAT_VERSION, 'session/color')
  const loaded = await readPersistedSession(ctx.sessionPersistence, 'color')
  assert.equal(loaded.events[0].type, 'session/color', 'TUI event is registered in the strict persistence validator')
  assert.deepEqual(readFileSync(color.path), color.bytes)

  const unknown = write('unknown', SESSION_FORMAT_VERSION, 'unregistered/required-event')
  await assert.rejects(readPersistedSession(ctx.sessionPersistence, 'unknown'), /unknown|unregistered|unsupported/i)
  assert.deepEqual(readFileSync(unknown.path), unknown.bytes, 'strict failure never alters the source')

  for (const version of [0, 3]) {
    const old = write(`old-${version}`, version, 'session/color')
    assert.equal(readSessionEventsFromFile(old.path)?.failed, true, 'bounded reader rejects old formats')
    assert.equal(appendSessionTitle(`old-${version}`, 'attempted rename'), 'unavailable')
    assert.deepEqual(readFileSync(old.path), old.bytes, 'unsupported old format is never modified')
  }
  const packed = write('packed', SESSION_FORMAT_VERSION, 'text-chunks')
  assert.equal(readSessionEventsFromFile(packed.path)?.failed, true, 'top-level packed rows are unsupported')
  assert.deepEqual(readFileSync(packed.path), packed.bytes)
  console.log('current storage: color registration, strict unknown events, old-format rejection and source preservation OK')
} finally {
  await plugin.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
