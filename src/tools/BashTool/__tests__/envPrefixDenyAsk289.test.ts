import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool'
import {
  _checkSandboxAutoAllowForTesting,
  _matchingRulesForInputForTesting,
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
