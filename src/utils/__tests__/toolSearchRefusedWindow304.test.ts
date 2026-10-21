/**
 * CC 2.1.306 (research-api.md #1/#2) — unit coverage for the tool-search
 * refuse-recovery state machine in src/utils/toolSearch.ts (official v306
 * binary @249522800 / iSe cluster @248312563 / Jmn @249494776 / vf @238694176
 * / vt @240811864).
 *
 * REMOVED from the v304 file (documented, per the official binary): the
 * whole persisted refused-window surface — isToolSearchRefuseRecoveryEnabled
 * (`zOe`), toolSearchRefusedKey (`c`), isRefusedAtFresh (`f`),
 * isToolSearchRefused (`d`), recordToolSearchRefused (`DUs`),
 * pruneRefusedEntries (`Cs`), the TTL `h`=86_400_000 — because the v306 ELF
 * has ZERO `toolSearchRefusedAt` string hits (v304: 6). Recovery in v306 is
 * per-request and one-shot via the retry run's rebuilt state, and
 * modelSupportsToolReference is back to `return!0` after the patterns check.
 * ENABLE_TOOL_SEARCH=true no longer turns the recovery off (the `zOe` gate is
 * gone).
 *
 * SURVIVING v304 sections (kept): XEe default-mode behavior behind a custom
 * base URL, and the haiku unsupported-patterns check.
 *
 * NEW v306 sections: isTrueFirstParty (`Jmn`), isToolSearchBetaRefusalNamed
 * (`iSe`/`TQ`/`e5t`/`Mv`/`eOs`/`Nnn`/`MM` + the `GB`/`oM` exclusions),
 * isAnonymousToolSearchRefuseRecoveryEligible (`Ese` message-side conjuncts
 * incl. the defer_loading guard), throwToolSearchRefused (`EF` verbatim warn
 * with the ENABLE_TOOL_SEARCH=false escape-hatch sentence + `UZ` marker),
 * markToolSearchBetaHealed (`hLe` body: anonymous debug log + the
 * tengu_beta_400_healed {beta,model,provider,status,unnamed} telemetry with
 * the `vt` model sanitizer).
 *
 * The claude.ts-layer wiring (L6 request-state gate, named-then-anonymous
 * path order, the un-defer rebuild, the critical_system_reminder prepend) is
 * covered end-to-end in
 * src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts.
 *
 * Mock discipline (repo convention): real module exports are captured before
 * mock.module registration and re-registered in afterAll (Bun's mock.restore()
 * does not undo mock.module registrations).
 */
import { APIError } from '@anthropic-ai/sdk'
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
// NOTE: this file lives in the same `bun test` directory as
// ideExtensionSingleLaunch300, which reads MACRO.VERSION as its
// BUNDLED_VERSION and feeds it through a real SemVer parse. The usual
// `{ VERSION: 'test' }` polyfill wins the load-order race in some pairings
// and fails that parse ("Invalid SemVer: test"), so this file polyfills a
// VALID semver instead — harmless here and compatible whichever file loads
// first.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.306' }
}

// ---------------------------------------------------------------------------
// Mocks: capture logForDebugging (EF warn / hLe debug log), logEvent (hLe
// telemetry), and controllable auth seams (Jmn's sH constituent).
// ---------------------------------------------------------------------------
const DEBUG_PATH = '../debug.js'
const ANALYTICS_PATH = '../../services/analytics/index.js'
const AUTH_PATH = '../auth.js'

interface DebugLogEntry {
  message: string
  level?: string
}

let debugLogs: DebugLogEntry[] = []
let analyticsEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

/** Per-test auth arrangement; undefined fields fall through to the real impl. */
let authOverrides: {
  apiKey?: string | null
  tokenSource?: { source: string; hasToken: boolean }
} = {}

const actualDebug = { ...((await import(DEBUG_PATH)) as object) }
const actualDebugLogForDebugging = (
  actualDebug as { logForDebugging: unknown }
).logForDebugging as (message: string, options?: { level?: string }) => void

mock.module(DEBUG_PATH, () => ({
  ...actualDebug,
  logForDebugging: (message: string, options?: { level?: string }) => {
    debugLogs.push({ message, level: options?.level })
  },
}))

const actualAnalytics = { ...((await import(ANALYTICS_PATH)) as object) }

mock.module(ANALYTICS_PATH, () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    analyticsEvents.push({ name, metadata })
  },
}))

