import { afterAll, describe, expect, mock, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.314 item 61 — "Fixed sessions staying untitled when the first
 * prompt failed (for example on a usage limit) and the conversation
 * continued afterward."
 *
 * Official mechanism (byte-verified, v314 linux-x64):
 *  - `nin(text,signal,credentials)` @261924458 (requestSessionTitle):
 *    `let n=e.trim(); if(!_(n))return{kind:"unusable"};` (S=10 min length)
 *    then C(...) → `return a("tengu_session_title_generated",{success:l!==null,
 *    input_capped:s!==n,input_over_cap:n.length>wfn}), l===null?{kind:"unusable"}
 *    :{kind:"titled",title:l}` ; catch → `t(`requestSessionTitle failed: ${l}`,
 *    {level:"error"}), a(...{success:!1,...}), {kind:"failed"}`.
 *  - `C(...)` @261920xxx: after the model call,
 *    `if(d.isApiErrorMessage&&!B3(d))throw Error("Session title request
 *    failed with an API error")` — then json_schema parse
 *    `f.success?f.data.title.trim()||null:null`.
 *  - `B3(e)` @246467524: `if(!e.isApiErrorMessage)return!1; let
 *    t=e.message.content; if(!Array.isArray(t))return!1; return
 *    t.some((r)=>r.type==="text"&&r.text.startsWith(YN))` with
 *    `YN="Prompt is too long"`.
 *  - `Uht(e,c,r)` @261925003: `let n=await nin(e,c,r); return
 *    n.kind==="titled"?n.title:null` — the generateSessionTitle wrapper.
 *  - wfn=2000 input cap (b1r) is gated behind `w()`=tengu_lucky_brooks
 *    (Statsig, default off, catch→false @255029272) — with the flag off the
 *    official never caps, so `input_capped` is always false; only the
 *    `input_over_cap` event field observes the 2000 threshold.
 */

// --- Mock seam (OCC-97 pattern: materialize the real claude.js exports,
// override queryHaiku narrowly, restore in afterAll). ---
const actualClaudeModule = await import('../../services/api/claude.js')
const actualClaudeExports = { ...actualClaudeModule }

type HaikuCall = { userPrompt: string }
const haikuCalls: HaikuCall[] = []
let haikuBehavior: (call: HaikuCall) => Promise<unknown> = async () => {
  throw new Error('test: no haiku behavior configured')
}

mock.module('../../services/api/claude.js', () => ({
  ...actualClaudeExports,
  queryHaiku: async (args: { userPrompt: string }): Promise<unknown> => {
    const call: HaikuCall = { userPrompt: args.userPrompt }
    haikuCalls.push(call)
    return haikuBehavior(call)
  },
}))

afterAll(() => {
  mock.module('../../services/api/claude.js', () => ({ ...actualClaudeExports }))
})

const {
  generateSessionTitle,
  isPromptTooLongApiError,
  requestSessionTitle,
} = await import('../sessionTitle.js')

function assistantWithText(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid: 'a-1',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku',
      content: [{ type: 'text', text }],
      usage: {},
    },
    costUSD: 0,
    durationMs: 1,
    isApiErrorMessage: false,
    ...extra,
  }
}

const signal = new AbortController().signal

