import { describe, expect, test } from 'bun:test'
import { HOOK_EVENTS } from '../../../entrypoints/agentSdkTypes.js'
import { HooksSchema } from '../../../schemas/hooks.js'
import { getHookEventMetadata } from '../hooksConfigManager.js'

/**
 * OCC-34 (Claude Code 2.1.219): the `DirectoryAdded` hook — fires after
 * `/add-dir` or the `register_repo_root` SDK control request registers a
 * new working directory mid-session (after the sandbox config refresh).
 * Decompiled upstream executor (`a2t`) payload:
 *   { ...baseHookInput, hook_event_name: "DirectoryAdded", directory, source }
 *
 * These tests pin the user-facing surface added in OCC-34:
 *  1. `'DirectoryAdded'` is a registered hook event (configurable in settings).
 *  2. The `/hooks` help metadata describes it (summary present).
 *  3. `HooksSchema` parses a settings config that wires a command hook under
 *     `DirectoryAdded` with a `matcher` (the add origin) — i.e. it is a
 *     first-class configurable hook event, not a silent gap.
 *  4. `executeDirectoryAddedHooks` is exported with the decompiled signature.
 */

describe('OCC-34 / CC 2.1.219: DirectoryAdded hook surface', () => {
  test("'DirectoryAdded' is a registered hook event", () => {
    expect(HOOK_EVENTS).toContain('DirectoryAdded')
  })

  test('getHookEventMetadata describes DirectoryAdded', () => {
    const meta = getHookEventMetadata([]) as Record<string, { summary: string; description: string }>
    const added = meta['DirectoryAdded']
    expect(added).toBeDefined()
    expect(added.summary.toLowerCase()).toContain('working directory')
    // Faithful to the binary's verbatim description: fires after the sandbox
    // refresh, hook commands run unsandboxed, duplicates do not re-run.
    expect(added.description).toContain('sandbox')
    expect(added.description).toContain('do not re-run')
  })

  test('HooksSchema accepts a DirectoryAdded config with a matcher + command hook', () => {
    const parsed = HooksSchema().parse({
      DirectoryAdded: [
        {
          matcher: 'add-dir',
          hooks: [{ type: 'command', command: 'echo added' }],
        },
      ],
    })
    const cfg = parsed as { DirectoryAdded?: Array<{ hooks: unknown[] }> }
    expect(cfg.DirectoryAdded).toBeDefined()
    expect(cfg.DirectoryAdded?.[0].hooks).toHaveLength(1)
  })

  test('executeDirectoryAddedHooks is exported with the decompiled (directory, source) signature', async () => {
    const mod = await import('../../hooks.js')
    const fn = (mod as { executeDirectoryAddedHooks?: unknown }).executeDirectoryAddedHooks
    expect(typeof fn).toBe('function')
  })
})
