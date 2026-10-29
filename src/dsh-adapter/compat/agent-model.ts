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
 * Read the native Agent model selector when available. Older Agents expose the
 * same live route through mutable options, so adapt that representation at this
 * single boundary instead of spreading version casts through channel code.
 */
export function agentModel(agent: Agent): AgentModelSelection {
  const compatible = agent as CompatibleAgent
  if (compatible.model !== undefined) return compatible.model

  const options = compatible.options
  if (options === undefined) throw new TypeError('Agent exposes neither model selection nor route options')
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
