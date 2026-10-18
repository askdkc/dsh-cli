/**
 * V4 message projection through a real Channel: live/replay, call-ID pairing,
 * presenters, errors, folding, goal/todo cards, export, subagents and compact checkpoints.
 * Run after compile: node scripts/verify-message-projection.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-cli-messages-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const { SubagentActivityStore } = await import('../lib/types/dsh-adapter/subagents.js')
const { extractEntries } = await import('../lib/types/dsh-adapter/sessionTree.js')
const { harnessToolResultView, toolErrorText } = await import('../lib/types/dsh-adapter/channel/transcript.js')

function result(api, callId, text, isError = false) {
  const content = [{ type: 'text', text }]
  return {
    id: `result-${callId}`, role: 'tool', source: { kind: 'tool', callId },
    toolCallId: callId, content, isError,
  }
}

try {
  for (const api of ['v4']) {
    for (const mode of ['live', 'replay']) {
      const raw = [
        { type: 'tool/call', data: { callId: 'one', name: 'read_file', arguments: '{"path":"a"}' } },
        { type: 'tool/call', data: { callId: 'two', name: 'read_file', arguments: '{"path":"b"}' } },
        // Out-of-order results must still answer the matching card.
        { type: 'tool/result', data: { message: result(api, 'two', 'second result'), meta: { path: 'b' } } },
        { type: 'tool/result', data: { message: result(api, 'one', 'permission denied', true) } },
        { type: 'tool/call', data: { callId: 'three', name: 'read_file', arguments: '{}' } },
        { type: 'tool/result', data: { message: result(api, 'three', 'detail', true), error: { name: 'ToolError', code: 'DENIED' } } },
        { type: 'user/message', data: {
          id: 'compact', role: 'user', content: [{ type: 'text', text: 'Durable summary' }],
          source: { kind: 'compact-checkpoint', compactionId: 'compact-1' },
        } },
      ]
      const events = raw.map((event, seq) => ({ ...event, seq, time: 1000 + seq }))
      const handlers = new Map()
      const presented = []
      const ctx = {
        on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
        get(name) {
          return name === 'tools' ? { get: () => ({ presentResult(args, payload) {
            presented.push({ args, payload })
            return { card: 'generic', content: payload.content }
          } }) } : undefined
        },
        logger: { warn() {} },
      }
      const log = mode === 'replay' ? [...events] : []
      const agent = {
        id: 'message-agent', status: 'idle', ctx: { on: () => () => {} },
        session: { id: 'message-session', get seq() { return log.length }, snapshotEvents: () => log },
      }
      const channel = createChannel(ctx, agent, { cwd: home, model: 'test', provider: 'test', activity: false })
      try {
        if (mode === 'live') for (const event of events) {
          log.push(event)
          handlers.get('session/event')(agent.session, event)
        }
        const cards = channel.rows.filter(row => row.kind === 'tool').map(row => row.tool)
        assert.deepEqual(cards.map(card => card.status), ['error', 'ok', 'error'], `${api}/${mode}: statuses`)
        assert.equal(cards[0].errorText, 'permission denied')
        assert.equal(cards[1].resultFull, 'second result')
        assert.equal(cards[2].errorText, 'ToolError: DENIED — detail')
        assert.equal(channel.activeToolCount, 0)
        assert.deepEqual(presented, [{ args: { path: 'b' }, payload: {
          content: [{ type: 'text', text: 'second result' }], isError: false, meta: { path: 'b' },
        } }])
        assert.equal(channel.rows.find(row => row.kind === 'compact')?.text, 'Durable summary')
        assert.equal(extractEntries('s', events).find(entry => entry.kind === 'compact')?.text, 'Durable summary')
        assert.deepEqual(extractEntries('s', events).filter(entry => entry.kind === 'tool').map(entry => entry.toolStatus),
          ['error', 'ok', 'error'], `${api}/${mode}: tree failure status follows the message payload`)
        const exported = channel.exportSession()
        assert.ok(exported)
        const markdown = readFileSync(exported, 'utf8')
        for (const text of ['second result', 'permission denied', 'detail']) assert.ok(markdown.includes(text))

        // Cross the real channel's retained-row limit, then restore through
        // loadOlder. Failure semantics and success-only presenters must agree
        // with the initial projection for both entry paths.
        const expectedPresentations = [...presented]
        for (let index = 0; index < 605; index++) {
          const event = { seq: log.length, time: 2000 + index, type: 'user/message', data: {
            id: `padding-${index}`, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: `prompt ${index}` }],
          } }
          log.push(event)
          handlers.get('session/event')(agent.session, event)
        }
        assert.ok(channel.rows.filter(row => row.kind === 'tool').every(row => row.folded))
        assert.ok(channel.loadOlder() > 0)
        const restored = channel.rows.filter(row => row.kind === 'tool')
        assert.ok(restored.every(row => !row.folded))
        assert.deepEqual(restored.map(row => row.tool.status), ['error', 'ok', 'error'], `${api}/${mode}: restored statuses`)
        assert.equal(restored[0].tool.errorText, 'permission denied')
        assert.equal(restored[0].tool.resultFull, undefined)
        assert.equal(restored[0].tool.resultView, undefined)
        assert.equal(restored[1].tool.resultFull, 'second result')
        assert.equal(restored[2].tool.errorText, 'ToolError: DENIED — detail')
        assert.equal(restored[2].tool.resultView, undefined)
        assert.deepEqual(presented, [...expectedPresentations, ...expectedPresentations], 'only successful results reach the presenter on restore')
      } finally { channel.releaseContributions() }

      const subagents = new SubagentActivityStore()
      subagents.onSpawned('child')
      for (const event of events) subagents.onSessionEvent('child', event)
      const calls = subagents.get('child').toolCalls
      assert.equal(calls[0].status, 'failed')
      assert.equal(calls[0].error, 'permission denied')
      assert.equal(calls[1].resultPreview, 'second result')
    }
    const goal = harnessToolResultView('goal', { message: result(api, 'g', '{"goal":{"objective":"Ship","phase":"active"}}') })
    assert.match(goal.content[0].text, /Ship/)
    const todos = harnessToolResultView('todo', { message: result(api, 't', '{"todos":[{"content":"Verify","status":"in_progress"}]}') })
    assert.match(todos.content[1].text, /Verify/)
    assert.equal(toolErrorText({ data: { message: result(api, 'e', 'explanation', true) } }), 'explanation')
  }
  // Kiokuko structured memory is passed unchanged through the real channel.
  // Body characters and relation metadata have independent upstream budgets.
  for (const mode of ['live', 'replay']) for (const status of [
    'complete', 'omitted_budget', 'omitted_edge_cap', 'omitted_unknown_type', 'omitted_legacy',
  ]) {
    const items = [{ workspace: 'project:memory', entryId: 'a', text: '😀'.repeat(12000) },
      { workspace: 'project:memory', entryId: 'b', text: '界'.repeat(4000) }]
    const relationDelivery = { scope: 'provided_items', status, edges: status === 'complete'
      ? ['supports', 'contradicts', 'derived_from', 'related_to'].map(type => ({
        from: { workspace: items[0].workspace, entryId: 'a' },
        to: { workspace: items[1].workspace, entryId: 'b' }, type,
      })) : [], selectionOmissions: ['body_budget', 'item_limit', 'final_filter'] }
    const payload = { items, relationDelivery }
    const text = JSON.stringify(payload)
    const events = [
      { seq: 0, time: 1, type: 'tool/call', data: { callId: 'memory', name: 'memory_recall', arguments: '{}' } },
      { seq: 1, time: 2, type: 'tool/result', data: { message: result('v4', 'memory', text) } },
    ]
    const untouched = structuredClone(events)
    const log = mode === 'replay' ? [...events] : []
    const handlers = new Map(), presented = []
    const ctx = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
      get(name) { return name === 'tools' ? { get: () => ({ presentResult(_args, value) {
        presented.push(value); return { card: 'generic', content: value.content }
      } }) } : undefined }, logger: { warn() {} } }
    const agent = { id: 'memory-agent', status: 'idle', ctx: { on: () => () => {} },
      session: { id: 'memory-session', get seq() { return log.length }, snapshotEvents: () => log } }
    const channel = createChannel(ctx, agent, { cwd: home, model: 'test', provider: 'test', activity: false })
    try {
      if (mode === 'live') for (const event of events) {
        log.push(event); handlers.get('session/event')(agent.session, event)
      }
      assert.deepEqual(events, untouched, `${mode}/${status}: native events retain full memory`)
      assert.equal(presented.length, 1)
      assert.equal(presented[0].content[0].text, text)
      assert.deepEqual(JSON.parse(channel.rows.find(row => row.kind === 'tool').tool.resultFull), payload)
      const exported = channel.exportSession()
      assert.ok(exported)
      const markdown = readFileSync(exported, 'utf8')
      assert.ok(markdown.includes(text), `${mode}/${status}: export preserves both body and metadata`)
    } finally { channel.releaseContributions() }
  }
  console.log('PASS: V4 messages in live/replay/folded projections, export, subagents and compact checkpoints')
} finally { rmSync(home, { recursive: true, force: true }) }
