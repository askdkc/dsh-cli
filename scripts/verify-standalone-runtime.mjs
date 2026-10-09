/** Bootstrap, profile migration and CLI handoff through the actual standalone entry. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createStandaloneArchive } from './lib/standalone-archive.mjs'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeMetadata, ensureProfile } from '../standalone/runtime.cjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-standalone-runtime-'))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`) }
const link = (from, to) => symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
const tui = '@askdkc/dsh-cli'
function fixture(name, version, bin = 'bin/start.mjs') {
  const runtimeRoot = join(scratch, name)
  write(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'), { name: '@deepseek-ai/dsh', version, type: 'module', bin: { dsh: bin } })
  write(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh', bin), 'export async function runCli() { console.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.DSH_HOME })) }\n')
  write(join(runtimeRoot, 'node_modules', tui, 'package.json'), { name: tui, version: '9.0.0' })
  write(join(runtimeRoot, 'node_modules', tui, 'cordis.patch.yml'), '- insert: []\n')
  return runtimeRoot
}
try {
  const oldRuntime = fixture('old', '0.1.7-rc.2')
  const runtimeRoot = fixture('new', '0.2.1-alpha', 'cli/launch.mjs')
  const metadata = readRuntimeMetadata(runtimeRoot)
  assert.equal(metadata.binPath, 'node_modules/@deepseek-ai/dsh/cli/launch.mjs')
  assert.equal(metadata.dshVersion, '0.2.1-alpha')
  const home = join(scratch, 'home')
  const options = { home, runtimeRoot, cliVersion: metadata.cliVersion }
  const profile = ensureProfile(options)
  const manifestPath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(readManifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base', tui])
  assert.equal(readFileSync(patchPath, 'utf8'), '[]\n')
  write(manifestPath, { ...readManifest(), custom: 'preserve', dsh: { feature: true, profile: { bundles: ['user-bundle', '@deepseek-ai/dsh-base', tui, tui], custom: true } } })
  write(patchPath, '- id: user-override\n  disabled: true\n')
  write(join(home, 'sessions/keep.json'), 'session-data')
  ensureProfile({ ...options, cliVersion: '9.1.0' })
  assert.equal(readManifest().custom, 'preserve')
  assert.equal(readManifest().dsh.feature, true)
  assert.equal(readManifest().dsh.profile.custom, true)
  assert.deepEqual(readManifest().dsh.profile.bundles, ['user-bundle', '@deepseek-ai/dsh-base', tui])
  assert.equal(readManifest().dependencies[tui], '9.1.0')
  assert.equal(readFileSync(patchPath, 'utf8'), '- id: user-override\n  disabled: true\n')
  assert.equal(readFileSync(join(home, 'sessions/keep.json'), 'utf8'), 'session-data')

  for (const edited of [false, true]) {
    const legacyHome = join(scratch, `legacy-${edited}`)
    const directory = join(legacyHome, 'profiles/dsh-cli')
    const manifest = { custom: 'keep', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
    write(join(directory, 'package.json'), manifest)
    const oldPatch = readFileSync(join(oldRuntime, 'node_modules', tui, 'cordis.patch.yml'), 'utf8') + (edited ? '# user edit\n' : '')
    write(join(directory, 'cordis.patch.yml'), oldPatch)
    link(join(oldRuntime, 'node_modules'), join(directory, 'node_modules'))
    if (edited) {
      assert.throws(() => ensureProfile({ ...options, home: legacyHome }), /preserved your edited patch/)
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), manifest)
      assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), oldPatch)
      assert.equal(readlinkSync(join(directory, 'node_modules')), join(oldRuntime, 'node_modules'))
    } else {
      ensureProfile({ ...options, home: legacyHome })
      assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), '[]\n')
      assert.equal(readlinkSync(join(directory, 'node_modules')), join(runtimeRoot, 'node_modules'))
    }
  }
  const userHome = join(scratch, 'user-dir')
  mkdirSync(join(userHome, 'profiles/dsh-cli/node_modules'), { recursive: true })
  assert.throws(() => ensureProfile({ ...options, home: userHome }), /user-owned directory/)
  assert.equal(existsSync(join(userHome, 'profiles/dsh-cli/package.json')), false)

  const dshManifest = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json')
  const validManifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  for (const bin of ['../../../outside.js', '/absolute.js', '']) {
    write(dshManifest, { ...validManifest, bin: { dsh: bin } })
    assert.throws(() => readRuntimeMetadata(runtimeRoot), /bin.dsh/)
  }
  write(dshManifest, validManifest)

  const stage = join(scratch, 'stage')
  mkdirSync(stage)
  for (const name of ['entry.cjs', 'runtime.cjs', 'cacheGuard.cjs', 'extractRuntime.cjs']) copyFileSync(join(root, 'standalone', name), join(stage, name))
  link(join(root, 'node_modules'), join(stage, 'node_modules'))
  write(join(stage, 'runtime-meta.json'), { ...metadata, bundleId: 'fixture-alpha' })
  createStandaloneArchive(join(stage, 'runtime.tar.gz'), runtimeRoot, ['node_modules'])
  const cache = join(scratch, 'bootstrap-cache')
  const env = { ...process.env, PATH: '', DSH_CLI_STANDALONE_CACHE: cache, DSH_CLI_STANDALONE_HOME: join(scratch, 'bootstrap-home') }
  const run = () => spawnSync(process.execPath, [join(stage, 'entry.cjs'), '--help'], { env, encoding: 'utf8', timeout: 30000 })
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).argv, ['--profile', 'dsh-cli', '--help'])
    assert.equal(JSON.parse(result.stdout).home, env.DSH_CLI_STANDALONE_HOME)
  }
  write(join(cache, 'fixture-alpha', metadata.binPath), 'throw new Error("tampered")\n')
  assert.equal(run().status, 0, 'manifest-derived entry must be hashed and restored')
  write(join(runtimeRoot, metadata.binPath), 'export const noCli = true\n')
  createStandaloneArchive(join(stage, 'runtime.tar.gz'), runtimeRoot, ['node_modules'])
  write(join(stage, 'runtime-meta.json'), { ...metadata, bundleId: 'fixture-missing-cli' })
  const missing = run()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no runCli\(\) entry/)
  console.log('standalone runtime OK (bootstrap handoff, migration, preserved settings, metadata and cache integrity)')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
