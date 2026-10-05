import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractRuntime, nativeTarPath } from '../standalone/extractRuntime.cjs'
import { createStandaloneArchive } from './lib/standalone-archive.mjs'

assert.equal(nativeTarPath('win32', 'C:\\Windows'), 'C:\\Windows\\System32\\tar.exe')
assert.equal(nativeTarPath('win32'), null)
assert.equal(nativeTarPath('darwin'), '/usr/bin/tar')
assert.equal(nativeTarPath('linux'), '/bin/tar')
assert.equal(nativeTarPath('unsupported'), null)
const options = { file: 'C:\\archive with spaces.tar.gz', cwd: 'C:\\runtime dir', strict: true, preservePaths: false }
let fallbackCalled = false
await extractRuntime(options, {
  platform: 'win32', systemRoot: 'C:\\Windows',
  execute(executable, args) {
    assert.equal(executable, 'C:\\Windows\\System32\\tar.exe')
    assert.deepEqual(args, ['-xzf', options.file, '-C', options.cwd, '--no-same-owner'])
  },
  fallback() { fallbackCalled = true },
})
assert.equal(fallbackCalled, false)
const originalPath = process.env.PATH
await extractRuntime(options, {
  platform: 'linux',
  exists: () => true,
  execute(executable, _args, childOptions) {
    assert.equal(executable, '/bin/tar')
    assert.equal(childOptions.env.PATH, '/usr/bin:/bin', 'GNU tar must find its OS gzip helper')
  },
})
assert.equal(process.env.PATH, originalPath, 'the caller environment is unchanged')
await assert.rejects(extractRuntime(options, {
  platform: 'linux', exists: () => true, execute() { throw Object.assign(new Error('bad archive'), { status: 2 }) },
  fallback() { fallbackCalled = true },
}), /bad archive/)
assert.equal(fallbackCalled, false, 'real extraction errors must propagate')
await extractRuntime(options, {
  platform: 'linux', exists: () => false,
  execute() { assert.fail('tar cannot run without its gzip helper') },
  fallback() { fallbackCalled = true },
})
assert.equal(fallbackCalled, true, 'missing gzip uses the bundled extractor')

const root = mkdtempSync(join(tmpdir(), 'dsh-extraction-'))
try {
  mkdirSync(join(root, 'source'))
  writeFileSync(join(root, 'source', 'file.txt'), 'runtime contents')
  const file = join(root, 'runtime.tar.gz')
  createStandaloneArchive(file, join(root, 'source'), ['file.txt'])
  for (const fallback of [false, true]) {
    const cwd = join(root, String(fallback))
    mkdirSync(cwd)
    await extractRuntime({ file, cwd, strict: true, preservePaths: false }, fallback ? {
      platform: 'linux', exists: () => true, execute() { throw Object.assign(new Error('tool missing'), { code: 'ENOENT' }) },
    } : {})
    assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'runtime contents')
  }
  console.log('standalone extraction OK (native round-trip, bundled fallback, Windows path selection, propagated failures)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
