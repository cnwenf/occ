import { validateBoundedIntEnvVar } from '../envValidation.js'
import { clampOutputChars } from '../shell/outputLimits.js'
import { getInitialSettings } from '../settings/settings.js'
import { getTaskOutputPath } from './diskOutput.js'

export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

// 2.1.261 (byte-verified): the official TaskOutput tool spec advertises
// `maxResultSizeChars = Kut() + TWn`, where `TWn` = eN - q8e = 50000 - 32000
// = 18000 chars of inline headroom above the task-output default.
export const TASK_OUTPUT_INLINE_HEADROOM = 18_000

/**
 * 2.1.261 official `Kut`: settings-ONLY inline task-output size. Used by the
 * TaskOutputTool `maxResultSizeChars` getter (plus headroom). Falls back to
 * TASK_MAX_OUTPUT_DEFAULT (32_000) when the setting is absent.
 */
export function getTaskOutputMaxChars(): number {
  return clampOutputChars(getInitialSettings().taskOutputMaxChars) ??
    TASK_MAX_OUTPUT_DEFAULT
}

/**
 * 2.1.261 official `eVo`: truncation window for a background task's output.
 * Settings-first — a clamped `taskOutputMaxChars` overrides the env var — then
 * falls back to the legacy TASK_MAX_OUTPUT_LENGTH env validation (default
 * 32_000, upper limit 160_000).
 */
export function getMaxTaskOutputLength(): number {
  const fromSettings = clampOutputChars(getInitialSettings().taskOutputMaxChars)
  if (fromSettings !== undefined) return fromSettings
  const result = validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}

/**
 * Format task output for API consumption, truncating if too large.
 * When truncated, includes a header with the file path and returns
 * the last N characters that fit within the limit.
 */
export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength()

  if (output.length <= maxLen) {
    return { content: output, wasTruncated: false }
  }

  const filePath = getTaskOutputPath(taskId)
  const header = `[Truncated. Full output: ${filePath}]\n\n`
  const availableSpace = maxLen - header.length
  const truncated = output.slice(-availableSpace)

  return { content: header + truncated, wasTruncated: true }
}
