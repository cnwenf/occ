import { describe, expect, test } from 'bun:test'
import { isCommandSafeViaFlagParsing } from '../readOnlyValidation'

/**
 * M6 (Claude Code 2.1.214): `file` commands using `-m`/`--magic-file` or
 * `-f`/`--files-from` must require permission instead of being auto-allowed as
 * read-only. The fail-open path is the read-only auto-allow gate
 * (isCommandSafeViaFlagParsing) via the `file:` safeFlags list — so the fix
 * removes `-f`/`-m`/`--magic-file` from that list (clearing matchingRulesForInput
 * allow wouldn't catch it).
 *
 * Red-test per security reviewer:
 *  - file -f namefile / file -m magic / file --magic-file=x → must NOT be
 *    auto-allowed (ask). Before fix: auto-allowed (RED).
 *  - file --files-from=x → already NOT auto-allowed (regression guard, both
 *    before and after).
 *  - plain file x.txt / file -i x.txt / file -F: x.txt → still auto-allowed
 *    (regression guard; -F/--separator kept, not -f).
 */

describe('M6 (2.1.214): file -m/-f/--magic-file require permission', () => {
  test('file -f namefile → NOT auto-allowed (ask)', () => {
    expect(isCommandSafeViaFlagParsing('file -f namefile')).toBe(false)
  })
  test('file -m magic → NOT auto-allowed (ask)', () => {
    expect(isCommandSafeViaFlagParsing('file -m magic')).toBe(false)
  })
  test('file --magic-file=x → NOT auto-allowed (ask)', () => {
    expect(isCommandSafeViaFlagParsing('file --magic-file=x')).toBe(false)
  })
  test('file -f=namefile (equals form) → NOT auto-allowed (ask)', () => {
    expect(isCommandSafeViaFlagParsing('file -f=namefile')).toBe(false)
  })

  // Regression guards
  test('file --files-from=x → NOT auto-allowed (already asks, before+after)', () => {
    expect(isCommandSafeViaFlagParsing('file --files-from=x')).toBe(false)
  })
  test('plain file x.txt → still auto-allowed (no regression)', () => {
    expect(isCommandSafeViaFlagParsing('file x.txt')).toBe(true)
  })
  test('file -i x.txt → still auto-allowed (-i kept)', () => {
    expect(isCommandSafeViaFlagParsing('file -i x.txt')).toBe(true)
  })
  test('file -F : x.txt (space form) → still auto-allowed (-F separator kept, NOT -f)', () => {
    expect(isCommandSafeViaFlagParsing('file -F : x.txt')).toBe(true)
  })
  test('file --separator : x.txt (space form) → still auto-allowed (--separator kept)', () => {
    expect(isCommandSafeViaFlagParsing('file --separator : x.txt')).toBe(true)
  })
})
