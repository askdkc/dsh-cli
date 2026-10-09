/**
 * Component and channel regression for settings `dsh-cli.whale`.
 * Imports source through tsx, so it never relies on a pre-existing lib/ tree.
 *
 * Run: node --import tsx/esm scripts/verify-whale-toggle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_CLI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render, ThemeProvider },
  { LogoHeader },
  { bigTextWidth, renderBigText },
  { resolveSplashLayout },
  { createChannel },
  { settle },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/components/bigfont.js'),
  import('../src/components/splashLayout.js'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
])

let checks = 0
function check(name, test) {
  try {
    test()
    checks += 1
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

function makeChannel(options = {}) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] , snapshotEvents() { return this.events }},
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    ...options,
  })
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class FakeOutput extends Writable {
  constructor(columns) {
    super()
    this.columns = columns
  }
  rows = 30
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

const stripAnsi = text => text
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
const WHALE_OUTLINE = '\x1b[38;2;20;38;96m'

// `ready`（可选）：call site 断言里比默认文字条件更强的正向条件必须并入
// 等待谓词（#561 弱条件分叉），否则 settle 等到文字就返回、断言到旧帧。
async function renderHeader({ columns, whale, ready, expectText = true }) {
  const stdout = new FakeOutput(columns)
  const stderr = new FakeOutput(columns)
  const props = { model: 'whale-model-probe', cwd: '/whale/cwd' }
  if (whale !== undefined) props.whale = whale
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(LogoHeader, props),
    ),
    {
      stdout,
      stderr,
      stdin: new FakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await settle(() => {
    const raw = stdout.writes.join('')
    const plain = stripAnsi(raw)
    return (expectText ? plain.includes('dsh-CLI') && plain.includes('whale-model-probe') : raw.includes(WHALE_OUTLINE))
      && (ready === undefined || ready(raw))
  })
  const raw = stdout.writes.join('')
  await instance.unmount()
  return { raw, plain: stripAnsi(raw) }
}

// Channel defaults and live setter semantics.
check('channel defaults whale to on', () => assert.equal(makeChannel().whale, true))
check('channel preserves an explicit whale=false', () => assert.equal(makeChannel({ whale: false }).whale, false))
const channel = makeChannel()
let notified = 0
channel.subscribe(() => { notified += 1 })
channel.setWhale(false)
check('setWhale(false) updates and notifies once', () => {
  assert.equal(channel.whale, false)
  assert.equal(notified, 1)
})
channel.setWhale(false)
check('repeated setWhale(false) is a no-op', () => assert.equal(notified, 1))
channel.setWhale(true)
check('setWhale(true) restores the default view', () => {
  assert.equal(channel.whale, true)
  assert.equal(notified, 2)
})

// Real LogoHeader -> LogoV2 rendering: default, explicit opt-out, and narrow fallback.
const wideDefault = await renderHeader({ columns: 100, ready: raw => raw.includes(WHALE_OUTLINE) })
check('wide LogoHeader shows whale by default', () => {
  assert.ok(wideDefault.raw.includes(WHALE_OUTLINE), 'whale palette marker missing')
  assert.ok(wideDefault.plain.includes('dsh-CLI'), 'text logo missing')
})

const wideDisabled = await renderHeader({ columns: 100, whale: false })
check('LogoHeader forwards whale=false while preserving the text logo', () => {
  assert.ok(!wideDisabled.raw.includes(WHALE_OUTLINE), 'whale palette marker still rendered')
  assert.ok(wideDisabled.plain.includes('dsh-CLI'), 'text logo missing')
  assert.ok(wideDisabled.plain.includes('whale-model-probe'), 'header details missing')
})

const narrowDefault = await renderHeader({ columns: 63 })
check('text-only tier hides whale and preserves the title', () => {
  assert.ok(!narrowDefault.raw.includes(WHALE_OUTLINE), 'whale should hide when both columns do not fit')
  assert.ok(narrowDefault.plain.includes('dsh-CLI'), 'text logo missing')
  assert.ok(narrowDefault.plain.includes('whale-model-probe'), 'header details missing')
})

const titleWidth = bigTextWidth('DEEPSEEK')
const paintedTitleWidth = stripAnsi(renderBigText('DEEPSEEK', 0,
  { r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }, { r: 7, g: 8, b: 9 })[0]).length
check('layout measures the exact painted title width', () => assert.equal(titleWidth, paintedTitleWidth))
for (const [columns, whale, expected] of [
  [90, true, 'whale+title'],
  [89, true, 'title'],
  [48, true, 'title'],
  [47, true, 'whale'],
  [40, true, 'whale'],
  [39, true, 'plain'],
  [47, false, 'plain'],
]) {
  const layout = resolveSplashLayout(columns, { whale })
  const actual = layout.showWhale && layout.showBigTitle ? 'whale+title'
    : layout.showBigTitle ? 'title' : layout.showWhale ? 'whale' : 'plain'
  check(`${columns} columns with whale=${whale} render ${expected}`, () => assert.equal(actual, expected))
}

const whaleOnly = await renderHeader({ columns: 44, expectText: false })
check('whale-only tier omits the clipped text column', () => {
  assert.ok(whaleOnly.raw.includes(WHALE_OUTLINE), 'whale should remain visible')
  assert.ok(!whaleOnly.plain.includes('dsh-CLI'), 'clipped wordmark should not render')
})

const plainTitle = await renderHeader({ columns: 39 })
check('small terminal uses a plain title', () => {
  assert.ok(!plainTitle.raw.includes(WHALE_OUTLINE), 'whale should not render')
  assert.ok(plainTitle.plain.includes('DeepSeekHarness'), 'plain title missing')
})

console.log(`\nAll ${checks} whale-toggle checks passed.`)
