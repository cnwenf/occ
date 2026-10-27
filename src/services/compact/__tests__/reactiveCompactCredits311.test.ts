import { APIError } from '@anthropic-ai/sdk'
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '../../../types/message.js'

/**
 * WP-B (triage-T1.md Item 5) — 1M-context credits refusal → withhold +
 * compact + continue instead of fatal.
 *
 * Official v311 evidence (linux-x64 ELF, /tmp/cc-diff-311/v311/package/claude,
 * all byte-verified with grep -aboF + dd):
 *   - z_e @250065637: `e.includes("Extra usage is required for long context")
 *     ||e.includes("Usage credits are required for long context")`
 *   - SHr @250065765: `fBe()&&e.isApiErrorMessage===!0&&e.errorDetails!==
 *     void 0&&z_e(e.errorDetails)` — the refusal is recognized by the RAW
 *     server text carried on errorDetails.
 *   - bd @257405921: `e.type==="assistant"&&SHr(e)&&n.contextWindow<=g6&&
 *     !RTt(n.model,np())&&aYn({hasAttempted:!1,querySource:r,aborted:!1})&&
 *     v6s()` with try/catch → `f("compact_after_long_context_refusal",
 *     "check_threw")` (g6=200000 @242280618).
 *   - aYn @250564537: `!e.hasAttempted&&!Qjt(e.querySource)&&(...||!G2e(
 *     e.querySource))&&of()&&T$()&&!e.aborted` — Qjt ≡ source==="compact";
 *     G2e ≡ {"prompt_suggestion","away_summary","agent_summary","hook_prompt"}
 *     @248136498; of() ≡ auto-compact enabled; T$() ≡ CLAUDE_CODE_REMOTE gate
 *     (tengu_reactive_compact_remote default false); v6s ≡ tengu_linked_rose
 *     default true @248135802.
 *   - Latch set in the API error handler @250042112: `if(H&&z_e(e.message)&&
 *     !fBe())Ods(!0),a("tengu_1m_credits_clamp_activated",{})`.
 *   - Post-loop outcomes @257505460-257509900: rapid_refill_breaker /
 *     too_few_groups (aWs ≡ groups<2) / aborted / still_refused @257509841 /
 *     not_compacted @257509857; telemetry compact_after_long_context_refusal
 *     (0 occurrences in v310 → 8 in v311).
 *
 * OCC deviations (documented in the final report):
 *   - errors.ts carries the raw refusal text on `errorDetails` (provenance
 *     marker ≡ SHr's fBe() gate) instead of errors.ts setting the latch —
 *     keeps errors.ts edits strictly inside the 1M-credits region and avoids
 *     an errors↔compact import cycle. The clamp latch lives here and is set
 *     on first detection (≡ Ods(!0) + tengu_1m_credits_clamp_activated).
 *   - RTt (true-1M-session check) omitted — redundant with the
 *     contextWindow<=200000 gate under OCC's single window source.
 *   - rapid_refill_breaker structurally wired but unreachable in OCC (no
 *     rapid-refill breaker exists; consecutiveRapidRefills is always 0).
 */

// Isolate config BEFORE the module graph loads (isAutoCompactEnabled reads
// getGlobalConfig; growthbook stubs return defaults).
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-credits311-'))
const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

// Force the 429 handler gate open (same facade mock as apiError429Sanitize281).
const RATE_LIMIT_MOCKING_PATH = '../../rateLimitMocking.js'
const realRateLimitMocking = await import(RATE_LIMIT_MOCKING_PATH)
mock.module(RATE_LIMIT_MOCKING_PATH, () => ({
  ...realRateLimitMocking,
  shouldProcessRateLimits: () => true,
}))

const { getAssistantMessageFromError } = await import('../../api/errors.js')
const rc = await import('../reactiveCompact.js')
const { createAssistantAPIErrorMessage, createUserMessage } = await import(
  '../../../utils/messages.js'
)

afterAll(() => {
  if (SAVED_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rc.resetLongContext1mCreditsBlocked()
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.CLAUDE_CODE_REMOTE
})

const MODEL = 'claude-sonnet-4-5'
const REFUSAL_EXTRA_USAGE = 'Extra usage is required for long context'
const REFUSAL_USAGE_CREDITS = 'Usage credits are required for long context'

function rateLimitError(bodyMessage: string): APIError {
  return new APIError(429, { message: bodyMessage }, bodyMessage, undefined)
}

function messageText(msg: AssistantMessage): string {
  const content = msg.message.content as Array<{ text?: string }>
  return content.map(block => block.text ?? '').join('')
}

function refusalMessage(errorDetails?: string): Message {
  return createAssistantAPIErrorMessage({
    content: 'API Error: Extra usage is required for 1M context · hint',
    error: 'rate_limit',
    ...(errorDetails !== undefined && { errorDetails }),
  }) as Message
}

function fakeCacheSafeParams(aborted = false) {
  const abortController = new AbortController()
  if (aborted) {
    abortController.abort()
  }
  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: {
      abortController,
      options: {},
    },
    forkContextMessages: [],
  } as never
}

