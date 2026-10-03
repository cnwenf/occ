/**
 * CC 2.1.287 (#25) — light-theme promptBorder contrast bump.
 *
 * Official v287 changes ONLY the two light-family `promptBorder` values
 * (`rgb(153,153,153)` → `rgb(138,138,138)` — darker on light backgrounds,
 * better contrast). Byte-check invariants from the gap report
 * (cluster-d2-misc.md #25), all pinned here:
 *   - lightTheme + lightDaltonizedTheme promptBorder → 'rgb(138,138,138)'
 *   - lightTheme + lightDaltonizedTheme promptBorderShimmer UNCHANGED at
 *     'rgb(183,183,183)'
 *   - darkTheme + darkDaltonizedTheme promptBorder UNCHANGED at
 *     'rgb(136,136,136)' (shimmer 'rgb(166,166,166)')
 *   - lightAnsiTheme + darkAnsiTheme UNCHANGED ('ansi:white' /
 *     'ansi:whiteBright')
 */
import { describe, expect, test } from 'bun:test'
import { getTheme } from '../theme.js'

describe('2.1.287 #25: light-family promptBorder contrast (138)', () => {
  test('lightTheme promptBorder is rgb(138,138,138)', () => {
    expect(getTheme('light').promptBorder).toBe('rgb(138,138,138)')
  })

  test('lightDaltonizedTheme promptBorder is rgb(138,138,138)', () => {
    expect(getTheme('light-daltonized').promptBorder).toBe('rgb(138,138,138)')
  })

  test('light-family promptBorderShimmer stays rgb(183,183,183) (untouched)', () => {
    expect(getTheme('light').promptBorderShimmer).toBe('rgb(183,183,183)')
    expect(getTheme('light-daltonized').promptBorderShimmer).toBe(
      'rgb(183,183,183)',
    )
  })
})

describe('2.1.287 #25: dark + ansi themes untouched (byte-check invariants)', () => {
  test('dark-family promptBorder stays rgb(136,136,136)', () => {
    expect(getTheme('dark').promptBorder).toBe('rgb(136,136,136)')
    expect(getTheme('dark-daltonized').promptBorder).toBe('rgb(136,136,136)')
  })

  test('dark-family promptBorderShimmer stays rgb(166,166,166)', () => {
    expect(getTheme('dark').promptBorderShimmer).toBe('rgb(166,166,166)')
    expect(getTheme('dark-daltonized').promptBorderShimmer).toBe(
      'rgb(166,166,166)',
    )
  })

  test('ansi themes keep ansi:white / ansi:whiteBright', () => {
    expect(getTheme('light-ansi').promptBorder).toBe('ansi:white')
    expect(getTheme('light-ansi').promptBorderShimmer).toBe('ansi:whiteBright')
    expect(getTheme('dark-ansi').promptBorder).toBe('ansi:white')
    expect(getTheme('dark-ansi').promptBorderShimmer).toBe('ansi:whiteBright')
  })
})
