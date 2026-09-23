import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { QuerySource } from '../../../constants/querySource.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'

/**
 * 2.1.280 #064 — /cost cache-miss causes: thinking mode/display changes.
 *
 * v280 added thinkingModeChanged/thinkingDisplayChanged to the prompt-cache-
 * break detector: the snapshot carries `thinkingConfig`, the mode/display are
 * derived per official `Sn`/`Fn` (@199384065), diffed per `dEt` (@199382474)
 * with ''-guards, folded into anyChanged, reported with byte-exact
 * diagnostics between the effort and extra-body parts (@199392699), and
 * surfaced as booleans on tengu_prompt_cache_break (@199397523). v278 has
 * zero hits for "thinking mode changed" — confirmed new in v280.
 *
 * Official strings (byte-exact, → is →):
 *   `thinking mode changed (${prevThinkingMode} → ${newThinkingMode})`
 *   `thinking display changed (${prevThinkingDisplay||"none"} → ${newThinkingDisplay||"none"})`
 */

// ---------------------------------------------------------------------------
// logForDebugging capture — the diagnostics label text only surfaces through
// the [PROMPT CACHE BREAK] summary, so mock src/utils/debug.js (spread the
// real module, restore after; same discipline as the growthbook mocks).
// ---------------------------------------------------------------------------
const DEBUG_MODULE_PATH = 'src/utils/debug.js'
const realDebug = await import(DEBUG_MODULE_PATH)
const debugLogs: string[] = []
mock.module(DEBUG_MODULE_PATH, () => ({
  ...realDebug,
  logForDebugging: (message: string) => {
    debugLogs.push(message)
  },
}))

const {
  checkResponseForCacheBreak,
  recordPromptState,
  resetPromptCacheBreakDetection,
} = require('../promptCacheBreakDetection.js') as typeof import('../promptCacheBreakDetection.js')

