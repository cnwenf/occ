import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.286 (item-C): context-window-drop notice — binary `el`/`tl`/`ol`/
 * `nl`/`rl`/`Ho`/`TN`/`ds` (@212133200-212135300) + `XEr`/`dSo` (@205138562),
 * all byte-verified in the v286 ELF.
 *
 * "Improved the model fallback notice and the autocompact-thrashing error to
 * say when a fallback dropped the context window from 1M to 200K tokens."
 * (Call-site wiring @212193507 / @212156257 / @212198514 is STAGED — the pure
 * builders are pinned here.)
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const CHECK_1M_PATH = '../check1mAccess.js'

let opus1m = true
let sonnet1m = true
let realCheck1m: Record<string, unknown> = {}

beforeAll(async () => {
  realCheck1m = { ...((await import(CHECK_1M_PATH)) as object) }
  mock.module(CHECK_1M_PATH, () => ({
    ...realCheck1m,
    checkOpus1mAccess: () => opus1m,
    checkSonnet1mAccess: () => sonnet1m,
  }))
})

afterAll(() => {
  mock.restore()
})

const {
  AUTOCOMPACT_THRASHING_HINT_MESSAGE,
  AUTOCOMPACT_THRASHING_MESSAGE,
  add1mSuffix,
  buildFallbackNoticeSuffix,
  composeThrashingMessage,
  createFallbackRecord,
  fallbackContextWindows,
  formatWindowLabel,
  mergeFallbackChain,
  suggest1mFallbackAlternative,
} = require('../contextDropNotice.js') as typeof import('../contextDropNotice.js')

const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'DISABLE_COMPACT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'USER_TYPE',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  opus1m = true
  sonnet1m = true
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('2.1.286 item-C — exact binary strings (XEr / dSo @205138562)', () => {
  test('AUTOCOMPACT_THRASHING_MESSAGE is byte-identical to XEr', () => {
    expect(AUTOCOMPACT_THRASHING_MESSAGE).toBe(
      'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
    )
  })

  test('AUTOCOMPACT_THRASHING_HINT_MESSAGE is byte-identical to dSo', () => {
    expect(AUTOCOMPACT_THRASHING_HINT_MESSAGE).toBe(
      `${AUTOCOMPACT_THRASHING_MESSAGE} A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.`,
    )
  })
})

describe('2.1.286 item-C — formatWindowLabel (Ho) / add1mSuffix (TN)', () => {
  test('1M and 200K labels (ur(e).toUpperCase())', () => {
    expect(formatWindowLabel(1_000_000)).toBe('1M')
    expect(formatWindowLabel(200_000)).toBe('200K')
  })

  test('add1mSuffix appends exactly one [1m], deduping trailing repetitions', () => {
    expect(add1mSuffix('claude-sonnet-5')).toBe('claude-sonnet-5[1m]')
    expect(add1mSuffix('claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]')
    expect(add1mSuffix('claude-sonnet-5[1m][1M]')).toBe('claude-sonnet-5[1m]')
  })
})

describe('2.1.286 item-C — createFallbackRecord (el) / mergeFallbackChain (tl)', () => {
  test('el: reason==="overloaded" sets allOverloaded; leftModels starts [from]', () => {
    expect(
      createFallbackRecord('claude-opus-5', 'claude-sonnet-5', true, 'overloaded'),
    ).toEqual({
      fromModel: 'claude-opus-5',
      toModel: 'claude-sonnet-5',
      toModelIsConfigured: true,
      leftModels: ['claude-opus-5'],
      allOverloaded: true,
    })
    expect(
      createFallbackRecord('a', 'b', false, 'server_error').allOverloaded,
    ).toBe(false)
  })

  test('tl: contiguous hops merge (first from, concat left, AND overloaded)', () => {
    const first = createFallbackRecord('m1', 'm2', true, 'overloaded')
    const second = createFallbackRecord('m2', 'm3', true, 'overloaded')
    expect(mergeFallbackChain(first, second)).toEqual({
      fromModel: 'm1',
      toModel: 'm3',
      toModelIsConfigured: true,
      leftModels: ['m1', 'm2'],
      allOverloaded: true,
    })
    // allOverloaded ANDs: one non-overload hop poisons the chain.
    expect(
      mergeFallbackChain(first, createFallbackRecord('m2', 'm3', true, 'x'))
        .allOverloaded,
    ).toBe(false)
  })

  test('tl: a non-contiguous next record replaces the chain', () => {
    const first = createFallbackRecord('m1', 'm2', true, 'overloaded')
    const unrelated = createFallbackRecord('m9', 'm8', true, 'overloaded')
    expect(mergeFallbackChain(first, unrelated)).toBe(unrelated)
    expect(mergeFallbackChain(undefined, unrelated)).toBe(unrelated)
  })
})

describe('2.1.286 item-C — fallbackContextWindows (nl)', () => {
  test('1M [1m] origin → 200K landing', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(fallbackContextWindows(record)).toEqual({
      fromWindow: 1_000_000,
      toWindow: 200_000,
    })
  })
})

