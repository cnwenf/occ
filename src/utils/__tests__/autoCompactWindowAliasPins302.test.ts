/**
 * CC 2.1.302 #07 (acceptance finding ⑫) — raw-alias normalization pins at
 * the TWO bare model-alias read points in autoCompactWindow.ts.
 *
 * Both sites derive a lookup key as `getCanonicalName(normalizeModelSpecifier(model))`
 * (official v302 key builder = Ke ∘ dFt). Existing tests only ever pass
 * already-canonical model names, where normalizeModelSpecifier is identity —
 * so dropping the normalize call at either site kept them green. These pins
 * drive the REAL exported functions with RAW aliases ('opus', 'sonnet'),
 * whose normalization changes the observable output:
 *
 * - autoCompactWindow.ts:298 — `resolveAutoCompactWindow` (official `Dw`):
 *   `settingsKey` selects the byModel entry of the aggregate override. A raw
 *   alias must hit the entry stored under the RESOLVED canonical key. Without
 *   normalization, getCanonicalName('opus') === 'opus' misses byModel and the
 *   resolver collapses to the aggregate default / auto fallback — a different
 *   {window, configured, source} triple.
 * - autoCompactWindow.ts:634 — `chosenWindowExceedsAutoWindow` (official
 *   `TAn` warn gate): `canonical` is the AGt (MODEL_WINDOW_DEFAULTS) lookup
 *   key for the denominator `resolveModelAutoWindow`. With
 *   ANTHROPIC_DEFAULT_SONNET_MODEL pinned to the table member
 *   'claude-sonnet-5', a raw 'sonnet' must hit the AGt surface/default arm.
 *   Without normalization the literal 'sonnet' misses AGt, the denominator
 *   collapses to the auto fallback (ctx), and the gate flips.
 *
 * No mocks: resolveAutoCompactWindow takes its override aggregate directly
 * and chosenWindowExceedsAutoWindow takes ctx/chosen directly; alias
 * resolution runs through the real parseUserSpecifiedModel →
 * getDefaultOpusModel/getDefaultSonnetModel env chain. Env hygiene + the tmp
 * CLAUDE_CONFIG_DIR mirror autoCompactWindowWarnGate300.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
// Must run BEFORE the production modules load, hence the awaited imports.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { resolveAutoCompactWindow, chosenWindowExceedsAutoWindow } =
  await import('../autoCompactWindow.js')
const { getCanonicalName, parseUserSpecifiedModel } = await import(
  '../model/model.js'
)

// ---------------------------------------------------------------------------
// Env hygiene + fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
/** Canonical key with an official AGt table entry (@225876625). */
const SONNET5 = 'claude-sonnet-5'

