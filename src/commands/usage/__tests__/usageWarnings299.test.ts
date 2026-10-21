import { describe, expect, test } from 'bun:test'
import type { UsageRecommendation } from '../usageRecommendations.js'
import {
  BEHAVIOR_KEYS,
  BEHAVIOR_PCT_THRESHOLD,
  BEHAVIORS_DISCLAIMER,
  formatBehaviors,
  formatTopList,
  formatWindow,
  LIMITS_USAGE_HEADING,
  TOP_LIST_CAP,
  type BehaviorWindowPcts,
} from '../usageWarnings.js'

/**
 * CC 2.1.299 (#017) + CC 2.1.305 (/usage one-line fixes): the /usage
 * behaviors text-formatter layer.
 *
 * Official forensics (v306 ELF, /tmp/cc-diff-306 — offsets into
 * package/claude):
 *   - v306 text formatter module @261447620: `S` formatBehaviors,
 *     `h(label, window)` formatWindow, `m(label, entries, prefix)`
 *     formatTopList (`y=8` cap).
 *   - v299 BEHAVIOR_WARNING_TEMPLATES strings (">100k-token cache miss"
 *     etc.): 3 hits in v304, 0 in v306 — officially deleted; the v305
 *     recommendation rows (`  NN%  title · detail`) replace them.
 *   - v306 disclaimer: "Approximate · sessions on this machine only ·
 *     shares overlap" (the long v299 disclaimer is gone).
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

function rec(
  pct: number,
  title: string,
  detail?: string,
): UsageRecommendation {
  return {
    key: title.toLowerCase().replace(/\W+/g, '_'),
    pct,
    title,
    ...(detail !== undefined ? { detail } : {}),
  }
}

describe('#017 — behavior key catalog (unchanged in v306)', () => {
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
  })

  test('heading and v306 disclaimer are the official strings', () => {
    expect(LIMITS_USAGE_HEADING).toBe(
      "What's contributing to your limits usage?",
    )
    expect(BEHAVIORS_DISCLAIMER).toBe(
      'Approximate · sessions on this machine only · shares overlap',
    )
  })

  test('thresholds match P$e=10 / y=8', () => {
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

describe('2.1.305 — formatWindow (official v306 h)', () => {
  test('no recommendations and no top lists → null (behaviors alone no longer render)', () => {
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
        recommendations: [rec(55, 'Save max effort for hard tasks')],
      }),
    )
    expect(out).toBe(
      'Last 7d · 2 requests · 3 sessions\n  55%  Save max effort for hard tasks',
    )
  })

  test('singular counts are not pluralized', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 1,
        session_count: 1,
        recommendations: [rec(100, 'Save workflows for big tasks')],
      }),
    )
    expect(out?.split('\n')[0]).toBe('Last 24h · 1 request · 1 session')
  })

  test('recommendation rows are "  NN%  title · detail" with the pct right-padded to 2', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 10,
        session_count: 4,
        recommendations: [
          rec(33, 'See what fills your context', 'run /context'),
          rec(10, 'Compact before you step away', 'run /compact'),
          rec(100, 'Turn off ultracode', '/effort ultracode off'),
        ],
      }),
    )
    expect(out).toBe(
      'Last 24h · 10 requests · 4 sessions\n' +
        '  33%  See what fills your context · run /context\n' +
        '  10%  Compact before you step away · run /compact\n' +
        '  100%  Turn off ultracode · /effort ultracode off',
    )
  })

  test('a recommendation without detail renders no separator', () => {
    const out = formatWindow(
      'Last 24h',
      makeWindow({
        request_count: 1,
        session_count: 1,
        recommendations: [rec(12, 'Stop sessions you no longer need')],
      }),
    )
    expect(out).toBe(
      'Last 24h · 1 request · 1 session\n  12%  Stop sessions you no longer need',
    )
  })

  test('top lists render after recommendations, 2-space indent; a window with only lists still renders', () => {
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

describe('2.1.305 — formatBehaviors (official v306 S)', () => {
  test('both windows empty → null', () => {
    expect(
      formatBehaviors({ day: makeWindow(), week: makeWindow() }),
    ).toBeNull()
  })

  test('heading, v306 disclaimer, blank line, then the non-null windows joined by a blank line', () => {
    const out = formatBehaviors({
      day: makeWindow({
        request_count: 3,
        session_count: 1,
        recommendations: [rec(80, 'Save max effort for hard tasks')],
      }),
      week: makeWindow({
        request_count: 9,
        session_count: 2,
        recommendations: [rec(60, 'Save workflows for big tasks')],
      }),
    })
    expect(out).toBe(
      [
        "What's contributing to your limits usage?",
        BEHAVIORS_DISCLAIMER,
        '',
        [
          'Last 24h · 3 requests · 1 session\n  80%  Save max effort for hard tasks',
          'Last 7d · 9 requests · 2 sessions\n  60%  Save workflows for big tasks',
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
        recommendations: [rec(100, 'Start fresh when you switch tasks', 'run /clear')],
      }),
    })
    expect(out).toContain('Last 7d · 1 request · 1 session')
    expect(out).not.toContain('Last 24h')
    expect(
      out?.endsWith(' 100%  Start fresh when you switch tasks · run /clear'),
    ).toBe(true)
  })
})
