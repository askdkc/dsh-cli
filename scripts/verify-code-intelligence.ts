/** Public-provider consumer and transcript regressions; no model API. */
import assert from 'node:assert/strict'
import type { CodeCapabilitiesV1, CodeHostBindingV1, CodeIntelligenceServiceV1, CodeRequestV1, CodeResponseV1 } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
import { CODE_INTELLIGENCE_SERVICE } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'
import { CODE_SERVICE_KEY } from '../src/dsh-adapter/code-intelligence-validation.js'
import { foldBack, foldRows, harnessToolResultView, restoreToolResult } from '../src/dsh-adapter/channel/transcript.js'
import { boundedCodeText, codeAnalysisLines, codeToolPresentation } from '../src/dsh-adapter/code-intelligence-presenter.js'
import { createChannelUi, createChannelUiLease } from '../src/adapter/channel/ui.js'
import { parseCodeCommand } from '../src/codeIntelligenceCommands.js'

const response = (data: unknown, status: CodeResponseV1['status'] = 'ok'): CodeResponseV1 => ({
  protocol: 'code-intelligence/v1', status, sourceKind: 'disk', freshness: 'current',
  snapshotVersion: '1:hash', truncated: false, omitted: 0, data,
})
assert.equal(CODE_SERVICE_KEY, CODE_INTELLIGENCE_SERVICE)
const resultEvent = (value: unknown) => ({ message: {
  source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: JSON.stringify(value) }],
} }) as never

// Red on the original presenter: the V1 envelope was dumped as raw JSON.
const card = harnessToolResultView('lsp_extra', resultEvent(response({ items: [{ label: '\u001b[31m日本語🙂é', textEdit: { newText: 'MUST NOT APPLY' }, command: 'MUST NOT EXECUTE' }] }, 'partial')))
assert.ok(card, 'code-intelligence results must have a bounded presentation')
assert.equal(card.card, 'generic')
assert.ok(!JSON.stringify(card).includes('MUST NOT'), 'completion edits and commands are never rendered as actions')
assert.ok(!JSON.stringify(card).includes('\\u001b'), 'terminal control sequences are sanitized')
assert.ok(JSON.stringify(card).includes('partial'))
assert.equal(harnessToolResultView('unrelated', resultEvent(response({ items: [] }))), undefined)
assert.deepEqual(parseCodeCommand('definition a file.ts 2 10'), { path: 'a file.ts', semantic: { kind: 'definition', position: { line: 2, character: 10 } } })
assert.equal(parseCodeCommand('rename fixture.ts 0 0'), undefined)
assert.equal(parseCodeCommand('completion fixture.ts -1 0'), undefined)
const huge = boundedCodeText('日本語🙂é\r\n'.repeat(20000))
assert.ok(Buffer.byteLength(huge) <= 32768)
assert.ok(huge.endsWith('[display truncated]'))
assert.ok(Buffer.byteLength(boundedCodeText('日本語'.repeat(20000))) <= 32768)
assert.ok(!/[\uD800-\uDBFF]$/u.test(huge))
const unicode = response({ items: [{ kind: 'function', name: '日本語🙂é', range: { start: { line: 0, character: 2 }, end: { line: 1, character: 0 } } }] })
assert.ok(codeAnalysisLines({ path: 'fixture.ts', status: 'ok', results: [unicode] }).join('\n').includes('[0:2–1:0) UTF-16'))
assert.ok(codeAnalysisLines({ path: 'fixture.ts', status: 'ok', results: [response({ text: '\n'.repeat(10000) })] }).length <= 200)
const args = JSON.stringify({ operation: 'structure', action: 'outline', file_path: 'fixture.ts' })
const presented = codeToolPresentation('lsp_extra', JSON.stringify(unicode), args)!
const row = { id: 1, kind: 'tool', seq: 1, text: '', tool: { callId: 'call', name: 'lsp_extra', argsFull: args, argsText: '', status: 'running' } } as never
const event = { type: 'tool/result', seq: 2, data: resultEvent(unicode) } as never
restoreToolResult(row, event)
assert.equal((row as any).tool.resultFull, presented.detail)
const rows = [row, { id: 2, kind: 'local', text: 'later' }] as never
assert.equal(foldRows(rows, 1), 1)
assert.equal((row as any).tool.resultFull, undefined)
assert.equal(foldBack(rows, [{ type: 'tool/call', seq: 1, data: { callId: 'call', name: 'lsp_extra', arguments: args } }, event] as never), 1)
assert.deepEqual((row as any).tool.resultView, presented.view, 'replay preserves the same passive presenter without a live provider')

