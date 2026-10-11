/**
 * Headless smoke for the pure modules — no cordis, no harness, no network.
 *
 * Covers: the credential file as a pi-ai `CredentialStore` (write/read/
 * modify/delete, list metadata, the serialized modify pi-ai's refresh-under-
 * lock depends on, loud corrupt-file refusal, loud refusal of non-OAuth
 * writes), the mounted profiles (catalog identity, OAuth flow present,
 * adapter-facing defaults), the question bridge (select/text mapping,
 * waiting-panel single-flight, cancel wiring), and the service api (status/
 * login/logout over a fabricated flow).
 *
 * Run after build: `node scripts/smoke.mjs`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { CredentialFile, OAUTH_PROVIDER_IDS, AUTH_PROVIDER_IDS, Config: AuthConfig, canonicalProvider, QuestionBridge, createDshAuthApi, openerFor, apply } =
  await import('../lib/index.js')
const { createCustomProfile, CUSTOM_PROVIDER_IDS } = await import('../lib/custom-profiles.js')
const { loginNous, refreshNous } = await import('../lib/nous-oauth.js')
const { buildOAuthProfile, CredentialGatedAdapter } = await import('../lib/pi-routes.js')
const { OPEN_CODE_SNAPSHOTS } = await import('../lib/opencode-owned.generated.js')
const { parseSnapshot } = await import('../lib/opencode-catalog.js')
const { adapterBuiltinProviders } = await import('../lib/pi-ai.js')

/** Adapter options over one profile — enough for listModels/resolveModel offline. */
function gateAdapterOptions() {
  const profiles = new Map([['openai-codex', buildOAuthProfile('openai-codex')], ['anthropic', buildOAuthProfile('anthropic')]])
  return {
    profiles: () => profiles,
    resolveApiKey: async () => undefined,
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async (_p, fn) => fn(undefined), delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  }
}

