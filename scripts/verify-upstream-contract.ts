/** Verify dependency availability; DSH release labels never gate compatibility. */
import assert from 'node:assert/strict'
import {
  installedUpstreamVersions,
  upstreamDependencyIssues,
  assertCordisLifecycle,
  UPSTREAM_BLESSED_PACKAGES,
} from '../src/dsh-adapter/contract.js'

for (const version of ['0.1.7-rc.2', '0.2.1-alpha', '0.2.1-alpha.1', '99.0.0-beta.1', '1.0.0']) {
  const versions = Object.fromEntries(UPSTREAM_BLESSED_PACKAGES.map(name => [
    name, version,
  ]))
  assert.deepEqual(upstreamDependencyIssues(versions), [], `${version} must not need a new allowlist entry`)
  assert.equal(upstreamDependencyIssues({ ...versions, '@deepseek-ai/dsh-agent': '99.1.0' }).length, 0)
  const absent = { ...versions }
  delete absent['@deepseek-ai/dsh-agent']
  assert.equal(upstreamDependencyIssues(absent)[0]?.package, '@deepseek-ai/dsh-agent')
  assert.equal(upstreamDependencyIssues({ ...versions, '@deepseek-ai/dsh-web-app': undefined }).length, 1)
  assert.equal(upstreamDependencyIssues({ ...versions, '@deepseek-ai/dsh-agent': '' }).length, 0)
  assert.equal(upstreamDependencyIssues({ ...versions, '@deepseek-ai/cordis': '5.0.0' }).length, 0)
  assert.equal(upstreamDependencyIssues({ ...versions, '@deepseek-ai/schemastery': '99.0.0' }).length, 0)
}

const installed = installedUpstreamVersions()
const issues = upstreamDependencyIssues(installed)
if (issues.length > 0) {
  for (const issue of issues) console.error(`${issue.package}: ${issue.reason} (installed=${issue.installed ?? 'missing'})`)
  process.exit(1)
}
console.log(`upstream contract OK (${UPSTREAM_BLESSED_PACKAGES.length} packages; installed web-app ${installed['@deepseek-ai/dsh-web-app']})`)

const { Context } = await import('@deepseek-ai/cordis')
const ctx = new Context()
try {
  assert.doesNotThrow(() => assertCordisLifecycle(ctx))
  for (const missing of ['effect', 'plugin', 'fiber.await']) {
    const candidate = { version: '4.0.1', effect() {}, plugin() {}, fiber: { await() {} } }
    if (missing === 'fiber.await') Object.assign(candidate.fiber, { await: undefined })
    else Object.assign(candidate, { [missing]: undefined })
    assert.throws(() => assertCordisLifecycle(candidate), /requires Cordis/, `known version missing ${missing}`)
  }
} finally { await ctx.fiber.dispose() }
