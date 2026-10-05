#!/usr/bin/env node
/**
 * 生成 dsh-TUI 便携包（Standalone Single Executable Bundles）。
 *
 * 用法：
 *   node scripts/make-standalone-bundle.mjs [--out <dir>] [--targets <targets>]
 *
 * 产物：<out>/ 目录下各平台的压缩包：
 *   - dsh-tui-standalone-linux-x64.tar.gz  (内含 dsh-tui)
 *   - dsh-tui-standalone-linux-arm64.tar.gz (内含 dsh-tui)
 *   - dsh-tui-standalone-darwin-arm64.tar.gz (内含 dsh-tui)
 *   - dsh-tui-standalone-darwin-x64.tar.gz (内含 dsh-tui)
 */
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createStandaloneArchive } from './lib/standalone-archive.mjs'
import { readRuntimeMetadata, ensureProfile } from '../standalone/runtime.cjs'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { standaloneTarget, stageStandaloneLauncher, pruneForeignPackages, prepareTargetPty } from './lib/standalone-layout.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const argOut = process.argv.indexOf('--out')
const outDir = resolve(argOut >= 0 ? process.argv[argOut + 1] : join(root, 'dist-standalone'))

const argTargets = process.argv.indexOf('--targets')
const defaultTargets = 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64'
const targets = argTargets >= 0 ? process.argv[argTargets + 1] : defaultTargets
const targetList = targets.split(',').map(standaloneTarget)
// Each executable carries only its own native dependency graph.
if (targetList.length > 1) {
  for (const target of targetList) {
    const args = [fileURLToPath(import.meta.url), '--targets', target.name, '--out', process.argv.includes('--skip-pkg') ? join(outDir, target.name) : outDir]
    if (process.argv.includes('--skip-pkg')) args.push('--skip-pkg')
    execFileSync(process.execPath, args, { stdio: 'inherit' })
  }
  process.exit(0)
}
const target = targetList[0]

const temporaryDir = mkdtempSync(join(tmpdir(), 'dsh-cli-standalone-'))
const standaloneDir = join(temporaryDir, 'standalone')
mkdirSync(standaloneDir, { recursive: true })
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'entry.cjs', 'cacheGuard.cjs', 'runtime.cjs', 'extractRuntime.cjs', 'pkg.config.json']) {
  copyFileSync(join(root, 'standalone', name), join(standaloneDir, name))
}
process.on('exit', () => rmSync(temporaryDir, { recursive: true, force: true }))
const runtimeTar = join(standaloneDir, 'runtime.tar.gz')

// ── 发布自助同步（一劳永逸）──────────────────────────────────────────
// 本脚本从本地源码打包 fork，standalone/package.json 指向这个 tarball；
// 构建在临时目录运行，不改写仓库里的 manifest 或 lockfile。lockfile-only
// 仍遵守 minimumReleaseAge，避免选到刚发布的第三方依赖；随后 frozen
// install 严格使用生成的锁文件。
const FIRST_PARTY_PACKAGES = ['dsh-working-activity']
const workspaceYamlPath = join(standaloneDir, 'pnpm-workspace.yaml')
const lockfilePath = join(standaloneDir, 'pnpm-lock.yaml')
const standalonePkgPath = join(standaloneDir, 'package.json')
const workspaceConfig = YAML.parse(readFileSync(workspaceYamlPath, 'utf8'))
// Lifecycle scripts run on the build host, including when cross-packaging.
// Keep its prebuilds available during install, then remove foreign packages.
workspaceConfig.supportedArchitectures = {
  os: [...new Set([target.os, process.platform])], cpu: [...new Set([target.cpu, process.arch])], libc: ['glibc'],
}
writeFileSync(workspaceYamlPath, YAML.stringify(workspaceConfig))

/**
 * Distinct resolved versions of each first-party package in the lockfile —
 * packages/snapshot section keys read `'name@version'` / `'name@version(peers)'`.
 */
