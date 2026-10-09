import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const begin = '# BEGIN dsh-cli managed PATH'
const end = '# END dsh-cli managed PATH'
const marker = '# dsh-cli managed launcher'

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

export interface CliRegistrationOptions {
  home?: string
  dshHome?: string
  path?: string
  shell?: string
  platform?: NodeJS.Platform
  zdotdir?: string
  xdgConfigHome?: string
  localAppData?: string
  cliEntry?: string
  dshRoot?: string
  windowsUserPath?: { read(): string; write(value: string): void }
}

function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function atomicWrite(path: string, content: string, mode?: number): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}

function updateOwnedFile(path: string, content: string, mode?: number): boolean {
  const target = pathExists(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path
  if (pathExists(target)) {
    const current = readFileSync(target, 'utf8')
    if (current === content) return false
    if (!current.startsWith(`#!/bin/sh\n${marker}`) && !current.startsWith('@echo off\r\nrem dsh-cli managed launcher\r\n')) {
      throw new Error(`${path} already belongs to another command`)
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  atomicWrite(target, content, mode)
  return true
}

function updateShellFile(path: string, line: string): boolean {
  const target = pathExists(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path
  const current = pathExists(target) ? readFileSync(target, 'utf8') : ''
  const first = current.indexOf(begin)
  const last = current.indexOf(end)
  if ((first < 0) !== (last < 0) || (first >= 0 && (last < first || current.indexOf(begin, first + begin.length) >= 0 || current.indexOf(end, last + end.length) >= 0))) {
    throw new Error(`malformed dsh-cli PATH block in ${path}`)
  }
  const block = `${begin}\n${line}\n${end}`
  const next = first < 0
    ? `${current}${current !== '' && !current.endsWith('\n') ? '\n' : ''}${block}\n`
    : current.slice(0, first) + block + current.slice(last + end.length)
  if (next === current) return false
  mkdirSync(dirname(target), { recursive: true })
  atomicWrite(target, next, pathExists(target) ? statSync(target).mode : 0o600)
  return true
}

function posixShellFiles(home: string, shell: string, zdotdir: string | undefined, xdg: string | undefined): string[] {
  switch (basename(shell)) {
    case 'zsh': return [join(zdotdir || home, '.zshrc')]
    case 'fish': return [join(xdg || join(home, '.config'), 'fish', 'conf.d', 'dsh-cli.fish')]
    case 'bash': {
      const login = ['.bash_profile', '.bash_login', '.profile'].map(name => join(home, name))
      return [join(home, '.bashrc'), login.find(existsSync) ?? login[0]!]
    }
    default: throw new Error(`unsupported shell ${shell}; add ~/.local/bin to PATH manually`)
  }
}

/** Resolve a Harness source entry, never the caller's project directory. */
function harnessSourceRoot(cliEntry: string | undefined): string | undefined {
  if (cliEntry === undefined) return undefined
  try {
    const entry = realpathSync(cliEntry)
    const root = resolve(dirname(entry), '../../..')
    if (entry !== join(root, 'apps', 'cli', 'src', 'bin.ts')
      && entry !== join(root, 'apps', 'cli', 'lib', 'bin.js')) return undefined
    const pkg = JSON.parse(readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8'))
    return pkg.name === '@deepseek-ai/dsh' ? root : undefined
  } catch {
    return undefined
  }
}

function configuredHarnessRoot(root: string | undefined): string | undefined {
  if (root === undefined || !isAbsolute(root)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8'))
    return pkg.name === '@deepseek-ai/dsh' ? realpathSync(root) : undefined
  } catch {
    return undefined
  }
}

/** Register a user-owned launcher for the existing dsh-cli profile. No DSH state is changed. */
export function ensureCliRegistered(options: CliRegistrationOptions = {}): string {
  const home = options.home ?? homedir()
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh')
  const platform = options.platform ?? process.platform
  const shell = options.shell ?? process.env.SHELL ?? ''
  const pathValue = options.path ?? process.env.PATH ?? ''
  const sourceRoot = harnessSourceRoot(options.cliEntry ?? process.argv[1])
    ?? configuredHarnessRoot(options.dshRoot ?? process.env.DSH_CLI_DSH_ROOT)
  const binDir = platform === 'win32'
    ? join(options.localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'dsh-cli', 'bin')
    : join(home, '.local', 'bin')
  const command = join(binDir, platform === 'win32' ? 'dsh-cli.cmd' : 'dsh-cli')
  const profilePackage = join(dshHome, 'profiles', 'dsh-cli', 'node_modules', '@askdkc', 'dsh-cli')
  try {
    if (JSON.parse(readFileSync(join(profilePackage, 'package.json'), 'utf8')).name !== '@askdkc/dsh-cli') {
      throw new Error('unexpected package identity')
    }
  } catch {
    throw new Error(`dsh-cli profile package is missing or unreadable at ${profilePackage}`)
  }
  const currentCommand = pathValue.split(platform === 'win32' ? ';' : ':')
    .filter(dir => dir.length > 0)
    .map(dir => join(dir, platform === 'win32' ? 'dsh-cli.cmd' : 'dsh-cli'))
    .find(candidate => candidate !== command && pathExists(candidate) && !candidate.includes(`${join('node_modules', '.bin')}`))
  if (currentCommand !== undefined) return `Existing dsh-cli command at ${currentCommand} was kept; automatic registration skipped.`
  mkdirSync(binDir, { recursive: true })
  const lock = join(binDir, '.dsh-cli-registration.lock')
  let handle: number
  try { handle = openSync(lock, 'wx') }
  catch {
    if (pathExists(lock) && Date.now() - statSync(lock).mtimeMs > 120000) {
      rmSync(lock, { force: true })
      handle = openSync(lock, 'wx')
    } else {
      throw new Error(`registration is already running (${lock}); retry on next TUI start`)
    }
  }
  try {
    const target = join('profiles', 'dsh-cli', 'node_modules', '@askdkc', 'dsh-cli', 'bin', 'dsh-cli.js')
    const content = platform === 'win32'
      ? `@echo off\r\nrem dsh-cli managed launcher\r\nsetlocal DisableDelayedExpansion\r\nif not defined DSH_HOME set "DSH_HOME=${dshHome.replace(/%/g, '%%')}"\r\nnode "%DSH_HOME%\\${target.replace(/\//g, '\\')}" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\n${marker}\nDEFAULT_DSH_HOME=${quoted(dshHome)}\n: "\${DSH_HOME:=$DEFAULT_DSH_HOME}"\nexport DSH_HOME\nexec node "$DSH_HOME/${target}" "$@"\n`
    let keepExistingDefault = false
    if (pathExists(command)) {
      const existing = readFileSync(command, 'utf8')
      keepExistingDefault = existing.startsWith(platform === 'win32' ? '@echo off\r\nrem dsh-cli managed launcher\r\n' : `#!/bin/sh\n${marker}\n`)
        && existing !== content
    }
    const changed = keepExistingDefault ? false : updateOwnedFile(command, content, 0o755)
    if (platform === 'win32') {
      const userPath = options.windowsUserPath ?? {
        read: () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetEnvironmentVariable("Path", "User")'], { encoding: 'utf8', timeout: 5000 }).trim(),
        write: (value: string) => {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::SetEnvironmentVariable("Path", $env:DSH_CLI_USER_PATH, "User")'], {
            env: { ...process.env, DSH_CLI_USER_PATH: value }, timeout: 5000,
          })
        },
      }
      const current = userPath.read()
      if (!current.split(';').some(part => part.toLowerCase() === binDir.toLowerCase())) {
        const next = current ? `${current};${binDir}` : binDir
        userPath.write(next)
      }
    } else {
      const files = posixShellFiles(home, shell, options.zdotdir ?? process.env.ZDOTDIR, options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME)
      const pathLine = basename(shell) === 'fish'
        ? `contains -- ${quoted(binDir)} $PATH; or set -gx PATH ${quoted(binDir)} $PATH`
        : `case ":$PATH:" in *:${quoted(binDir)}:*) ;; *) export PATH=${quoted(binDir)}:"$PATH" ;; esac`
      const sourceLine = sourceRoot === undefined ? '' : basename(shell) === 'fish'
        ? `\nset -q DSH_CLI_DSH_ROOT; or set -gx DSH_CLI_DSH_ROOT ${quoted(sourceRoot)}`
        : `\nif [ -z "\${DSH_CLI_DSH_ROOT:-}" ]; then export DSH_CLI_DSH_ROOT=${quoted(sourceRoot)}; fi`
      const line = pathLine + sourceLine
      for (const file of files) updateShellFile(file, line)
    }
    return keepExistingDefault
      ? `Kept ${command} with its original DSH_HOME default. Open a new shell to use dsh-cli; set DSH_HOME explicitly to use another installation.`
      : changed ? `Registered ${command}. Open a new shell to use dsh-cli.` : `dsh-cli registration is current at ${command}.`
  } finally {
    closeSync(handle)
    rmSync(lock, { force: true })
  }
}
