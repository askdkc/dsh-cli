import assert from 'node:assert/strict'

/** Decline optional compilation only when the profile has no build decision. */
export function declineUndecidedKiokukoBuild(allowBuilds) {
  const decision = allowBuilds?.['kiokuko-dsh']
  assert.ok(decision === undefined || decision === 'set this to true or false', 'never overwrite an existing build decision')
  return { ...allowBuilds, 'kiokuko-dsh': false }
}
