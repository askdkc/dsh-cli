import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProvider } from './pi-ai.js'
import { buildOAuthProfile, type ModelOverride } from './profiles.js'
import type { InfronServiceTier } from './routes.js'

type PiModel = ReturnType<PiAiProvider['getModels']>[number]
type PiStreamOptions = NonNullable<Parameters<PiAiProvider['streamSimple']>[2]>

const CUSTOM = {
  nous: { name: 'Hermes Agent / Nous Portal', baseURL: 'https://inference-api.nousresearch.com/v1' },
  infron: { name: 'Infron', baseURL: 'https://llm.onerouter.pro/v1' },
} as const

export type CustomProviderId = keyof typeof CUSTOM
export const CUSTOM_PROVIDER_IDS = Object.keys(CUSTOM) as CustomProviderId[]

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function nonnegative(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function modelFromRow(provider: CustomProviderId, value: unknown, overrides: Readonly<Record<string, ModelOverride>>): PiModel | undefined {
  const row = record(value)
  if (row === undefined || typeof row.id !== 'string' || row.id.length === 0) return undefined
  const endpoints = row.supported_endpoint_types
  if (Array.isArray(endpoints) && !endpoints.some(item =>
    item === 'openai' || item === 'chat' || item === 'chat_completions' || item === 'openai-chat-completions')) return undefined
  if (provider === 'infron' && (row.category_type !== 'LLM' || row.supports_function_calling === false || row.supports_streaming === false)) return undefined
  if (provider === 'nous' && (!Array.isArray(row.supported_parameters) || !row.supported_parameters.includes('tools'))) return undefined
  const override = overrides[row.id]
  const top = record(row.top_provider)
  const contextWindow = override?.contextWindow ?? positive(row.context_length) ?? positive(row.context_window)
  const maxTokens = override?.maxTokens ?? positive(row.max_output_tokens)
    ?? positive(row.max_tokens) ?? positive(row.max_completion_tokens) ?? positive(top?.max_completion_tokens)
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  const pricing = record(row.pricing)
  const promptPrice = pricing === undefined ? undefined : nonnegative(pricing.prompt)
  const completionPrice = pricing === undefined ? undefined : nonnegative(pricing.completion)
  // Infron's min_* prices are already USD per million tokens; OpenRouter-style
  // pricing.prompt/completion fields are USD per token.
  const inputCost = provider === 'infron' ? nonnegative(row.min_prompt_price) : promptPrice === undefined ? undefined : promptPrice * 1_000_000
  const outputCost = provider === 'infron' ? nonnegative(row.min_completion_price) : completionPrice === undefined ? undefined : completionPrice * 1_000_000
  // pi-ai requires numeric prices. Do not advertise a model whose pricing is unknown.
  if (inputCost === undefined || outputCost === undefined) return undefined
  const architecture = record(row.architecture)
  const modalities = architecture?.input_modalities ?? row.input_modalities
  if (Array.isArray(modalities) && !modalities.includes('text')) return undefined
  const outputModalities = architecture?.output_modalities ?? row.output_modalities
  if (Array.isArray(outputModalities) && !outputModalities.includes('text')) return undefined
  const input = Array.isArray(modalities) && modalities.includes('image') ? ['text', 'image'] as const : ['text'] as const
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : typeof row.display_name === 'string' ? row.display_name : row.id,
    provider,
    api: 'openai-completions',
    baseUrl: CUSTOM[provider].baseURL,
    reasoning: false,
    input: [...input],
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  } as PiModel
}

export interface CustomProfile {
  profile: ResolvedPiAiProviderProfile
  clear(): void
  refresh(key: string, signal?: AbortSignal): Promise<number>
}

function discoveryFailure(name: string, status: number): Error {
  const reason = status === 401 ? 'API key rejected'
    : status === 403 ? 'account is not allowed to list models'
      : status === 429 ? 'rate limited; retry later'
        : status >= 500 ? 'provider unavailable; retry later'
          : 'request rejected'
  return new Error(`dsh-auth: ${name} model discovery failed (HTTP ${status}: ${reason})`)
}

/** Merge Infron's routing extension after any caller payload transform. */
function serviceTierPayload(
  onPayload: PiStreamOptions['onPayload'],
  serviceTier: InfronServiceTier,
): NonNullable<PiStreamOptions['onPayload']> {
  return async (payload, model) => {
    const transformed = await onPayload?.(payload, model)
    const body = record(transformed === undefined ? payload : transformed)
    if (body === undefined) throw new Error('dsh-auth: Infron request payload must be an object')
    return { ...body, provider: { ...record(body.provider), service_tier: serviceTier } }
  }
}

/** A strict catalog: missing capacity/pricing/endpoint evidence leaves a model unselectable. */
export function createCustomProfile(
  id: CustomProviderId,
  overrides: Readonly<Record<string, ModelOverride>> = {},
  serviceTier?: InfronServiceTier,
): CustomProfile {
  const spec = CUSTOM[id]
  const base = buildOAuthProfile('openrouter')
  const source = base.piProvider
  if (source === undefined) throw new Error('dsh-auth: OpenRouter catalog is unavailable for chat-completion dispatch')
  let models: PiModel[] = []
  const provider: PiAiProvider = {
    ...source,
    id,
    name: spec.name,
    baseUrl: spec.baseURL,
    auth: {
      apiKey: {
        name: `${spec.name} credential`,
        resolve: async ({ credential }) => ({
          auth: credential?.type === 'api_key' ? { apiKey: credential.key } : {},
          source: spec.name,
        }),
      },
    },
    getModels: () => models,
    refreshModels: undefined,
    ...(id === 'infron' && serviceTier !== undefined ? {
      streamSimple: (model, context, options) => source.streamSimple(model, context, {
        ...options, onPayload: serviceTierPayload(options?.onPayload, serviceTier),
      }),
    } satisfies Partial<PiAiProvider> : {}),
  }
  return {
    profile: { ...base, provider: id, displayName: spec.name, piProvider: provider },
    clear: () => { models = [] },
    refresh: async (key, signal) => {
      const timeout = AbortSignal.timeout(15_000)
      let response: Response
      try {
        response = await fetch(`${spec.baseURL}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        })
      } catch {
        if (signal?.aborted) throw new Error(`dsh-auth: ${spec.name} model discovery cancelled`)
        if (timeout.aborted) throw new Error(`dsh-auth: ${spec.name} model discovery timed out`)
        throw new Error(`dsh-auth: ${spec.name} model discovery could not reach the provider`)
      }
      if (!response.ok) throw discoveryFailure(spec.name, response.status)
      let payload: unknown
      try { payload = await response.json() } catch {
        throw new Error(`dsh-auth: ${spec.name} model discovery returned invalid JSON`)
      }
      const data = record(payload)?.data
      if (!Array.isArray(data)) throw new Error(`dsh-auth: ${spec.name} model discovery returned an invalid list`)
      const next = data.map(row => modelFromRow(id, row, overrides)).filter((row): row is PiModel => row !== undefined)
      if (next.length === 0) throw new Error(`dsh-auth: ${spec.name} returned no chat models with verified capacity and pricing`)
      models = next
      return next.length
    },
  }
}
