import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

// MACRO.VERSION polyfill — mirrors repo convention (transitive imports read it).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * claude-code 2.1.314 item 89 (WP-B cluster):
 *   "Changed hook `if` conditions such as `Monitor(tail *)` to match the
 *    Monitor tool's shell commands as `Bash(tail *)` matches Bash's."
 *
 * Byte-verified against the official v314 linux-x64 binary. The Monitor tool
 * definition GREW a preparePermissionMatcher (v314 ELF @260931165):
 *
 *   async preparePermissionMatcher(e){let n=$Fr(e);return n===void 0?()=>!1:Gjr(n)}
 *
 * where `$Fr` (v314 ELF @253917406) extracts the non-empty string command:
 *
 *   function $Fr(e){return typeof e==="object"&&e!==null&&"command"in e&&
 *     typeof e.command==="string"&&e.command!==""?e.command:void 0}
 *
 * and `Gjr` (v314 ELF @257866096) is the SHARED command matcher also used by
 * the Bash tool def (v314 ELF @257927607:
 * `async preparePermissionMatcher({command:e}){return Gjr(e)}`) — which is
 * exactly the changelog's "as `Bash(tail *)` matches Bash's". v312's Monitor
 * def (v312 ELF @256378924 region) goes isEnabled→isConcurrencySafe directly
 * with NO preparePermissionMatcher, and v312 has no `$Fr` — both NEW in v314.
 *
 * OCC wiring: prepareIfConditionMatcher (src/utils/hooks.ts) already consults
 * `tool?.preparePermissionMatcher(input.data)`, so adding the official matcher
 * to the MonitorTool def makes `if: "Monitor(tail *)"` work end-to-end.
 * The Gjr body is mirrored from OCC's BashTool.tsx inline matcher (that file
 * is out-of-cluster for edits; official shares ONE Gjr between both defs).
 */

// --- Mock seam (Bun's mock.module leaks across files — spread the real
// module, override narrowly, restore in afterAll; hookConcurrencyCap302
// pattern). ---
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
const actualConfigModule = await import('../../config.js')
const actualAnalyticsModule = await import(
  '../../../services/analytics/index.js'
)
const actualAstModule = await import('../../bash/ast.js')

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
// tree-sitter sits behind the dead TREE_SITTER_BASH feature flag in OCC, so
// the real parseForSecurity always returns 'parse-unavailable' here (the same
// dormant-AST condition BashTool's matcher lives under). Mock the parse seam
// to exercise the official Gjr matcher LOGIC (simple-split + argv join);
// a dedicated test below pins the real parse-unavailable fail-safe.
const FAKE_SIMPLE_PARSES: Record<
  string,
  { kind: 'simple'; commands: { argv: string[] }[] }
> = {
  'tail -f app.log': {
    kind: 'simple',
    commands: [{ argv: ['tail', '-f', 'app.log'] }],
  },
  'ls && git push': {
    kind: 'simple',
    commands: [{ argv: ['ls'] }, { argv: ['git', 'push'] }],
  },
  'FOO=bar git push': {
    kind: 'simple',
    commands: [{ argv: ['git', 'push'] }],
  },
}
mock.module('../../bash/ast.js', () => ({
  ...actualAstModule,
  parseForSecurity: async (cmd: string) =>
    FAKE_SIMPLE_PARSES[cmd] ?? { kind: 'parse-unavailable' },
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
  mock.module('../../bash/ast.js', () => ({ ...actualAstModule }))
})

const { getMatchingHooks } = await import('../../hooks.js')
const { MonitorTool } = await import('../../../tools/MonitorTool/MonitorTool.js')
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

describe('2.1.314 item 89 — MonitorTool.preparePermissionMatcher (official $Fr-gated Gjr)', () => {
  test('the Monitor tool def exposes preparePermissionMatcher', () => {
    expect(typeof prepare).toBe('function')
  })

  test('`tail *` matches a `tail -f app.log` monitor command; `git *` does not', async () => {
    const matcher = await prepare?.call(MonitorTool, monitorInput())
    expect(matcher).toBeTypeOf('function')
    expect(matcher?.('tail *')).toBe(true)
    expect(matcher?.('git *')).toBe(false)
  })

  test('ws-only input (no command) → the official `()=>!1` never-match ($Fr gate)', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      {
        ws: { url: 'wss://events.example.com/stream' },
        description: 'ws events',
      } as never,
    )
    expect(matcher?.('tail *')).toBe(false)
    expect(matcher?.('*')).toBe(false)
    expect(matcher?.('')).toBe(false)
  })

  test('empty-string command → never-match ($Fr requires e.command!=="")', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      { command: '', description: 'd' } as never,
    )
    expect(matcher?.('')).toBe(false)
    expect(matcher?.('*')).toBe(false)
  })

  test('compound commands match if ANY subcommand matches (shared Gjr split)', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      monitorInput({ command: 'ls && git push' }),
    )
    expect(matcher?.('git *')).toBe(true)
    expect(matcher?.('ls')).toBe(true)
    expect(matcher?.('npm *')).toBe(false)
  })

  test('leading VAR=val assignments are stripped from argv (FOO=bar git push matches git *)', async () => {
    const matcher = await prepare?.call(
      MonitorTool,
      monitorInput({ command: 'FOO=bar git push' }),
    )
    expect(matcher?.('git *')).toBe(true)
  })

  test('legacy prefix rules (`:*`) match subcommand starts', async () => {
    const matcher = await prepare?.call(MonitorTool, monitorInput())
    expect(matcher?.('tail -f:*')).toBe(true)
    expect(matcher?.('tail -x:*')).toBe(false)
  })

  test('parse-unavailable / too-complex commands fail safe → () => true (run the hook)', async () => {
    // Not in FAKE_SIMPLE_PARSES → the mocked parseForSecurity returns
    // {kind:'parse-unavailable'} — the live OCC condition (tree-sitter sits
    // behind the dead TREE_SITTER_BASH flag). BashTool's matcher has the same
    // fail-safe; official Gjr returns ()=>!0 for non-simple parses too.
    const matcher = await prepare?.call(
      MonitorTool,
      monitorInput({ command: 'some $(complex) | pipeline' }),
    )
    expect(matcher?.('anything *')).toBe(true)
  })
})

describe('2.1.314 item 89 — getMatchingHooks e2e: if `Monitor(tail *)` on a Monitor call', () => {
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
    session_id: 's-89',
    transcript_path: '/tmp/none.jsonl',
    cwd: process.cwd(),
  } as never

  test('if "Monitor(tail *)" KEEPS the hook for a tail monitor command', async () => {
    mockedHooksConfig = configWithIf('Monitor(tail *)')
    const matched = await getMatchingHooks(
      undefined,
      's-89',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
  })

  test('if "Monitor(git *)" DROPS the hook for a tail monitor command', async () => {
    mockedHooksConfig = configWithIf('Monitor(git *)')
    const matched = await getMatchingHooks(
      undefined,
      's-89',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(0)
  })

  test('if "Monitor" (bare tool name, no rule content) keeps the hook', async () => {
    mockedHooksConfig = configWithIf('Monitor')
    const matched = await getMatchingHooks(
      undefined,
      's-89',
      'PreToolUse',
      monitorHookInput,
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
  })
})
