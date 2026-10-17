// CC 2.1.302 (#19): "Fixed prompt suggestions spending usage credits on
// models your plan pays for only with credits: they are now skipped after a
// reply billed to credits."
//
// Official v302 gate (binary evidence @251518600-region, dd skip=251518600):
//   function x(e,n){…
//     {let{status:t,overageInUse:o}=ha(),s=t==="allowed_warning"&&…;
//      if(t!=="allowed"&&!s)return"rate_limit";
//      if((n??o===!0)&&!(N0()||zU()||Cte()&&TLr()===null&&GE()===null))
//        return"usage_credits"}
//     return null}
//   caller: f=x(p,o.toolUseContext.queryTracking?.billedToUsageCredits)
//
// The five override predicates N0/zU/Cte/TLr/GE were NOT resolvable from the
// minified binary; per port discipline they are conservatively mapped to
// OCC's existing internal-user check (USER_TYPE === 'ant').
//
// Mocking follows the usageNoninteractive299.test.ts superset convention.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'

const actualClaudeAiLimits = await import('../../claudeAiLimits.js')

let mockStatus = 'allowed'
let mockOverageInUse: boolean | undefined 

mock.module('../../claudeAiLimits.js', () => ({
  ...actualClaudeAiLimits,
  // Stable object with live getters so each case can vary the limits state
  // (the ESM named binding is captured once by the SUT import).
  currentLimits: {
    get status() {
      return mockStatus
    },
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    get overageInUse() {
      return mockOverageInUse
    },
  },
}))

const { getSuggestionSuppressReason } = await import(
  '../promptSuggestion.js?usageCreditsSuppress302'
)

afterAll(() => {
  mock.module('../../claudeAiLimits.js', () => ({ ...actualClaudeAiLimits }))
  mock.restore()
})

let savedUserType: string | undefined
beforeEach(() => {
  savedUserType = process.env.USER_TYPE
  mockStatus = 'allowed'
  mockOverageInUse = undefined
})
afterEach(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

function makeAppState(): AppState {
  return {
    promptSuggestionEnabled: true,
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    elicitation: { queue: [] },
    toolPermissionContext: { mode: 'default' },
  } as unknown as AppState
}

describe('CC 2.1.302 (#19): usage_credits suppress reason', () => {
  test('per-turn billedToUsageCredits=true (external user) → "usage_credits"', () => {
    process.env.USER_TYPE = 'external'
    expect(getSuggestionSuppressReason(makeAppState(), true)).toBe(
      'usage_credits',
    )
  })

  test('billedToUsageCredits undefined + limits overageInUse=true → "usage_credits" (fallback)', () => {
    process.env.USER_TYPE = 'external'
    mockOverageInUse = true
    expect(getSuggestionSuppressReason(makeAppState())).toBe('usage_credits')
  })

  test('explicit billedToUsageCredits=false overrides limits overageInUse=true → null (official `n??o===!0`)', () => {
    process.env.USER_TYPE = 'external'
    mockOverageInUse = true
    expect(getSuggestionSuppressReason(makeAppState(), false)).toBeNull()
  })

  test('both false/absent → null (v301 fall-through preserved)', () => {
    process.env.USER_TYPE = 'external'
    expect(getSuggestionSuppressReason(makeAppState(), false)).toBeNull()
    expect(getSuggestionSuppressReason(makeAppState())).toBeNull()
  })

  test('internal (USER_TYPE=ant) user is exempt → null', () => {
    process.env.USER_TYPE = 'ant'
    mockOverageInUse = true
    expect(getSuggestionSuppressReason(makeAppState(), true)).toBeNull()
  })

  test('rate_limit check still takes precedence over usage_credits (official order)', () => {
    process.env.USER_TYPE = 'external'
    mockStatus = 'rejected'
    mockOverageInUse = true
    expect(getSuggestionSuppressReason(makeAppState(), true)).toBe(
      'rate_limit',
    )
  })

  test('v301 regression: external + status rejected + no overage → "rate_limit"', () => {
    process.env.USER_TYPE = 'external'
    mockStatus = 'rejected'
    expect(getSuggestionSuppressReason(makeAppState())).toBe('rate_limit')
  })

  test('v301 regression: disabled appState short-circuits before usage_credits', () => {
    process.env.USER_TYPE = 'external'
    const appState = {
      ...makeAppState(),
      promptSuggestionEnabled: false,
    } as unknown as AppState
    expect(getSuggestionSuppressReason(appState, true)).toBe('disabled')
  })
})
