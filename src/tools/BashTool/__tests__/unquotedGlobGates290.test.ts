import { describe, expect, test } from 'bun:test'
import {
  checkSemantics,
  parseForSecurityFromAst,
  type SimpleCommand,
} from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * CC 2.1.290 port: unquoted-glob machinery for the awk/find semantic gates.
 *
 * Official mechanisms ported verbatim (2.1.290 bash-security module):
 *  - `T()`/`I()`  — quote-aware whole-text unquoted-glob scanner
 *    → SimpleCommand.hasUnquotedGlob (2.1.289 producer, set at EVERY
 *    SimpleCommand construction site).
 *  - `St`/`V()`   — resolved-arg glob matcher `/[*?]|\[[^\]]*\]/`.
 *  - `me()`       — per-node-type unquoted-glob check (word/number raw
 *    scan; string/raw_string/simple_expansion/arithmetic_expansion false;
 *    concatenation any-child; default true).
 *  - `Kt` producer — per-arg `argvUnquotedGlob` record: word-like nodes
 *    `I(u.text)||me(u)`, bare `$VAR` always true.
 *  - `gt`/`N`     — cat-heredoc carve-out counter → `carveOutMayDesyncQuoteScan`
 *    when the substitution text contains `"` / backtick / backslash.
 *  - `kAn()`      — consumer combining record + desync flag + placeholders.
 *  - `Hor` gates  — awk-family FIRST branch `o.hasUnquotedGlob||r&&kAn(o)`
 *    ("awk command contains unquoted glob characters — could glob-expand to
 *    a planted program or flag before awk runs"); find FIRST branch
 *    (same shape, "find contains unquoted glob characters — could
 *    glob-expand to a dangerous action before find runs").
 *  - find block   — NEW in 2.1.290 per-arg glob check ("find argument '…'
 *    contains glob characters — …"); the action/version-divergent/
 *    runtime-determined branches existed in 2.1.289 but were never ported
 *    to OCC (the v288 #72 STAGED note understated the gap).
 *
 * Reason strings below are byte-identical to the official 2.1.290 binary
 * (extracted from the linux-x64 ELF payload; see gap ledger
 * docs/upstream-version-gap-occ148-2026-10.md).
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

function semanticsOf(cmd: string) {
  const r = parseSecurity(cmd)
  expect(r.kind).toBe('simple')
  if (r.kind !== 'simple') throw new Error(`not simple: ${r.reason}`)
  return { result: checkSemantics(r.commands), commands: r.commands }
}

const AWK_GLOB_REASON =
  'awk command contains unquoted glob characters — could glob-expand to a planted program or flag before awk runs'
const FIND_GLOB_REASON =
  'find contains unquoted glob characters — could glob-expand to a dangerous action before find runs'

describe('2.1.289 producer: hasUnquotedGlob (official T/I scanner)', () => {
  test('unquoted * in source → true', () => {
    const r = parseSecurity("awk '{print}' *.txt")
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(true)
  })

  test('unquoted [ ] class in source → true', () => {
    const r = parseSecurity('echo [ab]')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(true)
  })

  test('double-quoted glob → false', () => {
    const r = parseSecurity('echo "*"')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
  })

  test('single-quoted glob → false', () => {
    const r = parseSecurity("echo '*'")
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
  })

  test('backslash-escaped glob → false', () => {
    const r = parseSecurity('echo \\*')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
  })

  test('glob inside trailing comment → false (# at word start)', () => {
    const r = parseSecurity('echo ok # *')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
  })

  test('plain command → false', () => {
    const r = parseSecurity("awk '{print $1}' file.txt")
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
  })

  test('declaration_command site also sets the field', () => {
    const r = parseSecurity('declare x=1')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
      // CC 2.1.290: official declaration site also carries the carve-out flag.
      expect(r.commands[0]!.carveOutMayDesyncQuoteScan).toBe(false)
    }
  })

  test('test_command site also sets the field ([ is an unquoted glob char)', () => {
    // Official `I(e.text)` scans the WHOLE text — the literal `[` operator
    // counts as an unquoted glob char, so test_command sites report true.
    // Faithful to the binary; harmless because test_command never reaches
    // the awk/find gates.
    const r = parseSecurity('[ -f file.txt ]')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]!.hasUnquotedGlob).toBe(true)
      expect(r.commands[0]!.carveOutMayDesyncQuoteScan).toBe(false)
    }
  })

  test('unset_command site also sets the fields', () => {
    const r = parseSecurity('unset FOO')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]!.hasUnquotedGlob).toBe(false)
      expect(r.commands[0]!.carveOutMayDesyncQuoteScan).toBe(false)
    }
  })
})

describe('2.1.290 producer: argvUnquotedGlob record (official Kt)', () => {
  test('record is parallel to argv; quoted args record false', () => {
    const r = parseSecurity("awk '{print}' '*.txt'")
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      const cmd = r.commands[0]!
      expect(cmd.argv).toEqual(['awk', '{print}', '*.txt'])
      expect(cmd.argvUnquotedGlob).toEqual([false, false, false])
    }
  })

  test('unquoted glob word records true', () => {
    const r = parseSecurity('echo *.txt')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      expect(r.commands[0]!.argvUnquotedGlob).toEqual([false, true])
    }
  })

  test('cat-heredoc carve-out with double-quote in body sets carveOutMayDesyncQuoteScan', () => {
    const cmd = 'printf "%s" "$(cat <<\'EOF\'\nsay "hi"\nEOF\n)"'
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple')
      expect(r.commands[0]!.carveOutMayDesyncQuoteScan).toBe(true)
  })

  test('cat-heredoc carve-out without quote/backtick/backslash leaves the flag false', () => {
    const cmd = 'printf "%s" "$(cat <<\'EOF\'\nhello\nEOF\n)"'
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple')
      expect(r.commands[0]!.carveOutMayDesyncQuoteScan).toBe(false)
  })
})

