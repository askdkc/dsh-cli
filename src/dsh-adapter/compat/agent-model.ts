import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'

/** Stable model-selection surface across the upstream Agent API transition. */
export interface AgentModelSelection {
  current(): ModelSelection | undefined
  select(selection: ModelSelection): void
}

type CompatibleAgent = Agent & {
  readonly model?: AgentModelSelection
  readonly options?: {
    provider?: string
    model?: string
    reasoningEffort?: ModelSelection['reasoningEffort']
  }
}

/**
 * Total fallback for an Agent that exposes no route at all. Reads report that
 * no selection is known and writes change nothing, which is exactly what the
 * previously optional `agent.model` reads did. Model selection is an optional
 * capability of the Agent boundary, so binding a session must not abort when a
 * caller supplies an Agent-shaped value without it.
 */
const INERT_SELECTION: AgentModelSelection = Object.freeze({
  current: () => undefined,
  select: () => { /* no surface to record on */ },
})

/**
 * Read the native Agent model selector when available. Older Agents expose the
 * same live route through mutable options, so adapt that representation at this
 * single boundary instead of spreading version casts through channel code.
 * An Agent with neither representation keeps the pre-existing tolerant behavior
 * instead of turning an optional capability into a construction failure.
 */
export function agentModel(agent: Agent): AgentModelSelection {
  const compatible = agent as CompatibleAgent
  if (compatible.model !== undefined) return compatible.model

  const options = compatible.options
  if (options === undefined) return INERT_SELECTION
  return {
    current: () => {
      if (typeof options.provider !== 'string' || options.provider.length === 0 ||
        typeof options.model !== 'string' || options.model.length === 0) return undefined
      return {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      }
    },
    select: selection => {
      options.provider = selection.provider
      options.model = selection.model
      options.reasoningEffort = selection.reasoningEffort
    },
  }
}