// ── z_e: refusal text predicate ─────────────────────────────────────────────

describe('isLongContextCreditsRefusalText (official z_e @250065637)', () => {
  test('matches both official refusal strings', () => {
    expect(rc.isLongContextCreditsRefusalText(REFUSAL_EXTRA_USAGE)).toBe(true)
    expect(rc.isLongContextCreditsRefusalText(REFUSAL_USAGE_CREDITS)).toBe(
      true,
    )
    expect(
      rc.isLongContextCreditsRefusalText(`429 {"message":"${REFUSAL_EXTRA_USAGE}"}`),
    ).toBe(true)
  })

  test('rejects unrelated text', () => {
    expect(rc.isLongContextCreditsRefusalText('Prompt is too long')).toBe(false)
    expect(rc.isLongContextCreditsRefusalText('')).toBe(false)
    expect(
      rc.isLongContextCreditsRefusalText('Extra usage is required'),
    ).toBe(false)
  })
})

// ── errors.ts 1M-credits region (~700-730) ─────────────────────────────────

describe('getAssistantMessageFromError — 1M credits region (Item 5)', () => {
  test('Extra usage refusal keeps the fatal fallback text and carries errorDetails', () => {
    const msg = getAssistantMessageFromError(
      rateLimitError(REFUSAL_EXTRA_USAGE),
      MODEL,
    ) as AssistantMessage
    expect(msg.isApiErrorMessage).toBe(true)
    expect(messageText(msg)).toContain('Extra usage is required for 1M context')
    expect(msg.errorDetails ?? '').toContain(REFUSAL_EXTRA_USAGE)
  })

  test('Usage credits refusal (second official string) routes to the same branch', () => {
    const msg = getAssistantMessageFromError(
      rateLimitError(REFUSAL_USAGE_CREDITS),
      MODEL,
    ) as AssistantMessage
    expect(msg.isApiErrorMessage).toBe(true)
    expect(messageText(msg)).toContain('Extra usage is required for 1M context')
    expect(msg.errorDetails ?? '').toContain(REFUSAL_USAGE_CREDITS)
  })
})

// ── SHr: refusal message predicate ──────────────────────────────────────────

describe('isLongContextCreditsRefusalMessage (official SHr @250065765)', () => {
  test('recognizes an API-error assistant message with refusal errorDetails', () => {
    expect(rc.isLongContextCreditsRefusalMessage(refusalMessage(REFUSAL_EXTRA_USAGE))).toBe(true)
  })

  test('rejects without errorDetails provenance', () => {
    expect(rc.isLongContextCreditsRefusalMessage(refusalMessage())).toBe(false)
  })

  test('rejects non-assistant and non-API-error messages', () => {
    const user = createUserMessage({ content: REFUSAL_EXTRA_USAGE }) as Message
    expect(rc.isLongContextCreditsRefusalMessage(user)).toBe(false)
    const plain = {
      ...refusalMessage(REFUSAL_EXTRA_USAGE),
      isApiErrorMessage: false,
    } as Message
    expect(rc.isLongContextCreditsRefusalMessage(plain)).toBe(false)
  })

  test('rejects unrelated errorDetails', () => {
    expect(rc.isLongContextCreditsRefusalMessage(refusalMessage('Prompt is too long'))).toBe(false)
  })
})

// ── bd: withhold detector ────────────────────────────────────────────────────

