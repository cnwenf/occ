import { describe, expect, test } from 'bun:test'
import {
  permissionModeIndicator,
  permissionModeSymbol,
  permissionModeTitle,
} from '../PermissionMode.js'

/**
 * Gap-110e (2.1.251, OCC-110): the REPL footer chip renders the mode
 * INDICATOR, not the lowercased title — byte-verified against the official
 * binary (`_ml[mode].indicator` table) and live-verified in the 2.1.251
 * REPL footer (`⏸ manual mode on`). For default mode the title is "Manual"
 * (→ "manual on") while the indicator is "manual mode" (→ "manual mode on").
 * The PERMISSION_MODE_CONFIG 6-mode indicator table byte-matches official.
 */
describe('2.1.251 permission mode indicator table (Gap-110e)', () => {
  test('default mode indicator is "manual mode" (title "Manual")', () => {
    expect(permissionModeIndicator('default')).toBe('manual mode')
    expect(permissionModeTitle('default')).toBe('Manual')
    expect(permissionModeSymbol('default')).toBe('⏸')
  })

  test('plan mode indicator', () => {
    expect(permissionModeIndicator('plan')).toBe('plan mode')
  })

  test('acceptEdits indicator is lowercase "accept edits"', () => {
    expect(permissionModeIndicator('acceptEdits')).toBe('accept edits')
  })

  test('bypassPermissions indicator', () => {
    expect(permissionModeIndicator('bypassPermissions')).toBe(
      'bypass permissions',
    )
  })

  test("dontAsk indicator keeps the apostrophe: \"don't ask\"", () => {
    expect(permissionModeIndicator('dontAsk')).toBe("don't ask")
  })

  test('footer chip text for default mode reads "manual mode on"', () => {
    // Mirrors the footer construction: {symbol} {indicator} on
    const chip = `${permissionModeSymbol('default')} ${permissionModeIndicator('default')} on`
    expect(chip).toBe('⏸ manual mode on')
  })

  test('footer chip text for acceptEdits matches the official live footer', () => {
    const chip = `${permissionModeSymbol('acceptEdits')} ${permissionModeIndicator('acceptEdits')} on`
    expect(chip).toBe('⏵⏵ accept edits on')
  })
})
