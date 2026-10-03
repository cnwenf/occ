import { describe, expect, test } from 'bun:test'
import {
  checkSemantics,
  NODE_TYPE_EXPLANATIONS,
  parseForSecurityFromAst,
  tooComplex,
  type SimpleCommand,
} from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'
import type { Node } from '../../../utils/bash/parser.js'

/**
 * CC 2.1.288 #72 — behavioral evidence for the official changelog entry
 * "Improved Bash permission prompts to give a shorter reason when part of a
 * command can't be checked before it runs."
 *
 * Byte-exact port of the official 2.1.288 `_()` too-complex builder
 * (@203543557) and its sentence-case `vt` node-type → explanation map
 * (26 entries; the gap report prose says "27" but both the report's own
 * verbatim enumeration and the binary dump contain 26), plus the v288 short
 * wrapper reasons from the `FJn` region (@203551221) — all recovered
 * verbatim from the v288 ELF. See
 * docs/gap-research-288/cluster-a-permission-sandbox.md #72 and the dumps
 * /tmp/cc-diff-288/r72_builder.txt + r72_wrapper.txt.
 *
 * v288 template (replaces v287's "Part of this command (…) cannot be
 * checked in advance"):
 *   reason = `${n === undefined ? "This command" : `${n} in this command`}
 *             can't be checked before it runs`
 *
 * The unmapped-type branch of the official builder is a defensive fallback:
 * every node type the OCC walker currently routes to tooComplex() is covered
 * by the 26-entry map (verified by exhaustive probing), so that branch is
 * unit-tested directly via a synthetic node instead of a real command.
 *
 * Supersedes bashPromptPlainLanguage287.test.ts (v287 long messages).
 * Harness mirrors specialVarLoops274.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

// tooComplex() reads only node.type — a synthetic node is sufficient.
const nodeOfType = (type: string): Node => ({ type }) as unknown as Node

describe('2.1.288 #72: NODE_TYPE_EXPLANATIONS — official `vt` map, 26 byte-exact sentence-case entries', () => {
  test('has exactly 26 entries in official insertion order', () => {
    expect(NODE_TYPE_EXPLANATIONS.size).toBe(26)
    expect([...NODE_TYPE_EXPLANATIONS.keys()]).toEqual([
      'simple_expansion',
      'expansion',
      'command_substitution',
      'process_substitution',
      'brace_expression',
      'ansi_c_string',
      'translated_string',
      'test_command',
      'herestring_redirect',
      'heredoc_redirect',
      'subshell',
      'compound_statement',
      'for_statement',
      'c_style_for_statement',
      'while_statement',
      'until_statement',
      'if_statement',
      'case_statement',
      'function_definition',
      'array',
      'string',
      'file_redirect',
      'pipeline',
      'concatenation',
      'variable_assignment',
      'variable_assignments',
    ])
  })

  test('every explanation is byte-exact from the official v288 `vt` map', () => {
    expect([...NODE_TYPE_EXPLANATIONS.entries()]).toEqual([
      ['simple_expansion', 'A variable'],
      ['expansion', 'A variable in braces'],
      ['command_substitution', 'A nested command'],
      ['process_substitution', 'A command used as a file'],
      ['brace_expression', 'A brace pattern'],
      ['ansi_c_string', 'Text with escape codes'],
      ['translated_string', 'Translatable text'],
      ['test_command', 'A test in brackets'],
      ['herestring_redirect', 'A here-string'],
      ['heredoc_redirect', 'A here-document'],
      ['subshell', 'A group in parentheses'],
      ['compound_statement', 'A group in braces or double parentheses'],
      ['for_statement', 'A for or select loop'],
      ['c_style_for_statement', 'A counting for loop'],
      ['while_statement', 'A while or until loop'],
      ['until_statement', 'An until loop'],
      ['if_statement', 'An if statement'],
      ['case_statement', 'A case statement'],
      ['function_definition', 'A function definition'],
      ['array', 'A list of values'],
      ['string', 'Quoted text'],
      ['file_redirect', 'A file redirect'],
      ['pipeline', 'A pipeline'],
      ['concatenation', 'Joined pieces of text'],
      ['variable_assignment', 'A variable assignment'],
      ['variable_assignments', 'Variable assignments'],
    ])
  })
})

describe("2.1.288 #72: tooComplex() — official v288 `_()` builder (short \"can't be checked\" template)", () => {
  test('simple_expansion → "A variable in this command can\'t be checked before it runs"', () => {
    expect(tooComplex(nodeOfType('simple_expansion'))).toEqual({
      kind: 'too-complex',
      reason: "A variable in this command can't be checked before it runs",
      nodeType: 'simple_expansion',
    })
  })

  test('ERROR → "Parse error" (unchanged across v287 → v288)', () => {
    expect(tooComplex(nodeOfType('ERROR'))).toEqual({
      kind: 'too-complex',
      reason: 'Parse error',
      nodeType: 'ERROR',
    })
  })

  test('unmapped node type → "This command can\'t be checked before it runs" (defensive fallback)', () => {
    expect(tooComplex(nodeOfType('some_future_unmapped_node'))).toEqual({
      kind: 'too-complex',
      reason: "This command can't be checked before it runs",
      nodeType: 'some_future_unmapped_node',
    })
  })

  test('no mapped type leaks the raw parser name or the v287 long template', () => {
    for (const type of NODE_TYPE_EXPLANATIONS.keys()) {
      const r = tooComplex(nodeOfType(type))
      expect(r.kind).toBe('too-complex')
      if (r.kind === 'too-complex') {
        expect(r.reason).not.toContain('Contains ')
        expect(r.reason).not.toContain('Unhandled node type')
        expect(r.reason).not.toContain('cannot be checked in advance')
        expect(r.reason).not.toContain('Part of this command')
        expect(r.reason).toBe(
          `${NODE_TYPE_EXPLANATIONS.get(type)} in this command can't be checked before it runs`,
        )
        expect(r.nodeType).toBe(type)
      }
    }
  })
})

describe('2.1.288 #72: end-to-end through parseForSecurityFromAst', () => {
  test('for f in "$@" → too-complex with the short sentence-case reason', () => {
    const r = parseSecurity('for f in "$@"; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "A variable in this command can't be checked before it runs",
      )
      expect(r.nodeType).toBe('simple_expansion')
    }
  })

  test('malformed command (ERROR node) → "Parse error"', () => {
    const r = parseSecurity('echo )')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('Parse error')
      expect(r.nodeType).toBe('ERROR')
    }
  })

  test('array / c_style_for get the v288 mapped short reasons', () => {
    const arr = parseSecurity('x=(1 2 3)')
    expect(arr.kind).toBe('too-complex')
    if (arr.kind === 'too-complex') {
      expect(arr.reason).toBe(
        "A list of values in this command can't be checked before it runs",
      )
      expect(arr.nodeType).toBe('array')
    }
    const cfor = parseSecurity('for ((i=0;i<3;i++)); do echo $i; done')
    expect(cfor.kind).toBe('too-complex')
    if (cfor.kind === 'too-complex') {
      expect(cfor.reason).toBe(
        "A counting for loop in this command can't be checked before it runs",
      )
      expect(cfor.nodeType).toBe('c_style_for_statement')
    }
  })
})

/**
 * 2.1.288 #72 — short wrapper reasons from the official `FJn` region
 * (@203551221), verbatim from /tmp/cc-diff-288/r72_wrapper.txt:
 *   - timeout option   → `'timeout ${u}' can't be checked before it runs`
 *   - timeout duration → `timeout duration '${t[c]}' can't be checked before it runs`
 *   - env              → `'env ${u}' can't be checked before it runs`
 *   - stdbuf           → `'stdbuf ${u}' can't be checked before it runs`
 *   - nice             → UNCHANGED long form (v288 dump retains
 *     `nice argument '${t[1]}' contains expansion — cannot statically
 *     determine wrapped command`; not one of the shortened strings)
 * checkSemantics() is exercised directly with synthetic SimpleCommands —
 * the wrapper strip loop reads only argv.
 */
