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
 *   TAn = chosenWindowExceedsAutoWindow   Hno = resolveModelAutoWindow
 *   AGt = MODEL_WINDOW_DEFAULTS table     z$o/C0e/gPt = table lookup chain
 *   Bp  = isAutoCompactWindowTuningEnabled (oh + Es("autoCompactEnabled"))
 *
 * The denominator is the MODEL AUTO window (`Hno`), which NEVER reads
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (byte-verified @225877589 — no env symbol
 * in the Hno body). The statically-recoverable Hno arms ported into OCC:
 * the `z$o` model-default table (AGt @225876600:
 * `{"claude-sonnet-5":{surfaces:{remote_cowork:{default:500000},
 * "local-agent":{default:500000}},default:kge}}`, kge=1e6) with the
 * entrypoint-surface (`C0e`) + tier (`gPt`; tier context `Rr` staged →
 * undefined → `.default`) lookup, gated by `Bp`, and the final
 * `{window:ctx,source:"auto"}` fallback. Backend-bound arms (clientdata /
 * experiment / TG-200k predicate inputs / native1mHere / unknown-model)
 * stay staged — see autoCompactWindow.ts `resolveModelAutoWindow` docblock.
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
  resolveModelAutoWindow,
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
// Canonical key with an official AGt table entry (byte-verified @225876625).
const SONNET5 = 'claude-sonnet-5'
// [1m] spelling → getContextWindowForModel returns 1_000_000 (has1mContext).
const SONNET5_1M = 'claude-sonnet-5[1m]'
const WARNING =
  'Overriding auto may result in high token usage, especially when resuming long sessions.'

// Env vars that participate in the Hno static subset (Bp/oh gate, surface
// lookup, q$o) or would perturb getContextWindowForModel — snapshotted and
// restored around every test.
const GUARDED_ENV_KEYS = [
  ENV_KEY,
  'CLAUDE_CODE_ENTRYPOINT',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'USER_TYPE',
] as const

let tmpConfig = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
let savedEnv: Record<string, string | undefined> = {}

function makeContext(model: string): ToolUseContext {
  return { options: { mainLoopModel: model } } as unknown as ToolUseContext
}

beforeEach(() => {
  savedEnv = {}
  for (const key of GUARDED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tmpConfig = mkdtempSync(join(tmpdir(), 'occ-acw-warn-300-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfig
  settingsBySource = {}
  enabledSources = ['userSettings', 'projectSettings']
  setSessionAutoCompactWindow(undefined)
})

afterEach(() => {
  setSessionAutoCompactWindow(undefined)
  for (const key of GUARDED_ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
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
// resolveModelAutoWindow — official v300 `Hno` static subset
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #10 — resolveModelAutoWindow (official Hno)', () => {
  test('AGt table hit: sonnet-5 on the local-agent surface resolves to 500K (model-default)', () => {
    // Arrange — official AGt @225876625: surfaces["local-agent"].default=500000.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET5,
      contextWindow: 1_000_000,
      canonical: SONNET5,
    })

    // Assert — window = min(ctx, 500K) per the official z$o arm.
    expect(resolved.source).toBe('model-default')
    expect(resolved.configured).toBe(500_000)
    expect(resolved.window).toBe(500_000)
  })

  test('AGt table hit: sonnet-5 on the remote_cowork surface resolves to 500K', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'remote_cowork'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET5,
      contextWindow: 1_000_000,
      canonical: SONNET5,
    })

    // Assert
    expect(resolved.configured).toBe(500_000)
    expect(resolved.window).toBe(500_000)
  })

  test('AGt table hit: sonnet-5 WITHOUT a special entrypoint falls to default kge=1M', () => {
    // Arrange — entrypoint "cli" is not an AGt surface key.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET5,
      contextWindow: 1_000_000,
      canonical: SONNET5,
    })

    // Assert — C0e falls through to gPt(rest) = default = kge = 1e6.
    expect(resolved.configured).toBe(1_000_000)
    expect(resolved.window).toBe(1_000_000)
  })

  test('the table window is capped by the context window', () => {
    // Arrange — local-agent default 500K on a 300K context.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET5,
      contextWindow: 300_000,
      canonical: SONNET5,
    })

    // Assert — window = min(300K, 500K); configured stays 500K.
    expect(resolved.configured).toBe(500_000)
    expect(resolved.window).toBe(300_000)
  })

  test('no AGt entry (unknown to the table) resolves to the auto fallback (ctx)', () => {
    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET,
      contextWindow: 200_000,
      canonical: SONNET,
    })

    // Assert — final Hno branch: {window:s,configured:s,source:"auto"}.
    expect(resolved.source).toBe('auto')
    expect(resolved.window).toBe(200_000)
  })

  test('Bp gate: DISABLE_COMPACT suppresses the model-default table arm', () => {
    // Arrange — official z$o: `if(!Bp())return` → falls through to auto.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    process.env.DISABLE_COMPACT = '1'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET5,
      contextWindow: 1_000_000,
      canonical: SONNET5,
    })

    // Assert
    expect(resolved.source).toBe('auto')
    expect(resolved.window).toBe(1_000_000)
  })

  test('the denominator IGNORES CLAUDE_CODE_AUTO_COMPACT_WINDOW (core #10 fix)', () => {
    // Arrange — official Hno never reads the env var (@225877589 body).
    process.env[ENV_KEY] = '150000'

    // Act
    const resolved = resolveModelAutoWindow({
      model: SONNET,
      contextWindow: 200_000,
      canonical: SONNET,
    })

    // Assert — NOT 150K: auto fallback is the context window.
    expect(resolved.window).toBe(200_000)
  })
})

