import { beforeEach, describe, expect, test } from 'bun:test'
import { getFastModeChangeAnnouncement } from '../../src/utils/fastMode.js'

/**
 * CC 2.1.218 #32: announce when fast mode changes as a result of switching
 * models via /config model=<x> or Remote Control.
 *
 * Official binary recon (RDd function):
 *   function RDd(e,t,r){if(!!e===t)return null;return t
 *     ?`Fast mode ON${aNs(r,!0,OO())?" · Draws from usage credits":""}`
 *     :"Fast mode OFF"}
 *
 * Match the official message EXACTLY:
 *   - No change        → null
 *   - Turning ON       → "Fast mode ON" (+ " · Draws from usage credits" if billed)
 *   - Turning OFF      → "Fast mode OFF"
 */

describe('getFastModeChangeAnnouncement', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY ??= 'test-placeholder'
  })

  test('returns null when fast mode state is unchanged (OFF→OFF)', () => {
    expect(getFastModeChangeAnnouncement(false, false, null)).toBeNull()
  })

  test('returns null when fast mode state is unchanged (ON→ON)', () => {
    expect(getFastModeChangeAnnouncement(true, true, null)).toBeNull()
  })

  test('returns "Fast mode OFF" when turning OFF', () => {
    expect(getFastModeChangeAnnouncement(true, false, null)).toBe('Fast mode OFF')
  })

  test('returns "Fast mode ON" when turning ON with a non-extra-usage model', () => {
    // The default model (null) is not billed as extra usage in the test
    // environment (no claude.ai subscriber), so no suffix.
    expect(getFastModeChangeAnnouncement(false, true, null)).toBe('Fast mode ON')
  })

  test('coerces truthy prev to boolean for the no-change check', () => {
    // !!e === t: prev=1, new=true → !!1===true → no change → null
    expect(getFastModeChangeAnnouncement(1 as any, true, null)).toBeNull()
  })
})
