import { describe, expect, test } from 'bun:test'
import {
  BEHAVIOR_KEYS,
  BEHAVIOR_PCT_THRESHOLD,
  BEHAVIOR_WARNING_TEMPLATES,
  BEHAVIORS_DISCLAIMER,
  formatBehaviors,
  formatTopList,
  formatWindow,
  LIMITS_USAGE_HEADING,
  TOP_LIST_CAP,
  type BehaviorWindowPcts,
} from '../usageWarnings.js'

/**
 * CC 2.1.299 (#017): /usage behavior warnings — catalog + formatter layer.
 *
 * Official forensics (v299 ELF, /tmp/cc-diff-299 — offsets into
 * package/claude):
 *   - Catalog `S` @237017933 (9 keys); v296 @228835711 had only the first
 *     5 — the 4 new keys are the #017 delta.
 *   - `AKr=10` @236999598 pct filter; `g=8` top-list cap.
 *   - `d(s,e)` window formatter, `m(s,e,n)` top-list formatter, `_`
 *     formatBehaviors (heading `y` + disclaimer + windows joined "\n\n").
 */

function makeWindow(
  overrides: Partial<BehaviorWindowPcts> = {},
): BehaviorWindowPcts {
  return {
    request_count: 0,
    session_count: 0,
    behaviors: [],
    agents: [],
    skills: [],
    plugins: [],
    mcp_servers: [],
    ...overrides,
  }
}

describe('#017 — behavior warning catalog (official S @237017933)', () => {
  test('catalog covers exactly the 9 official keys in order', () => {
    expect(BEHAVIOR_KEYS).toEqual([
      'cache_miss',
      'long_context',
      'subagent_heavy',
      'high_parallel',
      'cron',
      'max_effort',
      'workflow',
      'always_on_context',
      'large_tool_results',
    ])
    expect(Object.keys(BEHAVIOR_WARNING_TEMPLATES)).toEqual([
      ...BEHAVIOR_KEYS,
    ])
  })

  test('the 4 keys new in 2.1.299 render byte-exact', () => {
    expect(BEHAVIOR_WARNING_TEMPLATES.max_effort(42)).toBe(
      '42% of your usage was at max effort',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.workflow(42)).toBe(
      '42% of your usage came from workflows',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.always_on_context(42)).toBe(
      '42% of your usage went to always-on context over 40k tokens',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.large_tool_results(42)).toBe(
      '42% of your usage went to tool results over 10k tokens',
    )
  })

  test('the 5 pre-existing keys render byte-exact (v296 @228835711)', () => {
    expect(BEHAVIOR_WARNING_TEMPLATES.cache_miss(11)).toBe(
      '11% of your usage hit a >100k-token cache miss',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.long_context(12)).toBe(
      '12% of your usage was at >150k context',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.subagent_heavy(13)).toBe(
      '13% of your usage came from subagent-heavy sessions',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.high_parallel(14)).toBe(
      '14% of your usage was while 4+ sessions ran in parallel',
    )
    expect(BEHAVIOR_WARNING_TEMPLATES.cron(15)).toBe(
      '15% of your usage came from sessions active for 8+ hours',
    )
  })

  test('heading and disclaimer are the official strings', () => {
    expect(LIMITS_USAGE_HEADING).toBe(
      "What's contributing to your limits usage?",
    )
    expect(BEHAVIORS_DISCLAIMER).toBe(
      'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
    )
  })

  test('thresholds match AKr=10 / g=8', () => {
    expect(BEHAVIOR_PCT_THRESHOLD).toBe(10)
    expect(TOP_LIST_CAP).toBe(8)
  })
})

describe('#017 — formatTopList (official m)', () => {
  test('empty list → null', () => {
    expect(formatTopList('Top skills', [])).toBeNull()
  })

  test('entries render "name pct%" joined by ", " with the label prefix', () => {
    expect(
      formatTopList('Top subagents', [
        { name: 'explore', pct: 30 },
        { name: 'build', pct: 20 },
      ]),
    ).toBe('Top subagents: explore 30%, build 20%')
  })

  test('skills get the official "/" prefix via the name mapper', () => {
    expect(
      formatTopList('Top skills', [{ name: 'commit', pct: 90 }], (r) => `/${r}`),
    ).toBe('Top skills: /commit 90%')
  })

  test('caps at 8 entries with ", +N more"', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `s${i}`,
      pct: 10 - i,
    }))
    const out = formatTopList('Top skills', entries)
    expect(out).toBe(
      'Top skills: s0 10%, s1 9%, s2 8%, s3 7%, s4 6%, s5 5%, s6 4%, s7 3%, +2 more',
    )
  })
})

