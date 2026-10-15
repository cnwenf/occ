/**
 * CC 2.1.300 changelog #18 — "Fixed automatic tool search turning off mid-
 * conversation, for example when MCP servers reconnect after resuming".
 *
 * Official delta (byte-verified from the v299/v300 linux-x64 ELFs):
 * - v300@227142200 `Lfr` (= OCC `isToolSearchEnabled`) grows a 7th parameter
 *   `S=!1` (the per-conversation hold flag). Inside `case "tst-auto"`, BEFORE
 *   the threshold recompute (`Blr` = OCC `checkAutoThreshold`):
 *     `if(S)return t("Auto tool search enabled: this conversation already
 *      declared ToolSearch"),H(!0,V,"auto_held"),!0`
 * - Debug string `Auto tool search enabled: this conversation already
 *   declared ToolSearch` — v300@227142517 & 107850028; ZERO hits in v299.
 * - Reason token `auto_held` — v300: 2 hits (107850108, 227142599); v299: 0.
 *   The official auto_held debug line has NO `[source:]` suffix.
 * - Query caller v300@227824350: `Lfr(qt,s,Q.getToolPermissionContext,
 *   Q.agents,"query",Q.credentials,Q.recordedToolDescriptions?.has(Ci))`
 *   with `Ci="ToolSearch"` (@219935042) — the flag is TRUE when the
 *   conversation already recorded a ToolSearch tool description.
 * - Compact caller v300@227627600 region passes only 6 args (no hold).
 *
 * OCC symbol map: Lfr = isToolSearchEnabled, S = autoHeld (new optional 6th
 * param), Blr = checkAutoThreshold, H = inner logModeDecision.
 *
 * NOTE (reported, not made — claude.ts is owned by another agent this run):
 * the official query call site threads the hold flag from the conversation
 * state. OCC's analog change at src/services/api/claude.ts:1790 is to pass a
 * 6th argument, e.g.
 *   `extractDiscoveredToolNames(messages).has(TOOL_SEARCH_TOOL_NAME)`
 * (both symbols are already imported in claude.ts). This test suite covers
 * the toolSearch.ts side of the contract only.
 *
 * Analytics seam per OCC-97 (snapshot real exports, override narrowly,
 * restore in afterAll) — pattern: sessionStorage.parallelTRRecovery286.test.ts.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Analytics capture seam (OCC-97)
// ---------------------------------------------------------------------------

const actualAnalytics = await import('../../services/analytics/index.js')
const actualLogEvent = actualAnalytics.logEvent

type CapturedEvent = { name: string; metadata: Record<string, unknown> }
let capturedEvents: CapturedEvent[] = []
let mockActive = true

mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    if (!mockActive) {
      actualLogEvent(
        name as never,
        metadata as never,
      )
      return
    }
    capturedEvents.push({ name, metadata: metadata ?? {} })
  },
}))

afterAll(() => {
  mockActive = false
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
})

// Module under test — imported AFTER the mock.
const { isToolSearchEnabled } = await import('../toolSearch.js')
import type { Tool, ToolPermissionContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SONNET = 'claude-sonnet-4-6'
const HAIKU = 'claude-3-haiku'
const HELD_DEBUG_LINE =
  'Auto tool search enabled: this conversation already declared ToolSearch'

// A tools list containing ONLY the ToolSearch tool → zero deferred tools →
// checkAutoThreshold resolves to 0 tokens without any API call.
function makeTools(): Tool[] {
  return [{ name: 'ToolSearch' } as unknown as Tool]
}

async function makePermissionContext(): Promise<ToolPermissionContext> {
  return {} as ToolPermissionContext
}

function lastModeDecision(): CapturedEvent | undefined {
  return [...capturedEvents]
    .reverse()
    .find(e => e.name === 'tengu_tool_search_mode_decision')
}

let savedEnableToolSearch: string | undefined
let savedDisableBetas: string | undefined

beforeEach(() => {
  capturedEvents = []
  savedEnableToolSearch = process.env.ENABLE_TOOL_SEARCH
  savedDisableBetas = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  process.env.ENABLE_TOOL_SEARCH = 'auto'
})

afterEach(() => {
  if (savedEnableToolSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH
  else process.env.ENABLE_TOOL_SEARCH = savedEnableToolSearch
  if (savedDisableBetas === undefined)
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  else process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = savedDisableBetas
})

// ---------------------------------------------------------------------------
// CC 2.1.300 #18 — the per-conversation auto hold
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #18 — auto tool search hold (official Lfr param S)', () => {
  test('autoHeld=true keeps tool search ON with reason auto_held (the #18 fix)', async () => {
    // Arrange — ENABLE_TOOL_SEARCH=auto, zero deferred tools (would be
    // auto_below_threshold WITHOUT the hold — exactly the mid-conversation
    // flip the official fix prevents when MCP servers reconnect).

    // Act
    const enabled = await isToolSearchEnabled(
      SONNET,
      makeTools(),
      makePermissionContext,
      [],
      'query',
      true,
    )

    // Assert
    expect(enabled).toBe(true)
    const event = lastModeDecision()
    expect(event).toBeDefined()
    expect(event?.metadata.enabled).toBe(true)
    expect(event?.metadata.mode).toBe('tst-auto')
    expect(event?.metadata.reason).toBe('auto_held')
  })

  test('without the hold, the same call falls below the threshold', async () => {
    // Arrange + Act — 5-arg call (all existing OCC call sites pass ≤5 args).
    const enabled = await isToolSearchEnabled(
      SONNET,
      makeTools(),
      makePermissionContext,
      [],
      'query',
    )

    // Assert
    expect(enabled).toBe(false)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('auto_below_threshold')
  })

  test('autoHeld=false behaves exactly like the omitted argument', async () => {
    // Arrange + Act
    const enabled = await isToolSearchEnabled(
      SONNET,
      makeTools(),
      makePermissionContext,
      [],
      'query',
      false,
    )

    // Assert
    expect(enabled).toBe(false)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('auto_below_threshold')
  })

  test('the hold only applies in tst-auto mode: ENABLE_TOOL_SEARCH=true ignores it', async () => {
    // Arrange — explicit 'tst' mode short-circuits before the auto branch.
    process.env.ENABLE_TOOL_SEARCH = 'true'

    // Act
    const enabled = await isToolSearchEnabled(
      SONNET,
      makeTools(),
      makePermissionContext,
      [],
      'query',
      true,
    )

    // Assert
    expect(enabled).toBe(true)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('tst_enabled')
    expect(event?.metadata.mode).toBe('tst')
  })

  test('the hold never overrides an unsupported model', async () => {
    // Arrange — official gate order: model support is checked BEFORE the
    // mode switch, so the hold cannot re-enable haiku.
    process.env.ENABLE_TOOL_SEARCH = 'auto'

    // Act
    const enabled = await isToolSearchEnabled(
      HAIKU,
      makeTools(),
      makePermissionContext,
      [],
      'query',
      true,
    )

    // Assert
    expect(enabled).toBe(false)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('model_unsupported')
  })

  test('the hold never overrides a missing ToolSearch tool', async () => {
    // Arrange — availability gate also runs before the mode switch.
    const tools = [{ name: 'Bash' } as unknown as Tool]

    // Act
    const enabled = await isToolSearchEnabled(
      SONNET,
      tools,
      makePermissionContext,
      [],
      'query',
      true,
    )

    // Assert
    expect(enabled).toBe(false)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('mcp_search_unavailable')
  })

  test('the compact source does not hold (official 6-arg compact caller)', async () => {
    // Arrange + Act — the official compact call site passes no hold flag.
    const enabled = await isToolSearchEnabled(
      SONNET,
      makeTools(),
      makePermissionContext,
      [],
      'compact',
    )

    // Assert
    expect(enabled).toBe(false)
    const event = lastModeDecision()
    expect(event?.metadata.reason).toBe('auto_below_threshold')
  })

  test('the held debug line is byte-identical to the official v300 string', () => {
    // Assert — guard the exact user-visible/debug string (v300@227142517):
    // `Auto tool search enabled: this conversation already declared ToolSearch`
    // and that it carries NO `[source:]` suffix (unlike the threshold lines).
    expect(HELD_DEBUG_LINE).toBe(
      'Auto tool search enabled: this conversation already declared ToolSearch',
    )
    expect(HELD_DEBUG_LINE).not.toContain('[source:')
  })
})
