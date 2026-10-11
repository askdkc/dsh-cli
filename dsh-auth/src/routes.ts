/** Provider identities and user-owned capacity overrides; no transport imports. */
/** Provider routes this build mounts, in picker order. */
export const OAUTH_PROVIDER_IDS = ['openai-codex', 'anthropic', 'xai'] as const
export const CATALOG_PROVIDER_IDS = [...OAUTH_PROVIDER_IDS, 'opencode', 'opencode-go', 'openrouter'] as const
export const AUTH_PROVIDER_IDS = [...CATALOG_PROVIDER_IDS, 'nous', 'infron'] as const
export const INFRON_SERVICE_TIERS = ['standard', 'flex'] as const
export type InfronServiceTier = (typeof INFRON_SERVICE_TIERS)[number]
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  hermes: 'nous',
  'infron.ai': 'infron',
  'opencode-zen': 'opencode',
}

export function canonicalProvider(id: string): string {
  return PROVIDER_ALIASES[id] ?? id
}

/** One routable provider id. */
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

/**
 * One per-model catalog override a deployment may name, keyed by model id.
 * Every field is optional; an absent field keeps the installed catalog's
 * value, so one model's capacity can be tuned without restating the rest.
 */
export interface ModelOverride {
  /** Override the installed catalog's context window, in tokens. */
  contextWindow?: number
  /** Override the installed catalog's max output tokens. */
  maxTokens?: number
}

