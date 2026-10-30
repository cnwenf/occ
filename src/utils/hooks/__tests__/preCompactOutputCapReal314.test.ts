import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

// MACRO.VERSION polyfill — mirrors repo convention (transitive imports read it).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * claude-code 2.1.314 item 22 — real-child integration proof that
 * executePreCompactHooks caps a very large hook output before it becomes a
 * compaction custom instruction (the changelog fix: "a PreCompact hook with
 * very large output making compaction fail or repeat; each hook's output is now
 * cut at 10,000 characters").
 *
 * Drives the REAL production chain (executePreCompactHooks →
 * executeHooksOutsideREPL → getMatchingHooks → execCommandHook) against a real
 * spawned shell command. Only the hook-config source is mocked (the
 * getHooksConfigFromSnapshot seam, exactly like hookStdioFlags285RealChild).
 * Nothing about the child process or the truncation is mocked.
 */

// --- Mock seam (OCC-97: Bun's mock.module leaks across files in the same
// worker — spread the real module, override narrowly, restore in afterAll). ---
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
let mockedHooksConfig: HooksSettings | null = null
mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

const { executePreCompactHooks, PRECOMPACT_HOOK_OUTPUT_CHAR_LIMIT } =
  await import('../../hooks.js')
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')

function preCompactConfig(command: string): HooksSettings {
  return {
    PreCompact: [{ matcher: '', hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

beforeAll(() => {
  // Interactive-mode trust gate (shouldSkipHookDueToTrust) latches for process.
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
})

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
})

const LIMIT = PRECOMPACT_HOOK_OUTPUT_CHAR_LIMIT

describe('2.1.314 item 22 — executePreCompactHooks real-child output cap', () => {
  test('a >10k-char hook output is cut in newCustomInstructions + display message', async () => {
    // Real child: emit exactly 15,000 'a' chars on stdout, exit 0.
    mockedHooksConfig = preCompactConfig(`head -c 15000 /dev/zero | tr '\\0' 'a'`)

    const result = await executePreCompactHooks({
      trigger: 'manual',
      customInstructions: null,
    })

    expect(result.blockedBy).toBeUndefined()
    const instructions = result.newCustomInstructions ?? ''
    // Body is the first LIMIT chars; then the official cut note.
    expect(instructions.startsWith('a'.repeat(LIMIT))).toBe(true)
    expect(instructions).toContain(
      `[PreCompact hook [head -c 15000 /dev/zero | tr '\\0' 'a'] output cut: 15000 characters is over the ${LIMIT}-character limit]`,
    )
    // The compaction instruction no longer carries the full 15k payload.
    expect(instructions.length).toBeLessThan(15_000)
    // Display message mirrors the cut value (official single-pass aggregation).
    expect(result.userDisplayMessage).toContain('completed successfully:')
    expect(result.userDisplayMessage).toContain(
      `output cut: 15000 characters is over the ${LIMIT}-character limit`,
    )
  }, 20_000)

  test('a small hook output passes through uncut', async () => {
    mockedHooksConfig = preCompactConfig(
      `echo 'focus the summary on the auth module'`,
    )

    const result = await executePreCompactHooks({
      trigger: 'manual',
      customInstructions: null,
    })

    expect(result.blockedBy).toBeUndefined()
    expect(result.newCustomInstructions).toBe(
      'focus the summary on the auth module',
    )
    expect(result.newCustomInstructions).not.toContain('output cut:')
    expect(result.userDisplayMessage).toContain(
      'completed successfully: focus the summary on the auth module',
    )
  }, 20_000)
})
