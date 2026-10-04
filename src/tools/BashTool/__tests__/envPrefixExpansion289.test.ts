import { afterAll, describe, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import {
  _matchingRulesForInputForTesting,
  bashToolHasPermission,
  BINARY_HIJACK_VARS,
  stripAllLeadingEnvVars,
} from '../bashPermissions.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code 2.1.289 security fixes #13/#14:
 *   #13: "Bash deny and ask rules were not applied to a command behind an
 *        environment-variable prefix with an expanded value (e.g.
 *        TZ=\"$HOME\" rm -rf build) — the command could be auto-allowed
 *        when sandboxing is enabled."
 *   #14: same class of bypass via a bare variable assignment prefix.
 *
 * Official fix (byte-verified against the 2.1.288/2.1.289 linux-x64 ELFs):
 * the sandbox deny/ask matcher `b5o` re-runs per-subcommand deny/ask against
 * the AST-normalized text — condition widened from `if(r.length>1)` to
 * `if(r.length>1||r[0]?.text!==s)` where `s = e.command.trim()` — and the AST
 * (`walkCommand`) rebuilds `.text` from argv WITHOUT the env assignments, so
 * `TZ="$HOME" rm -rf build` is deny-checked as `rm -rf build`.
 *
 * OCC mapping: OCC's LIVE permission path is the legacy string path
 * (tree-sitter WASM unavailable at runtime — see OCC-46), whose equivalent
 * normalization is stripAllLeadingEnvVars feeding extra deny/ask candidates
 * in filterRulesByContentsMatchingInput (used by checkSandboxAutoAllow).
 * The fix widens ENV_VAR_PATTERN so simple expansions (`$VAR`, `${VAR}`,
 * quoted or unquoted) strip, while command substitution (`$(...)`, backtick)
 * still refuses to strip (conservative — official's AST recurses into inner
 * commands, a regex cannot; not stripping never removes candidates).
 */

// ── Sandbox mock (pattern per sandboxLocalBinding281.test.ts, OCC-97
//    lesson: snapshot real namespaces BEFORE mocking; flag-gated delegation
//    keeps leaked closures behavior-neutral after afterAll) ──
const actualSandboxModule = await import(
  '../../../utils/sandbox/sandbox-adapter.js'
)
const actualSandboxExports = { ...actualSandboxModule }
const actualShouldUseSandboxModule = await import('../shouldUseSandbox.js')
const actualShouldUseSandboxExports = { ...actualShouldUseSandboxModule }
const actualSandboxManager = actualSandboxExports.SandboxManager
let bindingMocksActive = true

mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualSandboxExports,
  SandboxManager: {
    ...actualSandboxExports.SandboxManager,
    isSandboxingEnabled: () =>
      bindingMocksActive
        ? true
        : actualSandboxManager.isSandboxingEnabled(),
    isAutoAllowBashIfSandboxedEnabled: () =>
      bindingMocksActive
        ? true
        : actualSandboxManager.isAutoAllowBashIfSandboxedEnabled(),
  },
}))

mock.module('../shouldUseSandbox.js', () => ({
  ...actualShouldUseSandboxExports,
  shouldUseSandbox: (input: unknown) =>
    bindingMocksActive
      ? true
      : (
          actualShouldUseSandboxExports.shouldUseSandbox as (
            i: unknown,
          ) => boolean
        )(input),
}))

afterAll(() => {
  bindingMocksActive = false
})

function makeContext(opts: {
  mode?: string
  denyRules?: readonly string[]
  askRules?: readonly string[]
} = {}): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: opts.mode ?? 'default',
      alwaysDenyRules: { userSettings: [...(opts.denyRules ?? [])] },
      alwaysAskRules: { userSettings: [...(opts.askRules ?? [])] },
    },
  } as never
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

// ── 1. stripAllLeadingEnvVars unit behavior ──

