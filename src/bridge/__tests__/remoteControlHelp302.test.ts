import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CC 2.1.302 #16 — "Fixed `claude remote-control --help` not printing its
 * usage and exiting when not signed in." (dormant-surface alignment:
 * BRIDGE_MODE is not in OCC's FEATURE_ALLOWLIST, but the gate ordering must
 * match the official — prior rounds occ102/occ142 mis-classified this NO-OP
 * without inspecting the cli.tsx fast-path ordering; this round corrects it.)
 *
 * Byte evidence (official linux-x64 ELFs at /tmp/cc-diff-302/{v301,v302}):
 *
 * v302 remote-control command setup region @117867900 (dd-verified; marker
 * `--remote-control [name]` @117868256) — Commander help machinery
 * co-located with the auth/login state codes, help path FIRST:
 *   run_main_options_built configureHelp enablePositionalOptions argument
 *   helpOption addOption argParser hideHelp rootCommand … auth_failed
 *   request_failed stale_tunnel_credential … hasOAuthToken oauthEffective
 * Marker counts: `remote-control` v301=134 / v302=135 (+1 net); the official
 * fix reorders so the usage path runs before the auth gate.
 *
 * OCC-side bug pattern (pre-fix): src/entrypoints/cli.tsx bridge fast-path
 * ran `getClaudeAIOAuthTokens()?.accessToken` → exitWithError(
 * BRIDGE_LOGIN_ERROR) BEFORE delegating to bridgeMain — whose own first act
 * is `parsed.help → printHelp() → return` (pre-auth). So signed-out
 * `remote-control --help` died with the login error + exit 1, never usage.
 * Structurally identical to the official pre-2.1.302 bug.
 *
 * Fix: cli.tsx now checks `parseBridgeArgs(bridgeArgs).help` (bridgeMain's
 * OWN parseArgs — so `--name --help` keeps value-consumption semantics) and
 * delegates straight to bridgeMain before the auth/GrowthBook/min-version/
 * policy gate chain.
 *
 * MACRO polyfill per src/bridge/__tests__/remoteControlSandboxFlags300
 * precedent — bridgeMain's import graph touches cli.tsx macro consumers.
 */
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { parseArgs, bridgeMain } = await import('../bridgeMain.js')

describe('CC 2.1.302 #16 — remote-control --help prints usage when not signed in', () => {
  test('parseArgs recognizes --help and -h', () => {
    // Arrange / Act
    const long = parseArgs(['--help'])
    const short = parseArgs(['-h'])
    // Assert
    expect(long.help).toBe(true)
    expect(short.help).toBe(true)
  })

  test('--help consumed as a flag value does NOT set help (no gate bypass via --name --help)', () => {
    // Arrange / Act — parseArgs consumes `--name <value>` with args[++i].
    const result = parseArgs(['--name', '--help'])
    // Assert — help stays false, so cli.tsx's help-delegation predicate is
    // false and the auth/gate chain still runs for the real session start.
    expect(result.help).toBe(false)
    expect(result.name).toBe('--help')
  })

  test('bridgeMain(["--help"]) prints usage and returns WITHOUT any auth (behavioral)', async () => {
    // Arrange — capture console.log (printHelp emits via console.log at
    // bridgeMain.ts:2099). No OAuth token is set in this test env; the help
    // branch (bridgeMain.ts:2130-2135) returns before the token check at
    // :2254, so nothing should exit or throw.
    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      // Act — must RESOLVE (not process.exit) signed-out.
      await bridgeMain(['--help'])
    } finally {
      console.log = origLog
    }
    // Assert — usage text printed, mentions the surface + a documented flag.
    const out = lines.join('\n')
    expect(out).toContain('remote-control')
    expect(out).toContain('--name')
  })

  test('cli.tsx bridge fast-path delegates help BEFORE the auth/gate chain (source ordering)', () => {
    // The fast path lives behind feature("BRIDGE_MODE") (off in every
    // allowlist — dormant surface), so behavioral coverage of the wrapper
    // ordering is a source assertion per the sessionRunner precedent in
    // remoteControlSandboxFlags300.test.ts.
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'entrypoints', 'cli.tsx'),
      'utf8',
    )
    const helpDelegation = source.indexOf('parseBridgeArgs(bridgeArgs).help')
    const authGate = source.indexOf('getClaudeAIOAuthTokens()?.accessToken')
    // Assert — both exist and help delegation strictly precedes the auth gate.
    expect(helpDelegation).toBeGreaterThan(-1)
    expect(authGate).toBeGreaterThan(-1)
    expect(helpDelegation).toBeLessThan(authGate)
  })
})
