import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LENGTH_LIMIT,
  GLOBAL_FAST_PATH_LENGTH,
  HighlightLimitError,
  LANGUAGE_LENGTH_LIMITS,
  LONG_LINE_CHARS,
  LONG_LINE_EXCESS_LIMIT,
  makeHighlightLimitPlugin,
} from '../hljsLimit.js'

/**
 * OCC-154 fix-round C-item t-02 — Layer A `before:highlight` limit plugin
 * (CC 2.1.295 #091, official `B`/`_7r`/`J`/`x`/`j` chain).
 *
 * Why this file exists: the 验收员 t-02 mutation recipe (bump
 * DEFAULT_LENGTH_LIMIT 50000→100000, or drop the markdown WEIGHT_RULES
 * entry) left every existing suite green — nothing pinned the plugin's
 * observable reject/pass boundaries. This suite drives the exported plugin
 * factory directly and pins:
 *
 *  1. The default 50000 length cap at its exact boundary (50000 pass /
 *     50001 throw) for a plain grammar (python).
 *  2. The tighter per-language caps (asciidoc 16000, http 8000) — and that
 *     http's 8000 cap is a GRAMMAR cap, distinct from the equal-valued
 *     GLOBAL_FAST_PATH_LENGTH: python passes at 8001 while http throws.
 *  3. The long-line excess cost (LONG_LINE_CHARS=256 /
 *     LONG_LINE_EXCESS_LIMIT=16M): a single 5000-char line throws for
 *     python (excess 5000×5000=25M) but PASSES for markdown — the prose
 *     weight rule (`j`: markdown counts only '`~<' chars, 0 here).
 *  4. The htmlish override: the same 5000-char markdown line starting with
 *     `<script>` throws (HTMLISH_TEST matched → all chars weighted).
 *  5. The LONG_LINE_EXCESS_LIMIT boundary on the global fast path:
 *     4000×4000 = 16,000,000 exactly passes (<=), 4001×4001 throws.
 *
 * A fake hljs (`getLanguage: () => undefined`) suffices: `effectiveGrammar`
 * (`F`/`b7r`) returns a length-guarded language immediately without
 * consulting hljs — the subLanguage walk only runs for NON-guarded names.
 *
 * Mutation-verify recipes (each must turn this suite RED):
 *   - hljsLimit.ts `DEFAULT_LENGTH_LIMIT = 50000` → `100000`:
 *     the 50001-throws boundary test goes RED.
 *   - remove `['markdown', [PROSE_CHARS, HTMLISH_TEST]]` from WEIGHT_RULES:
 *     the markdown-prose-passes test goes RED (25M excess now weighted).
 *   - `LONG_LINE_EXCESS_LIMIT = 16_000_000` → `15_999_999`:
 *     the 4000-char fast-path boundary test goes RED.
 */

type LimitPlugin = {
  'before:highlight': (args: { code: string; language?: string }) => void
}

// The guarded-language probe path never resolves subLanguage chains, so a
// stub hljs is enough (see doc block).
const FAKE_HLJS = { getLanguage: (_name: string) => undefined } as never

const plugin = makeHighlightLimitPlugin(FAKE_HLJS) as LimitPlugin

function run(code: string, language?: string): void {
  plugin['before:highlight']({ code, language })
}

function expectThrows(code: string, language?: string): void {
  expect(() => run(code, language)).toThrow(HighlightLimitError)
}

function expectPasses(code: string, language?: string): void {
  expect(() => run(code, language)).not.toThrow()
}

/**
 * Exact-length code whose every LINE_TOKEN_RE token is <= 250 chars, so the
 * long-line excess is 0 and ONLY the length caps decide.
 */
function shortLineCode(len: number): string {
  let out = ''
  while (out.length < len) {
    out += 'a'.repeat(Math.min(249, len - out.length))
    if (out.length < len) {
      out += '\n'
    }
  }
  return out
}

describe('hljsLimit Layer A — constant table pins (official S/u/G/_Yt/HRn)', () => {
  test('pins the official constant values', () => {
    expect(DEFAULT_LENGTH_LIMIT).toBe(50_000)
    expect(LANGUAGE_LENGTH_LIMITS.get('asciidoc')).toBe(16_000)
    expect(LANGUAGE_LENGTH_LIMITS.get('http')).toBe(8_000)
    expect(GLOBAL_FAST_PATH_LENGTH).toBe(8_000)
    expect(LONG_LINE_CHARS).toBe(256)
    expect(LONG_LINE_EXCESS_LIMIT).toBe(16_000_000)
  })
})

