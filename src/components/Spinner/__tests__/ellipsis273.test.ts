import { describe, expect, test } from 'bun:test'

import {
  SPINNER_ELLIPSIS_RE,
  appendSpinnerEllipsis,
} from '../utils.js'

/**
 * Official 2.1.273 spinner-verb fix (byte-verified): the ellipsis appender
 * gained a trailing-ellipsis guard — verbs that already end in `…` or `...`
 * no longer get a doubled ellipsis (`Running hooks…` instead of
 * `Running hooks……`). Extracted as appendSpinnerEllipsis + SPINNER_ELLIPSIS_RE.
 */

describe('2.1.273 SPINNER_ELLIPSIS_RE', () => {
  test('matches a trailing unicode ellipsis', () => {
    expect(SPINNER_ELLIPSIS_RE.test('Running hooks…')).toBe(true)
  })

  test('matches trailing three ASCII dots', () => {
    expect(SPINNER_ELLIPSIS_RE.test('Loading...')).toBe(true)
  })

  test('does not match plain verbs or interior ellipses', () => {
    expect(SPINNER_ELLIPSIS_RE.test('Thinking')).toBe(false)
    expect(SPINNER_ELLIPSIS_RE.test('a…b')).toBe(false)
    expect(SPINNER_ELLIPSIS_RE.test('Verb..')).toBe(false)
    expect(SPINNER_ELLIPSIS_RE.test('')).toBe(false)
  })
})

describe('2.1.273 appendSpinnerEllipsis', () => {
  test('appends … to a plain verb', () => {
    expect(appendSpinnerEllipsis('Thinking')).toBe('Thinking…')
    expect(appendSpinnerEllipsis('')).toBe('…')
  })

  test('leaves verbs ending in … untouched (no doubled ellipsis)', () => {
    expect(appendSpinnerEllipsis('Running PreCompact hooks…')).toBe(
      'Running PreCompact hooks…',
    )
  })

  test('leaves verbs ending in ... untouched', () => {
    expect(appendSpinnerEllipsis('Loading...')).toBe('Loading...')
  })

  test('two ASCII dots still get the ellipsis (only exactly-three is guarded)', () => {
    expect(appendSpinnerEllipsis('Verb..')).toBe('Verb..…')
  })

  test('idempotent — appending twice equals appending once', () => {
    const once = appendSpinnerEllipsis('Working')
    expect(appendSpinnerEllipsis(once)).toBe(once)
  })
})
