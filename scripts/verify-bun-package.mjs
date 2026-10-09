import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const projectManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const packageName = projectManifest.name
const nodeCommand = process.execPath
const npmCommand = 'npm'

const isExecutable = async path => {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolveBunCommand = async () => {
  const configured = process.env.DSH_CLI_BUN_COMMAND
  if (configured) {
    if (!isAbsolute(configured) || await isExecutable(configured)) return configured
    throw new Error(`Bun executable configured by DSH_CLI_BUN_COMMAND was not found: ${configured}`)
  }

  if (process.platform !== 'win32') return 'bun'

  const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const installRoots = [process.env.BUN_INSTALL, join(homedir(), '.bun')].filter(Boolean)
  const candidates = [
    ...pathDirectories.flatMap(directory => [
      join(directory, 'bun.exe'),
      // npm's global `bun.cmd` shim delegates to this executable.
      join(directory, 'node_modules', 'bun', 'bin', 'bun.exe'),
    ]),
    ...installRoots.map(root => join(root, 'bin', 'bun.exe')),
  ]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  return 'bun'
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `Unable to start ${command}: executable not found. Install it or ensure its executable directory is on PATH.`,
      { cause: result.error },
    )
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit code'}):\n${output}`)
  }
  return result.stdout
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-bun-package-'))
try {
  const packOutput = run(nodeCommand, [
    join(projectRoot, 'scripts', 'with-publish-manifest.mjs'),
    npmCommand,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], projectRoot)
  const reports = JSON.parse(packOutput)
  const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
  if (report === undefined || typeof report.filename !== 'string') {
    throw new Error('npm pack did not return a tarball filename')
  }

  await writeFile(join(temporaryRoot, 'package.json'), '{"private":true,"type":"module"}\n')
  const bunCommand = await resolveBunCommand()
  // A real DSH host provides the optional framework peers. Model that host
  // with the exact dependency graph resolved in this repository's lockfile.
  const hostPeers = (await Promise.all(Object.keys(projectManifest.peerDependenciesMeta ?? {})
    .filter(name => name.startsWith('@deepseek-ai/'))
    .map(async name => {
      try {
        const { version } = JSON.parse(await readFile(
          join(projectRoot, 'node_modules', name, 'package.json'), 'utf8',
        ))
        return `${name}@${version}`
      } catch {
        return undefined
      }
    }))).filter(Boolean)
  run(bunCommand, ['add', ...hostPeers, join(temporaryRoot, report.filename)], temporaryRoot)
  run(bunCommand, [
    '-e',
    [
      `await import(${JSON.stringify(packageName)})`,
      `await import(${JSON.stringify(`${packageName}/extensions`)})`,
      `await import(${JSON.stringify(`./node_modules/${packageName}/node_modules/@dsh-std/manifest`)})`,
      `await import(${JSON.stringify(`./node_modules/${packageName}/node_modules/dsh-working-activity`)})`,
    ].join(';'),
  ], temporaryRoot)

  console.log('bun package install OK (root, extensions, bundled @dsh-std and activity runtime imported)')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
