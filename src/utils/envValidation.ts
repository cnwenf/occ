import { logForDebugging } from './debug.js'

export type EnvVarValidationResult = {
  effective: number
  status: 'valid' | 'capped' | 'invalid'
  message?: string
}

// ---------------------------------------------------------------------------
// CC 2.1.211 generalized integer env-var parser (`zl` in the upstream binary).
//
// 2.1.208 #11 fixed scientific-notation parsing (`1e6`) for
// CLAUDE_CODE_MAX_OUTPUT_TOKENS only. 2.1.211 generalizes the fix to ALL
// integer env vars AND adds digit-separator support (`64_000`, `1,000`).
//
// Accepted forms:
//   1e6       → 1000000   (scientific notation, integer result required)
//   64_000    → 64000      (digit separators: _ , NBSP NNBSP space)
//   1_000_000 → 1000000    (multi-group digit separators)
//   1000      → 1000       (plain decimal)
//   abc       → NaN        (invalid → caller supplies default)
// ---------------------------------------------------------------------------

/** Max string length eligible for notation-matched parsing. Mirrors binary. */
const MAX_NOTATION_LENGTH = 32

/**
 * Scientific-notation regex — same as 2.1.210 binary `T9f` / `aDe`.
 * Accepts optional sign, mantissa with optional fractional part, exponent.
 */
const SCIENTIFIC_NOTATION_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/

/**
 * Digit-separator regex — NEW in 2.1.211 (`_Ka`).
 * Groups of 1-3 digits separated by a consistent separator character.
 * The backreference `\1` enforces the SAME separator throughout.
 */
const DIGIT_SEPARATOR_RE = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/

/** Strip class for removing separators before parseInt — binary `bKa`. */
const SEPARATOR_STRIP_RE = /[_,\u00A0\u202F ]/g

/**
 * Core notation parser — mirrors binary `C9f`.
 * Returns the parsed integer, NaN for non-integer scientific results,
 * or undefined when no notation pattern matches (caller falls back).
 */
function parseNotationInt(s: string): number | undefined {
  if (s.length <= MAX_NOTATION_LENGTH) {
    if (SCIENTIFIC_NOTATION_RE.test(s)) {
      const asNumber = Number(s)
      return Number.isInteger(asNumber) ? asNumber : NaN
    }
    if (DIGIT_SEPARATOR_RE.test(s)) {
      return parseInt(s.replace(SEPARATOR_STRIP_RE, ''), 10)
    }
  }
  return undefined
}

/**
 * Parse an integer env-var value supporting scientific notation and digit
 * separators. Mirrors CC 2.1.211 binary `zl`.
 *
 * Returns NaN for invalid/unset values — callers use `|| default` or
 * explicit `isNaN` checks, matching the upstream pattern.
 */
export function parseEnvInt(value: string | undefined): number {
  const trimmed = String(value).trim()
  return parseNotationInt(trimmed) ?? parseInt(trimmed, 10)
}

/**
 * Parse an integer env-var with a default fallback.
 * Equivalent to `parseEnvInt(value) || defaultValue` — mirrors the
 * upstream `zl(process.env.X) || DEFAULT` pattern.
 * Note: 0 is falsy, so `parseEnvIntWithDefault('0', 10)` returns 10.
 */
export function parseEnvIntWithDefault(
  value: string | undefined,
  defaultValue: number,
): number {
  return parseEnvInt(value) || defaultValue
}

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  if (!value) {
    return { effective: defaultValue, status: 'valid' }
  }
  // CC 2.1.211: route through the shared parseEnvInt so bounded vars
  // also gain digit-separator support (`64_000`, `1,000`, etc.).
  const parsed = parseEnvInt(value)
  if (isNaN(parsed) || parsed <= 0) {
    const result: EnvVarValidationResult = {
      effective: defaultValue,
      status: 'invalid',
      message: `Invalid value "${value}" (using default: ${defaultValue})`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  if (parsed > upperLimit) {
    const result: EnvVarValidationResult = {
      effective: upperLimit,
      status: 'capped',
      message: `Capped from ${parsed} to ${upperLimit}`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  return { effective: parsed, status: 'valid' }
}
