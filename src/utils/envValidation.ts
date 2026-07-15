import { logForDebugging } from './debug.js'

export type EnvVarValidationResult = {
  effective: number
  status: 'valid' | 'capped' | 'invalid'
  message?: string
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
  // CC 2.1.208 #11: parseInt('1e6', 10) stops at 'e' and silently returns 1,
  // so scientific-notation values like CLAUDE_CODE_MAX_OUTPUT_TOKENS=1e6 were
  // treated as their mantissa. Detect scientific notation and parse via Number()
  // (which honors the exponent), accepting only integer results. Mirrors CC 2.1.210
  // binary `aDe`: /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/ -> Number.isInteger.
  const raw = String(value)
  const trimmed = raw.trim()
  let parsed: number
  if (
    trimmed.length <= 32 &&
    /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(trimmed)
  ) {
    const asNumber = Number(trimmed)
    parsed = Number.isInteger(asNumber) ? asNumber : NaN
  } else {
    parsed = parseInt(raw, 10)
  }
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
