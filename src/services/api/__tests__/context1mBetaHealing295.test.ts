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

/**
 * CC 2.1.295 PORT #016 — context-1m-beta 400 healing: detectors, the
 * per-request `qtt`/`Ztt`/`SEe` state machine, the process latch ($wr/$n),
 * the context-sizing gates (dUn/uUn), and the withRetry wiring.
 *
 * All offsets/strings byte-verified against the v295 ELF
 * (/tmp/cc-153/v295/package/claude): qtt @217663771, Ztt @217663952,
 * Yie @215746137, iN @215746028, qCe @209475101, $wr/Gr @209332322,
 * $n @206949551, dUn @209463598, uUn Gr gate @209465489, Cc @209477214,
 * store @206597264, clears zGn @206601086 / dln @224977400. v294 has zero
 * hits for 'retry:context-1m-beta' / 'resending once without it' / 'left out
 * for this model' — the whole mechanism is new in v295.
 */

// --- mocks: install BEFORE requiring the modules under test -----------------
// Passthrough-flag pattern (same as retryWatchdogMaxWait295.test.ts).

const actualSleepModule = { ...require('../../../utils/sleep.js') } as typeof import('../../../utils/sleep.js')
let sleepMockActive = true
const sleepCalls: number[] = []
mock.module('../../../utils/sleep.js', () => ({
  ...actualSleepModule,
  sleep: async (ms: number, signal?: AbortSignal) => {
    if (!sleepMockActive) return actualSleepModule.sleep(ms, signal)
    sleepCalls.push(ms)
  },
}))

const actualAnalytics = { ...require('../../analytics/index.js') } as typeof import('../../analytics/index.js')
let analyticsMockActive = true
type RecordedEvent = { name: string; metadata: Record<string, unknown> }
const events: RecordedEvent[] = []
mock.module('../../analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (!analyticsMockActive) return actualAnalytics.logEvent(name, metadata)
    events.push({ name, metadata })
  },
}))

// utils/config.js passthrough — the coral_reef_sonnet clientDataCache flag
// drives getSonnet1mExpTreatmentEnabled; flip coralReefConfigActive inside
// the kelp-gate test only.
const actualConfig = { ...require('../../../utils/config.js') } as typeof import('../../../utils/config.js')
let configMockActive = true
let coralReefConfigActive = false
mock.module('../../../utils/config.js', () => ({
  ...actualConfig,
  getGlobalConfig: () => {
    if (!configMockActive) return actualConfig.getGlobalConfig()
    if (coralReefConfigActive) {
      return { clientDataCache: { coral_reef_sonnet: 'true' } } as ReturnType<
        typeof actualConfig.getGlobalConfig
      >
    }
    return actualConfig.getGlobalConfig()
  },
}))

const {
  createContext1mBetaRetryHandler,
  isContext1mBetaRefusedError,
  isInvalidBetaFlagError,
  latchContext1mRefused,
} = require('../context1mBetaRetry.js') as typeof import('../context1mBetaRetry.js')

const { CONTEXT_1M_BETA_HEADER } =
  require('../../../constants/betas.js') as typeof import('../../../constants/betas.js')

const {
  clearBetaHeaderLatches,
  clearContext1mRefusedModels,
  isContext1mRefusedForModel,
  markContext1mRefusedModel,
} = require('../../../bootstrap/state.js') as typeof import('../../../bootstrap/state.js')

const {
  getContextWindowForModel,
  getSonnet1mExpTreatmentEnabled,
} = require('../../../utils/context.js') as typeof import('../../../utils/context.js')

const { withRetry } = require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene --------------------------------------------------------------

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'DISABLE_COMPACT',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}

/** A non-first-party endpoint — the healing scenario (gateway refuses beta). */
const GATEWAY_BASE_URL = 'https://my-gateway.example.com'

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  clearContext1mRefusedModels()
  sleepCalls.length = 0
  events.length = 0
  coralReefConfigActive = false
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearContext1mRefusedModels()
})

afterAll(() => {
  sleepMockActive = false
  analyticsMockActive = false
  configMockActive = false
  coralReefConfigActive = false
})

// --- helpers ------------------------------------------------------------------

function apiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

/** A 400 naming the beta header (official Yie, first arm). */
const namedHeaderError = () =>
  apiError(
    400,
    `betas: ${CONTEXT_1M_BETA_HEADER} is not supported by this endpoint`,
  )

/** A 400 naming the "long context beta" (official Yie, second arm). */
const longContextBetaError = () =>
  apiError(400, 'the long context beta is unavailable here')

/** A generic "invalid beta flag" 400 (official iN). */
const invalidFlagError = () => apiError(400, 'Invalid beta flag sent')

