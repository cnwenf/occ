/**
 * CC 2.1.302 (#035) — "Changed prompt and agent hooks so that at most 12 of
 * one event run at a time; the rest wait their turn."
 *
 * Official v302 binary evidence (linux-x64 ELF @246248866, NEW in v302 —
 * v301 lacks ant/Iee/ZRn entirely at the same site):
 *
 *   var ant=12;
 *   function Iee(e){return e.type==="prompt"||e.type==="agent"}
 *   function ZRn(e,n){let r=e.filter((h,y)=>n(y));
 *     if(r.length<=1)return oJt(e);
 *     let s=Promise.resolve();
 *     return oJt([...e.filter((h,y)=>!n(y)),
 *       oJt(r.map(async function*(h){s=s.then(Yg),await s,yield*h}),ant)])}
 *
 * Keepalive wave formula (`K=Math.max(1,Math.ceil(H/ant))`, budget
 * `min(w*K+60000,1200000)`) is NOT tested here: OCC has no
 * "hook-dispatch-hold" keepalive analogue (grep-verified), so there is no
 * budget to scale.
 */

import { describe, expect, test } from 'bun:test'
import { all, toArray } from '../../generators.js'
import {
  HOOK_PROMPT_AGENT_CONCURRENCY_CAP,
  isPromptOrAgentHook,
  mergeHookGeneratorsWithPromptAgentCap,
} from '../promptAgentConcurrencyCap302.js'

// ---------------------------------------------------------------------------
// Test harness: live-concurrency tracker + gated fake hook generators
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

function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

/** Fake hook generator: records start, yields, waits on its gate, yields, records finish. */
function trackedHookGenerator(
  tracker: Tracker,
  tag: string,
  gate: Promise<void>,
): AsyncGenerator<string, void> {
  return (async function* () {
    tracker.enter(tag)
    yield `${tag}:start`
    await gate
    yield `${tag}:end`
    tracker.exit(tag)
  })()
}

/** Immediately-completing generator (no gate) for ordering equivalence checks. */
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

/** Macrotask flush — drains pending microtask chains (stagger chain + races). */
const flush = (): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, 10))

const PROMPT_TAGS = Array.from({ length: 13 }, (_, i) => `p${i}`)