describe('hljsLimit Layer A — DEFAULT_LENGTH_LIMIT boundary (t-02 mutation target)', () => {
  test('python at exactly 50000 short-line chars passes', () => {
    const code = shortLineCode(50_000)
    expect(code.length).toBe(50_000)
    expectPasses(code, 'python')
  })

  test('python at 50001 short-line chars throws HighlightLimitError', () => {
    // Mutation RED point: DEFAULT_LENGTH_LIMIT 50000→100000 makes this pass
    // instead of throwing.
    const code = shortLineCode(50_001)
    expect(code.length).toBe(50_001)
    expectThrows(code, 'python')
  })

  test('unknown language falls back to the 50000 default cap', () => {
    expectPasses(shortLineCode(50_000), 'not-a-real-grammar')
    expectThrows(shortLineCode(50_001), 'not-a-real-grammar')
  })
})

describe('hljsLimit Layer A — per-language caps (asciidoc 16000, http 8000)', () => {
  test('asciidoc passes at 16000 and throws at 16001', () => {
    expectPasses(shortLineCode(16_000), 'asciidoc')
    expectThrows(shortLineCode(16_001), 'asciidoc')
  })

  test('http throws at 8001 while python passes — grammar cap, not fast path', () => {
    // GLOBAL_FAST_PATH_LENGTH is also 8000; this contrast proves http's
    // rejection comes from LANGUAGE_LENGTH_LIMITS (grammar path), because
    // python at the same length passes via its 50000 cap after the fast
    // path declines.
    const code = shortLineCode(8_001)
    expectThrows(code, 'http')
    expectPasses(code, 'python')
  })

  test('nestedtext shares the 8000 cap', () => {
    expectPasses(shortLineCode(8_000), 'nestedtext')
    expectThrows(shortLineCode(8_001), 'nestedtext')
  })
})

describe('hljsLimit Layer A — long-line excess + markdown prose weight rule', () => {
  test('5000-char single line throws for python (excess 25M > 16M)', () => {
    // longLineExcess: token 5000 > 256 → countChars(all) × 5000 = 25M.
    // The global fast path declines (25M > 16M) and python has no weight
    // rule, so every char is weighted on the grammar path too.
    expectThrows('a'.repeat(5_000), 'python')
  })

  test('same 5000-char line PASSES for markdown — prose weight counts only `~<', () => {
    // Mutation RED point: removing the markdown WEIGHT_RULES entry makes
    // countChars weight all chars → 25M excess → throw.
    expectPasses('a'.repeat(5_000), 'markdown')
  })

  test('htmlish override: markdown line starting with <script> throws', () => {
    // HTMLISH_TEST matches → proseCharsFor returns undefined → ALL chars
    // weighted → 5000×5000 = 25M > 16M.
    const code = `<script>${'a'.repeat(4_992)}`
    expect(code.length).toBe(5_000)
    expectThrows(code, 'markdown')
  })

  test('excess boundary: 4000×4000 = 16M exactly passes, 4001×4001 throws', () => {
    // Pins LONG_LINE_EXCESS_LIMIT via the <= comparison on the python path
    // (fast path declines at >16M; grammar path re-checks the same limit).
    expectPasses('a'.repeat(4_000), 'python')
    // Mutation RED point: LONG_LINE_EXCESS_LIMIT → 15_999_999 makes the
    // 4000 case throw.
    expectThrows('a'.repeat(4_001), 'python')
  })

  test('lines at or below LONG_LINE_CHARS never accrue excess', () => {
    // 256-char single line: token length is NOT > 256 → excess 0 → fast
    // path passes despite being a "long" line by eye.
    expectPasses('a'.repeat(256), 'python')
    // 257-char single line: excess 257×257 = 66049 ≤ 16M → still passes
    // (the LIMIT, not LONG_LINE_CHARS, rejects).
    expectPasses('a'.repeat(257), 'python')
  })
})
