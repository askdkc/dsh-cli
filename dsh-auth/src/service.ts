/**
 * The `ctx.dshAuth` service: the programmatic surface over this plugin's
 * mounted provider routes. UIs (the dsh-cli /provider wizard, a web settings
 * page) enumerate providers with masked sign-in state and drive login/logout
 * without touching the credential file or the pi-ai flow objects; the `/auth`
 * command in `command.ts` is a thin textual veneer over the same api.
 *
 * @module dsh-auth/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { asStoredCredential, CredentialFile } from './credentials.js'
import { canonicalProvider } from './routes.js'
import type { OpenCodeCatalog, OpenCodeRoute, OpenCodeCatalogStatus } from './opencode-catalog.js'
import { QuestionBridge, type AskFn } from './interaction.js'
import type { OAuthFlow } from './auth-contract.js'
import { loginNous } from './nous-oauth.js'

export interface AuthRoute {
  provider: string
  displayName: string
  oauth?: OAuthFlow
}
function oauthOf(profile: AuthRoute): NonNullable<AuthRoute['oauth']> {
  const oauth = profile.oauth
  if (!oauth) throw new Error(`dsh-auth: OAuth flow unavailable for ${profile.provider}`)
  return oauth
}

/** One provider's sign-in state; never carries token material. */
export interface DshAuthSignInStatus {
  provider: string
  /** Route display name (selectors, pickers). */
  label: string
  /** The OAuth flow's own name, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  oauthLabel: string
  /** The flow's login-call-to-action label, when it ships one. */
  loginLabel: string | undefined
  authMethods: readonly ('oauth' | 'api-key' | 'device-code' | 'bearer')[]
  credentialKind: 'oauth-token' | 'api-key' | undefined
  signedIn: boolean
  expiresAt?: number
  /** Signed in, but the stored access token has expired (refresh may still work). */
  expired: boolean
}

/** The outcome of a successful login. */
export interface DshAuthLoginResult {
  provider: string
  oauthLabel: string
  authMethods: readonly ('oauth' | 'api-key' | 'device-code' | 'bearer')[]
  credentialKind: 'oauth-token' | 'api-key'
  expiresAt?: number
  modelWarning?: string
}

/** The service api consumed by commands and UIs. */
export interface DshAuthApi {
  /** Every mounted provider with masked sign-in state. */
  providers(): Promise<readonly DshAuthSignInStatus[]>
  catalogStatus?(provider?: string): readonly OpenCodeCatalogStatus[]
  refreshModels?(provider?: string, signal?: AbortSignal): Promise<readonly OpenCodeCatalogStatus[]>
  /**
   * Run one provider's login. `provider` omitted asks the interactive
   * surface to choose among providers not currently signed in.
   * @throws Error when no interactive surface is present, the provider is
   *   unknown, a login is already running, or the flow itself fails.
   */
  login(provider?: string, signal?: AbortSignal): Promise<DshAuthLoginResult>
  /** Remove one provider's stored credential; resolves whether one existed. */
  logout(provider: string): Promise<boolean>
  /** Register a callback for successful credential mutations. */
  onCredentialChange?(listener: (provider: string) => void): () => void
  /** Signal that a previously stored credential's model catalog finished loading. */
  notifyModelsChanged?(provider: string): void
}

/** Cordis service holder; `api` is set by the plugin's apply. */
export class DshAuthService extends Service {
  api: DshAuthApi | undefined

  constructor(ctx: Context) {
    super(ctx, 'dshAuth')
  }
}

/** Everything the api factory needs; all cordis surface is injected, so tests run without a host. */
export interface DshAuthApiDeps {
  profiles: ReadonlyMap<string, AuthRoute>
  catalogs?: ReadonlyMap<OpenCodeRoute, OpenCodeCatalog>
  store: CredentialFile
  /** The interactive ask surface, resolved per call so mounting order never matters. */
  resolveAsk: () => AskFn | undefined
  logger: { warn(message: string): void }
  nousClientId?: string
  credentialChanged?: (provider: string, credential: ReturnType<typeof asStoredCredential> | undefined) => Promise<void>
}

