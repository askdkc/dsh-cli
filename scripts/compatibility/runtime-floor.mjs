/** Exercise only the generated installer's runtime predicate; never install anything. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { minVersion, satisfies } from 'semver'
const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json')))
const floor = minVersion(manifest.engines.node)
assert.ok(floor)
const work = mkdtempSync(join(tmpdir(), 'dsh-runtime-floor-'))
try {
  const built = spawnSync(process.execPath, ['scripts/make-installer-bundle.mjs', '--out', work], { cwd: root, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)
  const windows = process.platform === 'win32'
  const script = readFileSync(join(work, windows ? 'dsh-cli-setup/install.ps1' : 'dsh-cli-setup/install.sh'), 'utf8')
  const predicate = windows ? script.match(/if \(-not \$nv[^\n]*\{[^}]*\}/u)?.[0] : script.match(/need_node\(\) \{[\s\S]*?\n\}/u)?.[0]
  assert.ok(predicate)
  const fakeNode = join(work, 'node')
  writeFileSync(fakeNode, '#!/bin/sh\nprintf "v%s\\n" "$NODE_FIXTURE_VERSION"\n')
  chmodSync(fakeNode, 0o700)
  for (const version of [`${floor.major}.${floor.minor - 1}.0`, floor.version, `${floor.major + 1}.0.0`, '99.0.0']) {
    const command = windows ? 'powershell.exe' : '/bin/sh'
    const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', `function Fail { exit 1 }; $nv = [version]'${version}'; ${predicate}; exit 0`] : ['-c', `ok() { :; }; warn() { :; }; fail() { exit 1; };\n${predicate}\nneed_node`]
    const result = spawnSync(command, args, {
      env: { ...process.env, PATH: windows ? process.env.PATH : `${work}:/usr/bin:/bin`, NODE_FIXTURE_VERSION: version }, encoding: 'utf8',
    })
    assert.equal(result.status === 0, satisfies(version, manifest.engines.node), `generated installer and engines disagree for ${version}`)
  }
  console.log(`runtime floor OK (generated ${windows ? 'PowerShell' : 'shell'}; minimum, older boundary and newer majors)`)
} finally { rmSync(work, { recursive: true, force: true }) }