// ---------------------------------------------------------------------------
// chosenWindowExceedsAutoWindow — official v300 `TAn` boundary
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #10 — chosenWindowExceedsAutoWindow (official TAn)', () => {
  test('POSITIVE arm: sonnet-5 local-agent, chosen 800K > surface auto 500K', () => {
    // Arrange — AGt surface default 500K, ctx 1M.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act + Assert — min(1M, 800K) = 800K > min(1M, 500K) = 500K.
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 800_000)).toBe(
      true,
    )
  })

  test('POSITIVE arm via the [1m] spelling (canonical folds to the table key)', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act + Assert — getCanonicalName('claude-sonnet-5[1m]') = 'claude-sonnet-5'.
    expect(chosenWindowExceedsAutoWindow(SONNET5_1M, 1_000_000, 800_000)).toBe(
      true,
    )
  })

  test('POSITIVE arm on remote_cowork: chosen 600K > 500K', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'remote_cowork'

    // Act + Assert
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 600_000)).toBe(
      true,
    )
  })

  test('NEGATIVE: sonnet-5 local-agent, chosen 400K <= surface auto 500K', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act + Assert
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 400_000)).toBe(
      false,
    )
  })

  test('NEGATIVE boundary: chosen == surface auto 500K is not exceeding (strict >)', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act + Assert
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 500_000)).toBe(
      false,
    )
  })

  test('NEGATIVE: sonnet-5 without a special entrypoint (default kge=1M)', () => {
    // Arrange — no surface hit → C0e default = kge = 1M.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    // Act + Assert — min(1M, 800K) = 800K > min(1M, 1M) = 1M is false.
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 800_000)).toBe(
      false,
    )
  })

  test('NEGATIVE: env set, chosen == env value, no AGt entry — denominator must NOT collapse to env', () => {
    // Arrange — the pre-fix OCC denominator was env-aware, making the gate
    // structurally dead AND wrongly env-coupled. Official Hno ignores env.
    process.env[ENV_KEY] = '150000'

    // Act + Assert — denominator = auto fallback ctx = 200K, NOT 150K.
    expect(chosenWindowExceedsAutoWindow(SONNET, 200_000, 150_000)).toBe(false)
    // The pre-fix behavior returned true here (180K > env 150K).
    expect(chosenWindowExceedsAutoWindow(SONNET, 200_000, 180_000)).toBe(false)
  })

  test('NEGATIVE: unknown model (no AGt entry), any chosen <= ctx', () => {
    // Act + Assert — denominator = ctx (auto fallback).
    expect(chosenWindowExceedsAutoWindow(SONNET, 1_000_000, 999_999)).toBe(
      false,
    )
    expect(chosenWindowExceedsAutoWindow(SONNET, 1_000_000, 1_000_000)).toBe(
      false,
    )
    // A chosen window above ctx caps to ctx == denominator → still false.
    expect(chosenWindowExceedsAutoWindow(SONNET, 200_000, 500_000)).toBe(false)
  })

  test('NEGATIVE: Bp off (DISABLE_COMPACT) → auto fallback, table arm suppressed', () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    process.env.DISABLE_COMPACT = '1'

    // Act + Assert — denominator = ctx = 1M → 800K does not exceed.
    expect(chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 800_000)).toBe(
      false,
    )
  })

  test('NEGATIVE: CLAUDE_CODE_DISABLE_1M_CONTEXT — staged TG arm inputs stay inert', () => {
    // Arrange — official q$o fires only with uI() set AND a backend catalog
    // input (native1mInCatalog/declared); OCC stages both as undefined, so
    // the TG=200K arm cannot pull the denominator below ctx.
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'

    // Act + Assert — denominator = auto fallback ctx = 800K.
    expect(chosenWindowExceedsAutoWindow(SONNET, 800_000, 300_000)).toBe(false)
    const resolved = resolveModelAutoWindow({
      model: SONNET,
      contextWindow: 800_000,
      canonical: SONNET,
    })
    expect(resolved.source).toBe('auto')
    expect(resolved.window).toBe(800_000)
  })

  test('a SMALLER chosen window does not exceed the auto window', () => {
    // Act + Assert — no env, no table entry → denominator = ctx.
    expect(chosenWindowExceedsAutoWindow(SONNET, 200_000, 150_000)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /autocompact describe gate — official v300 `cCt(u)&&TAn(r,s)` (real entry)
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #10 — describe gate (official cCt && TAn, real command entry)', () => {
  test('POSITIVE: settings window above the model auto window WARNS (warn line reachable)', async () => {
    // Arrange — sonnet-5 [1m] (ctx 1M), local-agent surface auto = 500K,
    // settings window 800K → cCt(settings) && TAn(800K > 500K).
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    enabledSources = ['userSettings']
    settingsBySource.userSettings = {
      modelSettings: { [SONNET5]: { autoCompactWindow: 800_000 } },
    }
    setSessionAutoCompactWindow(aggregateAutoCompactWindow())

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET5_1M))

    // Assert
    expect(value).toContain(`Auto-compact window for ${SONNET5}:`)
    expect(value).toContain('(from settings)')
    expect(value).toContain(WARNING)
  })

  test('NEGATIVE: settings window below the model auto window does NOT warn', async () => {
    // Arrange — 400K < surface auto 500K.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    enabledSources = ['userSettings']
    settingsBySource.userSettings = {
      modelSettings: { [SONNET5]: { autoCompactWindow: 400_000 } },
    }
    setSessionAutoCompactWindow(aggregateAutoCompactWindow())

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET5_1M))

    // Assert
    expect(value).toContain('(from settings)')
    expect(value).not.toContain(WARNING)
  })

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
    // Arrange — settings 150k, no env, no AGt entry: denominator = ctx.
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