describe('CC 2.1.302 #035: prompt/agent hook concurrency cap (official ant/Iee/ZRn)', () => {
  test('cap constant is the official verbatim 12 (ant)', () => {
    expect(HOOK_PROMPT_AGENT_CONCURRENCY_CAP).toBe(12)
  })

  test('isPromptOrAgentHook matches official Iee predicate', () => {
    expect(isPromptOrAgentHook({ type: 'prompt' })).toBe(true)
    expect(isPromptOrAgentHook({ type: 'agent' })).toBe(true)
    expect(isPromptOrAgentHook({ type: 'command' })).toBe(false)
    expect(isPromptOrAgentHook({ type: 'callback' })).toBe(false)
    expect(isPromptOrAgentHook({ type: 'http' })).toBe(false)
  })

  test('13 prompt-type hooks: max observed concurrency is exactly 12 and the 13th starts only after one finishes', async () => {
    const tracker = createTracker()
    const gates = PROMPT_TAGS.map(() => createGate())
    const generators = PROMPT_TAGS.map((tag, i) =>
      trackedHookGenerator(tracker, tag, gates[i]!.promise),
    )

    const merged = mergeHookGeneratorsWithPromptAgentCap(
      generators,
      () => true, // all 13 are prompt/agent hooks
    )
    const { collected, done } = consume(merged)

    await flush()
    // Exactly the cap is live; the 13th has NOT started.
    expect(tracker.maxLive).toBe(12)
    expect(tracker.live).toBe(12)
    expect(tracker.starts).toEqual(PROMPT_TAGS.slice(0, 12))

    // Finish the first hook → the 13th starts, concurrency stays at 12.
    gates[0]!.open()
    await flush()
    expect(tracker.starts).toEqual(PROMPT_TAGS)
    expect(tracker.live).toBe(12)
    expect(tracker.maxLive).toBe(12)

    // Finish the rest; every yield reaches the consumer.
    for (const gate of gates) {
      gate.open()
    }
    await done
    expect(tracker.maxLive).toBe(12)
    expect(collected.length).toBe(26) // 13 hooks × 2 yields
  })

  test('mixed dispatch: 13 prompt + 3 command hooks — command hooks are NOT throttled by the capped stream', async () => {
    const tracker = createTracker()
    const promptGates = PROMPT_TAGS.map(() => createGate())
    const commandTags = ['c0', 'c1', 'c2']
    const commandGates = commandTags.map(() => createGate())

    const generators = [
      ...PROMPT_TAGS.map((tag, i) =>
        trackedHookGenerator(tracker, tag, promptGates[i]!.promise),
      ),
      ...commandTags.map((tag, i) =>
        trackedHookGenerator(tracker, tag, commandGates[i]!.promise),
      ),
    ]

    // Official call-site shape: index predicate over the matched-hook array.
    const merged = mergeHookGeneratorsWithPromptAgentCap(
      generators,
      index => index < PROMPT_TAGS.length,
    )
    const { collected, done } = consume(merged)

    await flush()
    // All 3 command hooks run concurrently ALONGSIDE the saturated 12-cap
    // prompt stream (outer merge is uncapped).
    const promptStarts = tracker.starts.filter(tag => tag.startsWith('p'))
    expect(promptStarts).toEqual(PROMPT_TAGS.slice(0, 12))
    expect(tracker.starts).toContain('c0')
    expect(tracker.starts).toContain('c1')
    expect(tracker.starts).toContain('c2')
    expect(tracker.live).toBe(15) // 12 capped prompt + 3 uncapped command
    expect(tracker.starts).not.toContain('p12')

    // Command hooks finish independently of the prompt gates.
    for (const gate of commandGates) {
      gate.open()
    }
    await flush()
    expect(collected).toContain('c0:end')
    expect(collected).toContain('c1:end')
    expect(collected).toContain('c2:end')
    expect(tracker.starts).not.toContain('p12') // prompt cap unaffected

    for (const gate of promptGates) {
      gate.open()
    }
    await done
    expect(collected.length).toBe(13 * 2 + 3 * 2) // every yield arrives
  })

  test('≤1 prompt/agent hook → behavior identical to the plain uncapped merge (v301 behavior, order preserved)', async () => {
    // Partition branch: exactly 1 capped hook must take the `oJt(e)` path.
    const viaHelper = await toArray(
      mergeHookGeneratorsWithPromptAgentCap(
        [immediateGen('p0'), immediateGen('c0'), immediateGen('c1')],
        index => index === 0,
      ),
    )
    const viaPlainAll = await toArray(
      all([immediateGen('p0'), immediateGen('c0'), immediateGen('c1')]),
    )
    expect(viaHelper).toEqual(viaPlainAll)
    expect(viaHelper).toEqual(['p0', 'c0', 'c1'])

    // Zero capped hooks also takes the plain path.
    const zeroCapped = await toArray(
      mergeHookGeneratorsWithPromptAgentCap(
        [immediateGen('c0'), immediateGen('c1')],
        () => false,
      ),
    )
    expect(zeroCapped).toEqual(['c0', 'c1'])
  })

  test('output completeness + relative order: every capped hook starts in original order and all yields reach the consumer', async () => {
    const tracker = createTracker()
    const gates = PROMPT_TAGS.map(() => createGate())
    const generators = PROMPT_TAGS.map((tag, i) =>
      trackedHookGenerator(tracker, tag, gates[i]!.promise),
    )

    const merged = mergeHookGeneratorsWithPromptAgentCap(
      generators,
      () => true,
    )
    const { collected, done } = consume(merged)

    // Release gates one at a time, in order; starts must follow the
    // original relative order p0…p12 (official filter preserves order).
    for (const gate of gates) {
      await flush()
      gate.open()
    }
    await done

    expect(tracker.starts).toEqual(PROMPT_TAGS)
    expect(collected.length).toBe(26)
    for (const tag of PROMPT_TAGS) {
      expect(collected).toContain(`${tag}:start`)
      expect(collected).toContain(`${tag}:end`)
    }
  })
})
