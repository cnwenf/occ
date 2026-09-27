/**
 * Gap-139a (official 2.1.283): the `--effort` CLI parser family.
 *
 * Byte-verified against the official 2.1.283 linux-x64 binary
 * (G/J/NNe/yct/fhe/_5e/oL/kzn/N$). The official silently replaced the strict
 * 2.1.218-era Commander validation (InvalidArgumentError → exit 1) with a
 * lenient warn-and-continue family:
 *
 *   • unknown value → { level: undefined, warning: "Unknown --effort value
 *     '<RAW>' — ignoring it and using the default effort. Valid values:
 *     low, medium, high, xhigh, max." } (raw case preserved, em dash)
 *   • 'med' aliases 'medium' (G map, both CLI and env parsers)
 *   • 'ultracode' keyword → CLI parser returns the keyword itself as the
 *     level; session init (kzn) maps it to 'xhigh'
 *   • env parser (oL) does NOT trim; CLI parser (fhe) does
 */
import { describe, expect, test, afterEach } from 'bun:test'
import {
  EFFORT_KEYWORD_LEVELS,
  EFFORT_LEVEL_ALIASES,
  EFFORT_LEVELS,
  getEffortEnvOverride,
  normalizeEffortKeyword,
  parseEffortCliFlag,
  parseEffortCliLevel,
  parseEffortEnvValue,
  parseEffortKeywordLevel,
  parseEffortSessionInit,
  parseEffortValue,
} from '../effort.js'

const EXACT_WARNING = (raw: string) =>
  `Unknown --effort value '${raw}' — ignoring it and using the default effort. Valid values: ${EFFORT_LEVELS.join(', ')}.`

