/**
 * CC 2.1.312 (item 15): the bundled /verify skill gains a short menu
 * description shown in the slash-command menu, while the model-facing
 * description keeps the full text.
 *
 * Official v312 byte evidence (string new-in-312 — 0 hits in v311, 2 in v312;
 * registration @258727734):
 *   ol({name:Cue,description:zi,menuDescription:"Try your change and report if it works",userInvocable:!0,...})
 * The plumbing (`menuDescription` on bundled skill definitions +
 * `menuDescriptionFor` resolver) landed with CC 2.1.307 (B7); 312 only adds
 * this value for /verify.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { registerVerifySkill } = await import('../bundled/verify.js')
const { getBundledSkills, clearBundledSkills } = await import('../bundledSkills.js')
const { menuDescriptionFor } = await import('../../commands.js')

const OFFICIAL_MENU_DESCRIPTION = 'Try your change and report if it works'

describe('CC 2.1.312 item 15 — /verify menuDescription', () => {
  beforeEach(() => {
    clearBundledSkills()
  })

  afterEach(() => {
    clearBundledSkills()
  })

  test('registers the official verbatim short menu description', () => {
    // Arrange / Act
    registerVerifySkill()

    // Assert
    const verify = getBundledSkills().find((s) => s.name === 'verify')
    expect(verify).toBeDefined()
    expect(verify?.menuDescription).toBe(OFFICIAL_MENU_DESCRIPTION)
  })

  test('model-facing description stays the full text (not the menu string)', () => {
    // Arrange / Act
    registerVerifySkill()

    // Assert
    const verify = getBundledSkills().find((s) => s.name === 'verify')
    expect(verify?.description).not.toBe(OFFICIAL_MENU_DESCRIPTION)
    expect(typeof verify?.description).toBe('string')
    expect((verify?.description ?? '').length).toBeGreaterThan(
      OFFICIAL_MENU_DESCRIPTION.length,
    )
  })

  test('menuDescriptionFor resolves the short text for the /verify command', () => {
    // Arrange
    registerVerifySkill()
    const verify = getBundledSkills().find((s) => s.name === 'verify')
    const cmd = {
      type: 'prompt',
      name: 'verify',
      description: verify?.description,
      menuDescription: verify?.menuDescription,
      source: 'bundled',
      loadedFrom: 'bundled',
    } as unknown as Parameters<typeof menuDescriptionFor>[0]

    // Act / Assert
    expect(menuDescriptionFor(cmd)).toBe(OFFICIAL_MENU_DESCRIPTION)
  })
})
