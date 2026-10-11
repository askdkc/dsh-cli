/** Validate the public V1 boundary, before retaining or displaying provider data. */
import type { CodeCapabilitiesV1, CodeIntelligenceServiceV1, CodeResponseV1 } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
import type { CodeAnalysisRequest } from '../adapter/ports/code-intelligence.js'

export const CODE_SERVICE_KEY = 'codeIntelligence'
export const CODE_RESPONSE_BYTES = 32 * 1024
export const CODE_SEMANTIC_KINDS = ['definition', 'references', 'implementation', 'hover', 'diagnostics', 'completion'] as const
const STATUSES = ['ok', 'partial', 'unsupported', 'unavailable', 'stale', 'cancelled', 'timeout', 'limit_exceeded']
const QUERIES = ['declarations', 'calls', 'imports']
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const list = (value: unknown, allowed: readonly string[]) => Array.isArray(value) && value.length <= allowed.length && value.every(item => typeof item === 'string' && allowed.includes(item)) && new Set(value).size === value.length
export const codePosition = (value: unknown): boolean => record(value) && keys(value, ['line', 'character']) && integer(value.line) && integer(value.character)
export function codeRange(value: unknown): boolean {
  if (!record(value) || !record(value.start) || !record(value.end) || !codePosition(value.start) || !codePosition(value.end)) return false
  return (value.end.line as number) > (value.start.line as number) || value.end.line === value.start.line && (value.end.character as number) >= (value.start.character as number)
}
export function codeService(value: unknown): value is CodeIntelligenceServiceV1 {
  return record(value) && value.version === 1 && list(value.capabilities, ['snapshots', 'structure', 'semantic']) && (value.capabilities as string[]).includes('snapshots') && typeof value.bind === 'function'
}
export function codeCapabilities(value: unknown): value is CodeCapabilitiesV1 {
  if (!record(value) || value.version !== 1 || !list(value.capabilities, ['snapshots', 'structure', 'semantic']) || !list(value.queryIds, QUERIES) || typeof value.semanticReady !== 'boolean' || !Array.isArray(value.sourceKinds) || value.sourceKinds.length !== 1 || value.sourceKinds[0] !== 'disk') return false
  if (!Array.isArray(value.languages) || value.languages.length > 64 || !value.languages.every(item => text(item, 100)) || !Array.isArray(value.languageCapabilities) || value.languageCapabilities.length > 64) return false
  if (!value.languageCapabilities.every(item => record(item) && text(item.language, 100) && typeof item.structure === 'boolean' && typeof item.semanticReady === 'boolean' && list(item.semantic, CODE_SEMANTIC_KINDS) && (item.reason === undefined || text(item.reason)))) return false
  const limits = value.limits
  return record(limits) && ['documentBytes', 'captureItems', 'outlineItems', 'spanChars', 'responseBytes', 'files', 'inputBytes', 'outputBytes', 'calls', 'batchMs', 'structureMs', 'semanticMs'].every(key => integer(limits[key], 1))
}
export function codeResponse(value: unknown): value is CodeResponseV1 {
  if (!record(value) || value.protocol !== 'code-intelligence/v1' || !STATUSES.includes(String(value.status)) || value.sourceKind !== 'disk' || !['pinned', 'current', 'unknown', 'stale'].includes(String(value.freshness)) || typeof value.truncated !== 'boolean' || !integer(value.omitted)) return false
  if (value.reason !== undefined && !text(value.reason) || value.snapshotVersion !== undefined && !text(value.snapshotVersion) || value.inputBytes !== undefined && !integer(value.inputBytes)) return false
  try { return Buffer.byteLength(JSON.stringify(value)) <= CODE_RESPONSE_BYTES } catch { return false }
}
export function codeAnalysisRequest(value: unknown): value is CodeAnalysisRequest {
  if (!record(value) || !keys(value, ['path', 'structure', 'semantic', 'span']) || !text(value.path) || !(value.structure || value.semantic || value.span)) return false
  if (value.structure !== undefined) {
    const s = value.structure
    if (!record(s) || !keys(s, ['method', 'range', 'limit', 'position', 'kinds', 'queryId'])) return false
    if (s.range !== undefined && !codeRange(s.range) || s.limit !== undefined && !integer(s.limit, 1, s.method === 'structure.outline' ? 100 : 200)) return false
    if (s.method === 'structure.outline') { if (!keys(s, ['method', 'range', 'limit'])) return false }
    else if (s.method === 'structure.query') { if (!keys(s, ['method', 'range', 'limit', 'queryId']) || !QUERIES.includes(String(s.queryId))) return false }
    else if (s.method === 'structure.enclosing') { if (!keys(s, ['method', 'position', 'kinds']) || !codePosition(s.position) || s.kinds !== undefined && (!Array.isArray(s.kinds) || s.kinds.length > 30 || !s.kinds.every(kind => text(kind, 100)))) return false }
    else return false
  }
  if (value.semantic !== undefined) {
    const s = value.semantic
    if (!record(s) || !keys(s, ['kind', 'position', 'limit']) || !(CODE_SEMANTIC_KINDS as readonly string[]).includes(String(s.kind)) || s.kind !== 'diagnostics' && !codePosition(s.position) || s.position !== undefined && !codePosition(s.position) || s.limit !== undefined && !integer(s.limit, 1, 200)) return false
  }
  if (value.span !== undefined && (!record(value.span) || !keys(value.span, ['position', 'maxChars']) || !codePosition(value.span.position) || value.span.maxChars !== undefined && !integer(value.span.maxChars, 1, 8000))) return false
  return true
}

/** Validate successful method data; an empty failure never becomes success. */
export function codeResultData(method: string, data: unknown, semanticKind?: string): boolean {
  if (method === 'capabilities') return codeCapabilities(data)
  if (!record(data)) return false
  if (method === 'snapshot.open') return text(data.handle, 256) && text(data.path) && text(data.language, 100)
  if (method === 'snapshot.release') return typeof data.released === 'boolean'
  if (method === 'structure.span') return typeof data.text === 'string' && data.text.length <= 8000 && codeRange(data.range)
  if (semanticKind === 'hover') return data.hover === null || record(data.hover) && typeof data.hover.contents === 'string' && (data.hover.range === undefined || codeRange(data.hover.range))
  if (!Array.isArray(data.items) || data.items.length > 200) return false
  return data.items.every(item => {
    if (!record(item)) return false
    if (semanticKind === 'completion') return typeof item.label === 'string' && ['detail', 'documentation', 'insertText'].every(key => item[key] === undefined || typeof item[key] === 'string')
    if (semanticKind === 'diagnostics') return text(item.uri) && codeRange(item.range) && typeof item.message === 'string'
    if (semanticKind !== undefined) return text(item.uri) && codeRange(item.range)
    return text(item.handle, 256) && text(item.kind, 100) && codeRange(item.range) && (item.name === undefined || typeof item.name === 'string')
  })
}

/** Strip capabilities and executable edit payloads from display data. */
export function codeDisplayData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(codeDisplayData)
  if (!record(value)) return value
  const allowed = ['path', 'language', 'parseErrors', 'items', 'kind', 'range', 'start', 'end', 'line', 'character', 'name', 'uri', 'message', 'severity', 'label', 'detail', 'documentation', 'insertText', 'hover', 'contents', 'text', 'queryId', 'released']
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key)).map(([key, item]) => [key, codeDisplayData(item)]))
}
