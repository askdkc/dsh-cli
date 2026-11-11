import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { declineUndecidedKiokukoBuild } from './opencode-profile-build-policy.mjs'

for (const [name, yaml] of [
  ['missing allowBuilds', 'minimumReleaseAge: 1440\n'],
  ['missing package decision', 'allowBuilds:\n  other-allowed: true\n  other-denied: false\n'],
  ['pnpm undecided placeholder', 'allowBuilds:\n  kiokuko-dsh: set this to true or false\n  other-allowed: true\n  other-denied: false\n  other-undecided: set this to true or false\n'],
]) {
  test(`declines optional compilation for ${name} without mutating existing policy`, () => {
    const policy = YAML.parse(yaml)
    const original = structuredClone(policy)
    if (policy.allowBuilds) Object.freeze(policy.allowBuilds)
    Object.freeze(policy)
    const result = declineUndecidedKiokukoBuild(policy.allowBuilds)
    assert.deepEqual(result, { ...original.allowBuilds, 'kiokuko-dsh': false })
    assert.deepEqual(policy, original)
  })
}

for (const decision of [true, false, null, 0, '', 'true', 'false', 'unexpected']) {
  test(`rejects existing or invalid decision ${JSON.stringify(decision)} without changing policy`, () => {
    const allowBuilds = Object.freeze({ 'kiokuko-dsh': decision, other: true })
    assert.throws(() => declineUndecidedKiokukoBuild(allowBuilds), /never overwrite an existing build decision/)
    assert.deepEqual(allowBuilds, { 'kiokuko-dsh': decision, other: true })
  })
}

test('a declined decision cannot be overwritten on a repeated attempt', () => {
  const declined = declineUndecidedKiokukoBuild(undefined)
  assert.throws(() => declineUndecidedKiokukoBuild(declined), /never overwrite an existing build decision/)
  assert.deepEqual(declined, { 'kiokuko-dsh': false })
})
