/** Owned OpenCode catalog. Public listings are untrusted; no pi catalog participates. */
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { abortable } from './abortable.js'
import { randomUUID } from 'node:crypto'

export const OPEN_CODE_ROUTES = ['opencode', 'opencode-go'] as const
export type OpenCodeRoute = typeof OPEN_CODE_ROUTES[number]
export type OpenCodeProtocol = 'messages' | 'responses' | 'chat' | 'google'
export const OPEN_CODE_URLS: Record<OpenCodeRoute, string> = {
  opencode: 'https://opencode.ai/zen/v1', 'opencode-go': 'https://opencode.ai/zen/go/v1',
}
export interface OpenCodeModel {
  id: string; name: string; protocol: OpenCodeProtocol; contextWindow: number; maxTokens: number
  inputModalities: ('text' | 'image')[]; toolCall: boolean; reasoning: boolean; temperature: boolean
  efforts: string[]; cost?: Record<string, number>
}
export interface OpenCodeSnapshot {
  version: 1; provider: OpenCodeRoute; fetchedAt: number; roster: string[]
  models: OpenCodeModel[]; excluded: { id: string; reason: string }[]
}
export interface OpenCodeCatalogStatus {
  provider: OpenCodeRoute; source: 'bundled' | 'cache' | 'live'; fetchedAt: number
  available: number; excluded: readonly { id: string; reason: string }[]; warning?: string
}
const PROTOCOLS: Record<string, { protocol: OpenCodeProtocol; sdks: readonly string[] }> = {
  messages: { protocol: 'messages', sdks: ['@ai-sdk/anthropic'] },
  responses: { protocol: 'responses', sdks: ['@ai-sdk/openai'] },
  'chat-completions': { protocol: 'chat', sdks: ['@ai-sdk/openai-compatible', '@ai-sdk/mistral'] },
  'generate-content': { protocol: 'google', sdks: ['@ai-sdk/google'] },
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('catalog expected an object')
  return value as Record<string, unknown>
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
export function rosterIds(payload: unknown): string[] {
  const data = object(payload).data
  if (!Array.isArray(data) || !data.length) throw new Error('catalog has no non-empty model roster')
  return [...new Set(data.map(row => {
    const id = object(row).id
    if (typeof id !== 'string' || !id.trim() || id.length > 512) throw new Error('catalog has an invalid model id')
    return id
  }))].sort()
}
/** Only the official route's model listing supplies metadata; each id has an explicit outcome. */
export function normalizeCatalog(provider: OpenCodeRoute, payload: unknown, fetchedAt: number): OpenCodeSnapshot {
  const data = object(payload).data
  const roster = rosterIds(payload)
  const entries = new Map<string, unknown>()
  for (const row of data as unknown[]) entries.set(object(row).id as string, row)
  const models: OpenCodeModel[] = []; const excluded: OpenCodeSnapshot['excluded'] = []
  for (const id of roster) {
    try {
      const raw = object(entries.get(id)); const api = object(raw.api)
      const wires = Object.keys(api)
      const route = wires.length === 1 && Object.hasOwn(PROTOCOLS, wires[0]!) ? PROTOCOLS[wires[0]!] : undefined
      const sdk = route && object(object(api[wires[0]!]).sdk).aisdk
      const limit = object(raw.limit); const modalities = object(raw.modalities)
      const capabilities = object(raw.capabilities)
      if (!route || !route.sdks.includes(sdk as string)) throw new Error('unsupported or unknown wire protocol')
      if (raw.type !== 'chat') throw new Error('not a chat model')
      if (!positive(limit.context) || !positive(limit.output)) throw new Error('context or output limit unavailable')
      if (!Array.isArray(modalities.input) || !modalities.input.includes('text') || !Array.isArray(modalities.output) || !modalities.output.includes('text')) throw new Error('not a verified text-generation model')
      const tools = object(capabilities.tools); const reasoning = object(capabilities.reasoning)
      if (typeof tools.supported !== 'boolean' || typeof reasoning.supported !== 'boolean') throw new Error('model capabilities unavailable')
      const efforts = reasoning.effort ?? []
      if (!Array.isArray(efforts) || !efforts.every(value => typeof value === 'string')) throw new Error('invalid reasoning efforts')
      const textCost = raw.cost === undefined ? undefined : object(object(raw.cost).text)
      const input = textCost === undefined ? undefined : object(textCost.input)
      const output = textCost === undefined ? undefined : object(textCost.output)
      const cache = input?.cache === undefined ? undefined : object(input.cache)
      const amounts = { input: input?.price, output: output?.price, cache_read: cache?.read, cache_write: cache?.write }
      const cost = Object.fromEntries(Object.entries(amounts).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) as Record<string, number>
      models.push({ id, name: typeof raw.name === 'string' && raw.name ? raw.name : id, protocol: route.protocol, contextWindow: limit.context, maxTokens: limit.output,
        inputModalities: modalities.input.some(value => typeof value === 'string' && value.startsWith('image/')) ? ['text', 'image'] : ['text'], toolCall: tools.supported, reasoning: reasoning.supported,
        temperature: capabilities.temperature === true, efforts: [...efforts], ...(Object.keys(cost).length ? { cost } : {}) })
    } catch (error) { excluded.push({ id, reason: error instanceof Error ? error.message : 'invalid metadata' }) }
  }
  if (!models.length) throw new Error('catalog has no usable models')
  return { version: 1, provider, fetchedAt, roster, models, excluded }
}
/** Validate cache/snapshot data using the same normalizer as fetched metadata. */
export function parseSnapshot(value: unknown, provider: OpenCodeRoute): OpenCodeSnapshot {
  const raw = object(value)
  if (raw.version !== 1 || raw.provider !== provider || typeof raw.fetchedAt !== 'number' || !Number.isSafeInteger(raw.fetchedAt) || raw.fetchedAt < 0 || !Array.isArray(raw.roster) || !raw.roster.length || !raw.roster.every(id => typeof id === 'string' && id.trim() && id.length <= 512) || !Array.isArray(raw.models) || !Array.isArray(raw.excluded)) throw new Error('invalid catalog snapshot')
  const roster = raw.roster as string[]
  if (new Set(roster).size !== roster.length) throw new Error('duplicate snapshot roster id')
  const models = raw.models.map(value => {
    const model = object(value)
    if (typeof model.id !== 'string' || typeof model.protocol !== 'string' || !Object.values(PROTOCOLS).some(route => route.protocol === model.protocol) || !positive(model.contextWindow) || !positive(model.maxTokens) || typeof model.name !== 'string' || !model.name || !Array.isArray(model.inputModalities) || !model.inputModalities.includes('text') || model.inputModalities.some(v => v !== 'text' && v !== 'image') || !Array.isArray(model.efforts) || !model.efforts.every(v => typeof v === 'string' && v.length > 0) || [model.toolCall, model.reasoning, model.temperature].some(v => typeof v !== 'boolean')) throw new Error('invalid cached model')
    const cost = model.cost === undefined ? undefined : object(model.cost)
    if (cost && Object.values(cost).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('invalid cached cost')
    return { id: model.id, name: model.name, protocol: model.protocol as OpenCodeProtocol, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      inputModalities: [...new Set(model.inputModalities)] as OpenCodeModel['inputModalities'], efforts: [...new Set(model.efforts)] as string[],
      toolCall: model.toolCall as boolean, reasoning: model.reasoning as boolean, temperature: model.temperature as boolean,
      ...(cost ? { cost: { ...cost } as Record<string, number> } : {}) }
  })
  const excluded = raw.excluded.map(value => { const entry = object(value); if (typeof entry.id !== 'string' || typeof entry.reason !== 'string' || !entry.reason) throw new Error('invalid exclusion reason'); return { id: entry.id, reason: entry.reason } })
  const ids = [...models, ...excluded].map(model => model.id)
  if (new Set(ids).size !== ids.length || ids.length !== roster.length || ids.some(id => !roster.includes(id))) throw new Error('incomplete catalog snapshot')
  return { version: 1, provider, fetchedAt: raw.fetchedAt, roster: [...roster], models, excluded }

}
export async function fetchCatalogJson(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  const response = await abortable(fetcher(url, { signal: timeout, headers: { accept: 'application/json' }, redirect: 'error' }), timeout)
  if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`)
  if (!response.body) throw new Error('empty catalog response')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { const item = await abortable(reader.read(), timeout); if (item.done) break; size += item.value.byteLength; if (size > 32 * 1024 * 1024) throw new Error('catalog exceeds 32 MiB'); chunks.push(item.value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
}
export class OpenCodeCatalog {
  private snapshot: OpenCodeSnapshot
  private source: OpenCodeCatalogStatus['source'] = 'bundled'
  private warning?: string
  private pending?: Promise<OpenCodeCatalogStatus>
  private disposed = false
  private abort = new AbortController()
  private timer?: NodeJS.Timeout
  private started = false
  constructor(readonly provider: OpenCodeRoute, bundled: unknown, private readonly options: {
    directory?: string; fetcher?: typeof fetch; changed?: () => void; now?: () => number
  } = {}) { this.snapshot = parseSnapshot(bundled, provider) }
  private get path(): string { return join(this.options.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-auth', 'catalog-v1'), `${this.provider}.json`) }
  models(): readonly OpenCodeModel[] { return structuredClone(this.snapshot.models) }
  status(): OpenCodeCatalogStatus { return { provider: this.provider, source: this.source, fetchedAt: this.snapshot.fetchedAt, available: this.snapshot.models.length, excluded: structuredClone(this.snapshot.excluded), ...(this.warning ? { warning: this.warning } : {}) } }
  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    try { const cached = parseSnapshot(JSON.parse(await readFile(this.path, 'utf8')), this.provider); if (!this.disposed && cached.fetchedAt > this.snapshot.fetchedAt) { this.snapshot = cached; this.source = 'cache'; this.options.changed?.() } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warning = 'catalog cache unreadable; using bundled information' }
    if (this.disposed) return
    await this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, 3_600_000); this.timer.unref()
  }
  refresh(): Promise<OpenCodeCatalogStatus> {
    if (this.disposed) return Promise.reject(new Error('catalog disposed'))
    if (this.pending) return this.pending
    this.pending = this.update().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async update(): Promise<OpenCodeCatalogStatus> {
    const startedAt = this.options.now?.() ?? Date.now()
    try {
      const listing = await fetchCatalogJson(`${OPEN_CODE_URLS[this.provider]}/models`, this.options.fetcher ?? fetch, this.abort.signal)
      const next = normalizeCatalog(this.provider, listing, startedAt)
      if (this.disposed || next.fetchedAt < this.snapshot.fetchedAt) return this.status()
      this.snapshot = next; this.source = 'live'; this.warning = next.excluded.length ? 'some official models have unsupported metadata' : undefined; this.options.changed?.()
      try { await this.save(next) }
      catch { if (!this.disposed) this.warning = 'catalog updated in memory; cache save failed' }
    } catch { if (!this.disposed) this.warning = 'catalog refresh failed; retaining last verified information' }
    return this.status()
  }
  /** Compare and replace under a bounded cross-process lock; failed writes retain the old cache. */
  private async save(next: OpenCodeSnapshot): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true })
    const lock = `${this.path}.lock`; const deadline = Date.now() + 5000
    while (true) {
      this.abort.signal.throwIfAborted()
      try { await mkdir(lock); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      try { const current = parseSnapshot(JSON.parse(await readFile(this.path, 'utf8')), this.provider); if (current.fetchedAt > next.fetchedAt) return }
      catch { /* An invalid cache may be replaced by verified public data. */ }
      this.abort.signal.throwIfAborted()
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); this.abort.signal.throwIfAborted(); await rename(temp, this.path)
    } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true }) }
  }
  dispose(): void { this.disposed = true; this.abort.abort(); if (this.timer) clearInterval(this.timer) }
}