type Harness = {
  handler: ReturnType<typeof createContext1mBetaRetryHandler>
  getBetas: () => string[]
}

function makeHandler(opts?: {
  model?: string
  betas?: string[]
  carried?: boolean
}): Harness {
  let betas = opts?.betas ?? [CONTEXT_1M_BETA_HEADER, 'other-beta']
  const handler = createContext1mBetaRetryHandler({
    model: opts?.model ?? 'claude-sonnet-4-6[1m]',
    getBetas: () => betas,
    setBetas: next => {
      betas = next
    },
    requestCarriedBeta: () => opts?.carried ?? true,
  })
  return { handler, getBetas: () => betas }
}

const healedEvents = () =>
  events.filter(e => e.name === 'tengu_beta_400_healed')

// --- detectors ----------------------------------------------------------------

describe('2.1.295 #016 — detectors (Yie @215746137 / iN @215746028)', () => {
  test('isContext1mBetaRefusedError matches a 400 naming the header or "long context beta"', () => {
    // Arrange/Act/Assert — both Yie arms.
    expect(isContext1mBetaRefusedError(namedHeaderError())).toBe(true)
    expect(isContext1mBetaRefusedError(longContextBetaError())).toBe(true)
  })

  test('isContext1mBetaRefusedError rejects unrelated 400s, wrong status, and non-APIErrors', () => {
    // Arrange/Act/Assert — status must be exactly 400 (Yie: `e.status===400`).
    expect(isContext1mBetaRefusedError(apiError(400, 'bad request'))).toBe(
      false,
    )
    expect(
      isContext1mBetaRefusedError(
        apiError(500, `server disliked ${CONTEXT_1M_BETA_HEADER}`),
      ),
    ).toBe(false)
    expect(
      isContext1mBetaRefusedError(new Error(CONTEXT_1M_BETA_HEADER)),
    ).toBe(false)
    expect(isContext1mBetaRefusedError(undefined)).toBe(false)
  })

  test('isInvalidBetaFlagError matches "invalid beta flag" case-insensitively at 400 only', () => {
    // Arrange/Act/Assert — iN lowercases before includes().
    expect(isInvalidBetaFlagError(invalidFlagError())).toBe(true)
    expect(
      isInvalidBetaFlagError(apiError(400, 'INVALID BETA FLAG in request')),
    ).toBe(true)
    expect(isInvalidBetaFlagError(apiError(404, 'invalid beta flag'))).toBe(
      false,
    )
    expect(isInvalidBetaFlagError(apiError(400, 'unrelated'))).toBe(false)
  })
})

// --- state machine --------------------------------------------------------------

