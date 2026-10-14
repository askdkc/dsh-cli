/** Real channel wiring: optional host event, native cancel first, no JSONL truth. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const handlers = new Map()
const fire = (name, ...args) => { for (const handler of [...(handlers.get(name) ?? [])]) handler(...args) }
const order = []
let task = { sessionId: 'session-task-channel', taskId: 'sqlite-task', runId: 'sqlite-task',
  state: 'Working', revision: 7, generation: 2, request: 'Verify the canonical channel',
  reason: 'Running', evidence: ['native:turn'], allowedOps: ['wait'] }
let snapshotCalls = 0
let releaseInitial
const initialRead = new Promise(resolve => { releaseInitial = resolve })
const host = {
  snapshot: async () => { snapshotCalls++; if (snapshotCalls === 1) await initialRead; return { sessionId: task.sessionId, task } },
  operate: async (target, input, signal) => {
    assert.equal(target, agent)
    assert.equal(signal.aborted, false)
    assert.deepEqual(order, ['native-cancel'])
    assert.deepEqual(input.expected, { taskId: 'sqlite-task', revision: 7, generation: 2 })
    order.push('host-wait')
    task = { ...task, pendingStop: { operation: 'wait', reason: 'Waiting for native stop' } }
    return task
  },
}
const ctx = { get: name => name === 'kiokukoTaskWorkflow' ? host : undefined,
  on(name, handler) {
    const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set)
    return () => set.delete(handler)
  }, logger: { warn() {} } }
const agent = { id: 'native-task-agent', status: 'idle',
  session: { id: task.sessionId, seq: 0, snapshotEvents: () => [] }, ctx: { on: () => () => {} },
  cancel: () => order.push('native-cancel') }
const channel = createChannel(ctx, agent, { model: 'fixture', provider: 'fixture', cwd: process.env.HOME, activity: false })
channel.cancel()
await settle(); await settle()
assert.deepEqual(order, ['native-cancel', 'host-wait'], 'early interrupt is not lost while initial snapshot is pending')
releaseInitial()
await settle(); await settle()
assert.equal(channel.todos[0].status, 'Working')
assert.equal(channel.todos[0].pendingStop.operation, 'wait')
task = { ...task, state: 'Pending', revision: 8, pendingStop: undefined, allowedOps: ['resume'] }
fire('kiokuko/task-state', { sessionId: task.sessionId, state: 'Ignore', revision: 999 })
await settle(); await settle()
assert.equal(channel.todos[0].status, 'Pending', 'event payload does not override canonical state')
assert.equal(channel.todos[0].revision, 8)
fire('session/event', agent.session, { type: 'todo/write', seq: 0, time: Date.now(), data: {
  todos: [{ content: 'Native TODO', status: 'pending', source: 'kiokuko', taskId: 'forged' }],
} })
assert.equal(channel.todos[0].taskId, 'sqlite-task', 'legacy event cannot erase or replace the canonical projection')
assert.deepEqual(channel.todos[1], { content: 'Native TODO', status: 'pending' })
channel.releaseContributions()
console.log('PASS: actual channel canonical event reread, early native cancel ordering, pending-stop display, and legacy JSONL isolation')
