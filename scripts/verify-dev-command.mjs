#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandInvocation } from './dev-command.mjs'
import { copyDevConfig, resolveDevPaths } from './dev-copy-config.mjs'

const unixArgs = ['--profile', 'dsh-cli', '/tmp/work tree']
assert.deepEqual(commandInvocation('dsh', unixArgs, 'linux'), ['dsh', unixArgs])
assert.deepEqual(commandInvocation('dsh', unixArgs, 'darwin'), ['dsh', unixArgs])

const [windowsCommand, windowsArgs] = commandInvocation(
  'dsh',
  ['--profile', 'dsh-cli', String.raw`C:\work tree\a&b`],
  'win32',
)
assert.deepEqual(windowsArgs, [])
assert.match(windowsCommand, /^dsh\.cmd /u)
assert.match(windowsCommand, /\^&/u)
assert.doesNotMatch(windowsCommand, /C:\\work tree\\a&b/u)

assert.deepEqual(
  resolveDevPaths({ XDG_CACHE_HOME: '/cache', DSH_SOURCE_HOME: '/source' }, '/home/dev', 'linux'),
  {
    devRoot: '/cache/dsh-cli-dev',
    sourceHome: '/source',
    isolatedHome: '/cache/dsh-cli-dev/home',
    dshHome: '/cache/dsh-cli-dev/dsh-home',
    sessionRoot: '/cache/dsh-cli-dev/sessions',
  },
)
assert.equal(
  resolveDevPaths({ LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local` }, String.raw`C:\Users\dev`, 'win32').devRoot,
  win32.resolve(String.raw`C:\Users\dev\AppData\Local\dsh-cli-dev`),
)

const fixture = mkdtempSync(join(tmpdir(), 'dsh-cli-dev-config-'))
try {
  const sourceHome = join(fixture, 'source')
  const devRoot = join(fixture, 'dev')
  mkdirSync(sourceHome)
  writeFileSync(join(sourceHome, 'settings.yaml'), 'providers: {}\n')
  writeFileSync(join(sourceHome, '.credentials.yaml'), 'test: secret\n')
  writeFileSync(join(sourceHome, 'cordis.patch.yml'), 'must not copy\n')

  const copied = copyDevConfig({ DSH_CLI_DEV_ROOT: devRoot, DSH_SOURCE_HOME: sourceHome })
  assert.deepEqual(copied.copied, ['settings.yaml', '.credentials.yaml'])
  assert.equal(readFileSync(join(copied.dshHome, 'settings.yaml'), 'utf8'), 'providers: {}\n')
  assert.equal(readFileSync(join(copied.dshHome, '.credentials.yaml'), 'utf8'), 'test: secret\n')
  assert.throws(() => readFileSync(join(copied.dshHome, 'cordis.patch.yml')))
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(copied.dshHome, 'settings.yaml')).mode & 0o777, 0o600)
    assert.equal(statSync(join(copied.dshHome, '.credentials.yaml')).mode & 0o777, 0o600)
  }

  // Exercise dev-test's real post-install verification without a build/install.
  // The installer stub places the package by its manifest name, as pnpm does.
  const repo = join(fixture, 'worktree')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  for (const file of ['dev-test.mjs', 'dev-command.mjs', 'dev-copy-config.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(repo, 'scripts', file))
  }
  copyFileSync(new URL('../package.json', import.meta.url), join(repo, 'package.json'))
  const artifacts = ['bin/dsh-cli.js', 'cordis.patch.yml', 'lib/types/index.js']
  for (const file of artifacts) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), `fixture artifact: ${file}\n`)
  }
  const preload = join(repo, 'scripts', 'mock-install.mjs')
  writeFileSync(preload, `
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { commandInvocation } from './dev-command.mjs'

childProcess.spawnSync = (command, args, options) => {
  const matches = (name, values) => JSON.stringify([command, args]) === JSON.stringify(commandInvocation(name, values))
  const success = { status: 0 }
  if (matches('pnpm', ['--version']) || matches('dsh', ['--version'])) return success
  if (matches('pnpm', ['install', '--frozen-lockfile']) || matches('pnpm', ['build'])) return success
  const packages = join(process.env.DSH_CLI_DEV_ROOT, 'packages')
  const runs = readdirSync(packages)
  assert.equal(runs.length, 1)
  const packDir = join(packages, runs[0])
  const tarball = join(packDir, 'fixture.tgz')
  if (matches('npm', ['pack', '--pack-destination', packDir])) {
    writeFileSync(tarball, 'stub packed artifact')
    return success
  }
  if (matches('dsh', ['plugin', '--profile', 'dsh-cli', 'add', tarball])) {
    const manifest = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'))
    const installed = join(options.env.DSH_HOME, 'profiles', 'dsh-cli', 'node_modules', ...manifest.name.split('/'))
    for (const file of ${JSON.stringify(artifacts)}) {
      mkdirSync(dirname(join(installed, file)), { recursive: true })
      copyFileSync(join(options.cwd, file), join(installed, file))
    }
    return success
  }
  throw new Error('unexpected subprocess: ' + command + ' ' + args.join(' '))
}
childProcess.spawn = () => { throw new Error('unexpected launch in --no-launch test') }
syncBuiltinESMExports()
`)
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href,
    join(repo, 'scripts', 'dev-test.mjs'), '--no-launch',
  ], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: fixture,
      USERPROFILE: fixture,
      TMPDIR: fixture,
      TMP: fixture,
      TEMP: fixture,
      DSH_CLI_DEV_ROOT: join(fixture, 'install-dev'),
      NODE_OPTIONS: '',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  assert.match(result.stdout, /dev-test: installed current worktree/u)
  console.log('dev-test installed artifact verification OK (manifest package path, no launch)')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log('dev command invocation OK (Linux, macOS, WSL, Windows quoting and paths)')
