/**
 * CC 2.1.312 (#22) — "Changed prompt and agent hooks to run at most 24 at a
 * time per session, sub-agents included, plus at most 12 that have waited
 * longer than their event's timeout; a `timeout` under 1 second now counts as
 * 1 second."
 *
 * Official v312 binary evidence (linux-x64 ELF, all offsets READ-ONLY
 * extracted from /tmp/cc-diff-312/v312/package/claude):
 *
 *   @251761428 constants + session state (verbatim):
 *     import{AsyncLocalStorage as cEr}from"async_hooks";
 *     var Wet=12,kvn=24,fEr=12,pEr=1,bvn=1e4;
 *     class Rvn{slots=new byt;holder=new cEr}
 *     var Mvn=new W(()=>new Rvn),Uet="model hooks",mEr="overdue model hooks";
 *     function zB(e){return e.type==="prompt"||e.type==="agent"}
 *     function BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}
 *
 *   @250558442 `byt`  — named-pool counting semaphore (acquire/wouldWait/
 *                      occupy + FIFO grant pump with abort-linked waiters)
 *   @250558987 `P0r`  — bounded seat wait: wait up to waitLimitMs, then
 *                      report seated:false so the caller falls back to the
 *                      overdue pool
 *   @251761660 `Ovn`  — two-tier merge (session cap 24 + stagger cap 12)
 *   `wvn`/`vvn`      — seating wrapper (ALS reentrancy guard, fast-path
 *                      occupy, bounded wait → overdue fallback) + held step
 *                      with keepalive release timer (limitMs + bvn grace)
 *   @251922088 call site — `w===void 0||It?lht(yr):Ovn(yr,…,{slots:
 *                      Mvn.of(w.session.host),signal:y,limitMs:S})`
 *
 * Test-harness note: the gated fake generators below await their gate BEFORE
 * the first yield, mirroring the real prompt/agent per-hook generators whose
 * first yield is the hook result (progress messages are yielded by a separate
 * loop before the merge — hooks.ts "Yield progress messages for each hook
 * before execution"). The official seat (vvn) is released when the first
 * step settles, so a pre-gate yield would release the seat instantly and the
 * cap would be unobservable.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { all, toArray } from '../../generators.js'
import {
  HOOK_OVERDUE_CONCURRENCY_CAP,
  HOOK_SESSION_CONCURRENCY_CAP,
  HOOK_STAGGER_CONCURRENCY_CAP,
  HOOK_TIMEOUT_FLOOR_SECONDS,
  HookSlotSemaphore,
  MAX_HOOK_TIMEOUT_MS,
  OVERDUE_HOOKS_POOL,
  SESSION_HOOKS_POOL,
  SLOT_KEEPALIVE_GRACE_MS,
  getHookSessionSlots,
  hookTimeoutMs,
  isPromptOrAgentHook,
  mergeHookGeneratorsWithSessionSlots,
  resetHookSessionSlotsForTest,
  seatKeepaliveDelayMs,
  wrapHookGeneratorWithSessionSeat,
} from '../hookSessionSlots312.js'

// ---------------------------------------------------------------------------
// Harness: live tracker + gates + seat-holding fake hook generators
// ---------------------------------------------------------------------------

type Tracker = {
  live: number
  maxLive: number
  starts: string[]
  enter(tag: string): void
  exit(tag: string): void
}

function createTracker(): Tracker {
  let live = 0
  let maxLive = 0
  const starts: string[] = []
  return {
    get live() {
      return live
    },
    get maxLive() {
      return maxLive
    },
    starts,
    enter(tag: string) {
      live++
      if (live > maxLive) {
        maxLive = live
      }
      starts.push(tag)
    },
    exit(_tag: string) {
      live--
    },
  }
}

type Gate = { promise: Promise<void>; open: () => void }

function createGate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

function createGates(count: number): Gate[] {
  return Array.from({ length: count }, () => createGate())
}

/**
 * Fake hook generator that holds its seat: enter → await gate → exit → yields.
 * The first next() stays pending until the gate opens, so the session seat
 * (released when the first step settles, official vvn) is held for the whole
 * gated window — exactly like a real prompt/agent hook execution. exit() is
 * recorded inside the first step (the "execution" window the seat covers) so
 * tracker.live mirrors seat occupancy without drain-ordering artifacts.
 */
