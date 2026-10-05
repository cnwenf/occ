import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool'
import {
  _checkSandboxAutoAllowForTesting,
  _matchingRulesForInputForTesting,
  stripLeadingEnvAssignmentsQuoteAware,
} from '../bashPermissions'

/**
 * CC 2.1.289 changelog #14 (SECURITY) port — byte-verified against the
 * official v289 binary fix @210022797 (variant-builder condition
 * `be[0]!==ye[0]` → `(be[0]!==ye[0]||(h?.envVars.length??0)>0)`):
 *
 *   "Fixed Bash deny and ask rules missing a command behind an environment
 *    variable prefix with an expanded value (e.g. `TZ="$HOME" rm -rf build`)
 *    when the sandbox auto-allows commands"
 *
 * Root cause (shared with official v288): ENV_VAR_PATTERN in
 * stripAllLeadingEnvVars refuses `$`/backtick values (ReDoS guard, CodeQL
 * #671), so deny/ask rule matching never sees the command behind an
 * expanded-value env prefix, and checkSandboxAutoAllow then auto-allows it
 * (splitCommand yields 1 part → no per-subcommand deny recheck).
 *
 * Test matrix per docs/gap-research-289/cluster-a-bash-permissions.md #14.
 */

function ctxWith(
  rules: { deny?: string[]; ask?: string[]; allow?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { userSettings: rules.allow ?? [] },
    alwaysDenyRules: { userSettings: rules.deny ?? [] },
    alwaysAskRules: { userSettings: rules.ask ?? [] },
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function denyMatches(command: string, deny: string[]): boolean {
  const r = _matchingRulesForInputForTesting(
    { command },
    ctxWith({ deny }),
    'prefix',
  )
  return r.matchingDenyRules.length > 0
}

describe('CC 2.1.289 #14: deny rules see commands behind expanded-value env prefixes', () => {
  test('TZ="$HOME" rm -rf build + deny Bash(rm *) → deny', () => {
    expect(denyMatches('TZ="$HOME" rm -rf build', ['Bash(rm *)'])).toBe(true)
  })

  test('TZ="$HOME" rm -rf build + deny Bash(rm:*) → deny (prefix rule form)', () => {
    expect(denyMatches('TZ="$HOME" rm -rf build', ['Bash(rm:*)'])).toBe(true)
  })

  test('TZ=$HOME rm -rf build (unquoted expansion) + deny Bash(rm *) → deny', () => {
    expect(denyMatches('TZ=$HOME rm -rf build', ['Bash(rm *)'])).toBe(true)
  })

  test('FOO=$(pwd) rm -rf build (command-substitution value) + deny Bash(rm *) → deny', () => {
    expect(denyMatches('FOO=$(pwd) rm -rf build', ['Bash(rm *)'])).toBe(true)
  })

  test('FOO=`pwd` rm -rf build (backtick value) + deny Bash(rm *) → deny', () => {
    expect(denyMatches('FOO=`pwd` rm -rf build', ['Bash(rm *)'])).toBe(true)
  })

  test('A=1 B="$X" rm x (stacked literal + expanded prefixes) + deny Bash(rm *) → deny', () => {
    expect(denyMatches('A=1 B="$X" rm x', ['Bash(rm *)'])).toBe(true)
  })

  test('control: TZ=UTC rm -rf build (literal value, already handled) + deny Bash(rm *) → deny', () => {
    expect(denyMatches('TZ=UTC rm -rf build', ['Bash(rm *)'])).toBe(true)
  })

  test('control: FOO=1 echo hi + deny Bash(rm *) → NOT denied (benign)', () => {
    expect(denyMatches('FOO=1 echo hi', ['Bash(rm *)'])).toBe(false)
  })

  test('control: echo "$HOME" + deny Bash(rm *) → NOT denied (no assignment prefix)', () => {
    expect(denyMatches('echo "$HOME"', ['Bash(rm *)'])).toBe(false)
  })

  test('unterminated quote A="x rm y → fail-closed: no crash, scanner pushes no variant', () => {
    expect(() => denyMatches('A="x rm y', ['Bash(rm *)'])).not.toThrow()
    expect(denyMatches('A="x rm y', ['Bash(rm *)'])).toBe(false)
  })

  test('unterminated substitution FOO=$(pwd rm -rf build → fail-closed: no crash', () => {
    expect(() => denyMatches('FOO=$(pwd rm -rf build', ['Bash(rm *)'])).not.toThrow()
  })
})

describe('CC 2.1.289 #14: ask rules see commands behind expanded-value env prefixes', () => {
  test('TZ="$HOME" npm publish x + ask Bash(npm publish:*) → ask', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'TZ="$HOME" npm publish x' },
      ctxWith({ ask: ['Bash(npm publish:*)'] }),
      'prefix',
    )
    expect(r.matchingAskRules.length).toBeGreaterThan(0)
  })
})

