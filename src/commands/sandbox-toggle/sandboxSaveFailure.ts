import { getErrnoCode } from '../../utils/errors.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'

/**
 * PORT (CC 2.1.299, gap entry #040): /sandbox must not report success when
 * the settings save actually failed.
 *
 * Official v299 byte-exact references (linux-x64 ELF, NEVER executed —
 * strings/dd extraction only):
 *   - message prefix `qeo` @227983933 (NEW in v299; 0 hits in v296):
 *       "✗ Sandbox settings not changed: "
 *   - formatter `v({error}, successText)` @255246300 region:
 *       var Do=new Set(["EACCES","EPERM","EROFS"]);
 *       function Ne(f){return Ky(Vc(f))}
 *       function v({error:f},t){if(f===null)return t;
 *         let d=f.cause instanceof Error?f.cause:f,o=E(d),
 *         c=hn("localSettings")??".claude/settings.local.json",
 *         m=o!==void 0&&Do.has(o)
 *           ?" Start Claude Code in a project folder you can write to.":"";
 *         return `${qeo}${Ne(c)} couldn't be updated (${Ne(o??d.message)}).${m}`}
 *   - backtick wrapper `Ky` (same chunk): collapses newlines to spaces,
 *     picks a fence longer than the longest backtick run in the payload,
 *     pads with a space when the payload starts/ends with a backtick, and
 *     maps "" to "` `".
 *   - whitespace visualizer `Vc` @214772951:
 *       function Vc(t){return KU(t).replace(/\n/g,"␤").replace(/\t/g,"␉")}
 *     `KU` @214772220 is a grapheme-aware control/invisible-character
 *     visualizer (ESC→␛, C0→U+2400 block, DEL→␡, other Cf→\u{HEX}) that is
 *     the identity on clean printable text. DOCUMENTED SIMPLIFICATION: OCC
 *     omits KU — this formatter's inputs are settings paths and errno codes
 *     (clean ASCII), and OCC has no existing KU port to reuse
 *     (src/services/mcp/displaySanitize.ts is the different 2.1.274 MCP
 *     strip-to-space family). The \n→␤ / \t→␉ visualization is kept.
 *
 * Cross-agent dependency: src/utils/sandbox/sandbox-adapter.ts is owned by a
 * concurrent agent. setSandboxSettings currently returns Promise<void> and
 * addToExcludedCommands returns {outcome,...} — both discard the
 * updateSettingsForSource write error. Consumption here is DEFENSIVE:
 * `extractSandboxSaveError` treats undefined / null / missing `.error` as
 * success, so this module is correct before AND after the adapter starts
 * returning `{error}` shapes.
 */

/** Official v299 `qeo` — byte-exact ("✗" = ✗ BALLOT X). */
export const SANDBOX_SETTINGS_NOT_CHANGED_PREFIX =
  '✗ Sandbox settings not changed: '

/** Official v299 `Do` — errno codes that get the writable-folder hint. */
const WRITE_FAILURE_ERRNO_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

/** Official v299 `m` hint suffix — byte-exact (leading space included). */
const WRITE_FAILURE_HINT =
  ' Start Claude Code in a project folder you can write to.'

/** Official fallback path literal in `v()` — byte-exact. */
const FALLBACK_SETTINGS_PATH = '.claude/settings.local.json'

/**
 * Faithful port of the official `Ky` backtick wrapper: fence the payload in
 * backticks, choosing a fence longer than any backtick run inside it.
 */
export function wrapInBackticks(raw: string): string {
  const collapsed = raw.replace(/\r\n?|\n/g, ' ')
  if (collapsed === '') return '` `'
  const longestRun =
    collapsed.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ??
    0
  const fence = '`'.repeat(longestRun + 1)
  const pad = collapsed.startsWith('`') || collapsed.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${collapsed}${pad}${fence}`
}

/**
 * Port of the official `Vc` minus the KU grapheme visualizer (see header):
 * newline → ␤ (U+2424), tab → ␉ (U+2409).
 */
export function visualizeWhitespace(raw: string): string {
  return raw.replace(/\n/g, '␤').replace(/\t/g, '␉')
}

/** Official `Ne(f) = Ky(Vc(f))`. */
function formatToken(raw: string): string {
  return wrapInBackticks(visualizeWhitespace(raw))
}

/**
 * Defensively extract the save error from a sandbox-adapter result.
 * Success shapes: undefined (current Promise<void> API), null, an object
 * without `.error`, or `{error: null}`. Anything else is a failure.
 */
export function extractSandboxSaveError(result: unknown): Error | null {
  if (result === null || result === undefined) return null
  if (typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  if (error === null || error === undefined) return null
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Port of the official `v({error}, successText)` failure branch: the honest
 * "nothing changed" message with the settings path and the failure reason.
 */
export function formatSandboxSaveFailure(error: unknown): string {
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause : error
  const errno = getErrnoCode(cause)
  const settingsPath =
    getSettingsFilePathForSource('localSettings') ?? FALLBACK_SETTINGS_PATH
  const hint =
    errno !== undefined && WRITE_FAILURE_ERRNO_CODES.has(errno)
      ? WRITE_FAILURE_HINT
      : ''
  const reason = errno ?? (cause instanceof Error ? cause.message : String(cause))
  return `${SANDBOX_SETTINGS_NOT_CHANGED_PREFIX}${formatToken(settingsPath)} couldn't be updated (${formatToken(reason)}).${hint}`
}

/**
 * Full official `v()` semantics: success text when the save succeeded,
 * the ✗ "Sandbox settings not changed" message when it failed.
 */
export function formatSandboxSaveResult(
  result: unknown,
  successText: string,
): string {
  const error = extractSandboxSaveError(result)
  if (error === null) return successText
  return formatSandboxSaveFailure(error)
}
