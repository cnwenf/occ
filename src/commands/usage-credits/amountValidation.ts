/**
 * Amount-input validation for /usage-credits (CC 2.1.207 #24).
 *
 * The official 2.1.207 fix replaced a buggy "strip non-digits then accept"
 * path with a strict regex that rejects malformed values (e.g. a pasted
 * timestamp `2024-01-15T10:30:00`) instead of silently collapsing them to
 * digits. Amounts over $1,000 (100 000 cents) additionally require a typed
 * confirmation.
 *
 * Binary evidence (2.1.210 `strings`):
 *   "Enter an amount"
 *   "Enter an amount like 20 or 20.50"
 *   /^([0-9]+)(?:\.([0-9]{1,2}))?$/
 *   Number(r[1])*100+Number((r[2]??"").padEnd(2,"0"))
 *   lgr(e)=e%100===0?String(e/100):(e/100).toFixed(2)  // cents→dollars
 *
 * The >$1,000 confirmation threshold is 100 000 cents (= `100000` in the
 * binary's literal pool).
 */

/** Dollar amounts ≥ this value (in cents) require a typed confirmation. */
export const AMOUNT_CONFIRMATION_THRESHOLD_CENTS = 100_000 // $1,000

/**
 * Regex matching a whole-dollar amount with an optional 2-decimal cents part.
 * Mirrors the binary's `/^([0-9]+)(?:\.([0-9]{1,2}))?$/`.
 *
 * A pasted timestamp such as `1700000000` is all-digits and WILL match — but
 * it converts to $1 700 000 000 which is far over the confirmation threshold.
 * A timestamp with separators (`2024-01-15T10:30:00`) does NOT match and is
 * rejected, which is the core fix.
 */
const AMOUNT_REGEX = /^([0-9]+)(?:\.([0-9]{1,2}))?$/

export type AmountParseResult =
  | { ok: true; cents: number }
  | { ok: false; error: string }

/**
 * Parse a free-text dollar amount into cents.
 *
 * - Empty input → "Enter an amount"
 * - Non-matching (malformed) input → "Enter an amount like 20 or 20.50"
 * - Zero → "Enter an amount"
 *
 * Returns `{ ok: true, cents }` on success.
 */
export function parseAmountInput(input: string): AmountParseResult {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Enter an amount' }
  }

  const match = AMOUNT_REGEX.exec(trimmed)
  if (!match) {
    return { ok: false, error: 'Enter an amount like 20 or 20.50' }
  }

  const dollars = Number(match[1])
  const centsPart = (match[2] ?? '').padEnd(2, '0')
  const cents = dollars * 100 + Number(centsPart)

  if (cents <= 0) {
    return { ok: false, error: 'Enter an amount' }
  }

  return { ok: true, cents }
}

/**
 * Whether a cents value exceeds the confirmation threshold (>$1,000).
 * The caller should prompt the user to type-confirm before proceeding.
 */
export function requiresConfirmation(cents: number): boolean {
  return cents >= AMOUNT_CONFIRMATION_THRESHOLD_CENTS
}

/**
 * Format a cents value back to a human-readable dollar string.
 * Mirrors the binary's `lgr(e)`:
 *   - exact dollar amounts (cents % 100 === 0) → "20"
 *   - amounts with cents → "20.50"
 */
export function formatCentsToDollars(cents: number): string {
  if (cents % 100 === 0) {
    return String(cents / 100)
  }
  return (cents / 100).toFixed(2)
}