describe('CC 2.1.289 #14: no new ALLOW surface (deny/ask-only variant)', () => {
  test('DOCKER_HOST="$X" docker ps + allow Bash(docker ps:*) → allow NOT matched', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'DOCKER_HOST="$X" docker ps' },
      ctxWith({ allow: ['Bash(docker ps:*)'] }),
      'prefix',
    )
    expect(r.matchingAllowRules.length).toBe(0)
  })
})

describe('CC 2.1.289 #14: sandbox auto-allow path (checkSandboxAutoAllow, 1-part command)', () => {
  test('TZ="$HOME" rm -rf build + deny Bash(rm *) → deny (auto-allow must not fire)', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'TZ="$HOME" rm -rf build' },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('TZ=$HOME rm -rf build + deny Bash(rm *) → deny', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'TZ=$HOME rm -rf build' },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('FOO=$(pwd) rm -rf build + deny Bash(rm *) → deny', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'FOO=$(pwd) rm -rf build' },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('TZ="$HOME" npm publish x + ask Bash(npm publish:*) → ask', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'TZ="$HOME" npm publish x' },
      ctxWith({ ask: ['Bash(npm publish:*)'] }),
    )
    expect(result.behavior).toBe('ask')
  })

  test('echo "$HOME" + deny Bash(rm *) → allow (no false positive, auto-allow stands)', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'echo "$HOME"' },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('allow')
  })

  test('unterminated quote FOO="$BAR + deny Bash(rm *) → no crash (fail-closed scanner)', () => {
    expect(() =>
      _checkSandboxAutoAllowForTesting(
        { command: 'FOO="$BAR' },
        ctxWith({ deny: ['Bash(rm *)'] }),
      ),
    ).not.toThrow()
  })
})

/**
 * OCC-107 acceptance-fix round (2026-10-05) — the two probes from the
 * acceptance verdict promoted to formal tests, all ground-truthed against
 * local /bin/bash:
 *
 * ① fail-open: `TZ=$'a\' b' rm x` — inside an ANSI-C `$'…'` string, `\'`
 *    is a literal quote and the string CONTINUES (bash runs `rm x` with
 *    TZ=`a' b`). The shipped scanner closed the string at the escaped quote
 *    and returned the mis-cut remainder `b' rm x`, which does not match
 *    `Bash(rm *)` → sandbox auto-allow fired → deny rule dropped.
 *
 * ② false-deny: `FOO=x|grep rm file` — a bare (unquoted) metacharacter
 *    ENDS the assignment word in bash, so `grep rm file` runs, NOT `rm`.
 *    The shipped value scan swallowed the `|` and produced the candidate
 *    `rm file` → `Bash(rm *)` falsely denied a legitimate grep.
 *
 * Fix semantics (bash-tokenization-faithful, matching what the official
 * 2.1.289 AST-side compensation achieves):
 *  - `$'…'` ANSI-C values honor backslash escapes (bare `'…'` does not).
 *  - bare `;` `|` `&` `(` in the value scan → null (fail-closed; deny
 *    coverage for the segments after the separator comes from the
 *    splitCommand per-subcommand recheck, which is where bash actually
 *    cuts them).
 *  - redirections (`<` `>` `&>` `<>` `<<` `>|` `>&N`, incl. space-separated
 *    targets and process substitutions) are SKIPPED — bash ground truth:
 *    the trailing command still runs, so a blanket null here would CREATE
 *    new fail-opens.
 *  - value-start `(…)` array assignments (`A=(1) rm x`) are consumed —
 *    bash runs the trailing command, so deny coverage must survive.
 */
