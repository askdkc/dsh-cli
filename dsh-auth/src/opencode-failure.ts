/** Provider-owned codes carried across both old and current DSH normalizers. */
import { LlmError, ProviderRequestId, type LlmFailure, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'

export type OpenCodeFailureCode = 'MODEL_NOT_FOUND' | 'UNSUPPORTED_CAPABILITY' | 'PROTOCOL_ERROR' | 'PROVIDER_ERROR' | 'ATTACHMENT_UNAVAILABLE'

export class OpenCodeFailure extends Error {
  readonly failure: LlmFailure
  constructor(message: string, readonly code: OpenCodeFailureCode, facts: LlmErrorOptions = {}) {
    super(message)
    this.name = 'OpenCodeFailure'
    // Use the common constructor only to validate metadata, never to rename the
    // provider code. Older DSH has no LlmError.fromFailure().
    const validated = new LlmError(message, 'UNKNOWN', facts).failure
    this.failure = Object.freeze({ ...validated, code })
    Object.freeze(this)
  }
}

/** Read SDK data without invoking foreign accessors or retaining its cause/body. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}

/** Map only validated HTTP diagnostics; all messages are owned by this adapter. */
export function openCodeRequestFailure(error: unknown, credential: string): LlmError | OpenCodeFailure {
  const rawStatus = own(error, 'statusCode')
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const headers = own(error, 'responseHeaders')
  const retryHeader = own(headers, 'retry-after')
  const seconds = typeof retryHeader === 'string' && retryHeader.trim() ? Number(retryHeader) : NaN
  const delay = typeof retryHeader === 'string' ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now() : NaN
  const rawId = own(headers, 'x-request-id') ?? own(headers, 'request-id')
  const requestId = typeof rawId === 'string' && /^[A-Za-z0-9._:/-]{1,256}$/.test(rawId) && !rawId.includes(credential) ? ProviderRequestId(rawId) : undefined
  const facts = {
    ...(status === undefined ? {} : { status }),
    ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
    ...(requestId === undefined ? {} : { requestId }),
  }
  const message = `OpenCode request failed${status === undefined ? '' : `: HTTP ${status}`}`
  if (status !== undefined && status !== 401 && status !== 403 && status !== 429 && status < 500) return new OpenCodeFailure(message, 'PROVIDER_ERROR', facts)
  return new LlmError(message, status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status !== undefined ? 'SERVER' : 'TRANSPORT', facts)
}