const { createCodeIntelligenceConsumer } = await import('../src/dsh-adapter/channel/code-intelligence.js')
const capabilities: CodeCapabilitiesV1 = {
  version: 1, capabilities: ['snapshots', 'structure', 'semantic'], languages: ['typescript'],
  queryIds: ['declarations', 'calls', 'imports'], semanticReady: false, sourceKinds: ['disk'],
  languageCapabilities: [{ language: 'typescript', structure: true, semantic: [], semanticReady: false, reason: 'not_yet_verified' }],
  limits: { documentBytes: 1024, captureItems: 200, outlineItems: 100, spanChars: 8000, responseBytes: 32768, files: 100, inputBytes: 1024, outputBytes: 65536, calls: 100, batchMs: 30000, structureMs: 2000, semanticMs: 10000 },
}
const calls: CodeRequestV1[] = []
let disposed = 0
let bound: CodeHostBindingV1 | undefined
let active = true
let generation = 1
let provider: unknown
let requestHook: ((input: CodeRequestV1, signal: AbortSignal) => Promise<CodeResponseV1>) | undefined
const service: CodeIntelligenceServiceV1 = {
  version: 1, capabilities: ['snapshots', 'structure', 'semantic'],
  async bind(binding, signal) {
    bound = binding
    await binding.assertCurrent()
    signal.throwIfAborted()
    return {
      async request(input, signal) {
        calls.push(input)
        if (requestHook) return requestHook(input, signal)
        if (input.method === 'capabilities') return response(capabilities)
        if (input.method === 'snapshot.open') return response({ handle: 'opaque', path: input.path, language: 'typescript' })
        if (input.method === 'snapshot.release') return response({ released: true })
        if (input.method === 'semantic.query') return response({ items: [{ uri: 'file:///workspace/fixture.ts', message: '日本語🙂é', range: { start: { line: 0, character: 2 }, end: { line: 1, character: 0 } } }] })
        return response({ items: [{ handle: 'private-node', kind: 'function', name: '日本語🙂é', range: { start: { line: 0, character: 2 }, end: { line: 1, character: 0 } } }] })
      },
      async dispose() { disposed++ },
    }
  },
}
provider = service
const context = { get: () => undefined }
const consumer = createCodeIntelligenceConsumer({
  discover: () => provider,
  capture: () => {
    const captured = generation
    return { owner: { agentId: 'agent', sessionId: 'session' }, workspaceRoot: '/workspace', scope: context, context,
      assertCurrent() { if (!active || captured !== generation) throw new Error('binding_changed') },
    }
  },
  signal: new AbortController().signal,
  timeoutMs: 100,
})
assert.equal((await consumer.capabilities()).status, 'ok')
assert.equal((await consumer.capabilities()).languages[0].semanticReady, false, 'presence does not imply semantic readiness')
const before = disposed
const result = await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' }, semantic: { kind: 'diagnostics' } })
assert.equal(result.status, 'ok')
assert.equal(disposed, before + 1)
assert.deepEqual(calls.slice(-5).map(x => x.method), ['capabilities', 'snapshot.open', 'structure.outline', 'semantic.query', 'snapshot.release'])
assert.ok(calls.filter(x => 'handle' in x && x.method !== 'snapshot.release').every(x => x.handle === 'opaque'))
assert.ok(!JSON.stringify(result).includes('private-node'), 'opaque handles never escape to the view model')
assert.equal(bound?.workspaceRoot, '/workspace')

for (const invalid of [
  { path: 'fixture.ts', semantic: { kind: 'rename' } },
  { path: 'fixture.ts', semantic: { kind: 'hover', position: { line: -1, character: 0 } } },
  { path: 'fixture.ts', structure: { method: 'structure.query', queryId: '(arbitrary)' } },
  { path: 'fixture.ts', owner: { agentId: 'forged' }, structure: { method: 'structure.outline' } },
]) {
  const count = calls.length
  assert.equal((await consumer.analyze(invalid as never)).status, 'unsupported')
  assert.equal(calls.length, count, 'invalid model/user input cannot reach the provider')
}
provider = { ...service, version: 2 }
assert.equal((await consumer.capabilities()).reason, 'schema_mismatch')
provider = undefined
assert.equal((await consumer.capabilities()).reason, 'provider_absent')
provider = service

