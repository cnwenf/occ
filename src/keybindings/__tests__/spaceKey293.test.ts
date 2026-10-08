import { describe, expect, test } from 'bun:test'
import { validateUserConfig } from '../validate.js'
import type { KeybindingWarning } from '../validate.js'

/**
 * CC 2.1.293 #34 — keybindings.json: a lone `" "` IS the space key (not an
 * empty part), and a space adjacent to `"+"` that splits off a keyless press is
 * its own parse_error. Official `Xe` @210180546 (report §34, verbatim):
 *
 *   n = e.trim()
 *   s = e === " " ? [] : n.split(/\s+/)
 *   c = e !== " " && e.split("+").some(P => !P.trim())
 *   g = /\s\+|\+\s/.test(n) && s.some(P => parseKeystroke(P).key === "")
 *   if (c || g) { let P = tc(e, I=80); return { type: "parse_error",
 *     severity: "error",
 *     message: c ? `Empty key part in "${P}"`
 *       : `A space next to "+" splits "${P}" into separate presses, and one of them has no key`,
 *     key: e, suggestion: c ? 'Remove extra "+" characters'
 *       : 'Remove the spaces next to "+"' } }
 *
 * `tc(t, 80)` truncates the display: `t.length <= 80 ? t
 * : `${t.slice(0,80)}… [+${t.length-80} chars]`` (surrogate-safe via `ne`).
 */

function parseWarningsFor(
  key: string,
  context = 'Chat',
): KeybindingWarning[] {
  return validateUserConfig([
    { context, bindings: { [key]: 'chat:submit' } },
  ]).filter(w => w.type === 'parse_error' && w.key === key)
}

describe('CC 2.1.293 #34 — a lone space is the space key', () => {
  test('a lone " " binding produces no parse error', () => {
    expect(parseWarningsFor(' ')).toEqual([])
  })
})

describe('CC 2.1.293 #34 — a space next to "+" warns', () => {
  test('ctrl+ k → the official space-next-to-plus message + suggestion', () => {
    const found = parseWarningsFor('ctrl+ k')
    expect(found.length).toBe(1)
    const w = found[0]!
    expect(w.severity).toBe('error')
    expect(w.message).toBe(
      'A space next to "+" splits "ctrl+ k" into separate presses, and one of them has no key',
    )
    expect(w.suggestion).toBe('Remove the spaces next to "+"')
  })

  test('ctrl +k (space before the plus) also warns', () => {
    const found = parseWarningsFor('ctrl +k')
    expect(found.length).toBe(1)
    expect(found[0]!.message).toBe(
      'A space next to "+" splits "ctrl +k" into separate presses, and one of them has no key',
    )
    expect(found[0]!.suggestion).toBe('Remove the spaces next to "+"')
  })

  test('ctrl+k (no space) is clean', () => {
    expect(parseWarningsFor('ctrl+k')).toEqual([])
  })

  test('multiple spaces around the plus still warn', () => {
    const found = parseWarningsFor('ctrl+  k')
    expect(found.length).toBe(1)
    expect(found[0]!.suggestion).toBe('Remove the spaces next to "+"')
  })

  test('a real chord (ctrl+x ctrl+s) is not falsely flagged', () => {
    expect(parseWarningsFor('ctrl+x ctrl+s')).toEqual([])
  })
})

describe('CC 2.1.293 #34 — 80-char keystroke truncation', () => {
  test('a keystroke longer than 80 chars is truncated with the official suffix', () => {
    const key = `${'a'.repeat(84)}+` // 85 chars; trailing "+" -> empty key part
    const found = parseWarningsFor(key)
    expect(found.length).toBe(1)
    expect(found[0]!.message).toBe(
      `Empty key part in "${'a'.repeat(80)}… [+5 chars]"`,
    )
  })

  test('a keystroke of exactly 80 chars is not truncated', () => {
    const key = `${'a'.repeat(79)}+` // 80 chars total
    const found = parseWarningsFor(key)
    expect(found.length).toBe(1)
    expect(found[0]!.message).toBe(`Empty key part in "${key}"`)
  })
})