describe('shouldWithholdLongContextCreditsRefusal (official bd @257405921)', () => {
  const detect = (
    overrides: Partial<{
      message: Message
      contextWindow: number
      querySource: string
    }> = {},
  ) =>
    rc.shouldWithholdLongContextCreditsRefusal({
      message: overrides.message ?? refusalMessage(REFUSAL_EXTRA_USAGE),
      contextWindow: overrides.contextWindow ?? 200000,
      querySource: overrides.querySource ?? 'repl_main_thread',
    })

  test('withholds at the standard 200000-token window and latches the clamp', () => {
    expect(rc.isLongContext1mCreditsBlocked()).toBe(false)
    expect(detect()).toBe(true)
    // ≡ Ods(!0) @250042112 — first detection clamps the account latch.
    expect(rc.isLongContext1mCreditsBlocked()).toBe(true)
  })

  test('does NOT withhold when the context window exceeds g6=200000', () => {
    expect(detect({ contextWindow: 200001 })).toBe(false)
    expect(detect({ contextWindow: 1000000 })).toBe(false)
  })

  test('does NOT withhold for excluded query sources (Qjt/G2e)', () => {
    expect(detect({ querySource: 'compact' })).toBe(false)
    expect(detect({ querySource: 'prompt_suggestion' })).toBe(false)
    expect(detect({ querySource: 'away_summary' })).toBe(false)
    expect(detect({ querySource: 'agent_summary' })).toBe(false)
    expect(detect({ querySource: 'hook_prompt' })).toBe(false)
  })

  test('does NOT withhold when auto-compact is disabled (of())', () => {
    process.env.DISABLE_AUTO_COMPACT = '1'
    expect(detect()).toBe(false)
  })

  test('does NOT withhold on a remote session without the remote gate (T$())', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    // tengu_reactive_compact_remote defaults false in the official binary.
    expect(detect()).toBe(false)
  })

  test('does NOT withhold non-refusal messages', () => {
    expect(detect({ message: refusalMessage() })).toBe(false)
    expect(
      detect({
        message: createUserMessage({ content: 'hi' }) as Message,
      }),
    ).toBe(false)
  })
})

// ── Gq/Tyt: round-group counting ────────────────────────────────────────────

describe('countCompactRoundGroups (official Gq @250532078 / aWs ≡ groups<2)', () => {
  const assistant = (id: string) =>
    ({ type: 'assistant', message: { id } }) as Message
  const user = () => ({ type: 'user' }) as Message
  const progress = () => ({ type: 'progress' }) as Message

  test('counts API-round groups by assistant message id boundaries', () => {
    expect(rc.countCompactRoundGroups([])).toBe(0)
    expect(rc.countCompactRoundGroups([user()])).toBe(1)
    expect(rc.countCompactRoundGroups([user(), assistant('m1')])).toBe(1)
    expect(
      rc.countCompactRoundGroups([user(), assistant('m1'), user(), assistant('m2')]),
    ).toBe(2)
    // Same message id streamed twice stays one group.
    expect(
      rc.countCompactRoundGroups([user(), assistant('m1'), assistant('m1')]),
    ).toBe(1)
    // Progress messages are filtered before grouping (Tyt).
    expect(
      rc.countCompactRoundGroups([user(), progress(), assistant('m1'), progress()]),
    ).toBe(1)
  })
})

// ── Outcome classifiers ─────────────────────────────────────────────────────

describe('compact-after-refusal outcome classifiers (official @257505460+)', () => {
  test('precheck: rapid_refill_breaker trips at 3 consecutive rapid refills', () => {
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: false,
        aborted: false,
        consecutiveRapidRefills: 3,
        roundGroups: 5,
      }),
    ).toBe('rapid_refill_breaker')
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: false,
        aborted: false,
        consecutiveRapidRefills: 2,
        roundGroups: 5,
      }),
    ).toBeUndefined()
    // hasAttempted short-circuits the breaker (official `!Zo` guard).
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: true,
        aborted: false,
        consecutiveRapidRefills: 3,
        roundGroups: 5,
      }),
    ).toBeUndefined()
  })

  test('precheck: aborted wins over too_few_groups', () => {
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: false,
        aborted: true,
        consecutiveRapidRefills: 0,
        roundGroups: 0,
      }),
    ).toBe('aborted')
  })

  test('precheck: too_few_groups below 2 round groups (aWs)', () => {
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: false,
        aborted: false,
        consecutiveRapidRefills: 0,
        roundGroups: 1,
      }),
    ).toBe('too_few_groups')
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: false,
        aborted: false,
        consecutiveRapidRefills: 0,
        roundGroups: 2,
      }),
    ).toBeUndefined()
    // hasAttempted skips the group check (official aYn gate inside the branch).
    expect(
      rc.classifyCompactRefusalPrecheck({
        hasAttempted: true,
        aborted: false,
        consecutiveRapidRefills: 0,
        roundGroups: 0,
      }),
    ).toBeUndefined()
  })

  test('failure: aborted → still_refused (attempted) → not_compacted', () => {
    expect(
      rc.classifyCompactRefusalFailure({ aborted: true, hasAttempted: false }),
    ).toBe('aborted')
    expect(
      rc.classifyCompactRefusalFailure({ aborted: false, hasAttempted: true }),
    ).toBe('still_refused')
    expect(
      rc.classifyCompactRefusalFailure({ aborted: false, hasAttempted: false }),
    ).toBe('not_compacted')
  })
})

