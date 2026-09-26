/**
 * CC 2.1.283 keybindings misspelled-modifier validation (OCC-138 / G2),
 * byte-verified against the official v2.1.283 linux-x64 ELF:
 *
 * - Validator `Me(e,r)` — extracted from the keybindings chunk
 *   (s283s.txt:137507 → /tmp/kb283.js). Replaces 282's `Se(e)`, which only
 *   checked empty key parts (s282s.txt:84899-region:
 *   `function Se(e){...Empty key part...return null}`).
 * - Fuzzy matcher `CJ(e,n,{maxEditDistance=1})` + Damerau-Levenshtein `_6`
 *   @ELF 196737282; dedupe `D(n)=[...new Set(n)]` @196094383.
 * - Modifier metadata @ELF keybindings chunk:
 *   `ce=[{name:"ctrl",aliases:["control"]},{name:"alt",aliases:["opt","option"]},
 *   {name:"shift"},{name:"meta"},{name:"cmd",aliases:["command","super","win"]}]`,
 *   `Ie=["ctrl","alt","shift","meta","super"]`.
 * - Guide delta: `Ys` Validation table (s283s.txt:300025) gains the
 *   `"X" is not a modifier...` row; the 282 table (s282s.txt:84899) has no
 *   such row. NEITHER official version ever emitted "Could not parse
 *   keystroke" — that OCC-invented branch was unreachable dead code and is
 *   removed by the port (pinned below).
 *
 * Message grammar (official, verbatim):
 *   `${quotedBadList} ${isNot|areNot} modifiers, so "${key}"${inContext}
 *    applies to "${chordToString(parseChord(key))}" instead`
 *   suggestion = every bad token fuzzy-matched
 *     ? `Did you mean "${rebuiltGroups.join(' ')}"?`
 *     : `Use ${disjunction of ce names} before "+"; for keys pressed one
 *        after another, put a space between them, as in "ctrl+x ctrl+s"`
 */
import { describe, expect, test } from 'bun:test'
import { validateBindings, validateUserConfig } from '../validate.js'
import type { KeybindingWarning } from '../validate.js'

function warningsFor(
  context: string,
  bindings: Record<string, string | null>,
): KeybindingWarning[] {
  return validateUserConfig([{ context, bindings }])
}

function parseWarningFor(key: string, context = 'Chat'): KeybindingWarning {
  const found = warningsFor(context, { [key]: 'chat:submit' }).filter(
    w => w.type === 'parse_error' && w.key === key,
  )
  expect(found.length).toBe(1)
  return found[0] as KeybindingWarning
}

