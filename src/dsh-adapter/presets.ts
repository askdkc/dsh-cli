/**
 * Agent-presets roster integration (issue #8): compose each session's
 * model-facing world (tools, prompt sections, projections) from one preset
 * directory instead of the host composition.
 *
 * Mirrors the official host's integration (dsh-host-apiproxy's
 * `composeAgent`): the preset id is resolved BEFORE create/resume because the
 * session boundary snapshots `meta` (the durable header's `agentPreset`)
 * before asynchronous setup begins; the mount itself runs inside the agent
 * factory's `setup(agentCtx)` hook, where a composition failure rolls the
 * whole creation back instead of publishing a half-configured agent.
 *
 * A composition without a preset registry supplies no preset setup.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { recordedModelRoute, type ModelRoute } from '../modelRoute.js'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'
import { readPersistedSession, type SessionReader } from './compat/persistence.js'
import {
  resolveRecordedPreset,
  rosterOf,
} from './preset-resolution.js'

const ASK_USER_TOOL = 'ask_user_question'

type ConditionalToolRegistration = {
  register(
    definition: unknown,
    options: { when(input: { agent: Agent }): boolean },
  ): () => void
}

/** Keep questionnaire availability in the step's admitted tool set. */
export function registerPresetQuestionToolAdmission(ctx: Context): () => void {
  const installed = new WeakSet<Agent>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const tools = agent.ctx.get('tools')
    const definition = tools?.get(ASK_USER_TOOL, agent)
    if (tools === undefined || definition === undefined) return
    installed.add(agent)
    if (tools.register.length >= 2) {
      const dispose = (tools as unknown as ConditionalToolRegistration).register(
        definition,
        { when: ({ agent: target }) => runningPresetOf(target.session) !== 'minimal' },
      )
      agent.ctx.effect(() => dispose)
      return
    }

    // Before conditional registrations, per-agent restrictions owned both the
    // visible schema and executable lookup. Keep the restriction in sync with
    // the session log so preset changes remain immediate and reversible.
    let liftRestriction: (() => void) | undefined
    const syncRestriction = (): void => {
      const minimal = runningPresetOf(agent.session) === 'minimal'
      if (minimal === (liftRestriction !== undefined)) return
      liftRestriction?.()
      liftRestriction = minimal ? tools.restrict({ deny: [ASK_USER_TOOL] }) : undefined
    }
    syncRestriction()
    const disposeSession = agent.ctx.on('session/event', (session) => {
      if (session === agent.session) syncRestriction()
    })
    agent.ctx.effect(() => () => {
      disposeSession()
      liftRestriction?.()
    })
  }
  const dispose = ctx.on('agent/created', ({ agent }) => { install(agent) })
  for (const agent of ctx.get('agents')?.list() ?? []) install(agent)
  return dispose
}

/** The composition inputs for `agents.create`/`agents.resume`. */
export interface PresetComposition {
  /** Value for the durable header's `meta.agentPreset`; absent without a roster. */
  readonly agentPreset?: string
  /** Factory setup hook mounting the preset onto the unpublished agent. */
  readonly setup?: AgentSetup
}

/**
 * Resolve the preset one new/resumed session will run under and the setup
 * that installs it. `requested` undefined adopts the roster default.
 *
 * Resolution failures (unknown/broken preset id, an empty roster that cannot
 * supply even the default) degrade to the rosterless composition with a loud
 * log line: a session that cannot start at all is worse than one running on
 * the host composition.
 *
 * @param ctx - The plugin context (roster lookup + logging).
 * @param requested - The preset id the caller wants, or undefined for the default.
 * @returns The header value + setup hook, or an empty composition.
 */
export async function composePreset(ctx: Context, requested?: string): Promise<PresetComposition> {
  const presets = rosterOf(ctx)
  if (presets === undefined) return {}
  let resolvedId: string
  try {
    resolvedId = (await presets.resolve(requested)).id
  } catch (error) {
    ctx.logger.warn(
      `dsh-cli: agent preset ${requested === undefined ? '(default)' : `"${requested}"`} unavailable ` +
        `(${error instanceof Error ? error.message : String(error)}) — composing the session without a preset`,
    )
    return {}
  }
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx: Context) => {
      await presets.mount(agentCtx, resolvedId)
    },
  }
}

