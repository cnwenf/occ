import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isKeybindingCustomizationEnabled } from '../loadUserBindings.js'

/**
 * P2-2 (OCC-101 review, CC 2.1.284): pin the keybinding-customization gate
 * DEFAULT and its consumer wiring.
 *
 * Official binary evidence (v284 ELF `KV()` @204876508, v283 `yV()`
 * @203041522): `return x("tengu_keybinding_customization_release",!0)` —
 * the flag fallback is TRUE. OCC's GrowthBook is stubbed and never fetches
 * (`isGrowthBookEnabled()` → `is1PEventLoggingEnabled()` is off in this
 * build), so `getFeatureValue_CACHED_MAY_BE_STALE(feature, fallback)`
 * returns the fallback — i.e. the fallback IS the shipped value. The
 * pre-284 `false` default hid the `/keybindings to customize` help row and
 * gated off the loader + /keybindings command for everyone.
 *
 * Mutation self-verification (review protocol): flipping the fallback in
 * loadUserBindings.ts to `false` MUST turn the functional pin red; removing
 * the `isKeybindingCustomizationEnabled() &&` gate from the help row MUST
 * turn the source-anchored wiring pin red.
 */

const REPO_SRC = join(import.meta.dir, '..', '..')

let savedUserType: string | undefined

beforeEach(() => {
  // Hermetic: USER_TYPE=ant would activate CLAUDE_INTERNAL_FC_OVERRIDES /
  // global-config growthBookOverrides ahead of the stub fallback.
  savedUserType = process.env.USER_TYPE
  delete process.env.USER_TYPE
})

afterEach(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

describe('2.1.284: keybinding customization gate (official KV() @204876508)', () => {
  test('fallback is TRUE under the GrowthBook stub — the gate ships open', () => {
    expect(isKeybindingCustomizationEnabled()).toBe(true)
  })

  test('the /keybindings help row is gated by the flag (source-anchored wiring)', () => {
    const src = readFileSync(
      join(REPO_SRC, 'components/PromptInput/PromptInputHelpMenu.tsx'),
      'utf-8',
    )
    // PromptInputHelpMenu.tsx:322 — the dim hint row renders ONLY when the
    // gate is open; un-gating or re-gating on a different flag breaks this.
    expect(src).toContain(
      't43 = isKeybindingCustomizationEnabled() && <Box><Text dimColor={dimColor}>/keybindings to customize</Text></Box>',
    )
  })

  test('the /keybindings command + bundled skill stay wired to the same gate', () => {
    const cmdSrc = readFileSync(
      join(REPO_SRC, 'commands/keybindings/index.ts'),
      'utf-8',
    )
    expect(cmdSrc).toContain(
      'isEnabled: () => isKeybindingCustomizationEnabled()',
    )
    const skillSrc = readFileSync(
      join(REPO_SRC, 'skills/bundled/keybindings.ts'),
      'utf-8',
    )
    expect(skillSrc).toContain(
      'isEnabled: isKeybindingCustomizationEnabled',
    )
  })
})
