import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function standaloneTarget(name) {
  const match = /^node\d+-(linux|macos|win)-(x64|arm64)$/u.exec(name)
  if (!match || (match[1] === 'win' && match[2] !== 'x64')) throw new Error(`Unsupported standalone target: ${name}`)
  return { name, os: { linux: 'linux', macos: 'darwin', win: 'win32' }[match[1]], cpu: match[2] }
}

/** node-pty's macOS helper needs chmod when packaged on another build host. */
export function prepareTargetPty(runtimeRoot, target) {
  const pty = join(runtimeRoot, 'node_modules/node-pty')
  if (target.os === 'darwin') {
    const prebuilt = join(pty, 'prebuilds', `${target.os}-${target.cpu}`, 'spawn-helper')
    const helper = existsSync(prebuilt) ? prebuilt : join(pty, 'build/Release/spawn-helper')
    if (!existsSync(prebuilt) && (target.os !== process.platform || target.cpu !== process.arch)) {
      throw new Error(`Missing node-pty prebuild for ${target.name}`)
    }
    chmodSync(helper, 0o755)
  }
}

/** Remove foreign platform packages from the builder-owned hoisted runtime. */
export function pruneForeignPackages(modules, target) {
  const accepts = (values, value) => !Array.isArray(values) || (
    !values.includes(`!${value}`) && (values.includes(value) || values.includes('any') || values.every(item => item.startsWith('!')))
  )
  let removed = 0
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const parent = join(modules, entry.name)
    if (entry.name.startsWith('@') && entry.isSymbolicLink()) throw new Error(`Unexpected linked package scope: ${parent}`)
    const packages = entry.name.startsWith('@') ? readdirSync(parent).map(name => join(parent, name)) : [parent]
    for (const directory of packages) {
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (!accepts(manifest.os, target.os) || !accepts(manifest.cpu, target.cpu) || (target.os === 'linux' && !accepts(manifest.libc, 'glibc'))) {
        rmSync(directory, { recursive: true, force: true })
        removed++
      } else if (!lstatSync(directory).isSymbolicLink() && existsSync(join(directory, 'node_modules')) && !lstatSync(join(directory, 'node_modules')).isSymbolicLink()) {
        removed += pruneForeignPackages(join(directory, 'node_modules'), target)
      }
    }
  }
  return removed
}

/** pkg must see the bootstrap's dependencies, never the host's package manifest. */
export function stageStandaloneLauncher(runtimeRoot, launcherRoot) {
  mkdirSync(launcherRoot, { recursive: true })
  for (const name of ['entry.cjs', 'runtime.cjs', 'cacheGuard.cjs', 'extractRuntime.cjs', 'runtime-meta.json', 'runtime.tar.gz', 'pkg.config.json']) {
    copyFileSync(join(runtimeRoot, name), join(launcherRoot, name))
  }
  const tarRoot = dirname(fileURLToPath(import.meta.resolve('tar/package.json')))
  const tar = JSON.parse(readFileSync(join(tarRoot, 'package.json'), 'utf8'))
  writeFileSync(join(launcherRoot, 'package.json'), JSON.stringify({
    name: 'dsh-cli-standalone-launcher', private: true, dependencies: { tar: tar.version },
  }, null, 2) + '\n')
  mkdirSync(join(launcherRoot, 'node_modules'))
  symlinkSync(tarRoot, join(launcherRoot, 'node_modules/tar'), process.platform === 'win32' ? 'junction' : 'dir')
}
