import { describe, expect, test } from 'bun:test'
import { isOutputRedirectOp } from '../bashPermissions'

/** M2 (CC 2.1.214): fail-closed on fd-redirect forms the analyzer parses
 * differently. Broaden isOutputRedirectOp from exact-match to catch numeric-fd
 * redirect ops (2>/1>>/2>& etc.) so their targets get validated. */

describe('M2 (2.1.214): fd-redirect fail-closed — isOutputRedirectOp', () => {
  test('standard ops → true', () => {
    expect(isOutputRedirectOp('>')).toBe(true)
    expect(isOutputRedirectOp('>>')).toBe(true)
    expect(isOutputRedirectOp('>|')).toBe(true)
    expect(isOutputRedirectOp('&>')).toBe(true)
    expect(isOutputRedirectOp('&>>')).toBe(true)
    expect(isOutputRedirectOp('>&')).toBe(true)
  })
  test('numeric-fd output ops → true (the M2 gap)', () => {
    expect(isOutputRedirectOp('2>')).toBe(true)
    expect(isOutputRedirectOp('1>')).toBe(true)
    expect(isOutputRedirectOp('2>>')).toBe(true)
    expect(isOutputRedirectOp('1>>')).toBe(true)
    expect(isOutputRedirectOp('2>&')).toBe(true)
    expect(isOutputRedirectOp('1>&')).toBe(true)
    expect(isOutputRedirectOp('3>')).toBe(true)
  })
  test('input/rdwr ops → false', () => {
    expect(isOutputRedirectOp('<')).toBe(false)
    expect(isOutputRedirectOp('<&')).toBe(false)
    expect(isOutputRedirectOp('<>')).toBe(false)
    expect(isOutputRedirectOp('<<')).toBe(false)
  })
  test('non-redirect → false', () => {
    expect(isOutputRedirectOp('|')).toBe(false)
    expect(isOutputRedirectOp('')).toBe(false)
    expect(isOutputRedirectOp('file.txt')).toBe(false)
  })
})
