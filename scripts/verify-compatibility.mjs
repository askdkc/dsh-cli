import { spawnSync } from 'node:child_process'
const cases = [
 ['upstream', ['scripts/compatibility/upstream.mjs']],
 ['logo', ['scripts/compatibility/logo.mjs'], { NODE_ENV: 'production' }],
 ['locks', ['scripts/compatibility/locks.mjs']],
 ['auth', ['scripts/compatibility/auth.mjs']],
 ['provider-wire', ['dsh-auth/scripts/verify-provider-wire.mjs']],
 ['snapshot', ['--test', 'scripts/compatibility/snapshot.mjs']],
 ['settings', ['--import', 'tsx/esm', '--test', 'scripts/compatibility/settings.mjs']],
 ['version', ['--import', 'tsx/esm', '--test', 'scripts/compatibility/version.mjs']],
 ['react-development', ['scripts/compatibility/react.mjs'], { NODE_ENV: 'development' }],
 ['react-production', ['scripts/compatibility/react.mjs'], { NODE_ENV: 'production' }],
]
let failed = false
for (const [name, args, env] of cases) {
 const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } })
 console.log(name, result.status === 0 ? 'PASS' : 'FAIL')
 if (result.error || result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
