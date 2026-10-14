/** Verify the optional host projection and cancellation fences without a DB. */
import assert from 'node:assert/strict'
import { createTaskWorkflowProjection } from '../lib/types/dsh-adapter/channel/task-workflow.js'
import { todoPanelItems } from '../lib/types/dsh-adapter/channel/projection-helpers.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const agent = sessionId => ({ session: { id: sessionId } })
const task = (sessionId, revision = 1, state = 'Working') => ({ sessionId, taskId: 'task-1', runId: 'task-1', state,
  revision, generation: 2, request: 'Ship this task', reason: null, evidence: ['ledger:evidence-1'], allowedOps: ['wait', 'complete'] })
let active = agent('a'), generation = 1, value = task('a'), reads = 0, operations = []
let rows = [{ content: 'native todo', status: 'pending' }], warnings = []
let read = async target => { reads++; return { sessionId: target.session.id, task: value } }
let operate = async (target, input, signal) => { operations.push({ target, input, signal }) }
let host = { snapshot: target => read(target), operate: (...args) => operate(...args) }
const projection = createTaskWorkflowProjection({
  discover: () => host,
  capture: () => ({ agent: active, generation }),
  current: capture => capture.agent === active && capture.generation === generation,
  rows: () => rows,
  publish: value => { rows = value },
  warn: message => warnings.push(message),
})

await projection.refresh()
assert.equal(rows[0].status, 'Working')
assert.equal(rows[0].taskId, 'task-1')
assert.equal(rows[1].content, 'native todo')
for (const state of ['ToDo', 'Working', 'Pending', 'Done', 'Ignore']) {
  value = task('a', ++value.revision, state)
  await projection.refresh()
  assert.equal(rows[0].status, state)
  assert.deepEqual(rows[0].evidence, ['ledger:evidence-1'])
}
value = { ...task('a', ++value.revision, 'Pending'), runStatus: 'failed', previousOutcome: { status: 'interrupted' } }
await projection.refresh()
assert.equal(rows[0].runStatus, 'failed', 'task labels retain distinct execution outcomes')
assert.deepEqual(rows[0].previousOutcome, { status: 'interrupted' })
value.previousOutcome.status = 'cancelled'
assert.equal(rows[0].previousOutcome.status, 'interrupted', 'projection owns its outcome snapshot')
const latestRevision = rows[0].revision
value = task('a', 1)
await projection.refresh()
assert.equal(rows[0].revision, latestRevision, 'older host reads cannot roll back the current projection')
const readsBefore = reads
projection.changed({ sessionId: 'other', taskId: 'task-1', state: 'Ignore' })
await settle()
assert.equal(reads, readsBefore, 'other sessions never refresh this projection')
value = task('a', latestRevision + 1)
projection.changed({ sessionId: 'a', state: 'Ignore', revision: 900 })
await settle()
assert.equal(rows[0].status, 'Working', 'events invalidate; their payload never becomes task truth')

const stopped = deferred()
operate = async (target, input, signal) => { operations.push({ target, input, signal }); await stopped.promise; value = task('a', latestRevision + 2, 'Pending') }
projection.cancelled()
await settle()
assert.equal(rows[0].status, 'Working', 'Esc alone cannot claim Pending before the host confirms the stop')
assert.deepEqual(operations[0].input.expected, { taskId: 'task-1', revision: latestRevision + 1, generation: 2 })
stopped.resolve()
await settle(); await settle()
assert.equal(rows[0].status, 'Pending')

const delayed = deferred()
read = () => delayed.promise
const oldRead = projection.refresh()
active = agent('a'); generation++ // same ID, fresh native agent: ABA must fail closed
value = task('a', 30)
read = async target => ({ sessionId: target.session.id, task: value })
projection.rebind()
assert.equal(rows.length, 1, 'rebind immediately drops the old host projection')
await settle()
delayed.resolve({ sessionId: 'a', task: task('a', 99, 'Ignore') })
await oldRead
assert.equal(rows[0].revision, 30, 'old agent response cannot contaminate a new binding of the same session')

const first = deferred(), second = deferred()
let count = 0
read = () => (++count === 1 ? first.promise : second.promise)
const one = projection.refresh(), two = projection.refresh()
second.resolve({ sessionId: 'a', task: task('a', 32, 'Done') }); await two
first.resolve({ sessionId: 'a', task: task('a', 31, 'Working') }); await one
assert.equal(rows[0].status, 'Done', 'out-of-order reads preserve the latest response')

let aborted
operate = async (_target, _input, signal) => { aborted = signal; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }
projection.cancelled(); await settle()
active = agent('b'); generation++
read = async target => ({ sessionId: target.session.id, task: null })
projection.rebind()
assert.equal(aborted.aborted, true, 'model/resume rebind cancels a parked old-owner operation')
await settle()
assert.deepEqual(rows, [{ content: 'native todo', status: 'pending' }])
// Handoff pins a fresh canonical revision, then binds its write and reread to
// the adopted native target. It never copies the old projection to that target.
value = task('b', 40, 'Pending')
read = async target => ({ sessionId: target.session.id, task: value?.sessionId === target.session.id ? value : null })
const source = active
const transferred = deferred()
let transfer
host.handoff = async (...args) => { transfer = args; await transferred.promise; value = task('c', 41, 'Pending') }
const handoff = await projection.prepareHandoff()
active = agent('c'); generation++
const finishInputHold = projection.holdInput(active)
projection.rebind()
await settle()
assert.equal(rows.some(row => row.source === 'kiokuko'), false)
const handingOff = handoff(active)
let delivered = false
const parkedInput = projection.waitForInput(active).then(() => { delivered = true })
await settle()
assert.equal(delivered, false, 'new target cannot start a turn before canonical ownership transfers')
assert.equal(transfer[0], source)
assert.equal(transfer[1], active)
assert.deepEqual(transfer[2], { taskId: 'task-1', revision: 40, generation: 2 })
transferred.resolve(); await handingOff
assert.equal(delivered, false)
finishInputHold()
await parkedInput
assert.equal(delivered, true)
assert.equal(rows[0].revision, 41)
value = { ...task('c', 42), pendingStop: { operation: 'wait', reason: 'Native stop is still pending' } }
await projection.refresh()
assert.equal(rows[0].status, 'Working')
assert.equal(rows[0].pendingStop.operation, 'wait')

const failedHold = projection.holdInput(active)
failedHold(new Error('CAS conflict'))
await assert.rejects(projection.waitForInput(active), /CAS conflict/u)
value = null
await projection.refresh()
await assert.rejects(projection.waitForInput(active), /CAS conflict/u, 'missing ownership cannot reopen failed input')
value = task('c', 50, 'ToDo')
await projection.refresh()
await projection.waitForInput(active)

const staleHandoff = await projection.prepareHandoff()
const staleTarget = active
active = agent('d'); generation++
projection.rebind()
await assert.rejects(staleHandoff(staleTarget), /target changed/u)
await settle()
host = undefined
await projection.refresh()
assert.deepEqual(rows, [{ content: 'native todo', status: 'pending' }], 'no plugin preserves native behavior')
projection.dispose()

assert.deepEqual(todoPanelItems({ todos: [{ content: 'forged', status: 'pending', source: 'kiokuko', taskId: 'fake' }] }),
  [{ content: 'forged', status: 'pending' }], 'JSONL cannot forge authoritative task metadata')
assert.deepEqual(warnings, [])
console.log('PASS: five states, canonical reads, native fallback, bind/ABA/revision fences, stop confirmation, ownership handoff and JSONL isolation')
