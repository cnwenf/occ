import { describe, expect, test } from 'bun:test'

// Status.tsx transitively reads MACRO.VERSION (a build-time constant
// polyfilled in cli.tsx). Mirror the repo-convention polyfill, then import
// dynamically so the polyfill is in place before the module evaluates.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { buildAutoModeServerProperties } = await import('../Status.js')

/**
 * CC 2.1.278 (A2) — `/status` gains an "Auto mode server" row.
 *
 * Official v278, byte-extracted from /tmp/cc-diff-278/v278/package/claude:
 *   @216302674  function jvr(i){return[{label:"Auto mode server",
 *               value:jUr(i)?"Enabled":"Disabled"}]}
 *   caller:     ...Bvr(),...jvr(R)]   (jvr appended LAST in the secondary
 *               section, after the setting-sources rows)
 *
 * OCC ships no server-side auto-mode classifier, so the `jUr(i)` gate is always
 * false here and the row reports the constant "Disabled". The label and both
 * value strings are byte-copied from the binary; buildSecondarySection appends
 * buildAutoModeServerProperties() last to match the official ordering.
 */
describe('2.1.278 A2 — /status "Auto mode server" row', () => {
  test('emits exactly one row carrying the byte-exact official label', () => {
    // Act
    const rows = buildAutoModeServerProperties()

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('Auto mode server')
  })

  test('reports the constant "Disabled" value (OCC has no server-side classifier)', () => {
    // Act
    const rows = buildAutoModeServerProperties()

    // Assert
    expect(rows[0].value).toBe('Disabled')
  })

  test('value is one of the two official strings (Enabled/Disabled)', () => {
    // Act
    const { value } = buildAutoModeServerProperties()[0]

    // Assert
    expect(['Enabled', 'Disabled']).toContain(value)
  })
})