afterEach(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

describe('Gap-139a: parseEffortCliFlag (official _5e)', () => {
  test('accepts every valid level verbatim', () => {
    for (const level of EFFORT_LEVELS) {
      expect(parseEffortCliFlag(level)).toEqual({ level, warning: undefined })
    }
  })

  test('lowercases and trims like official fhe', () => {
    expect(parseEffortCliFlag('HIGH')).toEqual({ level: 'high', warning: undefined })
    expect(parseEffortCliFlag('  Max ')).toEqual({ level: 'max', warning: undefined })
    expect(parseEffortCliFlag('XHIGH')).toEqual({ level: 'xhigh', warning: undefined })
  })

  test("maps the 'med' alias to 'medium' (official G)", () => {
    expect(parseEffortCliFlag('med')).toEqual({ level: 'medium', warning: undefined })
    expect(parseEffortCliFlag('MED')).toEqual({ level: 'medium', warning: undefined })
    expect(parseEffortCliFlag(' Med ')).toEqual({ level: 'medium', warning: undefined })
  })

  test("returns the 'ultracode' keyword itself as the level (official NNe branch)", () => {
    expect(parseEffortCliFlag('ultracode')).toEqual({ level: 'ultracode', warning: undefined })
    expect(parseEffortCliFlag(' UltraCode ')).toEqual({ level: 'ultracode', warning: undefined })
  })

  test('unknown value → undefined level + byte-exact warning preserving raw case', () => {
    expect(parseEffortCliFlag('BoGuS')).toEqual({
      level: undefined,
      warning: EXACT_WARNING('BoGuS'),
    })
    expect(parseEffortCliFlag('bogus')).toEqual({
      level: undefined,
      warning: EXACT_WARNING('bogus'),
    })
    // Em dash (U+2014), not a hyphen — matches the official — template.
    expect(parseEffortCliFlag('nope').warning).toContain('—')
    expect(parseEffortCliFlag('nope').warning).not.toContain(' - ')
  })

  test('warning text is byte-identical to the official template', () => {
    expect(parseEffortCliFlag('xyz').warning).toBe(
      "Unknown --effort value 'xyz' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.",
    )
  })
})

describe('Gap-139a: normalizeEffortKeyword / parseEffortKeywordLevel (official NNe / yct)', () => {
  test('normalizeEffortKeyword returns only known keywords', () => {
    expect(normalizeEffortKeyword('ultracode')).toBe('ultracode')
    expect(normalizeEffortKeyword(' ULTRACODE ')).toBe('ultracode')
    expect(normalizeEffortKeyword('high')).toBeUndefined()
    expect(normalizeEffortKeyword('bogus')).toBeUndefined()
    expect(normalizeEffortKeyword(undefined)).toBeUndefined()
    expect(normalizeEffortKeyword(42)).toBeUndefined()
  })

  test('parseEffortKeywordLevel maps keyword → level', () => {
    expect(parseEffortKeywordLevel('ultracode')).toBe('xhigh')
    expect(parseEffortKeywordLevel(' Ultracode ')).toBe('xhigh')
    expect(parseEffortKeywordLevel('high')).toBeUndefined()
    expect(EFFORT_KEYWORD_LEVELS.ultracode).toBe('xhigh')
  })
})

describe('Gap-139a: parseEffortCliLevel (official fhe)', () => {
  test('alias map covers med only', () => {
    expect(Object.keys(EFFORT_LEVEL_ALIASES)).toEqual(['med'])
    expect(EFFORT_LEVEL_ALIASES.med).toBe('medium')
  })

  test('trims, lowercases, applies alias', () => {
    expect(parseEffortCliLevel(' Low ')).toBe('low')
    expect(parseEffortCliLevel('med')).toBe('medium')
    expect(parseEffortCliLevel('ultracode')).toBeUndefined()
    expect(parseEffortCliLevel('bogus')).toBeUndefined()
  })
})

describe('Gap-139a: parseEffortEnvValue (official oL — no trim)', () => {
  test('passes integers through (official j = Number.isInteger)', () => {
    expect(parseEffortEnvValue(42)).toBe(42)
    // Non-integer numbers fall through to the parseInt(String(e)) branch —
    // official oL returns 3 for 3.5 (parseInt('3.5',10)), NOT undefined.
    expect(parseEffortEnvValue(3.5)).toBe(3)
  })

  test("honors the 'med' alias and case-insensitive levels", () => {
    expect(parseEffortEnvValue('med')).toBe('medium')
    expect(parseEffortEnvValue('HIGH')).toBe('high')
  })

  test('does NOT trim (official oL has no trim, unlike fhe)', () => {
    expect(parseEffortEnvValue(' high ')).toBeUndefined()
    expect(parseEffortEnvValue(' med ')).toBeUndefined()
  })

  test('parseInt fallback for numeric strings', () => {
    expect(parseEffortEnvValue('42')).toBe(42)
    expect(parseEffortEnvValue('7abc')).toBe(7)
  })

  test('empty/null/undefined → undefined', () => {
    expect(parseEffortEnvValue('')).toBeUndefined()
    expect(parseEffortEnvValue(null)).toBeUndefined()
    expect(parseEffortEnvValue(undefined)).toBeUndefined()
  })

  test("does NOT resolve the 'ultracode' keyword (that is yct's job)", () => {
    expect(parseEffortEnvValue('ultracode')).toBeUndefined()
  })
})

describe('Gap-139a: parseEffortSessionInit (official kzn = oL ?? yct)', () => {
  test("maps 'ultracode' to 'xhigh'", () => {
    expect(parseEffortSessionInit('ultracode')).toBe('xhigh')
    expect(parseEffortSessionInit(' ULTRACODE ')).toBe('xhigh')
  })

  test('loose value parse wins first', () => {
    expect(parseEffortSessionInit('med')).toBe('medium')
    expect(parseEffortSessionInit('high')).toBe('high')
    expect(parseEffortSessionInit('42')).toBe(42)
    expect(parseEffortSessionInit(42)).toBe(42)
  })

  test('unknown / absent → undefined (caller falls back to settings)', () => {
    expect(parseEffortSessionInit('bogus')).toBeUndefined()
    expect(parseEffortSessionInit(undefined)).toBeUndefined()
    expect(parseEffortSessionInit('')).toBeUndefined()
  })
})

describe('Gap-139a: getEffortEnvOverride uses the alias-aware parser (official N$)', () => {
  test("CLAUDE_CODE_EFFORT_LEVEL=med resolves to 'medium'", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'med'
    expect(getEffortEnvOverride()).toBe('medium')
  })

  test("'unset'/'auto' still return null", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(getEffortEnvOverride()).toBeNull()
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'AUTO'
    expect(getEffortEnvOverride()).toBeNull()
  })

  test('plain levels unchanged', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'
    expect(getEffortEnvOverride()).toBe('xhigh')
  })
})

describe('Gap-139a regression guard: parseEffortValue stays strict (frontmatter callers)', () => {
  test("parseEffortValue does NOT gain the alias maps", () => {
    expect(parseEffortValue('med')).toBeUndefined()
    expect(parseEffortValue('ultracode')).toBeUndefined()
    expect(parseEffortValue('high')).toBe('high')
    expect(parseEffortValue('HIGH')).toBe('high')
  })
})