const actualAuth = { ...((await import(AUTH_PATH)) as object) }
const actualGetAnthropicApiKey = (actualAuth as { getAnthropicApiKey: unknown })
  .getAnthropicApiKey as () => string | null
const actualGetAuthTokenSource = (actualAuth as { getAuthTokenSource: unknown })
  .getAuthTokenSource as () => { source: string; hasToken: boolean }

mock.module(AUTH_PATH, () => ({
  ...actualAuth,
  getAnthropicApiKey: () =>
    authOverrides.apiKey !== undefined
      ? authOverrides.apiKey
      : actualGetAnthropicApiKey(),
  getAuthTokenSource: () =>
    authOverrides.tokenSource ?? actualGetAuthTokenSource(),
}))

const {
  getToolSearchMode,
  isAnonymousToolSearchRefuseRecoveryEligible,
  isToolSearchBetaRefusalNamed,
  isToolSearchEnabledOptimistic,
  isTrueFirstParty,
  markToolSearchBetaHealed,
  modelSupportsToolReference,
  throwToolSearchRefused,
  TOOL_SEARCH_REFUSED_DESCRIPTION_ANONYMOUS,
  TOOL_SEARCH_REFUSED_DESCRIPTION_NAMED,
  TOOL_SEARCH_REFUSED_REMINDER,
  ToolSearchRefusedError,
} = await import('../toolSearch.js')
const { getGlobalConfig } = await import('../config.js')

afterAll(() => {
  mock.module(DEBUG_PATH, () => ({ ...actualDebug }))
  mock.module(ANALYTICS_PATH, () => ({ ...actualAnalytics }))
  mock.module(AUTH_PATH, () => ({ ...actualAuth }))
  mock.restore()
  // Touch the captured real implementations so they stay referenced (the
  // passthrough re-registration above restores them for later files).
  void actualDebugLogForDebugging
})

// ---------------------------------------------------------------------------
// Constants / env isolation
// ---------------------------------------------------------------------------
const CUSTOM_URL = 'https://gateway.example.com'
const OFFICIAL_URL = 'https://api.anthropic.com'
const SONNET = 'claude-sonnet-4-6'
const HAIKU = 'claude-3-haiku'

/** The firstParty tool-search beta header (official z_t() → getToolSearchBetaHeader). */
const BETA_1P = 'advanced-tool-use-2025-11-20'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'ENABLE_TOOL_SEARCH',
  'CI',
] as const

let savedEnv: Record<string, string | undefined> = {}

/** Build an APIError with a structured body (official `Ht` shape). */
function makeApiError(
  status: number,
  bodyMessage: string,
  body?: unknown,
): APIError {
  return new APIError(
    status,
    body ?? { error: { message: bodyMessage } },
    `${status} ${bodyMessage}`,
    new Headers(),
  )
}

/** A 400 whose first line is the official "Unexpected value(s)" shape (`e5t`). */
function namedBetaRefusal(
  header: string = BETA_1P,
  status: number = 400,
): APIError {
  return makeApiError(
    status,
    `Unexpected value(s) \`${header}\` for the \`anthropic-beta\` header. Please consult our documentation at docs.anthropic.com or try again without the header.`,
  )
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Default arrangement: custom gateway base URL, firstParty provider, env API
  // key (so auth lookups never throw in test mode).
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.ANTHROPIC_BASE_URL = CUSTOM_URL
  debugLogs = []
  analyticsEvents = []
  authOverrides = {}
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  debugLogs = []
  analyticsEvents = []
  authOverrides = {}
})

