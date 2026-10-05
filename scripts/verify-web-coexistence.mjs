/**
 * Regression gate for mixed dsh-web + dsh-tui profiles.
 *
 * The installed web-app is always checked. A source checkout supplies the
 * source-authoritative prerelease baseline; CI requires it instead of silently
 * skipping it.
 * Scoped TUI host rows must never collide with either bundle generation and
 * must yield to every official row that generation owns.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const yamlOptions = { logLevel: 'silent' }
const loadPatch = path => parse(readFileSync(path, 'utf8'), yamlOptions)
const insertedRows = patches => patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])

const tuiPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const installedWebPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'))
const installedWebManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))
const installedWebVersion = JSON.parse(readFileSync(installedWebManifest, 'utf8')).version
const baselines = [{
  label: `installed web-app ${installedWebVersion}`,
  version: installedWebVersion,
  baseUrl: pathToFileURL(tuiPath).href,
  webPath: installedWebPath,
  presetPath: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
}]

const sourceRoot = process.env.DSH_HARNESS_SOURCE_ROOT === undefined
  ? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
  : resolve(process.env.DSH_HARNESS_SOURCE_ROOT)
const sourceWebPath = join(sourceRoot, 'packages/bundle/web-app/cordis.patch.yml')
const sourceWebManifest = join(sourceRoot, 'packages/bundle/web-app/package.json')
const sourceBasePath = join(sourceRoot, 'packages/bundle/base/cordis.patch.yml')
const requireSourceBaseline = process.env.DSH_REQUIRE_UPSTREAM_BASELINE === '1'
if (existsSync(sourceWebPath) && existsSync(sourceWebManifest) && existsSync(sourceBasePath)) {
  const sourceWebVersion = JSON.parse(readFileSync(sourceWebManifest, 'utf8')).version
  baselines.push({
    label: `source web-app ${sourceWebVersion}`,
    version: sourceWebVersion,
    baseUrl: pathToFileURL(sourceWebManifest).href,
    presetPath: join(sourceRoot, 'packages/bundle/web-app/presets/standard.patch.yml'),
    basePath: sourceBasePath,
    webPath: sourceWebPath,
  })
} else if (requireSourceBaseline || process.env.DSH_HARNESS_SOURCE_ROOT !== undefined) {
  throw new Error(`required source baseline missing under ${sourceRoot}`)
}

const tuiPatches = loadPatch(tuiPath)
assert.ok(Array.isArray(tuiPatches), 'dsh-tui patch must be a top-level list')

const evaluateFor = (baseline, expression, entries = []) => evaluate({
  baseUrl: baseline.baseUrl,
  loader: { entries: () => entries },
}, expression)

const shared = [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
  { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain' },
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
  { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry' },
  { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
]

for (const baseline of baselines) {
  const shippedOwnsCommandGoal = insertedRows(loadPatch(baseline.presetPath))
    .some(row => row.config.plugins.some(plugin => plugin.id === 'command-goal'))
  const basePatches = baseline.basePath === undefined ? [] : loadPatch(baseline.basePath)
  const webPatches = loadPatch(baseline.webPath)
  assert.ok(Array.isArray(basePatches), `${baseline.label}: base patch must be a top-level list`)
  assert.ok(Array.isArray(webPatches), `${baseline.label}: web-app patch must be a top-level list`)
  assert.equal(
    shippedOwnsCommandGoal,
    webPatches.some(row => row?.id === 'command-goal' && row?.disabled === true),
    `${baseline.label}: direct shipped command-goal ownership must match the official web override`,
  )

  const officialRows = insertedRows([...basePatches, ...webPatches])
  const composed = applyEntryPatches([], [...basePatches, ...webPatches, ...tuiPatches], () => {})
  const counts = new Map()
  for (const row of composed) {
    if (typeof row?.id !== 'string') continue
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id)
  assert.deepEqual(
    duplicates,
    [],
    `${baseline.label}: dsh-tui reuses official loader ids: ${duplicates.join(', ')}`,
  )

  for (const { id, name } of shared) {
    const officialExpected = officialRows.some(row => row?.id === id && row?.name === name)
    const official = composed.find(row => row?.id === id && row?.name === name)
    assert.equal(Boolean(official), officialExpected, `${baseline.label}: official ${id} ownership drifted`)

    const scopedId = `dsh-tui-${id}`
    const tuiRow = composed.find(row => row?.id === scopedId && row?.name === name)
    assert.ok(tuiRow, `${baseline.label}: dsh-tui patch must mount ${scopedId}`)
    assert.equal(typeof tuiRow.disabled, 'string', `${baseline.label}: ${scopedId} needs a !!js disabled expression`)
    assert.ok(
      tuiRow.disabled.includes(`entry.options.id === '${id}'`) && tuiRow.disabled.includes(`'${name}'`),
      `${baseline.label}: ${scopedId} must yield to ${id}/${name}`,
    )
    const unavailable = false
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled)), unavailable,
      `${baseline.label}: ${scopedId} must follow the installed package generation`)
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled, [{ options: { id, name }, disabled: false }])), true,
      `${baseline.label}: ${scopedId} must yield to an enabled official row`)
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled, [{ options: { id, name }, disabled: true }])), unavailable,
      `${baseline.label}: a disabled official row does not own ${scopedId}`)
  }

  const commandGoalPatch = tuiPatches.find(row => row?.id === 'command-goal')
  assert.equal(commandGoalPatch?.disabled, shippedOwnsCommandGoal,
    `${baseline.label}: preset owns command-goal`)
  assert.equal(composed.some(row => row?.id === 'dsh-tui-agent-presets'), false)
  assert.equal(composed.some(row => row?.id === 'dsh-tui-code-runtime'), false)

}

console.log(`web coexistence OK (${baselines.map(({ label }) => label).join(' + ')})`)
