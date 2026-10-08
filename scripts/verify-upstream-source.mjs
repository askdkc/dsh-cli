import { assertCheckoutResolution } from './upstream-resolution.mjs'
import { snapshotCheckout } from './upstream-snapshot.mjs'
import { readProjectConfig, checkProjectGraph, projectDeclaration } from './upstream-projects.mjs'
/**
 * Type-check the TUI directly against the source-authoritative newest
 * DeepSeek Harness checkout. CI follows the upstream default branch; local runs
 * use DSH_HARNESS_SOURCE_ROOT or the adjacent deepseek-harness checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createHash } from 'node:crypto'

const tuiRoot = resolve(import.meta.dirname, '..')
const originalRoot = resolve(process.env.DSH_HARNESS_SOURCE_ROOT ?? join(tuiRoot, '../deepseek-harness'))
const isolation = mkdtempSync(join(tmpdir(), 'dsh-upstream-snapshot-'))
const sourceRoot = join(isolation, 'source')
const originalOutputs = new Map()
const fingerprint = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
try {
  const snapshot = snapshotCheckout(originalRoot, sourceRoot)
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: originalRoot, encoding: 'utf8' })
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: originalRoot, encoding: 'utf8' })
  console.log(`upstream input=${originalRoot} revision=${revision.stdout.trim()} dirty=${Boolean(dirty.stdout.trim())} digest=${snapshot.digest} isolated=${sourceRoot}`)
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: sourceRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  if (install.error || install.status !== 0) throw new Error(`isolated upstream install failed: ${install.error ?? install.status}`)
  const sourceManifestPath = join(sourceRoot, 'package.json')
  if (!existsSync(sourceManifestPath)) {
    console.error(`upstream source checkout missing: ${sourceRoot}`)
    throw new Error('upstream input validation failed')
  }

  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
  const upstreamConfigPath = join(sourceRoot, 'tsconfig.base.json')
  const upstreamConfig = readProjectConfig(upstreamConfigPath)
  const upstreamPaths = upstreamConfig.options.paths
  if (upstreamPaths === null || typeof upstreamPaths !== 'object') {
    console.error(`upstream source tsconfig has no compilerOptions.paths: ${upstreamConfigPath}`)
    throw new Error('upstream input validation failed')
  }
  const sourcePaths = Object.fromEntries(Object.entries(upstreamPaths)
    .filter(([name]) => name.startsWith('@deepseek-ai/'))
    .map(([name, entries]) => [
      name,
      entries.map(entry => {
        const target = resolve(upstreamConfig.options.baseUrl ?? upstreamConfig.options.pathsBasePath ?? dirname(upstreamConfigPath), entry)
        const rel = relative(sourceRoot, target)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error(`upstream mapping escapes checkout: ${name}: ${entry}`)
        const index = join(target, 'index.ts')
        return existsSync(index) ? index : target
      }),
    ]))
  // These packages require upstream's strict flags and native type references.
  // Build their declarations from this exact checkout; installed npm declarations
  // would silently verify a different source revision.
  const frameworkNames = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/cordis-plugin-hmr']
  const declarationEntries = []
  const projectsToBuild = new Set()
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@deepseek-ai/cordis-plugin-loader']) {
    if (!sourcePaths[name]?.length) throw new Error(`required upstream mapping missing: ${name}`)
  }
  for (const [name, entries] of Object.entries(sourcePaths)) {
    const declarationOnly = frameworkNames.includes(name) || name === '@deepseek-ai/dsh-hmr' || name.startsWith('@deepseek-ai/dsh-session-format') || name === '@deepseek-ai/dsh-session-persistence' || name === '@deepseek-ai/dsh-session-persistence-jsonl'
    sourcePaths[name] = entries.map(path => {
      if (!declarationOnly || path.includes('*')) return path
      if (!existsSync(path)) throw new Error(`upstream source missing: ${name}: ${path}`)
      let packageRoot = dirname(path)
      while (packageRoot !== sourceRoot && !existsSync(join(packageRoot, 'package.json'))) packageRoot = dirname(packageRoot)
      if (packageRoot === sourceRoot) throw new Error(`upstream package boundary missing: ${name}`)
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      const configPath = join(packageRoot, 'tsconfig.json')
      const config = readProjectConfig(configPath)
      checkProjectGraph(configPath, { sourceRoot, originalRoot, copied: snapshot.copied }, projectsToBuild)
      const declaration = projectDeclaration(config, path, packageRoot, manifest, name)
      declarationEntries.push(declaration)
      console.log(`upstream ${name} version=${manifest.version} source=${path} declaration=${declaration}`)
      return declaration
    })
  }
  const upstreamTsc = join(sourceRoot, 'node_modules/typescript/bin/tsc')
  for (const configPath of projectsToBuild) {
    const config = readProjectConfig(configPath)
    for (const source of config.fileNames) {
      for (const output of ts.getOutputFileNames(config, source, !ts.sys.useCaseSensitiveFileNames)) {
        const original = resolve(originalRoot, relative(sourceRoot, output))
        originalOutputs.set(original, fingerprint(original))
      }
    }
  }
  const result = spawnSync(process.execPath, [upstreamTsc, '-b', ...projectsToBuild], { cwd: sourceRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`upstream compiler failed: ${result.status}`)
  for (const declaration of declarationEntries) {
    if (!existsSync(declaration)) throw new Error(`upstream declaration missing: ${declaration}`)
  }

  const typescriptRoot = dirname(fileURLToPath(import.meta.resolve('typescript/package.json')))
  // tsc requires every input file to live under rootDir. POSIX '/' covers any
  // absolute path; on Windows '/' normalizes to the process drive, which need
  // not hold either tree — use the tui drive root and require the upstream source
  // to live on the same drive.
  const typeRoot = process.platform === 'win32' ? parse(tuiRoot).root : '/'
  if (process.platform === 'win32' && parse(sourceRoot).root !== typeRoot) {
    console.error(`upstream source must share the TUI drive for tsc rootDir (tui ${typeRoot}, source ${parse(sourceRoot).root})`)
    throw new Error('upstream input validation failed')
  }
  const projects = [
    { label: 'dsh-tui', config: join(tuiRoot, 'tsconfig.json') },
    { label: 'dsh-auth', config: join(tuiRoot, 'dsh-auth/tsconfig.json') },
  ]
  const failures = []
  for (const project of projects) {
    try {
    const tempRoot = join(isolation, project.label)
    mkdirSync(tempRoot)
    const generatedConfig = join(tempRoot, 'tsconfig.json')
    writeFileSync(generatedConfig, `${JSON.stringify({
      extends: project.config,
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024'],
        noEmit: true,
        declaration: false,
        declarationMap: false,
        rootDir: typeRoot,
        allowImportingTsExtensions: true,
        typeRoots: [join(tuiRoot, 'node_modules/@types')],
        paths: sourcePaths,
      },
    }, null, 2)}\n`)
    const parsed = ts.getParsedCommandLineOfConfigFile(generatedConfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: error => { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')) } })
    if (!parsed || parsed.errors.length) throw new Error('invalid consumer configuration')
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    assertCheckoutResolution(program, parsed.options, sourceRoot)
    const result = spawnSync(process.execPath, [
      join(typescriptRoot, 'bin/tsc'),
      '--project', generatedConfig,
      '--pretty', 'false',
    ], { cwd: tuiRoot, stdio: 'inherit' })
    rmSync(tempRoot, { recursive: true, force: true })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`upstream compiler failed: ${result.status}`)
    console.log(`upstream source types OK (${project.label})`)
    } catch (error) {
      failures.push(`${project.label}: ${error.message}`)
      console.error(`upstream source types FAIL (${project.label}): ${error.message}`)
    }
  }
  console.log(`upstream source types ${failures.length ? 'FAIL' : 'OK'} (${sourceManifest.version ?? 'unversioned checkout'}; ${Object.keys(sourcePaths).length} path mappings)`)

  if (process.argv.includes('--live-session')) {
    const live = spawnSync(process.execPath, ['--import', 'tsx/esm', join(tuiRoot, 'scripts/verify-live-session.ts'), '--real-upstream'], { cwd: tuiRoot, stdio: 'inherit', env: { ...process.env, HOME: isolation, USERPROFILE: isolation, DSH_HOME: join(isolation, 'dsh-home'), DSH_HARNESS_SOURCE_ROOT: sourceRoot, TSX_TSCONFIG_PATH: join(sourceRoot, 'tsconfig.base.json') } })
    if (live.error || live.status !== 0) failures.push(`isolated upstream Session failed: ${live.error ?? live.status}`)
    console.log(`isolated upstream Session ${live.status === 0 ? 'OK' : 'FAIL'}`)
  }
  if (failures.length) throw new Error(failures.join('\n'))
} finally {
  rmSync(isolation, { recursive: true, force: true })
  for (const [path, before] of originalOutputs) {
    if (fingerprint(path) !== before) throw new Error(`upstream input output changed during verification: ${path}`)
  }
  if (originalOutputs.size) console.log(`upstream input outputs unchanged (${originalOutputs.size} files)`)
}