// ---------------------------------------------------------------------------
// 1. SURVIVING v304 section — XEe: tool search ON by default behind a custom
//    base URL (the vprev-303 optimistic-disable branch stays removed in 306).
// ---------------------------------------------------------------------------
describe('CC 2.1.304→306 — default mode behind a custom ANTHROPIC_BASE_URL (XEe, survives)', () => {
  test("unset ENABLE_TOOL_SEARCH + custom base URL → mode 'tst' and optimistic check true", () => {
    // Act
    const mode = getToolSearchMode()
    const optimistic = isToolSearchEnabledOptimistic()

    // Assert — v303 returned false here; 304+ defaults to ON.
    expect(mode).toBe('tst')
    expect(optimistic).toBe(true)
  })

  test('explicit ENABLE_TOOL_SEARCH semantics (=false skips tool search entirely)', () => {
    // =false → standard: the refused request is never sent (the official
    // escape hatch named in EF's warn text).
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(getToolSearchMode()).toBe('standard')
    expect(isToolSearchEnabledOptimistic()).toBe(false)

    // =true → tst. v306 CHANGE vs v304: this no longer turns the recovery
    // off — the `zOe` eligibility gate is gone, so a refusal recovers here
    // too (covered by the integration suite).
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(getToolSearchMode()).toBe('tst')
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. modelSupportsToolReference — back to the official v306 `return!0` form.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — modelSupportsToolReference (official Zae, window arm removed)', () => {
  test('patterns check survives: haiku stays unsupported', () => {
    expect(modelSupportsToolReference(HAIKU)).toBe(false)
  })

  test('supported models are no longer gated by any persisted refused window', () => {
    // The v304 `return !d(e)` arm is gone: nothing can flip a supported
    // model to unsupported, and the config seam no longer carries the key
    // (v306 ELF: ZERO `toolSearchRefusedAt` hits).
    expect(modelSupportsToolReference(SONNET)).toBe(true)
    const config = getGlobalConfig() as { toolSearchRefusedAt?: unknown }
    expect(config.toolSearchRefusedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. NEW — isTrueFirstParty (official Jmn @249494776).
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #2 — isTrueFirstParty (official Jmn)', () => {
  test('firstParty + API key + no base-URL override → true', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isTrueFirstParty()).toBe(true)
  })

  test('base URL exactly api.anthropic.com → true (raw vf host check)', () => {
    process.env.ANTHROPIC_BASE_URL = OFFICIAL_URL
    expect(isTrueFirstParty()).toBe(true)
  })

  test('custom gateway base URL → false', () => {
    // beforeEach set CUSTOM_URL.
    expect(isTrueFirstParty()).toBe(false)
  })

  test('assume-first-party flag does NOT flip it (raw vf ≠ the Mi/Xo variant)', () => {
    // Documented deviation guard: providers.ts isFirstPartyAnthropicBaseUrl
    // honors _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL; Jmn's vf does not.
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(isTrueFirstParty()).toBe(false)
  })

  test('malformed base URL → false (vf catch arm)', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(isTrueFirstParty()).toBe(false)
  })

  test('ANTHROPIC_UNIX_SOCKET set → false', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    expect(isTrueFirstParty()).toBe(false)
  })

  test('non-firstParty provider (bedrock) → false', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isTrueFirstParty()).toBe(false)
  })

  test('subscriber OAuth form (no API key + claude.ai token source) → false (official sH)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    authOverrides = {
      apiKey: null,
      tokenSource: { source: 'claude.ai', hasToken: true },
    }
    expect(isTrueFirstParty()).toBe(false)
  })

  test('fail-closed: a throwing credential lookup → false (official catch arm)', () => {
    // No API key under NODE_ENV='test' makes the real getAnthropicApiKey
    // throw; Jmn's try/catch logs and returns false.
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    expect(isTrueFirstParty()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. NEW — isToolSearchBetaRefusalNamed (official iSe/TQ/e5t/Mv/eOs/Nnn/MM,
//    with the GB and oM exclusions).
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — isToolSearchBetaRefusalNamed (official iSe)', () => {
  test('Unexpected value(s) first line listing the header → true (e5t)', () => {
    expect(isToolSearchBetaRefusalNamed(namedBetaRefusal(), BETA_1P)).toBe(true)
  })

  test('Unexpected value(s) on a 422 → true (e5t has no status gate)', () => {
    expect(isToolSearchBetaRefusalNamed(namedBetaRefusal(BETA_1P, 422), BETA_1P)).toBe(
      true,
    )
  })

  test('Unexpected value(s) listing only OTHER headers → false', () => {
    const err = makeApiError(
      400,
      'Unexpected value(s) `some-other-beta` for the `anthropic-beta` header.',
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('capability_rejected beta_header token → true (MM via e5t/Mv)', () => {
    const err = makeApiError(
      400,
      `Your account does not have access to this beta. capability_rejected: beta_header:${BETA_1P}`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(true)
  })

  test('capability_rejected token must be whole (MM boundary: longer token does not match)', () => {
    const err = makeApiError(
      400,
      `capability_rejected: beta_header:${BETA_1P}-extended`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('400 mentioning the header alongside anthropic-beta → true (Nnn/eOs)', () => {
    const err = makeApiError(
      400,
      `The anthropic_beta header value ${BETA_1P} is not enabled for this organization.`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(true)
  })

  test('header mention WITHOUT any anthropic-beta context → false (Nnn requires both)', () => {
    const err = makeApiError(400, `The value ${BETA_1P} is unknown to us.`)
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('Mv arm is status-400-only: a 422 plain mention does not match (only e5t is status-free)', () => {
    const err = makeApiError(
      422,
      `The anthropic_beta header value ${BETA_1P} is not enabled for this organization.`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('conversation-binding exclusion (GB) → false even when the header is named', () => {
    const err = makeApiError(
      400,
      `messages.5: message not created in this conversation (anthropic-beta ${BETA_1P})`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('thinking-signature exclusion (oM) → false even when the header is named', () => {
    const err = makeApiError(
      400,
      `Invalid signature in thinking block (anthropic-beta: ${BETA_1P})`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('thinking_signature capability token → excluded by oM (MM arm)', () => {
    const err = makeApiError(
      400,
      `Request rejected. capability_rejected: thinking_signature (beta ${BETA_1P}, anthropic-beta)`,
    )
    expect(isToolSearchBetaRefusalNamed(err, BETA_1P)).toBe(false)
  })

  test('non-APIError input → false', () => {
    expect(
      isToolSearchBetaRefusalNamed(new Error('boom'), BETA_1P),
    ).toBe(false)
    expect(isToolSearchBetaRefusalNamed(undefined, BETA_1P)).toBe(false)
  })

  test('null header (tool search not declared on the request) → false (official TQ guard)', () => {
    expect(isToolSearchBetaRefusalNamed(namedBetaRefusal(), null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. NEW — isAnonymousToolSearchRefuseRecoveryEligible (official Ese,
//    message-side conjuncts; L6 lives in the claude.ts handler).
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — isAnonymousToolSearchRefuseRecoveryEligible (official Ese)', () => {
  test('behind a custom gateway (Jmn false): any 400 is eligible', () => {
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(
        makeApiError(400, 'the gateway did not like the request'),
      ),
    ).toBe(true)
  })

  test('behind a custom gateway: 422 is eligible', () => {
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(
        makeApiError(422, 'unprocessable'),
      ),
    ).toBe(true)
  })

  test('status outside 400/422 → not eligible', () => {
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(makeApiError(500, 'boom')),
    ).toBe(false)
  })

  test('billing_error body type → not eligible', () => {
    const err = new APIError(
      400,
      { error: { type: 'billing_error', message: 'insufficient credits' } },
      '400 insufficient credits',
      new Headers(),
    )
    expect(isAnonymousToolSearchRefuseRecoveryEligible(err)).toBe(false)
  })

  test('true-first-party (Jmn true): message WITHOUT defer_loading is not eligible', () => {
    // The Jmn guard: on a genuine first-party connection only refusals that
    // name the deferred-tools mechanism recover anonymously.
    delete process.env.ANTHROPIC_BASE_URL
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(
        makeApiError(400, 'some validation error'),
      ),
    ).toBe(false)
  })

  test('true-first-party (Jmn true): message naming defer_loading IS eligible', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(
        makeApiError(400, 'tools.3.defer_loading: unexpected field defer_loading'),
      ),
    ).toBe(true)
  })

  test('defer_loading must be a whole word (\\b boundaries)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(
      isAnonymousToolSearchRefuseRecoveryEligible(
        makeApiError(400, 'unknown field defer_loading_extended'),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. NEW — throwToolSearchRefused (official EF + UZ).
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — throwToolSearchRefused (official EF/UZ)', () => {
  test('throws ToolSearchRefusedError carrying refusal + declaredToolSearch', () => {
    const err = makeApiError(400, 'refused')
    let caught: unknown
    try {
      throwToolSearchRefused(
        err,
        BETA_1P,
        TOOL_SEARCH_REFUSED_DESCRIPTION_ANONYMOUS,
        true,
      )
    } catch (refused) {
      caught = refused
    }
    expect(caught).toBeInstanceOf(ToolSearchRefusedError)
    const marker = caught as InstanceType<typeof ToolSearchRefusedError>
    expect(marker.message).toBe('tool search refused')
    expect(marker.refusal).toBe(err)
    expect(marker.cause).toBe(err)
    expect(marker.declaredToolSearch).toBe(true)
  })

  test('named-path warn text is verbatim, level warn, with the escape-hatch sentence', () => {
    const err = makeApiError(422, 'refused')
    try {
      throwToolSearchRefused(
        err,
        BETA_1P,
        TOOL_SEARCH_REFUSED_DESCRIPTION_NAMED,
        true,
      )
    } catch {
      // the marker throw IS the contract
    }
    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0]?.level).toBe('warn')
    expect(debugLogs[0]?.message).toBe(
      `[ToolSearch] HTTP 422 refusing the tool search beta (${BETA_1P}); sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request`,
    )
  })

  test('anonymous-path warn text; no header clause when the header is null', () => {
    const err = makeApiError(400, 'refused')
    try {
      throwToolSearchRefused(
        err,
        null,
        TOOL_SEARCH_REFUSED_DESCRIPTION_ANONYMOUS,
        false,
      )
    } catch {
      // the marker throw IS the contract
    }
    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0]?.message).toBe(
      '[ToolSearch] HTTP 400 that no other recovery took, on a request that declared deferred tools; sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request',
    )
  })

  test('description + reminder constants are the official verbatim strings', () => {
    expect(TOOL_SEARCH_REFUSED_DESCRIPTION_NAMED).toBe(
      'refusing the tool search beta',
    )
    expect(TOOL_SEARCH_REFUSED_DESCRIPTION_ANONYMOUS).toBe(
      'that no other recovery took, on a request that declared deferred tools',
    )
    expect(TOOL_SEARCH_REFUSED_REMINDER).toBe(
      'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.',
    )
  })
})

// ---------------------------------------------------------------------------
// 7. NEW — markToolSearchBetaHealed (official hLe body).
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — markToolSearchBetaHealed (official hLe)', () => {
  test('anonymous refusal → verbatim debug log + tengu_beta_400_healed {beta,model,provider,status,unnamed:true}', () => {
    const refusal = makeApiError(400, 'plain gateway refusal')
    markToolSearchBetaHealed(refusal, SONNET)

    expect(
      debugLogs.some(
        entry =>
          entry.message ===
          '[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it',
      ),
    ).toBe(true)

    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed).toHaveLength(1)
    expect(healed[0]?.metadata.beta).toBe(BETA_1P)
    expect(healed[0]?.metadata.model).toBe(SONNET)
    expect(typeof healed[0]?.metadata.provider).toBe('string')
    expect(healed[0]?.metadata.status).toBe(400)
    expect(healed[0]?.metadata.unnamed).toBe(true)
    // v304's `unclaimed:true` field is GONE in v306.
    expect(healed[0]?.metadata.unclaimed).toBeUndefined()
  })

  test('named refusal → no anonymous debug log, unnamed:false', () => {
    markToolSearchBetaHealed(namedBetaRefusal(), SONNET)

    expect(
      debugLogs.some(entry =>
        entry.message.startsWith(
          '[ToolSearch] the endpoint answered the request sent without',
        ),
      ),
    ).toBe(false)
    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed).toHaveLength(1)
    expect(healed[0]?.metadata.unnamed).toBe(false)
    expect(healed[0]?.metadata.status).toBe(400)
  })

  test('model sanitizer (official vt): nonconforming ids report "nonconforming"', () => {
    markToolSearchBetaHealed(makeApiError(422, 'x'), 'claude sonnet with spaces!!')
    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed[0]?.metadata.model).toBe('nonconforming')
  })

  test('model sanitizer (official UI pattern): @YYYYMMDD snapshot ids conform', () => {
    markToolSearchBetaHealed(
      makeApiError(400, 'x'),
      'claude-sonnet-4-6@20260101',
    )
    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed[0]?.metadata.model).toBe('claude-sonnet-4-6@20260101')
  })

  test('model sanitizer (official UI pattern): [1m] snapshot suffix conforms', () => {
    markToolSearchBetaHealed(
      makeApiError(400, 'x'),
      'claude-sonnet-4-6@20260101[1m]',
    )
    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed[0]?.metadata.model).toBe('claude-sonnet-4-6@20260101[1m]')
  })

  test('internal errors never escape (official try/catch → logError)', () => {
    // A refusal whose status access is fine but model sanitize input odd —
    // exercise the catch arm by passing a throwing metadata value: the
    // sanitizer handles null/undefined gracefully, so assert no throw for
    // those shapes.
    expect(() =>
      markToolSearchBetaHealed(
        makeApiError(400, 'x'),
        undefined as unknown as string,
      ),
    ).not.toThrow()
    const healed = analyticsEvents.filter(
      entry => entry.name === 'tengu_beta_400_healed',
    )
    expect(healed).toHaveLength(1)
    expect(healed[0]?.metadata.model).toBeUndefined()
  })
})
