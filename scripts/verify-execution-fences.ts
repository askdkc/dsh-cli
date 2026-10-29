import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-execution-fences-'))
process.env.HOME = home
process.env.USERPROFILE = home
const { Context } = await import('@deepseek-ai/cordis')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const NativeToolExecutor = await import('@deepseek-ai/dsh-tool-executor-native')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const host = await import('../src/dsh-adapter/plugin-host.js')
const { ExecutionFenceRuntime } = await import('../src/dsh-adapter/execution-fences.js')
const root = new Context()
const agents = new Map<string, any>(), sessions = new Map<string, any>()
root.provide('systemPrompt', { tools: () => () => {} })
root.provide('agents', { get: (id: string) => agents.get(id) })
root.provide('sessions', { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] })
await root.plugin(ToolRuntime)
await root.plugin(NativeToolExecutor)
const hostFiber = root.plugin(host)
await hostFiber
const session = { id: 'session', header: { id: 'session', cwd: home } }
const agent: any = { id: 'agent', session }
agent.ctx = createScope(root, agent).ctx
sessions.set(session.id, session); agents.set(agent.id, agent)
const otherSession = { id: 'other', header: { id: 'other', cwd: home } }
const other: any = { id: 'other-agent', session: otherSession }
other.ctx = createScope(root, other).ctx
sessions.set(otherSession.id, otherSession); agents.set(other.id, other)
let effects = 0, forkEffects = 0
const output = { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: String(value) }] }
root.tools.register({ name: 'fenced_eval', description: 'Fixture', parameters: { type: 'object', properties: {} }, output, execute: async () => { effects++; return 42 } } as never)
root.tools.register({ name: 'native_write', description: 'Fixture', parameters: { type: 'object', properties: {} }, output, execute: async () => { effects++; return 1 } } as never)
root.tools.register({ name: 'fork_tool', description: 'Fork fixture', parameters: { type: 'object', properties: {} }, output, execute: async () => { forkEffects++; return 1 } } as never)
const execute = (name = 'fenced_eval', nativeAgent = agent) => root.tools.execute({ calls: [{ type: 'tool-call', id: crypto.randomUUID(), name, arguments: '{}' }], agent: nativeAgent, signal: new AbortController().signal } as never)
let lease: any, retainedContext: any
let ownerCommand: (() => void) | undefined
let allow = true, ready = true
let rewrite = false
let stepGate: Promise<void> | undefined
let stepStarted: (() => void) | undefined
const ownerPlugin = { name: 'fence-owner', apply(ctx: any) {
  const service = ctx.get('executionFences', false)
  assert.ok(service, 'host must expose the persistent deny-only fence API')
  retainedContext = ctx
  lease = service.attach({ id: 'fixture', tools: ['fenced_eval'], check: (execution: any) => {
    assert.equal('concludeTurn' in execution, false)
    assert.equal('deferContext' in execution, false)
    if (rewrite) assert.throws(() => { execution.name = 'fenced_eval' }, TypeError)
    return allow ? undefined : 'owner denied'
  }, beforeStep: async () => {
    stepStarted?.()
    await stepGate
    return ready
  } })
  lease.protect(session.id)
  ownerCommand = () => lease.protect(session.id)
} }