// A late result from a replaced binding cannot be published, but is released.
requestHook = async (input) => {
  if (input.method === 'capabilities') return response(capabilities)
  if (input.method === 'snapshot.open') return response({ handle: 'late', path: 'fixture.ts', language: 'typescript' })
  if (input.method === 'snapshot.release') return response({ released: true })
  generation++
  return response({ items: [] })
}
assert.equal((await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } })).status, 'stale')
assert.equal(calls.at(-1)?.method, 'snapshot.release')

// Abort and timeout reach the provider. Cleanup gets a fresh, bounded signal.
let aborted = false
requestHook = async (input, signal) => {
  if (input.method === 'capabilities') return response(capabilities)
  if (input.method === 'snapshot.open') return response({ handle: 'cancel', path: 'fixture.ts', language: 'typescript' })
  if (input.method === 'snapshot.release') { assert.equal(signal.aborted, false); return response({ released: true }) }
  await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
  return response({ items: [] })
}
const controller = new AbortController()
const pending = consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } }, controller.signal)
setTimeout(() => controller.abort(), 10)
assert.equal((await pending).status, 'cancelled')
assert.equal(aborted, true)
assert.equal((await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } })).status, 'timeout')

// Provider reload invalidates an old result even with the same session.
requestHook = async (input) => {
  if (input.method === 'capabilities') return response(capabilities)
  if (input.method === 'snapshot.open') return response({ handle: 'reload', path: 'fixture.ts', language: 'typescript' })
  if (input.method === 'snapshot.release') return response({ released: true })
  provider = { ...service }
  return response({ items: [] })
}
assert.equal((await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } })).status, 'stale')
provider = service
requestHook = async () => ({ ...response(undefined), protocol: 'wrong' as never })
assert.equal((await consumer.capabilities()).reason, 'invalid_result')
requestHook = async input => {
  if (input.method === 'capabilities') return response(capabilities)
  if (input.method === 'snapshot.open') return response({ handle: 'cleanup', path: 'fixture.ts', language: 'typescript' })
  if (input.method === 'snapshot.release') return response(undefined, 'unavailable')
  return response({ items: [] })
}
const failedRelease = await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } })
assert.equal(failedRelease.status, 'unavailable')
assert.equal(failedRelease.cleanupReason, 'snapshot_cleanup_failed')
requestHook = async input => {
  if (input.method === 'capabilities') return response(capabilities)
  if (input.method === 'snapshot.open') return response({ handle: 'version', path: 'fixture.ts', language: 'typescript' })
  if (input.method === 'snapshot.release') return response({ released: true })
  return { ...response({ items: [] }), snapshotVersion: 'another-version' }
}
assert.equal((await consumer.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } })).reason, 'snapshot_version_changed')
let lateClose = 0
let resolveBind!: (lease: unknown) => void
const lateProvider = { version: 1, capabilities: ['snapshots'], bind: () => new Promise(resolve => { resolveBind = resolve }) }
const lateConsumer = createCodeIntelligenceConsumer({
  discover: () => lateProvider,
  capture: () => ({ owner: { agentId: 'a', sessionId: 's' }, workspaceRoot: '/workspace', scope: context, context, assertCurrent() {} }),
  signal: new AbortController().signal, timeoutMs: 10,
})
assert.equal((await lateConsumer.capabilities()).status, 'timeout')
resolveBind({ request: async () => response(capabilities), dispose: async () => { lateClose++ } })
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(lateClose, 1, 'a lease returned after cancellation is still disposed exactly once')
await lateConsumer.dispose()
let boundWrites = 0
const uiLease = createChannelUiLease(() => true)
const ui = createChannelUi({ codeIntelligence: { status: consumer.status, analyze: async () => { boundWrites++ }, cancel: () => { boundWrites++ }, capabilities: async () => { boundWrites++ } } } as never, 'shadow', uiLease)
assert.throws(() => ui.codeIntelligence?.analyze({ path: 'fixture.ts', structure: { method: 'structure.outline' } }), /shadow|effect|read.only|passive/iu)
assert.equal(boundWrites, 0)
uiLease.dispose()
await consumer.dispose()
await consumer.dispose()
assert.equal((await consumer.capabilities()).status, 'cancelled')
console.log('code-intelligence consumer and presenter regressions OK')
