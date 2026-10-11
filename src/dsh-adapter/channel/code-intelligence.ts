/** One lease per bounded read; authority is captured by the trusted host. */
import type { CodeHostBindingV1, CodeLeaseV1, CodeRequestV1, CodeResponseV1, CodeStatus } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
import type { CodeAnalysisRequest, CodeAnalysisView, CodeCapabilityView, CodeIntelligencePort } from '../../adapter/ports/code-intelligence.js'
import { CODE_SERVICE_KEY, codeAnalysisRequest, codeCapabilities, codeDisplayData, codeResponse, codeResultData, codeService, record } from '../code-intelligence-validation.js'

export class CodeFailure extends Error {
  constructor(readonly status: CodeStatus, readonly reason: string) { super(reason) }
}
/** Bound even if a broken provider ignores AbortSignal. */
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Code analysis deadline', 'TimeoutError')), ms)
  try { return await bounded(work(controller.signal), controller.signal) }
  finally { clearTimeout(timer) }
}
function failure(error: unknown, signal?: AbortSignal): { status: CodeStatus; reason: string } {
  if (signal?.aborted) return { status: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', reason: signal.reason?.name === 'TimeoutError' ? 'caller_deadline' : 'caller_cancelled' }
  return error instanceof CodeFailure ? { status: error.status, reason: error.reason } : { status: 'unavailable', reason: 'provider_operation_failed' }
}

export function createCodeIntelligenceConsumer(deps: {
  discover(): unknown
  capture(): CodeHostBindingV1
  signal: AbortSignal
  timeoutMs?: number
  publish?(view: CodeCapabilityView): void
}): CodeIntelligencePort & { cancel(): void; dispose(): Promise<void> } {
  const requests = new Set<AbortController>()
  const disposals = new WeakMap<object, Promise<void>>()
  const lifetime = new AbortController()
  let view: CodeCapabilityView = { provider: CODE_SERVICE_KEY, status: 'unavailable', reason: 'not_checked', languages: [] }
  let refreshId = 0
  let disposal: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const close = (lease: CodeLeaseV1): Promise<void> => {
    if (!record(lease) || typeof lease.dispose !== 'function') return Promise.reject(new CodeFailure('unavailable', 'schema_mismatch'))
    let closing = disposals.get(lease)
    if (closing === undefined) {
      closing = deadline(() => Promise.resolve().then(() => lease.dispose()), 500)
      disposals.set(lease, closing)
    }
    return closing
  }
  const operation = async <T>(caller: AbortSignal | undefined, execute: (lease: CodeLeaseV1, signal: AbortSignal, binding: CodeHostBindingV1, current: () => Promise<void>) => Promise<T>): Promise<{ value?: T; status?: CodeStatus; reason?: string; cleanupReason?: string }> => {
    const controller = new AbortController()
    requests.add(controller)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException('Code analysis deadline', 'TimeoutError')), deps.timeoutMs ?? 30_000)
    const signal = AbortSignal.any([deps.signal, lifetime.signal, controller.signal, timeout.signal, ...(caller ? [caller] : [])])
    let lease: CodeLeaseV1 | undefined
    const outcome: { value?: T; status?: CodeStatus; reason?: string; cleanupReason?: string } = {}
    try {
      signal.throwIfAborted()
      const provider = deps.discover()
      if (provider === undefined) throw new CodeFailure('unavailable', 'provider_absent')
      if (!codeService(provider)) throw new CodeFailure('unavailable', 'schema_mismatch')
      const binding = deps.capture()
      const current = async () => {
        if (deps.discover() !== provider) throw new CodeFailure('stale', 'provider_changed')
        try { await binding.assertCurrent() } catch { throw new CodeFailure('stale', 'binding_changed') }
        signal.throwIfAborted()
      }
      await current()
      const acquiring = Promise.resolve(provider.bind(binding, signal))
      // A bind that ignores cancellation still returns an owned resource.
      void acquiring.then(acquired => { if (signal.aborted) void close(acquired).catch(() => undefined) }, () => undefined)
      lease = await bounded(acquiring, signal)
      if (!lease || typeof lease.request !== 'function' || typeof lease.dispose !== 'function') throw new CodeFailure('unavailable', 'schema_mismatch')
      await current()
      outcome.value = await execute(lease, signal, binding, current)
      await current()
    } catch (error) { Object.assign(outcome, failure(error, signal)) }
    finally {
      requests.delete(controller)
      if (lease) {
        try { await close(lease) } catch { outcome.cleanupReason = 'lease_cleanup_failed' }
      }
      clearTimeout(timer)
    }
    return outcome
  }
  const request = async (lease: CodeLeaseV1, input: CodeRequestV1, signal: AbortSignal): Promise<CodeResponseV1> => {
    const response = await bounded(lease.request(input, signal), signal)
    if (!codeResponse(response) || (response.status === 'ok' || response.status === 'partial') && !codeResultData(input.method, response.data, input.method === 'semantic.query' ? input.kind : undefined)) throw new CodeFailure('unavailable', 'invalid_result')
    return response
  }
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  const capabilities = (caller?: AbortSignal): Promise<CodeCapabilityView> => track((async () => {
    const id = ++refreshId
    const result = await operation(caller, async (lease, signal, binding) => {
      const response = await request(lease, { method: 'capabilities' }, signal)
      if (response.status !== 'ok' && response.status !== 'partial') throw new CodeFailure(response.status, response.reason ?? 'capabilities_unavailable')
      if (!codeCapabilities(response.data)) throw new CodeFailure('unavailable', 'invalid_result')
      const data = structuredClone(response.data)
      return { provider: CODE_SERVICE_KEY, schema: 1 as const, workspace: binding.workspaceRoot, status: response.status, reason: response.reason, languages: data.languageCapabilities, capabilities: data }
    })
    const next: CodeCapabilityView = result.value && !result.cleanupReason ? result.value : { provider: CODE_SERVICE_KEY, status: result.status ?? 'unavailable', reason: result.reason ?? result.cleanupReason, languages: [] }
    if (id === refreshId) { view = next; deps.publish?.(view) }
    return next
  })())

  const analyze = (input: CodeAnalysisRequest, caller?: AbortSignal): Promise<CodeAnalysisView> => track((async () => {
    const candidate: unknown = input
    if (!codeAnalysisRequest(candidate)) return { path: record(candidate) && typeof candidate.path === 'string' ? candidate.path : '', status: 'unsupported', reason: 'invalid_request', results: [] }
    const original = structuredClone(input)
    const results: CodeResponseV1[] = []
    let cleanupReason: string | undefined
    const result = await operation(caller, async (lease, signal, _binding, current) => {
      let handle: string | undefined
      try {
        const available = await request(lease, { method: 'capabilities' }, signal)
        if (available.status !== 'ok' && available.status !== 'partial') throw new CodeFailure(available.status, available.reason ?? 'capabilities_unavailable')
        const opened = await request(lease, { method: 'snapshot.open', path: original.path }, signal)
        if (opened.status !== 'ok' && opened.status !== 'partial') throw new CodeFailure(opened.status, opened.reason ?? 'snapshot_unavailable')
        handle = (opened.data as { handle: string }).handle
        const version = opened.snapshotVersion
        if (!version) throw new CodeFailure('unavailable', 'snapshot_version_missing')
        const add = async (input: CodeRequestV1) => {
          await current()
          const response = await request(lease, input, signal)
          await current()
          if ((response.status === 'ok' || response.status === 'partial') && response.snapshotVersion !== version) throw new CodeFailure('stale', 'snapshot_version_changed')
          results.push({ ...response, data: codeDisplayData(response.data) })
          if (response.status !== 'ok' && response.status !== 'partial') throw new CodeFailure(response.status, response.reason ?? 'query_failed')
          return response
        }
        if (original.structure) await add({ ...original.structure, handle })
        if (original.semantic) await add({ method: 'semantic.query', ...original.semantic, handle })
        if (original.span) {
          const enclosed = await add({ method: 'structure.enclosing', handle, position: original.span.position })
          const nodes = record(enclosed.data) && Array.isArray(enclosed.data.items) ? enclosed.data.items : []
          const node = nodes[0]
          if (record(node) && typeof node.handle === 'string') await add({ method: 'structure.span', nodeHandle: node.handle, maxChars: original.span.maxChars })
        }
      } finally {
        if (handle) {
          try {
            const released = await deadline(signal => request(lease, { method: 'snapshot.release', handle: handle! }, signal), 500)
            if (released.status !== 'ok') throw new Error('release_failed')
          } catch { cleanupReason = 'snapshot_cleanup_failed' }
        }
      }
    })
    // Revoked results are never returned to the replacement foreground view.
    const visible = result.status === 'stale' || result.status === 'cancelled' || result.status === 'timeout' ? [] : results
    cleanupReason ??= result.cleanupReason
    return { path: original.path, status: result.status ?? (cleanupReason ? 'unavailable' : visible.some(item => item.status === 'partial') ? 'partial' : 'ok'), reason: result.reason ?? cleanupReason, cleanupReason, results: visible }
  })())
  const cancel = () => {
    for (const request of requests) request.abort()
    refreshId++
    view = { provider: CODE_SERVICE_KEY, status: 'cancelled', reason: 'refresh_required', languages: [] }
    deps.publish?.(view)
  }
  return {
    get status() { return view }, capabilities, analyze, cancel,
    dispose() {
      if (disposal) return disposal
      lifetime.abort()
      cancel()
      disposal = deadline(() => Promise.allSettled([...pending]).then(() => undefined), 1200)
      return disposal
    },
  }
}
