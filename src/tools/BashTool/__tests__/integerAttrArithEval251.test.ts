import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.251 security fix (changelog #39, Gap-109f): the Bash permission
 * check auto-approved arithmetic assignments to integer-attribute shell
 * variables (`OPTIND=1/0`, `RANDOM=2+2`). bash/zsh arithmetically evaluate
 * the RHS when the target has the integer attribute, so `X='a[$(id)]'`
 * executes the subscript command substitution — a permission bypass.
 *
 * Verbatim from the official 2.1.251 binary (sets or/Va/Wn/Vo + Jo/Jn/Vwe):
 *  - bare assignment: exec-influencing (Jn) and integer-attr arith-eval
 *    (Jo) checks,
 *  - env-prefix: Jo check,
 *  - for_statement loop variable: Jn + all three variable sets,
 *  - unset_command: Vwe gate ('unset' targets shell variable …), -f/-v only,
 *    never flags after names, unsetenv/-f skip the gate.
 *
 * parseForSecurityFromAst is exercised directly (the wrapper is
 * feature-flag gated; the pure-TS parser module needs no async init).
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.251: integer-attr shell var arithmetic assignment (Gap-109f)', () => {
  test('OPTIND=1/0 → too-complex (arith-evals RHS, division aborts)', () => {
    const r = parseSecurity('OPTIND=1/0')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'OPTIND has integer attribute — assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test('RANDOM=2+2 → too-complex', () => {
    const r = parseSecurity('RANDOM=2+2')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'RANDOM has integer attribute — assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime',
      )
    }
  })

  test("SECONDS='x[$(id)]' → too-complex (subscript cmdsub executes)", () => {
    const r = parseSecurity("SECONDS='x[$(id)]'")
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('SECONDS has integer attribute')
    }
  })

  test('OPTIND=42 → allowed (plain integer literal, no arith risk)', () => {
    const r = parseSecurity('OPTIND=42')
    expect(r.kind).toBe('simple')
  })

  test('COUNT=5 → allowed (not an integer-attr shell var)', () => {
    const r = parseSecurity('COUNT=5')
    expect(r.kind).toBe('simple')
  })

  test('COUNT=1/0 → allowed (no integer attribute, RHS is literal text)', () => {
    const r = parseSecurity('COUNT=1/0')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.251: exec-influencing assignment gate (companion Jn check)', () => {
  test('PATH=/tmp/x → too-complex (alters command lookup)', () => {
    const r = parseSecurity('PATH=/tmp/x')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'PATH assignment alters command lookup/execution for subsequent commands',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test('LD_PRELOAD=/evil.so → too-complex (ld_ prefix)', () => {
    const r = parseSecurity('LD_PRELOAD=/evil.so')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'LD_PRELOAD assignment alters command lookup/execution for subsequent commands',
      )
    }
  })

  test('MY_PATH=/x → allowed (no exec influence)', () => {
    const r = parseSecurity('MY_PATH=/x')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.251: env-prefix integer-attr arith-eval (Jo at env-prefix site)', () => {
  test('RANDOM=2+2 ls → too-complex', () => {
    const r = parseSecurity('RANDOM=2+2 ls')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'RANDOM has integer attribute — env-prefix arith-evals value, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test('FOO=bar ls → allowed', () => {
    const r = parseSecurity('FOO=bar ls')
    expect(r.kind).toBe('simple')
  })

  test('OPTIND=7 ls → allowed (plain integer literal env-prefix)', () => {
    const r = parseSecurity('OPTIND=7 ls')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.251: for_statement loop variable gate extension', () => {
  test('for PATH in … → too-complex (exec-influencing)', () => {
    const r = parseSecurity('for PATH in /a /b; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('PATH as loop variable bypasses assignment validation')
      expect(r.nodeType).toBe('for_statement')
    }
  })

  test('for OPTIND in … → too-complex (integer-attr set)', () => {
    const r = parseSecurity('for OPTIND in 1 2; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('OPTIND as loop variable bypasses assignment validation')
    }
  })

  test('for REPLY in … → too-complex (special shell var set)', () => {
    const r = parseSecurity('for REPLY in a b; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('REPLY as loop variable bypasses assignment validation')
    }
  })

  test('for HOME in … → too-complex (env-influencing set)', () => {
    const r = parseSecurity('for HOME in /a; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('HOME as loop variable bypasses assignment validation')
    }
  })

  test('for IFS in … → too-complex (pre-existing check preserved)', () => {
    const r = parseSecurity('for IFS in x; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('IFS as loop variable bypasses assignment validation')
    }
  })

  test('for item in … → allowed (ordinary loop variable)', () => {
    const r = parseSecurity('for item in a b; do echo item; done')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.251: unset special shell variable gate (Vwe)', () => {
  test('unset PATH → too-complex', () => {
    const r = parseSecurity('unset PATH')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "'unset' targets shell variable PATH (exec-influencing / integer-attr / IFS / PS4)",
      )
      expect(r.nodeType).toBe('unset_command')
    }
  })

  test('unset IFS → too-complex', () => {
    const r = parseSecurity('unset IFS')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "'unset' targets shell variable IFS (exec-influencing / integer-attr / IFS / PS4)",
      )
    }
  })

  test('unset OPTIND → too-complex (integer-attr)', () => {
    const r = parseSecurity('unset OPTIND')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "'unset' targets shell variable OPTIND (exec-influencing / integer-attr / IFS / PS4)",
      )
    }
  })

  test('unset FOO BAR → allowed (ordinary vars)', () => {
    const r = parseSecurity('unset FOO BAR')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['unset', 'FOO', 'BAR'])
    }
  })

  test('unset -f myfunc → allowed (function unset skips the gate)', () => {
    const r = parseSecurity('unset -f myfunc')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]?.argv).toEqual(['unset', '-f', 'myfunc'])
    }
  })

  test('unset -v FOO → allowed (variable mode, ordinary var)', () => {
    const r = parseSecurity('unset -v FOO')
    expect(r.kind).toBe('simple')
  })

  test('unset -n FOO → too-complex (flag other than -f/-v)', () => {
    const r = parseSecurity('unset -n FOO')
    expect(r.kind).toBe('too-complex')
  })

  test('unset FOO -f → too-complex (flag after name)', () => {
    const r = parseSecurity('unset FOO -f')
    expect(r.kind).toBe('too-complex')
  })

  test('unset "MY VAR" → too-complex (non-identifier operand)', () => {
    const r = parseSecurity('unset "MY VAR"')
    expect(r.kind).toBe('too-complex')
  })

  test('unset "FOO" → too-complex (string node hits default, binary-identical)', () => {
    // The binary's unset switch only cases unset/variable_name/word; a
    // quoted operand parses as a `string` node and falls to its default
    // too-complex as well. OCC matches byte-for-byte.
    const r = parseSecurity('unset "FOO"')
    expect(r.kind).toBe('too-complex')
  })
})
