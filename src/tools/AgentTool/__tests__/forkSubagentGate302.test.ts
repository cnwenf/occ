/**
 * CC 2.1.302 (#31 + #32): fork-subagent gate swap — TDD pins.
 *
 * #31: fork subagents default ON in `claude -p` / Agent SDK (non-interactive),
 * as they already are in the terminal; `CLAUDE_CODE_FORK_SUBAGENT=0` turns
 * them off; new config `forkSubagentDisabled` kill flag; `mcp serve` never
 * offers them.
 *
 * #32: subagents are forced into the background on terminal-class surfaces
 * (and with `CLAUDE_CODE_FORK_SUBAGENT=1` anywhere); plain `-p`/SDK with
 * default-on fork keeps `run_in_background` offered so nested Agent calls
 * default to the foreground.
 *
 * Official v302 gate (byte-verified, docs/gap-research-302/triage-T2.md §#31):
 *   function qcn(){let e=Ro();
 *     if(Q3e())return"disabled";                                  // coordinator
 *     if(Hf().forkSubagentDisabled)return"disabled";              // config kill flag
 *     if(a.CLAUDE_CODE_FORK_SUBAGENT===!1)return"disabled";       // env=0
 *     if(e.forkSubagentEnabledSource!==void 0)return e.forkSubagentEnabledSource;
 *     if(a.CLAUDE_CODE_FORK_SUBAGENT!==!0&&we()&&ir(Qcr,!1))return"disabled";  // kill-switch (N/A in OCC)
 *     let n=a.CLAUDE_CODE_FORK_SUBAGENT===!0?"env":"default";     // non-interactive now DEFAULTS ON
 *     return e.forkSubagentEnabledSource=n,...,n}
 *   function mse(){return qcn()!=="disabled"}                      // fork enabled
 *   function vat(){if(!mse())return!1;return qcn()==="env"||!uL()} // forced background
 *
 * OCC divergences pinned here:
 * - Base gate keeps the FORK_SUBAGENT feature-flag check (flag is NOT in
 *   FEATURE_ALLOWLIST ⇒ env var is the live switch in production builds).
 * - `uL` (non-interactive surface minus vscode-child) maps directly to
 *   getIsNonInteractiveSession() — OCC has no vscode-child surface.
 * - GrowthBook kill-switch `tengu_federated_ullman` is absent (OCC stub);
 *   official default with the kill-switch OFF = enabled ⇒ byte-equivalent.
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
import { readFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// featureFlags mock — registered BEFORE importing the gate consumers so their
// runtime feature() calls resolve through the toggle (live ESM bindings; the
// gate functions call feature() at call time, not at module-eval time).
// Same pattern as skillLoadTerminalTail299.test.ts / retryWatchdogRetryAfter281.
// ---------------------------------------------------------------------------

const actualFeatureFlags = { ...(await import('src/utils/featureFlags.js')) }
const realFeature = actualFeatureFlags.feature
let flagOverrides: Record<string, boolean> = {}

mock.module('src/utils/featureFlags.js', () => ({
  ...actualFeatureFlags,
  feature: (name: string) =>
    name in flagOverrides ? flagOverrides[name] : realFeature(name),
}))

afterAll(() => {
  mock.module('src/utils/featureFlags.js', () => actualFeatureFlags)
})

// ---------------------------------------------------------------------------
// Imports (resolved AFTER the mock is registered)
// ---------------------------------------------------------------------------

const {
  getForkSubagentSource,
  isForkSubagentEnabled,
  isSubagentsForcedBackground,
} = await import('../forkSubagent.js')

const { resetStateForTests, setIsInteractive } = await import(
  '../../../bootstrap/state.js'
)
const { getGlobalConfig, GLOBAL_CONFIG_KEYS } = await import(
  '../../../utils/config.js'
)

// ---------------------------------------------------------------------------
// Env / state / config fixtures
// ---------------------------------------------------------------------------

const FORK_ENV = 'CLAUDE_CODE_FORK_SUBAGENT'
const COORD_ENV = 'CLAUDE_CODE_COORDINATOR_MODE'
let savedForkEnv: string | undefined
let savedCoordEnv: string | undefined

function testConfig(): Record<string, unknown> {
  return getGlobalConfig() as unknown as Record<string, unknown>
}

beforeEach(() => {
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
  savedForkEnv = process.env[FORK_ENV]
  savedCoordEnv = process.env[COORD_ENV]
  delete process.env[FORK_ENV]
  delete process.env[COORD_ENV]
  flagOverrides = {}
  resetStateForTests()
})

afterEach(() => {
  if (savedForkEnv === undefined) delete process.env[FORK_ENV]
  else process.env[FORK_ENV] = savedForkEnv
  if (savedCoordEnv === undefined) delete process.env[COORD_ENV]
  else process.env[COORD_ENV] = savedCoordEnv
  flagOverrides = {}
  const cfg = testConfig()
  delete cfg.forkSubagentDisabled
  delete cfg.forkSubagentEnabledSource
  resetStateForTests()
})

// ---------------------------------------------------------------------------
// #31 — source resolution (official qcn precedence)
// ---------------------------------------------------------------------------

describe('fork gate source resolution (CC 2.1.302 #31 — official qcn port)', () => {
  test("KEY v302 flip: env=1 + non-interactive (-p/SDK) ⇒ 'env' (v301 returned 'disabled')", () => {
    process.env[FORK_ENV] = '1'
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('env')
    expect(isForkSubagentEnabled()).toBe(true)
  })

  test("env unset + FORK_SUBAGENT flag ON + non-interactive ⇒ 'default' (non-interactive no longer excluded)", () => {
    flagOverrides.FORK_SUBAGENT = true
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('default')
    expect(isForkSubagentEnabled()).toBe(true)
  })

  test("env unset + flag OFF ⇒ 'disabled' (base gate — env var is the live switch)", () => {
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('disabled')
    setIsInteractive(true)
    expect(getForkSubagentSource()).toBe('disabled')
    expect(isForkSubagentEnabled()).toBe(false)
  })

  test("env='0' ⇒ 'disabled' even when the feature flag would enable", () => {
    process.env[FORK_ENV] = '0'
    flagOverrides.FORK_SUBAGENT = true
    setIsInteractive(true)
    expect(getForkSubagentSource()).toBe('disabled')
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test("env='false' ⇒ 'disabled' (OCC isEnvDefinedFalsy convention)", () => {
    process.env[FORK_ENV] = 'false'
    flagOverrides.FORK_SUBAGENT = true
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test('config forkSubagentDisabled=true beats env=1 (official: config flag checked before env)', () => {
    process.env[FORK_ENV] = '1'
    testConfig().forkSubagentDisabled = true
    expect(getForkSubagentSource()).toBe('disabled')
    expect(isForkSubagentEnabled()).toBe(false)
  })

  test("coordinator session ⇒ 'disabled' regardless of env=1", () => {
    process.env[FORK_ENV] = '1'
    flagOverrides.COORDINATOR_MODE = true
    process.env[COORD_ENV] = '1'
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test("config forkSubagentEnabledSource='env' override is honored with everything else unset", () => {
    testConfig().forkSubagentEnabledSource = 'env'
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('env')
    expect(isForkSubagentEnabled()).toBe(true)
  })

  test("stored source 'disabled' beats env=1", () => {
    process.env[FORK_ENV] = '1'
    testConfig().forkSubagentEnabledSource = 'disabled'
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test("env='0' beats stored source 'env' (env-falsy check precedes stored source)", () => {
    process.env[FORK_ENV] = '0'
    testConfig().forkSubagentEnabledSource = 'env'
    expect(getForkSubagentSource()).toBe('disabled')
  })

  test('config schema exposes the new kill flag + source override as global config keys', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('forkSubagentDisabled')
    expect(GLOBAL_CONFIG_KEYS).toContain('forkSubagentEnabledSource')
  })
})

// ---------------------------------------------------------------------------
// #32 — forced-background predicate (official vat)
// ---------------------------------------------------------------------------

describe('forced-background predicate (CC 2.1.302 #32 — official vat port)', () => {
  test('env=1 + non-interactive ⇒ true (run_in_background omitted, forced async)', () => {
    process.env[FORK_ENV] = '1'
    setIsInteractive(false)
    expect(isSubagentsForcedBackground()).toBe(true)
  })

  test('default-on fork + non-interactive ⇒ false (param offered; nested Agent calls foreground)', () => {
    flagOverrides.FORK_SUBAGENT = true
    setIsInteractive(false)
    expect(getForkSubagentSource()).toBe('default')
    expect(isSubagentsForcedBackground()).toBe(false)
  })

  test('interactive + enabled ⇒ true (terminal parity — main-convo subagents always background)', () => {
    flagOverrides.FORK_SUBAGENT = true
    setIsInteractive(true)
    expect(isSubagentsForcedBackground()).toBe(true)
  })

  test('disabled gate ⇒ false', () => {
    process.env[FORK_ENV] = '0'
    setIsInteractive(true)
    expect(isSubagentsForcedBackground()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AgentTool.tsx wiring — source-level pins.
//
// A full schema-render assertion is NOT safe in-process: inputSchema is a
// lazySchema (memoized on first call) and Bun's module registry is
// process-global across test files in one run (OCC-97), so a sibling file
// (agentEffortParam292) may freeze the schema under a different env first.
// Source-text pinning is the established convention (subagentHandback.test.ts).
// ---------------------------------------------------------------------------

describe('AgentTool wiring (CC 2.1.302 #32 — official lgt()||vat() schema gate)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'AgentTool.tsx'), 'utf8')

  test('schema omit predicate = backgroundTasksDisabled || isSubagentsForcedBackground()', () => {
    expect(src).toContain(
      'isBackgroundTasksDisabled || isSubagentsForcedBackground() ? schema.omit({',
    )
    expect(src).toContain('run_in_background: true')
  })

  test('forceAsync uses the forced-background predicate, not the raw fork gate', () => {
    expect(src).toContain('const forceAsync = isSubagentsForcedBackground();')
    expect(src).not.toContain('const forceAsync = isForkSubagentEnabled()')
  })

  test('isSubagentsForcedBackground is imported from forkSubagent.js', () => {
    expect(src).toContain('isSubagentsForcedBackground')
    const importLine = src
      .split('\n')
      .find(line => line.includes("from './forkSubagent.js'"))
    expect(importLine).toBeDefined()
    expect(importLine).toContain('isSubagentsForcedBackground')
  })
})

// ---------------------------------------------------------------------------
// mcp serve — never offers fork (verify-only, no change expected)
// ---------------------------------------------------------------------------

describe('mcp serve never offers fork (CC 2.1.302 #31)', () => {
  test('MCP_COMMANDS is review-only and no fork command is registered', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../../entrypoints/mcp.ts'),
      'utf8',
    )
    expect(src).toContain('const MCP_COMMANDS: Command[] = [review]')
    expect(src).not.toContain('forkCmd')
    expect(src.toLowerCase()).not.toContain('fork_subagent')
  })
})
