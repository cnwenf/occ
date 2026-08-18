import { describe, expect, test } from 'bun:test'
import { KEYBINDING_ACTIONS, KeybindingsSchema } from '../schema.js'

// CC 2.1.234 selection:clear action (byte-verified: registered between
// selection:copy and selection:extendLeft in the official action enum, with
// no default key binding).

describe('selection:clear keybinding action (CC 2.1.234)', () => {
  test('is registered in the action enum', () => {
    expect(KEYBINDING_ACTIONS).toContain('selection:clear')
  })

  test('sits directly after selection:copy (official enum order)', () => {
    const copyIndex = KEYBINDING_ACTIONS.indexOf('selection:copy')
    expect(copyIndex).toBeGreaterThan(-1)
    expect(KEYBINDING_ACTIONS[copyIndex + 1]).toBe('selection:clear')
  })

  test('is accepted by the keybindings schema in the Scroll context', () => {
    const parsed = KeybindingsSchema().safeParse({
      bindings: [
        {
          context: 'Scroll',
          bindings: { escape: 'selection:clear' },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})
