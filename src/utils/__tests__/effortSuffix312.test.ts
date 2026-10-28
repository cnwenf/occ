import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEffortSuffix } from '../effort.js'
import {
  getSentEffort,
  resetSentEffort,
  setSentEffort,
} from '../effort/sentEffort.js'
import { setTurnEffort } from '../effort/turnEffort.js'

/**
 * CC 2.1.312 items 9+16 — the "sentEffort" in-force effort state.
 *
 * Official v312 spinner suffix builder gained a 4th parameter and the
 * sentEffort slot WINS over the resolver (v312 `Sbn` @243469955, byte-verified):
 *
 *   function Sbn(e,n,r,s){
 *     if(n===void 0&&r===void 0)return"";
 *     let f=s??kS(e,n,{turnEffort:r});
 *     if(f===void 0)return"";
 *     return` with ${e6(U0(f))} effort`}
 *
 * (v311 `cbn` was 3-param with no `s`.) The slot itself is turn-state store
 * field `sentEffort` (@259429372 reset, @277260243 stream-handler populate,
 * @251161309 query-engine message_start emit).
 *
 * Fix semantics (changelog #9): the spinner shows the effort level IN FORCE
 * (what the model actually applied on its last message), not a newly picked
 * level the model has not applied yet.
 */

const SAVED_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
  }
  resetSentEffort()
  setTurnEffort(undefined)
})

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) delete process.env[key]
  resetSentEffort()
  setTurnEffort(undefined)
})

describe('sentEffort slot (official turn-state store field, v312 @259429372)', () => {
  test('starts null and round-trips set/get', () => {
    expect(getSentEffort()).toBeNull()
    setSentEffort('high')
    expect(getSentEffort()).toBe('high')
    setSentEffort('xhigh')
    expect(getSentEffort()).toBe('xhigh')
  })

  test('setSentEffort(null) clears; resetSentEffort restores the fresh-store default', () => {
    setSentEffort('max')
    setSentEffort(null)
    expect(getSentEffort()).toBeNull()
    setSentEffort('low')
    resetSentEffort()
    expect(getSentEffort()).toBeNull()
  })
})

describe('getEffortSuffix 4-param shape (official v312 Sbn @243469955)', () => {
  test('sentEffort WINS over the resolver: a mid-task pick still shows the in-force level', () => {
    // The user just picked xhigh (appState effortValue), but the model has
    // only ever applied 'high' — the spinner must say " with high effort".
    expect(getEffortSuffix('claude-sonnet-5', 'xhigh', undefined, 'high')).toBe(
      ' with high effort',
    )
  })

  test('sentEffort null falls back to the resolver (pre-312 behavior)', () => {
    expect(getEffortSuffix('claude-sonnet-5', 'xhigh', undefined, null)).toBe(
      ' with xhigh effort',
    )
    // env unset → nothing configured → no suffix, exactly like the 2-param call
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(getEffortSuffix('claude-sonnet-5', undefined, undefined, null)).toBe('')
  })

  test('sentEffort undefined (omitted) keeps the existing 2-param contract', () => {
    expect(getEffortSuffix('claude-sonnet-5', 'xhigh')).toBe(' with xhigh effort')
    expect(getEffortSuffix('claude-sonnet-5', undefined)).toBe('')
  })

  test('effortValue undefined with a live in-force slot still renders (sentEffort wins over an undefined resolver result)', () => {
    // Official guard is `if(n===void 0&&r===void 0)return""` — it only bails
    // when BOTH app-state value and turn effort are undefined; the spinner
    // call site keeps the 3-param shape (r=void 0) but passes the live
    // sentEffort slot as `s`, so once the model has applied a level the
    // suffix shows it even with no configured effort. `let f=s??kS(...)`
    // short-circuits on s.
    setSentEffort('medium')
    expect(
      getEffortSuffix('claude-sonnet-5', undefined, undefined, getSentEffort()),
    ).toBe(' with medium effort')
  })

  test('all-empty case stays "" (guard + `if(f===void 0)return""`)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(getEffortSuffix('claude-sonnet-5', undefined, undefined, null)).toBe('')
    expect(getEffortSuffix('claude-sonnet-5', undefined)).toBe('')
  })
})
