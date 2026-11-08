/**
 * Catalog provider routes this plugin owns, mounted with their catalog
 * models, wire implementations, and authentication methods intact.
 *
 * The hand-built profile mirrors what an empty llm-pi-ai settings profile
 * resolves to for a catalog route, including the image-request defaults
 * (llm-pi-ai does not expose its `DEFAULT_*` constants at the package entry).
 *
 * @module dsh-auth/profiles
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { adapterBuiltinProviders, type PiAiProvider } from './pi-ai.js'

export { OAUTH_PROVIDER_IDS, CATALOG_PROVIDER_IDS, AUTH_PROVIDER_IDS, canonicalProvider, type ModelOverride } from './routes.js'
import { CATALOG_PROVIDER_IDS, type ModelOverride } from './routes.js'

/** llm-pi-ai `DEFAULT_MAX_REQUEST_IMAGE_BYTES` (20 MiB, base64 payload bound). */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** llm-pi-ai `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` (2048×2048 pixels). */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** llm-pi-ai `DEFAULT_REQUEST_IMAGE_MAX_BYTES` (1 MiB per image). */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** Image count defaults from llm-pi-ai. Older peers ignore these fields. */
const REQUEST_IMAGE_COUNT_DEFAULTS = {
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
}
/** llm-pi-ai `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (5 minutes). */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** The installed pi-ai catalog provider for one route, whose OAuth flow we mount. */
function catalogProviderOf(id: string): PiAiProvider {
  const found = adapterBuiltinProviders().find(provider => provider.id === id)
  if (found === undefined) {
    throw new Error(
      `dsh-auth: the installed pi-ai catalog ships no provider "${id}"; `
      + 'remove it from this plugin\'s providers config or update pi-ai',
    )
  }
  return found
}

export function oauthOf(route: PiAiProvider): NonNullable<PiAiProvider['auth']['oauth']> {
  const oauth = route.auth.oauth
  if (oauth === undefined) {
    throw new Error(`dsh-auth: pi-ai provider "${route.id}" ships no OAuth flow`)
  }
  return oauth
}

/**
 * Apply per-model overrides to one catalog provider. Only the touched model
 * entries are cloned — the installed catalog objects are shared module state
 * and must never be mutated in place — and a miss is refused, never skipped,
 * so a typo lands as a boot error instead of a silently unchanged model.
 * @param catalog - the installed pi-ai catalog provider for one route.
 * @param overrides - per-model field overrides, keyed by model id.
 * @returns the catalog provider, or a shallow clone carrying overridden models.
 */
function withModelOverrides(
  catalog: PiAiProvider,
  overrides: Readonly<Record<string, ModelOverride>> | undefined,
): PiAiProvider {
  if (overrides === undefined || Object.keys(overrides).length === 0) return catalog
  const catalogModels = new Map(catalog.getModels().map(model => [model.id, model] as const))
  for (const id of Object.keys(overrides)) {
    if (!catalogModels.has(id)) {
      throw new Error(
        `dsh-auth: modelOverrides names "${id}", which provider "${catalog.id}" does not ship in the installed catalog`,
      )
    }
  }
  const models = catalog.getModels().map(model => {
    const override = overrides[model.id]
    if (override === undefined) return model
    return { ...model, ...override }
  })
  return {
    ...catalog,
    getModels: () => models,
  }
}

/**
 * Build the resolved profile one route registers under. Mirrors the fields
 * `PiAiAdapter` reads: identity for selectors, the idle timeout, retry
 * policy, and image budgets it forwards per request, and the catalog provider
 * with its own models. Everything optional stays absent — the adapter treats
 * absence as "provider defaults" exactly as an empty llm-pi-ai profile would.
 * @param id - the OAuth provider route to mount.
 * @param modelOverrides - optional per-model catalog overrides (see
 *   {@link ModelOverride}); `undefined` serves the installed catalog unchanged.
 */
export function buildOAuthProfile(
  id: string,
  modelOverrides?: Readonly<Record<string, ModelOverride>>,
): ResolvedPiAiProviderProfile {
  if (!(CATALOG_PROVIDER_IDS as readonly string[]).includes(id)) {
    throw new Error(`dsh-auth: "${id}" is not a catalog provider this build mounts (${CATALOG_PROVIDER_IDS.join(', ')})`)
  }
  const provider = catalogProviderOf(id)
  if (id === 'opencode' || id === 'opencode-go') throw new Error('OpenCode uses the native adapter')
  const catalog = withModelOverrides(provider, modelOverrides)
  return {
    provider: id,
    displayName: catalog.name,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-auth: provider "${id}" retryPolicy`),
    configuredMaxTokens: new Map(),
    piProvider: catalog,
    // Per-model pre-request diagnostics.
    modelErrors: new Map(),
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    ...REQUEST_IMAGE_COUNT_DEFAULTS,
  }
}