describe('2.1.295 #016 — qtt/Ztt/SEe state machine on a gateway endpoint', () => {
  test('named 400 on a gateway flips to retrying, suppresses, and asks for a resend', () => {
    // Arrange — a non-first-party base URL (qCe skip does not apply).
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler } = makeHandler()

    // Act
    const resend = handler.handleRefusal(namedHeaderError())

    // Assert — ≡ qtt returning "retry:context-1m-beta"; SEe() now true so the
    // next betas assembly omits the header.
    expect(resend).toBe(true)
    expect(handler.isSuppressed()).toBe(true)
  })

  test('confirmHealed after a named retry strips the beta, latches the model, and logs unnamed:false', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler, getBetas } = makeHandler()
    handler.handleRefusal(namedHeaderError())

    // Act — the resend succeeded (≡ message_start / non-streaming settle).
    handler.confirmHealed()

    // Assert — ≡ Ztt: `ct=ct.filter((Uo)=>Uo!==YS),$wr(Y.model),
    // i("tengu_beta_400_healed",{…})`.
    expect(getBetas()).toEqual(['other-beta'])
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(true)
    const healed = healedEvents()
    expect(healed.length).toBe(1)
    expect(healed[0]?.metadata).toMatchObject({
      beta: CONTEXT_1M_BETA_HEADER,
      model: 'claude-sonnet-4-6[1m]',
      status: 400,
      unnamed: false,
    })
    // spent → suppression off for the rest of this request (SEe()===false).
    expect(handler.isSuppressed()).toBe(false)
  })

  test('"invalid beta flag" 400 guesses; confirmHealed logs unnamed:true', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler } = makeHandler()

    // Act
    const resend = handler.handleRefusal(invalidFlagError())
    handler.confirmHealed()

    // Assert — ≡ sb="guessing" then Ztt's `Kn=sb==="guessing"` → unnamed:true.
    expect(resend).toBe(true)
    const healed = healedEvents()
    expect(healed.length).toBe(1)
    expect(healed[0]?.metadata.unnamed).toBe(true)
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(true)
  })

  test('a second 400 after a named retry goes unproven: no resend, stays suppressed, confirmHealed is a no-op', () => {
    // Arrange — ≡ `sb=sb==="guessing"&&Zo?"spent":"unproven"` (retrying branch).
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler, getBetas } = makeHandler()
    handler.handleRefusal(namedHeaderError())

    // Act — the resend WITHOUT the beta also 400'd.
    const resend = handler.handleRefusal(namedHeaderError())
    handler.confirmHealed()

    // Assert — no heal recorded ("the backend is not recorded as rejecting
    // it"); beta stays off for the remaining attempts of THIS request only.
    expect(resend).toBe(false)
    expect(handler.isSuppressed()).toBe(true)
    expect(healedEvents().length).toBe(0)
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(false)
    expect(getBetas()).toContain(CONTEXT_1M_BETA_HEADER)
  })

  test('a second "invalid beta flag" 400 after a guess goes spent: suppression lifts for the next request', () => {
    // Arrange — ≡ `sb==="guessing"&&Zo → "spent"` ("both said invalid beta
    // flag, so it is sent again from the next attempt").
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler } = makeHandler()
    handler.handleRefusal(invalidFlagError())

    // Act
    const resend = handler.handleRefusal(invalidFlagError())

    // Assert — spent: SEe()===false (beta goes back on the wire next attempt)
    // and nothing is latched; confirmHealed on spent is a no-op.
    expect(resend).toBe(false)
    expect(handler.isSuppressed()).toBe(false)
    handler.confirmHealed()
    expect(healedEvents().length).toBe(0)
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(false)
  })

  test('handleRefusal does nothing when the request never carried the beta (!OJe)', () => {
    // Arrange — ≡ `if(!OJe||…)return null`.
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler } = makeHandler({ carried: false })

    // Act/Assert
    expect(handler.handleRefusal(namedHeaderError())).toBe(false)
    expect(handler.isSuppressed()).toBe(false)
  })

  test('non-400 statuses and unrelated 400 messages are ignored', () => {
    // Arrange — ≡ `if(!(Kn instanceof xt)||Kn.status!==400)return null`.
    process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
    const { handler } = makeHandler()

    // Act/Assert
    expect(
      handler.handleRefusal(
        apiError(500, `boom ${CONTEXT_1M_BETA_HEADER}`),
      ),
    ).toBe(false)
    expect(handler.handleRefusal(apiError(400, 'malformed json'))).toBe(false)
    expect(handler.handleRefusal(new Error('network down'))).toBe(false)
    expect(handler.isSuppressed()).toBe(false)
  })
})

// --- provider gate (qCe) ----------------------------------------------------------

describe('2.1.295 #016 — qCe first-party skip (@209475101)', () => {
  test('genuine first-party endpoint (no ANTHROPIC_BASE_URL) skips healing', () => {
    // Arrange — beforeEach cleared ANTHROPIC_BASE_URL → firstParty && bi()
    // → qCe true → `return null`.
    const { handler } = makeHandler()

    // Act/Assert
    expect(handler.handleRefusal(namedHeaderError())).toBe(false)
    expect(handler.isSuppressed()).toBe(false)
  })

  test('anthropic_aws with default endpoint skips; with ANTHROPIC_AWS_BASE_URL heals', () => {
    // Arrange — ≡ `if(e==="anthropicAws")return a.ANTHROPIC_AWS_BASE_URL===void 0`.
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    const { handler: defaultHandler } = makeHandler()

    // Act/Assert — default AWS endpoint → skip.
    expect(defaultHandler.handleRefusal(namedHeaderError())).toBe(false)

    // Arrange — custom AWS base URL → NOT genuine first-party → heal.
    process.env.ANTHROPIC_AWS_BASE_URL = 'https://my-aws-gw.example.com'
    const { handler: customHandler } = makeHandler()

    // Act/Assert
    expect(customHandler.handleRefusal(namedHeaderError())).toBe(true)
  })

  test('bedrock provider heals (non-first-party arm)', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const { handler } = makeHandler()

    // Act/Assert
    expect(handler.handleRefusal(namedHeaderError())).toBe(true)
  })
})

// --- process latch ($wr / $n / zGn) --------------------------------------------