describe('2.1.289/290 awk-family gate (official Hor first branch)', () => {
  test('awk with unquoted glob → rejected, verbatim reason', () => {
    expect(semanticsOf("awk '{print}' *").result).toEqual({
      ok: false,
      reason: AWK_GLOB_REASON,
    })
  })

  test('awk with unquoted ? glob → rejected', () => {
    expect(semanticsOf('awk prog?').result).toEqual({
      ok: false,
      reason: AWK_GLOB_REASON,
    })
  })

  test('gawk (family member) with unquoted glob → rejected', () => {
    expect(semanticsOf("gawk '{print}' *.c").result).toEqual({
      ok: false,
      reason: AWK_GLOB_REASON,
    })
  })

  test('wrapper stripped first: timeout 5 awk … * → still rejected via cmd text', () => {
    expect(semanticsOf("timeout 5 awk '{print}' *").result).toEqual({
      ok: false,
      reason: AWK_GLOB_REASON,
    })
  })

  test('quoted globs pass the gate', () => {
    expect(semanticsOf("awk '{print}' '*.txt'").result).toEqual({ ok: true })
  })

  test('plain awk program passes', () => {
    expect(semanticsOf("awk '{print $1}' file.txt").result).toEqual({
      ok: true,
    })
  })

  test('sourceGlobRecord:false disables the kAn half but keeps hasUnquotedGlob', () => {
    // Synthetic: no whole-text glob, no per-arg record, placeholder+glob in
    // a resolved arg → kAn conservative branch fires only when the record
    // is honored (official `r=t?.sourceGlobRecord!==!1`).
    const cmd: SimpleCommand = {
      argv: ['awk', 'prog', 'x[y]__CMDSUB_OUTPUT__'],
      envVars: [],
      redirects: [],
      text: 'awk prog x[y]$(whoami)',
      hasUnquotedGlob: false,
    }
    const withRecord = checkSemantics([cmd])
    expect(withRecord).toEqual({ ok: false, reason: AWK_GLOB_REASON })
    const withoutRecord = checkSemantics([cmd], { sourceGlobRecord: false })
    // Gate off → falls through to the existing placeholder check.
    expect(withoutRecord).toEqual({
      ok: false,
      reason: "awk is given text that can't be checked before it runs",
    })
  })
})

describe('2.1.289/290 find gate + block (official Hor find section)', () => {
  test('find with unquoted glob → gate reason', () => {
    expect(semanticsOf('find * -print').result).toEqual({
      ok: false,
      reason: FIND_GLOB_REASON,
    })
  })

  test('find -delete → action reason (cannot be auto-allowed by prefix rule)', () => {
    expect(semanticsOf('find . -delete').result).toEqual({
      ok: false,
      reason:
        "find with '-delete' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule",
    })
  })

  test('find -exec → action reason', () => {
    expect(semanticsOf('find . -exec rm {} \\;').result).toEqual({
      ok: false,
      reason:
        "find with '-exec' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule",
    })
  })

  test('find -rm → action reason (warm-sunrise gate defaults on)', () => {
    expect(semanticsOf('find . -rm').result).toEqual({
      ok: false,
      reason:
        "find with '-rm' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule",
    })
  })

  test('find -df → version-divergent reason', () => {
    expect(semanticsOf('find . -df').result).toEqual({
      ok: false,
      reason:
        "find option '-df' is read differently by different versions of find — could hide a following action",
    })
  })

  test('find arg with runtime-determined content → runtime-determined reason', () => {
    expect(semanticsOf('find . "x$(whoami)"').result).toEqual({
      ok: false,
      reason:
        'find argument is runtime-determined — could resolve to a dangerous action',
    })
  })

  test('NEW 2.1.290: resolved arg carrying glob chars (quoted in source) → per-arg reason', () => {
    // Whole-text scan sees only quoted globs (gate passes); the official
    // 2.1.290 per-arg check catches the RESOLVED value.
    const r = parseSecurity('VAR=x; find . "$VAR*"')
    expect(r.kind).toBe('simple')
    if (r.kind === 'simple') {
      const sem = checkSemantics(r.commands)
      expect(sem).toEqual({
        ok: false,
        reason:
          "find argument 'x*' contains glob characters — could glob-expand to a dangerous action",
      })
    }
  })

  test('benign find with -name value + -print passes', () => {
    expect(semanticsOf("find . -name '*.c' -print").result).toEqual({
      ok: true,
    })
  })

  test('named-value option skips its value: find . -size +10 -print passes', () => {
    expect(semanticsOf('find . -size +10 -print').result).toEqual({ ok: true })
  })

  test('wrapper stripped: timeout 5 find . -delete → action reason', () => {
    expect(semanticsOf('timeout 5 find . -delete').result).toEqual({
      ok: false,
      reason:
        "find with '-delete' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule",
    })
  })
})

describe('2.1.290 no-FP: gate is scoped to awk family + find', () => {
  test('ls with unquoted glob still passes checkSemantics', () => {
    expect(semanticsOf('ls *.ts').result).toEqual({ ok: true })
  })

  test('grep with quoted pattern still passes', () => {
    expect(semanticsOf('grep -rn "pattern" src/').result).toEqual({ ok: true })
  })

  test('find with zero args beyond name passes', () => {
    expect(semanticsOf('find .').result).toEqual({ ok: true })
  })
})