let passed = 0
let failed = 0
const ok = (condition, label) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-smoke-'))
try {
  ok(!AUTH_PROVIDER_IDS.includes('orcarouter') && !CUSTOM_PROVIDER_IDS.includes('orcarouter'),
    'OrcaRouter is absent from mounted authentication and custom model providers')
  let retiredProviderError = ''
  try { await apply({}, { providers: ['orcarouter'], credentialsFile: join(root, 'retired.json') }) }
  catch (error) { retiredProviderError = error.message }
  ok(retiredProviderError.includes('providers must be a non-empty subset'),
    'explicit OrcaRouter configuration is rejected before mounting')
  // ── credential store ─────────────────────────────────────────────────────
  console.log('credential store')
  const store = new CredentialFile(join(root, 'creds', 'credentials.json'))
  const firstCred = { type: 'oauth', access: 'a1', refresh: 'r1', expires: Date.now() + 3_600_000 }
  await store.modify('anthropic', async () => firstCred)
  ok((await store.read('anthropic'))?.access === 'a1', 'modify persists and read returns the credential')
  const document = JSON.parse(readFileSync(store.path, 'utf8'))
  ok(document.version === 1 && document.providers['anthropic']?.type === 'oauth', 'file shape is the versioned document')
  await store.modify('anthropic', async () => undefined)
  ok((await store.read('anthropic'))?.access === 'a1', 'undefined from modify leaves the entry unchanged')
  ok((await store.list()).length === 1 && (await store.list())[0].type === 'oauth', 'list reports credential metadata without secrets')
  ok((await store.describe()).length === 1, 'describe lists stored providers without secrets')

  // The exclusion pi-ai's refresh-under-lock depends on: two modifies for one
  // provider run serialized, the second seeing the first's write.
  let observed = []
  await Promise.all([
    store.modify('xai', async current => {
      observed.push(current?.access)
      await delay(15)
      return { type: 'oauth', access: 'x1', refresh: 'r', expires: Date.now() + 60_000 }
    }),
    store.modify('xai', async current => {
      observed.push(current?.access)
      return { type: 'oauth', access: 'x2', refresh: 'r', expires: Date.now() + 60_000 }
    }),
  ])
  ok(JSON.stringify(observed) === JSON.stringify([undefined, 'x1']), `concurrent modifies serialize, each seeing the last write (saw ${JSON.stringify(observed)})`)
  ok((await store.read('xai'))?.access === 'x2', 'the last modify wins on disk')

  await store.modify('openrouter', async () => ({ type: 'api_key', key: 'test-key' }))
  const reopened = new CredentialFile(store.path)
  ok((await reopened.read('openrouter'))?.type === 'api_key', 'API key survives reopening the version-1 file')
  const keyStatus = (await reopened.describe()).find(row => row.provider === 'openrouter')
  ok(keyStatus?.credentialKind === 'api-key' && keyStatus.expiresAt === undefined,
    'API key status has no fabricated expiry')
  await store.modify('openrouter', async () => ({ type: 'oauth', access: 'exchanged-key', refresh: '', expires: Date.now() + 60_000 }))
  const exchangedKeyStatus = (await store.describe()).find(row => row.provider === 'openrouter')
  ok(exchangedKeyStatus?.credentialKind === 'api-key' && exchangedKeyStatus.expiresAt === undefined && !exchangedKeyStatus.expired,
    'OpenRouter OAuth-exchanged key never displays an OAuth token expiry')

  ok(await (async () => { const had = (await store.read('anthropic')) !== undefined; await store.delete('anthropic'); return had })(), 'delete removes the credential')
  ok((await store.read('anthropic')) === undefined, 'deleted entry reads as nothing stored')

  const worker = (provider, value) => new Promise(resolve => {
    const script = `import { CredentialFile } from './lib/credentials.js';
      const [path, provider, value] = process.argv.slice(1);
      const store = new CredentialFile(path);
      await store.modify(provider, async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return { type: 'api_key', key: value };
      });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, store.path, provider, value], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' })
    child.on('close', code => resolve(code))
  })
  const workerCodes = await Promise.all([worker('worker-a', 'key-a'), worker('worker-b', 'key-b')])
  const afterWorkers = new CredentialFile(store.path)
  ok(workerCodes.every(code => code === 0) && (await afterWorkers.read('worker-a'))?.key === 'key-a'
    && (await afterWorkers.read('worker-b'))?.key === 'key-b', 'two processes preserve distinct provider updates')

  const rotationStore = new CredentialFile(join(root, 'rotation', 'credentials.json'))
  await rotationStore.modify('nous', async () => ({
    type: 'oauth', access: 'expired-access', refresh: 'initial-refresh', expires: Date.now() - 1000,
  }))
  const refreshWorker = () => new Promise(resolve => {
    const script = `import { CredentialFile } from './lib/credentials.js';
      import { refreshNous } from './lib/nous-oauth.js';
      const store = new CredentialFile(process.argv[1]);
      globalThis.fetch = async (_url, options) => {
        const used = options.headers['x-nous-refresh-token'];
        const next = used === 'initial-refresh' ? 'rotated-one' : used === 'rotated-one' ? 'rotated-two' : undefined;
        return next === undefined
          ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
          : new Response(JSON.stringify({ access_token: 'access-' + next, refresh_token: next, expires_in: 3600 }), { status: 200 });
      };
      const updated = await store.modify('nous', async current => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return refreshNous(current, 'hermes-cli');
      });
      process.stdout.write(updated.refresh);`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, rotationStore.path],
      { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('close', code => resolve({ code, output }))
  })
  const rotations = await Promise.all([refreshWorker(), refreshWorker()])
  ok(rotations.every(result => result.code === 0)
    && JSON.stringify(rotations.map(result => result.output).sort()) === JSON.stringify(['rotated-one', 'rotated-two'])
    && (await new CredentialFile(rotationStore.path).read('nous'))?.refresh === 'rotated-two',
  'two processes refresh a rotating Nous token once each under the file lock')

  const corruptPath = join(root, 'corrupt.json')
  writeFileSync(corruptPath, '{not json', { mode: 0o600 })
  let corruptRefused = false
  try {
    await new CredentialFile(corruptPath).read('anyone')
  } catch {
    corruptRefused = true
  }
  ok(corruptRefused, 'corrupt file refuses loudly instead of acting empty')
  const wrongShapePath = join(root, 'wrong-shape.json')
  writeFileSync(wrongShapePath, '{"version":1,"providers":[]}', { mode: 0o600 })
  let wrongShapeRefused = false
  try { await new CredentialFile(wrongShapePath).read('anyone') } catch { wrongShapeRefused = true }
  ok(wrongShapeRefused, 'array-shaped provider store refuses instead of acting empty')

  // ── profiles ─────────────────────────────────────────────────────────────
  console.log('profiles')
  const profile = buildOAuthProfile('openai-codex')
  ok(profile.provider === 'openai-codex' && profile.displayName.length > 0, 'profile builds with catalog identity')
  ok(profile.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object')
  ok(typeof profile.piProvider.auth.oauth?.name === 'string', 'the flow carries a display name')
  ok(profile.maxRequestImageBytes === 20 * 1024 * 1024, 'image budgets mirror llm-pi-ai defaults')
  ok(OAUTH_PROVIDER_IDS.length === 3, `mounted provider set is the expected trio (got ${OAUTH_PROVIDER_IDS.join(',')})`)
  let unknownProvider = ''
  try {
    buildOAuthProfile('not-a-provider')
  } catch (error) {
    unknownProvider = error.message
  }
  ok(unknownProvider.includes('not a catalog provider'), 'building an unmounted provider fails loudly')

  // ── per-model overrides ─────────────────────────────────────────────────
  console.log('model overrides')
  const solBase = profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(solBase !== undefined && typeof solBase?.contextWindow === 'number', 'the catalog ships a numeric context window for gpt-5.6-sol')
  const overridden = buildOAuthProfile('openai-codex', {
    'gpt-5.6-sol': { contextWindow: 1000000 },
  })
  const sol = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(sol?.contextWindow === 1000000, 'modelOverrides contextWindow lands on the target model')
  ok(sol?.maxTokens === solBase?.maxTokens, 'untouched fields keep the installed catalog value')
  const untouched = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.5')
  ok(untouched?.contextWindow === solBase?.contextWindow, 'models without an override stay on the catalog value')
  ok(overridden.piProvider.getModels().length === profile.piProvider.getModels().length, 'the model list keeps every catalog entry')
  ok(overridden.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object under overrides')
  ok(profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')?.contextWindow === solBase?.contextWindow,
    'the installed catalog object is not mutated in place')
  let unknownOverride = ''
  try {
    buildOAuthProfile('openai-codex', { 'not-a-model': { contextWindow: 1 } })
  } catch (error) {
    unknownOverride = error.message
  }
  ok(unknownOverride.includes('does not ship in the installed catalog'), 'an override naming an unknown model fails loudly')
  // Overrides are provider-scoped: a dict that tunes a Codex model is refused
  // on a provider whose catalog does not ship it (the global-dict shape made
  // one cross-provider model id break every provider's boot).
  let crossProviderOverride = ''
  try {
    buildOAuthProfile('anthropic', { 'gpt-5.6-sol': { contextWindow: 1000000 } })
  } catch (error) {
    crossProviderOverride = error.message
  }
  ok(crossProviderOverride.includes('does not ship in the installed catalog'), 'an override naming a model another provider ships is refused on this provider')

  const router = buildOAuthProfile('openrouter').piProvider
  ok(router.auth.oauth !== undefined && router.auth.apiKey !== undefined, 'OpenRouter keeps both authentication methods')
  for (const id of ['opencode', 'opencode-go']) {
    const snapshot = parseSnapshot(OPEN_CODE_SNAPSHOTS[id], id)
    ok(snapshot.models.length > 0, `${id} owns a pi-independent model catalog`)
    ok(snapshot.models.length + snapshot.excluded.length === snapshot.roster.length, `${id} classifies every roster id`)
    ok(new Set(snapshot.roster).size === snapshot.roster.length, `${id} has unique roster ids`)
  }
  const catalogFetch = globalThis.fetch
  try {
    for (const [id, modelId, expectedUrl] of [
      ['openrouter', 'aion-labs/aion-2.0', 'https://openrouter.ai/api/v1/chat/completions'],
    ]) {
      let request
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers)
        request = { url: String(url), authorization: headers.get('authorization'), session: headers.get('x-opencode-session'), body: JSON.parse(options.body) }
        return new Response([
          'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]', '',
        ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const route = buildOAuthProfile(id)
      const adapter = new CredentialGatedAdapter({
        ...gateAdapterOptions(), profiles: () => new Map([[id, route]]),
        resolveApiKey: async () => 'catalog-fixture-key',
      }, async () => true)
      const chunks = []
      for await (const chunk of adapter.stream({ provider: id, model: modelId,
        sessionId: 'dsh-session-123',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [],
      })) chunks.push(chunk)
      ok(request?.url === expectedUrl && request.authorization === 'Bearer catalog-fixture-key'
        && request.session === (id.startsWith('opencode') ? 'dsh-session-123' : null)
        && request.body.model === modelId && chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'),
      `${id} catalog model streams to the exact Chat Completions URL with its API key`)
    }

  } finally { globalThis.fetch = catalogFetch }

  // ── credential-gated adapter ─────────────────────────────────────────────
  console.log('credential-gated adapter')
  const gateStore = new CredentialFile(join(root, 'gate', 'credentials.json'))
  const gated = new CredentialGatedAdapter(gateAdapterOptions(), async provider => {
    try {
      return await gateStore.read(provider) !== undefined
    } catch {
      return false
    }
  })
  const anyGptModel = (await gated.listModels('openai-codex'))[0]
  ok(anyGptModel === undefined, 'unsigned provider lists no models')
  const resolvedWhileUnsigned = await gated.resolveModel('openai-codex', 'gpt-5.6-sol')
  ok(resolvedWhileUnsigned?.id === 'gpt-5.6-sol', 'resolveModel stays ungated (saved sessions keep working)')
  await gateStore.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }))
  const listed = await gated.listModels('openai-codex')
  ok(listed.length > 0 && listed.every(m => m.provider === 'openai-codex'), `signed-in provider lists its catalog (${listed.length} models)`)
  ok((await gated.listModels('anthropic')).length === 0, 'other unsigned providers stay hidden on the same store')

  const registrations = []
  const released = []
  const registrationErrors = []
  const effects = []
  const holder = { api: undefined }
  await apply({
    get: service => service === 'dshAuth' ? holder
      : service === 'llm' ? { registerAdapter: providers => {
        const id = providers[0]
        if (id === 'openai-codex') throw new Error('route already owned')
        registrations.push(id)
        return () => { released.push(id) }
      } }
        : service === 'commands' ? { register: descriptor => {
          registrations.push(`/${descriptor.name}`)
          return () => { released.push(`/${descriptor.name}`) }
        } }
          : undefined,
    logger: { warn() {}, error: message => { registrationErrors.push(message) } },
    effect: callback => { const effect = callback(); effects.push({ effect, drain: effect.next().value }) },
  }, { providers: ['openai-codex', 'opencode'], credentialsFile: join(root, 'collision', 'credentials.json') })
  ok(JSON.stringify(registrations) === JSON.stringify(['opencode', '/auth'])
    && registrationErrors.some(message => message.includes('openai-codex') && message.includes('route already owned'))
    && holder.api !== undefined,
  'route collision reports the owner conflict while other routes and /auth continue mounting')
  await effects[0].drain()
  const cleanup = effects[0].effect.next().value
  cleanup()
  ok(JSON.stringify(released) === JSON.stringify(['opencode', '/auth']),
    'route collision does not add a disposer for the existing owner')

  console.log('custom chat-completion profiles')
  const custom = createCustomProfile('nous')
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  let requestedAuthorization = ''
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url)
    requestedAuthorization = options.headers.Authorization
    return new Response(JSON.stringify({ data: [
      { id: 'chat/model', supported_endpoint_types: ['openai'], supported_parameters: ['tools'], context_length: 32768, max_completion_tokens: 4096,
        pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'response/model', supported_endpoint_types: ['openai-response'], supported_parameters: ['tools'], context_length: 32768, max_completion_tokens: 4096,
        pricing: { prompt: '0.000001', completion: '0.000002' } },
    ] }), { status: 200 })
  }
  try {
    const count = await custom.refresh('fixture-key')
    ok(count === 1 && custom.profile.piProvider.getModels()[0].id === 'chat/model', 'discovery keeps exact chat-compatible model ids')
    ok(requestedUrl === 'https://inference-api.nousresearch.com/v1/models' && requestedAuthorization === 'Bearer fixture-key', 'model discovery uses one /v1 and bearer header')
    ok(custom.profile.piProvider.getModels()[0].api === 'openai-completions', 'custom model uses Chat Completions')
    const customAdapter = new CredentialGatedAdapter({ ...gateAdapterOptions(), profiles: () => new Map([['nous', custom.profile]]) }, async () => true)
    ok((await customAdapter.listModels('nous')).some(model => model.id === 'chat/model'), 'refreshed model appears in adapter listing')
    custom.clear()
    ok((await customAdapter.listModels('nous')).length === 0, 'logout removes custom model from adapter listing')
    const infron = createCustomProfile('infron')
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: 'vendor/chat', category_type: 'LLM', supported_endpoint_types: ['openai'], context_length: 65536,
        max_output_tokens: 4096, supports_function_calling: true, supports_streaming: true,
        min_prompt_price: 0.05, min_completion_price: 0.4, input_modalities: ['text'] },
      { id: 'vendor/embed', category_type: 'Embedding', supported_endpoint_types: ['embedding'],
        context_length: 65536, max_output_tokens: 4096, min_prompt_price: 0.05, min_completion_price: 0.4 },
    ] }), { status: 200 })
    ok(await infron.refresh('fixture-key') === 1 && infron.profile.piProvider.getModels()[0].cost.input === 0.05,
      'Infron models use its per-million prices and exclude non-chat categories')
    let streamRequest
    globalThis.fetch = async (url, options) => {
      streamRequest = { url: String(url), authorization: new Headers(options.headers).get('authorization'), body: JSON.parse(options.body) }
      return new Response([
        'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]', '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const streamAdapter = new CredentialGatedAdapter({
      ...gateAdapterOptions(), profiles: () => new Map([['infron', infron.profile]]),
      resolveApiKey: async () => 'fixture-key',
    }, async () => true)
    const chunks = []
    for await (const chunk of streamAdapter.stream({ provider: 'infron', model: 'vendor/chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: {} } }],
    })) chunks.push(chunk)
    ok(streamRequest?.url === 'https://llm.onerouter.pro/v1/chat/completions'
      && streamRequest.authorization === 'Bearer fixture-key' && streamRequest.body.model === 'vendor/chat'
      && streamRequest.body.tools?.[0]?.function?.name === 'probe',
    'custom provider sends exact URL, bearer key, model id, and tool schema')
    ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello'), 'custom provider streams text deltas')
    globalThis.fetch = async () => new Response([
      'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"probe","arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]', '',
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const toolChunks = []
    for await (const chunk of streamAdapter.stream({ provider: 'infron', model: 'vendor/chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'call probe' }] }],
      tools: [{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: {} } }],
    })) toolChunks.push(chunk)
    ok(toolChunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'probe'),
      'custom provider streams tool-call deltas')
    const nous = createCustomProfile('nous')
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: 'provider/tool-chat', context_length: 32768, top_provider: { max_completion_tokens: 4096 },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'],
        pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'provider/no-tools', context_length: 32768, top_provider: { max_completion_tokens: 4096 },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [],
        pricing: { prompt: '0.000001', completion: '0.000002' } },
    ] }), { status: 200 })
    ok(await nous.refresh('fixture-token') === 1 && nous.profile.piProvider.getModels()[0].id === 'provider/tool-chat',
      'Nous model discovery excludes entries without declared tool support')
    for (const [status, expected] of [[401, 'API key rejected'], [403, 'not allowed'], [429, 'rate limited'], [503, 'provider unavailable']]) {
      globalThis.fetch = async () => new Response('', { status })
      let message = ''
      try { await custom.refresh('secret-fixture-key') } catch (error) { message = error.message }
      ok(message.includes(`HTTP ${status}`) && message.includes(expected) && !message.includes('secret-fixture-key'),
        `model discovery identifies HTTP ${status} without exposing the key`)
    }
    globalThis.fetch = async () => new Response('{bad-json', { status: 200 })
    let invalidMessage = ''
    try { await custom.refresh('secret-fixture-key') } catch (error) { invalidMessage = error.message }
    ok(invalidMessage.includes('invalid JSON') && !invalidMessage.includes('secret-fixture-key'),
      'model discovery identifies invalid JSON without exposing the key')
    globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    let invalidListMessage = ''
    try { await custom.refresh('secret-fixture-key') } catch (error) { invalidListMessage = error.message }
    ok(invalidListMessage.includes('invalid list') && !invalidListMessage.includes('secret-fixture-key'),
      'model discovery rejects a non-array list without exposing the key')
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: 'embed-only', supported_endpoint_types: ['embedding'], context_length: 32768,
        max_completion_tokens: 4096, pricing: { prompt: '0.000001', completion: '0.000002' } },
    ] }), { status: 200 })
    let noChatMessage = ''
    try { await custom.refresh('secret-fixture-key') } catch (error) { noChatMessage = error.message }
    ok(noChatMessage.includes('no chat models') && !noChatMessage.includes('secret-fixture-key'),
      'model discovery refuses a list with no verified chat model')
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('Infron service tier configuration and wire')
  try {
    for (const serviceTier of [undefined, 'standard', 'flex']) {
      ok(AuthConfig({ infron: { serviceTier } }).infron.serviceTier === serviceTier,
        `configuration schema retains Infron ${serviceTier ?? 'default'} tier`)
      const requests = []
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [
          { id: 'z-ai/glm-5.3', category_type: 'LLM', supported_endpoint_types: ['openai'],
            context_length: 1024000, max_output_tokens: 128000, supports_function_calling: true,
            supports_streaming: true, min_prompt_price: 1.4, min_completion_price: 4.4 },
        ] }), { status: 200 })
        requests.push({ url: String(url), authorization: new Headers(options.headers).get('authorization'), body: JSON.parse(options.body) })
        return new Response([
          'data: {"id":"tier-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"tier-ok"},"finish_reason":null}]}',
          'data: {"id":"tier-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]', '',
        ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const holder = { api: undefined }
      let mounted
      let lifecycle
      await apply({
        get: name => name === 'dshAuth' ? holder
          : name === 'llm' ? { registerAdapter: (_providers, adapter) => { mounted = adapter; return () => {} } }
            : name === 'userQuestions' ? { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: [], custom: 'tier-fixture-key' }] }) }
              : undefined,
        logger: { warn() {}, error() {} },
        effect: callback => { lifecycle = callback(); lifecycle.next() },
      }, { providers: ['infron'], credentialsFile: join(root, `tier-${serviceTier ?? 'default'}.json`),
        ...(serviceTier === undefined ? {} : { infron: { serviceTier } }),
      })
      const login = await holder.api.login('infron')
      ok(login.modelWarning === undefined && (await mounted.listModels('infron')).some(model => model.id === 'z-ai/glm-5.3'),
        `Infron ${serviceTier ?? 'default'} configuration discovers the model through sign-in`)
      const input = { provider: 'infron', model: 'z-ai/glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: {} } }],
      }
      const prepared = await mounted.prepareCall('infron', input.model)
      for (const stream of [() => mounted.stream(input), () => prepared.stream(input)]) {
        const chunks = []
        for await (const chunk of stream()) chunks.push(chunk)
        const request = requests.at(-1)
        ok(request?.url === 'https://llm.onerouter.pro/v1/chat/completions'
          && request.authorization === 'Bearer tier-fixture-key' && request.body.model === input.model
          && request.body.tools?.[0]?.function?.name === 'probe'
          && request.body.provider?.service_tier === serviceTier
          && (serviceTier !== undefined || !Object.hasOwn(request.body, 'provider'))
          && !Object.hasOwn(request.body, 'extra_body') && !Object.hasOwn(request.body, 'service_tier')
          && chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'tier-ok'),
        `Infron ${serviceTier ?? 'default'} tier reaches direct and prepared wire requests without an extra_body wrapper`)
      }
      if (serviceTier === 'flex') {
        const custom = createCustomProfile('infron', {}, serviceTier)
        await custom.refresh('tier-fixture-key')
        const provider = custom.profile.piProvider
        let transformed
        const result = await provider.streamSimple(provider.getModels()[0], { messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 0 },
        ] }, { apiKey: 'tier-fixture-key', onPayload: async payload => {
          transformed = Object.freeze({ ...payload, provider: Object.freeze({ only: ['z-ai'], service_tier: 'standard' }), usage: { include: true } })
          return transformed
        } }).result()
        const body = requests.at(-1)?.body
        ok(result.stopReason !== 'error' && body?.provider?.service_tier === 'flex'
          && body.provider.only?.[0] === 'z-ai' && body.usage?.include === true,
        'Infron tier merges with an async payload transform and retains other routing fields')
        ok(transformed?.provider.service_tier === 'standard', 'tier injection does not mutate the caller payload')
      }
      const drain = lifecycle.next().value
      await drain()
      lifecycle.next()
    }
    for (const invalid of ['standard/flex', 'priority', '', null, 1]) {
      let message = ''
      try { await apply({}, { providers: ['infron'], infron: { serviceTier: invalid } }) }
      catch (error) { message = error.message }
      ok(message.includes('infron.serviceTier'), `invalid Infron service tier ${JSON.stringify(invalid)} is rejected before mounting`)
    }
  } finally { globalThis.fetch = originalFetch }

  // ── question bridge ──────────────────────────────────────────────────────
  console.log('question bridge')
  const runAbort = new AbortController()
  const asked = []
  // Scripted answers for the waiting panel, consumed in order; the default
  // mirrors the old behavior (immediate cancel).
  let waitingScript = ['Cancel sign-in']
  let waitingAsked = 0
  const openedUrls = []
  const copiedTexts = []
  const helpers = {
    openUrl: url => { openedUrls.push(url); return true },
    copyText: async text => { copiedTexts.push(text); return true },
  }
  const fakeAsk = async request => {
    asked.push(request)
    const question = request.questions[0]
    if (question.id === 'dsh-auth-prompt' && question.options !== undefined) {
      return { answers: [{ id: question.id, selected: [question.options[0].label] }] }
    }
    if (question.id === 'dsh-auth-waiting') {
      waitingAsked += 1
      const pick = waitingScript[waitingAsked - 1]
      if (pick === undefined) {
        // Script exhausted: park like a human who has not answered yet —
        // only settle()'s abort resolves this, proving the retire path.
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('panel retired')), { once: true })
        })
      }
      return { answers: [{ id: question.id, selected: [pick] }] }
    }
    return { answers: [{ id: question.id, selected: [], custom: 'typed-answer' }] }
  }
  const qb = new QuestionBridge(fakeAsk, runAbort, helpers)
  const selectId = await qb.prompt({ type: 'select', message: 'Choose', options: [{ id: 'opt-2', label: 'Option Two' }, { id: 'opt-1', label: 'Option One' }] })
  ok(selectId === 'opt-2', `select prompt maps the chosen label back to its id (got ${selectId})`)
  const typed = await qb.prompt({ type: 'manual_code', message: 'Paste the code', placeholder: 'xxxx-xxxx' })
  ok(typed === 'typed-answer', 'text prompt reads the custom-answer input row')
  const secret = await qb.prompt({ type: 'secret', message: 'Enter API key' })
  ok(secret === 'typed-answer' && asked.at(-1).questions[0].id === 'dsh-auth-secret', 'secret prompt marks the answer for masked TUI entry')

  // auth_url: browser opens automatically, panel offers copy/reopen/cancel,
  // and each action re-asks once before the scripted cancel.
  const longUrl = 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  waitingScript = ['Copy authorization link', 'Open browser again', 'Cancel sign-in']
  qb.notify({ type: 'auth_url', url: longUrl, instructions: 'A browser window should open.' })
  for (let i = 0; i < 40 && !runAbort.signal.aborted; i += 1) await delay(5)
  ok(openedUrls[0] === longUrl, 'auth_url opens the browser automatically')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy authorization link')), 'waiting panel offers a copy action')
  ok(runAbort.signal.aborted, 'cancel from the waiting panel aborts the run')
  ok(JSON.stringify(copiedTexts) === JSON.stringify([longUrl]), 'copy action copies the exact, unbroken URL')
  ok(openedUrls.length === 2 && openedUrls[1] === longUrl, 'reopen action opens the same URL again')
  ok(waitingAsked === 3, `the panel re-asks after each action (asked ${waitingAsked})`)
  await qb.settle()

  // device_code: verification page auto-opens, the code is the copy target,
  // and settle retires the panel without any cancel answer.
  const runAbort2 = new AbortController()
  const qb2 = new QuestionBridge(fakeAsk, runAbort2, helpers)
  waitingScript = ['Copy code']
  waitingAsked = 0
  qb2.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
  for (let i = 0; i < 40 && copiedTexts.length < 2; i += 1) await delay(5)
  ok(openedUrls[2] === 'https://auth.example/device', 'device flow opens the verification page automatically')
  ok(copiedTexts[1] === 'ABCD-1234', 'copy action on the device panel copies the user code')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy code')), 'device panel offers Copy code')
  await qb2.settle()

  // auto-open failure degrades to copy guidance, never a crash.
  const runAbort3 = new AbortController()
  const qb3 = new QuestionBridge(fakeAsk, runAbort3, { openUrl: () => false, copyText: async () => false })
  waitingScript = ['Cancel sign-in']
  waitingAsked = 0
  qb3.notify({ type: 'auth_url', url: 'https://auth.example/x' })
  await delay(10)
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && (r.questions[0]?.detail ?? '').includes('too long')), 'failed open degrades to copy guidance')
  await qb3.settle()

  // ── opener argv shape ────────────────────────────────────────────────────
  console.log('opener argv')
  const authorizeLikeUrl = 'https://auth.openai.com/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  const opener = openerFor(authorizeLikeUrl)
  if (process.platform === 'win32') {
    ok(opener?.verbatim === true, 'win32 opener uses verbatim argv (node would not quote a space-free URL)')
    const startToken = opener?.args[3]
    ok(typeof startToken === 'string' && startToken.startsWith('start "" "') && startToken.endsWith('"'),
      `the whole start command is one token with the URL double-quoted inside (got ${JSON.stringify(startToken?.slice(0, 32))}…)`)
    // Live round-trip through a real cmd.exe: `&` inside double quotes must
    // survive the shell that `start` will run under. Echo (not start) keeps
    // this side-effect free.
    const echo = await new Promise(resolve => {
      const child = spawn('cmd.exe', ['/d', '/c', `echo "${authorizeLikeUrl}"`], { windowsVerbatimArguments: true })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('close', () => resolve(out.trim()))
      child.on('error', () => resolve(''))
    })
    ok(echo.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann') && echo.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455'),
      `a quoted URL survives cmd.exe parsing intact (echo returned ${echo.length} chars)`)
  } else {
    ok(opener !== undefined && !opener.verbatim && opener.args[0] === authorizeLikeUrl,
      `${process.platform} opener passes the URL as a single exec argument (no shell)`)
  }

  // ── service api ──────────────────────────────────────────────────────────
  console.log('service api')
  const apiStore = new CredentialFile(join(root, 'api', 'credentials.json'))
  const fakeProvider = {
    id: 'fake',
    name: 'Fake Provider',
    auth: {
      oauth: {
        name: 'Fake (subscription)',
        loginLabel: 'Sign in with Fake',
        async login() {
          return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }
        },
        async refresh(credential) {
          return credential
        },
        async toAuth() {
          return { headers: { authorization: 'Bearer a' } }
        },
      },
    },
  }
  const fakeProfile = { provider: 'fake', displayName: 'Fake Provider', streamIdleTimeoutMs: 300_000, retryPolicy: { mode: 'normal', maxRetries: 2, retryDelayMs: () => 1 }, configuredMaxTokens: new Map(), piProvider: fakeProvider, oauth: fakeProvider.auth.oauth, maxRequestImageBytes: 1, requestImagePixelBudget: 1, requestImageMaxBytes: 1 }
  const api = createDshAuthApi({
    profiles: new Map([['fake', fakeProfile]]),
    store: apiStore,
    resolveAsk: () => fakeAsk,
    logger: { warn() {} },
  })
  ok((await api.providers())[0].signedIn === false, 'status reports unsigned providers')
  const login = await api.login('fake')
  ok(login.oauthLabel === 'Fake (subscription)' && (await apiStore.read('fake'))?.access === 'a', 'login runs the flow and persists the credential')
  ok((await api.providers())[0].signedIn === true, 'status reports the signed-in provider')
  ok(await api.logout('fake'), 'logout removes the credential')
  let unknownLogin = ''
  try {
    await api.login('nobody')
  } catch (error) {
    unknownLogin = error.message
  }
  ok(unknownLogin.includes('unknown provider'), 'login names the mounted set on an unknown provider')

  let finishLateLogin
  const lateFlow = new Promise(resolve => { finishLateLogin = resolve })
  const raceProvider = { ...fakeProvider, auth: { oauth: {
    ...fakeProvider.auth.oauth,
    login: async () => { await lateFlow; return { type: 'oauth', access: 'late-access', refresh: 'late-refresh', expires: Date.now() + 60_000 } },
  } } }
  const raceStore = new CredentialFile(join(root, 'logout-race', 'credentials.json'))
  const raceApi = createDshAuthApi({
    profiles: new Map([['fake', { ...fakeProfile, oauth: raceProvider.auth.oauth }]]),
    store: raceStore, resolveAsk: () => fakeAsk, logger: { warn() {} },
  })
  const lateLogin = raceApi.login('fake').catch(error => error.message)
  await Promise.resolve()
  await raceApi.logout('fake')
  finishLateLogin()
  ok((await lateLogin).includes('cancelled') && (await raceStore.read('fake')) === undefined,
    'logout prevents an older in-flight login from reviving credentials')

  console.log('API key and aliases')
  const keyStore = new CredentialFile(join(root, 'api-key', 'credentials.json'))
  const keyApi = createDshAuthApi({
    profiles: new Map([['opencode', { provider: 'opencode', displayName: 'OpenCode Zen' }], ['openrouter', { provider: 'openrouter', displayName: 'OpenRouter', oauth: buildOAuthProfile('openrouter').piProvider.auth.oauth }]]),
    store: keyStore,
    resolveAsk: () => fakeAsk,
    logger: { warn() {} },
  })
  ok(canonicalProvider('opencode-zen') === 'opencode' && canonicalProvider('hermes') === 'nous' && canonicalProvider('infron.ai') === 'infron', 'aliases resolve to canonical ids')
  const keyLogin = await keyApi.login('opencode-zen')
  ok(keyLogin.provider === 'opencode' && (await keyStore.read('opencode'))?.key === 'typed-answer', 'API key login saves under canonical id')
  const openCodeStatus = (await keyApi.providers()).find(row => row.provider === 'opencode')
  ok(openCodeStatus?.credentialKind === 'api-key' && openCodeStatus.expiresAt === undefined, 'API key status has no expiry')
  ok(await keyApi.logout('opencode-zen') && (await keyStore.read('opencode')) === undefined, 'alias logout removes canonical credential')
  await keyStore.modify('openrouter', async () => ({ type: 'oauth', access: 'router-key', refresh: '', expires: Number.MAX_SAFE_INTEGER }))
  const routerStatus = (await keyApi.providers()).find(row => row.provider === 'openrouter')
  ok(routerStatus?.credentialKind === 'api-key' && routerStatus.expiresAt === undefined && routerStatus.signedIn, 'OpenRouter OAuth-exchanged key has no displayed expiry')

  console.log('Nous device OAuth')
  const originalNousFetch = globalThis.fetch
  const calls = []
  let tokenPolls = 0
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: String(options.body), headers: options.headers })
    if (String(url).endsWith('/device/code')) return new Response(JSON.stringify({
      device_code: 'device-fixture', user_code: 'CODE-123', verification_uri: 'https://portal.nousresearch.com/device',
      verification_uri_complete: 'https://portal.nousresearch.com/device',
      expires_in: 3, interval: 0.001,
    }), { status: 200 })
    if (options.headers['x-nous-refresh-token']) return new Response(JSON.stringify({
      access_token: 'refreshed-access', refresh_token: 'rotated-refresh', expires_in: 3600,
    }), { status: 200 })
    tokenPolls += 1
    return tokenPolls === 1
      ? new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
      : new Response(JSON.stringify({ access_token: 'device-access', refresh_token: 'first-refresh', expires_in: 3600 }), { status: 200 })
  }
  try {
    const notices = []
    const device = await loginNous({ signal: AbortSignal.timeout(5000), notify: event => notices.push(event) }, 'hermes-cli')
    ok(device.access === 'device-access' && device.refresh === 'first-refresh' && tokenPolls === 2,
      'device polling waits for authorization and stores both tokens')
    ok(notices[0]?.type === 'device_code' && notices[0]?.userCode === 'CODE-123'
      && calls[0].body.includes('scope=inference%3Ainvoke') && calls[1].body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'),
    'device flow sends the inference scope and OAuth device grant')
    const rotated = await refreshNous(device, 'hermes-cli')
    ok(rotated.access === 'refreshed-access' && rotated.refresh === 'rotated-refresh'
      && calls.at(-1).headers['x-nous-refresh-token'] === 'first-refresh', 'refresh token rotates under the dedicated header')
    const cancelled = new AbortController()
    cancelled.abort()
    let cancellation = ''
    try { await loginNous({ signal: cancelled.signal, notify() {} }, 'hermes-cli') } catch (error) { cancellation = error.message }
    ok(cancellation.includes('cancelled'), 'device sign-in cancellation is reported without replacing credentials')
    for (const [code, expected] of [['access_denied', 'denied'], ['expired_token', 'expired']]) {
      globalThis.fetch = async (url) => String(url).endsWith('/device/code')
        ? new Response(JSON.stringify({ device_code: 'device-fixture', user_code: 'CODE-123',
          verification_uri: 'https://portal.nousresearch.com/device',
          verification_uri_complete: 'https://portal.nousresearch.com/device', expires_in: 3, interval: 0.001 }), { status: 200 })
        : new Response(JSON.stringify({ error: code }), { status: 400 })
      let message = ''
      try { await loginNous({ signal: AbortSignal.timeout(5000), notify() {} }, 'hermes-cli') }
      catch (error) { message = error.message }
      ok(message.includes(expected), `device flow reports ${code} without replacing credentials`)
    }
  } finally {
    globalThis.fetch = originalNousFetch
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
