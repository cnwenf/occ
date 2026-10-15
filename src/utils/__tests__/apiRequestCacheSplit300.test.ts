import { afterAll, describe, expect, mock, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.300 (#2) — "Added `cache_creation_5m_tokens` and
 * `cache_creation_1h_tokens` to the OpenTelemetry `api_request` event,
 * splitting cache writes by lifetime."
 *
 * Byte evidence (docs/gap-research-300/triage-T1.md §2):
 *   v300 api_request builder @227727872:
 *     pi("api_request",{model:e,input_tokens:w.input_tokens,
 *       output_tokens:w.output_tokens,
 *       cache_read_tokens:w.cache_read_input_tokens,
 *       cache_creation_tokens:w.cache_creation_input_tokens,
 *       cache_creation_5m_tokens:w.cache_creation?.ephemeral_5m_input_tokens??0,
 *       cache_creation_1h_tokens:w.cache_creation?.ephemeral_1h_input_tokens??0,
 *       cost_usd:Nr,...})
 *   v299 builder @226508395 has NO cache_creation_5m/1h fields (grep -c → 0).
 *   Field names also appear in the v300 OTel-attribute table @107102784.
 *
 * OCC convention at this emit site: every numeric attr is String()-wrapped
 * (input_tokens/output_tokens/cache_read_tokens/cache_creation_tokens/cost_usd
 * all pre-exist as String()); the two new fields follow the same convention —
 * value semantics identical to the official (`usage.cache_creation?.X ?? 0`).
 */

// --- Mock seam (OCC-97 pattern: snapshot real exports, override
// logOTelEvent narrowly, restore in afterAll). ---
const actualEventsModule = await import('../telemetry/events.js')
const actualEventsExports = { ...actualEventsModule }
type OtelCall = { name: string; attrs: Record<string, unknown> }
const otelCalls: OtelCall[] = []
mock.module('../telemetry/events.js', () => ({
  ...actualEventsExports,
  logOTelEvent: (name: string, attrs: Record<string, unknown> = {}): Promise<void> => {
    otelCalls.push({ name, attrs })
    return Promise.resolve()
  },
}))

afterAll(() => {
  mock.module('../telemetry/events.js', () => ({ ...actualEventsExports }))
})

const { logAPISuccessAndDuration } = await import('../../services/api/logging.js')

function makeUsage(overrides: Record<string, unknown> = {}) {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    inference_geo: 'global',
    iterations: [],
    speed: 'standard',
    ...overrides,
  }
}

function baseParams(usage: Record<string, unknown>) {
  const now = Date.now()
  return {
    model: 'claude-test',
    start: now - 5,
    startIncludingRetries: now - 5,
    usage,
    messageCount: 1,
    messageTokens: 100,
    costUSD: 0.001,
    attempt: 0,
  } as never
}

describe('2.1.300 #2 — api_request OTel cache-write lifetime split', () => {
  test('emits cache_creation_5m_tokens and cache_creation_1h_tokens from usage.cache_creation', () => {
    otelCalls.length = 0
    logAPISuccessAndDuration(
      baseParams(
        makeUsage({
          cache_creation: {
            ephemeral_5m_input_tokens: 1200,
            ephemeral_1h_input_tokens: 3400,
          },
        }),
      ),
    )
    const evt = otelCalls.find(c => c.name === 'api_request')
    expect(evt).toBeDefined()
    expect(evt!.attrs.cache_creation_5m_tokens).toBe('1200')
    expect(evt!.attrs.cache_creation_1h_tokens).toBe('3400')
    // Pre-existing fields untouched.
    expect(evt!.attrs.cache_creation_tokens).toBe('40')
    expect(evt!.attrs.cache_read_tokens).toBe('30')
  })

  test('missing cache_creation object falls back to "0"/"0" (official ??0 semantics)', () => {
    otelCalls.length = 0
    logAPISuccessAndDuration(baseParams(makeUsage()))
    const evt = otelCalls.find(c => c.name === 'api_request')
    expect(evt).toBeDefined()
    expect(evt!.attrs.cache_creation_5m_tokens).toBe('0')
    expect(evt!.attrs.cache_creation_1h_tokens).toBe('0')
  })

  test('partial cache_creation (only 5m arm) → 1h arm falls back to "0"', () => {
    otelCalls.length = 0
    logAPISuccessAndDuration(
      baseParams(
        makeUsage({
          cache_creation: { ephemeral_5m_input_tokens: 77 },
        }),
      ),
    )
    const evt = otelCalls.find(c => c.name === 'api_request')
    expect(evt!.attrs.cache_creation_5m_tokens).toBe('77')
    expect(evt!.attrs.cache_creation_1h_tokens).toBe('0')
  })
})
