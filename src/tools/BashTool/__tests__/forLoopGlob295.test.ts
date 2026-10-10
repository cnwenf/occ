import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.295 changelog #044 — "Fixed Bash permission checks for for-loops
 * over glob patterns, improving permission-check accuracy".
 *
 * Official 294→295 delta (byte-verified against /tmp/cc-153 bundles):
 *   v294: `else{let f=T(d,t,r,s);if(typeof f!=="string")return f;if(ge(d))h=!0}`
 *   v295: `...if(ge(d))h=!0;else if((T(d.text)||ee(d))&&wAs())h=!0}`
 *   (@211391071/@211391085 in v295; v294 baseline @208540813)
 * plus the branch tail `if(F(r,c),h&&t.length===a)C(t,e)` (@211391836,
 * v294 @208541539) and synthetic push `C` (@211427156, v294 @208576864):
 * a for-loop whose iteration word contains an unquoted glob (new, gated by
 * `tengu_vast_puddle` via wAs @208923529) or an arithmetic expansion (v294
 * baseline `ge` @211427258) AND whose body extracts zero commands gets a
 * synthetic `{argv:['true'], text:<full loop text>}` command pushed, so
 * prefix-rule matching sees the loop instead of an empty (auto-allow) list.
 *
 * Pre-port OCC gap (probe evidence): `for f in ?.txt; do X=1; done` →
 * simple with commands: [] — invisible to rule matching. Post-port it
 * yields the synthetic `true` carrying the full loop text, matching
 * official v295 behavior.
 *
 * Harness mirrors specialVarLoops274.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

/** Assert simple verdict and return the command list. */
function simpleCommands(cmd: string) {
  const r = parseSecurity(cmd)
  expect(r.kind).toBe('simple')
  if (r.kind !== 'simple') throw new Error('unreachable')
  return r.commands
}

describe('2.1.295 #044: for-loop over glob with command-less body → synthetic true', () => {
  test.each([
    'for f in ?.txt; do X=1; done',
    'for f in *.txt; do X=1; done',
    'for f in a *.txt b; do X=1; done',
    'for f in /etc/*; do X=1; done',
  ])('%s → synthetic true carrying full loop text', cmd => {
    const cmds = simpleCommands(cmd)
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv).toEqual(['true'])
    expect(cmds[0]!.envVars).toEqual([])
    expect(cmds[0]!.redirects).toEqual([])
    expect(cmds[0]!.text).toBe(cmd)
    expect(cmds[0]!.hasUnquotedGlob).toBe(true)
  })

  test('bracket glob word → synthetic true', () => {
    const cmds = simpleCommands('for f in [ab]*; do X=1; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv).toEqual(['true'])
    expect(cmds[0]!.text).toBe('for f in [ab]*; do X=1; done')
    expect(cmds[0]!.hasUnquotedGlob).toBe(true)
  })

  test('empty body (do done) with glob word → synthetic true', () => {
    const cmds = simpleCommands('for f in *.txt; do done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv).toEqual(['true'])
    expect(cmds[0]!.text).toBe('for f in *.txt; do done')
  })
})

describe('2.1.295 #044: quoted globs stay inert (official parity — T/ee are quote-aware)', () => {
  test.each([
    'for f in "[a-z]*"; do X=1; done',
    'for f in "*.txt"; do X=1; done',
    'for f in a"*"b; do X=1; done',
  ])('%s → simple with zero commands, no synthetic', cmd => {
    const cmds = simpleCommands(cmd)
    expect(cmds.length).toBe(0)
  })
})

describe('2.1.295 #044: synthetic push suppressed when commands were extracted', () => {
  test('body extracts a command → no synthetic (glob word)', () => {
    const cmds = simpleCommands('for f in *.txt; do :; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv[0]).toBe(':')
  })

  test('body extracts a command → no synthetic (echo body)', () => {
    const cmds = simpleCommands('for f in *.txt; do echo hi; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv).toEqual(['echo', 'hi'])
  })

  test('cmdsub iteration word pushes its inner command → no synthetic', () => {
    // Official `a=t.length` is captured at branch ENTRY: the word-list
    // cmdsub pushes `ls`, so `t.length!==a` and C() never fires.
    const cmds = simpleCommands('for f in $(ls *.txt); do X=1; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv[0]).toBe('ls')
  })

  test('plain words with command-less body → zero commands (unchanged)', () => {
    const cmds = simpleCommands('for f in a b c; do X=1; done')
    expect(cmds.length).toBe(0)
  })
})

describe('2.1.295 #044: arithmetic-expansion iteration word (v294 ge baseline, ported with the else-if chain)', () => {
  test('arith word + command-less body → synthetic true', () => {
    const cmds = simpleCommands('for i in $((1+2)); do X=1; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv).toEqual(['true'])
    expect(cmds[0]!.text).toBe('for i in $((1+2)); do X=1; done')
  })

  test('arith word + command body → body command only, no synthetic', () => {
    const cmds = simpleCommands('for i in $((1+2)); do :; done')
    expect(cmds.length).toBe(1)
    expect(cmds[0]!.argv[0]).toBe(':')
  })
})

describe('2.1.295 #044: pre-existing for_statement behaviors unchanged', () => {
  test('bare $f in body with glob word → too-complex (VAR_PLACEHOLDER)', () => {
    const r = parseSecurity('for f in *.txt; do rm $f; done')
    expect(r.kind).toBe('too-complex')
  })

  test('quoted embedding of $f in body → too-complex', () => {
    const r = parseSecurity('for f in *.txt; do X="$f"; done')
    expect(r.kind).toBe('too-complex')
  })

  test('special loop var still fails closed before any synthetic logic', () => {
    const r = parseSecurity('for IFS in *; do X=1; done')
    expect(r.kind).toBe('too-complex')
  })
})