function firstPartyLockfileVersions() {
  const result = new Map(FIRST_PARTY_PACKAGES.map(name => [name, new Set()]))
  let text = ''
  try {
    text = readFileSync(lockfilePath, 'utf8')
  } catch {
    return result
  }
  for (const name of FIRST_PARTY_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Scoped names serialize as `'name@version'` (quoted), unscoped as
    // `name@version:` — the leading quote is optional and the capture stops
    // at a quote, a peer-suffix `(`, or the key's trailing `:`.
    const pattern = new RegExp(`^  '?${escaped}@([^'(:\\s]+)`, 'gm')
    for (const match of text.matchAll(pattern)) result.get(name).add(match[1])
  }
  return result
}

/**
 * Ensure the workspace config's minimumReleaseAgeExclude carries exact
 * entries for the given first-party versions (stale own entries replaced,
 * foreign entries preserved). Returns true when the file was written.
 */
function syncReleaseAgeExcludes(versionsByName) {
  let text = ''
  try {
    text = readFileSync(workspaceYamlPath, 'utf8')
  } catch {
    return false
  }
  const ours = []
  for (const [name, versions] of versionsByName) {
    if (versions.size > 0) ours.push(`  - '${name}@${[...versions].sort().join(' || ')}'`)
  }
  if (ours.length === 0) return false
  const lines = text.split(/\r?\n/)
  let blockStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== '' && line === line.trimStart() && /^minimumReleaseAgeExclude:/.test(line)) {
      blockStart = i
      break
    }
  }
  if (blockStart === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    lines.push('minimumReleaseAgeExclude:', ...ours)
  } else {
    let blockEnd = blockStart + 1
    const kept = []
    for (let i = blockStart + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line === '' || line === line.trimStart()) break
      blockEnd = i + 1
      const item = line.trim().replace(/^-\s*/, '').replace(/^'(.*)'$/, '$1')
      if (!FIRST_PARTY_PACKAGES.some(name => item === name || item.startsWith(`${name}@`))) kept.push(line)
    }
    lines.splice(blockStart + 1, blockEnd - blockStart - 1, ...kept, ...ours)
  }
  const next = `${lines.join('\n')}\n`
  if (next === text) return false
  writeFileSync(workspaceYamlPath, next, 'utf8')
  return true
}

console.log(`\n============================================`)
console.log(`  dsh-TUI Standalone Bundle Builder`)
console.log(`  Version: ${version}`)
console.log(`  Targets: ${targets}`)
console.log(`  Output:  ${outDir}`)
console.log(`============================================\n`)

// 1. 同步版本号
console.log('==> 同步版本号到 standalone 配置…')
if (existsSync(standalonePkgPath)) {
  const sPkg = JSON.parse(readFileSync(standalonePkgPath, 'utf8'))
  if (!existsSync(join(root, 'lib', 'types', 'index.js'))) {
    throw new Error('Compile the fork before building standalone bundles: pnpm compile')
  }
  const packJson = execFileSync(process.execPath, [
    join(root, 'scripts', 'with-publish-manifest.mjs'),
    'npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDir,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(temporaryDir, 'npm-cache') },
  })
  const packed = JSON.parse(packJson)[0]
  if (packed?.name !== pkg.name || packed?.version !== version || !packed?.filename) {
    throw new Error('Local fork tarball identity does not match package.json')
  }
  delete sPkg.dependencies['dsh-cli']
  sPkg.dependencies[pkg.name] = `file:${join(temporaryDir, packed.filename)}`
  // Use the same package manager as CI, even in the temporary workspace.
  sPkg.packageManager = pkg.packageManager
  writeFileSync(standalonePkgPath, `${JSON.stringify(sPkg, null, 2)}\n`, 'utf8')
}

