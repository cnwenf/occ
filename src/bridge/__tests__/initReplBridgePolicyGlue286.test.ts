import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * PORT-glue pin (CC 2.1.286, SEC-1 acceptance re-review must-fix #2).
 *
 * `attachBridgePolicyWatcher286.test.ts` covers the WATCHER layer: it feeds
 * `registerStateHook` itself and asserts re-check-on-reconnect behavior. That
 * leaves the PRODUCTION-SIDE glue in `initReplBridge.ts` unpinned — mutation
 * M4 in the reviewer's matrix (delete the `policyStateHook?.(state)` feed
 * call inside `trackedOnStateChange`, initReplBridge.ts:297) killed ZERO
 * tests: the watcher still passed because it never observes how it gets fed.
 * If that line silently disappears, the reconnect re-check dies in
 * production while CI stays green.
 *
 * This suite pins the glue with the source-pin technique already blessed in
 * `queuedDrainGray286.test.ts` (REPL wrap-site pin) and
 * `promptsAwaitingModel275.test.ts` (turn-append literal pin): read the
 * production source and assert the wiring statements exist, in the right
 * order, at every site. Deliberately hermetic — it imports NO production
 * module (fs read only) and uses NO `mock.module`, so it is leak-free in a
 * shared `bun test` process by construction.
 *
 * Pinned contract (all sites byte-checked against head ee87887):
 *  1. `trackedOnStateChange` maintains `bridgeConnectedForPolicy`
 *     ('connected'/'ready' → true, 'failed' → false).
 *  2. It calls the caller's `onStateChange?.(state, detail)` BEFORE feeding
 *     `policyStateHook?.(state)` — the ordering comment in production is a
 *     real contract: a refusal found by the watcher's re-check re-enters this
 *     function with 'failed', so the consumer must see ready → failed, never
 *     the reverse.
 *  3. BOTH production paths (v2 env-less + v1 core) pass
 *     `onStateChange: trackedOnStateChange` to the transport AND to
 *     `attachBridgePolicyWatcher`, with `registerStateHook` assigning
 *     `policyStateHook = hook` and `isConnected` reading the flag.
 */

const SOURCE_PATH = fileURLToPath(new URL('../initReplBridge.ts', import.meta.url))
const source = readFileSync(SOURCE_PATH, 'utf8')

/**
 * Extract the body of `const trackedOnStateChange = (...): void => { ... }`
 * by brace-balance scan (comments in the body contain no braces-of-code
 * ambiguity risk because we count ALL braces, and the body's template-free
 * comments are brace-balanced).
 */
function extractTrackedOnStateChangeBody(src: string): string {
  const start = src.indexOf('const trackedOnStateChange = (state: BridgeState')
  expect(start).toBeGreaterThan(-1)
  const braceOpen = src.indexOf('{', start)
  expect(braceOpen).toBeGreaterThan(-1)
  let depth = 0
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(braceOpen, i + 1)
    }
  }
  throw new Error('trackedOnStateChange body: unbalanced braces')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

describe('initReplBridge policy glue — production feed wiring (M4 pin)', () => {
  const body = extractTrackedOnStateChangeBody(source)

  test('trackedOnStateChange feeds policyStateHook?.(state) — deleting this line is the M4 mutation', () => {
    // The exact statement the reviewer's M4 mutation removed. This is the
    // kill-test: with line :297 deleted, this assertion fails (verified
    // RED-before in the fix round).
    expect(body).toContain('policyStateHook?.(state)')
  })

  test('trackedOnStateChange maintains bridgeConnectedForPolicy transitions', () => {
    expect(body).toContain("if (state === 'connected' || state === 'ready')")
    expect(body).toContain('bridgeConnectedForPolicy = true')
    expect(body).toContain("} else if (state === 'failed')")
    expect(body).toContain('bridgeConnectedForPolicy = false')
  })

  test('caller onStateChange fires BEFORE the policy feed (ready → failed ordering contract)', () => {
    const callerIdx = body.indexOf('onStateChange?.(state, detail)')
    const feedIdx = body.indexOf('policyStateHook?.(state)')
    expect(callerIdx).toBeGreaterThan(-1)
    expect(feedIdx).toBeGreaterThan(-1)
    // The refusal re-check re-enters with 'failed'; the consumer must never
    // observe failed-before-ready, which requires caller-first ordering.
    expect(callerIdx).toBeLessThan(feedIdx)
  })

  test('policyStateHook is declared and assigned ONLY via registerStateHook (exactly 2 production sites)', () => {
    expect(source).toContain(
      'let policyStateHook: ((state: BridgeState) => void) | undefined',
    )
    // v2 env-less path + v1 core path — one registration each.
    expect(countOccurrences(source, 'policyStateHook = hook')).toBe(2)
    expect(countOccurrences(source, 'registerStateHook: hook => {')).toBe(2)
  })

  test('both transports receive the TRACKED onStateChange (4 sites: 2 transports + 2 watcher options)', () => {
    // Transport creation (env-less + core) and the watcher option object on
    // each path. Fewer sites = a path silently bypassing connection tracking.
    expect(countOccurrences(source, 'onStateChange: trackedOnStateChange')).toBe(4)
  })

  test('both watcher attach sites wire isConnected to the tracked flag', () => {
    expect(source).toContain('attachBridgePolicyWatcher(envLessHandle, {')
    expect(source).toContain('attachBridgePolicyWatcher(coreHandle, {')
    expect(
      countOccurrences(source, 'isConnected: () => bridgeConnectedForPolicy'),
    ).toBe(2)
  })
})
