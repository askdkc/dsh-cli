import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BindingCapture } from './binding.js'
import type { KiokukoTaskPanelItem, KiokukoRunStatus, KiokukoTaskState, KiokukoTaskOperation, TodoPanelItem } from '../../adapter/ports/channel-view.js'

/** Optional host contract: the plugin alone reads/writes its SQLite ledger. */
interface TaskSnapshot {
  sessionId: string
  taskId: string
  runId: string
  state: KiokukoTaskState
  runStatus?: KiokukoRunStatus
  previousOutcome?: { status: KiokukoRunStatus }
  revision: number
  generation: number
  request: string | null
  reason: string | null
  evidence: string[]
  allowedOps: KiokukoTaskOperation[]
  pendingStop?: { operation: 'wait' | 'ignore'; reason: string }
}
interface TaskWorkflowService {
  snapshot(agent: Agent): Promise<{ sessionId: string; task: TaskSnapshot | null }>
  operate(agent: Agent, input: {
    operation: 'wait'
    expected: { taskId: string; revision: number; generation: number }
    reason: string
  }, signal: AbortSignal): Promise<unknown>
  handoff?(source: Agent, target: Agent, expected: { taskId: string; revision: number; generation: number }, signal: AbortSignal): Promise<unknown>
}
const taskStates: readonly string[] = ['ToDo', 'Working', 'Pending', 'Done', 'Ignore']
const runStatuses: readonly string[] = ['intake', 'active', 'completed', 'failed', 'cancelled', 'interrupted']
const taskOperations: readonly string[] = ['start', 'wait', 'resume', 'complete', 'ignore']
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
function service(value: unknown): value is TaskWorkflowService {
  return object(value) && typeof value.snapshot === 'function' && typeof value.operate === 'function'
}
function snapshot(value: unknown, sessionId: string): value is { sessionId: string; task: TaskSnapshot | null } {
  if (!object(value) || value.sessionId !== sessionId) return false
  const task = value.task
  return task === null || (object(task) && task.sessionId === sessionId
    && typeof task.taskId === 'string' && task.taskId.length > 0 && task.runId === task.taskId
    && taskStates.includes(String(task.state))
    && (task.runStatus === undefined || runStatuses.includes(String(task.runStatus)))
    && (task.previousOutcome === undefined || (object(task.previousOutcome) && runStatuses.includes(String(task.previousOutcome.status))))
    && Number.isSafeInteger(task.revision) && Number(task.revision) > 0
    && Number.isSafeInteger(task.generation) && Number(task.generation) > 0
    && (task.request === null || typeof task.request === 'string')
    && (task.reason === null || typeof task.reason === 'string')
    && Array.isArray(task.evidence) && task.evidence.every(item => typeof item === 'string')
    && (task.pendingStop === undefined || (object(task.pendingStop)
      && ['wait', 'ignore'].includes(String(task.pendingStop.operation)) && typeof task.pendingStop.reason === 'string'))
    && Array.isArray(task.allowedOps) && task.allowedOps.every(item => typeof item === 'string' && taskOperations.includes(item)))
}

