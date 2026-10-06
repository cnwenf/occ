import { describe, expect, test } from 'bun:test'
import { isCommandSafeViaFlagParsing } from '../readOnlyValidation'

/**
 * Gap-research-291 Cluster A #3 — "更多 ps 形式要求审批" (official 2.1.290).
 *
 * Byte-verified against the official 2.1.290 linux-x64 ELF
 * (docs/gap-research-291/cluster-a-bash-permissions.md #3):
 *   - `ps` spec @213176201 gains `respectsDoubleDash:!1` and a NEW
 *     four-condition `additionalCommandIsDangerousCallback`, replacing the
 *     289-era `/^[a-zA-Z]*e[a-zA-Z]*$/` bare-token check (@209985176).
 *   - helper `Cze` @206581431: `e.startsWith("-")&&e.length>1&&rf.test(e)`
 *     with `rf=/^-[a-zA-Z0-9_-]/`.
 *
 * Official 290 callback (verbatim), with `e`=command name, `n`=argv rest:
 *   let r=n.some(S=>!Cze(S)&&/[eE]/.test(S)),
 *       s=n.some(S=>/^-[a-zA-Z]*e/.test(S)),
 *       g=n.every(S=>S==="--forest"||/^-[AacdeFfjlwHLTm]+$/.test(S)),
 *       h=n.flatMap(S=>S==="--forest"?[S]:S.match(/[HLTm]/g)??[]);
 *   return r||s&&!(g&&h.length<=1)
 *
 * Semantics:
 *   r — any token that is NOT a well-formed flag (`Cze` false) yet contains
 *       e/E is dangerous (289 only caught letter-only bare tokens, so it
 *       missed `foo1e`, `-Xe`, …).
 *   s — some `-[letters]*e` flag exists (`-e`, `-fe`, …).
 *   g — every token is `--forest` or a whitelisted `-[AacdeFfjlwHLTm]+`
 *       short-flag bundle.
 *   h — collects `--forest` plus every H/L/T/m character in the tokens.
 *   dangerous = r || (s && !(g && h.length<=1)) — an e-containing flag is
 *       only allowed when every token lands in the safe letter set AND at
 *       most one forest/thread flag is present.
 *   respectsDoubleDash:false — `ps -- …` no longer terminates option
 *       parsing (ps does not honor `--`), closing `ps -- -e …` smuggling.
 *
 * `isCommandSafeViaFlagParsing` returns true when the command is auto-allowed
 * as read-only, false when it must ask. Each 290 expectation below was
 * hand-evaluated against the official boolean (see the gap doc's table).
 */

// --- 290 NEW: tightened forms — must now ASK (were auto-allowed under 289) ---
describe('2.1.290 #3: ps forms that now require approval (ASK)', () => {
  test('ps -eHL → ASK (two thread/forest flags H,L → h.length=2 > 1)', () => {
    // r=false, s=true(-e), g=true(e,H,L whitelisted), h=[H,L] → 2>1 → dangerous
    expect(isCommandSafeViaFlagParsing('ps -eHL')).toBe(false)
  })

  test('ps -eT --forest → ASK (T + --forest → h.length=2 > 1)', () => {
    // r=false, s=true, g=true, h=[T,--forest] → 2>1 → dangerous
    expect(isCommandSafeViaFlagParsing('ps -eT --forest')).toBe(false)
  })

  test('ps foo1e → ASK (non-flag token containing e; 289 regex missed the digit)', () => {
    // Cze("foo1e")=false, /[eE]/ true → r=true → dangerous
    expect(isCommandSafeViaFlagParsing('ps foo1e')).toBe(false)
  })

  test('ps -- -e → ASK (respectsDoubleDash:false → `--` is not an option terminator)', () => {
    // args=['--','-e']: g=false ('--' not whitelisted) → s&&!(false&&…) → dangerous
    expect(isCommandSafeViaFlagParsing('ps -- -e')).toBe(false)
  })

  test('ps axe → ASK (bare BSD-style token containing e)', () => {
    // Cze("axe")=false, /[eE]/ true → r=true → dangerous
    expect(isCommandSafeViaFlagParsing('ps axe')).toBe(false)
  })

  test('ps -eHH → ASK (H twice → h.length=2 > 1)', () => {
    expect(isCommandSafeViaFlagParsing('ps -eHH')).toBe(false)
  })
})

// --- 290 still-safe forms — must remain AUTO-ALLOWED (regression guards) ---
describe('2.1.290 #3: ps forms that remain read-only safe (ALLOW)', () => {
  test('ps -e → ALLOW (s true, g true, h empty → 0≤1)', () => {
    expect(isCommandSafeViaFlagParsing('ps -e')).toBe(true)
  })

  test('ps -ef → ALLOW (e,f whitelisted, no H/L/T/m)', () => {
    expect(isCommandSafeViaFlagParsing('ps -ef')).toBe(true)
  })

  test('ps -eH → ALLOW (single forest/thread flag → h.length=1 ≤ 1)', () => {
    expect(isCommandSafeViaFlagParsing('ps -eH')).toBe(true)
  })

  test('ps -e --forest → ALLOW (--forest counts as the single h entry)', () => {
    expect(isCommandSafeViaFlagParsing('ps -e --forest')).toBe(true)
  })

  test('ps -a → ALLOW (no e → s false, r false)', () => {
    expect(isCommandSafeViaFlagParsing('ps -a')).toBe(true)
  })

  test('ps aux → ALLOW (bare token, no e/E)', () => {
    expect(isCommandSafeViaFlagParsing('ps aux')).toBe(true)
  })

  // NOTE: the gap doc's table lists `ps -ax` as a callback-level "allow"
  // (r=false, s=false). End-to-end it still ASKs because `-x` is NOT in the
  // ps safeFlags (byte-identical 289->290, unchanged by this port), so
  // validateFlags rejects the bundle before the callback runs. Pinned here to
  // document that the safeFlags gate — not the callback — decides this form.
  test('ps -ax → ASK (-x not in ps safeFlags; validateFlags rejects before callback)', () => {
    expect(isCommandSafeViaFlagParsing('ps -ax')).toBe(false)
  })

  test('ps -e -H → ALLOW (separate tokens, single H → h.length=1)', () => {
    expect(isCommandSafeViaFlagParsing('ps -e -H')).toBe(true)
  })

  test('ps --version → ALLOW (no e-flag; -V/--version safe)', () => {
    expect(isCommandSafeViaFlagParsing('ps --version')).toBe(true)
  })
})
