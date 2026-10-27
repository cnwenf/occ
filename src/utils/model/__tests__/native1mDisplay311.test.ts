import { describe, expect, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): same seed as the
// sibling launch suites (sonnet55Launch284.test.ts) — offline model-display
// logic only, no credential resolution happens in these code paths.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

import { getPublicModelDisplayName, renderModelName, stripNative1mSuffix } from '../model.js'
import { getModelStrings } from '../modelStrings.js'

/**
 * 2.1.311 (WP-X, gap item 69): native-1M models drop BOTH the `[1m]` suffix
 * AND the "(1M context)" display label.
 *
 * All expectations are byte-verified against the official Claude Code
 * 2.1.310/2.1.311 linux-x64 binaries:
 *   - v311 `lT`/`Gk` @242271504:
 *       function lT(e){return Gk(Je(e,{identity:!0}),a2(e).endsWith("[1m]"))}
 *       function Gk(e,n){let r=$l(e);if(!r)return null;
 *         let s=n&&r.context?.supports_1m_suffix?" (1M context)":"";
 *         return r.display_name+s}
 *     vs v310 `Vk`/`Mk` @240811212 (OLD: label for ANY raw `[1m]` name):
 *       function Vk(e){return Mk(Xe(e,{identity:!0}),e.endsWith("[1m]"))}
 *     The delta is the `a2(...)` wrapping the suffix check.
 *   - v311 `a2` @242248082: strip `[1m]` iff the base is native-1M:
 *       function a2(e){let n=FH(e);return n!==e&&wC(n,{byItsOwnName:!0})?n:e}
 *   - v311 `FH` @242277243: `e.replace(/\[1m\]/gi,"")` (case-insensitive).
 *   - v311 `kK` @242281038: `{window:1e6,native_1m:!0}` for the hardcoded
 *     `claude-mythos-preview` (`p5t` @239045033).
 *   - v311 embedded catalog (identical in v310): 11 `native_1m:!0` entries —
 *     claude-haiku-5-5, claude-sonnet-5, claude-sonnet-5-5, claude-opus-4-7,
 *     claude-opus-4-8, claude-opus-5, claude-opus-5-5, claude-fable-5,
 *     claude-fable-5-1, claude-mythos-5, claude-mythos-5-1. OCC has model
 *     strings for the first nine (mythos is not in OCC's catalog).
 *   - Models with ONLY `supports_1m_suffix:!0` (sonnet-4-0/4-5/4-6,
 *     opus-4-0/4-1/4-5/4-6) KEEP the "(1M context)" label in v311.
 */

const ms = getModelStrings()

/** The nine native-1M models OCC knows (official catalog ∩ getModelStrings()). */
const NATIVE_1M_BASES: readonly string[] = Object.freeze([
  ms.haiku55,
  ms.sonnet5,
  ms.sonnet55,
  ms.opus47,
  ms.opus48,
  ms.opus5,
  ms.opus55,
  ms.fable5,
  ms.fable51,
])

/** Non-native `[1m]`-suffix models: the label survives in official v311. */
const NON_NATIVE_1M_EXPECTATIONS: ReadonlyArray<readonly [string, string]> =
  Object.freeze([
    [ms.sonnet46, 'Sonnet 4.6 (1M context)'],
    [ms.sonnet45, 'Sonnet 4.5 (1M context)'],
    [ms.sonnet40, 'Sonnet 4 (1M context)'],
    [ms.opus46, 'Opus 4.6 (1M context)'],
  ])

const ONE_M_CONTEXT_LABEL = '(1M context)'