describe('2.1.295 #016 — process latch ($wr @209332322, $n @206949551)', () => {
  test('latch keys normalize the [1m]/[2m] suffix ($n)', () => {
    // Arrange/Act — ≡ `$n(e)=e.replace(/\[(1|2)m\]/gi,"")`.
    markContext1mRefusedModel('claude-sonnet-4-6[1m]')

    // Assert — same base model under any/no suffix reads the latch.
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(true)
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[2m]')).toBe(true)
    expect(isContext1mRefusedForModel('claude-sonnet-4-6')).toBe(true)
    expect(isContext1mRefusedForModel('claude-opus-5[1m]')).toBe(false)
  })

  test('latchContext1mRefused is idempotent', () => {
    // Arrange/Act — ≡ `if(Gr(e))return;` pre-check.
    latchContext1mRefused('claude-sonnet-4-6[1m]')
    latchContext1mRefused('claude-sonnet-4-6[1m]')

    // Assert
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(true)
  })

  test('clearBetaHeaderLatches clears the refusal latch (≡ zGn on /clear + compaction)', () => {
    // Arrange
    markContext1mRefusedModel('claude-sonnet-4-6[1m]')
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(true)

    // Act
    clearBetaHeaderLatches()

    // Assert
    expect(isContext1mRefusedForModel('claude-sonnet-4-6[1m]')).toBe(false)
  })
})

// --- context-sizing gates (dUn / uUn) ---------------------------------------------

describe('2.1.295 #016 — context sizing honors the latch (dUn @209463598, uUn @209465489)', () => {
  test('[1m] model sizes at 1M unlatched and falls back once refused', () => {
    // Arrange — ≡ dUn's `!Gr(e)` on the _p (has1mContext) arm.
    expect(getContextWindowForModel('test-model[1m]')).toBe(1_000_000)

    // Act
    markContext1mRefusedModel('test-model[1m]')

    // Assert — the effective server-side window really is 200K after a heal.
    expect(getContextWindowForModel('test-model[1m]')).toBe(200_000)
  })

  test('betas-carried 1M sizing (sonnet-4-6 + header) is latch-gated too', () => {
    // Arrange — ≡ dUn's `ikr(n)?.includes(YS.header)===!0&&a7(e)` arm.
    const betas = [CONTEXT_1M_BETA_HEADER]
    expect(
      getContextWindowForModel('claude-sonnet-4-6', betas),
    ).toBe(1_000_000)

    // Act
    markContext1mRefusedModel('claude-sonnet-4-6')

    // Assert
    expect(getContextWindowForModel('claude-sonnet-4-6', betas)).toBeLessThan(
      1_000_000,
    )
  })

  test('the kelp/coral-reef experiment never re-adds 1M for a refused model (uUn Gr gate)', () => {
    // Arrange — coral_reef_sonnet on: sonnet-4-6 without [1m] qualifies.
    coralReefConfigActive = true
    expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(true)

    // Act
    markContext1mRefusedModel('claude-sonnet-4-6')

    // Assert — ≡ `if(Gr(e))return null` (new in v295).
    expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(false)
  })
})

// --- withRetry wiring ---------------------------------------------------------------

describe('2.1.295 #016 — withRetry hook resends without consuming budget', () => {
  test(
    'a named 400 fires the hook, resends immediately, and succeeds without sleep or retry telemetry',
    async () => {
      // Arrange — gateway endpoint, handler wired via the new
      // retryContext1mBetaRefused option (≡ official chain
      // @217674936/@217685469).
      process.env.ANTHROPIC_BASE_URL = GATEWAY_BASE_URL
      const { handler } = makeHandler()
      let opCalls = 0
      const gen = withRetry(
        async () => ({}) as never,
        async () => {
          opCalls++
          if (opCalls === 1) throw namedHeaderError()
          return { ok: true }
        },
        {
          maxRetries: 5,
          model: 'claude-sonnet-4-6[1m]',
          thinkingConfig: { type: 'disabled' as const },
          retryContext1mBetaRefused: handler.handleRefusal,
        },
      )

      // Act
      const yields: unknown[] = []
      let result: unknown
      let threw: unknown = null
      try {
        while (true) {
          const next = await gen.next()
          if (next.done) {
            result = next.value
            break
          }
          yields.push(next.value)
        }
      } catch (e) {
        threw = e
      }

      // Assert — `attempt--; continue` before any telemetry/sleep: the resend
      // does not count against the retry budget and the next attempt would be
      // assembled with isSuppressed()===true.
      expect(threw).toBeNull()
      expect(result).toEqual({ ok: true })
      expect(opCalls).toBe(2)
      expect(yields.length).toBe(0)
      expect(sleepCalls.length).toBe(0)
      expect(events.find(e => e.name === 'tengu_api_retry')).toBeUndefined()
      expect(handler.isSuppressed()).toBe(true)
    },
    15000,
  )
})
