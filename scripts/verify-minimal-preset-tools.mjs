/** Regression checks for the official two-tool Minimal preset. Run against
 * compiled output. */

import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import {
  composePreset,
  registerPresetQuestionToolAdmission,
  resolvePersistedPreset,
  runningPresetOf,
} from '../lib/types/dsh-adapter/presets.js'
import { settled } from './lib/term-test.mjs'
import { setLang } from '../lib/types/i18n.js'

const { Context } = await import('@deepseek-ai/cordis')
const { default: ToolRuntime, defineTool } = await import('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const bash = { name: 'bash' }
const editor = { name: 'str_replace_editor' }
const questionRuntime = new Context()
try {
  await questionRuntime.plugin(SystemPrompt)
  await questionRuntime.plugin(ToolRuntime)
  questionRuntime.tools.register(defineTool({
    name: 'ask_user_question', description: 'question fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'answer' },
  }))
  let scope
  const agent = { id: 'question-admission', get ctx() { return scope.ctx },
    session: { header: { agentPreset: 'minimal' }, events: [], snapshotEvents() { return this.events } },
  }
  scope = createScope(questionRuntime, agent)
  questionRuntime.provide('agents', { list: () => [agent] })
  registerPresetQuestionToolAdmission(questionRuntime)
  questionRuntime.emit('agent/created', { agent })
  for (const preset of ['minimal', 'standard', 'ptc', 'cordis', 'liangshen', 'minimal']) {
    const event = { type: 'agent-preset/selected', data: { agentPreset: preset } }
    agent.session.events.push(event)
    questionRuntime.emit('session/event', agent.session, event)
    if (typeof questionRuntime.tools.resolve === 'function') {
      const admitted = await questionRuntime.tools.resolve({ agent,
        modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal })
      try {
        const schemas = questionRuntime.tools.schemas(agent, admitted)
        assert.equal(schemas.some(tool => tool.name === 'ask_user_question'), preset !== 'minimal')
        assert.equal(questionRuntime.tools.executable('ask_user_question', agent, admitted) !== undefined, preset !== 'minimal',
          'the same admission controls schemas and dispatch, including preset changes')
      } finally { admitted.dispose() }
    } else {
      const schemas = questionRuntime.tools.schemas(agent)
      assert.equal(schemas.some(tool => tool.name === 'ask_user_question'), preset !== 'minimal')
      assert.equal(questionRuntime.tools.get('ask_user_question', agent) !== undefined, preset !== 'minimal',
        'the legacy restriction controls schemas and executable lookup, including preset changes')
    }
  }
} finally { await questionRuntime.fiber.dispose() }

const headerSession = {
  header: { agentPreset: 'ptc' },
  events: [],
  snapshotEvents() { return this.events },
}
const eventSession = {
  header: { agentPreset: 'standard' },
  events: [{ type: 'agent-preset/selected', data: { agentPreset: 'ptc' } }],
  snapshotEvents() { return this.events },
}
const malformedLatestEventSession = {
  header: { agentPreset: 'standard' },
  events: [
    { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } },
    { type: 'agent-preset/selected', data: null },
  ],
  snapshotEvents() { return this.events },
}
assert.equal(runningPresetOf(headerSession), 'ptc')
assert.equal(runningPresetOf(eventSession), 'ptc')
assert.equal(runningPresetOf(malformedLatestEventSession), 'ptc')
assert.equal(headerSession.header.agentPreset, 'ptc')
assert.equal(eventSession.events[0].data.agentPreset, 'ptc')

function presetContext(available, broken = new Set()) {
  const attempts = []
  const service = {
    defaultId: 'standard',
    async list() {
      return [...available].map(id => ({ id, trust: 'system' }))
    },
    async resolve(id) {
      attempts.push(id)
      if (broken.has(id)) throw new Error(`broken ${id} preset`)
      if (!available.has(id)) throw new Error(`missing ${id}`)
      return { id, trust: 'system' }
    },
    async mount() {},
    async recompose() { throw new Error('not used') },
  }
  return {
    attempts,
    ctx: {
      get(name) {
        if (name !== 'agentPresets') return undefined
        return service
      },
      logger: { warn() {} },
    },
  }
}

const currentRoster = presetContext(new Set(['standard', 'ptc']))
const currentComposition = await composePreset(currentRoster.ctx, 'ptc')
assert.deepEqual(currentRoster.attempts, ['ptc'])
assert.equal(currentComposition.agentPreset, 'ptc')
const missingOldName = presetContext(new Set(['standard', 'ptc']))
assert.deepEqual(await composePreset(missingOldName.ctx, 'code'), {})
assert.deepEqual(missingOldName.attempts, ['code'], 'unsupported old names never alias')
const brokenExact = presetContext(new Set(['standard', 'ptc']), new Set(['ptc']))
assert.deepEqual(await composePreset(brokenExact.ctx, 'ptc'), {})
assert.deepEqual(brokenExact.attempts, ['ptc'])
let closed = false
const persistedPreset = await resolvePersistedPreset({
  get() {
    return { async open() { return {
      header: headerSession.header,
      async read() { return { events: headerSession.events } },
      async close() { closed = true },
    } } }
  },
}, 'current-session')
assert.equal(persistedPreset, 'ptc')
assert.equal(closed, true)

