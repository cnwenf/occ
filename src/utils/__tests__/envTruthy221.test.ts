import { describe, expect, test } from 'bun:test'
import { isEnvTruthy } from '../envUtils.js'

/**
 * 2.1.221: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0` must DISABLE interrupted
 * turn auto-resume — falsy values are honored. The official bool env parser
 * enables only on "1"/"true"/"yes"/"on" (case-insensitive, trimmed); print.ts
 * now gates the auto-resume on isEnvTruthy instead of a raw truthy check
 * (which treated the non-empty strings "0"/"false" as enabled).
 */
describe('2.1.221: resume-interrupted-turn env falsy semantics', () => {
  test('"0" is NOT enabled (the reported bug)', () => {
    expect(isEnvTruthy('0')).toBe(false)
  })
  test('"false" is NOT enabled', () => {
    expect(isEnvTruthy('false')).toBe(false)
  })
  test('"no" and "off" are NOT enabled', () => {
    expect(isEnvTruthy('no')).toBe(false)
    expect(isEnvTruthy('off')).toBe(false)
  })
  test('empty / undefined are NOT enabled', () => {
    expect(isEnvTruthy('')).toBe(false)
    expect(isEnvTruthy(undefined)).toBe(false)
  })
  test('"1" / "true" / "yes" / "on" are enabled', () => {
    expect(isEnvTruthy('1')).toBe(true)
    expect(isEnvTruthy('true')).toBe(true)
    expect(isEnvTruthy('yes')).toBe(true)
    expect(isEnvTruthy('on')).toBe(true)
  })
  test('matching is case-insensitive and trimmed', () => {
    expect(isEnvTruthy(' TRUE ')).toBe(true)
    expect(isEnvTruthy('On')).toBe(true)
  })
  test('arbitrary non-empty values are NOT enabled', () => {
    expect(isEnvTruthy('enabled')).toBe(false)
    expect(isEnvTruthy('2')).toBe(false)
  })
})
