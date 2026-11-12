import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { OpenCodeFailure, openCodeRequestFailure } from '../lib/opencode-failure.js'
import { OpenCodeAdapter } from '../lib/opencode-adapter.js'

if (process.env.DSH_AUTH_EXPECT_SOURCE) {
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm'))), join(realpathSync(process.env.DSH_AUTH_EXPECT_SOURCE), 'packages/llm/llm/src/index.ts'))
}
console.log('provider runtime:', import.meta.resolve('@deepseek-ai/dsh-llm'))
const model = { id: 'fixture', name: 'Fixture', protocol: 'chat', inputModalities: ['text', 'image'], toolCall: true, efforts: [], contextWindow: 8192, maxTokens: 256 }
const request = { provider: 'opencode', model: 'fixture', messages: [] }
const secret = 'fixture-secret-key'
const reply = () => new Response('data: ' + JSON.stringify({ id: 'ok', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
async function environment(body, options = {}) {
  let calls = 0
  const adapter = new OpenCodeAdapter({
    catalogs: new Map([['opencode', { models: () => [options.model ?? model], status: () => ({ excluded: [] }) }]]),
    store: { read: async () => ({ type: 'api_key', key: secret }) },
    fetcher: async (...args) => { calls++; return (options.fetcher ?? reply)(...args) },
    attachments: options.attachments,
  })
  const ctx = new Context(); await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['opencode'], adapter)
  const run = async (overrides = {}) => Array.fromAsync(ctx.llm.stream({ ...request, ...overrides }))
  try { await body({ run, adapter, calls: () => calls }) } finally { await ctx.fiber.dispose() }
}
function failure(chunks, code) {
  assert.equal(chunks.at(-1)?.reason.kind, 'error', JSON.stringify(chunks))
  assert.equal(chunks.at(-1).reason.failure.code, code)
  assert(!chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
  assert(!JSON.stringify(chunks).includes(secret))
  return chunks.at(-1).reason.failure
}
for (const [name, overrides, options, code] of [
  ['missing model', { model: 'missing' }, {}, 'MODEL_NOT_FOUND'],
  ['reasoning', { reasoningEffort: 'high' }, {}, 'UNSUPPORTED_REASONING_EFFORT'],
  ['tools', { tools: [{ name: 'tool', parameters: { type: 'object' } }] }, { model: { ...model, toolCall: false } }, 'UNSUPPORTED_CAPABILITY'],
  ['attachment service', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { width: 1, height: 1 } }] }] }, {}, 'ATTACHMENT_UNAVAILABLE'],
  ['missing attachment bytes', { messages: [{ role: 'user', content: [{ type: 'image', attachment: { width: 1, height: 1 } }] }] }, { attachments: () => ({ readImageRequest: async () => { throw new Error(secret) } }) }, 'ATTACHMENT_UNAVAILABLE'],
]) test(`runtime rejects ${name} before external calls`, async () => environment(async ({ run, calls }) => {
  failure(await run(overrides), code); assert.equal(calls(), 0)
  assert.equal((await run()).at(-1).reason.kind, 'stop')
}, options))
for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [503, 'SERVER'], [400, 'PROVIDER_ERROR'], [404, 'PROVIDER_ERROR']]) {
  test(`runtime HTTP ${status} retains metadata without response secrets`, async () => environment(async ({ run, calls }) => {
    const result = failure(await run(), code)
    assert.equal(result.status, status); assert.equal(result.providerRetryAfterMs, 3000); assert.equal(result.requestId, 'req_fixture'); assert.equal(calls(), 1)
  }, { fetcher: async () => Response.json({ error: { message: secret } }, { status, headers: { 'retry-after': '3', 'x-request-id': 'req_fixture' } }) }))
}
test('runtime drops unsafe metadata without losing HTTP classification', async () => environment(async ({ run }) => {
  const result = failure(await run(), 'PROVIDER_ERROR')
  assert.equal(result.requestId, undefined); assert.equal(result.providerRetryAfterMs, undefined)
}, { fetcher: async () => Response.json({ error: secret }, { status: 400, headers: { 'retry-after': 'Infinity', 'request-id': secret } }) }))
test('runtime transport failure hides SDK cause', async () => environment(async ({ run, calls }) => {
  failure(await run(), 'TRANSPORT'); assert.equal(calls(), 1)
}, { fetcher: async () => { throw new Error(secret) } }))
test('custom boundary validates metadata and keeps immutable own data', async () => {
  for (const facts of [{ status: 600 }, { status: 400.1 }, { providerRetryAfterMs: Infinity }, { providerRetryAfterMs: 0 }, { requestId: '' }]) {
    assert.throws(() => new OpenCodeFailure('safe', 'PROVIDER_ERROR', facts))
  }
  const error = new OpenCodeFailure('safe', 'PROVIDER_ERROR', { status: 418, requestId: 'req_id', providerRetryAfterMs: 1500 })
  assert.equal(error.code, error.failure.code); assert(Object.isFrozen(error.failure)); assert.equal(error.cause, undefined)
  const ctx = new Context(); await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter { async *stream() { throw error } })
  try {
    const chunks = await Array.fromAsync(ctx.llm.stream({ provider: 'fixture', model: 'fixture', messages: [] }))
    assert.deepEqual(chunks.at(-1).reason.failure, error.failure)
  } finally { await ctx.fiber.dispose() }
})
test('HTTP metadata validation rejects malformed SDK fields and retains HTTP-date retry', () => {
  for (const statusCode of [NaN, Infinity, 99, 600, 400.1, '429']) {
    const error = openCodeRequestFailure({ statusCode, responseHeaders: { 'request-id': 'bad\r\nid', 'retry-after': '-1' } }, secret)
    assert.equal(error.code, 'TRANSPORT'); assert.equal(error.failure.status, undefined)
    assert.equal(error.failure.requestId, undefined); assert.equal(error.failure.providerRetryAfterMs, undefined)
  }
  const date = new Date(Date.now() + 60_000).toUTCString()
  const result = openCodeRequestFailure({ statusCode: 429, responseHeaders: { 'retry-after': date, 'request-id': 'req_date' } }, secret)
  assert.equal(result.code, 'RATE_LIMIT'); assert(result.failure.providerRetryAfterMs > 58_000 && result.failure.providerRetryAfterMs <= 60_000)
  assert.equal(result.failure.requestId, 'req_date')
  assert.equal(openCodeRequestFailure(Object.defineProperty({}, 'statusCode', { get() { throw new Error(secret) } }), secret).code, 'TRANSPORT')
})