/** One volatile read projection, fenced by agent identity, binding and revision. */
export function createTaskWorkflowProjection(deps: {
  discover(): unknown
  capture(): BindingCapture
  current(capture: BindingCapture): boolean
  rows(): readonly TodoPanelItem[]
  publish(rows: TodoPanelItem[]): void
  warn(message: string): void
}) {
  let disposed = false
  let readId = 0
  let controller = new AbortController()
  let inputHold: {
    agent: Agent
    pending: Promise<void>
    release(): void
    settled: boolean
    error?: string
  } | undefined
  const clear = (): void => {
    const legacy = deps.rows().filter(row => row.source !== 'kiokuko')
    if (legacy.length !== deps.rows().length) deps.publish(legacy)
  }
  const refresh = async (): Promise<void> => {
    const id = ++readId
    const capture = deps.capture()
    const host = deps.discover()
    if (disposed || !deps.current(capture)) return
    if (!service(host)) { clear(); return }
    const current = (): boolean => !disposed && id === readId && deps.current(capture) && deps.discover() === host
    try {
      const value: unknown = await host.snapshot(capture.agent)
      if (!current()) return
      if (!snapshot(value, String(capture.agent.session.id))) throw new Error('invalid task snapshot')
      if (value.task === null) { clear(); return }
      const task = value.task
      // A successful explicit task operation can recover a failed handoff.
      // Only a canonical task now owned by this exact target opens its input.
      if (inputHold?.agent === capture.agent && inputHold.settled && inputHold.error) inputHold = undefined
      const previous = deps.rows().find(row => row.source === 'kiokuko')
      if (previous?.source === 'kiokuko' && previous.taskId === task.taskId && previous.revision > task.revision) return
      const row: KiokukoTaskPanelItem = {
        source: 'kiokuko', content: task.request ?? task.taskId, status: task.state,
        ...(task.runStatus === undefined ? {} : { runStatus: task.runStatus }),
        ...(task.previousOutcome === undefined ? {} : { previousOutcome: { status: task.previousOutcome.status } }),
        taskId: task.taskId, runId: task.runId, revision: task.revision, generation: task.generation,
        reason: task.reason, evidence: [...task.evidence], allowedOps: [...task.allowedOps],
        ...(task.pendingStop ? { pendingStop: { operation: task.pendingStop.operation, reason: task.pendingStop.reason } } : {}),
      }
      deps.publish([row, ...deps.rows().filter(item => item.source !== 'kiokuko')])
    } catch (error) {
      if (current()) {
        clear()
        deps.warn(`Kiokuko task snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return {
    refresh,
    holdInput(target: Agent): (error?: unknown) => void {
      inputHold?.release()
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const hold = { agent: target, pending, release, settled: false, error: undefined as string | undefined }
      inputHold = hold
      return error => {
        if (hold.settled) return
        hold.settled = true
        hold.error = error === undefined ? undefined : `Kiokuko task handoff failed: ${error instanceof Error ? error.message : String(error)}. Use /kioku-task status or create a new task before sending.`
        hold.release()
        if (inputHold === hold && hold.error === undefined) inputHold = undefined
      }
    },
    async waitForInput(agent: Agent): Promise<void> {
      const hold = inputHold
      if (hold?.agent !== agent) return
      await hold.pending
      if (hold.error && inputHold === hold) throw new Error(hold.error)
    },
    async prepareHandoff(): Promise<((target: Agent) => Promise<void>) | undefined> {
      const source = deps.capture()
      const host = deps.discover()
      if (!service(host)) return undefined
      const value: unknown = await host.snapshot(source.agent)
      if (disposed || !deps.current(source) || deps.discover() !== host) throw new Error('Task owner changed before model switch')
      if (!snapshot(value, String(source.agent.session.id))) throw new Error('Invalid task snapshot before model switch')
      if (value.task === null) return undefined
      if (typeof host.handoff !== 'function') throw new Error('Kiokuko task handoff is unavailable')
      const expected = { taskId: value.task.taskId, revision: value.task.revision, generation: value.task.generation }
      return async target => {
        const targetBinding = deps.capture()
        const signal = controller.signal
        if (disposed || signal.aborted || targetBinding.agent !== target || !deps.current(targetBinding) || deps.discover() !== host) {
          throw new Error('Task target changed during model switch')
        }
        try {
          await host.handoff!(source.agent, target, expected, signal)
        } finally {
          if (!signal.aborted && deps.current(targetBinding) && deps.discover() === host) await refresh()
        }
      }
    },
    rebind(): void {
      controller.abort()
      controller = new AbortController()
      readId++
      if (inputHold && inputHold.agent !== deps.capture().agent) {
        inputHold.release()
        inputHold = undefined
      }
      clear()
      void refresh()
    },
    changed(event: unknown): void {
      if (disposed || !object(event) || event.sessionId !== String(deps.capture().agent.session.id)) return
      // A commit notification is only an invalidation. Always read the ledger.
      void refresh()
    },
    cancelled(): void {
      const capture = deps.capture()
      const host = deps.discover()
      const task = deps.rows().find(row => row.source === 'kiokuko')
      if (disposed || !deps.current(capture) || !service(host)) return
      if (task?.source === 'kiokuko' && !task.allowedOps.includes('wait')) return
      const signal = controller.signal
      // Native cancel has already been requested. The host must confirm the
      // stop and CAS this exact displayed task before it can commit Pending.
      void Promise.resolve().then(async () => {
        if (signal.aborted || !deps.current(capture) || deps.discover() !== host) return
        let selected = task?.source === 'kiokuko' ? task : undefined
        // Cancellation can arrive before the initial projection read finishes.
        // Pin a canonical snapshot rather than silently losing that interrupt.
        if (selected === undefined) {
          const value: unknown = await host.snapshot(capture.agent)
          if (signal.aborted || !deps.current(capture) || deps.discover() !== host) return
          if (!snapshot(value, String(capture.agent.session.id))) throw new Error('Invalid task snapshot during cancellation')
          if (value.task === null || !value.task.allowedOps.includes('wait')) return
          const { taskId, revision, generation } = value.task
          return host.operate(capture.agent, { operation: 'wait', expected: { taskId, revision, generation }, reason: 'Interrupted in the CLI' }, signal)
        }
        const expected = { taskId: selected.taskId, revision: selected.revision, generation: selected.generation }
        return host.operate(capture.agent, { operation: 'wait', expected, reason: 'Interrupted in the CLI' }, signal)
      })
        .catch(error => {
          if (!signal.aborted && deps.current(capture) && deps.discover() === host) {
            deps.warn(`Kiokuko task interruption was not committed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }).finally(() => {
          if (!signal.aborted && deps.current(capture) && deps.discover() === host) void refresh()
        })
    },
    dispose(): void {
      disposed = true
      readId++
      controller.abort()
      inputHold?.release()
      inputHold = undefined
    },
  }
}
