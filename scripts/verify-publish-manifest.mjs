import assert from 'node:assert/strict'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const latestDependencies = Object.fromEntries(['kiokuko-dsh', 'agenticreplay'].map(name => {
  assert.equal(packageManifest.dependencies?.[name], 'latest', `${name} must track the latest dist-tag`)
  return [name, packageManifest.dependencies[name]]
}))
const root = mkdtempSync(join(tmpdir(), 'dsh-publish-manifest-'))
const bundles = ['command', 'connection', 'core', 'manifest', 'messages', 'presentation', 'storage']
const sources = new Map(bundles.map(name => [`@dsh-std/${name}`, `vendor/dsh-std/packages/${name}`]))
sources.set('@askdkc/dsh-auth', 'dsh-auth')
sources.set('dsh-working-activity', 'vendor/dsh-working-activity')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}
try {
  mkdirSync(join(root, 'scripts'))
  cpSync(new URL('./with-publish-manifest.mjs', import.meta.url), join(root, 'scripts/with-publish-manifest.mjs'))
  const manifest = JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { ...Object.fromEntries([...sources.keys()].map(name => [name, 'workspace:*'])), ...latestDependencies } })
  write(join(root, 'package.json'), manifest)
  for (const [name, source] of sources) {
    write(join(root, source, 'package.json'), JSON.stringify({ name, version: '0.1.0', files: ['lib'], dependencies: name === '@dsh-std/core' ? {} : { '@dsh-std/core': 'workspace:*' } }))
    write(join(root, source, 'lib/index.js'), 'export const fixture = true\n')
    const installed = join(root, 'node_modules', name)
    mkdirSync(dirname(installed), { recursive: true })
    symlinkSync(join(root, source), installed, 'dir')
  }
  write(join(root, 'dsh-auth/lib/opencode-owned.generated.js'), 'export const snapshot = "complete"\n')
  write(join(root, 'inspect.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync, lstatSync } from 'node:fs'
const root = JSON.parse(readFileSync('package.json'))
for (const name of ['kiokuko-dsh', 'agenticreplay']) assert.equal(root.dependencies[name], 'latest')
for (const name of ${JSON.stringify([...sources.keys()])}) {
  assert.equal(root.dependencies[name], undefined)
  assert.equal(root.optionalDependencies[name], '0.1.0')
  assert.equal(lstatSync('node_modules/' + name).isSymbolicLink(), false)
  const manifest = JSON.parse(readFileSync('node_modules/' + name + '/package.json'))
  assert.equal(manifest.name, name)
  for (const range of Object.values(manifest.dependencies)) assert.equal(range, '0.1.0')
}
assert.equal(readFileSync('node_modules/@askdkc/dsh-auth/lib/opencode-owned.generated.js', 'utf8'), 'export const snapshot = "complete"\\n')
process.exit(Number(process.argv[2] ?? 0))
`)
  const run = code => spawnSync(process.execPath, ['scripts/with-publish-manifest.mjs', process.execPath, 'inspect.mjs', String(code)], { cwd: root, encoding: 'utf8' })
  const restored = () => {
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), manifest)
    for (const [name, source] of sources) {
      assert.equal(lstatSync(join(root, 'node_modules', name)).isSymbolicLink(), true)
      assert.equal(realpathSync(join(root, 'node_modules', name)), realpathSync(join(root, source)))
      const original = JSON.parse(readFileSync(join(root, source, 'package.json')))
      if (name !== '@dsh-std/core') assert.equal(original.dependencies['@dsh-std/core'], 'workspace:*')
    }
  }
  for (const code of [0, 23]) {
    const result = run(code)
    assert.equal(result.status, code, result.stderr)
    restored()
  }
  const physical = join(root, 'node_modules/@dsh-std/command')
  rmSync(physical)
  write(join(physical, 'package.json'), '{"stale":true}')
  const refused = run(0)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /must be a workspace link/)
  assert.equal(readFileSync(join(physical, 'package.json'), 'utf8'), '{"stale":true}')
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), manifest)
  console.log('publish staging OK (concrete bundle versions, current auth, restoration, stale-copy refusal)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
