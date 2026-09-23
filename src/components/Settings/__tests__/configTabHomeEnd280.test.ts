import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Config.tsx transitively reads build-time constants; mirror the repo-convention
// polyfill (see statusAutoModeServer278.test.ts), then import dynamically so the
// polyfill is in place before the module evaluates.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { getSettingsListKeyAction, clampSettingsIndex } = await import(
  '../Config.js'
)

const CONFIG_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'Config.tsx'),
  'utf8',
)

/**
 * CC 2.1.280 — /config list-mode key handling (#030 + #028), byte-verified
 * against the official ELFs (/tmp/cc-diff-280/v278|v280/package/claude):
 *
 * #030 — Tab must not change setting values:
 *   v278 @225642857: if(f.key==="left"||f.key==="right"||f.key==="tab")
 *                      {f.preventDefault(),yn();return}   // yn cycles value
 *   v280 @225583608: if(h.key==="left"||h.key==="right"){h.preventDefault(),
 *                      ho();return}
 *                    if(h.key==="tab"){h.preventDefault();return}
 *
 * #028 — Home/End jump to first/last setting:
 *   v280 Settings handler map @225582280: "select:first":()=>Rs(0),
 *     "select:last":()=>Rs(Be.length-1); Rs clamps via
 *     Z=Math.max(0,Math.min(Be.length-1,h)) (@225582305).
 *
 * OCC has no Ink component-test harness, so the two pure pieces of the port
 * (key classifier + index clamp) are unit-tested here, and the handler-map
 * wiring is asserted against the source (repo convention, e.g.
 * vimModeSwitchFromValue276.test.ts).
 */

describe('2.1.280 #030 — tab no longer toggles setting values', () => {
  test('tab is classified preventDefaultOnly (swallowed, value unchanged)', () => {
    expect(getSettingsListKeyAction('tab')).toBe('preventDefaultOnly')
  })

  test('left/right still toggle the value', () => {
    expect(getSettingsListKeyAction('left')).toBe('toggleValue')
    expect(getSettingsListKeyAction('right')).toBe('toggleValue')
  })

  test('other list-mode keys fall through (none)', () => {
    for (const key of ['up', 'down', 'enter', 'return', 'escape', 'a', ' ']) {
      expect(getSettingsListKeyAction(key)).toBe('none')
    }
  })

  test('the v278 combined left/right/tab branch is gone from handleKeyDown', () => {
    expect(CONFIG_SOURCE).not.toContain(
      "e.key === 'left' || e.key === 'right' || e.key === 'tab'",
    )
  })

  test('preventDefaultOnly path prevents default without calling toggleSetting (source wiring)', () => {
    // Mirrors official v280: if(h.key==="tab"){h.preventDefault();return}
    const branch = CONFIG_SOURCE.match(
      /if \(listKeyAction === 'preventDefaultOnly'\) \{[^}]*\}/,
    )
    expect(branch).not.toBeNull()
    expect(branch![0]).toContain('e.preventDefault()')
    expect(branch![0]).not.toContain('toggleSetting')
  })
})

describe('2.1.280 #028 — Settings select:first/last index clamp (official Rs)', () => {
  test('jump to first: clamp(0) = 0', () => {
    expect(clampSettingsIndex(0, 10)).toBe(0)
  })

  test('jump to last: clamp(length - 1) = length - 1', () => {
    expect(clampSettingsIndex(9, 10)).toBe(9)
  })

  test('clamps overshoot to the last index (official Math.min(Be.length-1,h))', () => {
    expect(clampSettingsIndex(100, 10)).toBe(9)
  })

  test('clamps undershoot to 0 (official Math.max(0,...))', () => {
    expect(clampSettingsIndex(-5, 10)).toBe(0)
  })

  test('empty list clamps to 0 like the official expression', () => {
    // Math.max(0, Math.min(-1, 0)) === 0 in the official Rs as well.
    expect(clampSettingsIndex(0, 0)).toBe(0)
  })
})

describe('2.1.280 #028 — Settings handler-map wiring (source)', () => {
  test("registers 'select:first' jumping to index 0 (official Rs(0))", () => {
    expect(CONFIG_SOURCE).toMatch(/'select:first':\s*\(\)\s*=>\s*jumpToIndex\(0\)/)
  })

  test("registers 'select:last' jumping to the last filtered item (official Rs(Be.length-1))", () => {
    expect(CONFIG_SOURCE).toMatch(
      /'select:last':\s*\(\)\s*=>\s*jumpToIndex\(filteredSettingsItems\.length - 1\)/,
    )
  })

  test('both handlers live in the Settings useKeybindings context block', () => {
    const firstIdx = CONFIG_SOURCE.indexOf(
      "'select:first': () => jumpToIndex(0)",
    )
    expect(firstIdx).toBeGreaterThan(-1)
    const ctxIdx = CONFIG_SOURCE.indexOf("context: 'Settings'", firstIdx)
    expect(ctxIdx).toBeGreaterThan(firstIdx)
    const between = CONFIG_SOURCE.slice(firstIdx, ctxIdx)
    expect(between).toContain(
      "'select:last': () => jumpToIndex(filteredSettingsItems.length - 1)",
    )
  })
})
