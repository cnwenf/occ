import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resetGrowthBook } from '../../../services/analytics/growthbook.js'
import { findSubstitutionTargetBlock } from '../destructiveCommandWarning.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.281 wholeSubstitution guard is gated by GrowthBook
 * `tengu_iridescent_boot` (default true). Official gate:
 *   !(bt.value === false && bt.source === "payload")
 * OCC divergence (documented in docs/upstream-version-gap-occ136.md):
 * getFeatureValue_CACHED_MAY_BE_STALE exposes no `source`, so OCC treats an
 * explicit `false` from any override layer as disabling the guard. This is
 * fail-open only when an operator/override explicitly opts out — matching
 * the official env-gate escape hatch semantics.
 *
 * Isolation notes: bun test runs every file in ONE process, and growthbook
 * latches env overrides on first read (`envOverridesParsed`). So the
 * USER_TYPE=ant + CLAUDE_INTERNAL_FC_OVERRIDES env pair is set in beforeAll
 * (never at module top level, which would leak into sibling files) and
 * `resetGrowthBook()` clears the latch both before and after, making this
 * file order-independent.
 */
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ['USER_TYPE', 'CLAUDE_INTERNAL_FC_OVERRIDES']) {
    savedEnv[key] = process.env[key]
  }
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_INTERNAL_FC_OVERRIDES = JSON.stringify({
    tengu_iridescent_boot: false,
  })
  resetGrowthBook()
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetGrowthBook()
})

describe('2.1.281 tengu_iridescent_boot=false disables wholeSubstitution', () => {
  test('rm -rf $(pwd) is NOT blocked when the feature value is false', () => {
    expect(findSubstitutionTargetBlock('rm -rf $(pwd)')).toBeNull()
    expect(findSubstitutionTargetBlock('rm -rf "$(pwd)"')).toBeNull()
    expect(
      findSubstitutionTargetBlock('sudo env FOO=1 timeout 5 /usr/bin/rm -rf $(pwd)'),
    ).toBeNull()
  })

  test('emptyExpansion is NOT gated by tengu_iridescent_boot (official gate only wraps wholeSub)', () => {
    const block = findSubstitutionTargetBlock('rm -rf /$(pwd)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyExpansion')
  })
})
