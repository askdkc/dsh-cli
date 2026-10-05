'use strict'
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { win32 } = require('node:path')
const { x: extractTar } = require('tar')

function nativeTarPath(platform, systemRoot) {
  if (platform === 'win32') return systemRoot ? win32.join(systemRoot, 'System32', 'tar.exe') : null
  if (platform === 'darwin') return '/usr/bin/tar'
  if (platform === 'linux') return '/bin/tar'
  return null
}

/** Extract our generated archive using the OS tool, with a self-contained fallback. */
async function extractRuntime(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const executable = nativeTarPath(platform, dependencies.systemRoot ?? process.env.SystemRoot)
  const execute = dependencies.execute ?? execFileSync
  const fallback = dependencies.fallback ?? extractTar
  const exists = dependencies.exists ?? existsSync
  const hasCompressionHelper = platform !== 'linux' || exists('/usr/bin/gzip') || exists('/bin/gzip')
  if (executable && hasCompressionHelper) {
    try {
      // Never resolve tar via PATH: Git Bash tar misreads Windows drive letters.
      execute(executable, ['-xzf', options.file, '-C', options.cwd, '--no-same-owner'], {
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
        // GNU tar launches gzip separately. Use OS directories only, even when
        // the launcher has an empty PATH; never inherit caller-provided tools.
        ...(platform === 'linux' ? { env: { ...process.env, PATH: '/usr/bin:/bin' } } : {}),
      })
      return
    } catch (error) {
      // A corrupt archive or extraction failure must not be hidden by retrying.
      if (error.code !== 'ENOENT') throw error
    }
  }
  await fallback(options)
}

module.exports = { extractRuntime, nativeTarPath }