function seatedHookGenerator(
  tracker: Tracker,
  tag: string,
  gate: Promise<void>,
): AsyncGenerator<string, void> {
  return (async function* () {
    tracker.enter(tag)
    await gate
    tracker.exit(tag)
    yield `${tag}:start`
    yield `${tag}:end`
  })()
}

/** Immediately-completing generator (no gate) for ordering checks. */
function immediateGen(tag: string): AsyncGenerator<string, void> {
  return (async function* () {
    yield tag
  })()
}

function consume(
  gen: AsyncGenerator<string, void>,
): { collected: string[]; done: Promise<void> } {
  const collected: string[] = []
  const done = (async () => {
    for await (const value of gen) {
      collected.push(value)
    }
  })()
  return { collected, done }
}

/** Macrotask flush — drains stagger chains, seat promises and merge races. */
const flush = (): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, 10))

const sleep = (ms: number): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

const A_TAGS = Array.from({ length: 12 }, (_, i) => `a${i}`)
const B_TAGS = Array.from({ length: 12 }, (_, i) => `b${i}`)

/** Start a merge of N capped (prompt-like) gated generators. */
function startCappedMerge(
  tags: string[],
  gates: Gate[],
  tracker: Tracker,
  ctxLimitMs: number,
  perHookLimitMs = 60_000,
): { collected: string[]; done: Promise<void> } {
  const merged = mergeHookGeneratorsWithSessionSlots(
    tags.map((tag, i) => seatedHookGenerator(tracker, tag, gates[i]!.promise)),
    () => perHookLimitMs,
    { session: getHookSessionSlots(), limitMs: ctxLimitMs },
  )
  return consume(merged)
}

/** Saturate the session pool with two concurrent 12-hook event merges. */
function saturateSessionPool(
  tracker: Tracker,
): {
  gatesA: Gate[]
  gatesB: Gate[]
  merges: Array<{ collected: string[]; done: Promise<void> }>
} {
  const gatesA = createGates(A_TAGS.length)
  const gatesB = createGates(B_TAGS.length)
  const merges = [
    startCappedMerge(A_TAGS, gatesA, tracker, 60_000),
    startCappedMerge(B_TAGS, gatesB, tracker, 60_000),
  ]
  return { gatesA, gatesB, merges }
}

const openAll = (gates: Gate[]): void => {
  for (const gate of gates) {
    gate.open()
  }
}

afterEach(() => {
  resetHookSessionSlotsForTest()
})

// ---------------------------------------------------------------------------
// Constants + BM timeout floor
// ---------------------------------------------------------------------------

describe('CC 2.1.312 #22: constants are the official verbatim values', () => {
  test('session cap 24 (kvn), overdue cap 12 (fEr), stagger cap 12 (Wet), floor 1s (pEr), grace 10s (bvn), Bd, pool names (Uet/mEr)', () => {
    expect(HOOK_SESSION_CONCURRENCY_CAP).toBe(24)
    expect(HOOK_OVERDUE_CONCURRENCY_CAP).toBe(12)
    expect(HOOK_STAGGER_CONCURRENCY_CAP).toBe(12)
    expect(HOOK_TIMEOUT_FLOOR_SECONDS).toBe(1)
    expect(SLOT_KEEPALIVE_GRACE_MS).toBe(10_000)
    expect(MAX_HOOK_TIMEOUT_MS).toBe(2_147_483_647)
    expect(SESSION_HOOKS_POOL).toBe('model hooks')
    expect(OVERDUE_HOOKS_POOL).toBe('overdue model hooks')
  })

  test('hookTimeoutMs floors a sub-1s timeout to 1s (official BM: Math.max(e.timeout,pEr)*1000)', () => {
    expect(hookTimeoutMs({ timeout: 0.5 }, 600_000)).toBe(1_000)
    expect(hookTimeoutMs({ timeout: 0.25 }, 600_000)).toBe(1_000)
    expect(hookTimeoutMs({ timeout: 1 }, 600_000)).toBe(1_000)
    expect(hookTimeoutMs({ timeout: 60 }, 600_000)).toBe(60_000)
  })

  test('hookTimeoutMs keeps the official falsy-timeout branch: 0/undefined → event default', () => {
    expect(hookTimeoutMs({ timeout: 0 }, 600_000)).toBe(600_000)
    expect(hookTimeoutMs({}, 30_000)).toBe(30_000)
  })

  test('isPromptOrAgentHook re-export matches official zB predicate', () => {
    expect(isPromptOrAgentHook({ type: 'prompt' })).toBe(true)
    expect(isPromptOrAgentHook({ type: 'agent' })).toBe(true)
    expect(isPromptOrAgentHook({ type: 'command' })).toBe(false)
    expect(isPromptOrAgentHook({ type: 'callback' })).toBe(false)
    expect(isPromptOrAgentHook({ type: 'http' })).toBe(false)
  })

  test('seatKeepaliveDelayMs pins the official vvn timer formula Math.min(s,Bd-bvn)+bvn', () => {
    expect(seatKeepaliveDelayMs(30_000)).toBe(40_000)
    expect(seatKeepaliveDelayMs(600_000)).toBe(610_000)
    expect(seatKeepaliveDelayMs(500)).toBe(10_500)
    expect(seatKeepaliveDelayMs(MAX_HOOK_TIMEOUT_MS)).toBe(MAX_HOOK_TIMEOUT_MS)
  })
})

