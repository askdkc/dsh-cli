import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { standaloneTarget } from './lib/standalone-layout.mjs'

const target = standaloneTarget(process.argv[2] ?? '')
// Use the fetcher and checksum table from the exact pkg version used to bundle.
const pkgRequire = createRequire(import.meta.resolve('@yao-pkg/pkg/package.json'))
const fetchManifest = pkgRequire.resolve('@yao-pkg/pkg-fetch/package.json')
const fetchBin = join(dirname(fetchManifest), pkgRequire(fetchManifest).bin['pkg-fetch'])
const args = [
  fetchBin,
  '--node-range', target.name.split('-')[0],
  '--platform', target.os,
  '--arch', target.cpu,
  '--force-fetch',
]
const attempts = 3
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 45_000 })
    console.log(`Verified prebuilt Node.js for ${target.name}`)
    break
  } catch (error) {
    if (attempt === attempts) {
      throw new Error(`Could not fetch prebuilt Node.js for ${target.name} after ${attempts} attempts`, { cause: error })
    }
    console.warn(`Prebuilt Node.js fetch failed for ${target.name} (attempt ${attempt}/${attempts}). Retrying.`)
    await setTimeout(attempt * 2_000)
  }
}
