import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * 2.1.223 P0 security fix: "Fixed a Bash permission bypass where a crafted
 * command could hide part of itself from permission checks."
 *
 * This round brings OCC's whole test_command integrity chain to 2.1.223
 * byte-parity with the official binary (part of the chain — gap walker,
 * early-close, zero-width token, test_rhs_missing, the default-case
 * `]]`+separator check, zsh `$name[expr]` — was already in the official
 * 2.1.221 binary but absent from the OCC-44 partial port; 2.1.223 adds the
 * pattern-leaf `&&` / standalone-`]]` checks). All reason strings are
 * byte-identical to the 2.1.223 binary.
 *
 * Layers covered here:
 *  1. checkTestCommandUnparsedBytes — gaps between/after children must be
 *     whitespace-only (inside `[[ ]]` also newlines/comments); children must
 *     not extend past the parent span.
 *  2. walkTestExpr default case — quoted operand `]]` closer / `]]`+separator
 *     desync check, reason branching on the bracket context.
 *  3. walkTestExpr regex/extglob leaves — `&&` and standalone-`]]` checks
 *     (reachable through the quoted-operand path and extglob patterns).
 *  4. Negative cases — benign conditionals stay `simple` (no new prompts).
 *
 * parseForSecurityFromAst is exercised directly (parseForSecurity's wrapper
 * is feature-flag gated; the pure-TS parser module needs no async init).
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.223: test_command unparsed-bytes gap walker', () => {
  test('swallowed `==` between children → unparsed bytes (fail closed)', () => {
    // tree-sitter drops the `==` operator entirely ([ abc, ] remain) — the
    // ` == ` gap is not whitespace-only, so the shell would see content the
    // permission check was never shown.
    const r = parseSecurity('[ abc == ]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'Test command has unparsed bytes between children — parser dropped content that shell will see',
      )
    }
  })

  test('swallowed `=~` between children → unparsed bytes (fail closed)', () => {
    const r = parseSecurity('[[ abc =~ ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'Test command has unparsed bytes between children — parser dropped content that shell will see',
      )
    }
  })

  test('child extending past the node span → untrustworthy accounting', () => {
    // Malformed unclosed paren: tree-sitter's ERROR recovery emits a child
    // past the test_command span. Official-ordered: the gap walker runs
    // before the expression walk, so this reason precedes any leaf reason.
    const r = parseSecurity('[[ abc =~ (a(b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'Test command child extends past the node span — gap byte accounting is untrustworthy',
      )
    }
  })
})

describe('2.1.223: quoted-operand `]]` desync checks (default case)', () => {
  test('quoted `]]`+separator in [[ ]] → quote-state desync reason', () => {
    const r = parseSecurity('[[ abc == "a]]&&id" ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] quoted operand contains `]]` closer or `]]`+separator bytes — possible parser quote-state desync',
      )
    }
  })

  test('quoted `]]` + `;` separator in [[ ]] → desync reason', () => {
    const r = parseSecurity('[[ abc == "a]];id" ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] quoted operand contains `]]` closer or `]]`+separator bytes — possible parser quote-state desync',
      )
    }
  })

  test('standalone quoted `]]` closer at operand end in [[ ]] → desync reason', () => {
    // cys(): `]]` at end of text has no following word char → potential
    // standalone closer (zsh may close the conditional early).
    const r = parseSecurity('[[ abc == "x]]" ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] quoted operand contains `]]` closer or `]]`+separator bytes — possible parser quote-state desync',
      )
    }
  })

  test('single-bracket [ ] gets the non-bracket reason variant', () => {
    // Reason strings branch on the bracket context, byte-identical to the
    // official binary.
    const r = parseSecurity('[ abc == "x]];y" ]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'test command quoted operand contains `]]`+separator bytes — possible parser quote-state desync',
      )
    }
  })

  test('quoted `]]` embedded in a word → allowed (not standalone)', () => {
    // cys(): word chars on both sides of `]]` → part of the pattern word,
    // not a conditional closer.
    const r = parseSecurity('[[ abc == "a]]b" ]]')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.223: benign conditionals stay simple (no new false positives)', () => {
  test('[[ -f foo ]] → simple', () => {
    expect(parseSecurity('[[ -f foo ]]').kind).toBe('simple')
  })

  test('[[ abc == def ]] → simple', () => {
    expect(parseSecurity('[[ abc == def ]]').kind).toBe('simple')
  })

  test('[[ -d /tmp && -f /etc/hosts ]] → simple (cond && cond)', () => {
    expect(parseSecurity('[[ -d /tmp && -f /etc/hosts ]]').kind).toBe('simple')
  })

  test('[ -f foo ] → simple (single bracket)', () => {
    expect(parseSecurity('[ -f foo ]').kind).toBe('simple')
  })

  test('[[ abc =~ foo ]] → simple', () => {
    expect(parseSecurity('[[ abc =~ foo ]]').kind).toBe('simple')
  })

  test('[[ abc =~ a|b ]] → simple (single | is regex alternation)', () => {
    expect(parseSecurity('[[ abc =~ a|b ]]').kind).toBe('simple')
  })

  test('[[ abc == !(a) ]] → simple (extglob negation)', () => {
    expect(parseSecurity('[[ abc == !(a) ]]').kind).toBe('simple')
  })

  test('[[ abc == a?c ]] → simple (glob ?)', () => {
    expect(parseSecurity('[[ abc == a?c ]]').kind).toBe('simple')
  })

  test('[[ abc == *(x) ]] → simple (extglob star)', () => {
    expect(parseSecurity('[[ abc == *(x) ]]').kind).toBe('simple')
  })

  test('[[ abc == def ]] && ls → both commands extracted, nothing hidden', () => {
    const r = parseSecurity('[[ abc == def ]] && ls')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands.map((c) => c.argv.join(' '))).toEqual([
        '[[ abc == def',
        'ls',
      ])
    }
  })

  test('[[ abc == a]]&&id ]] → splits at ]], smuggled command exposed as its own argv', () => {
    // tree-sitter closes the conditional at the first `]]`, so `id` is
    // extracted as a separate visible command — nothing hidden from the
    // permission rules. (zsh/bash both split here too; the hiding vector is
    // the quoted/leaf forms asserted above.)
    const r = parseSecurity('[[ abc == a]]&&id ]]')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      // The trailing `]]` is a plain word outside the conditional, so it
      // rides with `id` — the smuggled command is still argv[0] and visible
      // to permission rules.
      expect(r.commands.map((c) => c.argv.join(' '))).toEqual([
        '[[ abc == a',
        'id ]]',
      ])
    }
  })
})
