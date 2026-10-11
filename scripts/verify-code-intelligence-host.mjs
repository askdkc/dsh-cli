/** Real public plugin bundle, services, registry and server; no model API.
 * --consumer-root also runs against files installed from the CLI tarball. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname)
const require = createRequire(join(root, 'package.json'))
const module = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await module('@deepseek-ai/cordis')
const { default: Loader } = await module('@deepseek-ai/cordis-plugin-loader')
const { default: AgentPresetRegistry } = await module('@deepseek-ai/dsh-agent-preset-registry')
const { default: SessionProjectionRegistry } = await module('@deepseek-ai/dsh-session-projection')
const { createScope } = await module('@deepseek-ai/dsh-scope')
const { parse } = await module('yaml')
const { createChannelCodeIntelligence } = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/channel/code-intelligence-host.js')).href)
const { createChannelOwner } = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/channel/owner.js')).href)
const { serviceForAgent } = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/presets.js')).href)
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-code-consumer-')))
const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-code-outside-')))
const text = 'export function 日本語(value: string) { return value + "🙂é" }\r\nconst answer: number = "wrong";\r\n日本語("ok");\r\n'
const ctx = new Context()
ctx.logger.error = (...args) => console.error(...args)
ctx.baseUrl = pathToFileURL(join(root, 'cordis.patch.yml')).href
const lifetimes = []
try {
  await writeFile(join(workspace, 'fixture.ts'), text)
  await writeFile(join(workspace, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
  await writeFile(join(outside, 'outside.ts'), 'export const secret = 1')
  await symlink(join(outside, 'outside.ts'), join(workspace, 'escape.ts'))
  await ctx.plugin(Loader)
  const providerRoot = resolve(require.resolve('@askdkc/dsh-lsp-server/package.json'), '..')
  const patch = parse(await readFile(join(providerRoot, 'cordis.patch.yml'), 'utf8'))
  const bundle = patch.flatMap(item => item.insert ?? [])
  const host = [
    { id: 'fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: workspace } },
    { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
  ]
  const rows = [...host, ...bundle.map(row => row.id === 'lsp-webstack-provider' ? { ...row, config: { ...row.config, servers: { phpantom: { enabled: false }, tailwind: { enabled: false } } } } : row)]
  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  assert.ok(ctx.get('codeIntelligence'), `the published bundle activates the public V1 service: ${JSON.stringify([...ctx.loader.entries()].map(entry => ({ id: entry.id, status: entry.fiber?.status, error: String(entry.fiber?.error ?? '') })))}`)
  assert.deepEqual(ctx.get('tools').schemas().map(tool => tool.name).sort(), ['lsp', 'lsp_extra'])
  const agent = { id: 'fixture-agent', ctx, session: { id: 'fixture-session', header: { cwd: workspace, agentPreset: 'standard' }, events: [], snapshotEvents() { return this.events } } }
  const owner = createChannelOwner()
  let generation = 1
  const binding = {
    get agent() { return agent }, capture: () => ({ agent, generation }),
    isCurrent: capture => capture.generation === generation && capture.agent === agent,
    subscribe: cleanup => owner.own(cleanup),
  }
  const channel = createChannelCodeIntelligence(ctx, { owner, binding, displayCwd: () => workspace, emit() {} })
  lifetimes.push(async () => { owner.dispose(); await channel.shutdown() })
  channel.rebind()
  await ctx.fiber.await()
  const capability = await channel.port.capabilities()
  assert.equal(capability.status, 'ok', JSON.stringify(capability))
  assert.equal(capability.workspace, workspace)
  assert.ok(capability.languages.some(language => language.language === 'typescript' && language.structure))
  for (const path of [relative(workspace, join(outside, 'outside.ts')), 'escape.ts']) {
    const denied = await channel.port.analyze({ path, structure: { method: 'structure.outline' } })
    assert.notEqual(denied.status, 'ok', JSON.stringify(denied))
    assert.equal(denied.results.length, 0, 'an existing outside target must be rejected before structure execution')
  }
  // A real server response, not executable discovery alone.
  const diagnostics = await channel.port.analyze({ path: 'fixture.ts', semantic: { kind: 'diagnostics' } })
  assert.equal(diagnostics.status, 'ok', JSON.stringify(diagnostics))
  assert.ok(diagnostics.results[0].data.items.some(item => /not assignable/u.test(item.message)), JSON.stringify(diagnostics))
  const definition = await channel.port.analyze({ path: 'fixture.ts', semantic: { kind: 'definition', position: { line: 2, character: 1 } } })
  assert.equal(definition.status, 'ok', JSON.stringify(definition))
  assert.ok(definition.results[0].data.items.some(item => item.range.start.line === 0))
  const completion = await channel.port.analyze({ path: 'fixture.ts', semantic: { kind: 'completion', position: { line: 2, character: 1 }, limit: 20 } })
  assert.equal(completion.status, 'partial', JSON.stringify(completion))
  assert.equal(completion.results[0].truncated, true)
  assert.ok(completion.results[0].data.items.length <= 20)
  assert.ok(completion.results[0].data.items.some(item => item.label === '日本語'))
  assert.equal(await readFile(join(workspace, 'fixture.ts'), 'utf8'), text, 'completion applies no edits')
  console.log('real V1 semantics OK (diagnostics, definition, completion, unchanged fixture)')
  const status = await ctx.get('tools').execute({ callId: 'native-status', name: 'lsp_extra', arguments: { operation: 'status' }, agent, signal: new AbortController().signal })
  assert.equal(status.isError, false, JSON.stringify(status))
  const nativeOpen = await ctx.get('tools').execute({ callId: 'native-open', name: 'lsp_extra', arguments: { operation: 'snapshot', action: 'open', file_path: 'fixture.ts' }, agent, signal: new AbortController().signal })
  assert.equal(nativeOpen.isError, false, JSON.stringify(nativeOpen))
  const handle = nativeOpen.value.handle
  assert.equal(typeof handle, 'string')
  const nativeRelease = await ctx.get('tools').execute({ callId: 'native-release', name: 'lsp_extra', arguments: { operation: 'snapshot', action: 'release', handle }, agent, signal: new AbortController().signal })
  assert.equal(nativeRelease.isError, false)
  // External edit -> stale pinned snapshot; fresh request sees the replacement.
  const service = ctx.get('codeIntelligence')
  const signal = new AbortController().signal
  const lease = await service.bind({ owner: { agentId: agent.id, sessionId: agent.session.id }, workspaceRoot: workspace, scope: ctx, context: ctx, assertCurrent() {} }, signal)
  try {
    const open = await lease.request({ method: 'snapshot.open', path: 'fixture.ts' }, signal)
    await writeFile(join(workspace, 'fixture.ts'), text.replace('日本語', 'newName'))
    const stale = await lease.request({ method: 'structure.outline', handle: open.data.handle }, signal)
    assert.equal(stale.status, 'stale', JSON.stringify(stale))
    await lease.request({ method: 'snapshot.release', handle: open.data.handle }, signal)
  } finally { await lease.dispose() }
  // Agent-visible fallback cannot borrow a root-only provider.
  assert.equal(serviceForAgent(ctx, { ctx: { get: () => undefined } }, 'codeIntelligence', { hostFallback: 'visible' }), undefined)
  generation++
  channel.rebind()
  const disabled = rows.map(row => bundle.some(item => item.id === row.id) ? { ...row, disabled: true } : row)
  await ctx.loader.root.update(disabled)
  await ctx.loader.await()
  assert.equal((await channel.port.capabilities()).reason, 'provider_absent')
  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  assert.notEqual(ctx.get('codeIntelligence'), service, 're-enable creates a new provider generation')
  assert.equal((await channel.port.capabilities()).status, 'ok')
  const providerRow = bundle.find(row => row.id === 'lsp-webstack-provider')
  await ctx.loader.root.update([...rows, { ...providerRow, id: 'duplicate-code-provider' }])
  await ctx.loader.await()
  assert.equal((await channel.port.capabilities()).reason, 'duplicate_provider')
  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  assert.equal((await channel.port.capabilities()).status, 'ok')
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresetRegistry, { default: 'fixture-lsp' })
  await ctx.get('agentPresets').register({ id: 'fixture-lsp', plugins: [{
    id: 'code-tools', name: '@deepseek-ai/cordis-plugin-group',
    isolate: { tools: true, systemPrompt: true },
    config: [host.find(row => row.id === 'system-prompt'), host.find(row => row.id === 'tools'), ...bundle.filter(row => row.id === 'tool-lsp' || row.id === 'tool-lsp-extra')],
  }] })
  const scopedAgent = { id: 'scoped-agent', ctx, session: { id: 'scoped-session', header: { cwd: workspace }, events: [], snapshotEvents() { return this.events } } }
  const scope = createScope(ctx, scopedAgent)
  lifetimes.push(() => scope.dispose())
  scopedAgent.ctx = scope.ctx
  const mounted = await ctx.get('agentPresets').mount(scope.ctx, 'fixture-lsp')
  assert.equal(mounted.broken, undefined, JSON.stringify(mounted))
  const scopedTools = serviceForAgent(ctx, scopedAgent, 'tools')
  assert.notEqual(scopedTools, ctx.get('tools'))
  assert.deepEqual(scopedTools.schemas(scopedAgent).map(tool => tool.name).sort(), ['lsp', 'lsp_extra'])
  const scopedStatus = await scopedTools.execute({ callId: 'scoped-status', name: 'lsp_extra', arguments: { operation: 'status' }, agent: scopedAgent, signal: new AbortController().signal })
  assert.equal(scopedStatus.isError, false, JSON.stringify(scopedStatus))
  console.log('explicit user preset OK (isolated tools, scoped native invocation)')
  console.log('real host lifecycle OK (bundle, native registry, scope, stale snapshot, duplicate rejection, disable/re-enable)')
  await writeFile(join(workspace, 'fixture.ts'), text)
  const outline = await channel.port.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' }, semantic: { kind: 'diagnostics' } })
  assert.equal(outline.status, 'ok', JSON.stringify(outline))
  assert.ok(JSON.stringify(outline).includes('日本語'))
  assert.ok(!JSON.stringify(outline).includes('"handle"'))
  assert.equal(new Set(outline.results.map(result => result.snapshotVersion)).size, 1, 'structure and semantics share a pinned version')
  const span = await channel.port.analyze({ path: 'fixture.ts', span: { position: { line: 0, character: 20 }, maxChars: 500 } })
  assert.equal(span.status, 'ok', JSON.stringify(span))
  assert.ok(span.results.some(result => result.data?.text?.includes('🙂é')))
  console.log('real structure OK (grammar, UTF-16 span, same snapshot)')
} finally {
  for (const dispose of lifetimes.reverse()) await dispose()
  await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
