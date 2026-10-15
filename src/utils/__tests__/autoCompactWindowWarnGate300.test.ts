/**
 * CC 2.1.300 changelog #10 — "Fixed `/autocompact` warning about high token
 * usage when you choose a smaller auto-compact window".
 *
 * Official delta (byte-verified from the v299/v300 linux-x64 ELFs):
 * - v299@237779900: `if(dTt(t))e.push("Overriding auto may result in high
 *   token usage, especially when resuming long sessions.")` — warns on ANY
 *   env/settings override (`dTt(u)` = `u==="env"||u==="settings"`).
 * - v300@239116094: `if(cCt(u)&&TAn(r,s))a.push(…)` — a NEW helper gates the
 *   warning; `cCt` is the same source check (@225878936:
 *   `function cCt(e){return e==="env"||e==="settings"}`) and
 *   v300@239116220: `function TAn(e,o){return Math.min(e.contextWindow,o)>Hno(e).window}`
 *   i.e. warn only when the chosen (capped) window EXCEEDS the model's auto
 *   window `Hno(e)`.
 *
 * OCC symbol map (official → OCC):
 *   TAn = chosenWindowExceedsAutoWindow   Hno ≈ resolveAutoCompactWindow(model, ctx, undefined)
 *
 * Documented divergence: the official `Hno` (@225877589) resolves the tuned
 * auto window via model-default/experiment/clientdata/unknown-model branches
 * — all Anthropic-backend-bound and staged in OCC (see autoCompactWindow.ts
 * header), so OCC's auto-window fallback is the context window and the
 * helper reuses `resolveAutoCompactWindow` (env-aware) as the Hno analog.
 *
 * Mock plumbing mirrors autoCompactWindowPerModel288.test.ts (OCC-97 seam:
 * snapshot real exports, override narrowly, restore in afterAll).
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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Mock plumbing (pattern: autoCompactWindowPerModel288.test.ts)
// ---------------------------------------------------------------------------

const actualSettingsModule = await import('../settings/settings.js')
const actualConstantsModule = await import('../settings/constants.js')

let settingsBySource: Record<string, Record<string, unknown> | null> = {}
let enabledSources: string[] = ['userSettings', 'projectSettings']

const actualGetSettingsForSource = actualSettingsModule.getSettingsForSource
const actualGetEnabledSettingSources =
  actualConstantsModule.getEnabledSettingSources

let mockActive = true

mock.module('../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (
    source: Parameters<typeof actualGetSettingsForSource>[0],
  ) => (mockActive ? settingsBySource[source] ?? null : actualGetSettingsForSource(source)),
}))

mock.module('../settings/constants.js', () => ({
  ...actualConstantsModule,
  getEnabledSettingSources: () =>
    mockActive ? [...enabledSources] : actualGetEnabledSettingSources(),
}))

afterAll(() => {
  mockActive = false
  mock.module('../settings/settings.js', () => ({
    ...actualSettingsModule,
    getSettingsForSource: actualGetSettingsForSource,
  }))
  mock.module('../settings/constants.js', () => ({
    ...actualConstantsModule,
    getEnabledSettingSources: actualGetEnabledSettingSources,
  }))
})

// Modules under test — imported AFTER mocks.
const {
  aggregateAutoCompactWindow,
  chosenWindowExceedsAutoWindow,
  resolveAutoCompactWindow,
  setSessionAutoCompactWindow,
} = await import('../autoCompactWindow.js')
const { call: autocompactCall } = await import(
  '../../commands/autocompact/autocompact-noninteractive.js'
)
import type { ToolUseContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Env hygiene + fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const SONNET = 'claude-sonnet-4-6'
const WARNING =
  'Overriding auto may result in high token usage, especially when resuming long sessions.'

let tmpConfig = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

function makeContext(model: string): ToolUseContext {
  return { options: { mainLoopModel: model } } as unknown as ToolUseContext
}

beforeEach(() => {
  tmpConfig = mkdtempSync(join(tmpdir(), 'occ-acw-warn-300-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfig
  settingsBySource = {}
  enabledSources = ['userSettings', 'projectSettings']
  setSessionAutoCompactWindow(undefined)
  delete process.env[ENV_KEY]
})

afterEach(() => {
  setSessionAutoCompactWindow(undefined)
  delete process.env[ENV_KEY]
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (tmpConfig) {
    try {
      rmSync(tmpConfig, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }
})

// ---------------------------------------------------------------------------
// chosenWindowExceedsAutoWindow — official v300 `TAn` boundary
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #10 — chosenWindowExceedsAutoWindow (official TAn)', () => {
  test('a SMALLER chosen window does not exceed the auto window', () => {
    // Arrange — no env override → auto window resolves to the context window.
    const ctx = 200_000

    // Act + Assert — min(200k, 150k) = 150k > 200k is false.
    expect(chosenWindowExceedsAutoWindow(SONNET, ctx, 150_000)).toBe(false)
  })

  test('a chosen window EQUAL to the auto window does not exceed it (boundary)', () => {
    // Arrange
    const ctx = 200_000

    // Act + Assert — strict `>` per the official TAn.
    expect(chosenWindowExceedsAutoWindow(SONNET, ctx, 200_000)).toBe(false)
  })

  test('a chosen window capped BY the context window does not exceed auto', () => {
    // Arrange — chosen 500k on a 200k-context model caps to 200k == auto.
    const ctx = 200_000

    // Act + Assert — Math.min(contextWindow, chosen) per official TAn.
    expect(chosenWindowExceedsAutoWindow(SONNET, ctx, 500_000)).toBe(false)
  })

  test('a chosen window LARGER than the auto window exceeds it', () => {
    // Arrange — env lowers the auto window to 150k (the OCC Hno analog is
    // resolveAutoCompactWindow(model, ctx, undefined), which is env-aware).
    process.env[ENV_KEY] = '150000'
    const ctx = 200_000

    // Act + Assert — min(200k, 180k) = 180k > 150k.
    expect(chosenWindowExceedsAutoWindow(SONNET, ctx, 180_000)).toBe(true)
  })

  test('the boundary is strict: chosen == env auto window does not exceed', () => {
    // Arrange
    process.env[ENV_KEY] = '150000'
    const ctx = 200_000

    // Act + Assert
    expect(chosenWindowExceedsAutoWindow(SONNET, ctx, 150_000)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /autocompact describe gate — official v300 `cCt(u)&&TAn(r,s)`
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #10 — describe gate (official cCt && TAn)', () => {
  test('choosing a SMALLER settings window does NOT warn (the #10 fix)', async () => {
    // Arrange — a per-model settings window well under the model context.
    enabledSources = ['userSettings']
    settingsBySource.userSettings = {
      modelSettings: { [SONNET]: { autoCompactWindow: 150_000 } },
    }
    setSessionAutoCompactWindow(aggregateAutoCompactWindow())

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET))

    // Assert — source is 'settings' (cCt true) but TAn is false → no warning.
    expect(value).toContain('(from settings)')
    expect(value).not.toContain(WARNING)
  })

  test('the auto source still never warns', async () => {
    // Arrange — no env, no settings.
    setSessionAutoCompactWindow(undefined)

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET))

    // Assert
    expect(value).toContain(': auto')
    expect(value).not.toContain(WARNING)
  })

  test('the gate helper agrees with the resolver on the settings path', () => {
    // Arrange — settings 150k, no env: the resolver's auto branch is the
    // context window, so any capped chosen window is <= auto.
    enabledSources = ['userSettings']
    settingsBySource.userSettings = {
      modelSettings: { [SONNET]: { autoCompactWindow: 150_000 } },
    }
    const aggregate = aggregateAutoCompactWindow()
    const ctx = 200_000

    // Act
    const resolved = resolveAutoCompactWindow(SONNET, ctx, aggregate)

    // Assert
    expect(resolved.source).toBe('settings')
    expect(resolved.configured).toBe(150_000)
    expect(
      chosenWindowExceedsAutoWindow(SONNET, ctx, resolved.configured),
    ).toBe(false)
  })
})
