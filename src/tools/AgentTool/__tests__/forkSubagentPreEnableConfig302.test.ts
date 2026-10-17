/**
 * CC 2.1.302 (#31) regression pin — fork gate must survive the PRE-ENABLE
 * config window.
 *
 * Production crash this guards (found by the live `-p` e2e, invisible to unit
 * tests because getConfig() only throws when NODE_ENV !== 'test'):
 *
 *   error: Config accessed before allowed.
 *     at getConfig (src/utils/config.ts)
 *     at getGlobalConfig
 *     at getForkSubagentSource (src/tools/AgentTool/forkSubagent.ts)
 *     at isForkSubagentEnabled
 *     at AgentTool.tsx:99 (effort-describe inside lazySchema)
 *     at buildTool (src/Tool.ts — object spread invokes `get inputSchema()`)
 *
 * buildTool()'s `...def` spread calls AgentTool's `get inputSchema()` getter
 * at MODULE-EVAL time; the `-p` path evaluates the tool-module graph before
 * enableConfigs() runs. When #31 made getForkSubagentSource() read
 * getGlobalConfig() unconditionally, every `occ -p` run died at startup.
 *
 * Fix under test: getForkSubagentSource() consults isConfigReadingAllowed()
 * and treats the config terms (kill flag / source override) as unset in the
 * pre-enable window — env/coordinator/flag terms still decide, matching
 * pre-302 module-eval behavior.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'

const actualConfig = { ...(await import('../../../utils/config.js')) }

// Simulate the production pre-enable state: gate closed, direct reads throw
// exactly like getConfig() does outside NODE_ENV=test.
mock.module('../../../utils/config.js', () => ({
  ...actualConfig,
  isConfigReadingAllowed: () => false,
  getGlobalConfig: () => {
    throw new Error('Config accessed before allowed.')
  },
}))

const {
  getForkSubagentSource,
  isForkSubagentEnabled,
  isSubagentsForcedBackground,
} = await import('../forkSubagent.js')
const { resetStateForTests, setIsInteractive } = await import(
  '../../../bootstrap/state.js'
)

const FORK_ENV = 'CLAUDE_CODE_FORK_SUBAGENT'
const savedForkEnv = process.env[FORK_ENV]
const savedNodeEnv = process.env.NODE_ENV

// Production-like NODE_ENV so any accidental raw getConfig() read throws
// (bun test does NOT set NODE_ENV=test by itself; the sibling gate test sets
// it explicitly). Restored in afterAll BEFORE resetStateForTests(), which
// itself throws outside NODE_ENV=test.
process.env.NODE_ENV = 'production'
delete process.env[FORK_ENV]

afterAll(() => {
  // Restore env first: resetStateForTests() requires NODE_ENV=test.
  if (savedForkEnv === undefined) delete process.env[FORK_ENV]
  else process.env[FORK_ENV] = savedForkEnv
  if (savedNodeEnv === undefined) process.env.NODE_ENV = 'test'
  else process.env.NODE_ENV = savedNodeEnv
  mock.module('../../../utils/config.js', () => actualConfig)
  resetStateForTests()
})

describe('CC 2.1.302 #31 regression — fork gate in the pre-enable config window', () => {
  test('env unset: getForkSubagentSource() does not throw and stays disabled', () => {
    // Arrange — no FORK env, config gate closed (mock above).
    setIsInteractive(false)
    // Act / Assert — must NOT throw "Config accessed before allowed".
    expect(getForkSubagentSource()).toBe('disabled')
    expect(isForkSubagentEnabled()).toBe(false)
    expect(isSubagentsForcedBackground()).toBe(false)
  })

  test("env=1 still resolves to 'env' without config access", () => {
    // Arrange
    process.env[FORK_ENV] = '1'
    setIsInteractive(false)
    try {
      // Act / Assert — env term decides; config terms treated as unset.
      expect(getForkSubagentSource()).toBe('env')
      expect(isForkSubagentEnabled()).toBe(true)
    } finally {
      delete process.env[FORK_ENV]
    }
  })

  test('interactive surface: isSubagentsForcedBackground() does not throw pre-enable', () => {
    // Arrange
    setIsInteractive(true)
    // Act / Assert
    expect(isSubagentsForcedBackground()).toBe(false)
  })
})
