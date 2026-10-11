/** Clean tarball consumer. Explicit host versions; no checkout links/overrides.
 * Usage: node scripts/verify-code-intelligence-package.mjs <cli.tgz> <provider.tgz>
 * Requires network unless these exact packages are already in the pnpm store. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url)
const require = createRequire(new URL('../package.json', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(process.argv.length, 4, 'supply absolute CLI and provider tarball paths')
const archives = await Promise.all(process.argv.slice(2).map(path => realpath(resolve(path))))
const home = await mkdtemp(join(tmpdir(), 'dsh-code-package-'))
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 180_000, env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, 'dsh') } })
  if (result.error) throw result.error
  return result.status ?? 1
}
try {
  const dependencies = {}
  const hostPackages = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))
  for (const name of new Set([...Object.keys(manifest.peerDependencies ?? {}), ...hostPackages, 'yaml'])) {
    dependencies[name] = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version
  }
  dependencies['@askdkc/dsh-cli'] = `file:${archives[0]}`
  dependencies['@askdkc/dsh-lsp-server'] = `file:${archives[1]}`
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'dsh-code-tarball-fixture', private: true, type: 'module', packageManager: manifest.packageManager, dependencies }, null, 2))
  await writeFile(join(home, 'pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: false\nminimumReleaseAge: 0\n')
  assert.equal(run('pnpm', ['install', '--ignore-scripts'], home), 0, 'clean consumer installation')
  assert.equal(run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], home), 0, 'repeat installation retains exact resolution')
  const installed = join(home, 'node_modules/@askdkc/dsh-cli')
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).name, '@askdkc/dsh-cli')
  assert.equal(run(process.execPath, [new URL('scripts/verify-code-intelligence-host.mjs', root).pathname, installed], home), 0, 'installed bundle and compiled CLI must pass full acceptance')
  console.log('code-intelligence tarball consumer OK')
} finally {
  await rm(home, { recursive: true, force: true })
}