// ── tryCompactAfterLongContextRefusal (injected compact fake) ───────────────

describe('tryCompactAfterLongContextRefusal', () => {
  const roundTrippedMessages = () => [
    createUserMessage({ content: 'q1' }) as Message,
    { type: 'assistant', message: { id: 'm1' } } as Message,
    createUserMessage({ content: 'q2' }) as Message,
    { type: 'assistant', message: { id: 'm2' } } as Message,
  ]

  function baseParams(overrides: Record<string, unknown> = {}) {
    return {
      hasAttempted: false,
      querySource: 'repl_main_thread',
      aborted: false,
      consecutiveRapidRefills: 0,
      messages: roundTrippedMessages(),
      cacheSafeParams: fakeCacheSafeParams(),
      ...overrides,
    } as Parameters<typeof rc.tryCompactAfterLongContextRefusal>[0]
  }

  test('delegates to compaction with the official argument tuple', async () => {
    const calls: unknown[][] = []
    const fakeResult = { boundaryMarker: 'B' } as never
    const attempt = await rc.tryCompactAfterLongContextRefusal(baseParams(), {
      compact: async (...args: unknown[]) => {
        calls.push(args)
        return fakeResult
      },
    })
    expect(attempt).toEqual({ kind: 'compacted', result: fakeResult })
    expect(calls.length).toBe(1)
    const args = calls[0]!
    // (messages, context, cacheSafeParams, suppressFollowUpQuestions=true,
    //  customInstructions=undefined, isAutoCompact=true,
    //  recompactionInfo=undefined, thresholdSource=undefined→reactive kind)
    expect(args[3]).toBe(true)
    expect(args[4]).toBeUndefined()
    expect(args[5]).toBe(true)
    expect(args[6]).toBeUndefined()
    expect(args[7]).toBeUndefined()
  })

  test('second refusal (hasAttempted) → still_refused without compacting', async () => {
    let called = 0
    const attempt = await rc.tryCompactAfterLongContextRefusal(
      baseParams({ hasAttempted: true }),
      {
        compact: async () => {
          called++
          return {} as never
        },
      },
    )
    expect(called).toBe(0)
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'still_refused' })
  })

  test('aborted up front → aborted without compacting', async () => {
    let called = 0
    const attempt = await rc.tryCompactAfterLongContextRefusal(
      baseParams({ aborted: true }),
      {
        compact: async () => {
          called++
          return {} as never
        },
      },
    )
    expect(called).toBe(0)
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'aborted' })
  })

  test('too few round groups → too_few_groups without compacting', async () => {
    let called = 0
    const attempt = await rc.tryCompactAfterLongContextRefusal(
      baseParams({ messages: [createUserMessage({ content: 'only' }) as Message] }),
      {
        compact: async () => {
          called++
          return {} as never
        },
      },
    )
    expect(called).toBe(0)
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'too_few_groups' })
  })

  test('compaction throw → not_compacted', async () => {
    const attempt = await rc.tryCompactAfterLongContextRefusal(baseParams(), {
      compact: async () => {
        throw new Error('Failed to generate conversation summary')
      },
    })
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'not_compacted' })
  })

  test('compaction abort → aborted', async () => {
    const { APIUserAbortError } = await import('@anthropic-ai/sdk')
    const attempt = await rc.tryCompactAfterLongContextRefusal(baseParams(), {
      compact: async () => {
        throw new APIUserAbortError()
      },
    })
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'aborted' })
  })

  test('compact query source → not_compacted without compacting (Qjt)', async () => {
    let called = 0
    const attempt = await rc.tryCompactAfterLongContextRefusal(
      baseParams({ querySource: 'compact' }),
      {
        compact: async () => {
          called++
          return {} as never
        },
      },
    )
    expect(called).toBe(0)
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'not_compacted' })
  })

  test('auto-compact disabled → not_compacted without compacting', async () => {
    process.env.DISABLE_AUTO_COMPACT = '1'
    let called = 0
    const attempt = await rc.tryCompactAfterLongContextRefusal(baseParams(), {
      compact: async () => {
        called++
        return {} as never
      },
    })
    expect(called).toBe(0)
    expect(attempt).toEqual({ kind: 'skipped', outcome: 'not_compacted' })
  })
})
