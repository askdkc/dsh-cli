import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { readFileSync } from 'node:fs'

test('source and compiled metadata boundaries and rereading', async () => {
 const temp = mkdtempSync(join(tmpdir(), 'compat-version-'))
 try {
  symlinkSync(join(process.cwd(), 'node_modules'), join(temp, 'node_modules'), 'dir')
  for (const layout of ['src', 'lib/types']) {
   const root = join(temp, layout === 'src' ? 'source' : 'compiled')
   const dir = join(root, layout); mkdirSync(dir, { recursive: true })
   const code = ts.transpileModule(readFileSync('src/package-version.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText
   writeFileSync(join(dir, 'package-version.mjs'), code)
   const manifest = join(root, 'package.json')
   const module = await import(pathToFileURL(join(dir, 'package-version.mjs')).href)
   assert.equal(module.installedCliVersion(), undefined)
   for (const metadata of ['{', '{}', '{"name":"other","version":"9.9.9"}', '{"name":"@askdkc/dsh-cli","version":"bad"}', '{"name":"@askdkc/dsh-cli","version":123}', '[]', 'null']) {
    writeFileSync(manifest, metadata); assert.equal(module.installedCliVersion(), undefined)
   }
   for (const version of ['1.2.3', '2.0.0-beta.1']) {
    writeFileSync(manifest, JSON.stringify({name:'@askdkc/dsh-cli',version})); assert.equal(module.installedCliVersion(),version)
   }
  }
 } finally { rmSync(temp,{recursive:true,force:true}) }
})
