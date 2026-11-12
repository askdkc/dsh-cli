/** Inject SDK stream parts, while keeping the adapter and DSH runtime real. */
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
let parts = [], stream, started, calls = 0, pending = false
mock.module('../lib/opencode-transport.js', { namedExports: { createTransport: () => ({ doStream: async () => {
  calls++
  stream = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); if (!pending) controller.close(); started?.() } })
  return { stream }
} }) } })
const { OpenCodeAdapter } = await import('../lib/opencode-adapter.js')
const request = { provider: 'opencode', model: 'fixture', messages: [] }
const start = { type: 'text-start', id: 'a' }
const finish = { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } }
async function environment(body) {
  calls = 0; pending = false; started = undefined
  const model = { id: 'fixture', name: 'Fixture', protocol: 'chat', inputModalities: ['text'], toolCall: true, efforts: [], contextWindow: 8192, maxTokens: 256 }
  const adapter = new OpenCodeAdapter({ catalogs: new Map([['opencode', { models: () => [model] }]]), store: { read: async () => ({ type: 'api_key', key: 'secret' }) } })
  const ctx = new Context(); await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['opencode'], adapter)
  const run = (options = {}) => Array.fromAsync(ctx.llm.stream({ ...request, ...options }))
  try { await body({ ctx, adapter, run }) } finally { await ctx.fiber.dispose() }
}
for (const [name, script, code] of [
  ['EOF', [], 'PROTOCOL_ERROR'],
  ['duplicate start', [start, start, finish], 'PROTOCOL_ERROR'],
  ['wrong delta kind', [start, { type: 'tool-input-delta', id: 'a', delta: '{}' }, finish], 'PROTOCOL_ERROR'],
  ['unfinished tool', [{ type: 'tool-input-start', id: 'a', toolName: 'tool' }, finish], 'PROTOCOL_ERROR'],
  ['broken stream', [{ type: 'error', error: new Error('private response') }], 'TRANSPORT'],
  ['unmatched delta', [{ type: 'text-delta', id: 'missing', delta: 'bad' }], 'PROTOCOL_ERROR'],
  ['unmatched end', [{ type: 'text-end', id: 'missing' }], 'PROTOCOL_ERROR'],
  ['provider tool', [{ type: 'tool-call', providerExecuted: true }], 'PROTOCOL_ERROR'],
  ['tool mismatch', [{ type: 'tool-input-start', id: 'a', toolName: 'one' }, { type: 'tool-call', toolCallId: 'a', toolName: 'two', input: '{}' }], 'PROTOCOL_ERROR'],
  ['provider finish', [start, { ...finish, finishReason: { unified: 'error' } }], 'PROVIDER_ERROR'],
]) test(`real runtime preserves ${name} failure and releases its reader`, async () => environment(async ({ run }) => {
  parts = script
  const chunks = await run()
  assert.equal(chunks.at(-1).reason.kind, 'error'); assert.equal(chunks.at(-1).reason.failure.code, code)
  assert.equal(stream.locked, false); assert.equal(calls, 1)
  parts = [start, { type: 'text-delta', id: 'a', delta: 'ok' }, finish]
  assert.equal((await run()).at(-1).reason.kind, 'stop'); assert.equal(stream.locked, false)
}))
test('adapter reasoning failure keeps its custom code through the real normalization boundary', async () => environment(async ({ ctx, adapter }) => {
  // Normal runtime model validation rejects this earlier with its own builtin
  // UNSUPPORTED_REASONING_EFFORT. Exercise the adapter's defensive check too.
  const boundary = new class extends LlmAdapter { stream() { return adapter.stream({ ...request, reasoningEffort: 'high' }) } }
  ctx.llm.registerAdapter(['boundary'], boundary)
  const chunks = await Array.fromAsync(ctx.llm.stream({ provider: 'boundary', model: 'fixture', messages: [] }))
  assert.equal(chunks.at(-1).reason.failure.code, 'UNSUPPORTED_CAPABILITY'); assert.equal(calls, 0)
}))
test('cancellation releases the reader, sends no retry, and allows the next turn', async () => environment(async ({ run }) => {
  pending = true; parts = [start]
  const ready = new Promise(resolve => { started = resolve }); const abort = new AbortController()
  const operation = run({ signal: abort.signal }); await ready; abort.abort(new Error('user cancel'))
  const chunks = await operation
  assert.equal(chunks.at(-1).reason.kind, 'aborted'); assert.equal(calls, 1); assert.equal(stream.locked, false)
  pending = false; parts = [start, finish]
  assert.equal((await run()).at(-1).reason.kind, 'stop'); assert.equal(calls, 2)
}))
test('idle timeout stays TIMEOUT rather than user cancellation', async t => environment(async ({ run }) => {
  pending = true; parts = [start]; const ready = new Promise(resolve => { started = resolve })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const operation = run(); await ready; t.mock.timers.tick(300001)
  const chunks = await operation
  assert.equal(chunks.at(-1).reason.kind, 'error'); assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
  assert.equal(calls, 1); assert.equal(stream.locked, false); t.mock.timers.reset()
}))
