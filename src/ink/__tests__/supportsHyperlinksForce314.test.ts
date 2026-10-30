import { describe, expect, test } from 'bun:test'

import { supportsHyperlinks } from '../supports-hyperlinks.js'

/**
 * CC 2.1.314 (OCC-138, changelog item 93): `FORCE_HYPERLINK=false` (also `no`
 * and `off`) turns hyperlinks OFF instead of ON.
 *
 * Official v314 outer override wrapper `ZWe` (byte-verified @259538525 region of
 * scratch-occ138/v314/package/claude):
 *   `let i=(r?.env??process.env).FORCE_HYPERLINK; if(!i)return;
 *    return !(os(i)||parseInt(i,10)===0)`
 * where `os` (@243469354) is:
 *   `function os(e){if(e===void 0)return!1;if(typeof e==="boolean")return!e;
 *    let n=String(e).toLowerCase().trim();return["0","false","no","off"].includes(n)}`
 * — byte-identical to OCC's existing `isEnvDefinedFalsy`.
 *
 * v312 `tje` instead returned `stdoutSupported` for ANY set value (ignoring it),
 * so `FORCE_HYPERLINK=false` wrongly kept hyperlinks ON. These tests pin the
 * value-aware v314 semantics.
 */
describe('supportsHyperlinks — FORCE_HYPERLINK value-aware override (2.1.314)', () => {
  // A terminal that DOES support hyperlinks; the override must beat detection.
  const stdoutSupported = true

  test('FORCE_HYPERLINK=false turns hyperlinks OFF even when stdout supports them', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: 'false' }, stdoutSupported }),
    ).toBe(false)
  })

  test('FORCE_HYPERLINK=no turns hyperlinks OFF', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: 'no' }, stdoutSupported }),
    ).toBe(false)
  })

  test('FORCE_HYPERLINK=off turns hyperlinks OFF', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: 'off' }, stdoutSupported }),
    ).toBe(false)
  })

  test('FORCE_HYPERLINK=0 turns hyperlinks OFF (parseInt-zero arm)', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: '0' }, stdoutSupported }),
    ).toBe(false)
  })

  test('FORCE_HYPERLINK is case-insensitive + trimmed (os lowercases/trims)', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: 'FALSE' }, stdoutSupported }),
    ).toBe(false)
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: ' Off ' }, stdoutSupported }),
    ).toBe(false)
  })

  test('FORCE_HYPERLINK=true / 1 turn hyperlinks ON even when stdout does not support them', () => {
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: 'true' }, stdoutSupported: false }),
    ).toBe(true)
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: '1' }, stdoutSupported: false }),
    ).toBe(true)
  })

  test('empty FORCE_HYPERLINK falls through to detection (official `if(!i)return`)', () => {
    // Empty value → no override → stdoutSupported decides.
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: '' }, stdoutSupported: true }),
    ).toBe(true)
    expect(
      supportsHyperlinks({ env: { FORCE_HYPERLINK: '' }, stdoutSupported: false }),
    ).toBe(false)
  })

  test('unset FORCE_HYPERLINK falls through to detection', () => {
    expect(supportsHyperlinks({ env: {}, stdoutSupported: true })).toBe(true)
    expect(supportsHyperlinks({ env: {}, stdoutSupported: false })).toBe(false)
  })

  test('detection still honors additional terminals when no override', () => {
    expect(
      supportsHyperlinks({ env: { TERM_PROGRAM: 'ghostty' }, stdoutSupported: false }),
    ).toBe(true)
  })
})
