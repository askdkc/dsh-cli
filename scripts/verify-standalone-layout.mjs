import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standaloneTarget, stageStandaloneLauncher, pruneForeignPackages, prepareTargetPty } from './lib/standalone-layout.mjs'

for (const [name, os, cpu] of [
  ['node24-linux-x64', 'linux', 'x64'], ['node24-linux-arm64', 'linux', 'arm64'],
  ['node24-macos-x64', 'darwin', 'x64'], ['node24-macos-arm64', 'darwin', 'arm64'],
  ['node24-win-x64', 'win32', 'x64'],
]) assert.deepEqual(standaloneTarget(name), { name, os, cpu })
for (const name of ['', 'node24-win-arm64', 'node24-linux-x64,garbage', '../node24-linux-x64']) {
  assert.throws(() => standaloneTarget(name), /Unsupported standalone target/)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-launcher-layout-'))
try {
  const runtime = join(root, 'runtime')
  const launcher = join(root, 'launcher')
  mkdirSync(runtime)
  const files = ['entry.cjs', 'runtime.cjs', 'cacheGuard.cjs', 'extractRuntime.cjs', 'runtime-meta.json', 'runtime.tar.gz', 'pkg.config.json']
  for (const name of files) writeFileSync(join(runtime, name), name)
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ dependencies: { 'unexpected-runtime-dependency': '*' } }))
  stageStandaloneLauncher(runtime, launcher)
  for (const name of files) assert.equal(readFileSync(join(launcher, name), 'utf8'), name)
  const manifest = JSON.parse(readFileSync(join(launcher, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['tar'])
  assert.deepEqual(readdirSync(join(launcher, 'node_modules')), ['tar'])
  const require = createRequire(join(launcher, 'entry.cjs'))
  assert.equal(typeof require('tar').x, 'function')
  assert.throws(() => require.resolve('unexpected-runtime-dependency'), { code: 'MODULE_NOT_FOUND' })
  assert.throws(() => require.resolve('@deepseek-ai/dsh'), { code: 'MODULE_NOT_FOUND' })
  const modules = join(runtime, 'node_modules')
  for (const [name, constraints] of [
    ['@native/linux', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }],
    ['@native/mac', { os: ['darwin'], cpu: ['arm64'] }],
    ['@native/musl', { os: ['linux'], libc: ['musl'] }],
    ['@native/arm', { cpu: ['arm64'] }], ['no-linux', { os: ['!linux'] }],
    ['universal', {}], ['universal/node_modules/foreign', { os: ['win32'] }],
  ]) {
    const directory = join(modules, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify(constraints))
  }
  assert.equal(pruneForeignPackages(modules, standaloneTarget('node24-linux-x64')), 5)
  assert.deepEqual(readdirSync(join(modules, '@native')), ['linux'])
  assert.equal(JSON.parse(readFileSync(join(modules, 'universal/package.json'), 'utf8')).os, undefined)
  assert.equal(pruneForeignPackages(modules, standaloneTarget('node24-linux-x64')), 0)
  // Linux and Windows distributions have no spawn-helper and must still build.
  prepareTargetPty(runtime, standaloneTarget('node24-linux-x64'))
  prepareTargetPty(runtime, standaloneTarget('node24-linux-arm64'))
  prepareTargetPty(runtime, standaloneTarget('node24-win-x64'))
  const helper = join(modules, 'node-pty/prebuilds/darwin-arm64/spawn-helper')
  mkdirSync(join(modules, 'node-pty/prebuilds/darwin-arm64'), { recursive: true })
  writeFileSync(helper, 'fixture', { mode: 0o644 })
  prepareTargetPty(runtime, standaloneTarget('node24-macos-arm64'))
  if (process.platform !== 'win32') assert.equal(statSync(helper).mode & 0o777, 0o755)
  assert.throws(() => prepareTargetPty(runtime, standaloneTarget('node24-macos-x64')))
  const external = join(root, 'external')
  mkdirSync(join(external, 'node_modules/foreign'), { recursive: true })
  writeFileSync(join(external, 'package.json'), '{}')
  writeFileSync(join(external, 'node_modules/foreign/package.json'), '{"os":["win32"]}')
  symlinkSync(external, join(modules, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(pruneForeignPackages(modules, standaloneTarget('node24-linux-x64')), 0)
  assert.equal(readFileSync(join(external, 'node_modules/foreign/package.json'), 'utf8'), '{"os":["win32"]}')
  console.log('standalone layout OK (five targets, isolated bootstrap, runtime graph excluded, tar closure resolves)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
