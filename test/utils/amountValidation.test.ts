import { describe, expect, test } from 'bun:test'
import {
  AMOUNT_CONFIRMATION_THRESHOLD_CENTS,
  formatCentsToDollars,
  parseAmountInput,
  requiresConfirmation,
} from '../../src/commands/usage-credits/amountValidation.js'

describe('parseAmountInput (CC 2.1.207 #24)', () => {
  test('accepts whole-dollar amounts', () => {
    expect(parseAmountInput('20')).toEqual({ ok: true, cents: 2000 })
    expect(parseAmountInput('1000')).toEqual({ ok: true, cents: 100000 })
  })

  test('accepts amounts with 2-decimal cents', () => {
    expect(parseAmountInput('20.50')).toEqual({ ok: true, cents: 2050 })
    expect(parseAmountInput('0.99')).toEqual({ ok: true, cents: 99 })
  })

  test('accepts single-decimal cents (pads to 2)', () => {
    // "20.5" → 20 dollars + 50 cents
    expect(parseAmountInput('20.5')).toEqual({ ok: true, cents: 2050 })
  })

  test('trims whitespace before validating', () => {
    expect(parseAmountInput('  42  ')).toEqual({ ok: true, cents: 4200 })
  })

  test('rejects empty input', () => {
    const result = parseAmountInput('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Enter an amount')
  })

  test('rejects whitespace-only input', () => {
    const result = parseAmountInput('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Enter an amount')
  })

  test('rejects zero', () => {
    const result = parseAmountInput('0')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Enter an amount')
  })

  test('rejects "0.00"', () => {
    const result = parseAmountInput('0.00')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Enter an amount')
  })

  test('rejects malformed pasted timestamp with separators (core fix)', () => {
    // A pasted ISO timestamp would previously be stripped to digits and
    // accepted. The regex now rejects it.
    const result = parseAmountInput('2024-01-15T10:30:00')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Enter an amount like 20 or 20.50')
    }
  })

  test('rejects negative amounts', () => {
    expect(parseAmountInput('-5').ok).toBe(false)
  })

  test('rejects more than 2 decimal places', () => {
    expect(parseAmountInput('20.123').ok).toBe(false)
  })

  test('rejects non-numeric input', () => {
    expect(parseAmountInput('abc').ok).toBe(false)
    expect(parseAmountInput('twenty').ok).toBe(false)
  })

  test('rejects dollar sign prefix', () => {
    // The binary regex does not accept a leading $ — mirrors official behavior
    expect(parseAmountInput('$20').ok).toBe(false)
  })
})

describe('requiresConfirmation (>$1,000 threshold)', () => {
  test('amounts under $1,000 do not require confirmation', () => {
    expect(requiresConfirmation(99900)).toBe(false) // $999.00
    expect(requiresConfirmation(100)).toBe(false) // $1.00
  })

  test('$1,000 exactly requires confirmation (>= threshold)', () => {
    expect(requiresConfirmation(AMOUNT_CONFIRMATION_THRESHOLD_CENTS)).toBe(true)
  })

  test('amounts over $1,000 require confirmation', () => {
    expect(requiresConfirmation(100001)).toBe(true) // $1,000.01
    expect(requiresConfirmation(5000000)).toBe(true) // $50,000.00
  })

  test('a pure-digit timestamp like 1700000000 would trigger confirmation', () => {
    // "1700000000" passes the regex (all digits) but converts to
    // $1,700,000,000 — well over the threshold, so the user must confirm.
    const result = parseAmountInput('1700000000')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(requiresConfirmation(result.cents)).toBe(true)
    }
  })
})

describe('formatCentsToDollars (lgr mirror)', () => {
  test('whole dollars omit decimals', () => {
    expect(formatCentsToDollars(2000)).toBe('20')
    expect(formatCentsToDollars(100000)).toBe('1000')
  })

  test('amounts with cents show 2 decimals', () => {
    expect(formatCentsToDollars(2050)).toBe('20.50')
    expect(formatCentsToDollars(99)).toBe('0.99')
  })

  test('zero cents formats as "0"', () => {
    expect(formatCentsToDollars(0)).toBe('0')
  })
})
