/**
 * OCC ROBUSTNESS HARDENING (acceptance finding ⑥) — runtime enum validation
 * of the config `forkSubagentEnabledSource` override in
 * getForkSubagentSource() step 4.
 *
 * Official v302 returns the stored value VERBATIM with no runtime check
 * (`if(e.forkSubagentEnabledSource!==void 0)return e.forkSubagentEnabledSource`),
 * so a corrupt/hand-edited config value (e.g. "auto") would silently surface
 * as the fork-gate source. This is an OCC hardening beyond official — NOT an
 * alignment fix. Hardened behavior:
 *
 * - Legal values ('disabled' | 'env' | 'default') pass through unchanged
 *   (byte-identical to official).
 * - Illegal values are ignored, warned via logForDebugging, and resolution
 *   falls through to the documented default base gate (step 6: env truthy →
 *   'env'; else FORK_SUBAGENT flag → 'default'; else 'disabled').
 *
 * Would-fail pin: delete the FORK_SUBAGENT_SOURCES.includes() check in
 * forkSubagent.ts step 4 (returning the stored value verbatim) and the
 * illegal-value tests below go RED.
 *
 * Setup/teardown discipline mirrors forkSubagentPreEnableConfig302.test.ts /
 * forkSubagentGate302.test.ts: spread-real mock.module registered BEFORE
 * importing the module under test, restored in afterAll; NODE_ENV restored
 * BEFORE resetStateForTests() in afterAll (resetStateForTests throws outside
 * NODE_ENV=test; bun test does NOT auto-set NODE_ENV).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const actualFeatureFlags = { ...(await import('src/utils/featureFlags.js')) }
const realFeature = actualFeatureFlags.feature
let flagOverrides: Record<string, boolean> = {}

mock.module('src/utils/featureFlags.js', () => ({
  ...actualFeatureFlags,
  feature: (name: string) =>
    name in flagOverrides ? flagOverrides[name] : realFeature(name),
}))

// OCC-121 P3 carryover fix (finding #3): pin the WARN OUTPUT side of the
// illegal-enum branch too. The behavior side (fall-through resolution) was
// already pinned below, but deleting the whole `logForDebugging(...)` block in
// forkSubagent.ts step 4 kept 7/7 green — the output side was unpinned.
// Spread-real mock registered BEFORE the module under test is imported;
// restored in afterAll. Mutation: delete the logForDebugging block → the
// warn-pin tests go RED.
const actualDebug = { ...(await import('src/utils/debug.js')) }
const debugCalls: Array<{ message: string; level?: string }> = []

mock.module('src/utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (
    message: string,
    { level }: { level?: string } = { level: 'debug' },
  ) => {
    debugCalls.push({ message, level })
  },
}))

const { getForkSubagentSource } = await import('../forkSubagent.js')
const { resetStateForTests } = await import('../../../bootstrap/state.js')
const { getGlobalConfig } = await import('../../../utils/config.js')

const FORK_ENV = 'CLAUDE_CODE_FORK_SUBAGENT'
const savedForkEnv = process.env[FORK_ENV]
const savedNodeEnv = process.env.NODE_ENV

// Real getGlobalConfig() reads require NODE_ENV=test (bun test does NOT set
// it). Restored in afterAll BEFORE resetStateForTests(), which itself throws
// outside NODE_ENV=test — preserve that ordering.
process.env.NODE_ENV = 'test'
delete process.env[FORK_ENV]

function testConfig(): Record<string, unknown> {
  return getGlobalConfig() as unknown as Record<string, unknown>
}

beforeEach(() => {
  flagOverrides = {}
  debugCalls.length = 0
  delete process.env[FORK_ENV]
  delete testConfig().forkSubagentDisabled
  delete testConfig().forkSubagentEnabledSource
  resetStateForTests()
})

afterEach(() => {
  delete testConfig().forkSubagentDisabled
  delete testConfig().forkSubagentEnabledSource
  delete process.env[FORK_ENV]
  flagOverrides = {}
  debugCalls.length = 0
})

afterAll(() => {
  // Restore env first: resetStateForTests() requires NODE_ENV=test.
  if (savedForkEnv === undefined) delete process.env[FORK_ENV]
  else process.env[FORK_ENV] = savedForkEnv
  if (savedNodeEnv === undefined) process.env.NODE_ENV = 'test'
  else process.env.NODE_ENV = savedNodeEnv
  mock.module('src/utils/featureFlags.js', () => actualFeatureFlags)
  mock.module('src/utils/debug.js', () => actualDebug)
  resetStateForTests()
})

describe('OCC hardening (finding ⑥) — forkSubagentEnabledSource runtime enum validation', () => {
  test.each(['disabled', 'env', 'default'] as const)(
    "legal stored source '%s' passes through unchanged (official-verbatim path)",
    source => {
      // Arrange — env unset, kill flag unset, so step 4 is reached.
      testConfig().forkSubagentEnabledSource = source
      // Act / Assert
      expect(getForkSubagentSource()).toBe(source)
    },
  )

  test("illegal stored source 'auto' falls back to the documented default resolution ('disabled': env unset + FORK_SUBAGENT flag off)", () => {
    // Arrange
    testConfig().forkSubagentEnabledSource = 'auto'
    // Act / Assert — verbatim return of 'auto' would fail this pin.
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test("illegal stored source 'ENV' (wrong case) falls back to the documented default resolution", () => {
    // Arrange
    testConfig().forkSubagentEnabledSource = 'ENV'
    // Act / Assert
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test("illegal stored source does not beat env=1 — falls through to the base gate ('env')", () => {
    // Arrange
    testConfig().forkSubagentEnabledSource = 'auto'
    process.env[FORK_ENV] = '1'
    // Act / Assert — fall-through honors the documented step-6 precedence.
    expect(getForkSubagentSource()).toBe('env')
  })

  test("illegal stored source with FORK_SUBAGENT flag on falls through to 'default'", () => {
    // Arrange
    testConfig().forkSubagentEnabledSource = 'auto'
    flagOverrides.FORK_SUBAGENT = true
    // Act / Assert
    expect(getForkSubagentSource()).toBe('default')
  })
})

// OCC-121 P3 carryover fix (finding #3): the warn OUTPUT side of the
// illegal-enum branch. Would-fail pin: delete the logForDebugging(...) block
// in forkSubagent.ts step 4 and the two warn tests below go RED (the
// behavior-side pins above stay green — that was the gap).
describe('OCC hardening (finding #3 output pin) — illegal forkSubagentEnabledSource warns via logForDebugging', () => {
  test("illegal stored source 'auto' emits exactly one level='warn' debug log naming the value and the legal enum set", () => {
    // Arrange
    testConfig().forkSubagentEnabledSource = 'auto'
    // Act
    expect(getForkSubagentSource()).toBe('disabled')
    // Assert — output side
    const warns = debugCalls.filter(c => c.level === 'warn')
    expect(warns.length).toBe(1)
    expect(warns[0].message).toContain(
      'Ignoring invalid config forkSubagentEnabledSource',
    )
    expect(warns[0].message).toContain('"auto"')
    expect(warns[0].message).toContain('disabled | env | default')
  })

  test.each(['disabled', 'env', 'default'] as const)(
    "legal stored source '%s' does not warn",
    source => {
      // Arrange
      testConfig().forkSubagentEnabledSource = source
      // Act
      expect(getForkSubagentSource()).toBe(source)
      // Assert — the official-verbatim path is silent
      expect(debugCalls.filter(c => c.level === 'warn').length).toBe(0)
    },
  )
})
