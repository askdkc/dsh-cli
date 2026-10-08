/** Real DSH plugin install/upgrade acceptance, isolated from user profiles. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { satisfies, rcompare } from 'semver'
import { randomUUID } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const baselinePlugin = '@askdkc/dsh-cli@0.12.3'
const hostDefault = process.argv.includes('--host-default')
const freshInstall = hostDefault || process.argv.includes('--fresh-install')
const piVersion = process.env.DSH_AUTH_TEST_PI ?? '0.87.1'
assert(['0.87.1', '0.99.1'].includes(piVersion))
const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-profile-'))
const probes = []
const providedHost = process.env.DSH_AUTH_TEST_HOST ? resolve(process.env.DSH_AUTH_TEST_HOST) : undefined
const host = join(directory, 'host')
const home = join(directory, 'home')
const node = process.env.DSH_AUTH_TEST_NODE ?? process.execPath
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), DSH_HOME: home, DSH_AUTH_CREDENTIALS: join(home, 'dsh-auth', 'credentials.json'), DSH_TELEMETRY_DISABLED: '1', CI: 'true' }
const run = (command, args, cwd = host, extra = {}) => {
  console.log(`profile acceptance: ${command} ${args.join(' ')} (cwd=${cwd})`)
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' && (command === 'npm' || command === 'pnpm') })
  if (result.status !== 0) throw new Error(`${command} failed (status=${result.status}, signal=${result.signal}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout + (args.includes('--json') ? '' : result.stderr)
}
try {
  await mkdir(host)
  if (providedHost) {
    // Use an existing host as a read-only dependency input. Probes, overlays,
    // credentials and profile installs always belong to this disposable tree.
    await writeFile(join(host, 'package.json'), await readFile(join(providedHost, 'package.json')))
    await symlink(join(providedHost, 'node_modules'), join(host, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    await writeFile(join(host, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': 'alpha' }, ...(hostDefault ? {} : { overrides: { '@earendil-works/pi-ai': piVersion } }) }))
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'])
  }
  const hostPackage = JSON.parse(await readFile(join(host, 'node_modules/@deepseek-ai/dsh/package.json')))
  const cli = join(host, 'node_modules/@deepseek-ai/dsh', hostPackage.bin.dsh)
  const manifest = JSON.parse(await readFile(join(root, 'package.json')))
  const authManifest = JSON.parse(await readFile(join(root, 'dsh-auth', 'package.json')))
  // Packing consumes the same build outputs CI already verified; no source links.
  const packed = run(node, [join(root, 'scripts/with-publish-manifest.mjs'), 'npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], root)
  const tarball = join(directory, JSON.parse(packed)[0].filename)
  // The historical plugin intentionally retains its old peer contract. Install
  // it on a host selected from that contract, then upgrade the same profile on
  // the current host. Never grant an incompatibility exemption for the fixture.
  const probe = join(host, `probe-${randomUUID()}.mjs`)
  await writeFile(probe, await readFile(new URL('./opencode-profile-probe.mjs', import.meta.url), 'utf8'), { flag: 'wx' })
  probes.push(probe)
  if (!freshInstall) {
    const baselinePeers = JSON.parse(run('npm', ['view', baselinePlugin, 'peerDependencies', '--json']))
    const ranges = Object.entries(baselinePeers)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => range)
    const supportsBaseline = version => ranges.every(range => satisfies(version, range, { includePrerelease: true }))
    let baselineHost = host
    let baselineCli = cli
    if (!supportsBaseline(hostPackage.version)) {
      const versions = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json']))
      const baselineVersion = versions.filter(supportsBaseline).sort(rcompare)[0]
      assert.ok(baselineVersion, 'the historical fixture needs a compatible published host')
      baselineHost = join(directory, 'baseline-host')
      await mkdir(baselineHost)
      await writeFile(join(baselineHost, 'package.json'), JSON.stringify({
        private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': baselineVersion },
        ...(hostDefault ? {} : { overrides: { '@earendil-works/pi-ai': piVersion } }),
      }))
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], baselineHost)
      const previous = JSON.parse(await readFile(join(baselineHost, 'node_modules/@deepseek-ai/dsh/package.json')))
      baselineCli = join(baselineHost, 'node_modules/@deepseek-ai/dsh', previous.bin.dsh)
    }
    run(node, [baselineCli, 'plugin', '--profile', 'dsh-cli', 'add', baselinePlugin], baselineHost)
    // Real profile boot with only the registry, commands and auth enabled. TUI
    // rendering, shells and live API keys are deliberately separate acceptance.
    const baselineProbe = join(baselineHost, `baseline-probe-${randomUUID()}.mjs`)
    await writeFile(baselineProbe, await readFile(new URL('./opencode-profile-probe.mjs', import.meta.url), 'utf8'), { flag: 'wx' })
    probes.push(baselineProbe)
    const baseline = run(node, [baselineProbe], baselineHost, { DSH_AUTH_TEST_PHASE: 'baseline', DSH_AUTH_TEST_PI: piVersion })
    if (piVersion === '0.87.1') assert.match(baseline, /snapshot opencode\/claude-sonnet-5-5.*neither metadata nor a fallback marker/)
  }
  run(node, [cli, 'plugin', '--profile', 'dsh-cli', 'add', `@askdkc/dsh-cli@file:${tarball}`])
  const carrier = join(home, 'profiles', 'dsh-cli', 'node_modules', '@askdkc/dsh-cli')
  const auth = join(carrier, 'node_modules', '@askdkc/dsh-auth')
  assert.equal(JSON.parse(await readFile(join(carrier, 'package.json'))).version, manifest.version)
  assert.equal(JSON.parse(await readFile(join(auth, 'package.json'))).version, authManifest.version)
  assert.equal(JSON.parse(await readFile(join(auth, 'dsh-plugin.json'))).version, authManifest.version)
  // Reuse the fixture authentication/transport suite against the installed
  // package with the host's normal runtime resolver active. Replace only its
  // CLI exit with an exception so the probe can still shut the app down.
  const installedSmoke = join(auth, 'scripts', 'smoke.mjs')
  await mkdir(join(auth, 'scripts'), { recursive: true })
  const smoke = await readFile(join(root, 'dsh-auth/scripts/smoke.mjs'), 'utf8')
  const terminal = 'process.exit(failed === 0 ? 0 : 1)'
  assert(smoke.includes(terminal), 'installed smoke wrapper requires its known CLI exit')
  await writeFile(installedSmoke, smoke.replace(terminal, "if (failed !== 0) throw new Error('installed auth fixtures failed')"))
  await writeFile(join(auth, 'scripts/verify-provider-wire.mjs'), await readFile(join(root, 'dsh-auth/scripts/verify-provider-wire.mjs')))
  const updated = run(node, [probe], host, { DSH_AUTH_TEST_PHASE: 'updated', DSH_AUTH_TEST_PI: hostDefault ? '' : piVersion })
  assert.doesNotMatch(updated, /did not activate/)
  console.log(updated.split('\n').filter(line => /host-owned pi|installed auth pi|profile updated ready|passed|failed|FAIL|fixture transport OK/.test(line)).join('\n'))
  run(node, ['--loader', join(root, 'dsh-auth/scripts/reject-pi-loader.mjs'), probe], host, { DSH_AUTH_TEST_PHASE: 'independent' })
  console.log(`DSH ${hostPackage.version} / pi ${hostDefault ? 'host-owned' : piVersion}: ${freshInstall ? 'fresh install' : 'public baseline, formal upgrade'} to cli ${manifest.version}/auth ${authManifest.version}, 9 routes, pi-free profile and installed wire fixture OK`)
} finally {
  for (const probe of probes) await rm(probe, { force: true })
  await rm(directory, { recursive: true, force: true })
}
