import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertCapabilityShadowPolicy, type AdapterRuntimeOptions } from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { bindCallerEffect, captureActivation, compositionRoot, concreteService, requirePluginCaller, withHostRootCapability } from './host-access.js'

/** Additional denial only: undefined never overrides another tool policy. */
export interface ExecutionFenceRequest {
  id: string
  tools: readonly string[]
  check(execution: Readonly<Pick<ToolExecution, 'name' | 'arguments' | 'agent'>>): string | undefined
  beforeStep?(agent: Agent): Promise<boolean> | boolean
}
export interface ExecutionFence {
  protect(sessionId: string): void
  release(sessionId: string): void
}
interface Attachment {
  current(): boolean
  check: ExecutionFenceRequest['check']
  beforeStep: ExecutionFenceRequest['beforeStep']
}
interface FenceState {
  owner: Function
  tools: readonly string[]
  sessions: Set<string>
  attachment?: Attachment
}
interface HostState {
  root: Context
  fences: Map<string, FenceState>
  parents: Map<SessionId, SessionId | undefined>
}
const hosts = new WeakMap<Context, HostState>()
const services = new WeakMap<object, HostState>()
const runtimes = new WeakMap<object, AdapterRuntimeOptions>()
const activeServices = new WeakSet<object>()
const DENIED = 'Execution is protected. Restore the owning plugin and recover the session before continuing.'
const INVALID = 'Execution fence session identity is invalid.'

function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.:-]{1,256}$/u.test(value)) throw new Error('dsh-cli: invalid execution fence identifier')
  return value
}

/** Retain only immutable native lineage, not live Session/Agent handles. */
function rememberParent(host: HostState, header: Pick<SessionHeader, 'id' | 'parentSession'>): void {
  if (typeof header.id !== 'string' || !header.id ||
    header.parentSession !== undefined && (typeof header.parentSession !== 'string' || !header.parentSession)) throw new Error(INVALID)
  if (host.parents.has(header.id) && host.parents.get(header.id) !== header.parentSession) throw new Error(INVALID)
  host.parents.set(header.id, header.parentSession)
}

type FenceScope = string | undefined | { unloaded: SessionId }

/** The executing agent/session must still be live. Ancestors may have retired
 * after /model or /rewind; their immutable lineage remains authoritative. */
function scopeFor(host: HostState, fence: FenceState, agent?: Agent): FenceScope {
  if (!agent) return undefined
  if (host.root.agents.get(agent.id) !== agent || host.root.sessions.get(agent.session.id) !== agent.session) throw new Error(INVALID)
  let id = agent.session.id
  const seen = new Set<string>()
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(id)) throw new Error(INVALID)
    seen.add(id)
    if (fence.sessions.has(id)) return id
    const live = host.root.sessions.get(id)
    if (live) rememberParent(host, live.header)
    if (!host.parents.has(id)) return { unloaded: id }
    const parent = host.parents.get(id)
    if (parent === undefined) return undefined
    id = parent
  }
  throw new Error(INVALID)
}

/** Cold resume may never load the ancestors into SessionStore. Read only their
 * headers, without acquiring write ownership or restoring their event logs. */
async function prepareScope(host: HostState, fence: FenceState, agent: Agent): Promise<void> {
  let scope = scopeFor(host, fence, agent)
  for (let reads = 0; typeof scope === 'object' && reads < 64; reads++) {
    const source = host.root.get('sessionPersistence', false)
    const snapshot = await source?.stat(scope.unloaded)
    if (!snapshot || snapshot.header.id !== scope.unloaded) throw new Error(INVALID)
    rememberParent(host, snapshot.header)
    // Recheck live identities and current protection after every awaited read.
    scope = scopeFor(host, fence, agent)
  }
  if (typeof scope === 'object') throw new Error(INVALID)
}

function denyTool(host: HostState, execution: Readonly<ToolExecution>): string | undefined {
  for (const fence of host.fences.values()) {
    try {
      const scope = scopeFor(host, fence, execution.agent)
      if (typeof scope === 'object') return INVALID
      if (!scope) {
        if (fence.tools.includes(execution.name)) return DENIED
        continue
      }
      const attachment = fence.attachment
      if (!attachment?.current()) return DENIED
      if (execution.agent!.session.id !== scope) return DENIED
      // Never expose mutable dispatch fields or effect methods to a denial callback.
      // Native Tools already freezes the detached JSON arguments.
      const reason = attachment.check(Object.freeze({ name: execution.name, arguments: execution.arguments, agent: execution.agent }))
      if (reason !== undefined) return typeof reason === 'string' && reason.length > 0 ? reason : DENIED
      if (!attachment.current()) return DENIED
      if (scopeFor(host, fence, execution.agent) !== scope || execution.agent!.session.id !== scope) return INVALID
    } catch { return INVALID }
  }
  return undefined
}

