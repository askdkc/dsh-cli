/** Host dependency boundary. Release labels are diagnostic data, not an allowlist. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Official packages the adapter consumes at runtime or as types. */
export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
] as const

function resolvePackageJson(packageName: string): string | undefined {
  try {
    const path = import.meta.resolve(`${packageName}/package.json`)
    return path.startsWith('file:') ? fileURLToPath(path) : path
  } catch {
    return undefined
  }
}

let cachedVersions: Record<string, string | undefined> | undefined
export function installedUpstreamVersions(): Record<string, string | undefined> {
  // Package manifests do not change during one verification process.
  // Frozen so callers can
  // never corrupt the shared cache.
  if (cachedVersions !== undefined) return cachedVersions
  const result: Record<string, string | undefined> = {}
  for (const packageName of UPSTREAM_BLESSED_PACKAGES) {
    let version: string | undefined
    const path = resolvePackageJson(packageName)
    if (path !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
        version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
      } catch {
        version = undefined
      }
    }
    result[packageName] = version
  }
  cachedVersions = Object.freeze(result)
  return cachedVersions
}

export interface UpstreamDependencyIssue {
  package: string
  installed: string | undefined
  reason: string
}

/** Require the development dependency surface without restricting DSH releases. */
export function upstreamDependencyIssues(
  installedVersions: Readonly<Record<string, string | undefined>> = installedUpstreamVersions(),
): UpstreamDependencyIssue[] {
  const issues: UpstreamDependencyIssue[] = []
  for (const name of UPSTREAM_BLESSED_PACKAGES) {
    const installed = installedVersions[name]
    if (installed === undefined) {
      issues.push({ package: name, installed, reason: 'package manifest is missing' })
    }
  }
  return issues
}

/** The frontend owns effects and starts a child after its owner settles. */
export function assertCordisLifecycle(value: unknown): void {
  const ctx = value as { effect?: unknown; plugin?: unknown; fiber?: { await?: unknown } } | null
  if (!ctx || typeof ctx.effect !== 'function' || typeof ctx.plugin !== 'function' || typeof ctx.fiber?.await !== 'function') {
    throw new Error('dsh-cli requires Cordis effect, plugin and fiber.await APIs')
  }
}