describe('2.1.311: native-1M models drop the "(1M context)" display label', () => {
  for (const base of NATIVE_1M_BASES) {
    test(`getPublicModelDisplayName('${base}[1m]') equals the base display name with no label`, () => {
      // Arrange
      const baseName = getPublicModelDisplayName(base)

      // Act
      const variantName = getPublicModelDisplayName(`${base}[1m]`)

      // Assert
      expect(baseName).not.toBeNull()
      expect(variantName).toBe(baseName)
      expect(variantName).not.toContain('[1m]')
      expect(variantName).not.toContain(ONE_M_CONTEXT_LABEL)
    })

    test(`getPublicModelDisplayName('${base}[1M]') — uppercase tag behaves the same (official FH uses /\\[1m\\]/gi)`, () => {
      // Arrange
      const baseName = getPublicModelDisplayName(base)

      // Act
      const variantName = getPublicModelDisplayName(`${base}[1M]`)

      // Assert
      expect(variantName).toBe(baseName)
      expect(variantName).not.toContain('[1M]')
      expect(variantName).not.toContain(ONE_M_CONTEXT_LABEL)
    })
  }
})

describe('2.1.311: non-native suffix-only models KEEP the "(1M context)" label', () => {
  for (const [base, expected] of NON_NATIVE_1M_EXPECTATIONS) {
    test(`getPublicModelDisplayName('${base}[1m]') === '${expected}'`, () => {
      // Act
      const variantName = getPublicModelDisplayName(`${base}[1m]`)

      // Assert
      expect(variantName).toBe(expected)
    })
  }
})

describe('2.1.311: renderModelName follows the display-name resolution', () => {
  test("renderModelName for a native-1M '[1m]' variant returns the plain display name", () => {
    // Act
    const renderedSonnet55 = renderModelName(`${ms.sonnet55}[1m]`)
    const renderedOpus5 = renderModelName(`${ms.opus5}[1m]`)

    // Assert
    expect(renderedSonnet55).toBe('Sonnet 5.5')
    expect(renderedOpus5).toBe('Opus 5')
  })

  test("renderModelName for a non-native '[1m]' variant keeps the label", () => {
    // Act
    const rendered = renderModelName(`${ms.sonnet46}[1m]`)

    // Assert
    expect(rendered).toBe('Sonnet 4.6 (1M context)')
  })
})

describe('2.1.311: unknown models are unchanged', () => {
  test('unknown model returns null with and without a [1m] suffix', () => {
    // Act & Assert
    expect(getPublicModelDisplayName('totally-unknown-model')).toBeNull()
    expect(getPublicModelDisplayName('totally-unknown-model[1m]')).toBeNull()
  })
})

describe('2.1.311: stripNative1mSuffix (official a2 @242248082)', () => {
  test('strips [1m] from a native-1M model (a2: FH strip + native check)', () => {
    // Act & Assert
    expect(stripNative1mSuffix(`${ms.sonnet5}[1m]`)).toBe(ms.sonnet5)
    expect(stripNative1mSuffix(`${ms.haiku55}[1m]`)).toBe(ms.haiku55)
  })

  test('strips the uppercase [1M] marker too (official FH uses /\\[1m\\]/gi)', () => {
    // Act & Assert
    expect(stripNative1mSuffix(`${ms.opus5}[1M]`)).toBe(ms.opus5)
  })

  test('leaves a non-native suffix-only model unchanged', () => {
    // Act & Assert
    expect(stripNative1mSuffix(`${ms.sonnet46}[1m]`)).toBe(`${ms.sonnet46}[1m]`)
    expect(stripNative1mSuffix(`${ms.opus46}[1m]`)).toBe(`${ms.opus46}[1m]`)
  })

  test('leaves inputs without a [1m] marker unchanged', () => {
    // Act & Assert
    expect(stripNative1mSuffix(ms.sonnet5)).toBe(ms.sonnet5)
    expect(stripNative1mSuffix('totally-unknown-model')).toBe('totally-unknown-model')
  })

  test('leaves an unknown model with a [1m] marker unchanged (base not native-1M)', () => {
    // Act & Assert
    expect(stripNative1mSuffix('totally-unknown-model[1m]')).toBe(
      'totally-unknown-model[1m]',
    )
  })
})