const {
  _resetForTesting: resetAnalyticsForTesting,
  attachAnalyticsSink,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')

const QUERY_SOURCE = 'repl_main_thread' as QuerySource
const MODEL = 'claude-opus-5'

function makeSnapshot(overrides?: {
  thinkingConfig?: ThinkingConfig
  systemText?: string
}) {
  const system: TextBlockParam[] = [
    { type: 'text', text: overrides?.systemText ?? 'You are OCC, a coding agent.' },
  ]
  const toolSchemas: BetaToolUnion[] = []
  return {
    system,
    toolSchemas,
    querySource: QUERY_SOURCE,
    model: MODEL,
    ...(overrides?.thinkingConfig !== undefined && {
      thinkingConfig: overrides.thinkingConfig,
    }),
  }
}

/** OCC's ThinkingConfig has no `display` yet — the official v280 config does. */
function thinkingWithDisplay(
  type: 'enabled',
  budgetTokens: number,
  display: string,
): ThinkingConfig {
  return { type, budgetTokens, display } as unknown as ThinkingConfig
}

let events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []

function attachCapturingSink(): void {
  events = []
  attachAnalyticsSink({
    logEvent: (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
    logEventAsync: async (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
  })
}

function cacheBreakEvent(): { eventName: string; metadata: Record<string, unknown> } | undefined {
  return events.find(e => e.eventName === 'tengu_prompt_cache_break')
}

function breakSummary(): string | undefined {
  return debugLogs.find(m => m.includes('[PROMPT CACHE BREAK]'))
}

beforeEach(() => {
  resetPromptCacheBreakDetection()
  resetAnalyticsForTesting()
  debugLogs.length = 0
  attachCapturingSink()
})

afterEach(() => {
  resetPromptCacheBreakDetection()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

describe('2.1.280 #064 — thinking mode change detection', () => {
  test('detects an on → off mode change with the byte-exact label', async () => {
    // Arrange — official derivation: enabled → mode 'on', disabled → 'off'.
    recordPromptState(
      makeSnapshot({ thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } }),
    )
    // Seed the cache-read baseline (first checkResponseForCacheBreak returns
    // early — prevCacheReadTokens was null).
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act — flip thinking off; everything else identical.
    recordPromptState(makeSnapshot({ thinkingConfig: { type: 'disabled' } }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert — telemetry booleans (official payload order: effort,
    // thinkingMode, thinkingDisplay, extraBody).
    const event = cacheBreakEvent()
    expect(event).toBeDefined()
    expect(event?.metadata.thinkingModeChanged).toBe(true)
    expect(event?.metadata.thinkingDisplayChanged).toBe(false)
    // Byte-exact diagnostics label — official:
    //   `thinking mode changed (${prevThinkingMode} → ${newThinkingMode})`
    // (NO ||fallback on the mode strings).
    const summary = breakSummary()
    expect(summary).toBeDefined()
    expect(summary).toContain('thinking mode changed (on → off)')
  })

  test('detects an off → on mode change', async () => {
    // Arrange
    recordPromptState(makeSnapshot({ thinkingConfig: { type: 'disabled' } }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act
    recordPromptState(
      makeSnapshot({ thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert
    expect(cacheBreakEvent()?.metadata.thinkingModeChanged).toBe(true)
    expect(breakSummary()).toContain('thinking mode changed (off → on)')
  })

  test('the first snapshot carrying thinkingConfig never reports a change (official "" guard)', async () => {
    // Arrange — seed WITHOUT thinkingConfig: prev.thinkingMode === ''.
    recordPromptState(makeSnapshot())
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act — official dEt: `e.thinkingMode!==""&&n.thinkingMode!==""&&…`
    recordPromptState(
      makeSnapshot({ thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert — the break still fires (token drop) but with no thinking cause.
    const event = cacheBreakEvent()
    expect(event).toBeDefined()
    expect(event?.metadata.thinkingModeChanged).toBe(false)
    expect(event?.metadata.thinkingDisplayChanged).toBe(false)
    expect(breakSummary()).not.toContain('thinking mode changed')
    expect(breakSummary()).not.toContain('thinking display changed')
  })
})

describe('2.1.280 #064 — thinking display change detection', () => {
  test('detects a display change while the mode is unchanged, with the byte-exact label', async () => {
    // Arrange — same mode ('on'), display concise → detailed.
    recordPromptState(
      makeSnapshot({ thinkingConfig: thinkingWithDisplay('enabled', 10_000, 'concise') }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act — official dEt: `e.thinkingMode!==""&&n.thinkingMode===e.thinkingMode
    // &&n.thinkingDisplay!==e.thinkingDisplay`
    recordPromptState(
      makeSnapshot({ thinkingConfig: thinkingWithDisplay('enabled', 10_000, 'detailed') }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert
    const event = cacheBreakEvent()
    expect(event?.metadata.thinkingModeChanged).toBe(false)
    expect(event?.metadata.thinkingDisplayChanged).toBe(true)
    // Byte-exact — official uses ||"none" fallbacks on the display strings.
    expect(breakSummary()).toContain(
      'thinking display changed (concise → detailed)',
    )
  })

  test('a missing display renders as "none" in the label (official ||"none" fallback)', async () => {
    // Arrange — display 'concise' then a config without display ('' via Fn).
    recordPromptState(
      makeSnapshot({ thinkingConfig: thinkingWithDisplay('enabled', 10_000, 'concise') }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act
    recordPromptState(
      makeSnapshot({ thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert
    expect(cacheBreakEvent()?.metadata.thinkingDisplayChanged).toBe(true)
    expect(breakSummary()).toContain('thinking display changed (concise → none)')
  })

  test('a mode change is NOT also reported as a display change', async () => {
    // Arrange — 'on' with display, then disabled: mode changes AND display
    // collapses to '' — official reports the mode only (display arm requires
    // n.thinkingMode===e.thinkingMode).
    recordPromptState(
      makeSnapshot({ thinkingConfig: thinkingWithDisplay('enabled', 10_000, 'concise') }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act
    recordPromptState(makeSnapshot({ thinkingConfig: { type: 'disabled' } }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert
    const event = cacheBreakEvent()
    expect(event?.metadata.thinkingModeChanged).toBe(true)
    expect(event?.metadata.thinkingDisplayChanged).toBe(false)
    expect(breakSummary()).toContain('thinking mode changed (on → off)')
    expect(breakSummary()).not.toContain('thinking display changed')
  })
})

describe('2.1.280 #064 — no thinking change adds no cause', () => {
  test('identical thinking config across calls → neither flag, no label', async () => {
    // Arrange
    const config: ThinkingConfig = { type: 'enabled', budgetTokens: 10_000 }
    recordPromptState(makeSnapshot({ thinkingConfig: config }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act — same config again; only the token drop triggers the break.
    recordPromptState(makeSnapshot({ thinkingConfig: config }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert
    const event = cacheBreakEvent()
    expect(event).toBeDefined()
    expect(event?.metadata.thinkingModeChanged).toBe(false)
    expect(event?.metadata.thinkingDisplayChanged).toBe(false)
    const summary = breakSummary()
    expect(summary).not.toContain('thinking mode changed')
    expect(summary).not.toContain('thinking display changed')
  })

  test('a thinking-only change still makes the diff "anyChanged" (cause is attributed, not unknown)', async () => {
    // Arrange — everything else identical; only thinkingConfig differs.
    recordPromptState(
      makeSnapshot({ thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } }),
    )
    await checkResponseForCacheBreak(QUERY_SOURCE, 100_000, 5_000, [])

    // Act
    recordPromptState(makeSnapshot({ thinkingConfig: { type: 'disabled' } }))
    await checkResponseForCacheBreak(QUERY_SOURCE, 50_000, 30_000, [])

    // Assert — the summary names the thinking cause instead of falling to
    // 'unknown cause' / 'likely server-side'.
    const summary = breakSummary()
    expect(summary).toContain('thinking mode changed (on → off)')
    expect(summary).not.toContain('unknown cause')
    expect(summary).not.toContain('likely server-side')
  })
})
