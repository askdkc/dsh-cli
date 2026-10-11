/** Bounded, passive presentation shared by live results and transcript replay. */
import type { ToolResultView } from '../adapter/ports/channel-view.js'
import type { CodeAnalysisView, CodeCapabilityView } from '../adapter/ports/code-intelligence.js'
import { cleanRenderText } from './sanitize.js'
import { CODE_RESPONSE_BYTES, codeDisplayData, codeResponse, record } from './code-intelligence-validation.js'

export function boundedCodeText(value: string, bytes = CODE_RESPONSE_BYTES): string {
  // Bound the input before sanitizer/cell-width work; never split a surrogate.
  let input = value.slice(0, bytes)
  if (/\p{Surrogate}$/u.test(input)) input = input.slice(0, -1)
  // A UTF-16 unit occupies at most two cells. Byte truncation below is linear;
  // do not make the cell sanitizer repeatedly measure a long unbroken line.
  const cleaned = input.split(/\r?\n/u).map(line => cleanRenderText(line, bytes * 2)).join('\n')
  if (Buffer.byteLength(cleaned) <= bytes && input === value) return cleaned
  let output = ''
  let used = 0
  const tail = '\n[display truncated]'
  for (const char of cleaned) {
    const size = Buffer.byteLength(char)
    if (used + size > bytes - Buffer.byteLength(tail)) break
    output += char
    used += size
  }
  return output + tail
}
export function codeCapabilityLines(view: CodeCapabilityView): string[] {
  const lines = [`Code analysis: ${view.status}${view.reason ? ` · ${view.reason}` : ''}`]
  if (view.workspace) lines.push(`Workspace: ${view.workspace} · ${view.provider} · schema ${view.schema ?? '?'}`)
  for (const language of view.languages) {
    lines.push(`${language.language}: structure ${language.structure ? 'supported (unverified)' : 'unsupported'} · semantic ${language.semanticReady ? language.semantic.join(', ') || 'ready' : 'unverified'}${language.reason ? ` · ${language.reason}` : ''}`)
  }
  return lines.map(line => cleanRenderText(line, 240))
}
export function codeAnalysisLines(view: CodeAnalysisView): string[] {
  const lines = [`${view.path}: ${view.status}${view.reason ? ` · ${view.reason}` : ''}${view.cleanupReason ? ` · ${view.cleanupReason}` : ''}`]
  for (const result of view.results) lines.push(codeResponseText(result))
  const bounded = boundedCodeText(lines.join('\n')).split('\n')
  return bounded.length <= 200 ? bounded : [...bounded.slice(0, 199), `[display truncated: ${bounded.length - 199} lines omitted]`]
}
function location(value: unknown): string {
  if (!record(value) || !record(value.start) || !record(value.end)) return ''
  return `[${value.start.line}:${value.start.character}–${value.end.line}:${value.end.character}) UTF-16`
}
function itemText(value: unknown): string {
  if (!record(value)) return ''
  const title = [value.name ?? value.label ?? value.kind ?? value.uri ?? value.capture, location(value.range)].filter(value => typeof value === 'string' && value !== '').join(' · ')
  const body = [value.message, value.detail, value.documentation].filter(value => typeof value === 'string').join('\n')
  return [title, body].filter(Boolean).join('\n')
}
export function codeResponseText(value: unknown): string {
  if (!record(value)) return ''
  const data = record(value.data) ? value.data : value
  const arrays = [data.items, data.declarations, data.captures, data.ancestors, data.diagnostics, data.locations]
  const items = arrays.find(Array.isArray) as unknown[] | undefined
  const lines = [
    `${value.status ?? (data.skipped ? 'unsupported' : 'ok')}${value.reason ? ` · ${value.reason}` : ''}${value.snapshotVersion ?? value.version ? ` · snapshot ${value.snapshotVersion ?? value.version}` : ''}${value.sourceKind ? ` · ${value.sourceKind}` : ''}${items ? ` · ${items.length} items` : ''}${value.truncated ? ' · truncated' : ''}${value.omitted ? ` · omitted ${value.omitted}` : ''}`,
  ]
  if (typeof data.path === 'string' || typeof data.filePath === 'string') lines.push(String(data.path ?? data.filePath))
  if (Array.isArray(data.servers)) for (const server of data.servers.slice(0, 64)) {
    if (!record(server)) continue
    lines.push(`${server.id}: ${server.enabled === false ? 'disabled' : server.available === true ? 'executable available' : 'executable unavailable'} · handshake unverified${typeof server.lastError === 'string' ? ` · ${server.lastError}` : ''}`)
  }
  if (typeof data.parserAvailable === 'boolean') lines.push(`Parser: ${data.parserAvailable ? 'available' : 'unavailable'}`)
  if (Array.isArray(data.languageCapabilities)) for (const language of data.languageCapabilities.slice(0, 64)) {
    if (record(language)) lines.push(`${language.language}: structure ${language.structure === true ? 'supported (unverified)' : 'unsupported'} · semantic ${language.semanticReady === true ? 'ready' : 'unverified'}${typeof language.reason === 'string' ? ` · ${language.reason}` : ''}`)
  }
  if (items) for (const item of items.slice(0, 200)) lines.push(itemText(item))
  if (record(data.node)) lines.push(itemText(data.node))
  if (typeof data.text === 'string') lines.push(data.text)
  if (record(data.hover) && typeof data.hover.contents === 'string') lines.push(data.hover.contents)
  if (data.skipped) lines.push('Unverified: unsupported file type')
  return boundedCodeText(lines.join('\n'))
}
/** Recognize only native LSP tools and V1/legacy provider result shapes. */
export function codeToolPresentation(name: string, rawText: string, rawArgs = ''): { view: ToolResultView; detail: string; preview: string } | undefined {
  if (name !== 'lsp' && name !== 'lsp_extra') return undefined
  if (rawText.length > CODE_RESPONSE_BYTES || Buffer.byteLength(rawText) > CODE_RESPONSE_BYTES) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(rawText) } catch { return undefined }
  if (!record(parsed)) return undefined
  const known = codeResponse(parsed) || ['declarations', 'captures', 'ancestors', 'diagnostics', 'items', 'locations', 'hover', 'servers', 'parsers', 'released', 'handle', 'text', 'skipped'].some(key => key in parsed)
  if (!known) return undefined
  let args: Record<string, unknown> = {}
  try { const value: unknown = JSON.parse(rawArgs); if (record(value)) args = value } catch { /* replay may lack full args */ }
  const operation = [args.operation, args.action].filter(value => typeof value === 'string').join('/') || name
  const path = typeof args.file_path === 'string' ? args.file_path : ''
  const detail = boundedCodeText(`${operation}${path ? ` · ${path}` : ''}\n${codeResponseText({ ...parsed, ...(codeResponse(parsed) ? { data: codeDisplayData(parsed.data) } : {}) })}`)
  return { view: { card: 'generic', title: cleanRenderText(operation, 80), content: [{ type: 'text', text: detail }] }, detail, preview: cleanRenderText(detail, 240) }
}
