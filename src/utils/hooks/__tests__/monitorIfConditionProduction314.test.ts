import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

// MACRO.VERSION polyfill — mirrors repo convention (transitive imports read it).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * 2.1.408 acceptance review P2-2 — PRODUCTION TRUTH for hook `if:` command
 * content narrowing, with NO mock on the parse seam.
 *
 * In production builds `TREE_SITTER_BASH` / `TREE_SITTER_BASH_SHADOW` are not
 * in the 6-flag FEATURE_ALLOWLIST (src/utils/featureFlags.ts), so
 * parseCommandRaw returns null for every command and parseForSecurity yields
 * `{kind:'parse-unavailable'}`. Both BashTool's and MonitorTool's
 * preparePermissionMatcher then fail-safe to `() => true`, and
 * prepareIfConditionMatcher KEEPS the hook for any parenthesized rule
 * content. Content narrowing (`Monitor(tail *)` vs `Monitor(git *)`) is
 * therefore dormant in production; the tool-NAME half of the if-condition
 * (own name + Bash family for Monitor shell commands) is structural and
 * stays live.
 *
 * This file pins that exact behavior WITHOUT mocking `../../bash/ast.js`
 * (unlike monitorIfCondition314.test.ts, which exercises the official Gjr
 * narrowing logic through a mocked parse seam). If a future round ships
 * tree-sitter in the allowlist, the assertions here MUST flip — that is the
 * point: the dormancy is a recorded platform state, not an accident.
 */

// --- Mock seam (config/trust/analytics only — the parse path stays REAL;
// Bun's mock.module leaks across files, so spread + restore, per the
// hookConcurrencyCap302 pattern). ---
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
const actualConfigModule = await import('../../config.js')
const actualAnalyticsModule = await import(
  '../../../services/analytics/index.js'
)

let mockedHooksConfig: HooksSettings | null = null

mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
}))
mock.module('../../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: () => {},
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
})

const { getMatchingHooks } = await import('../../hooks.js')
const { MonitorTool } = await import('../../../tools/MonitorTool/MonitorTool.js')
const { parseForSecurity } = await import('../../bash/ast.js')
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')

beforeAll(() => {
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
})

type PreparePermissionMatcher = (
  input: never,
) => Promise<(pattern: string) => boolean>

const prepare = (MonitorTool as unknown as {
  preparePermissionMatcher?: PreparePermissionMatcher
}).preparePermissionMatcher

function monitorInput(extra: Record<string, unknown> = {}): never {
  return {
    command: 'tail -f app.log',
    description: 'tail the app log',
    ...extra,
  } as never
}

describe('2.1.408 review P2-2 — production precondition: parseForSecurity is parse-unavailable (unmocked)', () => {
  test('a plain, benign command still parses as parse-unavailable in this build', async () => {
    const parsed = await parseForSecurity('tail -f app.log')
    expect(parsed.kind).toBe('parse-unavailable')
  })

  test('a compound command is parse-unavailable too', async () => {
    const parsed = await parseForSecurity('ls && git push')
    expect(parsed.kind).toBe('parse-unavailable')
  })
})

describe('2.1.408 review P2-2 — MonitorTool.preparePermissionMatcher production shape (unmocked)', () => {
  test('fails safe to () => true for EVERY pattern when the command cannot be parsed', async () => {
    const matcher = await prepare?.call(MonitorTool, monitorInput())
    expect(matcher).toBeTypeOf('function')
    // Content narrowing is dormant: `tail *` "matches" — but so does
    // everything else. The mocked-seam suite pins the official logic; this
    // pins the shipped behavior.
    expect(matcher?.('tail *')).toBe(true)
    expect(matcher?.('git *')).toBe(true)
    expect(matcher?.('npm *')).toBe(true)
    expect(matcher?.('')).toBe(true)
  })

  test('the $Fr gate stays LIVE without a parser: ws-only input → never match', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      {
        ws: { url: 'wss://events.example.com/stream' },
        description: 'ws events',
      } as never,
    )
    expect(matcher?.('tail *')).toBe(false)
    expect(matcher?.('*')).toBe(false)
  })

  test('empty-string command → never match ($Fr requires e.command!=="")', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      { command: '', description: 'd' } as never,
    )
    expect(matcher?.('*')).toBe(false)
  })
})

describe('2.1.408 review P2-2 — getMatchingHooks production truth (unmocked): content rules keep the hook, name rules still filter', () => {
  function configWithIf(ifCondition: string): HooksSettings {
    return {
      PreToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'echo x', if: ifCondition }],
        },
      ],
    } as unknown as HooksSettings
  }

  const monitorHookInput = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Monitor',
    tool_input: { command: 'tail -f app.log', description: 'tail logs' },
    session_id: 's-p22',
    transcript_path: '/tmp/none.jsonl',
    cwd: process.cwd(),
  } as never

  test('if "Monitor(git *)" KEEPS the hook for a tail monitor command (production fail-safe — the mocked suite\'s DROP holds only with a working parser)', async () => {
    mockedHooksConfig = configWithIf('Monitor(git *)')
    const matched = await getMatchingHooks(
      undefined,
      's-p22',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
  })

  test('if "Monitor(tail *)" also keeps the hook (matching content is indistinguishable in production)', async () => {
    mockedHooksConfig = configWithIf('Monitor(tail *)')
    const matched = await getMatchingHooks(
      undefined,
      's-p22',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
  })

  test('if "Bash(git *)" on the Monitor call keeps the hook — family NAME match is live, content narrowing dormant', async () => {
    mockedHooksConfig = configWithIf('Bash(git *)')
    const matched = await getMatchingHooks(
      undefined,
      's-p22',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
  })

  test('the tool-NAME half stays live: if "WebFetch(git *)" on a Monitor call still DROPS the hook', async () => {
    mockedHooksConfig = configWithIf('WebFetch(git *)')
    const matched = await getMatchingHooks(
      undefined,
      's-p22',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(0)
  })
})
