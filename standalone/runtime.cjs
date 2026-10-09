'use strict'
// Metadata and profile ownership shared by the builder, bootstrap and regressions.
const fs = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')

const CLI = '@askdkc/dsh-cli'
const BASE = '@deepseek-ai/dsh-base'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read the installed CLI contract; never infer its entry point from a release. */
function readRuntimeMetadata(runtimeRoot) {
  const dshRoot = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh')
  const dsh = JSON.parse(fs.readFileSync(join(dshRoot, 'package.json'), 'utf8'))
  const cli = JSON.parse(fs.readFileSync(join(runtimeRoot, 'node_modules', CLI, 'package.json'), 'utf8'))
  for (const [name, version] of [['DSH', dsh.version], ['CLI', cli.version]]) {
    if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/u.test(version)) {
      throw new Error(`${name} manifest has no usable version`)
    }
  }
  const bin = typeof dsh.bin === 'string' ? dsh.bin : dsh.bin?.dsh
  if (typeof bin !== 'string' || bin.length === 0 || isAbsolute(bin) || bin.includes('\\')) {
    throw new Error('DSH manifest must declare a relative bin.dsh entry')
  }
  const entry = resolve(dshRoot, bin)
  const inside = relative(dshRoot, entry)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error('DSH bin.dsh escapes its package')
  }
  if (!fs.statSync(entry).isFile()) throw new Error(`DSH CLI entry is not a file: ${entry}`)
  return {
    dshVersion: dsh.version,
    cliVersion: cli.version,
    binPath: relative(runtimeRoot, entry).split(sep).join('/'),
  }
}

function writeAtomic(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, text)
    fs.renameSync(temporary, path)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** Replace only the bootstrap-owned symlink, preserving ordinary directories. */
function replaceRuntimeLink(linkPath, target) {
  let previous
  try {
    const stat = fs.lstatSync(linkPath)
    if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace user-owned directory: ${linkPath}`)
    previous = fs.readlinkSync(linkPath)
    if (resolve(dirname(linkPath), previous) === target) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const next = `${linkPath}.${randomUUID()}.tmp`
  const backup = `${linkPath}.${randomUUID()}.previous`
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(target, next, type)
  let backedUp = false
  try {
    if (previous !== undefined) {
      fs.renameSync(linkPath, backup)
      backedUp = true
    }
    fs.renameSync(next, linkPath)
  } catch (error) {
    if (backedUp) fs.renameSync(backup, linkPath)
    throw error
  } finally {
    fs.rmSync(next, { force: true })
  }
  if (backedUp) fs.unlinkSync(backup)
}

/** Migrate generated profiles; validate all user state before the first write. */
function ensureProfile({ home, runtimeRoot, cliVersion, profile = 'dsh-cli' }) {
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const linkPath = join(profileDir, 'node_modules')
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { name: 'dsh-profile-dsh-cli-standalone', private: true }
  if (!object(manifest) || (manifest.dependencies !== undefined && !object(manifest.dependencies))
    || (manifest.dsh !== undefined && !object(manifest.dsh))
    || (manifest.dsh?.profile !== undefined && !object(manifest.dsh.profile))) {
    throw new Error(`Invalid standalone profile manifest: ${manifestPath}`)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
    throw new Error(`Invalid standalone profile bundles: ${manifestPath}`)
  }
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) throw new Error(`Refusing to replace user-owned directory: ${linkPath}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let resetPatch = !fs.existsSync(patchPath)
  if (!bundles.includes(CLI) && !resetPatch) {
    const patch = fs.readFileSync(patchPath, 'utf8')
    const previousPatch = join(linkPath, CLI, 'cordis.patch.yml')
    if (patch.trim() === '[]' || (fs.existsSync(previousPatch) && patch === fs.readFileSync(previousPatch, 'utf8'))) {
      resetPatch = true
    } else {
      throw new Error(`Standalone migration preserved your edited patch: ${patchPath}. `
        + `Move only your custom overrides into that file and add ${CLI} to dsh.profile.bundles in ${manifestPath}, then restart.`)
    }
  }
  const nextBundles = bundles.filter((name, index) =>
    (name !== BASE && name !== CLI) || bundles.indexOf(name) === index)
  if (!nextBundles.includes(BASE)) nextBundles.unshift(BASE)
  if (!nextBundles.includes(CLI)) nextBundles.splice(nextBundles.indexOf(BASE) + 1, 0, CLI)
  const next = {
    ...manifest,
    dependencies: { ...manifest.dependencies, [CLI]: cliVersion },
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: nextBundles,
      },
    },
  }
  fs.mkdirSync(profileDir, { recursive: true })
  if (resetPatch) writeAtomic(patchPath, '[]\n')
  writeAtomic(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  replaceRuntimeLink(linkPath, join(runtimeRoot, 'node_modules'))
  return profileDir
}

module.exports = { readRuntimeMetadata, ensureProfile }
