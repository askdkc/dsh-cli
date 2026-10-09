/** Real DSH plugin install/upgrade acceptance, isolated from user profiles. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { satisfies, rcompare, valid, lt } from 'semver'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../', import.meta.url))
const hostDefault = process.argv.includes('--host-default')
const freshInstall = hostDefault || process.argv.includes('--fresh-install')
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
const nativePiFor = async hostDirectory => {
  const hostRequire = createRequire(join(hostDirectory, 'package.json'))
  const adapterManifestPath = hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
  const adapterManifest = JSON.parse(await readFile(adapterManifestPath))
  const adapterRequire = createRequire(adapterManifestPath)
  let pi
  for (const path of adapterRequire.resolve.paths('@earendil-works/pi-ai') ?? []) {
    try { pi = JSON.parse(await readFile(join(path, '@earendil-works/pi-ai/package.json'))); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const range = adapterManifest.dependencies?.['@earendil-works/pi-ai'] ?? adapterManifest.peerDependencies?.['@earendil-works/pi-ai']
  assert(pi?.version && range, 'host must declare and own a pi dependency')
  assert(satisfies(pi.version, range), 'host pi must satisfy its native adapter dependency')
  return pi.version
}
try {
  await mkdir(host)
  if (providedHost) {
    // Use an existing host as a read-only dependency input. Probes, overlays,
    // credentials and profile installs always belong to this disposable tree.
    await writeFile(join(host, 'package.json'), await readFile(join(providedHost, 'package.json')))
    await symlink(join(providedHost, 'node_modules'), join(host, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    await writeFile(join(host, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': 'alpha' } }))
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'])
  }
  const hostPackage = JSON.parse(await readFile(join(host, 'node_modules/@deepseek-ai/dsh/package.json')))
  const nativePiVersion = await nativePiFor(host)
  console.log(`current host: DSH ${hostPackage.version}, native pi ${nativePiVersion}`)
  const cli = join(host, 'node_modules/@deepseek-ai/dsh', hostPackage.bin.dsh)
  const manifest = JSON.parse(await readFile(join(root, 'package.json')))
  const authManifest = JSON.parse(await readFile(join(root, 'dsh-auth', 'package.json')))
  // Packing consumes the same build outputs CI already verified; no source links.
  const packed = run(node, [join(root, 'scripts/with-publish-manifest.mjs'), 'npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], root)
  const tarball = join(directory, JSON.parse(packed)[0].filename)
  // Select the previous published release and a host satisfying its peers,
  // then upgrade the same profile on the current host. Both hosts retain their
  // own native dependencies; no package-version-specific boot expectations.
  const probe = join(host, `probe-${randomUUID()}.mjs`)
  await writeFile(probe, await readFile(new URL('./opencode-profile-probe.mjs', import.meta.url), 'utf8'), { flag: 'wx' })
  probes.push(probe)
  let baselinePlugin
  if (!freshInstall) {
    const published = JSON.parse(run('npm', ['view', manifest.name, 'versions', '--json']))
    const baselineCliVersion = published.filter(version => valid(version) && lt(version, manifest.version)).sort(rcompare)[0]
    assert(baselineCliVersion, 'upgrade acceptance requires an older published CLI release')
    baselinePlugin = `${manifest.name}@${baselineCliVersion}`
    console.log(`rolling upgrade baseline: ${baselinePlugin}`)
    const baselinePeers = JSON.parse(run('npm', ['view', baselinePlugin, 'peerDependencies', '--json']))
    const ranges = Object.entries(baselinePeers)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => range)
    assert(ranges.length, 'the published baseline must declare its DSH host peers')
    const supportsBaseline = version => ranges.every(range => satisfies(version, range, { includePrerelease: true }))
    let baselineVersion = hostPackage.version
    if (!supportsBaseline(baselineVersion)) {
      const versions = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json']))
      baselineVersion = versions.filter(supportsBaseline).sort(rcompare)[0]
      assert.ok(baselineVersion, 'the historical fixture needs a compatible published host')
    }
    const baselineHost = join(directory, 'baseline-host')
    await mkdir(baselineHost)
    await writeFile(join(baselineHost, 'package.json'), JSON.stringify({
      private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': baselineVersion },
    }))
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], baselineHost)
    const previous = JSON.parse(await readFile(join(baselineHost, 'node_modules/@deepseek-ai/dsh/package.json')))
    const baselinePiVersion = await nativePiFor(baselineHost)
    const baselineCli = join(baselineHost, 'node_modules/@deepseek-ai/dsh', previous.bin.dsh)
    run(node, [baselineCli, 'plugin', '--profile', 'dsh-cli', 'add', baselinePlugin], baselineHost)
    // Real profile boot with only the registry, commands and auth enabled. TUI
    // rendering, shells and live API keys are deliberately separate acceptance.
    const baselineProbe = join(baselineHost, `baseline-probe-${randomUUID()}.mjs`)
    await writeFile(baselineProbe, await readFile(new URL('./opencode-profile-probe.mjs', import.meta.url), 'utf8'), { flag: 'wx' })
    probes.push(baselineProbe)
    const baseline = run(node, [baselineProbe], baselineHost, { DSH_AUTH_TEST_PHASE: 'baseline', DSH_AUTH_TEST_EXPECT_PI: baselinePiVersion, DSH_AUTH_TEST_EXPECT_CLI: baselineCliVersion })
    console.log(baseline.split('\n').filter(line => /host-owned pi|profile baseline ready/.test(line)).join('\n'))
    const missingAuth = spawnSync(node, [baselineProbe], {
      cwd: baselineHost, env: { ...env, DSH_AUTH_TEST_PHASE: 'missing-auth', DSH_AUTH_TEST_EXPECT_PI: baselinePiVersion, DSH_AUTH_TEST_EXPECT_CLI: baselineCliVersion },
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(missingAuth.status, 1, 'a profile without auth must fail')
    assert.match(missingAuth.stderr, /must contain exactly one registered auth module/)
    console.log('missing auth rejected before boot')
    // The updated probe must reject the old artifact before boot even if both
    // releases use the same auth row ID. Missing auth is independently rejected
    // by the probe's module-registration check.
    const mismatched = spawnSync(node, [baselineProbe], {
      cwd: baselineHost, env: { ...env, DSH_AUTH_TEST_PHASE: 'updated', DSH_AUTH_TEST_EXPECT_CLI: manifest.version },
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(mismatched.status, 1, 'a profile with the wrong package version must fail')
    assert.match(mismatched.stderr, /profile updated package version must match requested artifact/)
    console.log('baseline auth active; mismatched artifact rejected before boot')
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
  const updated = run(node, [probe], host, { DSH_AUTH_TEST_PHASE: 'updated', DSH_AUTH_TEST_EXPECT_PI: nativePiVersion, DSH_AUTH_TEST_EXPECT_CLI: manifest.version })
  assert.doesNotMatch(updated, /did not activate/)
  console.log(updated.split('\n').filter(line => /host-owned pi|installed auth pi|profile updated ready|passed|failed|FAIL|fixture transport OK/.test(line)).join('\n'))
  run(node, ['--loader', join(root, 'dsh-auth/scripts/reject-pi-loader.mjs'), probe], host, { DSH_AUTH_TEST_PHASE: 'independent', DSH_AUTH_TEST_EXPECT_CLI: manifest.version })
  console.log(`DSH ${hostPackage.version} / native pi ${nativePiVersion}: ${freshInstall ? 'fresh install' : `formal upgrade from ${baselinePlugin}`} to cli ${manifest.version}/auth ${authManifest.version}, all configured routes, pi-free profile and installed wire fixture OK`)
} finally {
  for (const probe of probes) await rm(probe, { force: true })
  await rm(directory, { recursive: true, force: true })
}
