/**
 * L4 router ownership regressions: retained root callbacks, waterfall tails,
 * queued mode restores, and partial subscription setup must not outlive the
 * captured binding/owner.
 */
import assert from 'node:assert/strict'
import { createChannelBinding } from '../src/dsh-adapter/channel/binding.js'
import { createBindingEvents } from '../src/dsh-adapter/channel/binding-events.js'
import { createModeActions } from '../src/dsh-adapter/channel/mode-actions.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolveInner => { resolve = resolveInner })
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

type Listener = (...args: any[]) => unknown
const listeners = new Map<string, Listener[]>()
const ctx = {
  logger: { warn() {} },
  on(name: string, listener: Listener) {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) }
  },
}
const emit = (name: string, ...args: any[]) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(...args) }

const assemblyListeners: Listener[] = []
const requestListeners: Listener[] = []
const makeAgent = (id: string) => ({
  id,
  status: 'idle' as const,
  session: { id: `s-${id}`, events: [] as any[] , snapshotEvents() { return this.events }},
  ctx: {
    on(name: string, listener: Listener) {
      const list = name === 'system-prompt/assemble' ? assemblyListeners : requestListeners
      list.push(listener)
      return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) }
    },
  },
})
const agentA = makeAgent('A')
const agentB = makeAgent('B')
const owner = createChannelOwner()
const binding = createChannelBinding(agentA as never, undefined, owner)
const state = {
  agentBindingGeneration: 0, provider: 'p', model: 'm', status: 'idle', pending: [], working: false,
  cancelPending: false, activeToolCount: 0, emit() {}, emitStream() {},
}
let projected = 0
let childStarts = 0
const events = createBindingEvents(ctx as never, {
  owner, binding, state: state as never,
  activity: { start() {}, stop() {}, onAgentStatus() {}, onSessionEvent() {} },
  inputConvergence: { interruptSeq: 0, cancelInFlight: false },
  modelActions: { async applyPreferredEffort() {} },
  modeActions: { refreshMode() {}, onSessionEvent() {} },
  projector: { renderEvent() { projected += 1 }, settleStreaming() {}, updateSpinnerMode() {} } as never,
  subagents: { onSessionEvent() { return false }, onStart() { childStarts += 1 }, onEnd() {} },
  agentView: { schedule() {} },
})
events.bind()
const oldStatus = listeners.get('agent/status')![0]!
const oldSession = listeners.get('session/event')![0]!
const oldChild = listeners.get('subagent/start')![0]!
assert.equal(assemblyListeners.length, 0, 'binding installs no late model assembly hook')
assert.equal(requestListeners.length, 0, 'binding installs no late model request hook')

binding.switchTo(agentB as never, undefined, () => events.bind())
binding.switchTo(agentA as never, undefined, () => events.bind())
oldStatus({ agent: agentA, status: 'disposed' })
oldSession(agentA.session, { type: 'plugin/noise' })
oldChild({ id: 'retained', provider: 'p' })
assert.equal(state.status, 'idle', 'retained ABA status callback cannot mutate current state')
assert.equal(projected, 0, 'retained ABA session callback cannot project into current binding')
assert.equal(childStarts, 0, 'retained ABA child callback cannot mutate current child projection')

owner.dispose()
oldStatus({ agent: agentA, status: 'disposed' })
oldSession(agentA.session, { type: 'plugin/noise' })
oldChild({ id: 'postdispose', provider: 'p' })
assert.equal(projected, 0, 'post-dispose retained session callback is inert')
assert.equal(childStarts, 0, 'post-dispose retained child callback is inert')

// A partial root subscription failure revokes the owner and disposes earlier subscriptions.
const failingOwner = createChannelOwner()
const failingBinding = createChannelBinding(makeAgent('fail') as never, undefined, failingOwner)
let subscriptionDisposes = 0
let installs = 0
const failingContext = {
  ...ctx,
  on() {
    installs += 1
    if (installs === 2) throw new Error('subscription registration failed')
    return () => { subscriptionDisposes += 1 }
  },
}
const failingEvents = createBindingEvents(failingContext as never, {
  owner: failingOwner, binding: failingBinding, state: { ...state } as never,
  inputConvergence: { interruptSeq: 0, cancelInFlight: false },
  modelActions: { async applyPreferredEffort() {} }, modeActions: { refreshMode() {}, onSessionEvent() {} },
  projector: { settleStreaming() {}, updateSpinnerMode() {}, renderEvent() {} } as never,
  subagents: { onSessionEvent() { return false }, onStart() {}, onEnd() {} }, agentView: { schedule() {} },
})
assert.throws(() => failingEvents.bind(), /subscription registration failed/)
assert.equal(subscriptionDisposes, 1, 'partial subscription is disposed on setup failure')
assert.equal(failingOwner.current(), false, 'partial setup failure revokes its owner')

// A queued plan-exit restore captures the owner and binding. Revoking either
// before the microtask drains must prevent durable restore atoms from writing.
const modeOwner = createChannelOwner()
const modeAgent = makeAgent('mode')
modeAgent.session.events.push(
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'plan/mode', data: { active: true } },
  { type: 'sandbox/mode', data: { mode: 'read-only' } },
)
const modeBinding = createChannelBinding(modeAgent as never, undefined, modeOwner)
modeBinding.bind()
let durableWrites = 0
;(modeAgent.session as any).append = () => { durableWrites += 1 }
const modeActions = createModeActions({ get() { return undefined }, logger: { warn() {} } } as never, { mode: { id: 'base' }, modeIndex: 0, emit() {} } as never, {
  owner: modeOwner, binding: modeBinding, sessionModes: [{ id: 'base' }, { id: 'write', sandbox: 'workspace-write' }],
  async executeRegistryCommand() { return '' }, notify() {},
})
const exit = { type: 'plan/mode', data: { active: false } }
modeAgent.session.events.push(exit)
modeActions.onSessionEvent(modeAgent.session as never, exit as never)
modeOwner.dispose()
await tick()
assert.equal(durableWrites, 0, 'owner-revoked queued mode restore cannot append durable events')

console.log('verify-channel-router-lifecycle: OK')
