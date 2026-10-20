/**
 * CC 2.1.304 (#58) — "tool search is now enabled by default when using a
 * custom ANTHROPIC_BASE_URL; if the endpoint refuses, the request is retried
 * without it and tool search stays off there for a day."
 *
 * Unit coverage for the toolSearch.ts side of the port (official `vver`
 * module: `h`/`zOe`/`c`/`f`/`d`/`DUs`/`Cs`/`Zae`/`XEe`, byte-verified in
 * research-R4-skills-hooks.md "#58"):
 *
 *  - XEe: the vprev-303 optimistic-disable branch for a custom base URL is
 *    GONE — default mode behind a custom ANTHROPIC_BASE_URL is 'tst' and
 *    isToolSearchEnabledOptimistic() returns true (vprev=2 → vver=0 string
 *    hits for the old warn text);
 *  - zOe (isToolSearchRefuseRecoveryEnabled): true only with
 *    ENABLE_TOOL_SEARCH unset + provider firstParty + a NON-first-party base
 *    URL; =false and =true both turn the recovery off (and =false additionally
 *    yields 'standard' mode so the refused request is never sent);
 *  - c (toolSearchRefusedKey): sha256(`${ANTHROPIC_BASE_URL}\0${normalized
 *    model}`).slice(0,24) — verified against an independently computed hash,
 *    and the [1m] suffix normalizes away (Pn = normalizeModelStringForAPI);
 *  - f (isRefusedAtFresh) / TTL h=86_400_000: an entry older than a day is
 *    expired → tool search is back on;
 *  - d (isToolSearchRefused) + Zae (modelSupportsToolReference's final
 *    `return !d(e)`): a fresh entry makes the model read as unsupported
 *    (downstream gate reason `model_unsupported`), isolated per model AND per
 *    endpoint URL; the haiku patterns check still wins independently;
 *  - DUs (recordToolSearchRefused): writes toolSearchRefusedAt[key]=Date.now()
 *    through saveGlobalConfig and prunes expired entries in the same write
 *    (Cs);
 *  - the whole refused-window read path is zOe-gated: with the official host
 *    (or the assume-first-party flag) a planted fresh entry is ignored.
 *
 * The claude.ts-layer refuse-recovery wiring (retryToolSearchRefused, the
 * critical_system_reminder prepend, the tengu_beta_400_healed {unclaimed:true}
 * telemetry) is covered end-to-end in
 * src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts.
 *
 * Config seam: under `bun test` NODE_ENV='test', so getGlobalConfig()/
 * saveGlobalConfig() operate on config.ts's module-level
 * TEST_GLOBAL_CONFIG_FOR_TESTING object (getGlobalConfig returns the live
 * reference). Tests reset it by deleting the `toolSearchRefusedAt` key.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createHash } from 'crypto'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
// NOTE: this file lives in the same `bun test` directory as
// ideExtensionSingleLaunch300, which reads MACRO.VERSION as its
// BUNDLED_VERSION and feeds it through a real SemVer parse. The usual
// `{ VERSION: 'test' }` polyfill wins the load-order race in some pairings
// and fails that parse ("Invalid SemVer: test"), so this file polyfills a
// VALID semver instead — harmless here (only fingerprinting reads it) and
// compatible whichever file loads first.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.304' }
}

const {
  getToolSearchMode,
  isToolSearchEnabledOptimistic,
  isToolSearchRefuseRecoveryEnabled,
  isToolSearchRefused,
  recordToolSearchRefused,
  modelSupportsToolReference,
} = await import('../toolSearch.js')
const { getGlobalConfig, saveGlobalConfig } = await import('../config.js')

// ---------------------------------------------------------------------------
// Constants / env isolation
// ---------------------------------------------------------------------------
const CUSTOM_URL = 'https://gateway.example.com'
const OTHER_URL = 'https://proxy.other.example.com'
const OFFICIAL_URL = 'https://api.anthropic.com'
const SONNET = 'claude-sonnet-4-6'
const OTHER_MODEL = 'claude-opus-5'
const HAIKU = 'claude-3-haiku'

/** Official `h` — one day in ms. */
const TTL_MS = 86_400_000

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
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
] as const

let savedEnv: Record<string, string | undefined> = {}

