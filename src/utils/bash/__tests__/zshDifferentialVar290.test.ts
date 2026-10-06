import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../ast.js'
import { getParserModule } from '../bashParser.js'

/**
 * Gap-research-291 Cluster A #2 — zsh/bash variable-name differential → ask.
 *
 * Official 2.1.290 mechanism (byte-verified — see
 * docs/gap-research-291/verify-290-snippets-report.md and
 * docs/gap-research-291/cluster-a-bash-permissions.md #2):
 *   - `We` @206280333: /^\$[#^=~+]*[\w\u0080-\uffff]+$/.test(e) &&
 *     /[\u0080-\uffff]/.test(e) — a whole token `$` + zero-or-more zsh
 *     expansion-flag chars (#^=~+) + a name, containing a NON-ASCII char.
 *   - `Ue` @206279914: `$#` + name + immediately `[` (subscript) or
 *     `:letter/&` (history modifier), name containing NON-ASCII.
 *   - Reason authoring happens in `b(e)` @206342289 (the per-node too-complex
 *     builder): for an offending token the reason is official-verbatim
 *     "A $ followed by non-ASCII text in this command can't be checked
 *     before it runs". (`Be`/`Ue` @206279674 only escalate `nodeType` to
 *     ERROR, inheriting that reason.)
 *   - The [\u0080-\uffff] classes are LITERAL backslash-u escapes in the
 *     binary's JS source (forensically confirmed), not raw codepoints.
 *
 * Why: bash variable names are ASCII-only. `$=vaer` (a-umlaut) is an inert
 * literal in bash but zsh applies expansion flags (`$=var` word-splits,
 * `$~var` globs, `$^var` rc-expands, `$+var` exists-tests) — so under the
 * user's zsh login shell the token can word-split / glob extra argv past a
 * `Bash(cat:*)`-style permission rule. Static analysis can't reconcile the two
 * readings → ask.
 *
 * The NON-ASCII restriction is load-bearing: pure-ASCII `$=var` is NOT
 * escalated by official (`We` requires a non-ASCII char). These pins assert
 * OCC does not over-tighten beyond official.
 *
 * NOTE (empirical): OCC's LIVE permission surface already asks on every token
 * below (path-validation "Shell expansion syntax" gate + mid-word `#` gate +
 * the blanket `$` rejection in isCommandSafeViaFlagParsing). This file pins the
 * DORMANT AST path (parseForSecurityFromAst, live once TREE_SITTER_BASH is
 * enabled) so that path independently reaches official parity — same decision
 * (too-complex → ask) AND the official reason string — rather than relying on
 * the generic `$`-node fallback.
 *
 * Encoding note: the invisible / combining non-ASCII operands below (U+0080,
 * U+030A) and the regex-class bounds (U+0080, U+FFFF) are written as explicit
 * \uXXXX escapes so no invisible control or combining char sits in the raw
 * source bytes (formatter- and editor-safe). The visible operand æ (U+00E6)
 * is a stable printable char and is left literal for readability.
 */

// Official-verbatim reason (byte-verified @206342406). Deviates from the gap
// doc's point-3 suggestion of an OCC-specific string: forensics found the real
// upstream string, and aligning-with-official-binary mandates matching it.
const ZSH_DIFFERENTIAL_REASON =
  "A $ followed by non-ASCII text in this command can't be checked before it runs"

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

// --- 290 NEW: non-ASCII zsh differential variable forms → too-complex (ask) ---
describe('2.1.290 #2: non-ASCII zsh differential var tokens escalate (too-complex)', () => {
  test.each([
    ['cat $=vær', 'word-split flag $='],
    ['cat $~vær', 'glob flag $~'],
    ['cat $^vær', 'rc-expand flag $^'],
    ['cat $+vær', 'exists-test flag $+'],
  ])('%s → too-complex (%s)', (cmd, _label) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: ZSH_DIFFERENTIAL_REASON,
    })
  })

  test.each([
    ['cat $#vær[1]', 'subscript $#name[1]'],
    ['cat $#vær:h', 'history modifier $#name:h'],
  ])('%s → too-complex (%s)', (cmd, _label) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: ZSH_DIFFERENTIAL_REASON,
    })
  })

  test('non-ASCII at the U+0080 class boundary still escalates', () => {
    // U+0080 is the low bound of the official [\u0080-\uffff] class. It is a
    // C1 control, so it is NOT caught by CONTROL_CHAR_RE ([\x00-\x08\x0B-\x1F
    // \x7F], ASCII-only) nor UNICODE_WHITESPACE_RE — it reaches the walker.
    const r = parseSecurity('cat $=v\u0080r')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: ZSH_DIFFERENTIAL_REASON,
    })
  })

  test('combining-character name still escalates (a + U+030A ring)', () => {
    // Decomposed a-ring = `a` + U+030A combining ring; U+030A is in
    // [\u0080-\uffff], so the name carries a non-ASCII char.
    const r = parseSecurity('cat $=va\u030ar')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: ZSH_DIFFERENTIAL_REASON,
    })
  })
})

// --- non-ASCII restriction: pure-ASCII forms must NOT get the #2 reason ---
describe('2.1.290 #2: pure-ASCII forms do not over-tighten (non-ASCII restriction preserved)', () => {
  test('cat $=var (ASCII) is NOT given the non-ASCII differential reason', () => {
    // Official `We` requires a non-ASCII char, so `$=var` never escalates via
    // this mechanism. OCC's AST path still reaches too-complex through the
    // pre-existing generic `$`-node fallback — but MUST NOT claim the #2 reason.
    const r = parseSecurity('cat $=var')
    if (r.kind === 'too-complex') {
      expect(r.reason).not.toBe(ZSH_DIFFERENTIAL_REASON)
    }
  })

  test('cat $#var[1] (ASCII) is NOT given the non-ASCII differential reason', () => {
    const r = parseSecurity('cat $#var[1]')
    if (r.kind === 'too-complex') {
      expect(r.reason).not.toBe(ZSH_DIFFERENTIAL_REASON)
    }
  })
})

// --- quoted / tracked-var forms must NOT be escalated by the bare-token rule ---
describe('2.1.290 #2: quoted and tracked-variable forms are unaffected', () => {
  test('cat "$=vaer" (double-quoted) parses as a string → simple (no bare-token escalation)', () => {
    // Official `We` matches the WHOLE token ^\$…$; inside quotes tree-sitter
    // yields a `string` node, not a bare word/concatenation, so it is literal.
    const r = parseSecurity('cat "$=vær"')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['cat', '$=vær'])
    }
  })

  test('VAR=x; cat $VAR regression: tracked var still resolves via varScope', () => {
    const r = parseSecurity('VAR=x; cat $VAR')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['cat', 'x'])
    }
  })

  test('[[ $=vaer == x ]] regression: existing test-expr guard still escalates', () => {
    // The 2.1.221 `[[ ]]` operand guard (ast.ts zsh $name[expr]/$name:mod) must
    // keep firing; #2 does not relax it.
    const r = parseSecurity('[[ $=vær == x ]]')
    expect(r.kind).toBe('too-complex')
  })
})