/**
 * The preset a PERSISTED session actually runs, read from its log: the last
 * `agent-preset/selected` event wins over the creation header (a blank
 * session may have switched). undefined when the log records none (sessions
 * from before presets existed → the roster default applies at mount).
 *
 * @param ctx - The plugin context (persistence lookup).
 * @param sessionId - The persisted session to inspect.
 * @returns The running preset id, or undefined when unrecorded/unreadable.
 */
export async function resolvePersistedPreset(ctx: Context, sessionId: SessionId): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionReader | undefined
  if (persistence === undefined) return undefined
  try {
    const { meta, events } = await readPersistedSession(persistence, sessionId)
    return resolveRecordedPreset({ header: meta, events })
  } catch {
    // A missing/corrupt artifact leaves resume itself to report the failure;
    // the preset lookup must not mask it with a second, misleading error.
    return undefined
  }
}

/**
 * The preset a LIVE session runs, resolved from its own log (last
 * `agent-preset/selected` wins over the header). Used for fork-style creates
 * (rewind/model switch) and for reading an already-live agent's composition.
 *
 * @param session - The live session.
 * @returns The running preset id, or undefined when the log records none.
 */
export function runningPresetOf(session: unknown): string | undefined {
  const header = (session as { header?: { agentPreset?: string } }).header ?? {}
  return resolveRecordedPreset({ header, events: snapshotLiveSessionEvents(session) })
}

/**
 * The route a PERSISTED session actually ran, read from its log: the last
 * `request/header` snapshot. undefined when the log records none (a session
 * that never started a turn) or the artifact is unreadable.
 *
 * Resume feeds this back into `agents.resume({ agentOptions })` so the
 * resumed agent's `options.model` is populated again — a cordis.yml that
 * pins only `provider` (issue #67: a half-pin never merges) leaves
 * agentOptions.model undefined, which breaks the `{{model}}` persona variable
 * for the resumed agent's own assembly AND for every subagent it spawns
 * (dsh-subagent's `resolveChildAgentOptions` inherits `parent.options.model`).
 *
 * @param ctx - The plugin context (persistence lookup).
 * @param sessionId - The persisted session to inspect.
 * @returns The recorded model route, or undefined when unrecorded/unreadable.
 */
export async function resolvePersistedRoute(ctx: Context, sessionId: SessionId): Promise<ModelRoute | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionReader | undefined
  if (persistence === undefined) return undefined
  try {
    const { events } = await readPersistedSession(persistence, sessionId)
    return recordedModelRoute(events)
  } catch {
    // A missing/corrupt artifact leaves resume itself to report the failure;
    // the route lookup must not mask it with a second, misleading error.
    return undefined
  }
}

/**
 * Read a service the way a joined agent sees it: through the preset scope
 * chain when a roster is mounted (preset realms hide e.g. `compaction` from
 * the root context), falling back to the host context otherwise. Mirrors the
 * official host's `agentPresets.serviceFor(agent, key) ?? ctx.get(key)`.
 *
 * @param ctx - The plugin context (roster + host fallback).
 * @param agent - The live agent whose scope chain resolves first.
 * @param key - The cordis service key.
 * @returns The service instance, or undefined when neither layer provides it.
 */
export function serviceForAgent<T>(ctx: Context, agent: { ctx: Context }, key: string, options?: { hostFallback: 'visible' }): T | undefined {
  const presets = rosterOf(ctx)
  const scoped = presets?.serviceFor?.(agent, key)
  if (scoped !== undefined) return scoped as T
  // Authority-sensitive consumers may only fall back to a host service that
  // the requesting Agent's own context can resolve. Missing realm services
  // never borrow a root-only provider or filesystem capability.
  if (options?.hostFallback === 'visible') return agent.ctx.get(key) as T | undefined
  return ctx.get(key) as T | undefined
}