function resetRefusedWindow(): void {
  // getGlobalConfig() returns the LIVE TEST_GLOBAL_CONFIG_FOR_TESTING object
  // under NODE_ENV='test' — deleting the key is the cleanest per-test reset.
  const config = getGlobalConfig() as { toolSearchRefusedAt?: unknown }
  delete config.toolSearchRefusedAt
}

/** Independently recompute the official `c(e)` key for cross-checking. */
function expectedKey(baseUrl: string, model: string): string {
  return createHash('sha256')
    .update(`${baseUrl}\0${model}`)
    .digest('hex')
    .slice(0, 24)
}

/** Plant a raw toolSearchRefusedAt map through the real config seam. */
function plantRefusedEntries(entries: Record<string, number>): void {
  saveGlobalConfig(config => ({ ...config, toolSearchRefusedAt: entries }))
}

function refusedEntries(): Record<string, number> {
  return getGlobalConfig().toolSearchRefusedAt ?? {}
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Default arrangement: custom gateway base URL, firstParty provider, no
  // explicit ENABLE_TOOL_SEARCH override → zOe() true.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.ANTHROPIC_BASE_URL = CUSTOM_URL
  resetRefusedWindow()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetRefusedWindow()
})

afterAll(() => {
  resetRefusedWindow()
})

