import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
assert.deepEqual(manifest.bin, { 'dsh-cli': './bin/dsh-cli.js' })
assert.ok(existsSync(new URL('../bin/dsh-cli.js', import.meta.url)))
assert.ok(!existsSync(new URL('../bin/dsh-tui.js', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'cli-naming-'))
try {
  const legacy = join(scratch, '.dsh-tui')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'lang.json'), '{"lang":"zh"}')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DATA_DIR } from './src/utils/paths.ts';
    import { envDirect, ideLockDir } from './src/dsh-adapter/ide-channel.ts';
    import { resolveStartupLang } from './src/i18n.ts';
    import { sessionsRoots } from './src/dsh-adapter/compat/sessionLog.ts';
    assert.equal(resolveStartupLang(), 'en');
    assert.equal(DATA_DIR, process.env.HOME + '/.dsh-cli');
    assert.equal(envDirect({ DSH_TUI_IDE_PORT: '12345', DSH_TUI_IDE_TOKEN: 'old' }), undefined);
    assert.deepEqual(envDirect({ DSH_CLI_IDE_PORT: '12345', DSH_CLI_IDE_TOKEN: 'new' }), { port: 12345, token: 'new' });
    assert.equal(ideLockDir(), DATA_DIR + '/ide');
    assert.ok(!sessionsRoots().some(p => p.includes('.dsh-tui') || p === '/legacy-sessions'));
  `], { cwd: new URL('../', import.meta.url), env: { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'), DSH_CLI_LANG: '', DSH_TUI_LANG: 'zh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', DSH_TUI_SESSION_ROOT: '/legacy-sessions' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(legacy, 'lang.json'), 'utf8'), '{"lang":"zh"}')
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log('CLI naming and legacy isolation passed')
