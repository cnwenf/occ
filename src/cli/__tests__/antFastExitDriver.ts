/**
 * Live-path child driver for the OCC-132 P2-2 ant fast-exit cost-save test.
 *
 * Spawned as a REAL `bun` subprocess by antFastExitCostSave277.test.ts. It
 * drives the actual `runHeadless()` (src/cli/print.ts) ant branch:
 *   1. `registerHeadlessCostSaveOnExit()` runs FIRST (print.ts:519),
 *   2. then `USER_TYPE === 'ant'` + `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER`
 *      writes "Startup time:" to stderr and calls `process.exit(0)`
 *      (print.ts:525-534).
 * `process.exit()` runs 'exit' listeners synchronously, so the recorder
 * installed in step 1 fires `saveCurrentSessionCosts()` and the project-config
 * file write lands before the process dies.
 *
 * This isolates the live path the finding targets (the print.ts:519 ordering +
 * hard exit + cost save). It deliberately does NOT run main.tsx's full setup:
 * in dev/source mode with USER_TYPE=ant that setup calls into the ant-only
 * `getAntModelOverrideConfig` global (never injected in the open-source build,
 * so it throws) and a growthbook/analytics network fetch that hangs without a
 * live gateway — neither is part of this finding. See
 * docs/upstream-version-gap-occ132.md §7 (P2-2).
 *
 * NODE_ENV must NOT be 'test' here: the real config-file write path
 * (saveCurrentProjectConfig → getGlobalClaudeFile) is what we assert on; the
 * 'test' branch swaps in an in-memory config and writes nothing to disk.
 */

// Mirror src/entrypoints/cli.tsx's runtime polyfill so importing print.ts (and
// its transitive MACRO/BUILD_TARGET reads) works outside the bundler. Set these
// BEFORE the dynamic imports below — static imports would hoist above them.
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.278',
  BINARY_NAME: 'occ',
  BUILD_TIME: new Date().toISOString(),
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '@cnwenf/occ',
  VERSION_CHANGELOG: '',
}
;(globalThis as Record<string, unknown>).BUILD_TARGET = 'external'
;(globalThis as Record<string, unknown>).BUILD_ENV = 'production'
;(globalThis as Record<string, unknown>).INTERFACE_TYPE = 'stdio'

const { enableConfigs } = await import('../../utils/config.js')
const { addToTotalCostState } = await import('../../bootstrap/state.js')
const { runHeadless } = await import('../print.js')

// Mirror the real startup gate: main.tsx / init.ts / cli.tsx all call
// enableConfigs() before the headless lane runs, which unlocks the config
// read/write path saveCurrentSessionCosts() relies on at exit.
enableConfigs()

// Accrue a known, non-zero cost so the parent test can assert the saved total
// (not merely key presence). The ant branch exits before any model call, so
// this is the only cost in the session.
const KNOWN_COST = 1.75
addToTotalCostState(
  KNOWN_COST,
  {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: KNOWN_COST,
    contextWindow: 200000,
    maxOutputTokens: 16384,
  },
  'claude-sonnet-4-20250514',
)

// The ant branch calls process.exit(0) synchronously, so this await never
// resolves — the process terminates inside runHeadless. Dummy collaborators
// are fine: none is touched before the exit.
const noop = (): void => {}
await runHeadless(
  'hi',
  () => ({}) as never,
  noop as never,
  [],
  [],
  {},
  [],
  { outputFormat: 'text' } as never,
)
