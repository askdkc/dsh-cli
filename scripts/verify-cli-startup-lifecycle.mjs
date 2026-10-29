/** A pending unrelated Loader task must not prevent the frontend's own child from starting. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as tui from '../src/dsh-adapter/index.ts'
import { awaitConfiguredKiokukoStartup, ensureCliUserQuestions } from '../src/dsh-adapter/startup-addons.ts'
import { settled } from './lib/term-test.mjs'

const saved = Object.fromEntries(['DSH_CLI_LAUNCHER_VERSION', 'DSH_CLI_STANDALONE'].map(name => [name, process.env[name]]))
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
for (const name of Object.keys(saved)) delete process.env[name]
const root = new Context()
let globalWaits = 0
root.provide('agents', {})
root.provide('loader', {
  await() { globalWaits++; return new Promise(() => {}) },
  entries() { throw new Error('a headless host must not enter the interactive addon gate') },
})
const runtime = () => [...root.registry.values()].find(value => value.name === 'dsh-cli-runtime')
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
  console.log('dsh-cli startup lifecycle OK (owner settlement, independent Loader work, child cleanup)')
} finally {
  await root.fiber.dispose()
  if (stdoutTty === undefined) delete process.stdout.isTTY
  else Object.defineProperty(process.stdout, 'isTTY', stdoutTty)
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(run) {
  const ctx = new Context()
  const releases = []
  const warnings = []
  // Expected import/activation failures below are asserted through the actual
  // Loader boundary. Avoid printing them as unrelated verifier failures.
  ctx.logger.error = () => {}
  ctx.logger.warn = (...args) => warnings.push(args.map(String).join(' '))
  await ctx.plugin(Loader)
  const loader = ctx.get('loader')
  loader.await = () => { throw new Error('the frontend must never await the whole Loader') }
  const hold = () => { const gate = deferred(); releases.push(gate.resolve); return gate }
  const front = (timeoutMs = 1_000) => {
    const observed = { ready: false }
    observed.fiber = ctx.plugin({
      name: 'startup-test-frontend',
      async apply(frontend) {
        await ensureCliUserQuestions(frontend)
        if (!await awaitConfiguredKiokukoStartup(frontend, timeoutMs)) return
        observed.ready = true
      },
    })
    observed.result = Promise.resolve(observed.fiber).then(() => undefined, error => error)
    return observed
  }
  try { await run({ ctx, loader, hold, front, warnings }) } finally {
    for (const release of releases) release()
    await ctx.fiber.dispose()
  }
}

// Import completion does not imply activation completion. A sibling which is
// permanently pending must not delay the configured addon's own readiness.
await fixture(async ({ ctx, loader, hold, front }) => {
  const imported = hold(), mounted = hold()
  let importCalls = 0
  loader.import = name => {
    if (name === 'kiokuko-dsh') { importCalls++; return imported.promise }
    return { name, inject: ['neverProvided'], apply() {} }
  }
  const loading = loader.root.update([
    { id: 'kiokuko', name: 'kiokuko-dsh' },
    { id: 'unrelated', name: 'unrelated-pending' },
  ])
  const ui = front()
  assert.ok(await settled(() => !!ctx.get('userQuestions')))
  assert.equal(ui.ready, false, 'an unresolved Kiokuko import cannot expose input')
  imported.resolve({ name: 'kiokuko-dsh', inject: ['userQuestions'], async apply(addon) {
    await mounted.promise
    addon.provide('startupTestCommands', true)
  } })
  await loading
  assert.ok(await settled(() => loader.resolve('kiokuko').fiber.state === 1))
  assert.equal(ui.ready, false, 'commands are still mounting after import')
  assert.equal(importCalls, 1, 'refresh joins the existing import')
  mounted.resolve()
  assert.equal(await ui.result, undefined)
  assert.equal(ui.ready, true)
  assert.equal(ctx.get('startupTestCommands'), true)
  assert.equal(loader.resolve('unrelated').fiber.state, 0)
  await loader.resolve('kiokuko').update({ disabled: true })
  assert.equal(ui.fiber.state, 2, 'later addon unload must not own the frontend')
  await ui.fiber.dispose()
  assert.equal(ctx.get('userQuestions'), undefined, 'bare-host fallback is disposed with the frontend')
})

// Pending dependencies are observed through Cordis status events, including a
// userQuestions service created by a child of the still-loading frontend.
await fixture(async ({ ctx, loader, front }) => {
  loader.import = () => ({ name: 'kiokuko-dsh', inject: ['lateService', 'userQuestions'], apply() {} })
  await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  const ui = front()
  assert.ok(await settled(() => !!ctx.get('userQuestions')))
  assert.equal(loader.resolve('kiokuko').fiber.state, 0)
  assert.equal(ui.ready, false)
  ctx.provide('lateService', {})
  assert.equal(await ui.result, undefined)
  assert.equal(ui.ready, true)
})

// Core-only, disabled rows and explicitly disabled addon config do not wait.
for (const options of [undefined, { disabled: true }, { config: { enabled: false } }]) {
  await fixture(async ({ loader, front }) => {
    loader.import = () => ({ name: 'kiokuko-dsh', inject: ['neverProvided'], apply() {} })
    await loader.root.update(options ? [{ id: 'kiokuko', name: 'kiokuko-dsh', ...options }] : [])
    const ui = front()
    assert.equal(await ui.result, undefined)
    assert.equal(ui.ready, true)
  })
}

for (const stage of ['import', 'apply']) {
  await fixture(async ({ ctx, loader, front, warnings }) => {
    loader.import = () => stage === 'import'
      ? Promise.reject(new Error('fixture import failure'))
      : {
        name: 'kiokuko-dsh',
        apply(addon) {
          addon.provide('startupTestPartialKiokuko', true)
          throw new Error('fixture apply failure')
        },
      }
    await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
    const ui = front()
    assert.equal(await ui.result, undefined)
    assert.equal(ui.ready, true, 'an optional addon failure must not take down the CLI')
    assert.equal(ctx.get('startupTestPartialKiokuko'), undefined, 'failed addon registrations must roll back before input is exposed')
    assert.ok(warnings.some(line => line.includes('kiokuko-dsh') && line.includes('continuing without it')), 'degraded startup must be visible')
  })
}

await fixture(async ({ loader, front }) => {
  loader.import = () => ({ name: 'kiokuko-dsh', inject: ['neverProvided'], apply() {} })
  await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  const ui = front(20)
  assert.match((await ui.result)?.message ?? '', /kiokuko-dsh startup timed out.*waiting for required services/)
  assert.equal(ui.ready, false)
})

// Disabling an addon while its dependencies are pending releases the gate.
await fixture(async ({ ctx, loader, front }) => {
  loader.import = () => ({ name: 'kiokuko-dsh', inject: ['neverProvided'], apply() {} })
  await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  const ui = front()
  assert.ok(await settled(() => !!ctx.get('userQuestions')))
  assert.equal(ui.ready, false)
  await loader.resolve('kiokuko').update({ disabled: true })
  assert.equal(await ui.result, undefined)
  assert.equal(ui.ready, true, 'disabling the configured addon releases the startup gate')
})

// Owner teardown cancels the gate without waiting for the missing dependency.
await fixture(async ({ ctx, loader, front }) => {
  loader.import = () => ({ name: 'kiokuko-dsh', inject: ['neverProvided'], apply() {} })
  await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  const ui = front()
  assert.ok(await settled(() => !!ctx.get('userQuestions')))
  await ui.fiber.dispose()
  assert.equal(await ui.result, undefined)
  assert.equal(ui.ready, false)
  assert.equal(ctx.get('userQuestions'), undefined)
  ctx.provide('neverProvided', {})
  await loader.resolve('kiokuko').fiber.await()
  assert.equal(ui.ready, false, 'late addon completion cannot resume a disposed frontend')
})

// A configured entry removed/replaced while waiting must be re-read; the old
// activation is not allowed to release a newer, still-loading addon.
await fixture(async ({ ctx, loader, hold, front }) => {
  const oldMount = hold(), newMount = hold()
  let generation = 0
  loader.import = () => {
    const gate = generation++ ? newMount : oldMount
    return { name: 'kiokuko-dsh', async apply() { await gate.promise } }
  }
  await loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  const ui = front()
  assert.ok(await settled(() => !!ctx.get('userQuestions')))
  loader.remove('kiokuko')
  const replacement = loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
  oldMount.resolve()
  await replacement
  assert.equal(ui.ready, false)
  newMount.resolve()
  assert.equal(await ui.result, undefined)
  assert.equal(ui.ready, true)
})

// Loader swallows an import rejection, but invalid module exports reject
// Entry.refresh itself. Neither outcome from an obsolete entry may fail its
// replacement or release it before its own activation finishes.
for (const outcome of ['rejected-import', 'invalid-export']) {
  await fixture(async ({ ctx, loader, hold, front }) => {
    const oldImport = hold(), newMount = hold()
    let generation = 0
    loader.import = () => generation++ ? {
      name: 'kiokuko-dsh', async apply() { await newMount.promise },
    } : oldImport.promise
    const oldLoading = loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
    const ui = front()
    assert.ok(await settled(() => !!ctx.get('userQuestions')))
    loader.remove('kiokuko')
    const replacement = loader.root.update([{ id: 'kiokuko', name: 'kiokuko-dsh' }])
    if (outcome === 'rejected-import') oldImport.reject(new Error('obsolete import failed'))
    else oldImport.resolve(null)
    await oldLoading
    await replacement
    assert.equal(ui.ready, false)
    newMount.resolve()
    assert.equal(await ui.result, undefined, outcome)
    assert.equal(ui.ready, true)
  })
}

console.log('dsh-cli addon startup OK (import, activation, pending services, failure, timeout, disable, disposal, replacement)')

await import('./verify-startup-registration-rollback.mjs')