try {
  const owner = root.plugin(ownerPlugin)
  await owner
  // /model forks the conversation, then disposes the old handle. The native
  // registry removes the parent, even though the child's lineage is valid.
  const sourceSession = { id: 'model-source', header: { id: 'model-source', cwd: home } }
  sessions.set(sourceSession.id, sourceSession)
  root.emit('session/created', sourceSession as never)
  const switchedSession = { id: 'model-target', header: { id: 'model-target', cwd: home, parentSession: sourceSession.id } }
  const switched: any = { id: 'model-target-agent', session: switchedSession }
  switched.ctx = createScope(root, switched).ctx
  sessions.set(switchedSession.id, switchedSession); agents.set(switched.id, switched)
  root.emit('session/created', switchedSession as never)
  sessions.delete(sourceSession.id)
  let switchedSteps = 0
  const switchedStep = () => root.waterfall('agent/pre-step' as never, { agent: switched } as never,
    async () => { switchedSteps++; return { kind: 'enter', messages: [] } })
  assert.equal((await switchedStep() as any).kind, 'enter', 'model switch must admit input after its unprotected parent is retired')
  let beforeSwitchedTool = forkEffects
  await execute('fork_tool', switched)
  assert.equal(forkEffects, beforeSwitchedTool + 1, 'ordinary tools remain usable after model switch')
  beforeSwitchedTool = forkEffects
  // Remembering a retired parent must preserve, not bypass, later protection.
  lease.protect(sourceSession.id)
  assert.equal((await switchedStep() as any).kind, 'reject')
  await execute('fork_tool', switched)
  assert.equal(forkEffects, beforeSwitchedTool, 'retired protected parent still fences its child')
  lease.release(sourceSession.id)
  assert.equal((await switchedStep() as any).kind, 'enter')
  assert.equal(switchedSteps, 2)

  // Cold resume: no ancestor has been live in this host. Metadata reads must
  // establish the chain without opening a session or claiming its write lock.
  const stored = new Map<string, any>([
    ['cold-parent', { id: 'cold-parent', parentSession: 'cold-root' }],
    ['cold-root', { id: 'cold-root' }],
  ])
  const reads: string[] = []
  let metadataRead: (() => Promise<void>) | undefined
  root.provide('sessionPersistence', { stat: async (id: string) => {
    reads.push(id)
    await metadataRead?.()
    const header = stored.get(id)
    return header ? { header } : undefined
  } })
  const coldSession = { id: 'cold-resume', header: { id: 'cold-resume', parentSession: 'cold-parent' } }
  const cold: any = { id: 'cold-agent', session: coldSession }
  cold.ctx = createScope(root, cold).ctx
  sessions.set(coldSession.id, coldSession); agents.set(cold.id, cold)
  const coldStep = () => root.waterfall('agent/pre-step' as never, { agent: cold } as never,
    async () => ({ kind: 'enter', messages: [] }))
  await execute('fork_tool', cold)
  assert.equal(forkEffects, beforeSwitchedTool, 'unresolved ancestry cannot grant tool execution')
  assert.equal((await coldStep() as any).kind, 'enter', 'cold resume reads retired ancestor metadata')
  assert.deepEqual(reads, ['cold-parent', 'cold-root'])
  await execute('fork_tool', cold)
  assert.equal(forkEffects, beforeSwitchedTool + 1)
  beforeSwitchedTool = forkEffects
  await coldStep()
  assert.equal(reads.length, 2, 'immutable parent headers are reused')
  lease.protect('cold-root')
  assert.equal((await coldStep() as any).kind, 'reject', 'cold protected ancestor still fences descendants')
  await execute('fork_tool', cold)
  assert.equal(forkEffects, beforeSwitchedTool)
  lease.release('cold-root')
  assert.equal((await coldStep() as any).kind, 'enter', 'explicit release permits retry')

  for (const [name, header] of [
    ['missing-parent', undefined],
    ['wrong-parent', { id: 'different-id' }],
    ['cyclic-parent', { id: 'cyclic-parent', parentSession: 'cyclic-parent' }],
  ] as const) {
    if (header) stored.set(name, header)
    const invalidSession = { id: `child-${name}`, header: { id: `child-${name}`, parentSession: name } }
    const invalid: any = { id: `agent-${name}`, session: invalidSession }
    invalid.ctx = createScope(root, invalid).ctx
    sessions.set(invalidSession.id, invalidSession); agents.set(invalid.id, invalid)
    const result = await root.waterfall('agent/pre-step' as never, { agent: invalid } as never,
      async () => ({ kind: 'enter', messages: [] }))
    assert.equal((result as any).kind, 'reject', `${name} must fail closed`)
    await execute('fork_tool', invalid)
    assert.equal(forkEffects, beforeSwitchedTool)
  }
  const raceSession = { id: 'race-resume', header: { id: 'race-resume', parentSession: 'race-parent' } }
  const race: any = { id: 'race-agent', session: raceSession }
  race.ctx = createScope(root, race).ctx
  sessions.set(raceSession.id, raceSession); agents.set(race.id, race)
  stored.set('race-parent', { id: 'race-parent' })
  metadataRead = async () => { agents.set(race.id, { ...race }) }
  const raced = await root.waterfall('agent/pre-step' as never, { agent: race } as never,
    async () => ({ kind: 'enter', messages: [] }))
  assert.equal((raced as any).kind, 'reject', 'metadata reads cannot admit a retired agent')
  metadataRead = undefined

  // A registered command runs in the dispatcher's async activation, while
  // its opaque lease remains bound to the original plugin activation.
  let commandInvoked = false
  const dispatch = root.plugin({ name: 'native-command-dispatcher', apply() {
    assert.ok(ownerCommand)
    ownerCommand()
    commandInvoked = true
  } })
  await dispatch
  assert.equal(commandInvoked, true, 'live owner command must work through another activation')
  await dispatch.dispose()
  // Restoring saved modes must not omit protection after an arbitrary cap.
  for (let index = 0; index < 5000; index++) lease.protect(`restored-${index}`)
  for (let index = 0; index < 5000; index++) lease.release(`restored-${index}`)
  await execute(); assert.equal(effects, 1)
  const deny = root.tools.guard(() => 'existing permission denied')
  await execute(); assert.equal(effects, 1, 'fence cannot bypass another policy')
  deny()
  allow = false; await execute(); assert.equal(effects, 1)
  allow = true
  const denyNative = root.tools.guard(execution => execution.name === 'native_write' ? 'native permission denied' : undefined)
  rewrite = true
  await execute('native_write'); assert.equal(effects, 1, 'callback cannot rewrite dispatch to bypass permission')
  rewrite = false; denyNative()
  await execute('native_write'); assert.equal(effects, 2, 'owner check may admit only against the other policies')
  const oldLease = lease
  await owner.dispose()
  await execute(); await execute('native_write')
  assert.equal(effects, 2, 'unload keeps the protected session denied')
  await execute('native_write', other); assert.equal(effects, 3, 'unrelated sessions stay usable')
  await execute('fenced_eval', other); assert.equal(effects, 3, 'fence tools need a protected session')
  assert.throws(() => oldLease.release(session.id), /activation|inactive|stale/u)
  let denied = false
  const foreign = root.plugin({ name: 'foreign', inject: ['executionFences'], apply(ctx: any) {
    assert.throws(() => ctx.executionFences.attach({ id: 'fixture', tools: ['fenced_eval'], check: () => undefined }), /owner/u)
    assert.throws(() => ctx.root.executionFences.attach({ id: 'root-spoof', tools: [], check: () => undefined }), /activation/u)
    assert.throws(() => oldLease.release(session.id), /activation|inactive|stale/u)
    denied = true
  } })
  await foreign; assert.ok(denied); await foreign.dispose()
  const rebound = root.plugin(ownerPlugin)
  await rebound
  await execute(); assert.equal(effects, 4, 'same authenticated owner can reattach')
  assert.throws(() => oldLease.release(session.id), /activation|inactive|stale/u)
  let steps = 0
  const step = () => root.waterfall('agent/pre-step' as never, { agent } as never, async () => { steps++; return 'next' })
  ready = false; await step(); assert.equal(steps, 0)
  ready = true; await step(); assert.equal(steps, 1)
  const childSession = { id: 'child', header: { id: 'child', cwd: home, parentSession: session.id } }
  const child: any = { id: 'child-agent', session: childSession }
  child.ctx = createScope(root, child).ctx
  sessions.set(childSession.id, childSession); agents.set(child.id, child)
  await execute('native_write', child); assert.equal(effects, 4, 'protected child cannot escape')
  agents.set(agent.id, { ...agent })
  await execute(); assert.equal(effects, 4, 'stale agent identity cannot escape')
  agents.set(agent.id, agent)
  lease.release(session.id)
  await execute('native_write'); assert.equal(effects, 5, 'explicit release lifts only this fence')
  lease.protect(session.id)
  const restarting = retainedContext.fiber.restart()
  await execute('native_write'); assert.equal(effects, 5, 'restart window stays denied')
  await restarting
  await rebound
  let finishStep!: () => void
  stepGate = new Promise(resolve => { finishStep = resolve })
  const started = new Promise<void>(resolve => { stepStarted = resolve })
  const pending = step()
  await started
  await rebound.dispose()
  finishStep(); await pending
  assert.equal(steps, 1, 'late step approval cannot survive owner unload')
  stepGate = undefined; stepStarted = undefined
  const finalOwner = root.plugin(ownerPlugin)
  await finalOwner
  const providerLease = lease
  await hostFiber.dispose()
  await execute('native_write'); assert.equal(effects, 5, 'provider unload retains denial')
  assert.throws(() => providerLease.release(session.id), /inactive|stale/u)
  await finalOwner.dispose()
  await execute(); assert.equal(effects, 5)
  const originalMode = process.env.DSH_CLI_ADAPTER_MODE
  const originalSlices = process.env.DSH_CLI_ADAPTER_SLICES
  try {
    for (const mode of ['passive-shadow', 'replay-shadow']) {
      process.env.DSH_CLI_ADAPTER_MODE = mode
      process.env.DSH_CLI_ADAPTER_SLICES = 'execution-fences'
      const isolated = new Context()
      isolated.provide('systemPrompt', { tools: () => () => {} })
      isolated.provide('agents', { get: (id: string) => agents.get(id) })
      isolated.provide('sessions', { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] })
      try {
        await isolated.plugin(ToolRuntime)
        await isolated.plugin(ExecutionFenceRuntime)
        // Environment mutation cannot change the bound host policy.
        process.env.DSH_CLI_ADAPTER_MODE = 'new'
        await isolated.plugin({ name: 'shadow-fence-owner', apply(ctx: any) {
          assert.throws(() => ctx.get('executionFences').attach({ id: 'shadow', tools: [], check: () => undefined }), /shadow|replay|effect/u)
        } })
      } finally { await isolated.fiber.dispose() }
    }
  } finally {
    if (originalMode === undefined) delete process.env.DSH_CLI_ADAPTER_MODE
    else process.env.DSH_CLI_ADAPTER_MODE = originalMode
    if (originalSlices === undefined) delete process.env.DSH_CLI_ADAPTER_SLICES
    else process.env.DSH_CLI_ADAPTER_SLICES = originalSlices
  }
  console.log('PASS: persistent fence, permission intersection, ownership, stale activation, children, identity and recovery')
} finally {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
