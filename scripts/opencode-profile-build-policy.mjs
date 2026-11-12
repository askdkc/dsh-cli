import assert from 'node:assert/strict'

/** Decline optional compilation only when the profile has no build decision. */
export function declineUndecidedKiokukoBuild(allowBuilds) {
  const decision = allowBuilds?.['kiokuko-dsh']
  assert.ok(decision === undefined || decision === 'set this to true or false', 'never overwrite an existing build decision')
  return { ...allowBuilds, 'kiokuko-dsh': false }
}

/** Recognize only the single optional package, across pnpm 11/12 diagnostics. */
export function isUndecidedKiokukoBuild(message) {
  const code = /(?:^|\n)(?:\[ERR_PNPM_IGNORED_BUILDS\]|Error: ERR_PNPM_IGNORED_BUILDS)(?:\s|$)/u.test(message)
  const packages = [...message.matchAll(/Ignored build scripts: ([^\r\n]+)/gu)]
  return code && packages.length === 1 && /^kiokuko-dsh@[0-9][0-9A-Za-z.+-]*\s*$/u.test(packages[0][1])
}
