import { isEnvTruthy } from './envUtils.js'

/**
 * claude-code 2.1.98: CLAUDE_CODE_PERFORCE_MODE — when set, Edit/Write/
 * NotebookEdit fail on read-only files with a `p4 edit` hint instead of
 * silently overwriting them.
 */

const PERFORCE_READ_ONLY_MESSAGE =
  'File is read-only — it has not been opened for edit in Perforce. Run `p4 edit <file>` to check it out, then retry. Do not chmod the file writable; that bypasses Perforce tracking.'

/** True when CLAUDE_CODE_PERFORCE_MODE is set (Perforce workspace). */
export function isPerforceMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PERFORCE_MODE)
}

/**
 * Mirrors claude-code 2.1.98's `JZ6(mode)`: perforce mode is on AND the file's
 * mode lacks the owner-write bit (0o200) → the file is read-only (not opened
 * for edit in Perforce). Returns the `p4 edit` hint message to surface, or
 * null if the edit may proceed.
 */
export function perforceReadOnlyError(mode: number): string | null {
  if (!isPerforceMode()) {
    return null
  }
  // (mode & 0o200) === 0 → owner-write bit not set → read-only
  if ((mode & 0o200) === 0) {
    return PERFORCE_READ_ONLY_MESSAGE
  }
  return null
}
