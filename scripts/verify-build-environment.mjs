/** Exercise the actual aggregate wrapper's npm environment handoff without running the inner chain. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const fixture = mkdtempSync(join(tmpdir(), 'dsh-build-environment-'))
try {
  const hook = join(fixture, 'capture-npm.mjs')
  const report = join(fixture, 'environment.json')
  writeFileSync(hook, `
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { writeFileSync, existsSync } from 'node:fs'
    let calls = 0
    childProcess.spawnSync = (command, options) => {
      writeFileSync(process.env.DSH_VERIFY_ENV_REPORT, JSON.stringify({
        calls: ++calls, command, shell: options.shell, home: options.env.HOME,
        userProfile: options.env.USERPROFILE, homeExists: existsSync(options.env.HOME),
        inheritedHome: process.env.HOME,
        lower: options.env.npm_config_manage_package_manager_versions,
        upper: options.env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS,
        registry: options.env.npm_config_registry,
        sentinel: options.env.DSH_VERIFY_ENV_SENTINEL,
      }))
      return { status: 0 }
    }
    syncBuiltinESMExports()
  `)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href,
    fileURLToPath(new URL('./run-verify-build.mjs', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, DSH_VERIFY_ENV_REPORT: report,
      DSH_VERIFY_ENV_SENTINEL: 'preserve-this', npm_config_manage_package_manager_versions: 'true',
      NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'true', npm_config_registry: 'https://registry.example.invalid/' },
  })
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(actual.calls, 1, 'exercise exactly one npm handoff')
  assert.equal(actual.command, 'npm run verify:build:inner')
  assert.equal(actual.shell, true)
  assert.equal(actual.lower, undefined, 'pnpm-only lower-case option must not reach npm')
  assert.equal(actual.upper, undefined, 'environment key matching must handle Windows casing')
  assert.equal(actual.registry, 'https://registry.example.invalid/', 'preserve npm settings')
  assert.equal(actual.sentinel, 'preserve-this', 'preserve unrelated environment')
  assert.notEqual(actual.home, actual.inheritedHome)
  assert.equal(actual.userProfile, actual.home)
  assert.equal(actual.homeExists, true)
  assert.equal(existsSync(actual.home), false, 'aggregate wrapper removes its temporary home')
  console.log('build environment OK (pnpm-only option removed, npm settings and isolated HOME preserved)')
} finally { rmSync(fixture, { recursive: true, force: true }) }
