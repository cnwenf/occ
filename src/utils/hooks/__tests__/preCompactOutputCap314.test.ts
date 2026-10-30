import { describe, expect, test } from 'bun:test'

// MACRO.VERSION polyfill — mirrors repo convention for test execution (some
// transitive imports of hooks.ts read the build-time constant).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  PRECOMPACT_HOOK_OUTPUT_CHAR_LIMIT,
  cutPreCompactHookOutput,
} from '../../hooks.js'

/**
 * claude-code 2.1.314 item 22 (WP-B cluster):
 *   "Fixed a PreCompact hook with very large output making compaction fail or
 *    repeat; each hook's output is now cut at 10,000 characters."
 *
 * Byte-verified against the official v314 linux-x64 binary. The PreCompact
 * aggregation `v0e` (v314 ELF @256502723) gained, per successful hook output
 * `Se` (already `.trim()`ed):
 *
 *   if(Se.length>WPt)
 *     t(`PreCompact [${ke.command}] output cut from ${Se.length} to ${WPt} characters`,{level:"warn"}),
 *     Se=`${ne(Se,WPt)}\n\n[PreCompact hook [${ke.command}] output cut: ${Se.length} characters is over the ${WPt}-character limit]`;
 *
 * where `WPt=1e4` (v314 ELF @245625586: `...,WPt=1e4,sxn=1e4,p9t=1e5;`) and
 * `ne` (v314 ELF @243461814) is the shared surrogate-aware head slicer:
 *
 *   function ne(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(0,n),
 *     r=e.charCodeAt(n-1);return hQt(r>=55296&&r<=56319?e.slice(0,-1):e)}
 *
 * v312's PreCompact aggregation `UHe` (v312 ELF @251795705) has NO such cut —
 * it maps every successful output verbatim into newCustomInstructions, which is
 * what made a very large hook output blow up compaction. `ne` itself already
 * existed in v312 (@238757944) as a generic helper; the NEW v314 behavior is
 * its use inside PreCompact.
 *
 * OCC already carries a byte-identical port of `ne`/`hQt` as `re`/`f` in
 * src/utils/secretRedaction/textSlicing.ts, so `cutPreCompactHookOutput`
 * reuses it (DRY + byte-faithful).
 */

const LIMIT = PRECOMPACT_HOOK_OUTPUT_CHAR_LIMIT

function note(command: string, originalLength: number): string {
  return `[PreCompact hook [${command}] output cut: ${originalLength} characters is over the ${LIMIT}-character limit]`
}

describe('2.1.314 item 22 — PreCompact hook output char limit constant', () => {
  test('the cap is 10,000 characters (official WPt=1e4)', () => {
    expect(LIMIT).toBe(10_000)
  })
})

describe('2.1.314 item 22 — cutPreCompactHookOutput', () => {
  test('returns a short output unchanged (below the cap)', () => {
    const out = 'keep compaction focused on the auth module'
    expect(cutPreCompactHookOutput('my-hook', out)).toBe(out)
  })

  test('returns an output of exactly the cap length unchanged (boundary: length > WPt is false)', () => {
    const out = 'a'.repeat(LIMIT)
    expect(out.length).toBe(LIMIT)
    expect(cutPreCompactHookOutput('my-hook', out)).toBe(out)
  })

  test('returns an empty string unchanged', () => {
    expect(cutPreCompactHookOutput('my-hook', '')).toBe('')
  })

  test('cuts an over-cap output to the cap + the official note', () => {
    const out = 'a'.repeat(15_000)
    const cut = cutPreCompactHookOutput('summarize.sh', out)
    expect(cut).toBe(`${'a'.repeat(LIMIT)}\n\n${note('summarize.sh', 15_000)}`)
  })

  test('one char over the cap still cuts and reports the ORIGINAL length in the note', () => {
    const out = 'b'.repeat(LIMIT + 1)
    const cut = cutPreCompactHookOutput('h', out)
    // Body is the first LIMIT chars; note cites the pre-cut length (LIMIT + 1).
    expect(cut.startsWith('b'.repeat(LIMIT))).toBe(true)
    expect(cut).toContain(`output cut: ${LIMIT + 1} characters is over the ${LIMIT}-character limit`)
    expect(cut.endsWith(note('h', LIMIT + 1))).toBe(true)
  })

  test('the note embeds the hook command verbatim', () => {
    const out = 'x'.repeat(LIMIT + 500)
    const cut = cutPreCompactHookOutput('scripts/pre-compact.sh', out)
    expect(cut).toContain('[PreCompact hook [scripts/pre-compact.sh] output cut:')
  })

  test('does not split a surrogate pair straddling the cap (official ne high-surrogate drop)', () => {
    // Place a high surrogate at index LIMIT-1 so ne()'s charCodeAt(n-1) check
    // fires and drops the dangling high surrogate (body becomes LIMIT-1 chars).
    // '😀' is U+1F600 = D83D (high) + DE00 (low).
    const out = 'a'.repeat(LIMIT - 1) + '😀' + 'z'.repeat(10)
    expect(out.charCodeAt(LIMIT - 1)).toBe(0xd83d) // high surrogate at the boundary
    const cut = cutPreCompactHookOutput('emoji-hook', out)
    const body = cut.split('\n\n[PreCompact hook')[0]
    // The lone high surrogate is dropped — body is LIMIT-1 'a's, no trailing
    // unpaired surrogate, and the low surrogate 'z'-tail never leaks in.
    expect(body).toBe('a'.repeat(LIMIT - 1))
    expect(body.charCodeAt(body.length - 1)).toBe(0x61) // 'a', not a surrogate
    expect(cut.endsWith(note('emoji-hook', out.length))).toBe(true)
  })
})
