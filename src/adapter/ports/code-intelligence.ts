/** Read-only consumer of the provider's public protocol; no DSH runtime types. */
import type { CodeCapabilitiesV1, CodePosition, CodeRequestV1, CodeResponseV1, CodeStatus } from '@askdkc/dsh-lsp-server/code-intelligence-contracts'

type WithoutHandle<T> = T extends unknown ? Omit<T, 'handle'> : never
export type CodeStructureRequest = WithoutHandle<Extract<CodeRequestV1, { method: 'structure.outline' | 'structure.enclosing' | 'structure.query' }>>
export type CodeSemanticRequest = Omit<Extract<CodeRequestV1, { method: 'semantic.query' }>, 'method' | 'handle'>

/** The host supplies authority and opaque handles. UI input supplies only a read. */
export interface CodeAnalysisRequest {
  readonly path: string
  readonly structure?: CodeStructureRequest
  readonly semantic?: CodeSemanticRequest
  /** Enclose this cursor, then read that node's bounded span in the same lease. */
  readonly span?: { readonly position: CodePosition; readonly maxChars?: number }
}
export interface CodeCapabilityView {
  readonly provider: string
  readonly schema?: 1
  readonly workspace?: string
  readonly status: CodeStatus
  readonly reason?: string
  readonly languages: CodeCapabilitiesV1['languageCapabilities']
  readonly capabilities?: CodeCapabilitiesV1
}
export interface CodeAnalysisView {
  readonly path: string
  readonly status: CodeStatus
  readonly reason?: string
  readonly cleanupReason?: string
  /** Projected results never include snapshot/node handles or executable edits. */
  readonly results: readonly CodeResponseV1[]
}
export interface CodeIntelligencePort {
  readonly status: CodeCapabilityView
  capabilities(signal?: AbortSignal): Promise<CodeCapabilityView>
  analyze(request: CodeAnalysisRequest, signal?: AbortSignal): Promise<CodeAnalysisView>
  cancel(): void
}
