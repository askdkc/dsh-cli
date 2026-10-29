/** Run with node --import tsx/esm and the kiokuko-dsh source root as argv[2].
 * Uses Kiokuko's actual routing module and DSH's real loop; only model I/O is scripted.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { settled } from './lib/term-test.mjs'

assert.ok(process.argv[2], 'pass the kiokuko-dsh source root')
const { installDshModelRouting } = await import(pathToFileURL(join(resolve(process.argv[2]), 'src/dsh/model-routing.ts')).href)
const requests = []
let choice = { provider: 'scripted', model: 'head', reasoningEffort: 'low' }
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max',
    } }
  }
  async *stream(options) {
    requests.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
    if (requests.length === 2) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'handoff', name: 'echo', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
const ctx = new Context()
let channel
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new Adapter())
  ctx.tools.register(defineTool({
    name: 'echo', description: 'change Kiokuko route before continuation', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { choice = { provider: 'scripted', model: 'worker', reasoningEffort: 'max' }; return 'done' },
  }))
  const handle = await ctx.agents.create({ sessionId: 'kiokuko-model-routing',
    agentOptions: { provider: 'scripted', model: 'ordinary' },
    setup(agentCtx, agent) {
      agentCtx.effect(() => installDshModelRouting(agent, async () => choice))
    },
  })
  channel = createChannel(ctx, handle.agent, { provider: 'scripted', model: 'ordinary', effort: 'max', cwd: '/tmp', activity: false })
  const send = async (text, count) => {
    channel.submit(text)
    assert.ok(await settled(() => requests.length >= count && !channel.working), JSON.stringify(channel.rows))
    assert.ok(!channel.rows.some(row => /turn error/.test(row.text ?? '')), JSON.stringify(channel.rows))
  }
  await send('first request', 1)
  assert.deepEqual(requests[0], { provider: 'scripted', model: 'head', reasoningEffort: 'low' }, 'Kiokuko selection survives the channel preference')
  await send('continue through a tool', 3)
  assert.deepEqual(requests[1], requests[0])
  assert.deepEqual(requests[2], { provider: 'scripted', model: 'worker', reasoningEffort: 'max' }, 'tool continuation captures the next Kiokuko selection')
  choice = undefined
  await send('return to ordinary selection', 4)
  assert.deepEqual(requests[3], { provider: 'scripted', model: 'ordinary', reasoningEffort: 'max' }, 'ordinary selection is restored before preparation')
  assert.equal(channel.reasoningEffort, 'max')
  console.log('Kiokuko model routing OK (real DSH loop: head, effort, tool continuation, worker, ordinary restore)')
} finally {
  channel?.releaseContributions()
  await ctx.fiber.dispose()
}