function semanticsFor(argv: string[]) {
  const cmd: SimpleCommand = { argv, envVars: [], redirects: [], text: argv.join(' ') }
  return checkSemantics([cmd])
}

describe('2.1.288 #72: wrapper reasons — official v288 short forms', () => {
  test("timeout unknown long flag → \"'timeout --bogus' can't be checked before it runs\"", () => {
    const r = semanticsFor(['timeout', '--bogus', '5', 'echo', 'hi'])
    expect(r).toEqual({
      ok: false,
      reason: "'timeout --bogus' can't be checked before it runs",
    })
  })

  test("timeout unknown short flag → \"'timeout -x' can't be checked before it runs\"", () => {
    const r = semanticsFor(['timeout', '-x', '5', 'echo', 'hi'])
    expect(r).toEqual({
      ok: false,
      reason: "'timeout -x' can't be checked before it runs",
    })
  })

  test('timeout non-standard duration → short v288 form', () => {
    const r = semanticsFor(['timeout', '.5', 'echo', 'hi'])
    expect(r).toEqual({
      ok: false,
      reason: "timeout duration '.5' can't be checked before it runs",
    })
  })

  test("env -S → \"'env -S' can't be checked before it runs\"", () => {
    const r = semanticsFor(['env', '-S', 'echo hi'])
    expect(r).toEqual({
      ok: false,
      reason: "'env -S' can't be checked before it runs",
    })
  })

  test("stdbuf unknown flag → \"'stdbuf -x' can't be checked before it runs\"", () => {
    const r = semanticsFor(['stdbuf', '-x', 'echo', 'hi'])
    expect(r).toEqual({
      ok: false,
      reason: "'stdbuf -x' can't be checked before it runs",
    })
  })

  test('nice expansion argument keeps the official v288 long form (unchanged)', () => {
    // v288 dump verbatim: the nice reason was NOT shortened — it retains
    // "contains expansion — cannot statically determine wrapped command".
    const r = semanticsFor(['nice', '$((0-5))', 'echo', 'hi'])
    expect(r).toEqual({
      ok: false,
      reason:
        'nice argument \'$((0-5))\' contains expansion — cannot statically determine wrapped command',
    })
  })
})

