/** Real /model -> submit -> JSONL resume with the host execution fence mounted.
 * Only model transport is scripted. No network or user-profile writes.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Host from '../lib/types/dsh-adapter/plugin-host.js'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { settled } from './lib/term-test.mjs'

let requests = 0, toolRuns = 0
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() {
    requests++
    if (requests % 2 === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `echo-${requests}`, name: 'echo', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `reply-${requests}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function fixture(id) {
  const ctx = new Context()
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(JsonlSessionPersistence, { root: join(process.env.HOME, 'sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Host)
    await ctx.plugin({ name: 'fixture-fence-owner', apply(scope) {
      const fence = scope.get('executionFences').attach({ id: 'fixture', tools: ['fenced_eval'], check: () => undefined })
      fence.protect('unrelated-protected-session')
    } })
    ctx.llm.registerAdapter(['scripted'], new Adapter())
    ctx.tools.register(defineTool({
      name: 'echo', description: 'Regression fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { toolRuns++; return 'tool output' },
    }))
    const handle = await ctx.agents.create({ sessionId: id, cwd: process.env.HOME,
      agentOptions: { provider: 'scripted', model: 'initial' } })
    const channel = createChannel(ctx, handle.agent, { handle, cwd: process.env.HOME,
      provider: 'scripted', model: 'initial', activity: false })
    return { ctx, channel, async close() { channel.releaseContributions(); await ctx.fiber.dispose() } }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

async function send(channel, prompt, expectedRequests, expectedTools) {
  channel.submit(prompt)
  assert.ok(await settled(() => requests === expectedRequests && !channel.working), JSON.stringify(channel.rows))
  assert.equal(toolRuns, expectedTools, 'the native tool executes after the model step')
  assert.ok(channel.rows.some(row => row.kind === 'user' && row.text === prompt))
  assert.ok(channel.rows.some(row => row.kind === 'assistant' && row.text === `reply-${expectedRequests}`))
  assert.ok(!channel.rows.some(row => /turn (blocked|error)/u.test(row.text)), JSON.stringify(channel.rows))
  assert.equal(channel.pending.length, 0)
}

const live = await fixture('model-source')
let forkId
try {
  for (const model of ['second', 'third']) {
    const previousId = live.channel.sessionId
    assert.equal(await live.channel.switchModel('scripted', model), true)
    assert.notEqual(live.channel.sessionId, previousId)
    assert.ok(await settled(() => live.ctx.sessions.get(previousId) === undefined), 'model switch retires its parent Session')
  }
  forkId = live.channel.sessionId
  await send(live.channel, 'question after model switch', 2, 1)
} finally { await live.close() }

const resumed = await fixture('resume-bootstrap')
try {
  assert.equal(resumed.ctx.sessions.get('model-source'), undefined)
  const result = await resumed.channel.resumeTo(forkId)
  assert.equal(result.ok, true, JSON.stringify(result))
  await send(resumed.channel, 'continue after restart', 4, 2)
  assert.equal(resumed.ctx.sessions.get('model-source'), undefined, 'metadata lookup does not restore the parent Session')
} finally { await resumed.close() }
console.log('PASS: real model switches, retired parents, model/tool replies and cold JSONL resume with execution fences')
