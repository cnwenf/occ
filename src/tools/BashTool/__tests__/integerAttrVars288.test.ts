import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.288 #28 — behavioral evidence for the official changelog entry
 * "Fixed Bash tool permission check to prompt before a BASHPID assignment
 * whose value the shell would evaluate as arithmetic, instead of allowing it
 * silently."
 *
 * The official v288 integer-attribute shell-variable set `fyt`
 * (@203549536, 42 members, recovered verbatim — see
 * /tmp/cc-diff-288/r28_fyt_set.txt) adds THREE names to the set OCC carried
 * from 2.1.251/2.1.260 (39 members):
 *   - BASHPID           — this round's official delta (#28)
 *   - BASH_MONOSECONDS  — pre-existing gap (already in the v288 set)
 *   - BASH_TRAPSIG      — pre-existing gap (already in the v288 set)
 * All three sit between EPOCHREALTIME and COLUMNS in official order.
 *
 * The gate function `qe()` (hasIntegerAttrArithEvalRisk) is UNCHANGED
 * v287 → v288 (verified byte-for-byte against /tmp/cc-diff-288/r28_qe.txt);
 * every consumer (bare assignment, env-prefix, for_statement loop variable,
 * unset gate) picks the new members up automatically.
 *
 * Harness mirrors integerAttrArithEval260.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.288 #28: BASHPID — bare assignment gate', () => {
  test('BASHPID=1/0 → too-complex (arith-evals RHS, division aborts)', () => {
    const r = parseSecurity('BASHPID=1/0')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'BASHPID has integer attribute — assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test("BASHPID='x[$(id)]' → too-complex (subscript cmdsub executes)", () => {
    const r = parseSecurity("BASHPID='x[$(id)]'")
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('BASHPID has integer attribute')
    }
  })

  test('BASHPID=5 → allowed (plain integer literal, no arith risk)', () => {
    const r = parseSecurity('BASHPID=5')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.288 #28: BASH_MONOSECONDS / BASH_TRAPSIG — pre-existing v288 set members', () => {
  test('BASH_MONOSECONDS=2+2 → too-complex (arith-evals RHS)', () => {
    const r = parseSecurity('BASH_MONOSECONDS=2+2')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('BASH_MONOSECONDS has integer attribute')
    }
  })

  test('BASH_TRAPSIG=1/0 → too-complex (arith-evals RHS)', () => {
    const r = parseSecurity('BASH_TRAPSIG=1/0')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('BASH_TRAPSIG has integer attribute')
    }
  })

  test('BASH_MONOSECONDS=5 → allowed (plain integer literal)', () => {
    const r = parseSecurity('BASH_MONOSECONDS=5')
    expect(r.kind).toBe('simple')
  })

  test('BASH_TRAPSIG=64 → allowed (plain integer literal)', () => {
    const r = parseSecurity('BASH_TRAPSIG=64')
    expect(r.kind).toBe('simple')
  })

  test('BASHPID_X=2+2 → allowed (not in the integer-attr set)', () => {
    const r = parseSecurity('BASHPID_X=2+2')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.288 #28: new members — env-prefix, loop variable and unset gates', () => {
  test('BASHPID=1/0 ls → too-complex (env-prefix arith-evals value)', () => {
    const r = parseSecurity('BASHPID=1/0 ls')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'BASHPID has integer attribute — env-prefix arith-evals value, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test('BASHPID=5 git status → allowed (plain integer literal env-prefix)', () => {
    const r = parseSecurity('BASHPID=5 git status')
    expect(r.kind).toBe('simple')
  })

  test('for BASHPID in … → too-complex (integer-attr set)', () => {
    const r = parseSecurity('for BASHPID in 1 2; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'BASHPID as loop variable bypasses assignment validation',
      )
      expect(r.nodeType).toBe('for_statement')
    }
  })

  test('unset BASH_TRAPSIG → too-complex (isSpecialShellVar via integer-attr set)', () => {
    const r = parseSecurity('unset BASH_TRAPSIG')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "'unset' targets shell variable BASH_TRAPSIG (exec-influencing / integer-attr / IFS / PS4)",
      )
    }
  })
})