describe('OCC-107 acceptance-fix ①: ANSI-C $\'…\' escaped quote (fail-open → correct remainder)', () => {
  test("scanner: TZ=$'a\\' b' rm x → 'rm x' (bash: escaped quote does NOT close the string; rm x runs)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware("TZ=$'a\\' b' rm x")).toBe('rm x')
  })

  test("scanner: unterminated ANSI-C TZ=$'a\\ rm x → null (bash: syntax error; fail-closed)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware("TZ=$'a\\ rm x")).toBe(null)
  })

  test("scanner: bare quotes still treat backslash literally — A='a\\' rm x → 'rm x'", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware("A='a\\' rm x")).toBe('rm x')
  })

  test("scanner: ANSI-C escape sequences — A=$'\\n\\t' rm x → 'rm x'", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware("A=$'\\n\\t' rm x")).toBe('rm x')
  })

  test("verdict probe ①: TZ=$'a\\' b' rm x + deny Bash(rm *) under sandbox auto-allow → deny (was allow = fail-open)", () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: "TZ=$'a\\' b' rm x" },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test("verdict probe ①: TZ=$'a\\' b' rm x + deny Bash(rm *) → deny rule matches (rule-matching layer)", () => {
    expect(denyMatches("TZ=$'a\\' b' rm x", ['Bash(rm *)'])).toBe(true)
  })
})

describe('OCC-107 acceptance-fix ②: bare metacharacters end the assignment word (false-deny fix)', () => {
  test("scanner: FOO=x|grep rm file → null (bash runs `grep rm file`; no `rm` candidate)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=x|grep rm file')).toBe(null)
  })

  test('verdict probe ②: FOO=x|grep rm file + deny Bash(rm *) → NOT denied (was falsely denied)', () => {
    expect(denyMatches('FOO=x|grep rm file', ['Bash(rm *)'])).toBe(false)
  })

  test("scanner: FOO=bar|rm x → null (bash pipeline: assignment feeds segment 1 only)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=bar|rm x')).toBe(null)
  })

  test('verdict twin pin: FOO=bar|rm x + deny Bash(rm *) → still deny via splitCommand backstop (rm DOES run as 2nd segment)', () => {
    const result = _checkSandboxAutoAllowForTesting(
      { command: 'FOO=bar|rm x' },
      ctxWith({ deny: ['Bash(rm *)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('scanner: bare semicolon FOO=a;rm x → null', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a;rm x')).toBe(null)
  })

  test('scanner: bare and-list FOO=a&&rm x → null', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a&&rm x')).toBe(null)
  })

  test('scanner: bare background FOO=a&rm x → null', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a&rm x')).toBe(null)
  })

  test('scanner: mid-value paren FOO=x(y) rm z → null (bash: syntax error)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=x(y) rm z')).toBe(null)
  })

  test('scanner: double array A=(1)(2) rm x → null (bash: syntax error)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('A=(1)(2) rm x')).toBe(null)
  })
})

describe('OCC-107 acceptance-fix ②: redirections/arrays in the prefix keep deny coverage (bash: trailing command RUNS)', () => {
  test('scanner: FOO=a<b rm x → rm x (input redirect)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a<b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a>b rm x → rm x (output redirect)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a>b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a> b rm x → rm x (space-separated redirect target)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a> b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a<>b rm x → rm x (read-write redirect)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a<>b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a<<EOF rm x → rm x (heredoc marker)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a<<EOF rm x')).toBe('rm x')
  })

  test('scanner: FOO=a>|b rm x → rm x (noclobber override)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a>|b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a&>b rm x → rm x (combined redirect)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a&>b rm x')).toBe('rm x')
  })

  test('scanner: FOO=a>&1 rm x → rm x (fd dup)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a>&1 rm x')).toBe('rm x')
  })

  test('scanner: A=(1) rm x → rm x (array assignment prefix is a legal env prefix)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('A=(1) rm x')).toBe('rm x')
  })

  test('scanner: A=(1 2) rm x → rm x (array with inner spaces)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('A=(1 2) rm x')).toBe('rm x')
  })

  test("scanner: A=(x'y'z) rm q → rm q (quoted array elements)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware("A=(x'y'z) rm q")).toBe('rm q')
  })

  test('scanner: A=(1 rm x → null (unterminated array; fail-closed)', () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('A=(1 rm x')).toBe(null)
  })

  test("scanner: FOO=a> rm x → 'x' (bash: `rm` is the redirect TARGET; the command is `x`)", () => {
    expect(stripLeadingEnvAssignmentsQuoteAware('FOO=a> rm x')).toBe('x')
  })
})