describe('2.1.289 #13/#14 — stripAllLeadingEnvVars expansion handling', () => {
  test('strips double-quoted $VAR expansion prefix (the #13 vector)', () => {
    expect(stripAllLeadingEnvVars('TZ="$HOME" rm -rf build')).toBe(
      'rm -rf build',
    )
  })

  test('strips double-quoted ${VAR} brace expansion prefix', () => {
    expect(stripAllLeadingEnvVars('TZ="${HOME}" rm -rf build')).toBe(
      'rm -rf build',
    )
  })

  test('strips unquoted $VAR expansion prefix', () => {
    expect(stripAllLeadingEnvVars('TZ=$HOME rm -rf build')).toBe(
      'rm -rf build',
    )
  })

  test('strips unquoted ${VAR} brace expansion prefix', () => {
    expect(stripAllLeadingEnvVars('TZ=${HOME} rm -rf build')).toBe(
      'rm -rf build',
    )
  })

  test('strips expansion inside a concatenated unquoted value', () => {
    expect(stripAllLeadingEnvVars('FOO=$HOME/bin ls -la')).toBe('ls -la')
  })

  test('strips multiple mixed prefixes ending in the real command', () => {
    expect(stripAllLeadingEnvVars('A=1 B="$HOME" C=$PWD rm x')).toBe('rm x')
  })

  test('bare literal prefix still strips (#14 regression guard)', () => {
    expect(stripAllLeadingEnvVars('FOO=bar rm -rf build')).toBe(
      'rm -rf build',
    )
  })

  test('command substitution in double quotes does NOT strip', () => {
    const cmd = 'FOO="$(rm -rf /)" echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd)
  })

  test('command substitution unquoted does NOT strip', () => {
    const cmd = 'FOO=$(date) echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd)
  })

  test('backtick substitution in double quotes does NOT strip', () => {
    const cmd = 'FOO="`date`" echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd)
  })

  test('arithmetic expansion does NOT strip', () => {
    const cmd = 'FOO=$((1+2)) echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd)
  })

  test('blocklist still stops stripping at a hijack var', () => {
    const cmd = 'PATH="$HOME" rm x'
    expect(stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)).toBe(cmd)
  })

  test('stripping is linear on pathological input (CodeQL #671 guard)', () => {
    const noTrailingSpace = `FOO=${'a'.repeat(20000)}`
    const start = performance.now()
    expect(stripAllLeadingEnvVars(noTrailingSpace)).toBe(noTrailingSpace)
    const manyExpansions = `FOO=${'$HOME'.repeat(5000)} ls`
    expect(stripAllLeadingEnvVars(manyExpansions)).toBe('ls')
    const dollars = `FOO=${'$'.repeat(20000)} ls`
    expect(stripAllLeadingEnvVars(dollars)).toBe(dollars)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

// ── 2. deny/ask rule matching sees through expansion prefixes ──

describe('2.1.289 #13/#14 — deny/ask rules match expansion-prefixed commands', () => {
  const ctxWith = (opts: Parameters<typeof makeContext>[0]) =>
    (makeContext(opts).getAppState() as { toolPermissionContext: never })
      .toolPermissionContext

  test('deny Bash(rm:*) matches TZ="$HOME" rm -rf build (#13)', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'TZ="$HOME" rm -rf build' } as never,
      ctxWith({ denyRules: ['Bash(rm:*)'] }),
      'prefix',
      { skipCompoundCheck: true },
    )
    expect(r.matchingDenyRules.length).toBeGreaterThan(0)
  })

  test('deny Bash(rm:*) matches unquoted TZ=$HOME rm -rf build', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'TZ=$HOME rm -rf build' } as never,
      ctxWith({ denyRules: ['Bash(rm:*)'] }),
      'prefix',
      { skipCompoundCheck: true },
    )
    expect(r.matchingDenyRules.length).toBeGreaterThan(0)
  })

  test('deny Bash(rm:*) matches bare FOO=bar rm -rf build (#14)', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'FOO=bar rm -rf build' } as never,
      ctxWith({ denyRules: ['Bash(rm:*)'] }),
      'prefix',
      { skipCompoundCheck: true },
    )
    expect(r.matchingDenyRules.length).toBeGreaterThan(0)
  })

  test('ask Bash(curl:*) matches expansion-prefixed curl', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'TZ="$HOME" curl http://evil.example' } as never,
      ctxWith({ askRules: ['Bash(curl:*)'] }),
      'prefix',
      { skipCompoundCheck: true },
    )
    expect(r.matchingAskRules.length).toBeGreaterThan(0)
  })

  test('command substitution prefix: no deny match — but see full-path ask guard below', () => {
    const r = _matchingRulesForInputForTesting(
      { command: 'FOO="$(rm -rf /)" echo hi' } as never,
      ctxWith({ denyRules: ['Bash(rm:*)'] }),
      'prefix',
      { skipCompoundCheck: true },
    )
    // Documents the conservative residue: the env-prefix stripper cannot
    // expose the inner command (official's AST path checks it as a separate
    // command). Not stripped → the full command is the only candidate and
    // `rm:*` (prefix rule) does not match it. Tracked in the gap ledger.
    expect(r.matchingDenyRules.length).toBe(0)
  })
})

// ── 3. Full permission path with sandbox auto-allow enabled ──

describe('2.1.289 #13 — sandbox auto-allow no longer bypasses deny rules', () => {
  test('deny rule wins over sandbox auto-allow for expansion prefix', async () => {
    const result = await bashToolHasPermission(
      { command: 'TZ="$HOME" rm -rf build', description: '' } as never,
      makeContext({ denyRules: ['Bash(rm:*)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('deny rule wins over sandbox auto-allow for unquoted expansion', async () => {
    const result = await bashToolHasPermission(
      { command: 'TZ=$HOME rm -rf build', description: '' } as never,
      makeContext({ denyRules: ['Bash(rm:*)'] }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('ask rule prompts instead of auto-allowing for expansion prefix', async () => {
    const result = await bashToolHasPermission(
      { command: 'TZ="$HOME" curl http://evil.example', description: '' } as never,
      makeContext({ askRules: ['Bash(curl:*)'] }),
    )
    expect(result.behavior).toBe('ask')
  })

  test('benign expansion-prefixed command still auto-allows under sandbox', async () => {
    const result = await bashToolHasPermission(
      { command: 'TZ="$HOME" ls -la', description: '' } as never,
      makeContext({}),
    )
    expect(result.behavior).toBe('allow')
    const reason = (result as { decisionReason?: { reason?: string } })
      .decisionReason?.reason
    expect(reason).toContain('Auto-allowed with sandbox')
  })
})
