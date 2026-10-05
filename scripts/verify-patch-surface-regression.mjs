/** Exercise the production patch verifiers against release-independent source fixtures. */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-patch-regression-'))
const tui = join(scratch, 'tui')
const source = join(scratch, 'deepseek-harness')
const web = join(source, 'packages/bundle/web-app')
const base = join(source, 'packages/bundle/base')
const installedPatch = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')), 'utf8')
const installedManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json')), 'utf8'))
const env = { ...process.env, DSH_HARNESS_SOURCE_ROOT: source, DSH_REQUIRE_UPSTREAM_BASELINE: '1' }
const run = (script, extraEnv = {}, args = []) => spawnSync(process.execPath,
  ['--import', 'tsx/esm', join(tui, 'scripts', script), ...args],
  { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 })
const check = (script, pass, pattern, extraEnv, args) => {
  const result = run(script, extraEnv, args)
  assert.equal(result.status === 0, pass, result.stdout + result.stderr)
  if (pattern) assert.match(result.stdout + result.stderr, pattern)
}
try {
  for (const path of [join(tui, 'scripts'), join(web, 'presets'), base]) mkdirSync(path, { recursive: true })
  writeFileSync(join(tui, 'package.json'), JSON.stringify({ type: 'module' }))
  symlinkSync(join(root, 'node_modules'), join(tui, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of ['scripts/verify-patch-surface.ts', 'scripts/verify-web-coexistence.mjs', 'cordis.patch.yml', 'patch-surface.snapshot.json']) {
    copyFileSync(join(root, path), join(tui, path))
  }
  copyFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')), join(web, 'presets/standard.patch.yml'))
  writeFileSync(join(base, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(web, 'cordis.patch.yml'), installedPatch)
  for (const version of ['0.1.7-rc.2', '0.2.1-alpha', '0.2.2-alpha.7', '99.0.0', installedManifest.version]) {
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version }))
    check('verify-patch-surface.ts', true)
    check('verify-web-coexistence.mjs', true)
  }
  // Same release label may describe different harmless Web-only additions.
  writeFileSync(join(web, 'cordis.patch.yml'), `${installedPatch}\n- insert:\n    - id: web-only-future-feature\n      name: test-feature\n`)
  check('verify-patch-surface.ts', true)
  writeFileSync(join(web, 'cordis.patch.yml'), `${installedPatch}\n- insert:\n    - id: dsh-tui\n      name: conflicting-plugin\n`)
  check('verify-patch-surface.ts', false, /insertsSharedWithWebApp/)
  check('verify-web-coexistence.mjs', false, /reuses official loader ids/)
  const before = readFileSync(join(tui, 'patch-surface.snapshot.json'), 'utf8')
  check('verify-patch-surface.ts', false, /insertsSharedWithWebApp/, {}, ['--snapshot'])
  assert.equal(readFileSync(join(tui, 'patch-surface.snapshot.json'), 'utf8'), before)
  writeFileSync(join(web, 'cordis.patch.yml'), `${installedPatch}\n- id: unexpected-web-disable\n  disabled: true\n`)
  check('verify-patch-surface.ts', false, /webAppDisablesBeyondTui/)
  writeFileSync(join(web, 'cordis.patch.yml'), installedPatch)
  writeFileSync(join(tui, 'cordis.patch.yml'), `${readFileSync(join(root, 'cordis.patch.yml'), 'utf8')}\n- id: unexpected-tui-disable\n  disabled: true\n`)
  check('verify-patch-surface.ts', false, /disablesBeyondWebApp/)
  copyFileSync(join(root, 'cordis.patch.yml'), join(tui, 'cordis.patch.yml'))
  const snapshot = JSON.parse(before)
  snapshot.inserts.pop()
  writeFileSync(join(tui, 'patch-surface.snapshot.json'), JSON.stringify(snapshot))
  check('verify-patch-surface.ts', false, /TUI inserts/)
  writeFileSync(join(tui, 'patch-surface.snapshot.json'), before)
  rmSync(source, { recursive: true })
  for (const script of ['verify-patch-surface.ts', 'verify-web-coexistence.mjs']) {
    check(script, false, /required source baseline missing/)
    check(script, false, /required source baseline missing/, { DSH_REQUIRE_UPSTREAM_BASELINE: '0' })
    check(script, true, undefined, { DSH_HARNESS_SOURCE_ROOT: undefined, DSH_REQUIRE_UPSTREAM_BASELINE: '0' })
  }
  console.log('patch-surface regression OK (release labels, ownership failures, snapshot guard, source presence)')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
