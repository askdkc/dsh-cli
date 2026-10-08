/** Catalog transports with synthetic credentials and an in-process fetch fixture. */
import assert from 'node:assert/strict'
import * as zlib from 'node:zlib'
import { buildOAuthProfile, CredentialGatedAdapter } from '../lib/pi-routes.js'
import { CATALOG_PROVIDER_IDS } from '../lib/profiles.js'
import { createCustomProfile, CUSTOM_PROVIDER_IDS } from '../lib/custom-profiles.js'

const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`
const credential = { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 }
const originalFetch = globalThis.fetch
try {
  for (const id of [...CATALOG_PROVIDER_IDS.filter(id => !id.startsWith('opencode')), ...CUSTOM_PROVIDER_IDS]) {
    let custom
    if (CUSTOM_PROVIDER_IDS.includes(id)) {
      custom = createCustomProfile(id)
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), custom.profile.piProvider.baseUrl + '/models')
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-key')
        return Response.json({ data: [{ id: 'fixture/chat', supported_endpoint_types: ['chat_completions'], supported_parameters: ['tools'], category_type: 'LLM', supports_function_calling: true, supports_streaming: true, context_length: 32768, max_output_tokens: 4096, pricing: { prompt: '0.000001', completion: '0.000002' }, min_prompt_price: 1, min_completion_price: 2 }] })
      }
      assert.equal(await custom.refresh('fixture-key'), 1)
    }
    const profile = { ...(custom?.profile ?? buildOAuthProfile(id)), transport: 'sse' }
    const model = profile.piProvider.getModels()[0]
    assert(model, `${id} must retain its host catalog`)
    let requested = false
    globalThis.fetch = async (url, options) => {
      requested = true
      const headers = new Headers(options.headers)
      const body = JSON.parse(headers.get('content-encoding') === 'zstd'
        ? zlib.zstdDecompressSync(options.body).toString('utf8') : options.body)
      const target = new URL(String(url))
      assert.equal(body.model, model.id)
      assert.equal(target.origin, new URL(profile.piProvider.baseUrl).origin)
      let events
      if (model.api === 'anthropic-messages') {
        assert(target.pathname.endsWith('/messages'))
        assert.equal(headers.get('x-api-key'), 'fixture-key')
        events = [
          { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
      } else if (model.api === 'openai-completions') {
        assert(target.pathname.endsWith('/chat/completions'))
        assert.equal(headers.get('authorization'), 'Bearer fixture-key')
        return new Response([
          'data: ' + JSON.stringify({ id: 'chat_fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture' }, finish_reason: null }] }),
          'data: ' + JSON.stringify({ id: 'chat_fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]', '',
        ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
      } else {
        assert(target.pathname.endsWith('/responses'))
        assert.equal(headers.get('authorization'), `Bearer ${id === 'openai-codex' ? token : 'fixture-key'}`)
        if (id === 'openai-codex') assert.equal(headers.get('chatgpt-account-id'), 'fixture-account')
        events = [
          { type: 'response.created', response: { id: 'resp_fixture', model: model.id, created_at: 1 } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } },
          { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'fixture' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'fixture', annotations: [] }] } },
          { type: 'response.completed', response: { id: 'resp_fixture', model: model.id, status: 'completed', usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
        ]
      }
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    const fixtureFetch = globalThis.fetch
    let fixtureError
    globalThis.fetch = async (...args) => {
      try { return await fixtureFetch(...args) }
      catch (error) { fixtureError = error; throw error }
    }
    const adapter = new CredentialGatedAdapter({
      profiles: () => new Map([[id, profile]]),
      resolveApiKey: async () => id === 'openai-codex' ? undefined : 'fixture-key',
      auth: {
        credentials: {
          read: async provider => provider === 'openai-codex' ? credential : undefined,
          list: async () => [{ provider: 'openai-codex', type: 'oauth', expires: credential.expires }],
          modify: async (_provider, fn) => fn(credential), delete: async () => {},
        },
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    }, async () => true)
    assert.equal((await adapter.resolveModel(id, model.id)).id, model.id)
    assert((await adapter.listModels(id)).some(row => row.id === model.id))
    const chunks = []
    for await (const chunk of adapter.stream({ provider: id, model: model.id, sessionId: 'fixture-session', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], tools: [], signal: AbortSignal.timeout(10000) })) chunks.push(chunk)
    if (fixtureError) throw fixtureError
    assert(requested, id)
    assert(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'fixture'), JSON.stringify(chunks))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    console.log(`${id}: host catalog, auth and fixture transport OK`)
  }
} finally {
  globalThis.fetch = originalFetch
}
