import { LOCAL_COMMAND_STDERR_TAG } from '../constants/xml.js'
import { extractTag } from './messages.js'

/**
 * The error marker prepended to a failed local-command's stderr output so it
 * DISPLAYS as an error rather than a plain result line. `figures.cross` (✘)
 * — the same glyph OCC's StatusIcon uses for `status: 'error'`.
 */
export const LOCAL_COMMAND_ERROR_MARKER = '✘'

/**
 * 2.1.216 #35 (b): "a failed /compact displays as an error".
 *
 * Recon: at the command-logic layer OCC already surfaces compact failures —
 * compact.ts throws on every failure path and processSlashCommand's `local`
 * catch wraps the thrown error in a `<local-command-stderr>` tag. The genuine
 * gap was the DISPLAY layer: UserLocalCommandOutputMessage rendered stderr
 * IDENTICALLY to stdout (no error color, no marker), so a failed /compact
 * looked like a normal result line.
 *
 * This helper classifies a local-command output payload as an error when it
 * carries a non-empty `<local-command-stderr>` payload, so the renderer can
 * distinguish failures from normal results and surface them as errors.
 * Reuses OCC's existing stderr tag — no new error channel is introduced.
 */
export function isLocalCommandError(content: string): boolean {
  const stderr = extractTag(content, LOCAL_COMMAND_STDERR_TAG)
  return stderr !== null && stderr.trim().length > 0
}
