import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * 2.1.221 security fix: Bash tool permission-check bypass where zsh could
 * execute hidden commands in `[[ ]]` regex conditionals. zsh splits `[[ ]]`
 * contents differently from bash/tree-sitter:
 *   - a glued `||` inside the RHS regex is re-split as the conditional OR
 *     operator (so `[[ x =~ a||malicious ]]` runs `malicious` in zsh)
 *   - an unquoted `&` splits the word at any depth
 * Official binary (2.1.221 test-expression RHS case "regex"/"extglob_pattern")
 * rejects these as too-complex so the command goes through the permission
 * prompt instead of being auto-approved from the extracted argv. Verbatim port.
 *
 * parseForSecurityFromAst is exercised directly (parseForSecurity's wrapper is
 * feature-flag gated; the pure-TS parser module needs no async init).
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.221: zsh [[ ]] regex conditional guards', () => {
  test('[[ abc =~ a||b ]] → too-complex (glued || at paren depth 0)', () => {
    const r = parseSecurity('[[ abc =~ a||b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex contains glued || (zsh splits it as a cond operator)',
      )
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ a&b ]] → too-complex (unquoted & in regex)', () => {
    const r = parseSecurity('[[ abc =~ a&b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex contains unquoted & (zsh splits the word at & at any depth)',
      )
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ a\\&b ]] → allowed (escaped & is inert)', () => {
    const r = parseSecurity('[[ abc =~ a\\&b ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ "&" ]] → allowed (& inside quoted span is skipped)', () => {
    const r = parseSecurity('[[ abc =~ "&" ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ (a|b) ]] → allowed (| inside parens is regex alternation)', () => {
    const r = parseSecurity('[[ abc =~ (a|b) ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ (a(b)) ]] → allowed (balanced parens)', () => {
    const r = parseSecurity('[[ abc =~ (a(b)) ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ (a(b ]] → too-complex (unbalanced parens, end of text)', () => {
    const r = parseSecurity('[[ abc =~ (a(b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex has unbalanced parentheses (parser desync)',
      )
    }
  })

  test('[[ abc =~ a$(cmd)b ]] → too-complex (expansion in regex)', () => {
    const r = parseSecurity('[[ abc =~ a$(cmd)b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('contains expansion')
    }
  })

  test('[[ abc =~ a`id`b ]] → too-complex (backtick cmd in regex)', () => {
    const r = parseSecurity('[[ abc =~ a`id`b ]]')
    expect(r.kind).toBe('too-complex')
  })

  // 2.1.221 (issue 5③) — expansion pre-check branch coverage. The pre-check
  // regex is /\$[({[\w#?!*@$'"+~^=-]|`|[<>]\(/ ; each alternation arm must be
  // pinned so a typo in any one arm is caught.
  test('dollar-brace parameter expansion in regex → too-complex', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${var}` in the command under test, not a JS template placeholder.
    const r = parseSecurity('[[ abc =~ ${var} ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('contains expansion')
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ <(cmd) ]] → too-complex (<( process substitution arm)', () => {
    const r = parseSecurity('[[ abc =~ <(cmd) ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('contains expansion')
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ >(cmd) ]] → too-complex (>( process substitution arm)', () => {
    const r = parseSecurity('[[ abc =~ >(cmd) ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('contains expansion')
      expect(r.nodeType).toBe('regex')
    }
  })

  // 2.1.221 (issue 5③) — negative-depth EARLY reject. A `)` that closes more
  // than was opened drops parenDepth below 0 and must reject immediately (the
  // 2.1.221 new behavior), not only at the end-of-text balance check.
  test('[[ abc =~ a)b ]] → too-complex (close-paren at depth 0 → negative depth early reject)', () => {
    const r = parseSecurity('[[ abc =~ a)b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex has unbalanced parentheses (parser desync)',
      )
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ (a))b ]] → too-complex (depth goes negative after a balanced pair)', () => {
    const r = parseSecurity('[[ abc =~ (a))b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex has unbalanced parentheses (parser desync)',
      )
    }
  })

  // Mutation-killer for the EARLY reject: `)` drops depth to -1, and the
  // early reject must fire at the `)` (returning "unbalanced parentheses")
  // BEFORE the scan continues to the `&`. If the early reject were removed,
  // the scan would fall through to the `&` and return "unquoted &" instead —
  // so asserting the exact reason pins the early-reject branch.
  test('[[ abc =~ a)&b ]] → too-complex (early reject at ) wins over the later &)', () => {
    const r = parseSecurity('[[ abc =~ a)&b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] regex has unbalanced parentheses (parser desync)',
      )
      expect(r.nodeType).toBe('regex')
    }
  })

  test('[[ abc =~ a\\)b ]] → allowed (escaped close-paren is inert, no negative depth)', () => {
    const r = parseSecurity('[[ abc =~ a\\)b ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc == a&b ]] → too-complex (unquoted & in extglob_pattern)', () => {
    const r = parseSecurity('[[ abc == a&b ]]')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        '[[ ]] pattern contains unquoted & (zsh splits the word at & at any depth)',
      )
    }
  })

  test('[[ abc == a\\&b ]] → allowed (escaped & in pattern)', () => {
    const r = parseSecurity('[[ abc == a\\&b ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ ^[0-9]+$ ]] → allowed (ordinary regex stays auto-checkable)', () => {
    const r = parseSecurity('[[ abc =~ ^[0-9]+$ ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ -f /tmp/x ]] → allowed (plain conditional unaffected)', () => {
    const r = parseSecurity('[[ -f /tmp/x ]]')
    expect(r.kind).toBe('simple')
  })

  test('[[ abc =~ a||b ]] embedded in list → too-complex propagates', () => {
    const r = parseSecurity('echo hi && [[ abc =~ a||b ]]')
    expect(r.kind).toBe('too-complex')
  })

  test('[[ abc =~ foo ]] && echo ok → simple (ws-delimited || outside regex)', () => {
    // Whitespace before && / || ends the regex node — this is a REAL shell
    // list operator, not the zsh-smuggled glued form.
    const r = parseSecurity('[[ abc =~ foo ]] && echo ok')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands.map(c => c.argv[0])).toEqual(['[[', 'echo'])
    }
  })
})
