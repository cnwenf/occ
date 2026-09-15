import { describe, expect, test } from 'bun:test'
import { getSessionId } from '../../../bootstrap/state.js'
import type { AppState } from '../../../state/AppState.js'
import { groupHooksByEventAndMatcher } from '../hooksConfigManager.js'

/**
 * OCC-126 (self-acceptance security discovery — NOT an official-version port).
 *
 * A hook config's `matcher` is an unvalidated `z.string()` (schemas/hooks.ts),
 * so a malicious settings/session hook can use `matcher: "__proto__"` (or
 * `"constructor"`/`"prototype"`). `groupHooksByEventAndMatcher` used plain `{}`
 * inner buckets keyed by that matcher:
 *
 *   if (!eventGroup[matcherKey]) eventGroup[matcherKey] = []
 *   eventGroup[matcherKey].push(hook)
 *
 * For `matcherKey === "__proto__"`, `eventGroup["__proto__"]` reads through
 * Object.prototype (it is `Object.prototype`, truthy), so the `= []` init is
 * SKIPPED and `.push(hook)` runs on a non-array → "push is not a function",
 * crashing the /hooks menu and all hook grouping. (Assigning `obj.__proto__ = []`
 * would instead silently re-point the bucket's prototype.) The fix re-creates
 * every inner bucket with `Object.create(null)`, so attacker-chosen keys become
 * inert own properties.
 */

// A minimal AppState: getAllHooks only dereferences `appState.sessionHooks`
// (via getSessionHooks); everything else comes from module-level settings/state.
function makeAppState(
  sessionHooks: Map<string, unknown> = new Map(),
): AppState {
  return { sessionHooks } as unknown as AppState
}

describe('OCC-126 hook matcher prototype-key crash — vulnerability characterization', () => {
  test('a plain {} bucket crashes on a "__proto__" matcher (the pre-fix bug)', () => {
    // This reproduces EXACTLY what groupHooksByEventAndMatcher did before the
    // fix, proving the vector is real and not theoretical.
    const plainBucket: Record<string, unknown[]> = {}
    const matcherKey = '__proto__'

    // `{}.__proto__` is Object.prototype (truthy) — the init guard is skipped.
    expect(plainBucket[matcherKey]).toBeTruthy()

    expect(() => {
      if (!plainBucket[matcherKey]) plainBucket[matcherKey] = []
      plainBucket[matcherKey].push({} as never) // ".push is not a function"
    }).toThrow()
  })

  test('a null-prototype bucket defuses "__proto__" and "constructor"', () => {
    const nullBucket = Object.create(null) as Record<string, unknown[]>
    for (const matcherKey of ['__proto__', 'constructor', 'prototype']) {
      // No inherited value → the init guard runs → a real own array property.
      expect(nullBucket[matcherKey]).toBeUndefined()
      if (!nullBucket[matcherKey]) nullBucket[matcherKey] = []
      expect(() => nullBucket[matcherKey].push({} as never)).not.toThrow()
      expect(nullBucket[matcherKey]).toHaveLength(1)
    }
  })
})

describe('OCC-126 groupHooksByEventAndMatcher — buckets are null-prototyped', () => {
  test('every event bucket has a null prototype (fix is wired into the real function)', () => {
    const grouped = groupHooksByEventAndMatcher(makeAppState(), [])
    const events = Object.keys(grouped)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(Object.getPrototypeOf(grouped[event as keyof typeof grouped])).toBeNull()
    }
  })

  test('attack keys are inert on a real returned bucket', () => {
    const grouped = groupHooksByEventAndMatcher(makeAppState(), [])
    const pre = grouped.PreToolUse
    expect(pre['__proto__']).toBeUndefined()
    pre['__proto__'] = []
    expect(() => pre['__proto__'].push({} as never)).not.toThrow()
    expect(pre['__proto__']).toHaveLength(1)
    // The bucket still behaves as a normal map for ordinary matcher keys.
    pre['Bash'] = []
    pre['Bash'].push({} as never)
    expect(pre['Bash']).toHaveLength(1)
  })
})

describe('OCC-126 end-to-end — a "__proto__" session-hook matcher groups safely', () => {
  test('a malicious session hook with matcher:"__proto__" does not crash grouping', () => {
    const sessionId = getSessionId()
    const sessionHooks = new Map<string, unknown>([
      [
        sessionId,
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '__proto__',
                hooks: [{ hook: { type: 'command', command: 'echo pwned' } }],
              },
            ],
          },
        },
      ],
    ])

    let grouped: ReturnType<typeof groupHooksByEventAndMatcher>
    expect(() => {
      grouped = groupHooksByEventAndMatcher(makeAppState(sessionHooks), [])
    }).not.toThrow()

    // The hook is grouped under the LITERAL "__proto__" key as an own property
    // (not swallowed by, or re-pointing, Object.prototype).
    const bucket = grouped!.PreToolUse
    expect(Object.hasOwn(bucket, '__proto__')).toBe(true)
    expect(Array.isArray(bucket['__proto__'])).toBe(true)
    expect(bucket['__proto__'].length).toBeGreaterThanOrEqual(1)
    expect(bucket['__proto__'][0].matcher).toBe('__proto__')
  })
})
