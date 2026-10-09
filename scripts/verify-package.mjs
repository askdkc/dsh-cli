import { readFile } from 'node:fs/promises'

const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

const reports = JSON.parse(input)
// npm 10 emits an array while npm 11 emits an object keyed by package name.
const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error('npm pack did not return a package file list')
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (manifest.bin?.['dsh-cli'] !== './bin/dsh-cli.js') {
  throw new Error('package must expose the dsh-cli command through the launcher')
}
if (Object.keys(manifest.bin).join() !== 'dsh-cli') throw new Error('legacy command aliases must not ship')
const packed = new Set(report.files.map(file => file.path.replaceAll('\\', '/')))
if (packed.has('bin/dsh-tui.js')) throw new Error('legacy launcher must not ship')
const targets = new Set()

const addTarget = value => {
  if (typeof value === 'string') targets.add(value.replace(/^\.\//u, ''))
}

addTarget(manifest.main)
addTarget(manifest.types)
for (const target of Object.values(manifest.bin ?? {})) addTarget(target)

const collectExports = value => {
  if (typeof value === 'string') {
    addTarget(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)

const missing = [...targets].filter(target => !packed.has(target))
if (missing.length > 0) {
  throw new Error(`package exports missing from tarball: ${missing.join(', ')}`)
}
for (const presetFile of [
  'presets/response-language.txt',
  'presets/liangshen/agent.cordis.yml',
  'presets/liangshen/preset.yml',
  'presets/liangshen/tool-bootstrap.mjs',
]) {
  if (!packed.has(presetFile)) throw new Error(`packaged preset file missing from tarball: ${presetFile}`)
}
for (const path of packed) {
  const lower = path.toLowerCase()
  if (lower.includes('plugin-spec/')
    || /dsh-adapter\/(?:grants|host-descriptor)(?:\.|$)/u.test(lower)) {
    throw new Error(`npm package contains legacy compat shim (case-insensitive): ${path}`)
  }
}
if ([...packed].some(path => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if ([...packed].some(path => path.startsWith('skills/') || path.startsWith('.agents/skills/'))) {
  throw new Error('npm package unexpectedly contains developer skills')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}

// The publish helper rewrites only known bundled workspace links; any other
// `workspace:` range would land in the tarball and kill `dsh plugin add`
// in the profile workspace
// (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND). Bundled manifests must also use concrete
// ranges: npm resolves them when updating an existing installation.
// Workspace helpers (e.g. vendor/sqlite-island) are reached by
// relative import instead of a manifest entry.
const bundled = new Set(manifest.bundledDependencies ?? manifest.bundleDependencies ?? [])
for (const path of [
  'node_modules/@askdkc/dsh-auth/package.json',
  'node_modules/@askdkc/dsh-auth/lib/index.js',
  'node_modules/@askdkc/dsh-auth/lib/opencode-owned.generated.js',
  'node_modules/@askdkc/dsh-auth/lib/opencode-sdk.js',
  'node_modules/@askdkc/dsh-auth/lib/THIRD_PARTY_NOTICES.txt',
  'node_modules/@askdkc/dsh-auth/lib/opencode-adapter.js',
  'node_modules/@askdkc/dsh-auth/lib/opencode-catalog.js',
]) {
  if (!bundled.has('@askdkc/dsh-auth') || !packed.has(path)) {
    throw new Error(`bundled dsh-auth missing from tarball: ${path}`)
  }
}
for (const path of [
  'node_modules/dsh-working-activity/package.json',
  'node_modules/dsh-working-activity/lib/types/frames.js',
  'node_modules/dsh-working-activity/lib/types/lang.js',
  'node_modules/dsh-working-activity/lib/types/projection.js',
]) {
  if (!bundled.has('dsh-working-activity') || !packed.has(path)) {
    throw new Error(`bundled working-activity fork missing from tarball: ${path}`)
  }
}
for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(manifest[section] ?? {})) {
    if (typeof range === 'string' && range.startsWith('workspace:') && !bundled.has(name)) {
      throw new Error(`manifest ${section}.${name} uses the ${range} protocol on a non-bundled package, which must never ship (reach workspace helpers by relative import)`)
    }
  }
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-cli-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
