/** Preferred efforts must be selected before preparation and survive binding changes. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createChannelBinding } from '../src/dsh-adapter/channel/binding.js'
import { createBindingEvents } from '../src/dsh-adapter/channel/binding-events.js'
import { createModelActions } from '../src/dsh-adapter/channel/model-actions.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'

type Selection = { provider: string; model: string; reasoningEffort?: string }
async function rig(preferred: string | undefined, available: string[], defaultEffort: string, saved?: string) {
  const ctx = new Context()
  ctx.provide('llm', { async resolveModelInfo() {
    return { reasoning: { efforts: available.map(id => ({ id, name: id })), defaultEffort } }
  } } as never)
  const makeAgent = (effort?: string) => {
    let selected: Selection = { provider: 'fixture', model: 'model', ...(effort ? { reasoningEffort: effort } : {}) }
    return { id: 'fixture', ctx: ctx.extend(), status: 'idle',
      session: { id: 'fixture', snapshotEvents: () => [] },
      model: { current: () => selected, select: (next: Selection) => { selected = { ...next } } },
    }
  }
  const owner = createChannelOwner()
  const binding = createChannelBinding(makeAgent(saved) as never, undefined, owner)
  const notices: string[] = []
  const state = { provider: 'fixture', model: 'model', reasoningEffort: undefined as string | undefined,
    effortLevels: undefined as string[] | undefined, agentPreset: undefined, working: false,
    agentBindingGeneration: 0, pending: [], cancelPending: false, activeToolCount: 0, emit() {}, emitStream() {},
  }
  const actions = createModelActions(ctx, state, {
    owner, binding, initialEffort: preferred, agent: () => binding.agent,
    notify: message => { notices.push(message) }, checkContextWarning() {},
  })
  const events = createBindingEvents(ctx, {
    owner, binding, state: state as never, inputConvergence: { interruptSeq: 0, cancelInFlight: false },
    modelActions: actions, modeActions: { refreshMode() {}, onSessionEvent() {} },
    projector: { renderEvent() {}, renderStreamFrame() {}, settleStreaming() {}, updateSpinnerMode() {} } as never,
    subagents: { onSessionEvent: () => false, onStart() {}, onEnd() {} }, agentView: { schedule() {} },
  })
  events.bind()
  await events.ready()
  return { actions, state, notices, selected: () => binding.agent.model.current(),
    async rebind() {
      binding.switchTo(makeAgent() as never, undefined, () => events.bind())
      await events.ready()
    },
    async close() { owner.dispose(); await ctx.fiber.dispose() },
  }
}

for (const entry of [
  { preferred: 'high', available: ['low', 'high', 'max'], expected: 'high', defaultEffort: 'max', notices: 0 },
  { preferred: 'max', available: ['off', 'low'], expected: 'low', defaultEffort: 'off', notices: 1 },
  { preferred: 'high', available: ['off', 'low', 'medium'], expected: 'medium', defaultEffort: 'off', notices: 1 },
  { preferred: 'low', available: ['high', 'max'], expected: undefined, defaultEffort: 'high', notices: 1 },
  { preferred: undefined, available: ['low', 'max'], expected: undefined, defaultEffort: 'max', notices: 0 },
]) {
  const f = await rig(entry.preferred, entry.available, entry.defaultEffort)
  try {
    for (let bind = 0; bind < 4; bind++) {
      if (bind > 0) await f.rebind()
      assert.equal(f.selected()?.reasoningEffort, entry.expected, 'each session records the validated preference')
      assert.equal(f.state.reasoningEffort, entry.expected ?? entry.defaultEffort, 'readout matches effective effort')
      assert.equal(f.notices.length, entry.notices, 'fallback notices are deduplicated across sessions')
    }
  } finally { await f.close() }
}

const saved = await rig(undefined, ['low', 'max'], 'max', 'low')
assert.equal(saved.selected()?.reasoningEffort, 'low', 'an unconfigured channel preserves the saved explicit choice')
assert.equal(saved.state.reasoningEffort, 'low')
await saved.close()

const changed = await rig('max', ['high', 'max'], 'high')
try {
  changed.actions.setDefaultEffort('low')
  for (let i = 0; i < 100 && changed.state.reasoningEffort !== 'high'; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(changed.selected()?.reasoningEffort, undefined, 'unsupported replacement clears the old explicit choice')
  assert.equal(changed.state.reasoningEffort, 'high')
} finally { await changed.close() }
console.log('effort preferences OK (20 binds, saved choice, default change, fallback and notice deduplication)')
