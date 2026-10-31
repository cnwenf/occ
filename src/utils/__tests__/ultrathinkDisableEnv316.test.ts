/**
 * CC 2.1.316 (OCC-139): `CLAUDE_CODE_DISABLE_ULTRATHINK` kill switch +
 * ULTRATHINK feature enablement.
 *
 * Changelog bullet 3: "Added `CLAUDE_CODE_DISABLE_ULTRATHINK` to turn off the
 * ultrathink keyword boost."
 *
 * Official v316 gate `ePt` (@276986161, byte-verified):
 *   `function ePt(){return!i.CLAUDE_CODE_DISABLE_ULTRATHINK&&v("tengu_turtle_carbon",!0)}`
 * v314's gate `hxt` (@247108806) was just `return v("tengu_turtle_carbon",!0)`
 * — the env check is NEW in 2.1.316. Raw truthiness (`!env.X`): ANY non-empty
 * value disables, including '0' and 'false' — same family as the official
 * `CLAUDE_CODE_DISABLE_WEB_FETCH` gate (WebFetchTool precedent).
 *
 * `ePt` consumers in v316 (exhaustive — 3, byte-verified):
 *   - `gme` @278285563 — the effort-boost gate ≡ OCC canBoost/shouldBoost
 *     (2.1.311 port in src/utils/effort/ultrathink.ts).
 *   - `iPr` @286516968 — the ultrathink attachment trigger ≡ OCC
 *     attachments.ts:1671.
 *   - `QAr` @307686155 — a ≤4000-char UI truncation guard (NOT ported;
 *     pre-existing trim, noted in the gap doc).
 * There is NO default-effort-resolver consumer in v314 or v316 — OCC's stale
 * `isUltrathinkEnabled() → 'medium'` branch in getDefaultEffortForModel is
 * removed this round (asserted below).
 *
 * ULTRATHINK feature-flag enablement: official external builds ship the
 * ultrathink gate ON (ePt's only runtime condition is the GrowthBook flag,
 * default true — and OCC's GrowthBook stub returns the default). OCC's
 * feature() stand-in must therefore allowlist 'ULTRATHINK' to match the
 * shipped official behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDefaultEffortForModel } from '../effort.js'
import { feature } from '../featureFlags.js'
import { isUltrathinkEnabled } from '../thinking.js'

const ENV_VAR = 'CLAUDE_CODE_DISABLE_ULTRATHINK'
const SAVED = process.env[ENV_VAR]

beforeEach(() => {
  delete process.env[ENV_VAR]
})

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = SAVED
  }
})

describe('CC 2.1.316: ULTRATHINK feature allowlist (official ships ON)', () => {
  test("feature('ULTRATHINK') is enabled", () => {
    expect(feature('ULTRATHINK')).toBe(true)
  })
})

describe('CC 2.1.316: CLAUDE_CODE_DISABLE_ULTRATHINK (official ePt)', () => {
  test('unset → enabled (tengu_turtle_carbon default true via GB stub)', () => {
    expect(isUltrathinkEnabled()).toBe(true)
  })

  test.each(['1', 'true', 'yes'])('%s → disabled', value => {
    process.env[ENV_VAR] = value
    expect(isUltrathinkEnabled()).toBe(false)
  })

  test.each(['0', 'false', 'no'])(
    '%s → disabled too (official raw truthiness !env.X, not a bool parse)',
    value => {
      process.env[ENV_VAR] = value
      expect(isUltrathinkEnabled()).toBe(false)
    },
  )

  test('empty string → enabled (falsy in JS, so !env.X passes)', () => {
    process.env[ENV_VAR] = ''
    expect(isUltrathinkEnabled()).toBe(true)
  })
})

describe('CC 2.1.316: getDefaultEffortForModel has no ultrathink branch (byte-verified absent from official v314+v316)', () => {
  test("claude-sonnet-5 → undefined (catalog default_effort 'high' ≡ API fallback)", () => {
    expect(getDefaultEffortForModel('claude-sonnet-5')).toBeUndefined()
  })

  test('claude-sonnet-5 stays undefined even with ultrathink disabled', () => {
    process.env[ENV_VAR] = '1'
    expect(getDefaultEffortForModel('claude-sonnet-5')).toBeUndefined()
  })

  test('claude-opus-5-5 catalog branch unaffected → medium', () => {
    expect(getDefaultEffortForModel('claude-opus-5-5')).toBe('medium')
  })

  test('claude-haiku-5-5 catalog branch unaffected → medium', () => {
    expect(getDefaultEffortForModel('claude-haiku-5-5')).toBe('medium')
  })

  test('claude-sonnet-5-5 catalog branch unaffected → medium', () => {
    expect(getDefaultEffortForModel('claude-sonnet-5-5')).toBe('medium')
  })

  test("claude-opus-4-7 catalog branch unaffected → xhigh", () => {
    expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('xhigh')
  })
})