describe('2.1.283 G2 — misspelled modifier warns with a suggestion', () => {
  test('ctl+k → error, "is not a modifier", Did-you-mean suggestion, context woven in', () => {
    const w = parseWarningFor('ctl+k')
    expect(w.severity).toBe('error')
    expect(w.message).toBe(
      '"ctl" is not a modifier, so "ctl+k" in Chat applies to "k" instead',
    )
    expect(w.suggestion).toBe('Did you mean "ctrl+k"?')
    expect(w.context).toBe('Chat')
  })

  test('other fuzzy typos within edit distance 1 suggest the right modifier', () => {
    // transposition (Damerau) + insertion
    expect(parseWarningFor('ctrol+k').suggestion).toBe('Did you mean "ctrl+k"?')
    expect(parseWarningFor('contrl+k').suggestion).toBe('Did you mean "control+k"?')
    expect(parseWarningFor('shft+k').suggestion).toBe('Did you mean "shift+k"?')
    expect(parseWarningFor('alr+k').suggestion).toBe('Did you mean "alt+k"?')
    // aliases fuzzy-match too; the rebuilt group pushes the matched
    // candidate string verbatim (alias form preserved).
    expect(parseWarningFor('comand+k').suggestion).toBe('Did you mean "command+k"?')
  })

  test('typo beyond edit distance 1 (cntl) falls back to the generic suggestion', () => {
    const w = parseWarningFor('cntl+k')
    expect(w.message).toBe(
      '"cntl" is not a modifier, so "cntl+k" in Chat applies to "k" instead',
    )
    expect(w.suggestion).toBe(
      'Use ctrl, alt, shift, meta, or cmd before "+"; for keys pressed one after another, put a space between them, as in "ctrl+x ctrl+s"',
    )
  })

  test('fuzzy match preserves the original token casing in the message', () => {
    const w = parseWarningFor('Ctrol+k')
    expect(w.message).toBe(
      '"Ctrol" is not a modifier, so "Ctrol+k" in Chat applies to "k" instead',
    )
    expect(w.suggestion).toBe('Did you mean "ctrl+k"?')
  })

  test('two keys joined with "+" and no fuzzy match → generic space-vs-plus suggestion', () => {
    const w = parseWarningFor('k+s')
    expect(w.severity).toBe('error')
    expect(w.message).toBe(
      '"k" is not a modifier, so "k+s" in Chat applies to "s" instead',
    )
    expect(w.suggestion).toBe(
      'Use ctrl, alt, shift, meta, or cmd before "+"; for keys pressed one after another, put a space between them, as in "ctrl+x ctrl+s"',
    )
  })

  test('multiple misplaced tokens → conjunction list + plural copula', () => {
    const w = parseWarningFor('ctl+shft+k')
    expect(w.message).toBe(
      '"ctl" and "shft" are not modifiers, so "ctl+shft+k" in Chat applies to "k" instead',
    )
    expect(w.suggestion).toBe('Did you mean "ctrl+shift+k"?')
  })

  test('mixed fuzzy/unmatched tokens fall back to the generic suggestion', () => {
    // "ctl" matches ctrl, "zz" matches nothing → allFuzzyMatched=false
    const w = parseWarningFor('ctl+zz+k')
    expect(w.message).toBe(
      '"ctl" and "zz" are not modifiers, so "ctl+zz+k" in Chat applies to "k" instead',
    )
    expect(w.suggestion).toBe(
      'Use ctrl, alt, shift, meta, or cmd before "+"; for keys pressed one after another, put a space between them, as in "ctrl+x ctrl+s"',
    )
  })

  test('misplaced token in a chord keystroke reports the full chord reparse', () => {
    const w = parseWarningFor('ctrl+x ctl+s', 'Global')
    expect(w.message).toBe(
      '"ctl" is not a modifier, so "ctrl+x ctl+s" in Global applies to "ctrl+x s" instead',
    )
    expect(w.suggestion).toBe('Did you mean "ctrl+x ctrl+s"?')
    expect(w.context).toBe('Global')
  })

  test('a modifier already set on the keystroke is not duplicated in the rebuild', () => {
    const w = parseWarningFor('ctrl+ctrol+k')
    expect(w.suggestion).toBe('Did you mean "ctrl+k"?')
  })

  test('duplicate misplaced tokens are deduped in the message', () => {
    // "ctl" appears in both chord keystrokes → single quoted entry, singular copula
    const w = parseWarningFor('ctl+x ctl+s')
    expect(w.message).toBe(
      '"ctl" is not a modifier, so "ctl+x ctl+s" in Chat applies to "x s" instead',
    )
    expect(w.suggestion).toBe('Did you mean "ctrl+x ctrl+s"?')
  })

  test('invalid context → message omits the " in X" suffix', () => {
    const all = warningsFor('chat', { 'ctl+k': 'chat:submit' })
    const parse = all.find(w => w.type === 'parse_error' && w.key === 'ctl+k')
    expect(parse).toBeDefined()
    expect(parse?.message).toBe(
      '"ctl" is not a modifier, so "ctl+k" applies to "k" instead',
    )
    // plus the separate invalid_context warning
    expect(all.some(w => w.type === 'invalid_context')).toBe(true)
  })
})

describe('2.1.283 G2 — valid bindings and pre-existing behavior unchanged', () => {
  test('valid modifier spellings and aliases produce no parse errors', () => {
    for (const key of [
      'ctrl+k',
      'control+k',
      'alt+k',
      'opt+k',
      'option+k',
      'shift+k',
      'meta+k',
      'cmd+k',
      'command+k',
      'super+k',
      'win+k',
      'ctrl+shift+k',
      'ctrl+x ctrl+s',
      'space',
      'escape',
      'esc',
      'enter',
      'return',
      'up',
      'k',
    ]) {
      const parseErrors = warningsFor('Chat', { [key]: 'chat:submit' }).filter(
        w => w.type === 'parse_error' && w.key === key,
      )
      expect(parseErrors).toEqual([])
    }
  })

  test('empty key part check is unchanged from 282 (fires before modifier scan)', () => {
    const w = parseWarningFor('ctrl++k')
    expect(w.message).toBe('Empty key part in "ctrl++k"')
    expect(w.suggestion).toBe('Remove extra "+" characters')
  })

  test('the OCC-invented "Could not parse keystroke" message is gone', () => {
    for (const key of ['+', '++', ' + ', 'ctrl+', 'ctl+k', 'k+s', 'zz']) {
      const all = warningsFor('Chat', { [key]: 'chat:submit' })
      for (const w of all) {
        expect(w.message).not.toContain('Could not parse keystroke')
      }
    }
  })

  test('validateBindings surfaces the modifier error through the full pipeline', () => {
    const warnings = validateBindings(
      [{ context: 'Chat', bindings: { 'ctl+k': 'chat:submit' } }],
      [],
    )
    const parse = warnings.find(
      w => w.type === 'parse_error' && w.key === 'ctl+k',
    )
    expect(parse).toBeDefined()
    expect(parse?.suggestion).toBe('Did you mean "ctrl+k"?')
  })
})
