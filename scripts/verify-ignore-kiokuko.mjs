/** Launch-local Kiokuko exclusion: real launcher + real Loader, no user state. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), 'verify-ignore-kiokuko-'))
const home = join(tmp, 'home'), profile = join(home, '.dsh', 'profiles', 'dsh-cli')
const pkg = join(profile, 'node_modules', '@askdkc', 'dsh-cli')
const harness = join(tmp, 'harness'), log = join(tmp, 'launch.json')
try {
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  mkdirSync(join(harness, 'apps', 'cli', 'lib'), { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml']) writeFileSync(join(pkg, name), readFileSync(join(root, name)))
  let launcher = readFileSync(join(root, 'bin', 'dsh-cli.js'), 'utf8')
  if (process.argv.includes('--mutation')) launcher = launcher.replace("if (ignoreKiokuko && profile === PROFILE)", "if (false && profile === PROFILE)")
  writeFileSync(join(pkg, 'bin', 'dsh-cli.js'), launcher)
  for (const name of ['lib', 'node_modules']) symlinkSync(join(root, name), join(pkg, name), 'junction')
  writeFileSync(join(harness, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  writeFileSync(join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@askdkc/dsh-cli","kiokuko-dsh"]}}}')
  writeFileSync(join(profile, 'cordis.patch.yml'), '# User configuration stays untouched\n[]\n')
  const before = ['package.json', 'cordis.patch.yml'].map(name => readFileSync(join(profile, name), 'utf8'))
  writeFileSync(join(harness, 'apps', 'cli', 'lib', 'bin.js'), `
    const fs = require('node:fs'); const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('fixture'); process.exit(0) }
    if (args.includes('--dump-config')) {
      if (process.env.BAD_DUMP) { console.log('invalid: ['); process.exit(0) }
      const manifest = JSON.parse(fs.readFileSync(require('node:path').join(process.env.DSH_HOME,'profiles','dsh-cli','package.json')));
      console.log(!manifest.dsh.profile.bundles.includes('kiokuko-dsh') && process.env.STANDALONE_ENTRIES ? process.env.STANDALONE_ENTRIES : process.env.ENTRIES); process.exit(0)
    }
    const overlays = [];
    for (let i=0;i<args.length;i++) if(args[i]==='--patch') overlays.push({path:args[i+1], data:JSON.parse(fs.readFileSync(args[++i], 'utf8'))});
    fs.writeFileSync(process.env.LAUNCH_LOG, JSON.stringify({ args, overlays, resume:process.env.DSH_CLI_RESUME_SESSION }));
  `)
  const entries = [
    { id: 'renamed', name: 'kiokuko-dsh' },
    { id: 'models', name: 'kiokuko-dsh/models' },
    { id: 'other', name: 'other-plugin' },
    { id: 'lookalike', name: 'kiokuko-dsh-other' },
    { id: 'group', name: '@deepseek-ai/cordis-plugin-group', group: true, config: [{ id: 'nested', name: 'kiokuko-dsh/nested' }] },
  ]
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'), DSH_CLI_DSH_ROOT: harness, DSH_CLI_LANG: 'en', LAUNCH_LOG: log, ENTRIES: JSON.stringify(entries) }
  for (const key of ['SystemRoot', 'ComSpec', 'windir']) if (process.env[key]) env[key] = process.env[key]
  const run = (args, extra = {}) => {
    rmSync(log, { force: true })
    return spawnSync(process.execPath, [join(pkg, 'bin', 'dsh-cli.js'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 })
  }
  for (const args of [['--help'], ['--ignore-kiokuko', '--help'], ['--help', '--ignore-kiokuko']]) assert.match(run(args).stdout, /--ignore-kiokuko/)
  for (const command of ['safe', 'update', 'migrate', 'doctor']) {
    assert.equal(run(['--ignore-kiokuko', command]).status, 1)
    assert.ok(!existsSync(log))
  }
  let result = run(['--ignore-kiokuko', '--resume', 'session-123', '--unknown-option'])
  assert.equal(result.status, 0, result.stderr)
  let launch = JSON.parse(readFileSync(log))
  assert.equal(launch.resume, 'session-123')
  assert.ok(launch.args.includes('--unknown-option'))
  assert.ok(!launch.args.includes('--ignore-kiokuko'))
  assert.equal(launch.overlays.length, 1)
  const patches = launch.overlays[0].data
  assert.deepEqual(patches.map(p => p.id), ['renamed', 'models', 'nested'])
  assert.ok(patches.every(p => p.disabled === true))
  assert.ok(!existsSync(launch.overlays[0].path), 'overlay must be cleaned after child exit')

  // Actual dependency boundary: disabled rows never reach Loader.import.
  const ctx = new Context(), imported = []
  try {
    await ctx.plugin(Loader)
    const loader = ctx.get('loader')
    loader.import = name => { if (name === '@deepseek-ai/cordis-plugin-group') return import('@deepseek-ai/cordis-plugin-group'); imported.push(name); return { name, apply() {} } }
    await loader.root.update(applyEntryPatches(entries, patches, message => { throw new Error(message) }))
    assert.deepEqual(imported.sort(), ['kiokuko-dsh-other', 'other-plugin'])
  } finally { await ctx.fiber.dispose() }

  result = run(['--unknown-option'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(log)).overlays.length, 0, 'next launch restores ordinary behavior')
  result = run(['--ignore-kiokuko', '-c'], { ENTRIES: '[{"id":"other","name":"other-plugin"}]' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(log)).overlays[0].data, [], 'no Kiokuko installed is valid')
  const stock = { id: 'stock', name: 'stock-export', disabled: true }
  const withStock = [...entries, stock]
  const withoutStockOverride = [...entries, { id: 'stock', name: 'stock-export' }]
  result = run(['--ignore-kiokuko'], { ENTRIES: JSON.stringify(withStock), STANDALONE_ENTRIES: JSON.stringify(withoutStockOverride) })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(log)).overlays[0].data.at(-1), { id: 'stock', disabled: false }, 'bundle-only stock disable is reversed')
  result = run(['--ignore-kiokuko'], { ENTRIES: JSON.stringify(withStock), STANDALONE_ENTRIES: JSON.stringify(withStock) })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!JSON.parse(readFileSync(log)).overlays[0].data.some(p => p.id === 'stock'), 'explicit user override is retained')
  const custom = join(tmp, 'custom.yml')
  writeFileSync(custom, '[]')
  result = run(['--ignore-kiokuko', '--patch', custom, 'hello'])
  assert.equal(result.status, 0, result.stderr)
  launch = JSON.parse(readFileSync(log))
  assert.equal(launch.overlays[0].path, custom)
  assert.deepEqual(launch.overlays[1].data, patches, 'exclusion overlay is last')
  for (const extra of [{ BAD_DUMP: '1' }, { STANDALONE_ENTRIES: JSON.stringify(entries.map(e => e.id === 'other' ? { ...e, name: 'different' } : e)) }, { ENTRIES: '[{"name":"kiokuko-dsh"}]' }, { ENTRIES: '[{"id":"a","name":"kiokuko-dsh"},{"id":"a","name":"other"}]' }]) {
    result = run(['--ignore-kiokuko'], extra)
    assert.notEqual(result.status, 0)
    assert.ok(!existsSync(log), 'ambiguous composition must fail before launch')
  }
  assert.deepEqual(['package.json', 'cordis.patch.yml'].map(name => readFileSync(join(profile, name), 'utf8')), before)
  console.log('ignore-kiokuko: launcher, real Loader no-import, absent/default/restart/resume, overlays, failure isolation passed')
} finally { rmSync(tmp, { recursive: true, force: true }) }
