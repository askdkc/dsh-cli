/**
 * Patch-surface contract for the TUI bundle overlay.
 *
 * TUI-owned inserts/config overrides are one snapshot. Official Web ownership
 * is checked structurally, independent of release labels. Dynamic disabled
 * conditions are evaluated from each baseline's package root. An installed
 * package is checked when available; a
 * source-authoritative prerelease tree is checked too when present. CI sets
 * DSH_REQUIRE_UPSTREAM_BASELINE=1 so that baseline can never be skipped.
 *
 * Run via `node --import tsx/esm scripts/verify-patch-surface.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const tuiPatchPath = join(root, 'cordis.patch.yml')
const snapshotPath = join(root, 'patch-surface.snapshot.json')

interface ParsedPatch {
  /** Top-level rows with id and optional disabled/config. */
  overrides: Array<{ id: string; disabled: boolean | string; hasConfig: boolean }>
  /** Rows listed inside `- insert:` blocks. */
  inserts: Array<{ id: string }>
}

interface WebComparison {
  /** Rows the TUI disables that this web-app version does not. */
  disablesBeyondWebApp: string[]
  /** Rows this web-app version disables that the TUI does not. */
  webAppDisablesBeyondTui: string[]
  /** Loader ids inserted by both patches; this must stay empty. */
  insertsSharedWithWebApp: string[]
}

interface Snapshot {
  inserts: string[]
  configOverrides: string[]
}

interface WebBaseline {
  label: string
  version: string
  baseUrl: string
  patch: ParsedPatch
  /** Present only when the baseline's base and Web declarations are known. */
  declaredIds?: ReadonlySet<string>
}

function parsePatch(text: string): ParsedPatch {
  const doc = parseYaml(text) as unknown
  const overrides: ParsedPatch['overrides'] = []
  const inserts: ParsedPatch['inserts'] = []
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const row of record.insert) {
        if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
          inserts.push({ id: (row as Record<string, unknown>).id as string })
        }
      }
      continue
    }
    if (typeof record.id === 'string') {
      overrides.push({
        id: record.id,
        disabled: record.disabled === true || typeof record.disabled === 'string'
          ? record.disabled
          : false,
        hasConfig: 'config' in record,
      })
    }
  }
  return { overrides, inserts }
}

function resolvedPackageFile(specifier: string): string {
  const path = import.meta.resolve(specifier)
  return path.startsWith('file:') ? fileURLToPath(path) : path
}

function isMissingModuleError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

