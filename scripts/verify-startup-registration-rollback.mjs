/** Real Cordis subscriptions and real Node timers; fault injection has no sleeps. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// An explicit source argument supports before/after regression checks in an
// isolated harness. Ordinary CI always imports this worktree's implementation.
const source = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('../src/dsh-adapter/startup-addons.ts', import.meta.url).href
const { awaitConfiguredKiokukoStartup } = await import(source)
const failures = []
for (const failAt of [1, 2, 3, 4, 5]) {
  const root = new Context()
  root.provide('loader', { entries: () => [{ id: 'fixture-addon', options: { name: 'kiokuko-dsh' },
    disabled: false, fiber: { state: 0 } }] })
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout
  const timers = [], live = new Set()
  let registrations = 0
  globalThis.setTimeout = (...args) => {
    const handle = setTimer(...args)
    timers.push(handle)
    return handle
  }
  globalThis.clearTimeout = handle => clearTimer(handle)
  const register = install => {
    const id = ++registrations
    if (id === failAt) throw new Error(`registration failed at ${id}`)
    const dispose = install()
    live.add(id)
    return () => { dispose(); live.delete(id) }
  }
  const ctx = {
    get: root.get.bind(root), fiber: root.fiber,
    on: (...args) => register(() => root.on(...args)),
    effect: (...args) => register(() => root.effect(...args)),
  }
  try {
    await assert.rejects(awaitConfiguredKiokukoStartup(ctx), new RegExp(`registration failed at ${failAt}`))
    // These are the actual Timeout instances, not a fake timer queue. Node is
    // the supported test runtime; _destroyed records clearTimeout's release.
    const activeTimers = timers.filter(handle => handle._destroyed !== true).length
    console.log(JSON.stringify({ failAt, registeredListeners: failAt - 1,
      remainingListeners: live.size, allocatedTimers: timers.length, activeTimers }))
    assert.equal(timers.length, 1, 'each startup gate owns one real timer')
    assert.equal(activeTimers, 0, 'registration failure releases the real timeout')
    assert.equal(live.size, 0, 'registration failure disposes every installed Cordis listener')
  } catch (error) {
    failures.push(error)
  } finally {
    globalThis.setTimeout = setTimer
    globalThis.clearTimeout = clearTimer
    // Test cleanup is separate from the observations above, so broken source
    // fails without leaving a real 30-second timer or listener behind.
    for (const timer of timers) clearTimer(timer)
    await root.fiber.dispose()
  }
}
if (failures.length) throw new AggregateError(failures, `${failures.length} startup registration rollback checks failed`)
console.log('PASS: all five registration failures release actual Cordis listeners and Node timers')
