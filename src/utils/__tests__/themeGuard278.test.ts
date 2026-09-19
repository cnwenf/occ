import { describe, expect, test } from 'bun:test'

import { chevronThemeFamily } from '../../components/LogoV2/OccMark.js'
import { saveGlobalConfig } from '../config.js'
import { resolveThemeSetting } from '../systemTheme.js'
import {
  normalizeThemeSetting,
  THEME_SETTINGS,
  type ThemeSetting,
} from '../theme.js'

/**
 * claude-code 2.1.277 (C8): "Fixed a crash at launch when the persisted
 * `theme` value in ~/.claude.json is malformed."
 *
 * Official v277 mechanism (byte-extracted @0xbad14e4): the config-read
 * boundary (`Po` resolveSetting) gained a schema-guard call —
 *
 *   function AEn(t,s){let e=Kb().shape[t].safeParse(s);
 *     return e.success?e.data??void 0:void 0}
 *   ... if(o!==void 0&&o!==UU[n]){let i=AEn(n,o);if(i!==void 0)
 *     return{value:i,source:"legacyGlobalConfig"}}
 *   return{value:s,source:"default"}
 *
 * safeParse failure → undefined → fall through to the DEFAULT value. The
 * theme schema (identical v276/v277):
 *
 *   theme:Fe([q(F2e),o().startsWith("custom:").transform((i)=>i)])
 *     .optional().catch(void 0)
 *   F2e=["auto","dark","light","light-daltonized","dark-daltonized",
 *        "light-ansi","dark-ansi"]
 *
 * so valid = a THEME_SETTINGS member OR a "custom:"-prefixed string;
 * anything else falls back to the default ('dark'). Pre-fix, a malformed
 * value (number, object, unknown string) flowed into `.startsWith`
 * consumers (chevronThemeFamily via the mark render) and threw a TypeError
 * at launch.
 */

const MALFORMED: unknown[] = [
  123,
  null,
  undefined,
  {},
  [],
  true,
  'neon',
  'Dark',
  '',
  ['dark'],
]

describe('2.1.277 normalizeThemeSetting (official AEn guard + theme schema)', () => {
  test('malformed values fall back to the default "dark", no throw', () => {
    for (const raw of MALFORMED) {
      expect(normalizeThemeSetting(raw)).toBe('dark')
    }
  })

  test('every valid THEME_SETTINGS member passes through unchanged', () => {
    for (const setting of THEME_SETTINGS) {
      expect(normalizeThemeSetting(setting)).toBe(setting)
    }
  })

  test('"custom:"-prefixed slugs pass through (official union branch)', () => {
    expect(normalizeThemeSetting('custom:My Theme')).toBe('custom:My Theme')
    expect(normalizeThemeSetting('custom:')).toBe('custom:')
  })
})

describe('2.1.277 resolveThemeSetting read boundary tolerates malformed theme', () => {
  test('malformed values resolve to "dark" instead of passing through raw', () => {
    for (const raw of MALFORMED) {
      expect(resolveThemeSetting(raw as ThemeSetting)).toBe('dark')
    }
  })

  test('valid settings keep their prior semantics', () => {
    expect(resolveThemeSetting('dark')).toBe('dark')
    expect(resolveThemeSetting('light-ansi')).toBe('light-ansi')
    // 'auto' resolves via the system-theme cache (dark in tests, no
    // $COLORFGBG) — the point is that it does not throw and stays concrete.
    expect(['dark', 'light']).toContain(resolveThemeSetting('auto'))
  })

  test('boundary expression over a malformed persisted config value', () => {
    saveGlobalConfig(current => ({
      ...current,
      theme: 123 as unknown as ThemeSetting,
    }))
    // The exact expression ThemeProvider.defaultInitialTheme now uses:
    expect(normalizeThemeSetting(123)).toBe('dark')
    saveGlobalConfig(current => ({
      ...current,
      theme: 'dark',
    }))
  })
})

describe('2.1.277 chevronThemeFamily defense-in-depth guard', () => {
  test('non-string values → "dark", no throw (pre-fix: startsWith TypeError)', () => {
    for (const raw of [123, null, undefined, {}, []]) {
      expect(chevronThemeFamily(raw as unknown as string)).toBe('dark')
    }
  })

  test('valid theme names keep their family', () => {
    expect(chevronThemeFamily('light')).toBe('light')
    expect(chevronThemeFamily('light-ansi')).toBe('light')
    expect(chevronThemeFamily('light-daltonized')).toBe('light')
    expect(chevronThemeFamily('dark')).toBe('dark')
    expect(chevronThemeFamily('dark-ansi')).toBe('dark')
    expect(chevronThemeFamily('dark-daltonized')).toBe('dark')
  })
})
