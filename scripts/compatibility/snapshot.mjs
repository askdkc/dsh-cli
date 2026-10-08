import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { snapshotCheckout } from '../upstream-snapshot.mjs'
import { checkProjectGraph, readProjectConfig, projectDeclaration } from '../upstream-projects.mjs'
test('snapshot keeps tracked dirty sources, excludes generated/private data and does not write back', () => {
 const temp = mkdtempSync(join(tmpdir(), 'compat-snapshot-'))
 try {
  const source = join(temp,'source'); mkdirSync(source)
  execFileSync('git',['init','-q'],{cwd:source})
  writeFileSync(join(source,'source.ts'),'old'); execFileSync('git',['add','source.ts'],{cwd:source})
  writeFileSync(join(source,'source.ts'),'dirty')
  mkdirSync(join(source,'lib')); writeFileSync(join(source,'lib/generated.d.ts'),'stale')
  writeFileSync(join(source,'.env'),'private')
  execFileSync('git',['add','lib/generated.d.ts','.env'],{cwd:source})
  const destination=join(temp,'copy'); snapshotCheckout(source,destination)
  assert.equal(readFileSync(join(destination,'source.ts'),'utf8'),'dirty')
  assert.equal(existsSync(join(destination,'lib')),false); assert.equal(existsSync(join(destination,'.env')),false)
  writeFileSync(join(destination,'source.ts'),'built')
  assert.equal(readFileSync(join(source,'source.ts'),'utf8'),'dirty')
 } finally {rmSync(temp,{recursive:true,force:true})}
})

test('checkout references and compiler outputs stay isolated; untracked inputs fail', () => {
  const temp = mkdtempSync(join(tmpdir(), 'compat-projects-'))
  try {
    const originalRoot = join(temp, 'original')
    const sourceRoot = join(temp, 'copy')
    mkdirSync(originalRoot)
    execFileSync('git', ['init', '-q'], { cwd: originalRoot })
    const base = { compilerOptions: { composite: true, declaration: true, rootDir: '.', outDir: 'lib', types: [] } }
    writeFileSync(join(originalRoot, 'base.json'), JSON.stringify(base))
    writeFileSync(join(originalRoot, 'tsconfig.json'), JSON.stringify({ extends: './base.json', include: ['*.ts'], references: [{ path: './dependency' }] }))
    writeFileSync(join(originalRoot, 'index.ts'), 'export const value = 1')
    writeFileSync(join(originalRoot, 'subpath.ts'), 'export const subpath = 2')
    mkdirSync(join(originalRoot, 'dependency'))
    writeFileSync(join(originalRoot, 'dependency/tsconfig.json'), JSON.stringify({ compilerOptions: base.compilerOptions, include: ['*.ts'] }))
    writeFileSync(join(originalRoot, 'dependency/index.ts'), 'export const dependency = 3')
    execFileSync('git', ['add', '.'], { cwd: originalRoot })
    const { copied } = snapshotCheckout(originalRoot, sourceRoot)
    const configPath = join(sourceRoot, 'tsconfig.json')
    const context = { originalRoot, sourceRoot, copied }
    const projects = new Set()
    checkProjectGraph(configPath, context, projects)
    assert.equal(projects.size, 2)
    const config = readProjectConfig(configPath)
    const manifest = { name: 'fixture', types: 'lib/index.d.ts' }
    const declaration = projectDeclaration(config, join(sourceRoot, 'subpath.ts'), sourceRoot, manifest, 'fixture/subpath')
    assert.equal(declaration, join(sourceRoot, 'lib/subpath.d.ts'))
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-b', configPath])
    assert(existsSync(declaration))
    assert(!existsSync(join(originalRoot, 'lib')))
    writeFileSync(join(originalRoot, 'untracked.ts'), 'export const untracked = true')
    assert.throws(() => checkProjectGraph(configPath, context, new Set()), /required untracked upstream source/)
    writeFileSync(configPath, JSON.stringify({ ...base, compilerOptions: { ...base.compilerOptions, outDir: join(originalRoot, 'lib') }, include: ['*.ts'] }))
    assert.throws(() => checkProjectGraph(configPath, context, new Set()), /output escapes isolation/)
    assert.throws(() => projectDeclaration(config, join(sourceRoot, 'index.ts'), sourceRoot, { name: 'fixture' }, 'fixture'), /type entry missing/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