// Env vars that participate in the two read points (env branch of Dw, the
// Bp/oh tuning gate, the C0e surface lookup, q$o) or would perturb alias
// resolution — snapshotted and restored around every test.
const GUARDED_ENV_KEYS = [
  ENV_KEY,
  'CLAUDE_CODE_ENTRYPOINT',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'USER_TYPE',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const

let tmpConfig = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
let savedEnv: Record<string, string | undefined> = {}

/** The canonical key a raw specifier must resolve to (real prod chain). */
function resolvedKey(alias: string): string {
  return getCanonicalName(parseUserSpecifiedModel(alias) as never)
}

beforeEach(() => {
  savedEnv = {}
  for (const key of GUARDED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tmpConfig = mkdtempSync(join(tmpdir(), 'occ-acw-alias-pins-302-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfig
})

afterEach(() => {
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
// Site :298 — resolveAutoCompactWindow settings key (official Dw)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #07 finding ⑫ — resolveAutoCompactWindow raw-alias settings key (:298)', () => {
  test("a raw 'opus' alias reads the byModel window stored under the RESOLVED canonical Opus key", () => {
    // Arrange — the writer side (buildAutoCompactWindowPatch, pinned in
    // autoCompactWindowAliasKey302.test.ts) stores bare 'opus' under the
    // resolved canonical key; the reader side must resolve identically.
    const opusKey = resolvedKey('opus')
    expect(opusKey).not.toBe('opus')
    const aggregate = { default: undefined, byModel: { [opusKey]: 150_000 } }

    // Act
    const resolved = resolveAutoCompactWindow('opus', 200_000, aggregate)

    // Assert — settings branch with the per-model window. Dropping the
    // normalizeModelSpecifier call at :298 leaves settingsKey === 'opus',
    // misses byModel and falls through to {window: 200_000, source: 'auto'}.
    expect(resolved).toEqual({
      window: 150_000,
      configured: 150_000,
      source: 'settings',
    })
  })

  test("a raw 'sonnet' alias reads its canonical byModel entry, never the aggregate default", () => {
    // Arrange — a DIFFERENT default and per-model value, so an alias that
    // fails normalization is observably served the default instead.
    const sonnetKey = resolvedKey('sonnet')
    expect(sonnetKey).not.toBe('sonnet')
    const aggregate = {
      default: 180_000,
      byModel: { [sonnetKey]: 120_000 },
    }

    // Act
    const resolved = resolveAutoCompactWindow('sonnet', 200_000, aggregate)

    // Assert — normalized: 120K from byModel. Unnormalized: settingsKey
    // 'sonnet' misses → default 180K.
    expect(resolved).toEqual({
      window: 120_000,
      configured: 120_000,
      source: 'settings',
    })
  })

  test("an aggregate keyed by the LITERAL alias 'opus' is NOT read (key derivation is normalize-then-canonicalize)", () => {
    // Arrange — the pre-302 leak spelled the key 'opus'; the resolver must
    // not serve that entry to a raw 'opus' model.
    const aggregate = { default: undefined, byModel: { opus: 150_000 } }

    // Act
    const resolved = resolveAutoCompactWindow('opus', 200_000, aggregate)

    // Assert — auto fallback. Dropping normalization at :298 makes
    // settingsKey === 'opus' hit this stale literal key instead.
    expect(resolved).toEqual({
      window: 200_000,
      configured: 200_000,
      source: 'auto',
    })
  })
})

// ---------------------------------------------------------------------------
// Site :634 — chosenWindowExceedsAutoWindow AGt key (official TAn)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #07 finding ⑫ — chosenWindowExceedsAutoWindow raw-alias AGt key (:634)', () => {
  test("a raw 'sonnet' alias hits the AGt surface window through normalization (gate fires)", () => {
    // Arrange — pin the 'sonnet' alias onto the AGt table member and the
    // local-agent surface (official AGt @225876625: surfaces["local-agent"]
    // .default = 500_000).
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = SONNET5
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    expect(resolvedKey('sonnet')).toBe(SONNET5)

    // Act + Assert — min(1M, 800K) = 800K > min(1M, 500K) = 500K → true,
    // identical to the concrete-name call. Dropping normalizeModelSpecifier
    // at :634 leaves canonical === 'sonnet', misses AGt, the denominator
    // collapses to the auto fallback ctx = 1M and the gate flips to false.
    expect(chosenWindowExceedsAutoWindow('sonnet', 1_000_000, 800_000)).toBe(
      true,
    )
    expect(
      chosenWindowExceedsAutoWindow(SONNET5, 1_000_000, 800_000),
    ).toBe(true)
  })

  test("the same raw alias below the AGt surface window does not fire", () => {
    // Arrange
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = SONNET5
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'

    // Act + Assert — 400K <= surface auto 500K.
    expect(chosenWindowExceedsAutoWindow('sonnet', 1_000_000, 400_000)).toBe(
      false,
    )
  })

  test("a raw 'sonnet' alias hits the AGt default kge=1M arm without a surface entrypoint", () => {
    // Arrange — entrypoint 'cli' is not an AGt surface key → C0e falls to
    // gPt(rest).default = kge = 1_000_000.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = SONNET5
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    // Act + Assert — min(2M, 1.5M) = 1.5M > min(2M, 1M) = 1M → true.
    // Unnormalized: denominator = auto fallback ctx = 2M → false.
    expect(
      chosenWindowExceedsAutoWindow('sonnet', 2_000_000, 1_500_000),
    ).toBe(true)
  })
})
