import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CC 2.1.300 #66 — "Removed the `--sandbox` and `--no-sandbox` flags from
 * `claude remote-control`" (dormant-surface alignment: BRIDGE_MODE is not in
 * OCC's FEATURE_ALLOWLIST, but the flag surface must match the official).
 *
 * Byte evidence (official linux-x64 ELFs at /tmp/cc-diff-300/{v299,v300}):
 *
 * v300 RC parseArgs `ko()` @241543023 — DEDICATED error branch (dd-verified;
 * the triage sketch guessed unknown-arg fallthrough, the binary says
 * otherwise — binary is source of truth):
 *   else if(C==="--sandbox"||C==="--no-sandbox")return U(
 *     `${C} is not supported by claude remote-control. The flag had no effect
 *      and was removed. ${C==="--sandbox"?ion:"Remove it from the command."}`)
 * with ion="To sandbox sessions, set sandbox.enabled to true in settings."
 * @222586160 (string-table copy @109346400).
 *
 * v299 parseArgs `hs` @240274100 accepted the flags instead:
 *   else if(R==="--sandbox")_=!0;else if(R==="--no-sandbox")_=!1;
 *
 * New-string offsets (v300 hits / v299 hits):
 *   "is not supported by claude remote-control" @112571513,@241543023 / 0
 *   "Remove it from the command."               @112571604,@241543129 / 0
 *   "To sandbox sessions, set sandbox.enabled"  @109346400,@222586160 / 0
 *
 * Branding deviation (documented): OCC precedent bridgeMain.ts unknown-arg
 * error already reads "Run 'occ remote-control --help'" → the official
 * "claude remote-control" becomes "occ remote-control". The hint sentence is
 * verbatim official.
 *
 * MACRO polyfill per src/bridge/__tests__/bridgePolicyRefusalShutdown286
 * precedent — bridgeMain's import graph touches cli.tsx macro consumers.
 */
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { parseArgs } = await import('../bridgeMain.js')

const SANDBOX_SANDBOX_ERROR =
  '--sandbox is not supported by occ remote-control. The flag had no effect and was removed. To sandbox sessions, set sandbox.enabled to true in settings.'
const NO_SANDBOX_ERROR =
  '--no-sandbox is not supported by occ remote-control. The flag had no effect and was removed. Remove it from the command.'

describe('CC 2.1.300 #66 — remote-control rejects the removed sandbox flags', () => {
  test('--sandbox exits with the official error carrying the sandbox-settings hint', () => {
    // Act
    const result = parseArgs(['--sandbox'])
    // Assert — dedicated error branch, byte-verified v300 @241543023.
    expect(result.error).toBe(SANDBOX_SANDBOX_ERROR)
  })

  test('--no-sandbox exits with the official error carrying the remove-it hint', () => {
    // Act
    const result = parseArgs(['--no-sandbox'])
    // Assert
    expect(result.error).toBe(NO_SANDBOX_ERROR)
  })

  test('the removed-flag error fires even alongside otherwise-valid flags (early return)', () => {
    // Act — official returns U(...) at the branch point; no partial parse.
    const result = parseArgs(['--name', 'sess', '--sandbox'])
    // Assert
    expect(result.error).toBe(SANDBOX_SANDBOX_ERROR)
  })

  test('known flags still parse cleanly and never carry sandbox: true', () => {
    // Act
    const result = parseArgs(['--name', 'sess'])
    // Assert — no error; sandbox field (if still present on ParsedArgs for
    // BridgeConfig compatibility) is constant false — the flags that could
    // set it no longer exist.
    expect(result.error).toBeUndefined()
    expect(result.sandbox).toBe(false)
  })

  test('unknown-argument path is unchanged (the removal did NOT reroute through it)', () => {
    // Act
    const result = parseArgs(['--totally-unknown-flag'])
    // Assert — existing OCC unknown-arg error (occ-branded --help hint).
    expect(result.error).toBe(
      "Unknown argument: --totally-unknown-flag\nRun 'occ remote-control --help' for usage.",
    )
  })

  test('sessionRunner no longer forces CLAUDE_CODE_FORCE_SANDBOX from the removed flag', () => {
    // The --sandbox flag's only behavioral consumer in-cluster was the
    // sessionRunner child-env line `...(deps.sandbox && {
    // CLAUDE_CODE_FORCE_SANDBOX: '1' })`. With the flags removed, the dead
    // threading must go too (grep-verified: no other src/packages consumer
    // of CLAUDE_CODE_FORCE_SANDBOX).
    const source = readFileSync(
      join(import.meta.dir, '..', 'sessionRunner.ts'),
      'utf8',
    )
    expect(source).not.toContain('CLAUDE_CODE_FORCE_SANDBOX')
  })
})