async function beforeStep(host: HostState, agent: Agent): Promise<boolean> {
  for (const fence of host.fences.values()) {
    try {
      await prepareScope(host, fence, agent)
      const scope = scopeFor(host, fence, agent)
      if (typeof scope === 'object') return false
      if (!scope) continue
      const attachment = fence.attachment
      if (!attachment?.current() || agent.session.id !== scope) return false
      if (attachment.beforeStep && await attachment.beforeStep(agent) !== true) return false
      if (fence.attachment !== attachment || !attachment.current()) return false
      if (scopeFor(host, fence, agent) !== scope || agent.session.id !== scope) return false
    } catch { return false }
  }
  return true
}

/** Root-owned monotonic gates outlive the service and every plugin lease.
 * Disposal revokes callbacks, while protected session IDs remain until an
 * authenticated reattachment explicitly releases them. No raw root escapes. */
function hostFor(ctx: Context): HostState {
  const root = compositionRoot(ctx)
  let host = hosts.get(root)
  if (host) return host
  host = { root, fences: new Map(), parents: new Map() }
  const state = host
  withHostRootCapability(() => {
    for (const session of root.sessions.list()) rememberParent(state, session.header)
    root.on('session/created', session => {
      if (root.sessions.get(session.id) === session) rememberParent(state, session.header)
    }, { global: true })
    root.tools.guard(execution => denyTool(state, execution))
    root.on('agent/pre-step', async (payload, next) => await beforeStep(state, payload.agent) ? next() : { kind: 'reject' }, { prepend: true, global: true })
  })
  hosts.set(root, host)
  return host
}

declare module '@deepseek-ai/cordis' {
  interface Context { executionFences: ExecutionFenceRuntime }
}

export class ExecutionFenceRuntime extends Service {
  static inject = ['tools', 'agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'executionFences')
    services.set(this, hostFor(ctx))
    runtimes.set(this, adapterRuntimeFor(ctx))
    ctx.effect(() => {
      activeServices.add(this)
      return () => { activeServices.delete(this) }
    })
  }

  attach(request: ExecutionFenceRequest): ExecutionFence {
    const caller = requirePluginCaller(this.ctx, 'executionFences.attach', this)
    const receipt = captureActivation(caller)
    const service = concreteService(this)
    const runtime = runtimes.get(service)!
    assertCapabilityShadowPolicy('host.execution-fences.attach', runtime.mode, runtime.slices)
    if (!activeServices.has(service)) throw new Error('dsh-cli: execution fence provider is inactive')
    const host = services.get(service)!
    const id = token(request?.id)
    if (!Array.isArray(request.tools) || request.tools.length > 128 || typeof request.check !== 'function'
      || request.beforeStep !== undefined && typeof request.beforeStep !== 'function') throw new Error('dsh-cli: invalid execution fence request')
    const tools = [...new Set(request.tools.map(token))].sort()
    let fence = host.fences.get(id)
    if (fence && fence.owner !== receipt.owner) throw new Error('dsh-cli: execution fence belongs to another owner')
    if (fence?.attachment?.current()) throw new Error('dsh-cli: execution fence already has an active attachment')
    if (fence && JSON.stringify(fence.tools) !== JSON.stringify(tools)) throw new Error('dsh-cli: execution fence tool binding changed')
    if (!fence) {
      if (host.fences.size >= 128) throw new Error('dsh-cli: execution fence capacity exceeded')
      fence = { owner: receipt.owner, tools: Object.freeze(tools), sessions: new Set() }
      host.fences.set(id, fence)
    }
    const state = fence
    const current = () => activeServices.has(service) && receipt.current()
    const attachment: Attachment = { current, check: request.check, beforeStep: request.beforeStep }
    state.attachment = attachment
    const revoke = () => { if (state.attachment === attachment) delete state.attachment }
    if (!bindCallerEffect(caller, revoke)) throw new Error('dsh-cli: execution fence activation is inactive')
    const assertOwner = () => {
      // This opaque lease already pins the authenticated owner at attach.
      // Command/tool callbacks may run in a different dispatch activation;
      // keep checking the pinned lifetime instead of reauthenticating that pipeline.
      if (state.attachment !== attachment || !current()) throw new Error('dsh-cli: execution fence activation is stale')
    }
    return Object.freeze({
      protect(sessionId: string) {
        assertCapabilityShadowPolicy('host.execution-fences.protect', runtime.mode, runtime.slices)
        assertOwner(); token(sessionId)
        state.sessions.add(sessionId)
      },
      release(sessionId: string) {
        assertCapabilityShadowPolicy('host.execution-fences.release', runtime.mode, runtime.slices)
        assertOwner(); state.sessions.delete(token(sessionId))
      },
    })
  }
}
