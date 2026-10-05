#!/usr/bin/env node
// Polyfill Intl.Segmenter for pkg small-icu builds so string-width, wrap-ansi, and ansi-tokenize work seamlessly
if (typeof Intl !== 'undefined') {
  let needsPolyfill = false
  try {
    const test = new Intl.Segmenter()
    test.segment('test')
  } catch {
    needsPolyfill = true
  }
  if (needsPolyfill) {
    Intl.Segmenter = class Segmenter {
      constructor(locale, options) {
        this.granularity = options?.granularity || 'grapheme'
      }
      segment(input) {
        const str = String(input ?? '')
        return {
          *[Symbol.iterator]() {
            let index = 0
            for (const char of str) {
              yield {
                segment: char,
                index,
                input: str,
                isWordLike: /\w/.test(char),
              }
              index += char.length
            }
          },
        }
      }
    }
  }
}
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { extractRuntime } = require('./extractRuntime.cjs')

const { existsSync, rmSync } = require('node:fs')
const { ensureProfile } = require('./runtime.cjs')
const metadata = require('./runtime-meta.json')

// Runtime cache integrity guard (hash manifest + runtimeReady/ensureRuntime;
// single source of truth in cacheGuard.cjs, tested directly by
// scripts/verify-standalone-cache-guard.mjs).
const { ensureRuntime } = require('./cacheGuard.cjs')

const TUI_VERSION = metadata.tuiVersion
const BUNDLE_ID = metadata.bundleId
const PROFILE = 'dsh-cli'
const archivePath = join(__dirname, 'runtime.tar.gz')

const cacheBase = resolve(
  process.env.DSH_TUI_STANDALONE_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-tui-standalone'),
)
const runtimeRoot = join(cacheBase, BUNDLE_ID)
const dshBin = join(runtimeRoot, metadata.binPath)

/**
 * Ensure the bundled runtime archive is unpacked into the cache directory.
 * Delegates to cacheGuard.cjs (hash-manifest guard + extraction flow).
 */
async function ensureRuntimeReady() {
  await ensureRuntime({
    cacheBase,
    runtimeRoot,
    bundleId: BUNDLE_ID,
    archivePath,
    extract: extractRuntime,
    requiredPaths: [
      metadata.binPath,
      'node_modules/@askdkc/dsh-cli/cordis.patch.yml',
    ],
    log: text => process.stderr.write(text),
  })
}

// Clean up Windows .old backup file from a previous update
if (process.platform === 'win32') {
  try {
    const oldBinary = `${process.execPath}.old`
    if (existsSync(oldBinary)) rmSync(oldBinary, { force: true })
  } catch {
    // Best effort cleanup.
  }
}

async function main() {
  await ensureRuntimeReady()
  process.env.DSH_HOME = resolve(
    process.env.DSH_TUI_STANDALONE_HOME ?? join(homedir(), '.dsh-tui-standalone'),
  )
  ensureProfile({ home: process.env.DSH_HOME, runtimeRoot, tuiVersion: TUI_VERSION, profile: PROFILE })

  process.env.DSH_TUI_STANDALONE = '1'
  process.env.DSH_TUI_STANDALONE_BINARY = process.execPath
  process.env.DSH_TUI_LAUNCHER_VERSION = TUI_VERSION
  process.argv = [process.execPath, dshBin, '--profile', PROFILE, ...process.argv.slice(2)]
  const { runCli } = await import(pathToFileURL(dshBin).href)
  if (typeof runCli !== 'function') throw new Error(`Bundled DSH CLI has no runCli() entry: ${dshBin}`)
  await runCli()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
