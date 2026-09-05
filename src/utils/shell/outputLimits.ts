import { validateBoundedIntEnvVar } from '../envValidation.js'
import { getInitialSettings } from '../settings/settings.js'

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000

// 2.1.261 (byte-verified against the official binary): the settings-level
// `bashOutputMaxChars` / `taskOutputMaxChars` values clamp to this window
// (official consts `Asr`=4000, `lge`=128000). Distinct from the env-var
// BASH_MAX_OUTPUT_LENGTH upper limit (150_000) below — the settings keys are
// clamped tighter than the legacy env cap.
export const OUTPUT_CHARS_MIN = 4_000
export const OUTPUT_CHARS_MAX = 128_000

/**
 * 2.1.261 official `ree`: clamp a settings-provided char count into
 * [OUTPUT_CHARS_MIN, OUTPUT_CHARS_MAX]; undefined passes through as undefined.
 */
export function clampOutputChars(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Math.min(Math.max(value, OUTPUT_CHARS_MIN), OUTPUT_CHARS_MAX)
}

/**
 * 2.1.261 official `OBt`: settings-ONLY inline Bash/PowerShell output size.
 * Used by the BashTool/PowerShellTool `maxResultSizeChars` getter. Falls back
 * to BASH_MAX_OUTPUT_DEFAULT (30_000) when the setting is absent.
 */
export function getBashOutputMaxChars(): number {
  return clampOutputChars(getInitialSettings().bashOutputMaxChars) ??
    BASH_MAX_OUTPUT_DEFAULT
}

/**
 * 2.1.261 official `pHe`: read-back window for Bash/PowerShell output.
 * Settings-first — a clamped `bashOutputMaxChars` overrides the env var — then
 * falls back to the legacy BASH_MAX_OUTPUT_LENGTH env validation (default
 * 30_000, upper limit 150_000).
 */
export function getMaxOutputLength(): number {
  const fromSettings = clampOutputChars(getInitialSettings().bashOutputMaxChars)
  if (fromSettings !== undefined) return fromSettings
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}
