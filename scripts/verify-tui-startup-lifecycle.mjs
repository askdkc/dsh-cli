/** A pending unrelated Loader task must not prevent the frontend's own child from starting. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as tui from '../src/dsh-adapter/index.ts'
import { settled } from './lib/term-test.mjs'

const saved = Object.fromEntries(['DSH_TUI_LAUNCHER_VERSION', 'DSH_TUI_STANDALONE'].map(name => [name, process.env[name]]))
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
for (const name of Object.keys(saved)) delete process.env[name]
const root = new Context()
let globalWaits = 0
root.provide('agents', {})
root.provide('loader', { await() { globalWaits++; return new Promise(() => {}) } })
const runtime = () => [...root.registry.values()].find(value => value.name === 'dsh-tui-runtime')
const runtimeFibers = () => [...(runtime()?.fibers ?? [])]
try {
  // This fixture exercises a headless host, even when a local build inherits
  // a terminal. Interactive startup requires a real Loader Config owner.
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  // The real plugin follows its headless branch in this process; it still has
  // to schedule, activate and own that runtime child through real Cordis.
  const owner = await root.plugin(tui, {})
  assert.ok(await settled(() => runtimeFibers()[0]?.state === 2), 'frontend child must activate without waiting for unrelated Loader work')
  assert.equal(globalWaits, 0)
  await owner.dispose()
  assert.equal(runtimeFibers().length, 0, 'the entry owns and disposes its runtime child')
  console.log('TUI startup lifecycle OK (owner settlement, independent Loader work, child cleanup)')
} finally {
  await root.fiber.dispose()
  if (stdoutTty === undefined) delete process.stdout.isTTY
  else Object.defineProperty(process.stdout, 'isTTY', stdoutTty)
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