// ---------------------------------------------------------------------------
// 1. XEe — tool search ON by default behind a custom base URL (the vprev-303
//    optimistic-disable branch was removed by the official 304).
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — default mode behind a custom ANTHROPIC_BASE_URL', () => {
  test("unset ENABLE_TOOL_SEARCH + custom base URL → mode 'tst' and optimistic check true", () => {
    // Arrange — beforeEach set ANTHROPIC_BASE_URL to the custom gateway.

    // Act
    const mode = getToolSearchMode()
    const optimistic = isToolSearchEnabledOptimistic()

    // Assert — v303 returned false here (the dropped "is not a first-party
    // Anthropic host" branch); 304 defaults to ON.
    expect(mode).toBe('tst')
    expect(optimistic).toBe(true)
  })

  test('explicit ENABLE_TOOL_SEARCH semantics survive the branch removal', () => {
    // =false → standard (the refused request is skipped entirely).
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(getToolSearchMode()).toBe('standard')
    expect(isToolSearchEnabledOptimistic()).toBe(false)

    // =true → tst (always send tool search; recovery off — see below).
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(getToolSearchMode()).toBe('tst')
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. zOe — the refuse-recovery eligibility predicate.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — isToolSearchRefuseRecoveryEnabled (official zOe)', () => {
  test('custom base URL + no override + firstParty → true', () => {
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(true)
  })

  test('ENABLE_TOOL_SEARCH=false → false (=false skips the refused request)', () => {
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })

  test('ENABLE_TOOL_SEARCH=true → false (=true always sends, recovery off)', () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })

  test('official api.anthropic.com host → false', () => {
    process.env.ANTHROPIC_BASE_URL = OFFICIAL_URL
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })

  test('unset ANTHROPIC_BASE_URL (implicit first-party) → false', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })

  test('assume-first-party flag → false', () => {
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })

  test('non-firstParty provider (bedrock) → false', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isToolSearchRefuseRecoveryEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. c/f/d/DUs/Cs — the persisted refused window.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — refused window record/read/prune', () => {
  test('fresh config → isToolSearchRefused false, modelSupportsToolReference true', () => {
    expect(isToolSearchRefused(SONNET)).toBe(false)
    expect(modelSupportsToolReference(SONNET)).toBe(true)
  })

  test('recordToolSearchRefused writes the official sha256 key and flips both predicates', () => {
    // Act
    recordToolSearchRefused(SONNET)

    // Assert — the entry key is exactly c(e) =
    // sha256(`${ANTHROPIC_BASE_URL}\0${normalizedModel}`).slice(0,24).
    const entries = refusedEntries()
    const key = expectedKey(CUSTOM_URL, SONNET)
    expect(Object.keys(entries)).toEqual([key])
    expect(typeof entries[key]).toBe('number')
    expect(Math.abs(Date.now() - (entries[key] as number))).toBeLessThan(60_000)
    // d(e) fresh → refused; Zae's `return !d(e)` → unsupported.
    expect(isToolSearchRefused(SONNET)).toBe(true)
    expect(modelSupportsToolReference(SONNET)).toBe(false)
  })

  test('recording is idempotent while the window is fresh (official `if(d(e))return`)', () => {
    // Arrange
    recordToolSearchRefused(SONNET)
    const first = refusedEntries()[expectedKey(CUSTOM_URL, SONNET)]

    // Act — a second record inside the window must not rewrite the timestamp.
    recordToolSearchRefused(SONNET)

    // Assert
    expect(refusedEntries()[expectedKey(CUSTOM_URL, SONNET)]).toBe(first)
  })

  test('the key normalizes the model ([1m] suffix maps to the same entry)', () => {
    // Arrange — record with the suffixed alias.
    recordToolSearchRefused(`${SONNET}[1m]`)

    // Assert — one entry, keyed by the NORMALIZED model, and the bare model
    // reads as refused (Pn = normalizeModelStringForAPI in the key hash).
    expect(Object.keys(refusedEntries())).toEqual([expectedKey(CUSTOM_URL, SONNET)])
    expect(isToolSearchRefused(SONNET)).toBe(true)
    expect(isToolSearchRefused(`${SONNET}[1m]`)).toBe(true)
  })

  test('isolation: a refusal for one model does not spill to another', () => {
    // Arrange
    recordToolSearchRefused(SONNET)

    // Act / Assert
    expect(isToolSearchRefused(OTHER_MODEL)).toBe(false)
    expect(modelSupportsToolReference(OTHER_MODEL)).toBe(true)
  })

  test('isolation: a refusal behind one endpoint does not spill to another URL', () => {
    // Arrange
    recordToolSearchRefused(SONNET)
    expect(isToolSearchRefused(SONNET)).toBe(true)

    // Act — same model, different gateway.
    process.env.ANTHROPIC_BASE_URL = OTHER_URL

    // Assert
    expect(isToolSearchRefused(SONNET)).toBe(false)
    expect(modelSupportsToolReference(SONNET)).toBe(true)
  })

  test('TTL: an entry older than 86_400_000 ms is expired → tool search back on', () => {
    // Arrange — plant a stale timestamp (official f: |now - ts| < h).
    plantRefusedEntries({
      [expectedKey(CUSTOM_URL, SONNET)]: Date.now() - TTL_MS - 1000,
    })

    // Act / Assert
    expect(isToolSearchRefused(SONNET)).toBe(false)
    expect(modelSupportsToolReference(SONNET)).toBe(true)
  })

  test('recording prunes expired entries in the same write (official Cs)', () => {
    // Arrange — one expired entry for another endpoint+model, then record a
    // fresh refusal for the current one.
    const staleKey = expectedKey(OTHER_URL, OTHER_MODEL)
    plantRefusedEntries({ [staleKey]: Date.now() - TTL_MS - 1000 })

    // Act
    recordToolSearchRefused(SONNET)

    // Assert — only the fresh entry survives.
    const entries = refusedEntries()
    expect(Object.keys(entries)).toEqual([expectedKey(CUSTOM_URL, SONNET)])
    expect(entries[staleKey]).toBeUndefined()
  })

  test('zOe gate: with the official host a planted fresh entry is ignored', () => {
    // Arrange
    recordToolSearchRefused(SONNET)
    expect(isToolSearchRefused(SONNET)).toBe(true)

    // Act — flip to the first-party host (recovery ineligible there).
    process.env.ANTHROPIC_BASE_URL = OFFICIAL_URL

    // Assert — the read path is zOe-gated: no refused-window semantics.
    expect(isToolSearchRefused(SONNET)).toBe(false)
    expect(modelSupportsToolReference(SONNET)).toBe(true)
  })

  test('zOe gate: assume-first-party flag ignores a planted fresh entry', () => {
    // Arrange
    recordToolSearchRefused(SONNET)

    // Act
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

    // Assert
    expect(isToolSearchRefused(SONNET)).toBe(false)
    expect(modelSupportsToolReference(SONNET)).toBe(true)
  })

  test('patterns check still wins: haiku stays unsupported regardless of the window', () => {
    // Arrange — no refusal recorded at all.

    // Act / Assert — the unsupported-patterns arm of Zae fires first.
    expect(modelSupportsToolReference(HAIKU)).toBe(false)
    expect(isToolSearchRefused(HAIKU)).toBe(false)
  })
})