let directResolveId
const directChannel = createChannel({
  on() { return () => {} },
  get(name) {
    if (name !== 'agentPresets') return undefined
    return {
      defaultId: 'standard',
      async list() { return [] },
      async resolve(id) {
        directResolveId = id
        if (id !== 'ptc') throw new Error(`missing ${id}`)
        return { id, trust: 'system' }
      },
      async mount() {},
      async recompose() { throw new Error('not used') },
    }
  },
  logger: { warn() {} },
}, {
  id: 'preset-current-agent',
  status: 'idle',
  options: { provider: 'deepseek', model: 'deepseek-chat' },
  session: {
    id: 'preset-current-session',
    seq: 1,
    events: [{
      type: 'agent-preset/selected',
      seq: 1,
      time: 1,
      data: { agentPreset: 'ptc' },
    }],
   snapshotEvents() { return this.events }},
  ctx: { on() { return () => {} } },
  followup() {},
  steer() {},
}, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
  agentPreset: 'ptc',
})
assert.equal(directChannel.agentPreset, 'ptc')
assert.equal(directChannel.rows.some(row => row.text.includes('ptc')), true)
assert.equal(directChannel.rows.some(row => row.text.includes('code')), false)
assert.equal(await directChannel.switchPreset('ptc'), true)
assert.equal(directResolveId, 'ptc')

// Display localization: the roster id `ptc` must resolve the en
// dictionary surface keyed under the current `ptc` id (preset-name-ptc /
// preset-desc-ptc), never the Chinese roster copy — same bug as issue #8.
setLang('en')
const displayChannel = createChannel({
  on() { return () => {} },
  get(name) {
    if (name !== 'agentPresets') return undefined
    return {
      defaultId: 'standard',
      async list() {
        return [
          { id: 'standard', trust: 'system', name: '标准模式', description: '标准描述' },
          { id: 'ptc', trust: 'system', name: 'PTC 模式', description: 'PTC 描述' },
          { id: 'minimal', trust: 'system', name: '极简模式', description: '极简描述' },
        ]
      },
      async resolve() { throw new Error('not used') },
      async mount() {},
      async recompose() { throw new Error('not used') },
    }
  },
  logger: { warn() {} },
}, {
  id: 'preset-display-agent',
  status: 'idle',
  options: { provider: 'deepseek', model: 'deepseek-chat' },
  session: { id: 'preset-display-session', seq: 1, events: [] , snapshotEvents() { return this.events }},
  ctx: { on() { return () => {} } },
  followup() {},
  steer() {},
}, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
  agentPreset: 'ptc',
})
const displayList = await displayChannel.listPresets()
const ptcOption = displayList.find(preset => preset.id === 'ptc')
assert.equal(ptcOption.name, 'PTC')
assert.equal(ptcOption.description, 'Everything standard mode offers, with tools exposed through the Code Mode SDK so the model composes multi-step operations in one TypeScript program.')
assert.equal(displayList.find(preset => preset.id === 'standard').name, 'Standard')
assert.equal(displayList.find(preset => preset.id === 'minimal').name, 'Minimal')
setLang('zh')

const bundledSkills = [{
  name: 'audit',
  description: 'Audit code',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled',
}, {
  name: 'manual-only',
  description: 'Manual only',
  invocation: { modelInvocable: false, userInvocable: true },
  source: 'bundled',
}]

async function loadedContextWith(tools, complete = true) {
  let unscopedReads = 0
  const skills = {
    async list() {
      unscopedReads += 1
      return bundledSkills
    },
    async snapshot(options) {
      if (options?.scope !== agent || options.cwd !== '/tmp') {
        unscopedReads += 1
        return { skills: [], complete: true }
      }
      return { skills: bundledSkills, complete }
    },
  }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'systemPrompt') {
        return { assemble: async () => ({ sections: [], contexts: [], tools, variables: {} }) }
      }
      if (name === 'skills') return skills
      return undefined
    },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: 's1', seq: 0, events: [] , snapshotEvents() { return this.events }},
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false,
  })
  assert.equal(await settled(() => channel.loadedContext !== undefined), true)
  return { context: channel.loadedContext, unscopedReads }
}

const minimalContext = await loadedContextWith([bash, editor])
assert.deepEqual(minimalContext.context.skills, [])
assert.equal(minimalContext.unscopedReads, 0)

const standardContext = await loadedContextWith([bash, editor, { name: 'skill' }])
assert.deepEqual(standardContext.context.skills, [{ name: 'audit', description: 'Audit code' }])
assert.equal(standardContext.unscopedReads, 0)

const incompleteContext = await loadedContextWith([bash, editor, { name: 'skill' }], false)
assert.deepEqual(incompleteContext.context.skills, [])
assert.deepEqual(incompleteContext.context.tools.map(tool => tool.name), ['bash', 'str_replace_editor', 'skill'])
assert.equal(incompleteContext.unscopedReads, 0)

console.log('minimal preset tool filtering verified')
