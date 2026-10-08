import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function snapshotCheckout(source, destination) {
  const result = spawnSync('git', ['ls-files', '--recurse-submodules', '-z'], { cwd: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`cannot enumerate upstream tracked sources: ${result.stderr}`)
  const digest = createHash('sha256')
  const copied = new Set()
  for (const name of result.stdout.split('\0').filter(Boolean).sort()) {
    if (name.split('/').some(part => ['.git', '.agents', '.codex', '.claude', 'node_modules', 'lib', 'dist', '.kiokuko', '.dsh', 'profiles', 'sessions', 'snapshots'].includes(part)) || /(?:\.tsbuildinfo|\.env(?:\..*)?)$/.test(name)) continue
    const from = resolve(source, name)
    const rel = relative(source, from)
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`invalid tracked path: ${name}`)
    if (!existsSync(from)) continue // Preserve tracked deletions in the snapshot.
    const stat = lstatSync(from)
    if (stat.isDirectory()) throw new Error(`upstream submodule is not initialized: ${name}`)
    if (stat.isSymbolicLink() && /\.md$/.test(name)) continue
    if (stat.isSymbolicLink()) throw new Error(`upstream source symlink requires explicit handling: ${name}`)
    const to = join(destination, name)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    digest.update(name).update('\0').update(readFileSync(from)).update('\0')
    copied.add(name)
  }
  return { digest: digest.digest('hex'), copied }
}
