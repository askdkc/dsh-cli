/** Bind the optional provider to the foreground Agent, never the launch cwd. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { CODE_SERVICE_KEY } from '../code-intelligence-validation.js'
import { concreteService } from '../host-access.js'
import { runningPresetOf, serviceForAgent } from '../presets.js'
import { resolveSessionCwd } from '../../utils/workspaceRoot.js'
import { CodeFailure, createCodeIntelligenceConsumer } from './code-intelligence.js'
import type { ChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'

function checkoutIdentity(cwd: string): string {
  const stat = statSync(cwd)
  const root = resolveSessionCwd(undefined, cwd)
  const marker = join(root, '.git')
  if (!existsSync(marker)) return `${stat.dev}:${stat.ino}`
  let git = marker
  try {
    if (statSync(marker).isFile()) {
      const pointer = readFileSync(marker, 'utf8').trim()
      if (!pointer.startsWith('gitdir: ')) throw new Error('invalid_gitdir')
      git = resolve(root, pointer.slice(8))
    }
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim()
    const common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git
    const ref = head.startsWith('ref: ') ? head.slice(5) : undefined
    let revision = ''
    if (ref && /^refs\/heads\/(?!.*(?:\.\.|\\))[\w./-]+$/u.test(ref)) {
      try { revision = readFileSync(join(common, ref), 'utf8').trim() }
      catch { try { const packed = statSync(join(common, 'packed-refs')); revision = `${packed.mtimeMs}:${packed.size}` } catch { /* unborn branch */ } }
    }
    return `${stat.dev}:${stat.ino}:${git}:${head}:${revision}`
  } catch {
    throw new CodeFailure('unavailable', 'checkout_identity_unavailable')
  }
}
function identity(value: unknown): unknown { return typeof value === 'object' && value !== null ? concreteService(value) : value }

export function createChannelCodeIntelligence(ctx: Context, deps: {
  owner: ChannelOwner
  binding: ChannelBinding
  displayCwd(): string
  emit(): void
}) {
  const disposedAgents = new WeakSet<Agent>()
  const discover = () => {
    const loader = ctx.get('loader') as { entries(): Iterable<{ disabled: boolean; options: { name?: string } }> } | undefined
    const rows = [...(loader?.entries() ?? [])].filter(row => !row.disabled && row.options.name === '@askdkc/dsh-lsp-server/provider')
    if (rows.length > 1) throw new CodeFailure('unavailable', 'duplicate_provider')
    const agent = deps.binding.agent
    const service = serviceForAgent<unknown>(ctx, agent, CODE_SERVICE_KEY, { hostFallback: 'visible' })
    return identity(service)
  }
  const capture = () => {
    const capture = deps.binding.capture()
    const agent: Agent = capture.agent
    if (disposedAgents.has(agent)) throw new CodeFailure('unavailable', 'agent_disposed')
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(deps.displayCwd()) && !deps.displayCwd().startsWith('file://')) throw new CodeFailure('unavailable', 'workspace_backend_unsupported')
    let root: string
    try { root = realpathSync(cwd) } catch { throw new CodeFailure('unavailable', 'workspace_unavailable') }
    const checkout = checkoutIdentity(root)
    const preset = runningPresetOf(agent.session)
    const context = { get: (name: string) => serviceForAgent<unknown>(ctx, agent, name, { hostFallback: 'visible' }) }
    const fs = identity(context.get('fs'))
    const subprocess = identity(context.get('subprocess'))
    if (!fs || !subprocess) throw new CodeFailure('unavailable', 'host_scope_unavailable')
    return {
      owner: { agentId: String(agent.id), sessionId: String(agent.session.id) },
      workspaceRoot: root, scope: agent.ctx, context,
      assertCurrent() {
        if (!deps.owner.current() || !deps.binding.isCurrent(capture) || agent.session.header.cwd !== cwd || runningPresetOf(agent.session) !== preset || realpathSync(cwd) !== root || checkoutIdentity(root) !== checkout || identity(context.get('fs')) !== fs || identity(context.get('subprocess')) !== subprocess) throw new CodeFailure('stale', 'binding_changed')
      },
    }
  }
  const consumer = createCodeIntelligenceConsumer({ discover, capture, signal: deps.owner.signal, publish: () => { if (deps.owner.current()) deps.emit() } })
  deps.owner.own(consumer.cancel)
  deps.owner.own(ctx.on('agent/disposed', ({ agent }) => {
    disposedAgents.add(agent)
    if (agent === deps.binding.agent) consumer.cancel()
  }))
  const rebind = () => {
    consumer.cancel()
    deps.binding.subscribe(consumer.cancel)
    void consumer.capabilities()
  }
  deps.owner.own(ctx.on('tools/change', () => { if (deps.owner.current()) { consumer.cancel(); void consumer.capabilities() } }))
  const injection = typeof ctx.inject === 'function' ? ctx.inject([CODE_SERVICE_KEY], ready => {
    if (!deps.owner.current()) return
    consumer.cancel()
    void consumer.capabilities()
    ready.effect(() => () => { consumer.cancel(); if (deps.owner.current()) void consumer.capabilities() })
  }) : undefined
  if (injection) deps.owner.own(() => { void Promise.resolve(injection.dispose()).catch(error => ctx.logger.warn('dsh-cli: code provider subscription cleanup failed: %o', error)) })
  return { port: { get status() { return consumer.status }, capabilities: consumer.capabilities, analyze: consumer.analyze, cancel: consumer.cancel }, rebind, shutdown: consumer.dispose }
}
