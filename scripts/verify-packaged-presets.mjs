import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { packagedPresetRoot } from '../lib/types/dsh-adapter/packaged-presets.js'

// The source and npm layouts must both resolve the shipped assets.
const root = fileURLToPath(new URL('../presets', import.meta.url))
assert.equal(packagedPresetRoot(), root)
assert.equal(packagedPresetRoot(new URL('../src/dsh-adapter/packaged-presets.ts', import.meta.url).href), root)
const liangshen = parse(readFileSync(join(root, 'liangshen', 'agent.cordis.yml'), 'utf8'), { logLevel: 'silent' })
assert.ok(Array.isArray(liangshen))
// Resolve the shipped delegation rows against the installed host API. A removed
// subpath must fail here, before the standalone TUI tries to create its agent.
const controls = liangshen.find(row => row.id === 'delegation').config
  .filter(row => !row.disabled && row.name.startsWith('@deepseek-ai/dsh-tool-subagent-control'))
assert.ok(controls.length > 0, 'the shipped preset includes subagent controls')
for (const row of controls) {
  assert.equal(typeof import.meta.resolve(row.name), 'string', `${row.id} must resolve`)
}
const metadata = parse(readFileSync(join(root, 'liangshen', 'preset.yml'), 'utf8'))
assert.equal(typeof metadata.name, 'string')
assert.equal(typeof metadata.description, 'string')
console.log('packaged preset assets OK (source and npm layouts)')
