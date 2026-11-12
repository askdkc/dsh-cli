/** Real runtime failures passed to the real retry policy executor. */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { apply as installRetry } from '@deepseek-ai/dsh-llm-retry'
import { OpenCodeAdapter } from '../lib/opencode-adapter.js'

if (process.env.DSH_AUTH_EXPECT_SOURCE) {
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-retry'))), join(realpathSync(process.env.DSH_AUTH_EXPECT_SOURCE), 'packages/llm/llm-retry/src/index.ts'))
}

async function harness(body) {
  let calls = 0, recover, reducer, state
  const events = [], cleanup = []
  const controller = new AbortController()
  // Minimal event/projection host: the scheduling and limits are production
  // llm-retry code. Runtime dispatch and HTTP adapter are also unmodified.
  const agent = { session: { append(type, data) { const event = { type, data }; events.push(event); state = reducer(state, event) } } }
  await installRetry({
    fiber: { uid: 'fixture' }, logger: { warn() {} },
    sessionProjections: { stateOf: () => state, register(spec) { reducer = spec.apply; state = spec.init(); return { stateOf: () => state } } },
    on(name, listener) { assert.equal(name, 'agent/request-error'); recover = listener; return () => {} },
    effect(factory) { cleanup.push(factory()) },
  })
  const ctx = new Context(); await ctx.plugin(LlmRuntime)
  const adapter = new OpenCodeAdapter({
    catalogs: new Map([['opencode', { models: () => [{ id: 'fixture', name: 'Fixture', protocol: 'chat', inputModalities: ['text'], toolCall: true, efforts: [], contextWindow: 8192, maxTokens: 256 }] }]]),
    store: { read: async () => ({ type: 'api_key', key: 'secret' }) },
    fetcher: async () => { calls++; return Response.json({ error: 'secret' }, { status: 400 }) },
  })
  ctx.llm.registerAdapter(['opencode'], adapter)
  const attempt = async () => {
    const chunks = await Array.fromAsync(ctx.llm.stream({ provider: 'opencode', model: 'fixture', messages: [], signal: controller.signal }))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'PROVIDER_ERROR')
    return chunks.at(-1).reason.failure
  }
  const recovery = (failure, policy) => recover({ agent, turn: 1, step: 1, provider: 'opencode', failure, retryPolicy: policy, signal: controller.signal }, async () => undefined)
  try { await body({ attempt, recovery, calls: () => calls, events, controller }) }
  finally { for (const dispose of cleanup) await dispose(); await ctx.fiber.dispose() }
}
test('default policy does not retry custom provider failures', async () => harness(async ({ attempt, recovery, calls, events }) => {
  const result = await recovery(await attempt(), resolveRetryPolicy(undefined, 'fixture'))
  assert.equal(result, undefined); assert.equal(calls(), 1); assert.deepEqual(events, [])
}))
test('explicit custom retryableCodes respects maxRetries with real runtime failures', async () => harness(async ({ attempt, recovery, calls, events }) => {
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['PROVIDER_ERROR'], backoff: { initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 } }, 'fixture')
  for (let count = 0; count < 4; count++) {
    const decision = await recovery(await attempt(), policy)
    if (decision?.kind !== 'retry') break
  }
  assert.equal(calls(), 3); assert.equal(events.filter(event => event.type === 'llm/retry').length, 2)
  assert.equal(events.filter(event => event.type === 'llm/retry-started').length, 2)
}))
test('cancel during retry delay starts no resend', async () => harness(async ({ attempt, recovery, calls, events, controller }) => {
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['PROVIDER_ERROR'], backoff: { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 } }, 'fixture')
  const operation = recovery(await attempt(), policy)
  await Promise.resolve(); controller.abort(new Error('user cancel'))
  assert.equal(await operation, undefined); assert.equal(calls(), 1)
  assert.equal(events.filter(event => event.type === 'llm/retry-started').length, 0)
}))
