import { describe, expect, test } from 'bun:test'

// CC 2.1.290 (cluster-d Item 1 / D#1): the plan-mode structural gate on the
// auto-mode classifier's allow. Official 290 `_rn` (@213320210) only honors a
// classifier "allow" in plan mode when the tool call is STRUCTURALLY read-only;
// a non-read-only call must fall back to prompting (plan_mode_floor) even though
// the classifier said allow. `case"auto":return!0` — auto mode is unconditional.
//
// This mirrors the classifierAuthError.test.ts convention: cover the PURE
// load-bearing gate in isolation (no permissions.ts / SDK import graph). The
// call-site wiring (fallback -> ask with reason 'plan_mode_floor') is a 4-line
// guard verified by the permissions-suite regression.

const { shouldHonorClassifierAllow, PLAN_MODE_FLOOR_REASON } = await import(
  '../planModeClassifierGate.js'
)

const CTX = {} as never

/** Mock tool: `safeParse` succeeds/fails per parseOk; isReadOnly returns readOnly. */
function makeTool(opts: { parseOk?: boolean; readOnly?: boolean } = {}) {
  const { parseOk = true, readOnly = false } = opts
  return {
    inputSchema: {
      safeParse: (input: unknown) =>
        parseOk
          ? { success: true, data: input }
          : { success: false, error: new Error('parse failed') },
    },
    isReadOnly: (_input: unknown, _ctx?: unknown) => readOnly,
  } as never
}

describe('D#1 shouldHonorClassifierAllow — official `_rn` mode switch', () => {
  test('auto mode honors the classifier allow unconditionally (non-read-only)', () => {
    expect(
      shouldHonorClassifierAllow('auto', makeTool({ readOnly: false }), {}, CTX),
    ).toBe(true)
  })

  test('auto mode honors the classifier allow unconditionally (read-only)', () => {
    expect(
      shouldHonorClassifierAllow('auto', makeTool({ readOnly: true }), {}, CTX),
    ).toBe(true)
  })

  test('plan mode + read-only + parse ok -> honor allow', () => {
    expect(
      shouldHonorClassifierAllow('plan', makeTool({ readOnly: true }), {}, CTX),
    ).toBe(true)
  })

  test('plan mode + NON-read-only -> floor (do NOT honor allow)', () => {
    expect(
      shouldHonorClassifierAllow('plan', makeTool({ readOnly: false }), {}, CTX),
    ).toBe(false)
  })

  test('plan mode + parse failure -> floor (even if isReadOnly would be true)', () => {
    expect(
      shouldHonorClassifierAllow(
        'plan',
        makeTool({ parseOk: false, readOnly: true }),
        {},
        CTX,
      ),
    ).toBe(false)
  })

  test('plan mode threads the PARSED input + context into isReadOnly (2-param signature)', () => {
    const input = { file_path: '/repo/x.txt' }
    let seenInput: unknown
    let seenCtx: unknown
    const tool = {
      inputSchema: { safeParse: (i: unknown) => ({ success: true, data: i }) },
      isReadOnly: (i: unknown, ctx: unknown) => {
        seenInput = i
        seenCtx = ctx
        return true
      },
    } as never
    shouldHonorClassifierAllow('plan', tool, input, CTX)
    expect(seenInput).toBe(input)
    expect(seenCtx).toBe(CTX)
  })

  test('non-classifier modes honor allow unconditionally (landing only reached in auto/plan)', () => {
    for (const mode of [
      'default',
      'dontAsk',
      'acceptEdits',
      'bypassPermissions',
      'bubble',
    ] as const) {
      expect(
        shouldHonorClassifierAllow(mode, makeTool({ readOnly: false }), {}, CTX),
      ).toBe(true)
    }
  })

  test('PLAN_MODE_FLOOR_REASON is the official binary literal', () => {
    expect(PLAN_MODE_FLOOR_REASON).toBe('plan_mode_floor')
  })
})
