import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.274 S1 — behavioral evidence for the official changelog entry
 * "Fixed Bash permission checks for commands that loop over or assign certain
 * special shell variables; these commands now ask for permission".
 *
 * Verdict: NO-OP for OCC — the 2.1.251-era ports (`Vo` SPECIAL_SHELL_VARS
 * loop-var gate, `Jn` isExecInfluencingVar, `Jo`/`vc` integer-attr gate, the
 * PS4 value allowlist, IFS gate) already drive every risky pattern to
 * too-complex (→ ask). The remaining `simple` verdicts below are official
 * PARITY, not gaps, byte-verified against the 2.1.274 ELF:
 *   - `PS4=x` literal-safe values pass the allowlist (official allowlist
 *     equivalent; a charset-safe literal cannot execute at trace time).
 *   - env-prefix assignments (`RPS1=$(id) cmd`, `LD_PRELOAD=x cmd`) are
 *     "simple" in the official too: binary `Zp` (walkCommand) checks ONLY the
 *     integer-attr gate (`vc`) on env-prefix variable_assignment — no `_2t`
 *     (exec-influencing) gate — matching OCC's walkCommand exactly. The
 *     cmdsub inner command (`id`) IS extracted into the command list and
 *     permission-checked separately, so nothing executes un-permissioned.
 * The official's broader tracked-literal/resolvability subsystem (`Kp`
 * read/printf -v/getopts/set -A write-target analysis) is present in BOTH
 * 273 and 274 and remains unported by OCC — pre-existing STAGED gap, not a
 * 274 delta (docs/upstream-version-gap-occ127.md Part II).
 *
 * Harness mirrors integerAttrArithEval260.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.274 S1: loops over special shell variables → too-complex (ask)', () => {
  test.each([
    ['for IFS in a b; do echo x; done', 'IFS'],
    ['for PS4 in x; do :; done', 'PS4'],
    ['for RANDOM in 1 2; do echo $RANDOM; done', 'RANDOM'],
    ['for PATH in /bin; do ls; done', 'PATH'],
  ])('%s → too-complex', (cmd, name) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain(name)
      expect(r.reason).toContain('bypasses assignment validation')
    }
  })

  test('for f in "$@" → too-complex (simple_expansion in iteration words)', () => {
    const r = parseSecurity('for f in "$@"; do rm "$f"; done')
    expect(r.kind).toBe('too-complex')
  })

  test('for i in $* → too-complex (simple_expansion in iteration words)', () => {
    const r = parseSecurity('for i in $*; do echo $i; done')
    expect(r.kind).toBe('too-complex')
  })
})

describe('2.1.274 S1: special-variable assignments → too-complex (ask)', () => {
  test.each([
    ['IFS=, sort file.txt', 'IFS assignment changes word-splitting'],
    ['PS4=$(id) set -x', 'PS4 value derived from cmdsub/variable'],
    ["PS4='$(id)' set -x", 'PS4 value outside safe charset'],
    ['PS4=`id` set -x', 'PS4 value derived from cmdsub/variable'],
    ['for i in 1 2; do PS4=$i; done', 'PS4 value derived from cmdsub/variable'],
    ['RANDOM=2+2', 'integer attribute'],
    ['OPTIND=x[$(id)]', 'command_substitution'],
  ])('%s → too-complex', (cmd, reasonPart) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') expect(r.reason).toContain(reasonPart)
  })

  test('bare PATH assignment → too-complex (exec-influencing)', () => {
    const r = parseSecurity('PATH=/evil/bin')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex')
      expect(r.reason).toContain('alters command lookup/execution')
  })
})

describe('2.1.274 S1: official-parity simple verdicts (NOT gaps)', () => {
  test('PS4=x literal-safe value → simple (allowlist-verified inert)', () => {
    // Binary parity: a charset-safe PS4 literal cannot execute at trace time
    // (no $, no backtick, no backslash/octal, no parens).
    const r = parseSecurity('PS4=x set -x')
    expect(r.kind).toBe('simple')
  })

  test('RPS1=$(id) echo hi → simple BUT the inner command is extracted and permission-checked', () => {
    // Official `Zp` env-prefix path has no exec-influencing gate (only the
    // integer-attr `vc` check) — OCC matches. The cmdsub payload is NOT
    // smuggled: `id` lands in the command list, so the permission engine
    // evaluates `Bash(id)` on its own and asks when no rule allows it.
    const r = parseSecurity('RPS1=$(id) echo hi')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      const argvs = r.commands.map(c => c.argv[0])
      expect(argvs).toContain('id')
      expect(argvs).toContain('echo')
    }
  })

  test('LD_PRELOAD=/evil.so cat f → simple (env-prefix parity with official Zp)', () => {
    // Byte-verified: official 2.1.274 `Zp` checks only `vc` (integer-attr)
    // on env-prefix assignments; `_2t` (exec-influencing) gates BARE
    // assignments only — identical to OCC. Command-local env prefix; the
    // bare-assignment form below is the one both binaries gate.
    const r = parseSecurity('LD_PRELOAD=/evil.so cat f')
    expect(r.kind).toBe('simple')
  })
})
