import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { InputConvergence } from './input-actions.js'
import type { ChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { type createChannelProjection } from './projection.js'
import type { ChannelState } from './types.js'

/**
 * The binding event router is the sole subscriber for a foreground Agent.
 * It captures the binding generation at every listener entry; teardown is
 * incremental and retained callbacks check that captured Agent/session pair
 * before touching state. Transcript presentation remains exclusively owned by
 * ChannelProjection.
 */
export function createBindingEvents(ctx: Context, deps: {
  owner: ChannelOwner
  binding: ChannelBinding
  state: ChannelState
  /** Read the activity projection's current value for a freshly bound session.
   *  A projection value only arrives when it changes, so a resumed or
   *  reattached session needs this read to show its line before the next event.
   *  The line's semantics live in the working-activity plugin: this app folds
   *  nothing itself and forwards no events. */
  seedActivity?(session: unknown): void
  inputConvergence: InputConvergence
  modelActions: { applyPreferredEffort(): Promise<void> }
  modeActions: { refreshMode(): void; onSessionEvent(session: unknown, event: unknown): void }
  projector: ReturnType<typeof createChannelProjection>
  subagents: { onSessionEvent(session: unknown, event: unknown): boolean; onStreamFrame?(agent: unknown, frame: AssistantStreamFrame): boolean; onParentEvent?(event: unknown): void; onStart(info: { id: string; runId?: string; provider: string; local?: boolean }): void; onEnd(info: { id: string; runId?: string; stopReason: string; lastAssistantMessage?: unknown[] }): void }
  agentView: { schedule(): void }
  messageObserver?: { publish(session: unknown, event: unknown): void }
  /** Drop a pre-step attachment registered by this channel for one message id
   *  (input-delivery's `retireAttachment`); see the discard hook below.
   *  Optional for direct/embed constructors that never emit inbox discards;
   *  channel.ts always wires it. */
  retireAttachment?(messageId: string): void
}) {
  const reconcileRetiredProjection = (status: 'idle' | 'disposed'): void => {
    if (!deps.state.working) return
    ctx.logger.warn(`dsh-cli: agent became ${status} while the channel still projected an open turn; releasing volatile UI gates`)
    deps.inputConvergence.cancelInFlight = false
    deps.state.cancelPending = false
    deps.state.working = false
    deps.state.activeToolCount = 0
    deps.projector.settleStreaming()
    deps.projector.updateSpinnerMode()
  }

  let ready: Promise<void> = Promise.resolve()
  const bind = (): void => {
    try {
      deps.state.agentBindingGeneration = deps.binding.bind()
      deps.inputConvergence.cancelInFlight = false
      deps.inputConvergence.interruptSeq += 1
      deps.seedActivity?.(deps.binding.agent.session)
      const model = deps.binding.agent.model
      const selected = model?.current()
      if (model && deps.state.provider !== '' && deps.state.model !== '' &&
        (selected?.provider !== deps.state.provider || selected.model !== deps.state.model)) {
        model.select({ provider: deps.state.provider, model: deps.state.model })
      }
      ready = deps.modelActions.applyPreferredEffort()
      // Keep a rejected initialization observable to input delivery without an
      // unhandled rejection while the user has not submitted anything yet.
      void ready.catch(error => ctx.logger.warn(`dsh-cli: model selection failed: ${String(error)}`))
      deps.modeActions.refreshMode()
      const capture = deps.binding.capture()
      const session = capture.agent.session
      const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(capture)
      const register = <T extends () => void>(dispose: T): T => {
        deps.binding.subscribe(dispose)
        return dispose
      }
      const on = (...args: Parameters<typeof ctx.on>): ReturnType<typeof ctx.on> => register(ctx.on(...args))

      on('agent/status', ({ agent: subject, status }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = status
        if (status === 'idle') reconcileRetiredProjection('idle')
        deps.state.emit()
      })
      on('agent/disposed', ({ agent: subject }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = 'disposed'
        reconcileRetiredProjection('disposed')
        deps.state.emit()
      })
      /**
       * The inbox removed one message. Both events retire the pending
       * preview, but ONLY a discard retires an attached-context entry:
       * `agent/inbox/claimed` fires while the loop claims the batch, BEFORE
       * the resident `agent/pre-step` listener can append the attachment —
       * retiring there would delete the context before it is ever injected
       * (dsh-agent-loop: `inbox.claim()` → claimed event → `agent/pre-step`).
       */
      const retirePending = (payload: { agent: unknown; message: { id?: unknown } }, alsoRetireAttachment = false): void => {
        if (!current() || payload.agent !== capture.agent) return
        const messageId = payload.message?.id
        if (typeof messageId !== 'string') return
        if (alsoRetireAttachment) deps.retireAttachment?.(messageId)
        const before = deps.state.pending.length
        deps.state.pending = deps.state.pending.filter(item => item.id !== messageId)
        if (deps.state.pending.length !== before) deps.state.emit()
      }
      on('agent/inbox/claimed', retirePending)
      on('agent/inbox/discarded', payload => retirePending(payload, true))
      on('session/event', (subject, event) => {
        if (!current()) return
        const isMainSession = subject === session
        if (!isMainSession && deps.subagents.onSessionEvent(subject, event)) return
        if (!isMainSession) return
        deps.messageObserver?.publish(subject, event)
        // Parent-log discovery events (`subagent/catalog`, workflow member
        // edges) reach the dashboard through the same firehose; they are not
        // transcript rows and render below remains untouched by them.
        deps.subagents.onParentEvent?.(event)
        deps.modeActions.onSessionEvent(subject, event)
        deps.projector.renderEvent(event)
        deps.state.emit()
      })
      // Transient streaming and durable settlement have separate channels.
      on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (!current()) return
        if (subject !== capture.agent) {
          deps.subagents.onStreamFrame?.(subject, frame)
          return
        }
        deps.projector.renderStreamFrame(frame)
        if (frame.type === 'chunk') deps.state.emitStream()
        else if (frame.type === 'end') deps.state.emit()
      })
      on('subagent/start' as never, (info: { id: string; runId?: string; provider: string; local?: boolean }) => {
        if (current()) deps.subagents.onStart(info)
      })
      on('subagent/end' as never, (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }) => {
        if (current()) deps.subagents.onEnd(info)
      })
    } catch (error) {
      deps.owner.dispose()
      throw error
    }
  }
  return { bind, ready: () => ready }
}