// 2. 构建 runtime.tar.gz 运行时资源包
console.log('==> 构建 runtime.tar.gz 运行时资源包…')
rmSync(runtimeTar, { force: true })
console.log('    正在同步 lockfile（仅重解析改写的 spec）…')
// 本地 tarball 改写了 fork 的依赖 spec；供应链年龄策略在解析时继续生效。
execSync('pnpm install --lockfile-only --no-frozen-lockfile', { cwd: standaloneDir, stdio: 'inherit' })
const firstParty = firstPartyLockfileVersions()
if (syncReleaseAgeExcludes(firstParty)) {
  const described = [...firstParty.entries()]
    .filter(([, versions]) => versions.size > 0)
    .map(([name, versions]) => `${name}@${[...versions].sort().join(' || ')}`)
    .join(', ')
  console.log(`    已同步 minimumReleaseAgeExclude：${described}`)
}
console.log('    正在执行 pnpm install…')
// --frozen-lockfile：便携包供应链锁死——install 只按 pnpm-lock.yaml 的
// 已解析版本装包，绝不隐式改 lock 拉新（--no-frozen-lockfile 会让每次
// 构建重新解析依赖，被投毒的镜像/registry 能在构建机无感知换入恶意
// 版本并打进发布产物）。lock 失配会直接失败，提示提交新的 lock 而非
// 构建期静默重解析；上面的 lockfile-only 预同步保证 spec 与 lock 一致，
// fork 本体使用本地 tarball，不需要 registry 年龄豁免。
execSync('pnpm install --frozen-lockfile', { cwd: standaloneDir, stdio: 'inherit' })
const metadata = readRuntimeMetadata(standaloneDir)
const smokeHome = join(temporaryDir, 'smoke-home')
ensureProfile({ home: smokeHome, runtimeRoot: standaloneDir, tuiVersion: metadata.tuiVersion })
// Validate the real host graph before spending time archiving it. Keep resolved
// config off stdout: a caller may have provider settings in the environment.
const smokeEnv = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  HOME: smokeHome, USERPROFILE: smokeHome, DSH_HOME: smokeHome,
  DSH_TELEMETRY_MODE: 'DISABLED', NODE_ENV: 'production',
}
for (const args of [['--help'], ['--profile', 'dsh-cli', '--dump-config']]) {
  const result = execFileSync(process.execPath, [join(standaloneDir, metadata.binPath), ...args], {
    cwd: standaloneDir, env: smokeEnv, encoding: 'utf8', timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.trim() === '') throw new Error(`Bundled DSH did not execute ${args.join(' ')}`)
}
rmSync(smokeHome, { recursive: true, force: true })
console.log(`    Removed ${pruneForeignPackages(join(standaloneDir, 'node_modules'), target)} foreign platform packages for ${target.name}`)
prepareTargetPty(standaloneDir, target)
console.log('    正在打包 node_modules 到 runtime.tar.gz…')
createStandaloneArchive(runtimeTar, standaloneDir, ['node_modules'])
const archiveDigest = createHash('sha256').update(readFileSync(runtimeTar)).digest('hex')
metadata.bundleId = `tui-${metadata.tuiVersion}-dsh-${metadata.dshVersion}-${archiveDigest.slice(0, 16)}`
writeFileSync(join(standaloneDir, 'runtime-meta.json'), `${JSON.stringify(metadata, null, 2)}\n`)
const tarStat = statSync(runtimeTar)
console.log(`    [OK] runtime.tar.gz (${(tarStat.size / 1024 / 1024).toFixed(2)} MB)`)

if (process.argv.includes('--skip-pkg')) {
  mkdirSync(outDir, { recursive: true })
  for (const name of ['runtime.tar.gz', 'runtime-meta.json', 'entry.cjs', 'cacheGuard.cjs', 'runtime.cjs', 'extractRuntime.cjs']) {
    copyFileSync(join(standaloneDir, name), join(outDir, name))
  }
  console.log('\n[OK] --skip-pkg 指定，跳过 pkg 二进制编译。')
  process.exit(0)
}

// 3. 准备输出目录与临时构建目录
const stageDir = join(outDir, '.stage')
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

// 4. 调用 pkg 编译
console.log(`\n==> 编译 Standalone 二进制 (${targets})…`)
const launcherDir = join(temporaryDir, 'launcher')
stageStandaloneLauncher(standaloneDir, launcherDir)
const entryFile = join(launcherDir, 'entry.cjs')
const pkgConfig = join(launcherDir, 'pkg.config.json')
const pkgManifestPath = fileURLToPath(import.meta.resolve('@yao-pkg/pkg/package.json'))
const pkgManifest = JSON.parse(readFileSync(pkgManifestPath, 'utf8'))
const pkgBin = join(dirname(pkgManifestPath), typeof pkgManifest.bin === 'string' ? pkgManifest.bin : pkgManifest.bin.pkg)
const pkgArgs = [
  pkgBin,
  entryFile,
  '--config',
  pkgConfig,
  '--targets',
  targets,
  '--out-path',
  stageDir,
  // runtime.tar.gz is already compressed. pkg compression would materialize
  // the entire large asset in memory and a temporary file before tar can read it.
  '--compress',
  'None',
  '--no-bytecode',
  '--public',
  '--public-packages',
  '*',
]
execFileSync(process.execPath, pkgArgs, { cwd: root, stdio: 'inherit' })

// 5. 整理产物并归档压缩
console.log(`\n==> 打包压缩各平台便携包…`)
const stagedFiles = readdirSync(stageDir)
if (stagedFiles.length === 0) throw new Error('Standalone builder produced no executable')

const targetMap = [
  { match: /^entry-linux-arm64$/i, platform: 'linux-arm64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^(?:entry-linux(?:-x64)?|entry)$/i, platform: 'linux-x64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^entry-win(?:-x64)?(?:\.exe)?$/i, platform: 'win-x64', binary: 'dsh-tui.exe', format: 'zip' },
  { match: /^entry-(?:macos|darwin)-arm64$/i, platform: 'darwin-arm64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^entry-(?:macos|darwin)(?:-x64)?$/i, platform: 'darwin-x64', binary: 'dsh-tui', format: 'tar.gz' },
]

for (const stagedFile of stagedFiles) {
  const stagedPath = join(stageDir, stagedFile)
  const stat = statSync(stagedPath)
  if (!stat.isFile()) continue

  let matched = null
  if (!targets.includes(',')) {
    const target = /^node\d+-(linux|macos|win)-(x64|arm64)$/u.exec(targets)
    if (!target) throw new Error(`Unsupported standalone target: ${targets}`)
    const platform = `${target[1] === 'macos' ? 'darwin' : target[1]}-${target[2]}`
    matched = { platform, binary: target[1] === 'win' ? 'dsh-tui.exe' : 'dsh-tui', format: target[1] === 'win' ? 'zip' : 'tar.gz' }
  }
  for (const item of targetMap) {
    if (matched) break
    if (item.match.test(stagedFile)) {
      matched = item
      break
    }
  }

  if (!matched) {
    throw new Error(`Unknown standalone build artifact: ${stagedFile}`)
  }

  const { platform, binary: binaryName, format } = matched
  const archiveName = `dsh-tui-standalone-${platform}.${format}`
  const archivePath = join(outDir, archiveName)

  // 临时存放二进制并赋权
  const binDir = join(stageDir, `bin-${platform}`)
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  const targetBinPath = join(binDir, binaryName)
  copyFileSync(stagedPath, targetBinPath)
  try {
    chmodSync(targetBinPath, 0o755)
  } catch {
    // Windows file permissions
  }

  // 压缩归档
  if (existsSync(archivePath)) rmSync(archivePath, { force: true })
  if (format === 'zip') {
    if (process.platform === 'win32') {
      // 优先 Windows 10+ 自带 bsdtar（-a 按后缀写 zip），数组参数不经
      // shell、无注入面；tar 缺失才回退 Compress-Archive——路径含 `'`
      // 会闭合单引号字面量注入命令，必须按 PowerShell 约定把 ' 双写为 ''
      // （与 src/update.ts 的 escapePsSingleQuoted 同款）。
      // Git Bash's GNU tar treats drive letters as remote hosts and cannot
      // create ZIP files. Select Windows' own bsdtar independently of PATH.
      const windowsTar = process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'tar.exe')
      if (windowsTar && existsSync(windowsTar)) {
        execFileSync(windowsTar, ['-a', '-cf', archivePath, '-C', binDir, binaryName], { stdio: 'inherit' })
      } else {
        const psQuote = (s) => `'${s.replace(/'/g, "''")}'`
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Compress-Archive -Path ${psQuote(targetBinPath)} -DestinationPath ${psQuote(archivePath)} -Force`,
        ], { stdio: 'inherit' })
      }
    } else {
      execFileSync('zip', ['-j', archivePath, targetBinPath], { stdio: 'inherit' })
    }
  } else {
    createStandaloneArchive(archivePath, binDir, [binaryName])
  }

  const archStat = statSync(archivePath)
  console.log(`    [OK] ${archiveName} (${(archStat.size / 1024 / 1024).toFixed(2)} MB)`)
}

rmSync(stageDir, { recursive: true, force: true })
console.log(`\n便携包构建完成！产物位于：${outDir}`)
