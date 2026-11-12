/** Real DSH plugin install/upgrade acceptance, isolated from user profiles. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { satisfies, parse, lt } from 'semver'
import { c as createTar, x as extractTar } from 'tar'
import YAML from 'yaml'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { declineUndecidedKiokukoBuild, isUndecidedKiokukoBuild } from './opencode-profile-build-policy.mjs'
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
async function packBaseline(tarball, candidateVersion) {
  // Change only the package version so the probe can distinguish a stale
  // install from the candidate without fetching a historical release.
  const { major, minor, patch } = parse(candidateVersion)
  const prerelease = `${major}.${minor}.${patch}-0`
  const version = lt(prerelease, candidateVersion) ? prerelease : '0.0.0-0'
  assert(lt(version, candidateVersion), 'upgrade fixture version must precede the candidate')
  const staging = join(directory, 'baseline')
  await mkdir(staging)
  await extractTar({ file: tarball, cwd: staging, strict: true })
  const path = join(staging, 'package', 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  const file = join(directory, 'baseline.tgz')
  await createTar({ file, cwd: staging, gzip: true, portable: true, strict: true }, ['package'])
  return { file, version }
}

async function installProfile(cli, name, tarball, initialInstall) {
  const installArgs = [cli, 'plugin', '--profile', 'dsh-cli', 'add', `${name}@file:${tarball}`]
  try {
    run(node, installArgs)
  } catch (error) {
    // Exercise the documented user choice, not a pre-seeded install policy.
    // Any other failure or additional undecided package still fails acceptance.
    if (!(error instanceof Error) || !isUndecidedKiokukoBuild(error.message)) throw error
    const profile = join(home, 'profiles', 'dsh-cli')
    const policyPath = join(profile, 'pnpm-workspace.yaml')
    const before = YAML.parse(await readFile(policyPath, 'utf8'))
    const allowBuilds = declineUndecidedKiokukoBuild(before.allowBuilds)
    console.log('profile acceptance: explicitly decline optional Kiokuko Lisp compilation, then retry installation')
    run('pnpm', ['config', 'set', '--location=project', '--json', 'allowBuilds', JSON.stringify(allowBuilds)], profile)
    const after = YAML.parse(await readFile(policyPath, 'utf8'))
    assert.deepEqual(after, { ...before, allowBuilds: { ...before.allowBuilds, 'kiokuko-dsh': false } }, 'preserve every other profile policy')
    // A failed first add can leave a plain dependency that a second add does
    // not activate. Recover via the public command, never inject bundle rows.
    const installedProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    if (initialInstall && !installedProfile.dsh?.profile?.bundles?.includes(name)) {
      run(node, [cli, 'plugin', '--profile', 'dsh-cli', 'remove', name])
    }
    run(node, installArgs)
  }
}

try {
  await mkdir(host)
  if (providedHost) {
    // Use an existing host as a read-only dependency input. Probes, overlays,
    // credentials and profile installs always belong to this disposable tree.
    await writeFile(join(host, 'package.json'), await readFile(join(providedHost, 'package.json')))
    await symlink(join(providedHost, 'node_modules'), join(host, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    await writeFile(join(host, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': process.env.DSH_AUTH_TEST_VERSION ?? 'alpha' } }))
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'])
  }
  const hostPackage = JSON.parse(await readFile(join(host, 'node_modules/@deepseek-ai/dsh/package.json')))
  if (process.env.DSH_AUTH_TEST_VERSION) assert.equal(hostPackage.version, process.env.DSH_AUTH_TEST_VERSION)
  const nativePiVersion = await nativePiFor(host)
  console.log(`current host: DSH ${hostPackage.version}, native pi ${nativePiVersion}`)
  const cli = join(host, 'node_modules/@deepseek-ai/dsh', hostPackage.bin.dsh)
  const manifest = JSON.parse(await readFile(join(root, 'package.json')))
  const authManifest = JSON.parse(await readFile(join(root, 'dsh-auth', 'package.json')))
  // Packing consumes the same build outputs CI already verified; no source links.
  const packed = run(node, [join(root, 'scripts/with-publish-manifest.mjs'), 'npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], root)
  const tarball = join(directory, JSON.parse(packed)[0].filename)
  const probe = join(host, `probe-${randomUUID()}.mjs`)
  await writeFile(probe, await readFile(new URL('./opencode-profile-probe.mjs', import.meta.url), 'utf8'), { flag: 'wx' })
  probes.push(probe)
  if (!freshInstall) {
    const { file, version } = await packBaseline(tarball, manifest.version)
    await installProfile(cli, manifest.name, file, true)
    // Boot only the registry, commands and auth on the installed baseline.
    const baseline = run(node, [probe], host, { DSH_AUTH_TEST_PHASE: 'baseline', DSH_AUTH_TEST_EXPECT_PI: nativePiVersion, DSH_AUTH_TEST_EXPECT_CLI: version })
    console.log(baseline.split('\n').filter(line => /host-owned pi|profile baseline ready/.test(line)).join('\n'))
    const missingAuth = spawnSync(node, [probe], {
      cwd: host, env: { ...env, DSH_AUTH_TEST_PHASE: 'missing-auth', DSH_AUTH_TEST_EXPECT_PI: nativePiVersion, DSH_AUTH_TEST_EXPECT_CLI: version },
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(missingAuth.status, 1, 'a profile without auth must fail')
    assert.match(missingAuth.stderr, /must contain exactly one registered auth module/)
    console.log('missing auth rejected before boot')
    // The updated probe must reject the old artifact before boot even if both
    // artifacts use the same auth row ID. Missing auth is independently rejected
    // by the probe's module-registration check.
    const mismatched = spawnSync(node, [probe], {
      cwd: host, env: { ...env, DSH_AUTH_TEST_PHASE: 'updated', DSH_AUTH_TEST_EXPECT_CLI: manifest.version },
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(mismatched.status, 1, 'a profile with the wrong package version must fail')
    assert.match(mismatched.stderr, /profile updated package version must match requested artifact/)
    console.log('baseline auth active; mismatched artifact rejected before boot')
  }
  await installProfile(cli, manifest.name, tarball, freshInstall)
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
  console.log(run(node, [join(root, 'scripts/verify-opencode-profile-lifecycle.mjs'), host, cli]))
  console.log(`DSH ${hostPackage.version} / native pi ${nativePiVersion}: ${freshInstall ? 'fresh install' : 'upgrade from generated baseline'} to cli ${manifest.version}/auth ${authManifest.version}, all configured routes, pi-free profile and installed wire fixture OK`)
} finally {
  for (const probe of probes) await rm(probe, { force: true })
  await rm(directory, { recursive: true, force: true })
}