function baseline(label: string, manifestPath: string, patchPath: string, baseUrl?: string): WebBaseline {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${label} web-app manifest has no version`)
  }
  return {
    label,
    version: manifest.version,
    baseUrl: baseUrl ?? pathToFileURL(manifestPath).href,
    patch: parsePatch(readFileSync(patchPath, 'utf8')),
  }
}

function disabledIds(patch: ParsedPatch, baseUrl: string): Set<string> {
  return new Set(patch.overrides.filter(row => {
    if (row.disabled === true) return true
    if (typeof row.disabled !== 'string') return false
    return Boolean(evaluate({ baseUrl, loader: { entries: () => [] } }, row.disabled))
  }).map(row => row.id))
}

function declaredIds(text: string): Set<string> {
  const doc = parseYaml(text) as unknown
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  const ids = new Set<string>()
  const visit = (rows: unknown[]) => {
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      if (typeof record.id === 'string') ids.add(record.id)
      if (record.group === true && Array.isArray(record.config)) visit(record.config)
    }
  }
  for (const patch of doc) {
    if (patch !== null && typeof patch === 'object' && Array.isArray(patch.insert)) visit(patch.insert)
  }
  return ids
}

function comparison(tui: ParsedPatch, webApp: WebBaseline, officialDisabledIds: ReadonlySet<string>): WebComparison {
  const tuiDisableSet = disabledIds(tui, webApp.baseUrl)
  const webDisableSet = disabledIds(webApp.patch, webApp.baseUrl)
  const webAppPatch = webApp.patch
  const webInsertSet = new Set(webAppPatch.inserts.map(row => row.id))
  return {
    disablesBeyondWebApp: tui.overrides
      .filter(row => tuiDisableSet.has(row.id) && !webDisableSet.has(row.id))
      // A legacy official disable is inert only when this source generation
      // declares no target in either base or Web. Unknown overrides still fail.
      .filter(row => !officialDisabledIds.has(row.id) || webApp.declaredIds === undefined || webApp.declaredIds.has(row.id))
      .map(row => row.id),
    webAppDisablesBeyondTui: webAppPatch.overrides
      .filter(row => webDisableSet.has(row.id) && !tuiDisableSet.has(row.id))
      .map(row => row.id),
    insertsSharedWithWebApp: tui.inserts.filter(row => webInsertSet.has(row.id)).map(row => row.id),
  }
}

if (!existsSync(tuiPatchPath)) {
  console.error('cordis.patch.yml missing')
  process.exit(1)
}
const tui = parsePatch(readFileSync(tuiPatchPath, 'utf8'))
const baselines: WebBaseline[] = []

let installedManifest: string | undefined
try {
  installedManifest = resolvedPackageFile('@deepseek-ai/dsh-web-app/package.json')
} catch (error) {
  if (!isMissingModuleError(error)) throw error
  console.warn('@deepseek-ai/dsh-web-app not installed — skipping installed web-app comparison')
}
if (installedManifest !== undefined) {
  baselines.push(baseline(
    'installed',
    installedManifest,
    resolvedPackageFile('@deepseek-ai/dsh-web-app/cordis.patch.yml'),
  ))
}

const sourceRoot = resolve(process.env.DSH_HARNESS_SOURCE_ROOT ?? resolve(root, '../deepseek-harness'))
const sourceManifest = join(sourceRoot, 'packages/bundle/web-app/package.json')
const sourcePatch = join(sourceRoot, 'packages/bundle/web-app/cordis.patch.yml')
const sourceBasePatch = join(sourceRoot, 'packages/bundle/base/cordis.patch.yml')
const requireSourceBaseline = process.env.DSH_REQUIRE_UPSTREAM_BASELINE === '1'
if (existsSync(sourceManifest) && existsSync(sourcePatch) && existsSync(sourceBasePatch)) {
  baselines.push({
    ...baseline('source', sourceManifest, sourcePatch),
    declaredIds: new Set([
      ...declaredIds(readFileSync(sourceBasePatch, 'utf8')),
      ...declaredIds(readFileSync(sourcePatch, 'utf8')),
    ]),
  })
} else if (requireSourceBaseline || process.env.DSH_HARNESS_SOURCE_ROOT !== undefined) {
  throw new Error(`required source baseline missing under ${sourceRoot}`)
}

const ownSurface = {
  inserts: tui.inserts.map(row => row.id),
  configOverrides: tui.overrides.filter(row => !row.disabled && row.hasConfig).map(row => row.id),
}
// These differences express TUI ownership, not a particular DSH release.
const expectedComparison: WebComparison = {
  disablesBeyondWebApp: [],
  webAppDisablesBeyondTui: ['tool-plugin-manager', 'workflow-ptc'],
  insertsSharedWithWebApp: [],
}
if (baselines.length === 0) throw new Error('patch-surface requires a Web baseline')
const officialDisabledIds = new Set(baselines.flatMap(webApp => [...disabledIds(webApp.patch, webApp.baseUrl)]))
for (const webApp of baselines) {
  const actual = comparison(tui, webApp, officialDisabledIds)
  for (const key of Object.keys(expectedComparison) as Array<keyof WebComparison>) {
    if (JSON.stringify([...actual[key]].sort()) !== JSON.stringify([...expectedComparison[key]].sort())) {
      throw new Error(`patch-surface: ${webApp.label} web-app ${webApp.version} ${key}: `
        + `expected ${JSON.stringify(expectedComparison[key])}, got ${JSON.stringify(actual[key])}`)
    }
  }
}

const mode = process.argv[2]
if (mode === '--snapshot') {
  if (baselines.length === 0) {
    console.error('refusing to snapshot without any @deepseek-ai/dsh-web-app baseline')
    process.exit(1)
  }
  const next: Snapshot = ownSurface
  writeFileSync(snapshotPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`patch-surface snapshot written: ${snapshotPath}`)
  process.exit(0)
}

if (!existsSync(snapshotPath)) {
  console.error('patch-surface.snapshot.json missing — run this script with --snapshot')
  process.exit(1)
}
const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
const failures: string[] = []
if (JSON.stringify(recorded.inserts) !== JSON.stringify(ownSurface.inserts)) failures.push('TUI inserts')
if (JSON.stringify(recorded.configOverrides) !== JSON.stringify(ownSurface.configOverrides)) failures.push('TUI config overrides')

if (failures.length === 0) {
  console.log(
    `patch-surface OK (${ownSurface.inserts.length} inserts, `
    + `${ownSurface.configOverrides.length} config overrides; `
    + `${baselines.map(({ label, version }) => `${label} ${version}`).join(' + ') || 'no web baseline'})`,
  )
  process.exit(0)
}
console.error(`patch-surface drifted: ${failures.join(', ')}`)
console.error('Review the diff, then regenerate: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
process.exit(1)
