/** Exercise the builder's archive writer with pnpm-style links and reordered I/O. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x as extractTar } from 'tar'
import { createStandaloneArchive } from './lib/standalone-archive.mjs'

if (process.argv[2] === '--worker') {
  const root = process.argv[3]
  // Force a valid completion order that strands async tar's hardlink queue.
  const lstat = fs.lstat
  fs.lstat = (path, callback) => lstat(path, (error, stat) => {
    setTimeout(() => callback(error, stat), path.endsWith('0-0') ? 50 : 0)
  })
  const lstatSync = fs.lstatSync
  fs.lstatSync = (...args) => {
    const stat = lstatSync(...args)
    if (String(args[0]).includes('unsafe-')) {
      // Distinct Windows file indexes can round to this same Number.
      stat.ino = Number.MAX_SAFE_INTEGER + 1
      stat.nlink = 2
    }
    return stat
  }
  await createStandaloneArchive(join(root, 'runtime.tar.gz'), root, ['node_modules'])
  process.stdout.write('archive complete\n')
} else {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-archive-'))
  try {
    const modules = join(root, 'node_modules')
    fs.mkdirSync(modules)
    const expected = new Map()
    for (let i = 0; i < 20; i++) {
      const value = `package contents ${i}`
      const source = join(root, `store-${i}`)
      fs.writeFileSync(source, value)
      for (let j = 0; j < 5; j++) {
        const name = `${j}-${i}`
        fs.linkSync(source, join(modules, name))
        expected.set(name, value)
      }
    }
    for (const name of ['unsafe-a', 'unsafe-b']) {
      fs.writeFileSync(join(modules, name), name)
      expected.set(name, name)
    }
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', root], {
      env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(child.status, 0, `archive worker: ${child.error?.code ?? child.signal}\n${child.stderr}`)
    assert.equal(child.stdout, 'archive complete\n')
    const extracted = join(root, 'extracted')
    fs.mkdirSync(extracted)
    await extractTar({ file: join(root, 'runtime.tar.gz'), cwd: extracted, strict: true })
    for (const [name, value] of expected) {
      assert.equal(fs.readFileSync(join(extracted, 'node_modules', name), 'utf8'), value, name)
    }
    assert.equal(fs.readdirSync(join(extracted, 'node_modules')).length, expected.size)
    assert.throws(() => createStandaloneArchive(join(root, 'missing.tar.gz'), root, ['missing']), { code: 'ENOENT' })
    assert.throws(() => createStandaloneArchive(join(root, 'absent/out.tar.gz'), root, ['node_modules']), { code: 'ENOENT' })
    console.log('standalone archive OK (reordered hardlinks, unsafe inode identity, full round-trip, I/O failures, empty PATH)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
