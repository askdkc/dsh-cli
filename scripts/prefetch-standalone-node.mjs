import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { standaloneTarget } from './lib/standalone-layout.mjs'

const target = standaloneTarget(process.argv[2] ?? '')
// Use the fetcher and checksum table from the exact pkg version used to bundle.
const pkgRequire = createRequire(import.meta.resolve('@yao-pkg/pkg/package.json'))
const fetchManifest = pkgRequire.resolve('@yao-pkg/pkg-fetch/package.json')
const fetchBin = join(dirname(fetchManifest), pkgRequire(fetchManifest).bin['pkg-fetch'])
const nodeRange = target.name.split('-')[0]
const args = [
  fetchBin,
  '--node-range', nodeRange,
  '--platform', target.os,
  '--arch', target.cpu,
  '--force-fetch',
]

function fetchDirect() {
  execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 45_000 })
}

async function fetchViaReleaseApi() {
  const fetchRequire = createRequire(fetchManifest)
  const { getNodeVersion } = fetchRequire('./lib-es5/index.js')
  const { localPlace, remotePlace } = fetchRequire('./lib-es5/places.js')
  const { toFancyPlatform, toFancyArch } = fetchRequire('./lib-es5/system.js')
  const { EXPECTED_HASHES } = fetchRequire('./lib-es5/expected.js')
  const { hash, plusx } = fetchRequire('./lib-es5/utils.js')
  const binary = {
    version: fetchRequire('./package.json').version,
    nodeVersion: getNodeVersion(nodeRange),
    platform: toFancyPlatform(target.os),
    arch: toFancyArch(target.cpu),
  }
  const { tag, name } = remotePlace(binary)
  const expected = EXPECTED_HASHES[name]
  if (!expected) throw new Error(`No locked checksum for ${name}`)

  const releases = 'https://api.github.com/repos/yao-pkg/pkg-fetch/releases'
  const curl = ['--disable', '--fail', '--silent', '--show-error', '--location']
  const release = JSON.parse(execFileSync('curl', [
    ...curl, '--max-time', '10', `${releases}/tags/${tag}`,
  ], { encoding: 'utf8' }))
  const asset = release.assets.find(asset => asset.name === name)
  if (!Number.isSafeInteger(asset?.id)) throw new Error(`Release ${tag} has no asset for ${name}`)

  const cached = localPlace({ ...binary, from: 'fetched' })
  mkdirSync(dirname(cached), { recursive: true })
  const scratch = mkdtempSync(join(dirname(cached), '.release-api-'))
  try {
    const download = join(scratch, name)
    execFileSync('curl', [
      ...curl, '--max-time', '60', '--header', 'Accept: application/octet-stream',
      '--output', download, `${releases}/assets/${asset.id}`,
    ], { stdio: 'inherit' })
    if (await hash(download) !== expected) throw new Error(`Release API checksum mismatch for ${name}`)
    await plusx(download)
    renameSync(download, cached)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Try a distinct HTTP route after the browser download fails. Keep a final
// direct attempt in case the public API is unavailable or rate-limited.
const attempts = [
  ['pkg-fetch', fetchDirect],
  ['release API', fetchViaReleaseApi],
  ['pkg-fetch', fetchDirect],
]
const failures = []
for (const [route, fetchBinary] of attempts) {
  try {
    await fetchBinary()
    console.log(`Verified prebuilt Node.js for ${target.name} via ${route}`)
    break
  } catch (error) {
    failures.push(error)
    console.warn(`Prebuilt Node.js fetch failed for ${target.name} via ${route}: ${error.code ?? error.message}`)
    if (failures.length === attempts.length) {
      throw new AggregateError(failures, `Could not fetch prebuilt Node.js for ${target.name}`)
    }
    await setTimeout(failures.length * 2_000)
  }
}
