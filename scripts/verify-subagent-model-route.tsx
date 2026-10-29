/** Children receive their route before step preparation, never in agent/request. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createChannel } from '../src/dsh-adapter/channel.js'

const ctx = new Context()
let channel: ReturnType<typeof createChannel> | undefined
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  const parent = await ctx.agents.create({ sessionId: 'route-parent' as never,
    agentOptions: { provider: 'parent-provider', model: 'parent-model' } })
  channel = createChannel(ctx, parent.agent, {
    provider: 'parent-provider', model: 'parent-model', cwd: '/tmp', activity: false,
  })
  const inherited = await ctx.agents.create({ sessionId: 'route-child' as never })
  assert.deepEqual(inherited.agent.model.current(), { provider: 'parent-provider', model: 'parent-model' })
  const explicit = await ctx.agents.create({ sessionId: 'route-explicit' as never,
    agentOptions: { provider: 'custom', model: 'custom-model', reasoningEffort: 'high' as never } })
  assert.deepEqual(explicit.agent.model.current(), { provider: 'custom', model: 'custom-model', reasoningEffort: 'high' })
  const partial = await ctx.agents.create({ sessionId: 'route-partial' as never,
    agentOptions: { provider: 'orphan' } })
  assert.deepEqual(partial.agent.model.current(), { provider: 'parent-provider', model: 'parent-model' })
  channel.releaseContributions()
  const detached = await ctx.agents.create({ sessionId: 'route-detached' as never })
  assert.equal(detached.agent.model.current(), undefined, 'released channels cannot route unrelated agents')
  console.log('subagent model routes OK (real Agent creation, inherited/explicit/partial/disposed)')
} finally {
  channel?.releaseContributions()
  await ctx.fiber.dispose()
}
