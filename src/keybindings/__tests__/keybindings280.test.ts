import { describe, expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from '../defaultBindings.js'
import { KEYBINDING_ACTIONS, KeybindingsSchema } from '../schema.js'
import type { KeybindingContextName } from '../types.js'

/**
 * CC 2.1.280 keybinding table changes (#011 + #028), byte-verified against
 * the official ELFs (/tmp/cc-diff-280/v278|v280/package/claude):
 *
 * #011 — default y/n removed from the Confirmation context:
 *   v278 @197715675: {context:"Confirmation",bindings:{y:"confirm:yes",
 *     n:"confirm:no",enter:"confirm:yes",escape:"confirm:no",up:
 *     "confirm:previous",down:"confirm:next",tab:"confirm:nextField",
 *     space:"confirm:toggle",[X]:"confirm:cycleMode"}}
 *   v280 @197322944: identical table WITHOUT the y/n pair (string count
 *     `y:"confirm:yes"` 1→0). confirm:yes/confirm:no remain valid actions
 *     in the v280 allowlist @197330841, so users can restore y/n via
 *     keybindings.json.
 *
 * #028 — Home/End (select:first/select:last) reach the Settings context:
 *   v280 Settings block @197322645: ...,"ctrl+p":"select:previous",
 *     "ctrl+n":"select:next",home:"select:first",end:"select:last",
 *     space:"select:accept",... (v278 @197715639 has no home/end there).
 *   The Select context block already carried home:"select:first",
 *     end:"select:last" in BOTH versions (v278 @197720458, v280 @197327692)
 *     — regression-guarded below.
 */

function blockBindings(context: KeybindingContextName): Record<string, string> {
  const block = DEFAULT_BINDINGS.find(b => b.context === context)
  if (!block) throw new Error(`${context} binding block missing`)
  return block.bindings as Record<string, string>
}

describe('2.1.280 #011 — Confirmation defaults no longer bind y/n', () => {
  test('y and n keys are absent from the Confirmation block', () => {
    const bindings = blockBindings('Confirmation')
    expect(bindings).not.toHaveProperty('y')
    expect(bindings).not.toHaveProperty('n')
  })

  test('no Confirmation binding maps to y or n (any casing)', () => {
    const bindings = blockBindings('Confirmation')
    for (const key of Object.keys(bindings)) {
      expect(key.toLowerCase()).not.toBe('y')
      expect(key.toLowerCase()).not.toBe('n')
    }
  })

  test('enter/escape and the rest of the v280 table are intact', () => {
    const bindings = blockBindings('Confirmation')
    expect(bindings.enter).toBe('confirm:yes')
    expect(bindings.escape).toBe('confirm:no')
    expect(bindings.up).toBe('confirm:previous')
    expect(bindings.down).toBe('confirm:next')
    expect(bindings.tab).toBe('confirm:nextField')
    expect(bindings.space).toBe('confirm:toggle')
    expect(bindings['shift+tab']).toBe('confirm:cycleMode')
    expect(bindings['ctrl+d']).toBe('permission:toggleDebug')
  })

  test('confirm:yes/confirm:no stay valid actions (restore via keybindings.json)', () => {
    // v280 action allowlist @197330841 still contains both actions.
    expect(KEYBINDING_ACTIONS).toContain('confirm:yes')
    expect(KEYBINDING_ACTIONS).toContain('confirm:no')
  })

  test('a user keybindings.json restoring y/n passes the schema', () => {
    const parsed = KeybindingsSchema().safeParse({
      bindings: [
        {
          context: 'Confirmation',
          bindings: { y: 'confirm:yes', n: 'confirm:no' },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('2.1.280 #028 — Settings block gains home/end (select:first/last)', () => {
  test('home/end are bound in the Settings context', () => {
    const bindings = blockBindings('Settings')
    expect(bindings.home).toBe('select:first')
    expect(bindings.end).toBe('select:last')
  })

  test('official v280 order: after ctrl+n, before space', () => {
    const bindings = blockBindings('Settings')
    const keys = Object.keys(bindings)
    const ctrlN = keys.indexOf('ctrl+n')
    const home = keys.indexOf('home')
    const end = keys.indexOf('end')
    const space = keys.indexOf('space')
    expect(ctrlN).toBeGreaterThan(-1)
    expect(home).toBe(ctrlN + 1)
    expect(end).toBe(home + 1)
    expect(space).toBe(end + 1)
  })

  test('select:first/select:last are registered actions', () => {
    expect(KEYBINDING_ACTIONS).toContain('select:first')
    expect(KEYBINDING_ACTIONS).toContain('select:last')
  })
})

describe('2.1.280 #028 — Select block home/end regression guard', () => {
  test('Select context keeps home/end (present since ≤2.1.278 @197720458)', () => {
    const bindings = blockBindings('Select')
    expect(bindings.home).toBe('select:first')
    expect(bindings.end).toBe('select:last')
  })

  test('Select context keeps g/shift+g first/last aliases', () => {
    const bindings = blockBindings('Select')
    expect(bindings.g).toBe('select:first')
    expect(bindings['shift+g']).toBe('select:last')
  })
})
