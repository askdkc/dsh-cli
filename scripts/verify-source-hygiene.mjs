/**
 * Check maintainable source inputs and product naming. This is a regression
 * guard, not a license audit or a proof of independent implementation.
 * Run: node scripts/verify-source-hygiene.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ownPath = fileURLToPath(import.meta.url)
const collect = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(directory, entry.name)
  return entry.isDirectory() ? collect(path) : [path]
})
const rules = [
  ['private internal link', /anthropic\.slack\.com|slack\.com\/archives/],
  ['foreign runtime environment variable', /CLAUDE_CODE_[A-Z_]+/],
  ['embedded source map in source', /sourceMappingURL=data:/],
  ['compiler-generated component input', /(?:from\s*|import\s*\()['"]react\/compiler-runtime['"]|react\.early_return_sentinel|react\.memo_cache_sentinel/],
  ['retired helper namespace', /(?:src\/|\.\.\/|types\/)cc\/|cc\.d\.ts/],
  ['product comparison wording', /Claude Code[- ](?:style|风格)|mirroring Claude Code|ported CC|\bCC[- ](?:style|parity)|Claude-Code-identical/],
]
const files = ['src', 'scripts', 'docs'].flatMap(name => collect(resolve(root, name)))
  .filter(path => /\.(?:[cm]?[jt]sx?|md)$/.test(path) && path !== ownPath)
files.push(...['README.md', 'README_JA.md', 'README_ZH.md', 'ADAPTER.md', 'package.json'].map(name => resolve(root, name)))
// Local agent instructions are optional; scan them when present.
const agentInstructions = resolve(root, 'AGENTS.md')
if (existsSync(agentInstructions)) files.push(agentInstructions)
// Retired env naming is code-only: launcher and config files are scanned
// as code, while docs may still mention the old names in migration history.
// The harness home now follows the upstream default (~/.dsh), so run.ts and
// sync-profile.mjs no longer pin the early ~/.dsh-cc directory.
const codeFiles = ['src', 'scripts'].flatMap(name => collect(resolve(root, name)))
  .filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path))
codeFiles.push(...['bin/dsh-cli.js', 'dsh-cli.cmd', 'cordis.yml', 'cordis.patch.yml'].map(name => resolve(root, name)))
const retiredNaming = /\b(?:CC_TUI_[A-Z_]+|DSH_CC_[A-Z_]+)\b/
const failures = []
// Exact external contracts, legacy-negative tests and published historical fixtures only.
const namingExceptions = new Map([
  ['src/adapter/standard/descriptor.ts', /urn:dsh-tui:host-descriptor:0\.15/],
  ['src/adapter/standard/types.ts', /urn:dsh-tui:host-descriptor:0\.15|authority: 'dsh-tui'/],
  ['src/adapter/standard/registry.ts', /authority === 'dsh-tui'/],
  ['src/adapter/spec/protocol-constants.ts', /adapters\/dsh-tui-v0\.15\.md/],
  ['src/dsh-adapter/ide-channel.ts', /companion IDE extension \(dsh-tui-vscode\)/],
  ['scripts/verify-protocol-single-source.ts', /'dsh-tui-v0\.15\.md'/],
  ['scripts/verify-package.mjs', /packed.has\('bin\/dsh-tui\.js'\)/],
  ['scripts/verify-cli-naming.mjs', /dsh-tui|DSH_TUI_/],
  // Only the immutable 0.12.3 baseline's auth row selector may use this ID.
  ['scripts/opencode-profile-probe.mjs', /^const authEntryId=process\.env\.DSH_AUTH_TEST_PHASE==='baseline'\?'dsh-tui-auth':'dsh-cli-auth'$/],
])
for (const file of [...codeFiles, ...collect(resolve(root, 'standalone')).filter(p => /\.(?:cjs|json)$/.test(p))]) {
  const name = relative(root, file)
  if (file === ownPath) continue
  for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (/dsh-tui|DSH_TUI_|dshtui/i.test(line) && !namingExceptions.get(name)?.test(line)) {
      failures.push(`${name}:${index + 1}: retired product naming`)
    }
  }
}
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const [label, pattern] of rules) {
      if (pattern.test(line)) failures.push(`${relative(root, file)}:${index + 1}: ${label}`)
    }
  }
}
for (const file of codeFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (retiredNaming.test(line)) failures.push(`${relative(root, file)}:${index + 1}: retired env/dir naming`)
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`source hygiene passed (${files.length} files; provider IDs and documented migration aliases remain supported)`)
}
