/**
 * Live Session facade: exclusive seq, inclusive source slice, lineage, and
 * the current-host fork/end-seed trap (child snapshot length cannot determine the cut).
 *
 * Run: node --import tsx/esm scripts/verify-live-session.ts
 * Real newest-upstream seam (requires the checked-out upstream source aliases):
 *   TSX_TSCONFIG_PATH="$DSH_HARNESS_SOURCE_ROOT/tsconfig.base.json" \
 *     node --import tsx/esm scripts/verify-live-session.ts --real-upstream
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  appendInterruptedTurnEnd,
  liveSessionCreateOptions,
  liveSessionOffset,
  liveSessionPhysicalSeedLength,
  liveSessionSeedMetadata,
  sliceLiveSessionSeed,
  snapshotLiveSessionEvents,
} from '../src/dsh-adapter/compat/liveSession.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const ev = (seq: number, type: string) => ({ seq, time: seq, type, data: { turn: 0 } })
type OptionsView = {
  readonly meta: Record<string, unknown>
  readonly inheritedEventCount?: unknown
}

interface UpstreamSessionView {
  readonly header: Record<string, unknown>
  readonly inheritedEventCount: number
  readonly seq: number
  append(type: string, data: Record<string, unknown>): unknown
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly {
    readonly type: string
    readonly seq: number
  }[]
  ownEvents(): readonly { readonly type: string; readonly seq: number }[]
}

interface UpstreamSessionModule {
  readonly SESSION_FORMAT_VERSION: number
  SessionId(value: string): unknown
  SessionLogOffset(value: number): number
  readonly Session: {
    create(
      id: unknown,
      seed?: readonly unknown[],
      header?: Record<string, unknown>,
      inheritedEventCount?: number,
    ): UpstreamSessionView
  }
}

const current = {
  seq: 3,
  header: { isSeeded: true, parentSession: 'parent' },
  inheritedEventCount: 3,
  snapshotEvents() {
    return this._log
  },
  _log: [ev(0, 'turn/start'), ev(1, 'user/message'), ev(2, 'turn/end')],
}

function throwsMatching(run: () => unknown, pattern: RegExp): boolean {
  try {
    run()
    return false
  } catch (error) {
    return error instanceof Error && pattern.test(error.message)
  }
}

check('current snapshot uses snapshotEvents', snapshotLiveSessionEvents(current).length === 3)
check('empty seq is exclusive 0', liveSessionOffset({ seq: 0, snapshotEvents: () => [] }) === 0)
check('seq is exclusive offset not last event seq', liveSessionOffset(current) === 3 && current.snapshotEvents().at(-1)!.seq === 2)
check(
  'invalid snapshot result fails loudly',
  throwsMatching(() => snapshotLiveSessionEvents({ snapshotEvents: () => ({}) }), /did not return an array/),
)
check(
  'missing live log API fails loudly',
  throwsMatching(() => snapshotLiveSessionEvents({ header: {} }), /snapshotEvents\(\) is unavailable/),
)

const whole = sliceLiveSessionSeed(current)
check('omitted boundary copies whole source log', whole.length === 3 && whole[2]!.seq === 2)
const cut = sliceLiveSessionSeed(current, 2)
check('inclusive boundary keeps seq <= boundary', cut.length === 3 && cut[2]!.seq === 2)
let pastEnd = false
try {
  sliceLiveSessionSeed(current, 3)
} catch (error) {
  pastEnd = error instanceof Error && error.message.includes('does not exist')
}
check('boundary at exclusive seq is rejected', pastEnd)
check(
  'snapshot length must match exclusive seq',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 4, snapshotEvents: () => current._log }),
    /snapshot length 3 does not match exclusive seq 4/,
  ),
)
check(
  'boundary must name the contiguous event at that index',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 3, snapshotEvents: () => [ev(0, 'turn/start'), ev(7, 'user/message'), ev(2, 'turn/end')] }, 1),
    /does not match a contiguous event seq/,
  ),
)

const childSnapshot = [...current._log, ev(3, 'session/end-seed')]
check(
  'child snapshot with end-seed is longer than inherited cut',
  childSnapshot.length !== current.inheritedEventCount
    && childSnapshot.length === 4
    && whole.length === current.inheritedEventCount,
)

let openTurn = false
try {
  sliceLiveSessionSeed({ seq: 2, snapshotEvents: () => [ev(0, 'turn/start'), ev(1, 'user/message')] }, 1)
} catch (error) {
  openTurn = error instanceof Error && error.message.includes('open turn')
}
check('open-turn slice is rejected', openTurn)
check(
  'omitted-boundary whole open turn is rejected',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 2, snapshotEvents: () => [ev(0, 'turn/start'), ev(1, 'user/message')] }),
    /open turn/,
  ),
)

const inherited = liveSessionSeedMetadata(3)
check(
  'current inherited uses isSeeded + inheritedEventCount',
  inherited.meta.isSeeded === true && inherited.inheritedEventCount === 3,
)

check('physical seedLength from live current seeded session', liveSessionPhysicalSeedLength(current) === 3)
check('physical seedLength omitted for unseeded live session', liveSessionPhysicalSeedLength({ header: { isSeeded: false } }) === undefined)
check(
  'seeded live session never invents a missing cut',
  liveSessionPhysicalSeedLength({ header: { isSeeded: true } }) === undefined,
)

const currentOptions = liveSessionCreateOptions({
  sessionId: 'child-current' as never,
  seed: current._log as never,
  inheritedCount: 3,
  cwd: '/tmp',
  parentSession: 'parent' as never,
  agentOptions: {},
}) as unknown as OptionsView
check(
  'current create options keep exact top-level inherited cut',
  currentOptions.meta.isSeeded === true
    && currentOptions.meta.seedLength === undefined
    && currentOptions.inheritedEventCount === 3,
)

const independentOptions = liveSessionCreateOptions({
  sessionId: 'independent-current' as never,
  seed: current._log as never,
  inheritedCount: 3,
  cwd: '/tmp',
  agentOptions: {},
}) as unknown as OptionsView
check(
  'current independent root keeps seed ownership without parent lineage',
  independentOptions.meta.isSeeded === true
    && independentOptions.inheritedEventCount === 3
    && independentOptions.meta.parentSession === undefined,
)

const kept = [ev(0, 'turn/start'), ev(1, 'user/message')]
const inheritedBeforeCloser = kept.length
appendInterruptedTurnEnd(kept as never, 0)
const keptOptions = liveSessionCreateOptions({
  sessionId: 'child-closed' as never,
  seed: kept as never,
  inheritedCount: inheritedBeforeCloser,
  cwd: '/tmp',
  parentSession: 'parent' as never,
  agentOptions: {},
}) as unknown as OptionsView
check(
  'synthetic closer is child-owned, not part of inherited cut',
  kept.length === inheritedBeforeCloser + 1
    && kept.at(-1)?.type === 'turn/end'
    && keptOptions.inheritedEventCount === inheritedBeforeCloser,
)

async function verifyRealUpstreamSession(): Promise<void> {
  const sourceRoot = process.env.DSH_HARNESS_SOURCE_ROOT
  if (sourceRoot === undefined || sourceRoot.length === 0) {
    throw new Error('--real-upstream requires DSH_HARNESS_SOURCE_ROOT')
  }
  if (process.env.TSX_TSCONFIG_PATH === undefined) {
    throw new Error('--real-upstream requires TSX_TSCONFIG_PATH for upstream workspace source aliases')
  }

  const sessionEntry = pathToFileURL(resolve(sourceRoot, 'packages/core/session/src/index.ts')).href
  const upstream = await import(sessionEntry) as unknown as UpstreamSessionModule

  const parentId = upstream.SessionId('dsh-cli-real-upstream-parent')
  const source = upstream.Session.create(parentId)
  source.append('turn/start', { turn: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const seed = sliceLiveSessionSeed(source)
  check(
    'real upstream source slice keeps one closed turn',
    seed.length === 2 && seed[0]?.type === 'turn/start' && seed[1]?.type === 'turn/end',
  )

  const childId = upstream.SessionId('dsh-cli-real-upstream-child')
  const request = liveSessionCreateOptions({
    sessionId: childId as never,
    seed,
    inheritedCount: seed.length,
    cwd: process.cwd(),
    parentSession: parentId as never,
    agentOptions: {},
  }) as unknown as {
    readonly sessionId: unknown
    readonly seed: readonly unknown[]
    readonly meta: Record<string, unknown>
    readonly inheritedEventCount?: unknown
  }

  check(
    'real upstream create options use isSeeded and exact inherited count',
    request.meta['isSeeded'] === true
      && request.meta['seedLength'] === undefined
      && request.inheritedEventCount === 2,
  )

  const header = {
    version: upstream.SESSION_FORMAT_VERSION,
    id: request.sessionId,
    createdAt: Date.now(),
    cwd: request.meta['cwd'],
    parentSession: request.meta['parentSession'],
    isSeeded: request.meta['isSeeded'],
  }
  const child = upstream.Session.create(
    request.sessionId,
    request.seed,
    header,
    upstream.SessionLogOffset(Number(request.inheritedEventCount)),
  )
  const childSnapshot = snapshotLiveSessionEvents(child)
  const childOwnEvents = child.ownEvents()

  check(
    'real upstream Session accepts adapter create options',
    child.header['isSeeded'] === true
      && child.inheritedEventCount === 2
      && child.seq === 3,
  )
  check(
    'real upstream Session keeps end-seed child-owned',
    childSnapshot.at(-1)?.type === 'session/end-seed'
      && childOwnEvents.length === 1
      && childOwnEvents[0]?.type === 'session/end-seed',
  )
  check(
    'real upstream physical seed cut remains inherited prefix length',
    liveSessionPhysicalSeedLength(child) === 2,
  )
}

if (process.argv.includes('--real-upstream')) await verifyRealUpstreamSession()

process.exit(failed === 0 ? 0 : 1)