describe('#017 — formatWindow (official d)', () => {
  test('no behaviors ≥ threshold and no top lists → null', () => {
    expect(formatWindow('Last 24h', makeWindow())).toBeNull()
    expect(
      formatWindow(
        'Last 24h',
        makeWindow({
          request_count: 5,
          session_count: 2,
          behaviors: [{ key: 'cron', pct: 9, count: 1 }],
        }),
      ),
    ).toBeNull()
  })

  test('header is "label · N requests · M sessions" with U+00B7 separators', () => {
    const out = formatWindow(
      'Last 7d',
      makeWindow({
        request_count: 2,
        session_count: 3,
        behaviors: [{ key: 'max_effort', pct: 55, count: 2 }],
      }),
    )
    expect(out).toBe(
      'Last 7d · 2 requests · 3 sessions\n  55% of your usage was at max effort',
    )
  })

  test('singular counts are not pluralized', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 1,
        session_count: 1,
        behaviors: [{ key: 'workflow', pct: 100, count: 1 }],
      }),
    )
    expect(out?.split('\n')[0]).toBe('Last 24h · 1 request · 1 session')
  })

  test('behaviors below the 10% threshold are filtered, rows indented 2 spaces', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 10,
        session_count: 4,
        behaviors: [
          { key: 'always_on_context', pct: 33, count: 3 },
          { key: 'cache_miss', pct: 9, count: 1 },
          { key: 'large_tool_results', pct: 10, count: 2 },
        ],
      }),
    )
    expect(out).toBe(
      'Last 24h · 10 requests · 4 sessions\n' +
        '  33% of your usage went to always-on context over 40k tokens\n' +
        '  10% of your usage went to tool results over 10k tokens',
    )
  })

  test('top lists render after behaviors, 2-space indent; a window with only lists still renders', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 1,
        session_count: 1,
        skills: [{ name: 'commit', pct: 40 }],
        mcp_servers: [{ name: 'chrome', pct: 25 }],
      }),
    )
    expect(out).toBe(
      'Last 24h · 1 request · 1 session\n' +
        '  Top skills: /commit 40%\n' +
        '  Top MCP servers: chrome 25%',
    )
  })
})

describe('#017 — formatBehaviors (official _)', () => {
  test('both windows empty → null', () => {
    expect(
      formatBehaviors({ day: makeWindow(), week: makeWindow() }),
    ).toBeNull()
  })

  test('heading, disclaimer, blank line, then the non-null windows joined by a blank line', () => {
    const out = formatBehaviors({
      day: makeWindow({
        request_count: 3,
        session_count: 1,
        behaviors: [{ key: 'max_effort', pct: 80, count: 3 }],
      }),
      week: makeWindow({
        request_count: 9,
        session_count: 2,
        behaviors: [{ key: 'workflow', pct: 60, count: 5 }],
      }),
    })
    expect(out).toBe(
      [
        "What's contributing to your limits usage?",
        BEHAVIORS_DISCLAIMER,
        '',
        [
          'Last 24h · 3 requests · 1 session\n  80% of your usage was at max effort',
          'Last 7d · 9 requests · 2 sessions\n  60% of your usage came from workflows',
        ].join('\n\n'),
      ].join('\n'),
    )
  })

  test('an empty window is dropped without leaving a stray separator', () => {
    const out = formatBehaviors({
      day: makeWindow(),
      week: makeWindow({
        request_count: 1,
        session_count: 1,
        behaviors: [{ key: 'long_context', pct: 100, count: 1 }],
      }),
    })
    expect(out).toContain('Last 7d · 1 request · 1 session')
    expect(out).not.toContain('Last 24h')
    expect(out?.endsWith('  100% of your usage was at >150k context')).toBe(true)
  })
})