describe("2.1.288 #72: wrapper strip + short reasons — jobs/xargs/awk/command/generic (FJn @203550620, all verbatim)", () => {
  test("jobs -x → \"What 'jobs -x' starts can't be checked before it runs\" (@203559309)", () => {
    expect(semanticsFor(['jobs', '-x', 'rm'])).toEqual({
      ok: false,
      reason: "What 'jobs -x' starts can't be checked before it runs",
    })
    // Any arg matching /^[+-].*x/ trips it (official regex, verbatim).
    expect(semanticsFor(['jobs', '+lx'])).toEqual({
      ok: false,
      reason: "What 'jobs -x' starts can't be checked before it runs",
    })
    // Plain listing flags are inert.
    expect(semanticsFor(['jobs', '-l'])).toEqual({ ok: true })
  })

  test("command strip: `command eval` is checked as eval; bad flag gets the short reason (@203552202)", () => {
    expect(semanticsFor(['command', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    expect(semanticsFor(['command', '--bogus', 'rm'])).toEqual({
      ok: false,
      reason: "'command --bogus' can't be checked before it runs",
    })
    // -v/-V are existence checks: strip loop breaks with name='command',
    // which is NOT in the official d8 eval-like set → allowed.
    expect(semanticsFor(['command', '-v', 'rm'])).toEqual({ ok: true })
    expect(semanticsFor(['command', '-pV', 'rm'])).toEqual({ ok: true })
    // `command -p rm` strips -p (POSIX flag) and checks rm — inert here.
    expect(semanticsFor(['command', '-p', 'rm', '-rf', 'x'])).toEqual({
      ok: true,
    })
    // `command -- eval` strips the separator, then eval is caught.
    expect(semanticsFor(['command', '--', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
  })

  test('builtin/noglob strip (raw argv[0], optional -- after builtin)', () => {
    expect(semanticsFor(['builtin', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    expect(semanticsFor(['builtin', '--', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    expect(semanticsFor(['noglob', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    // Bare forms are inert (official d8 omits command/builtin/noglob).
    expect(semanticsFor(['builtin'])).toEqual({ ok: true })
    expect(semanticsFor(['noglob'])).toEqual({ ok: true })
  })

  test('xargs strip: adds-to for find/jq, gives-to for program-less awk (@203559521/@203559787)', () => {
    expect(semanticsFor(['xargs', 'find', '.', '-delete'])).toEqual({
      ok: false,
      reason: "What xargs adds to find can't be checked before it runs",
    })
    expect(semanticsFor(['xargs', 'jq', '.'])).toEqual({
      ok: false,
      reason: "What xargs adds to jq can't be checked before it runs",
    })
    // No program text after xargs → awk would read its program from stdin.
    expect(semanticsFor(['xargs', 'awk'])).toEqual({
      ok: false,
      reason: "The program xargs gives awk can't be checked before it runs",
    })
    // -F consumes the next arg as its operand → still no program text.
    expect(semanticsFor(['xargs', 'gawk', '-F', '{print}'])).toEqual({
      ok: false,
      reason: "The program xargs gives gawk can't be checked before it runs",
    })
    // Explicit program text present → falls through to the awk checks, inert.
    expect(semanticsFor(['xargs', 'awk', '{print}'])).toEqual({ ok: true })
    // `--` with a following operand counts as program text.
    expect(semanticsFor(['xargs', 'awk', '--', '{print}'])).toEqual({
      ok: true,
    })
    // xargs with its own flags is NOT stripped (official: only when argv[1]
    // is not a flag) → name stays 'xargs', inert to checkSemantics.
    expect(semanticsFor(['xargs', '-I{}', 'rm', '{}'])).toEqual({ ok: true })
  })

  test('awk program text: pyt() 5 reasons, byte-exact (@203546874)', () => {
    expect(semanticsFor(['awk', '{system("id")}'])).toEqual({
      ok: false,
      reason: 'awk program contains system() which executes arbitrary commands',
    })
    expect(semanticsFor(['awk', '{print | "sh"}'])).toEqual({
      ok: false,
      reason:
        'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands',
    })
    expect(semanticsFor(['awk', '{cmd | getline x}'])).toEqual({
      ok: false,
      reason:
        'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands',
    })
    expect(semanticsFor(['awk', '@load "ext"'])).toEqual({
      ok: false,
      reason:
        'awk program contains @load/@include or an @indirect call which can execute arbitrary code',
    })
    expect(semanticsFor(['awk', '{extension("x")}'])).toEqual({
      ok: false,
      reason:
        'awk program contains extension() which loads arbitrary native code (legacy gawk)',
    })
    expect(semanticsFor(['awk', '"/inet/tcp/80/host/path"'])).toEqual({
      ok: false,
      reason:
        'awk program opens a gawk /inet/ network socket which can exfiltrate data',
    })
    // Inert programs pass.
    expect(semanticsFor(['awk', '{print $1}'])).toEqual({ ok: true })
  })

  test("awk placeholder text → \"awk is given text that can't be checked before it runs\" (@203560656)", () => {
    expect(semanticsFor(['awk', '__CMDSUB_OUTPUT__'])).toEqual({
      ok: false,
      reason: "awk is given text that can't be checked before it runs",
    })
    expect(semanticsFor(['mawk', '__TRACKED_VAR__'])).toEqual({
      ok: false,
      reason: "awk is given text that can't be checked before it runs",
    })
  })

  test("awk program-file options → \"awk has an option that can't be checked before it runs\" (@203560826)", () => {
    // Official regexes verbatim: /^-[bcCghIkMnNOPrsStV]*[fEileDW]/ and
    // /^--(?:fil|e|i|lo|s|de)/.
    expect(semanticsFor(['awk', '-f', 'prog.awk'])).toEqual({
      ok: false,
      reason: "awk has an option that can't be checked before it runs",
    })
    expect(semanticsFor(['awk', '-Wfile', 'x'])).toEqual({
      ok: false,
      reason: "awk has an option that can't be checked before it runs",
    })
    expect(semanticsFor(['gawk', '--file=x'])).toEqual({
      ok: false,
      reason: "awk has an option that can't be checked before it runs",
    })
    expect(semanticsFor(['gawk', '--include=x'])).toEqual({
      ok: false,
      reason: "awk has an option that can't be checked before it runs",
    })
    // -F (field separator) is not a program-file option → inert.
    expect(semanticsFor(['awk', '-F:', '{print}'])).toEqual({ ok: true })
  })

  test("generic process wrappers (W4 @203547944) → \"What '<w>' starts can't be checked before it runs\" (@203561860)", () => {
    for (const w of [
      'watch',
      'ionice',
      'chrt',
      'setsid',
      'taskset',
      'strace',
      'ltrace',
      'script',
      'flock',
      'unshare',
      'nsenter',
    ]) {
      expect(semanticsFor([w, 'rm', '-rf', 'x'])).toEqual({
        ok: false,
        reason: `What '${w}' starts can't be checked before it runs`,
      })
    }
    // Bare wrapper with no args is inert (official: t.length>1 gate).
    expect(semanticsFor(['watch'])).toEqual({ ok: true })
  })

  test('basename normalization strips path-prefixed wrappers (official l=t[0].replace)', () => {
    expect(semanticsFor(['/usr/bin/timeout', '--bogus', '5', 'x'])).toEqual({
      ok: false,
      reason: "'timeout --bogus' can't be checked before it runs",
    })
    // /bin/time strips to name='rm' — inert to checkSemantics.
    expect(semanticsFor(['/bin/time', 'rm', '-rf', 'x'])).toEqual({ ok: true })
    expect(semanticsFor(['/usr/bin/command', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
  })

  test('nested wrappers strip recursively (official for(;;) loop)', () => {
    expect(semanticsFor(['command', 'timeout', '5', 'eval', 'x'])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    expect(semanticsFor(['xargs', 'watch', 'rm'])).toEqual({
      ok: false,
      reason: "What 'watch' starts can't be checked before it runs",
    })
  })
})