// ---------------------------------------------------------------------------
// HookSlotSemaphore (official byt @250558442)
// ---------------------------------------------------------------------------

describe('CC 2.1.312 #22: HookSlotSemaphore (official byt)', () => {
  test('grants below the limit immediately, queues FIFO at the limit, release pumps the oldest waiter', async () => {
    const semaphore = new HookSlotSemaphore()
    const controller = new AbortController()

    const release1 = await semaphore.acquire('pool', 2, controller.signal)
    const release2 = await semaphore.acquire('pool', 2, controller.signal)
    expect(typeof release1).toBe('function')
    expect(typeof release2).toBe('function')
    expect(semaphore.wouldWait('pool', 2)).toBe(true)

    let queued: (() => void) | undefined
    let settled = false
    const pending = semaphore.acquire('pool', 2, controller.signal).then(release => {
      queued = release
      settled = true
      return release
    })
    await flush()
    expect(settled).toBe(false) // third waiter queued, not granted

    release1!()
    await pending
    expect(settled).toBe(true)
    expect(typeof queued).toBe('function')
    release2!()
    queued!()
    expect(semaphore.wouldWait('pool', 2)).toBe(false)
  })

  test('a queued acquire resolves undefined when its signal aborts, and an aborted signal never queues', async () => {
    const semaphore = new HookSlotSemaphore()
    const holder = new AbortController()
    const release = await semaphore.acquire('pool', 1, holder.signal)

    const waiter = new AbortController()
    const queued = semaphore.acquire('pool', 1, waiter.signal)
    await flush()
    waiter.abort()
    expect(await queued).toBeUndefined()
    release!() // free the held seat; the aborted waiter must be gone from the
    // queue (official `w` splices it out), so wouldWait is false again.
    expect(semaphore.wouldWait('pool', 1)).toBe(false)

    const preAborted = new AbortController()
    preAborted.abort()
    expect(
      await semaphore.acquire('pool', 1, preAborted.signal),
    ).toBeUndefined() // official: if(r.aborted)return Promise.resolve(void 0)
  })

  test('occupy takes a seat without queueing and wouldWait reports saturation', async () => {
    const semaphore = new HookSlotSemaphore()
    expect(semaphore.wouldWait('pool', 1)).toBe(false)
    const release = semaphore.occupy('pool')
    expect(semaphore.wouldWait('pool', 1)).toBe(true)
    expect(semaphore.activeCount('pool')).toBe(1)
    release()
    expect(semaphore.activeCount('pool')).toBe(0)
    expect(semaphore.wouldWait('pool', 1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mergeHookGeneratorsWithSessionSlots (official Ovn/wvn/vvn)
// ---------------------------------------------------------------------------

describe('CC 2.1.312 #22: session cap 24 shared across concurrent event merges', () => {
  test('24 prompt hooks run session-wide; the 25th waits until a seat frees (session sharing, sub-agent total not per-event)', async () => {
    const tracker = createTracker()
    const { gatesA, gatesB, merges } = saturateSessionPool(tracker)
    await flush()
    expect(tracker.live).toBe(24) // both events fully seated
    expect(getHookSessionSlots().slots.activeCount(SESSION_HOOKS_POOL)).toBe(24)

    // A third concurrent event (sub-agent-like) with one prompt hook: the
    // 25th seat-seeker must NOT start while the session pool is saturated.
    const gatesC = createGates(1)
    const mergeC = startCappedMerge(['c0'], gatesC, tracker, 60_000)
    await flush()
    expect(tracker.starts).not.toContain('c0')
    expect(tracker.live).toBe(24)

    // One hook of event A finishes → its seat frees → c0 is seated and starts.
    gatesA[0]!.open()
    await flush()
    expect(tracker.starts).toContain('c0')
    expect(tracker.live).toBe(24) // a0 exited, c0 entered
    expect(tracker.maxLive).toBe(24)

    openAll(gatesA)
    openAll(gatesB)
    openAll(gatesC)
    await Promise.all([...merges.map(m => m.done), mergeC.done])
    expect(tracker.maxLive).toBe(24)
    expect(mergeC.collected).toEqual(['c0:start', 'c0:end'])
  })

  test('non-prompt/agent generators are never seated and run uncapped alongside a saturated session pool', async () => {
    const tracker = createTracker()
    const { gatesA, gatesB, merges } = saturateSessionPool(tracker)
    await flush()
    expect(tracker.live).toBe(24)

    // Official Ovn: limit undefined → generator joins the uncapped outer
    // merge with no wrapper — command/callback hooks are outside the cap.
    const commandTags = ['x0', 'x1', 'x2']
    const commandGates = createGates(commandTags.length)
    const mergeU = consume(
      mergeHookGeneratorsWithSessionSlots(
        commandTags.map((tag, i) =>
          seatedHookGenerator(tracker, tag, commandGates[i]!.promise),
        ),
        () => undefined,
        { session: getHookSessionSlots(), limitMs: 60_000 },
      ),
    )
    await flush()
    expect(tracker.starts).toEqual(expect.arrayContaining(commandTags))
    expect(tracker.live).toBe(27) // 24 seated + 3 uncapped

    openAll(commandGates)
    openAll(gatesA)
    openAll(gatesB)
    await Promise.all([...merges.map(m => m.done), mergeU.done])
    expect(mergeU.collected.length).toBe(6)
  })
})

describe('CC 2.1.312 #22: overdue pool (at most 12 that waited past the event timeout)', () => {
  test('a hook waiting longer than its event timeout is admitted via the overdue pool while the session pool stays saturated', async () => {
    const tracker = createTracker()
    const { gatesA, gatesB, merges } = saturateSessionPool(tracker)
    await flush()
    expect(tracker.live).toBe(24)

    // ctx.limitMs is the event timeout (official: {…,limitMs:S} → P0r
    // waitLimitMs). 30ms wait, then seated:false → overdue acquire.
    const gatesC = createGates(1)
    const mergeC = startCappedMerge(['c0'], gatesC, tracker, 30)
    await flush()
    expect(tracker.starts).not.toContain('c0') // still inside the bounded wait
    expect(getHookSessionSlots().slots.activeCount(OVERDUE_HOOKS_POOL)).toBe(0)

    await sleep(80) // bounded wait (30ms) elapses → overdue admission
    expect(tracker.starts).toContain('c0')
    expect(tracker.live).toBe(25)
    expect(getHookSessionSlots().slots.activeCount(OVERDUE_HOOKS_POOL)).toBe(1)
    expect(getHookSessionSlots().slots.activeCount(SESSION_HOOKS_POOL)).toBe(24)

    openAll(gatesC)
    openAll(gatesA)
    openAll(gatesB)
    await Promise.all([...merges.map(m => m.done), mergeC.done])
  })

  test('the overdue pool caps at 12: the 13th overdue hook waits until an overdue hook finishes', async () => {
    const tracker = createTracker()
    const { gatesA, gatesB, merges } = saturateSessionPool(tracker)
    await flush()

    // 12 single-hook events all fall into the overdue pool (short waitLimit).
    const overdueMerges: Array<{ collected: string[]; done: Promise<void> }> = []
    const overdueGates: Gate[][] = []
    for (let i = 0; i < 12; i++) {
      const gates = createGates(1)
      overdueGates.push(gates)
      overdueMerges.push(startCappedMerge([`d${i}`], gates, tracker, 20))
    }
    await sleep(80)
    const overdueStarted = tracker.starts.filter(tag => tag.startsWith('d'))
    expect(overdueStarted.length).toBe(12)
    expect(getHookSessionSlots().slots.activeCount(OVERDUE_HOOKS_POOL)).toBe(12)

    // 13th overdue seeker: bounded wait expires, but the overdue pool is full
    // → stays queued (official byt FIFO on mEr).
    const gatesE = createGates(1)
    const mergeE = startCappedMerge(['e0'], gatesE, tracker, 20)
    await sleep(80)
    expect(tracker.starts).not.toContain('e0')
    expect(tracker.live).toBe(24 + 12)

    // One overdue hook finishes → its overdue seat frees → e0 is admitted.
    overdueGates[0]![0]!.open()
    await flush()
    expect(tracker.starts).toContain('e0')
    expect(tracker.live).toBe(24 + 12) // d0 exited, e0 entered
    expect(tracker.maxLive).toBe(36)

    openAll(gatesE)
    for (const gates of overdueGates) {
      openAll(gates)
    }
    openAll(gatesA)
    openAll(gatesB)
    await Promise.all([
      ...merges.map(m => m.done),
      ...overdueMerges.map(m => m.done),
      mergeE.done,
    ])
    expect(getHookSessionSlots().slots.activeCount(OVERDUE_HOOKS_POOL)).toBe(0)
    expect(getHookSessionSlots().slots.activeCount(SESSION_HOOKS_POOL)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ALS session sharing, reentrancy guard, singleton
// ---------------------------------------------------------------------------

describe('CC 2.1.312 #22: ALS holder (official Rvn.holder) — reentrancy guard + shared session state', () => {
  test('a dispatch inside a held step skips seating (official holder.getStore()?.isHeld===true → e.next())', async () => {
    const session = getHookSessionSlots()
    const tracker = createTracker()

    // Saturate the session pool directly (24 occupies).
    const releases: Array<() => void> = []
    for (let i = 0; i < HOOK_SESSION_CONCURRENCY_CAP; i++) {
      releases.push(session.slots.occupy(SESSION_HOOKS_POOL))
    }
    expect(session.slots.wouldWait(SESSION_HOOKS_POOL, HOOK_SESSION_CONCURRENCY_CAP)).toBe(true)

    // Control: outside the holder, a wrapped generator must NOT start.
    const controlGate = createGate()
    const control = wrapHookGeneratorWithSessionSeat(
      seatedHookGenerator(tracker, 'ctrl', controlGate.promise),
      60_000,
      { session, limitMs: 60_000 },
      new AbortController().signal,
    )
    void control.next()

    // Nested (sub-agent-like) dispatch inside a held step: starts immediately
    // despite saturation, and consumes no seat.
    const heldGate = createGate()
    const held = wrapHookGeneratorWithSessionSeat(
      seatedHookGenerator(tracker, 'held0', heldGate.promise),
      60_000,
      { session, limitMs: 60_000 },
      new AbortController().signal,
    )
    const heldStep = session.holder.run({ isHeld: true }, () => held.next())
    await flush()
    expect(tracker.starts).toEqual(['held0']) // control still waiting
    expect(session.slots.activeCount(SESSION_HOOKS_POOL)).toBe(24) // no extra seat

    // Free one seat → the control waiter is pumped and starts.
    releases[0]!()
    await flush()
    expect(tracker.starts).toEqual(expect.arrayContaining(['ctrl']))

    controlGate.open()
    heldGate.open()
    await heldStep
    await flush()
    for (const release of releases.slice(1)) {
      release()
    }
  })

  test('the session tracker is a lazily created shared singleton (official Mvn=new W(()=>new Rvn))', () => {
    const first = getHookSessionSlots()
    expect(getHookSessionSlots()).toBe(first)
    resetHookSessionSlotsForTest()
    expect(getHookSessionSlots()).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// Merge contract preservation (official Ovn fast branch)
// ---------------------------------------------------------------------------

describe('CC 2.1.312 #22: ≤1 capped generator keeps the plain-merge contract', () => {
  test('output set and order match the uncapped all() merge (v301 behavior)', async () => {
    const viaHelper = await toArray(
      mergeHookGeneratorsWithSessionSlots(
        [immediateGen('p0'), immediateGen('c0'), immediateGen('c1')],
        index => (index === 0 ? 1_000 : undefined),
        { session: getHookSessionSlots(), limitMs: 60_000 },
      ),
    )
    const viaPlainAll = await toArray(
      all([immediateGen('p0'), immediateGen('c0'), immediateGen('c1')]),
    )
    expect(viaHelper).toEqual(viaPlainAll)
    expect(viaHelper).toEqual(['p0', 'c0', 'c1'])

    const zeroCapped = await toArray(
      mergeHookGeneratorsWithSessionSlots(
        [immediateGen('c0'), immediateGen('c1')],
        () => undefined,
        { session: getHookSessionSlots(), limitMs: 60_000 },
      ),
    )
    expect(zeroCapped).toEqual(['c0', 'c1'])
  })
})