describe('2.1.314 item 61 requestSessionTitle (official nin)', () => {
  test('parses the title JSON → {kind:"titled"} with the title trimmed', async () => {
    haikuBehavior = async () => assistantWithText('{"title": "  Fix login flow  "}')
    const result = await requestSessionTitle('please fix the login bug', signal)
    expect(result).toEqual({ kind: 'titled', title: 'Fix login flow' })
  })

  test('input shorter than the 10-char minimum → {kind:"unusable"} WITHOUT a model call (official !_(n) early return)', async () => {
    haikuCalls.length = 0
    haikuBehavior = async () => {
      throw new Error('must not be called')
    }
    expect(await requestSessionTitle('short', signal)).toEqual({ kind: 'unusable' })
    expect(await requestSessionTitle('123456789', signal)).toEqual({ kind: 'unusable' })
    expect(haikuCalls.length).toBe(0)
    // Exactly 10 trimmed chars is enough (official S=10, >=).
    haikuBehavior = async () => assistantWithText('{"title":"Ok title"}')
    expect(await requestSessionTitle('1234567890', signal)).toEqual({
      kind: 'titled',
      title: 'Ok title',
    })
  })

  test('unparseable model output → {kind:"unusable"} (official l===null branch)', async () => {
    haikuBehavior = async () => assistantWithText('not json at all')
    expect(await requestSessionTitle('a sufficiently long prompt', signal)).toEqual({
      kind: 'unusable',
    })
  })

  test('empty title after trim → {kind:"unusable"} (official `f.data.title.trim()||null`)', async () => {
    haikuBehavior = async () => assistantWithText('{"title": "   "}')
    expect(await requestSessionTitle('a sufficiently long prompt', signal)).toEqual({
      kind: 'unusable',
    })
  })

  test('API error result → {kind:"failed"} (official C throw "Session title request failed with an API error")', async () => {
    haikuBehavior = async () =>
      assistantWithText('API Error: 529 Overloaded', { isApiErrorMessage: true })
    expect(await requestSessionTitle('a sufficiently long prompt', signal)).toEqual({
      kind: 'failed',
    })
  })

  test('"Prompt is too long" API error does NOT throw → parsed (fails) → {kind:"unusable"} (official B3 exemption)', async () => {
    haikuBehavior = async () =>
      assistantWithText('Prompt is too long: 250k tokens > 200k maximum', {
        isApiErrorMessage: true,
      })
    expect(await requestSessionTitle('a sufficiently long prompt', signal)).toEqual({
      kind: 'unusable',
    })
  })

  test('queryHaiku rejection → {kind:"failed"} (official catch branch)', async () => {
    haikuBehavior = async () => {
      throw new Error('network unreachable')
    }
    expect(await requestSessionTitle('a sufficiently long prompt', signal)).toEqual({
      kind: 'failed',
    })
  })
})

describe('2.1.314 item 61 generateSessionTitle (official Uht wrapper)', () => {
  test('titled → title string', async () => {
    haikuBehavior = async () => assistantWithText('{"title":"Refactor auth client"}')
    expect(await generateSessionTitle('refactor the auth client please', signal)).toBe(
      'Refactor auth client',
    )
  })

  test('failed / unusable / too-short → null (official `n.kind==="titled"?n.title:null`)', async () => {
    haikuBehavior = async () => {
      throw new Error('boom')
    }
    expect(await generateSessionTitle('a sufficiently long prompt', signal)).toBeNull()
    expect(await generateSessionTitle('tiny', signal)).toBeNull()
  })
})

describe('2.1.314 isPromptTooLongApiError (official B3)', () => {
  test('non-API-error message → false', () => {
    expect(isPromptTooLongApiError(assistantWithText('Prompt is too long') as never)).toBe(false)
  })

  test('API error whose text starts with "Prompt is too long" → true', () => {
    expect(
      isPromptTooLongApiError(
        assistantWithText('Prompt is too long: 250k tokens', {
          isApiErrorMessage: true,
        }) as never,
      ),
    ).toBe(true)
  })

  test('API error with other text → false', () => {
    expect(
      isPromptTooLongApiError(
        assistantWithText('API Error: 400 invalid', { isApiErrorMessage: true }) as never,
      ),
    ).toBe(false)
  })

  test('API error with non-array content → false (official `if(!Array.isArray(t))return!1`)', () => {
    expect(
      isPromptTooLongApiError({
        isApiErrorMessage: true,
        message: { content: 'Prompt is too long' },
      } as never),
    ).toBe(false)
  })
})