/** Select a provider interactively among `candidates`. */
async function chooseProvider(ask: AskFn, candidates: readonly DshAuthSignInStatus[], signal: AbortSignal | undefined): Promise<string> {
  const answer = await ask({
    questions: [{
      id: 'dsh-auth-provider',
      header: 'dsh-auth',
      question: 'Sign in with which provider?',
      options: candidates.map(row => ({ label: row.oauthLabel, description: row.provider })),
    }],
    signal,
  })
  const row = answer.answers[0]
  const label = row?.selected[0]
  const chosen = candidates.find(candidate => candidate.oauthLabel === label)
  if (chosen === undefined) throw new Error('dsh-auth: no provider was chosen')
  return chosen.provider
}

/**
 * The api implementation. One login runs per provider at a time (an in-flight
 * map, not a global lock: providers sign in independently); a second login
 * attempt for the same provider fails fast instead of stacking two flows.
 */
export function createDshAuthApi(deps: DshAuthApiDeps): DshAuthApi {
  const inflight = new Map<string, Promise<DshAuthLoginResult>>()

  const statusOf = async (): Promise<readonly DshAuthSignInStatus[]> => {
    const described = new Map((await deps.store.describe()).map(row => [row.provider, row]))
    return [...deps.profiles.entries()].map(([id, profile]) => {
      const methods = authMethodsOf(id)
      const oauth = methods.includes('oauth') ? oauthOf(profile) : undefined
      const row = described.get(id)
      return {
        provider: id,
        label: profile.displayName,
        oauthLabel: oauth?.name ?? profile.displayName,
        loginLabel: oauth?.loginLabel,
        authMethods: methods,
        credentialKind: row?.credentialKind,
        signedIn: row !== undefined && !row.expired,
        ...(row?.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
        expired: row?.expired ?? false,
      }
    })
  }

  const generations = new Map<string, number>()
  const listeners = new Set<(provider: string) => void>()
  const changed = (provider: string): void => {
    for (const listener of listeners) {
      try { listener(provider) } catch { deps.logger.warn('dsh-auth: a credential-change subscriber failed') }
    }
  }

  const loginOne = async (provider: string, ask: AskFn, signal: AbortSignal | undefined): Promise<DshAuthLoginResult> => {
    const profile = deps.profiles.get(provider)
    if (profile === undefined) {
      throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
    }
    const methods = authMethodsOf(provider)
    const generation = generations.get(provider) ?? 0
    const runAbort = new AbortController()
    if (signal !== undefined) {
      if (signal.aborted) runAbort.abort(signal.reason)
      else signal.addEventListener('abort', () => runAbort.abort(signal.reason), { once: true })
    }
    const bridge = new QuestionBridge(ask, runAbort)
    try {
      let method = methods[0]
      if (methods.length > 1) {
        const answer = await ask({
          questions: [{
            id: 'dsh-auth-method', header: 'dsh-auth', question: `Sign in to ${profile.displayName} using:`,
            options: methods.map(item => ({ label: item })),
          }], signal: runAbort.signal,
        })
        method = methods.find(item => item === answer.answers[0]?.selected[0])
        if (method === undefined) throw new Error('dsh-auth: no authentication method was chosen')
      }
      if (runAbort.signal.aborted) throw new Error('dsh-auth: sign-in cancelled')
      let credential: ReturnType<typeof asStoredCredential>
      if (method === 'oauth') {
        const oauth = oauthOf(profile)
        credential = asStoredCredential(await oauth.login(bridge))
        if (credential?.type !== 'oauth') throw new Error(`dsh-auth: the ${oauth.name} flow returned an unusable credential`)
      } else if (method === 'api-key' || method === 'bearer') {
        const key = await bridge.prompt({ type: 'secret', message: `Enter ${profile.displayName} ${method === 'bearer' ? 'Bearer token' : 'API key'}` })
        credential = { type: 'api_key', key }
      } else if (method === 'device-code' && provider === 'nous') {
        credential = await loginNous(bridge, deps.nousClientId ?? 'hermes-cli')
      } else {
        throw new Error('dsh-auth: device-code authentication is unavailable')
      }
      if (credential === undefined) throw new Error('dsh-auth: sign-in returned no credential')
      if (runAbort.signal.aborted || generation !== (generations.get(provider) ?? 0)) {
        throw new Error('dsh-auth: sign-in cancelled')
      }
      const stored = await deps.store.modify(provider, async () =>
        generation === (generations.get(provider) ?? 0) ? credential : undefined)
      if (generation !== (generations.get(provider) ?? 0) || stored !== credential) {
        throw new Error('dsh-auth: sign-in cancelled')
      }
      let modelWarning: string | undefined
      try {
        await deps.credentialChanged?.(provider, credential)
      } catch (error: unknown) {
        modelWarning = error instanceof Error ? error.message : 'model discovery failed'
      }
      if (generation !== (generations.get(provider) ?? 0)) {
        await deps.credentialChanged?.(provider, undefined)
        throw new Error('dsh-auth: sign-in cancelled')
      }
      changed(provider)
      const expiresAt = credential.type === 'oauth' && provider !== 'openrouter' ? credential.expires : undefined
      return { provider, oauthLabel: method === 'oauth' ? oauthOf(profile).name : profile.displayName, authMethods: methods,
        credentialKind: credential.type === 'api_key' || provider === 'openrouter' ? 'api-key' : 'oauth-token',
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(modelWarning === undefined ? {} : { modelWarning }) }
    } finally {
      await bridge.settle()
    }
  }

  return {
    providers: statusOf,
    catalogStatus: provider => [...(deps.catalogs?.values() ?? [])].filter(catalog => provider === undefined || catalog.provider === canonicalProvider(provider)).map(catalog => catalog.status()),
    refreshModels: async (provider, signal) => {
      signal?.throwIfAborted()
      const selected = [...(deps.catalogs?.values() ?? [])].filter(catalog => provider === undefined || catalog.provider === canonicalProvider(provider))
      if (!selected.length) throw new Error('No matching OpenCode catalog is mounted')
      const refresh = Promise.all(selected.map(catalog => catalog.refresh()))
      if (!signal) return refresh
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Catalog update wait cancelled; shared background refresh may continue'))
        signal.addEventListener('abort', abort, { once: true })
        void refresh.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
    },
    login: async (provider, signal) => {
      const ask = deps.resolveAsk()
      let target = provider === undefined ? undefined : canonicalProvider(provider)
      if (target === undefined) {
        if (ask === undefined) {
          throw new Error('dsh-auth: provider selection needs an interactive surface; name the provider: /auth login <provider>')
        }
        const statuses = await statusOf()
        const candidates = statuses.filter(row => !row.signedIn)
        if (candidates.length === 0) throw new Error('dsh-auth: every mounted provider is already signed in')
        target = await chooseProvider(ask, candidates, signal)
      } else if (!deps.profiles.has(target)) {
        throw new Error(`dsh-auth: unknown provider "${target}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
      }
      if (ask === undefined) {
        throw new Error(
          `dsh-auth: signing in to "${target}" needs an interactive surface (run inside dsh-cli or the web client); `
          + 'this plugin refuses to assume a browser on this machine',
        )
      }
      const existing = inflight.get(target)
      if (existing !== undefined) {
        throw new Error(`dsh-auth: a login for "${target}" is already running`)
      }
      const run = loginOne(target, ask, signal).finally(() => { inflight.delete(target) })
      inflight.set(target, run)
      return run
    },
    logout: async provider => {
      const target = canonicalProvider(provider)
      if (!deps.profiles.has(target)) {
        throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
      }
      generations.set(target, (generations.get(target) ?? 0) + 1)
      const existed = (await deps.store.read(target)) !== undefined
      await deps.store.delete(target)
      await deps.credentialChanged?.(target, undefined)
      if (existed) changed(target)
      return existed
    },
    onCredentialChange: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    notifyModelsChanged: changed,
  }
}

function authMethodsOf(provider: string): DshAuthSignInStatus['authMethods'] {
  if (provider === 'openrouter') return ['oauth', 'api-key']
  if (provider === 'nous') return ['device-code', 'bearer']
  if (provider === 'opencode' || provider === 'opencode-go' || provider === 'orcarouter' || provider === 'infron') return ['api-key']
  return ['oauth']
}