describe('2.1.286 item-C — suggest1mFallbackAlternative (rl)', () => {
  const shrinking = () =>
    createFallbackRecord('claude-opus-5[1m]', 'claude-sonnet-5', true, 'overloaded')

  test('configured + 1M origin + all-overloaded + entitled → the suggestion text', () => {
    expect(suggest1mFallbackAlternative(shrinking(), 'claude-opus-5[1m]')).toBe(
      'use claude-sonnet-5[1m] for this entry in your fallback model list',
    )
  })

  test('suppressed when the to-model is not a configured fallback', () => {
    const record = { ...shrinking(), toModelIsConfigured: false }
    expect(suggest1mFallbackAlternative(record, 'claude-opus-5[1m]')).toBeUndefined()
  })

  test('suppressed when not all hops were overloads', () => {
    const record = { ...shrinking(), allOverloaded: false }
    expect(suggest1mFallbackAlternative(record, 'claude-opus-5[1m]')).toBeUndefined()
  })

  test('suppressed when the origin had no 1M context (vd)', () => {
    expect(suggest1mFallbackAlternative(shrinking(), 'claude-opus-5')).toBeUndefined()
  })

  test('suppressed when CLAUDE_CODE_DISABLE_1M_CONTEXT is set (vd → Zx)', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(suggest1mFallbackAlternative(shrinking(), 'claude-opus-5[1m]')).toBeUndefined()
  })

  test('suppressed when the [1m] variant is already in leftModels (dedup)', () => {
    // Same-family 1M→200K fallback: leftModels=['claude-sonnet-5[1m]'] equals
    // TN(toModel) — the binary `some(g=>g.toLowerCase()===n.toLowerCase())`.
    const record = createFallbackRecord(
      'claude-sonnet-5[1m]',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(
      suggest1mFallbackAlternative(record, 'claude-sonnet-5[1m]'),
    ).toBeUndefined()
  })

  test('suppressed when the to-model family lacks 1M access (zP/EN gate)', () => {
    sonnet1m = false
    expect(suggest1mFallbackAlternative(shrinking(), 'claude-opus-5[1m]')).toBeUndefined()
  })
})

describe('2.1.286 item-C — buildFallbackNoticeSuffix (ol)', () => {
  test('1M→200K shrink without suggestion → the exact binary suffix', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      false, // not configured → rl returns undefined
      'server_error',
    )
    expect(buildFallbackNoticeSuffix(record, record)).toEqual({
      fromWindow: 1_000_000,
      toWindow: 200_000,
      noticeSuffix: ' · context window 1M → 200K tokens',
    })
  })

  test('1M→200K shrink with suggestion → the (to keep …) clause', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(buildFallbackNoticeSuffix(record, record)).toEqual({
      fromWindow: 1_000_000,
      toWindow: 200_000,
      noticeSuffix:
        ' · context window 1M → 200K tokens (to keep 1M, use claude-sonnet-5[1m] for this entry in your fallback model list)',
    })
  })

  test('no shrink (toWindow >= fromWindow) → empty suffix', () => {
    const record = createFallbackRecord(
      'claude-opus-5',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(buildFallbackNoticeSuffix(record, record)).toEqual({
      fromWindow: 200_000,
      toWindow: 200_000,
      noticeSuffix: '',
    })
  })
})

describe('2.1.286 item-C — composeThrashingMessage (ds)', () => {
  test('no fallback record → the plain hint message (dSo)', () => {
    expect(
      composeThrashingMessage({ fallback: undefined, mainLoopModel: 'claude-sonnet-5' }),
    ).toEqual({
      content: AUTOCOMPACT_THRASHING_HINT_MESSAGE,
      afterShrinkingFallback: false,
    })
  })

  test('the fallback did not land on the main-loop model → plain', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(
      composeThrashingMessage({ fallback: record, mainLoopModel: 'claude-opus-5' }),
    ).toEqual({
      content: AUTOCOMPACT_THRASHING_HINT_MESSAGE,
      afterShrinkingFallback: false,
    })
  })

  test('window did not shrink → plain', () => {
    const record = createFallbackRecord(
      'claude-opus-5',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(
      composeThrashingMessage({ fallback: record, mainLoopModel: 'claude-sonnet-5' }),
    ).toEqual({
      content: AUTOCOMPACT_THRASHING_HINT_MESSAGE,
      afterShrinkingFallback: false,
    })
  })

  test('1M→200K shrink WITH suggestion → the full official text', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      true,
      'overloaded',
    )
    expect(
      composeThrashingMessage({ fallback: record, mainLoopModel: 'claude-sonnet-5' }),
    ).toEqual({
      content:
        'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. The likely cause: while working on this response, Claude Code fell back from Opus 5 (1M context) to Sonnet 5 and runs that model with a 200K-token context window on your provider, instead of 1M. Your next message tries Opus 5 (1M context) first. To keep 1M, use claude-sonnet-5[1m] for this entry in your fallback model list.',
      afterShrinkingFallback: true,
    })
  })

  test('1M→200K shrink WITHOUT suggestion → the "To avoid this" variant', () => {
    const record = createFallbackRecord(
      'claude-opus-5[1m]',
      'claude-sonnet-5',
      false, // not configured → no suggestion
      'server_error',
    )
    expect(
      composeThrashingMessage({ fallback: record, mainLoopModel: 'claude-sonnet-5' }),
    ).toEqual({
      content:
        'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. The likely cause: while working on this response, Claude Code fell back from Opus 5 (1M context) to Sonnet 5 and runs that model with a 200K-token context window on your provider, instead of 1M. Your next message tries Opus 5 (1M context) first. To avoid this, use a fallback model with a 1M context window, or use /clear to start fresh.',
      afterShrinkingFallback: true,
    })
  })
})
