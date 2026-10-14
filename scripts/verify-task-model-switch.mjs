/** Real model-switch/binding/input FIFO, with an offline canonical-host fixture. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { createChannelOwner } from '../lib/types/dsh-adapter/channel/owner.js'
import { createChannelBinding } from '../lib/types/dsh-adapter/channel/binding.js'
import { createModelSwitchAction } from '../lib/types/dsh-adapter/channel/model-switch.js'
import { createTaskWorkflowProjection } from '../lib/types/dsh-adapter/channel/task-workflow.js'
import { createInputDelivery } from '../lib/types/dsh-adapter/channel/input-delivery.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
const canonical = (sessionId, revision) => ({ sessionId, taskId: 'canonical-task', runId: 'canonical-task',
  state: 'Pending', revision, generation: 3, request: 'Continue the same task', reason: 'Interrupted', evidence: [], allowedOps: ['resume'] })

async function exercise(failure) {
  const owner = createChannelOwner()
  const messages = [], warnings = []
  const makeHandle = (id, parentSession) => {
    const value = { disposed: 0, agent: { id, status: 'idle', session: { id, seq: 0,
      header: { id, parentSession }, snapshotEvents: () => [] },
      followup: message => messages.push(message), steer: message => messages.push(message),
    }, async dispose() { value.disposed++ } }
    return value
  }
  const old = makeHandle(`source-${failure}`)
  const binding = createChannelBinding(old.agent, old, owner)
  let target, task = canonical(old.agent.session.id, 12)
  const entered = deferred(), completed = deferred()
  const host = {
    snapshot: async agent => ({ sessionId: agent.session.id, task: task.sessionId === agent.session.id ? task : null }),
    operate: async () => { throw new Error('Unexpected operation') },
    handoff: async (source, next, expected, signal) => {
      assert.equal(source, old.agent)
      assert.equal(next, target.agent)
      assert.equal(old.disposed, 0)
      assert.deepEqual(expected, { taskId: 'canonical-task', revision: 12, generation: 3 })
      assert.equal(signal.aborted, false)
      entered.resolve()
      await completed.promise
      task = canonical(next.session.id, 13)
    },
  }
  const ctx = { get: key => key === 'agents' ? { create: async options => {
    assert.equal(options.meta.parentSession, old.agent.session.id)
    target = makeHandle(options.sessionId, options.meta.parentSession)
    return target
  } } : undefined, on: () => () => {}, logger: { warn: message => warnings.push(message) } }
  const state = { cwd: process.env.HOME, rows: [], todos: [], working: false,
    agentId: old.agent.id, sessionId: old.agent.session.id, agentBindingGeneration: binding.bind(),
    emit: () => {}, notify: message => warnings.push(message) }
  const projection = createTaskWorkflowProjection({ discover: () => host, capture: binding.capture,
    current: binding.isCurrent, rows: () => state.todos, publish: rows => { state.todos = rows }, warn: state.notify })
  owner.own(projection.dispose)
  await projection.refresh()
  const composer = { snapshot: () => new Map(), captureDraftImages: (_text, images) => images, clearStagedImages() {} }
  const delivery = createInputDelivery(ctx, owner, binding, () => state, state.notify, () => {}, () => {}, composer,
    () => undefined, () => {}, agent => projection.waitForInput(agent))
  // The first view emit after adoption can synchronously enqueue real input.
  // It must not race the SQLite owner CAS that starts after this callback.
  state.emit = () => { if (target && binding.agent === target.agent) delivery.dispatchUserText('new target input', 'followup') }
  const noop = () => {}
  const action = createModelSwitchAction(ctx, state, {
    owner, binding, rowIds: { value: 0 }, settleCompaction: async () => {},
    prepareTaskHandoff: () => projection.prepareHandoff(), holdTaskInput: agent => projection.holdInput(agent),
    resetProjector: noop, resetSubagents: noop, resetJobs: noop, replay: noop, settleReplay: noop,
    bindAgent: () => { state.agentBindingGeneration = binding.bind(); projection.rebind() },
    refreshCommands: noop, refreshLoadedContext: async () => {}, refreshSkillCommands: async () => {},
    clearStagedImages: delivery.clearStagedImages, dropModelCompletion: noop, notify: state.notify,
  })
  const switching = action('fixture', 'new-model')
  await entered.promise
  await settle()
  assert.equal(binding.agent, target.agent)
  assert.equal(old.disposed, 0, 'native source remains live throughout handoff')
  assert.equal(messages.length, 0, 'first emitted target input remains parked in the actual FIFO')
  let retired = false
  const retirement = binding.waitForDisposal(old.agent.session.id).then(() => { retired = true })
  await settle()
  assert.equal(retired, false, '/resume source must await the handoff before reacquiring it')
  if (failure) completed.reject(new Error('Canonical CAS conflict'))
  else completed.resolve()
  assert.equal(await switching, true, 'model adoption has committed independently of task ownership')
  await retirement; await settle(); await settle()
  assert.equal(old.disposed, 1)
  assert.equal(target.disposed, 0)
  if (failure) {
    assert.equal(messages.length, 0)
    delivery.dispatchUserText('still blocked', 'followup')
    await settle()
    assert.equal(messages.length, 0, 'failed owner transfer keeps later target sends closed')
    assert.ok(warnings.some(text => text.includes('CAS conflict')))
    // Explicit /kioku-task create is represented by a committed host row.
    task = canonical(target.agent.session.id, 1)
    task.taskId = task.runId = 'explicit-new-task'
    await projection.refresh()
    delivery.dispatchUserText('new task input', 'followup')
    await settle(); await settle()
    assert.equal(messages.length, 1)
  } else {
    assert.equal(messages.length, 1)
    assert.equal(state.todos[0].taskId, 'canonical-task')
    assert.equal(state.todos[0].revision, 13)
  }
  owner.dispose()
}

await exercise(false)
await exercise(true)
console.log('PASS: model handoff preserves native source, holds real target input, fences failed sends, retires once, and permits explicit new-task recovery')
