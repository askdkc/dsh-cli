/** Real host verification must stay quiet on expected rejection and fail on unexpected errors. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = fileURLToPath(new URL('./verify-code-intelligence-host.mjs', import.meta.url))
const source = readFileSync(script, 'utf8')
const fixture = mkdtempSync(join(tmpdir(), 'dsh-host-verifier-regression-'))
function run(file) {
  const result = spawnSync(process.execPath, [file, root], { encoding: 'utf8', timeout: 60000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}
function replace(before, after) {
  assert.equal(source.split(before).length, 2, 'fault injection must target exactly one current boundary')
  return source.replace(before, after)
}
try {
  const normal = run(script)
  assert.equal(normal.status, 0, normal.stderr)
  assert.doesNotMatch(normal.stderr, /LspError:|LSP_CONFLICT/u, 'expected duplicate rejection must not leak a stack')
  assert.match(normal.stdout, /real structure OK/u, 'run the complete real host verification')
  const mutations = [
    ['unexpected-outside', "  const status = (await ctx.get('tools').execute", "  ctx.logger.error(new Error('INJECTED_OUTSIDE'))\n  const status = (await ctx.get('tools').execute", /INJECTED_OUTSIDE/u],
    ['unexpected-inside', "    await ctx.loader.root.update([...rows, { ...providerRow, id: 'duplicate-code-provider' }])", "    ctx.logger.error(new Error('INJECTED_INSIDE'))\n    await ctx.loader.root.update([...rows, { ...providerRow, id: 'duplicate-code-provider' }])", /INJECTED_INSIDE/u],
    ['missing-rejection', "    await ctx.loader.root.update([...rows, { ...providerRow, id: 'duplicate-code-provider' }])", '    await ctx.loader.root.update(rows)', /real plugin lifecycle/u],
    ['wrong-type', 'duplicate.fiber.await()', `Promise.reject(Object.assign(new Error('wrong type'), {name:'LspError',code:'LSP_CONFLICT'}))`, /actual LspError type/u],
    ['wrong-code', 'duplicate.fiber.await()', `Promise.reject(new LspError('wrong code', 'INJECTED_WRONG_CODE'))`, /INJECTED_WRONG_CODE/u],
    ['extra-notification', '    assert.equal(conflictLogs.length, 2,', '    ctx.logger.error(conflict)\n    assert.equal(conflictLogs.length, 2,', /exactly two framework notifications/u],
  ]
  for (const [name, before, after, expected] of mutations) {
    const file = join(fixture, name + '.mjs')
    writeFileSync(file, replace(before, after))
    const result = run(file)
    assert.notEqual(result.status, 0, name + ': fault must fail verification')
    assert.match(result.stderr, expected, name + ': fail for the injected fault, not another startup problem')
  }
  console.log('host verifier regressions OK (quiet success; unexpected errors; missing rejection; exact type, code and log count)')
} finally { rmSync(fixture, { recursive: true, force: true }) }
