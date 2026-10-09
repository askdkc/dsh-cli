import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve the package asset in both src/tsx and compiled npm layouts. */
export function packagedPresetRoot(moduleUrl: string = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl))
  const candidates = [join(directory, '../../presets'), join(directory, '../../../presets')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`dsh-cli: packaged preset root is missing (checked ${candidates.join(', ')})`)
  }
  return found
}
