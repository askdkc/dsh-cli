import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { valid } from 'semver'

const PACKAGE_NAME = '@askdkc/dsh-cli'

/** Read the version from either the compiled package or the source checkout. */
export function installedTuiVersion(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relativePath of ['../../package.json', '../package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, relativePath), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const packageJson = parsed as Record<string, unknown>
        const version = packageJson.version
        if (packageJson.name === PACKAGE_NAME && typeof version === 'string' && valid(version) !== null) {
          return version
        }
      }
    } catch {
      // Try the source-layout fallback after the compiled-layout path.
    }
  }
  return undefined
}

