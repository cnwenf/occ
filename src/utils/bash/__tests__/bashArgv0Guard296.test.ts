import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.296 — changelog: "Fixed Bash permission checks auto-approving some
 * commands that assign the BASH_ARGV0 shell variable and then use it; these
 * now prompt for approval."
 *
 * Official evidence (ev-bashargv0.txt / ev-bashargv0-loop.txt):
 *  - the special-var set `KLn` (2.1.296 spelling of OCC's SPECIAL_SHELL_VARS)
 *    gains BASH_ARGV0 (plus BASH_MONOSECONDS / BASH_TRAPSIG members OCC's Vo
 *    port was missing);
 *  - resolver `Z`: `if(KLn.has(s))return r&&le.has(s)&&s!=="BASHPID"?_:b(e)`
 *    — a TRACKED special var never resolves to its literal value: bare use is
 *    too-complex, in-string use is a placeholder only for the le
 *    (SAFE_ENV_VARS) members other than BASHPID;
 *  - for-loop guard @212027456: `…||n==="BASH_ARGV0"||…||KLn.has(n)` →
 *    `{kind:"too-complex",
 *      reason:"${n} as loop variable bypasses assignment validation",
 *      nodeType:"for_statement"}`.
 *
 * Harness mirrors specialVarLoops274.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.296: BASH_ARGV0 assign-then-use is no longer auto-approved', () => {
  test('BASH_ARGV0=x then bare $BASH_ARGV0 use → too-complex (was: trusted literal)', () => {
    // Arrange / Act — before the fix the tracked literal 'rm' resolved and the
    // command parsed as a simple `rm -rf /` with the real argv visible only
    // because the model chose a benign-looking value; the shell can rewrite
    // BASH_ARGV0 itself ($0 assignment), so the literal is untrustworthy.
    const r = parseSecurity('BASH_ARGV0=rm && $BASH_ARGV0 -rf /tmp/x')

    // Assert
    expect(r.kind).toBe('too-complex')
  })

  test('BASH_ARGV0=x then in-string use → too-complex (not a SAFE_ENV_VARS member)', () => {
    const r = parseSecurity('BASH_ARGV0=/etc && echo "path: $BASH_ARGV0"')
    expect(r.kind).toBe('too-complex')
  })

  test('BASH_ARGV0 assignment alone stays simple (nothing uses it)', () => {
    const r = parseSecurity('BASH_ARGV0=hello')
    expect(r.kind).toBe('simple')
  })

  test.each([
    'PIPESTATUS',
    'BASH_REMATCH',
    'BASH_MONOSECONDS',
    'BASH_TRAPSIG',
    'PS1',
    'REPLY',
  ])('%s assign-then-bare-use → too-complex (KLn member)', name => {
    const r = parseSecurity(`${name}=x && echo $${name}`)
    expect(r.kind).toBe('too-complex')
  })

  test('tracked RANDOM in-string → placeholder (SAFE_ENV_VARS member, kind stays simple)', () => {
    // le.has(RANDOM) && insideString && !== BASHPID → VAR_PLACEHOLDER.
    const r = parseSecurity('RANDOM=5 && echo "roll: $RANDOM"')
    expect(r.kind).toBe('simple')
  })

  test('tracked RANDOM bare use → too-complex', () => {
    const r = parseSecurity('RANDOM=5 && echo $RANDOM')
    expect(r.kind).toBe('too-complex')
  })

  test('BASHPID carve-out: tracked BASHPID use → too-complex even inside a string', () => {
    // Official `s!=="BASHPID"`: BASHPID never resolves to the placeholder.
    const bare = parseSecurity('BASHPID=5 && echo $BASHPID')
    expect(bare.kind).toBe('too-complex')
    const inString = parseSecurity('BASHPID=5 && echo "pid: $BASHPID"')
    expect(inString.kind).toBe('too-complex')
  })

  test('non-special tracked var literal still resolves (no regression)', () => {
    const r = parseSecurity('MY_VAR=/tmp && echo "$MY_VAR"')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.296: special vars as for-loop variables → too-complex (verbatim reason)', () => {
  test.each([
    'BASH_ARGV0',
    'BASH_MONOSECONDS',
    'BASH_TRAPSIG',
    'PIPESTATUS',
    'PS2',
  ])('for %s in … → too-complex with the official reason', name => {
    // Arrange / Act
    const r = parseSecurity(`for ${name} in a b; do echo x; done`)

    // Assert — verbatim official reason + nodeType (ev-bashargv0-loop.txt).
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        `${name} as loop variable bypasses assignment validation`,
      )
      expect(r.nodeType).toBe('for_statement')
    }
  })

  test('existing BASHPID loop behavior unchanged', () => {
    const r = parseSecurity('for BASHPID in 1 2; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'BASHPID as loop variable bypasses assignment validation',
      )
      expect(r.nodeType).toBe('for_statement')
    }
  })

  test('ordinary loop var still allowed with placeholder body use', () => {
    const r = parseSecurity('for f in a b; do echo "x: $f"; done')
    expect(r.kind).toBe('simple')
  })
})
