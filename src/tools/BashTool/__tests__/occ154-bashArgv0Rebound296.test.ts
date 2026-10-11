import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.296 changelog #031 (P0): "Fixed Bash permission checks
 * auto-approving some commands that assign the `BASH_ARGV0` shell variable
 * and then use it; these now prompt for approval."
 *
 * Binary evidence (official ELF, never executed; strings + mmap.find + dd):
 * - The fix is EXACTLY one insertion: `"BASH_ARGV0"` added after
 *   `"BASH_LINENO"` in the implicitly-rebound special-variable set.
 *   v295 `eLn=new Set([...])` @211429632 (no BASH_ARGV0) vs v296
 *   `KLn=new Set([...])` @212066150 (with BASH_ARGV0); whole-module
 *   added/removed diff shows no other content change (minifier renames
 *   only). Official export alias @231459065: `KLn as
 *   BASH_IMPLICITLY_REBOUND_VARS`.
 * - The set feeds three official consumption sites (all live in BOTH v295
 *   and v296 — the set addition is what activates them for BASH_ARGV0):
 *   1. for_statement loop-var guard: v295 @211391287 / v296 @212027500
 *      (`||KLn.has(n)` → too-complex "as loop variable bypasses
 *      assignment validation"). OCC: SPECIAL_SHELL_VARS in the loop gate.
 *   2. Expansion resolver `Z`: v295 @211430429 / v296 @212066655 —
 *      `let n=t.get(s);if(n!==void 0){if(KLn.has(s))return
 *      r&&le.has(s)&&s!=="BASHPID"?_:b(e)}` — a TRACKED assignment of an
 *      implicitly-rebound var must NOT substitute the literal: inside a
 *      string with a SAFE_ENV_VARS member (except BASHPID) → placeholder
 *      `_`; otherwise → too-complex `b(e)`. This is the #031 attack path:
 *      bash rebinds these vars itself (BASH_ARGV0 is $0; function calls
 *      rebind it between assign and use), so the tracked literal is
 *      untrustworthy → must prompt.
 *   3. Tracked-literal scope capture: v295 @218262070 / v296 @219025811
 *      (`&&!KLn.has(w.text)` before `n.scopes.at(-1).set(...)`) — lives in
 *      the official scopes-tracker subsystem OCC has not ported (see
 *      ast.ts:1917 note); OCC's varScope model is covered by the site-2
 *      guard ported here.
 * - Alignment bonus (pre-existing OCC gap vs BOTH v295+v296 sets): official
 *   also lists `BASH_MONOSECONDS` and `BASH_TRAPSIG` (zsh bash-emulation
 *   dynamic vars); OCC's SPECIAL_SHELL_VARS missed them (they were only in
 *   the v288 integer-attr set). Added at their official positions.
 *
 * Harness mirrors specialVarLoops274.test.ts.
 *
 * Legacy live-path probe (Leader's "AST+legacy 双路径" mandate; method:
 * quotedBracketCloserLivePath223.test.ts harness, tree-sitter forced off via
 * CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK=1 → parse-unavailable): every
 * #031 attack form under permissive rules (rm/eval/echo wildcards) returned
 * ask/passthrough — NEVER allow — while the `echo hello` control proved the
 * allow-rule harness active. The legacy path fail-closes uniformly on
 * assignment-prefix compounds (parity control FOO=tmpprobe && rm $FOO/x also
 * asks), so no live-path compensation guard is needed (same verdict as the
 * 2.1.221 #044 zsh-regex probe: "28/28 passthrough, fail-closed").
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('CC 2.1.296 #031: BASH_ARGV0 assign-then-use → prompt (too-complex)', () => {
  test('BASH_ARGV0=/tmp/x && rm -rf $BASH_ARGV0/y no longer resolves to a literal path', () => {
    // Pre-fix OCC: "simple" with argv ['rm','-rf','/tmp/x/y'] → auto-allowed.
    // Official v296 site-2 guard: tracked BASH_ARGV0 is implicitly rebound
    // by bash → literal untrustworthy → too-complex → permission prompt.
    const r = parseSecurity('BASH_ARGV0=/tmp/x && rm -rf $BASH_ARGV0/y')
    expect(r.kind).toBe('too-complex')
  })

  test('BASH_ARGV0=evil && eval "$BASH_ARGV0" no longer resolves to `eval evil`', () => {
    // Pre-fix OCC: "simple" argv ['eval','evil'] — the resolved literal
    // smuggled an arbitrary eval payload past the permission check.
    const r = parseSecurity('BASH_ARGV0=evil && eval "$BASH_ARGV0"')
    expect(r.kind).toBe('too-complex')
  })

  test('BASH_ARGV0=evil && echo "$BASH_ARGV0" → too-complex (not a SAFE_ENV_VARS member)', () => {
    // Official: `r&&le.has(s)&&s!=="BASHPID"?_:b(e)` — BASH_ARGV0 ∉ le
    // (SAFE_ENV_VARS), so even the in-string position is too-complex.
    const r = parseSecurity('BASH_ARGV0=evil && echo "$BASH_ARGV0"')
    expect(r.kind).toBe('too-complex')
  })

  test('for BASH_ARGV0 in a b → official loop-var reason', () => {
    const r = parseSecurity('for BASH_ARGV0 in a b; do rm $BASH_ARGV0; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('BASH_ARGV0')
      expect(r.reason).toContain('bypasses assignment validation')
    }
  })
})

describe('CC 2.1.296 #031 alignment: BASH_MONOSECONDS / BASH_TRAPSIG set members', () => {
  test('for BASH_MONOSECONDS in 1 2 → too-complex loop-var reason', () => {
    const r = parseSecurity('for BASH_MONOSECONDS in 1 2; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('bypasses assignment validation')
    }
  })

  test('BASH_TRAPSIG=x && echo "$BASH_TRAPSIG" → too-complex', () => {
    const r = parseSecurity('BASH_TRAPSIG=x && echo "$BASH_TRAPSIG"')
    expect(r.kind).toBe('too-complex')
  })
})

describe('CC 2.1.296 #031 official parity: SAFE_ENV_VARS members degrade to placeholder, BASHPID excluded', () => {
  test('RANDOM=5 && echo "x$RANDOM" → simple but value is the placeholder, not the tracked literal', () => {
    // Official: RANDOM ∈ KLn ∩ le, in-string, ≠BASHPID → `_` placeholder.
    // Pre-fix OCC substituted the literal '5' ("x5").
    const r = parseSecurity('RANDOM=5 && echo "x$RANDOM"')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['echo', 'x__TRACKED_VAR__'])
    }
  })

  test('RANDOM=5 && echo "$RANDOM" → too-complex (solo-placeholder string gate)', () => {
    // The resolver degrades to the placeholder, then walkString's
    // solo-placeholder gate rejects a quoted arg that is ONLY a placeholder.
    const r = parseSecurity('RANDOM=5 && echo "$RANDOM"')
    expect(r.kind).toBe('too-complex')
  })

  test('BASHPID=7 && echo "$BASHPID" → too-complex (official `s!=="BASHPID"` carve-out)', () => {
    const r = parseSecurity('BASHPID=7 && echo "$BASHPID"')
    expect(r.kind).toBe('too-complex')
  })

  test('bare RANDOM=5 && echo $RANDOM → too-complex (not inside string)', () => {
    const r = parseSecurity('RANDOM=5 && echo $RANDOM')
    expect(r.kind).toBe('too-complex')
  })
})

describe('CC 2.1.296 #031 no over-block: ordinary tracked vars still resolve', () => {
  test('FOO=/tmp && rm $FOO/x → simple with the real path', () => {
    const r = parseSecurity('FOO=/tmp && rm $FOO/x')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['rm', '/tmp/x'])
    }
  })

  test('untracked echo "$BASH_ARGV0" → too-complex (pre-existing behavior unchanged)', () => {
    const r = parseSecurity('echo "$BASH_ARGV0"')
    expect(r.kind).toBe('too-complex')
  })
})
