import { getFlagSettingsPath } from 'src/bootstrap/state.js'

import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import { getSettingsWithErrors } from './settings/settings.js'
import type { ValidationError } from './settings/validation.js'
import { logForDebugging } from './debug.js'

/**
 * CC 2.1.299 (#076): "Fixed `claude -p` saying nothing when a settings file
 * fails validation: text-output runs now list the file and the invalid entry
 * on stderr."
 *
 * Official v299-NEW function `jR(outputFormat)` (byte-verified @250480040 in
 * /tmp/cc-diff-299/v299/package/claude; ALL of its user-facing strings have
 * 0 hits in v296), called as `jR(P.outputFormat)` at the top of the print-run
 * entry (`fxe` @250567560). Verbatim shape:
 *
 *   var wh=10,lL=500;
 *   function jR(e){let n=$hn(xm().errors);if(n.length===0)return;
 *     let r=new Set([...aS(),...WVn()].map(NR)),s=n.filter((w)=>!r.has(NR(w)));
 *     if(s.length===0)return;
 *     let h=new Set(s.filter((w)=>w.severity!=="warning").map((w)=>w.file)),
 *         S=s.filter((w)=>h.has(w.file)),y=s.filter((w)=>!h.has(w.file));
 *     if(Fhn(s),i("tengu_own_settings_validation_errors",
 *        {not_loaded_file_count:h.size,skipped_entry_count:y.length}),
 *        e==="json"||e==="stream-json")return;
 *     let R=[];
 *     if(S.length>0)R.push(`These settings files did not load, ...:\n${qR(S)}`);
 *     if(y.length>0)R.push(`These settings entries were skipped ...:\n${qR(y)}`);
 *     process.stderr.write(`${R.join("\n")}\n`)}
 *
 * Semantics:
 * - `$hn` filter (chunk-n2jwgevn, identical in v296): drop MCP errors,
 *   `statusOnly` notices and `startupFatal` records (those surface elsewhere).
 * - Grouping: files with at least one non-warning error did NOT load at all
 *   (group S — "nothing in them is in effect"); remaining entries (files
 *   whose only records are warnings) were skipped individually (group y).
 * - `Fhn` per-entry debug log (verbatim message, level error) and the
 *   `tengu_own_settings_validation_errors` telemetry fire for EVERY output
 *   format; the stderr write is suppressed for json/stream-json so
 *   machine-readable runs stay clean.
 * - `qR` entry lines: `  <file> (<path>): <message>`, max `wh`=10 entries per
 *   group then `  … and N more`; every field sanitized through the official
 *   `Ks(w,{maxCodeUnits:lL=500})` (collapse whitespace, trim, surrogate-safe
 *   code-unit truncation @214767645/@214788022).
 * - Errors whose file equals the `--settings` flag path render as
 *   `--settings (inline JSON)` (official `Ww()===void 0?void 0:BC()`).
 *
 * Documented divergences (KISS):
 * - Official `jR` runs per-turn inside the query runner and dedups against
 *   errors already shown via dialog/startup notices (`aS()`/`WVn()`). OCC
 *   calls this ONCE from the automated-session startup branch (main.tsx),
 *   where no dialog or notice has run, so the dedup set would always be
 *   empty — it is omitted.
 * - Official `Ks` also strips invisible Unicode via the shared sanitizer;
 *   OCC applies the whitespace-collapse + truncation parts only (fields are
 *   our own validation strings).
 */

/** Official `wh` — max entries listed per group before "… and N more". */
export const MAX_REPORTED_ENTRIES_PER_GROUP = 10

/** Official `lL` — max code units per rendered field. */
export const MAX_FIELD_CODE_UNITS = 500

/** Official `$hn`: errors eligible for the automated-session report. */
export function filterReportableSettingsErrors(
  errors: ValidationError[],
): ValidationError[] {
  return errors.filter(
    e => !e.mcpErrorMetadata && !e.statusOnly && !e.startupFatal,
  )
}

/** Official `NR`: identity key used for dedup and grouping. */
export function settingsErrorKey(e: ValidationError): string {
  return `${e.file}:${e.path}:${e.message}`
}

/**
 * Official field sanitizer `Ks(w,{maxCodeUnits:500})`: collapse whitespace
 * to single spaces, trim, then truncate to 500 code units without splitting
 * a surrogate pair (official `ne` @214767645).
 */
export function sanitizeSettingsField(value: unknown): string {
  let result = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (result.length > MAX_FIELD_CODE_UNITS) {
    result = result.slice(0, MAX_FIELD_CODE_UNITS)
    const lastUnit = result.charCodeAt(MAX_FIELD_CODE_UNITS - 1)
    // A trailing high surrogate means the cut split a pair — drop it.
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      result = result.slice(0, -1)
    }
    result = result.trim()
  }
  return result
}

/** Official `qR`: indented entry lines with the inline-JSON file label. */
export function formatInvalidSettingsEntries(
  entries: ValidationError[],
  inlineSettingsPath: string | undefined = getFlagSettingsPath(),
): string {
  const lines = entries.slice(0, MAX_REPORTED_ENTRIES_PER_GROUP).map(e => {
    const fileLabel =
      e.file !== undefined && e.file === inlineSettingsPath
        ? '--settings (inline JSON)'
        : (e.file ?? 'settings')
    const [file, path, message] = [fileLabel, e.path, e.message].map(
      sanitizeSettingsField,
    )
    return `  ${file}${path ? ` (${path})` : ''}: ${message}`
  })
  if (entries.length > MAX_REPORTED_ENTRIES_PER_GROUP) {
    lines.push(
      `  … and ${entries.length - MAX_REPORTED_ENTRIES_PER_GROUP} more`,
    )
  }
  return lines.join('\n')
}

/** Official `Fhn`: per-entry debug log, verbatim message and level. */
export function logInvalidSettingsSkipped(entries: ValidationError[]): void {
  for (const e of entries) {
    logForDebugging(
      `Invalid setting skipped without dialog (automated session): ${e.file ?? 'settings'}: ${e.path}: ${e.message}`,
      { level: 'error' },
    )
  }
}

export type InvalidSettingsReportDeps = {
  getErrors?: () => ValidationError[]
  getInlineSettingsPath?: () => string | undefined
  writeStderr?: (text: string) => void
}

/**
 * Official `jR(outputFormat)` — automated-session report. Debug-logs every
 * skipped entry and emits telemetry regardless of output format; writes the
 * human-readable list to stderr only for text-output runs (never json or
 * stream-json).
 */
export function reportInvalidSettingsForAutomatedSession(
  outputFormat: string | undefined,
  deps: InvalidSettingsReportDeps = {},
): void {
  const getErrors = deps.getErrors ?? (() => getSettingsWithErrors().errors)
  const getInlinePath = deps.getInlineSettingsPath ?? getFlagSettingsPath
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text))

  const reportable = filterReportableSettingsErrors(getErrors())
  if (reportable.length === 0) {
    return
  }
  const notLoadedFiles = new Set(
    reportable.filter(e => e.severity !== 'warning').map(e => e.file),
  )
  const notLoadedEntries = reportable.filter(e => notLoadedFiles.has(e.file))
  const skippedEntries = reportable.filter(e => !notLoadedFiles.has(e.file))

  logInvalidSettingsSkipped(reportable)
  logEvent('tengu_own_settings_validation_errors', {
    not_loaded_file_count:
      notLoadedFiles.size as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    skipped_entry_count:
      skippedEntries.length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  if (outputFormat === 'json' || outputFormat === 'stream-json') {
    return
  }
  const inlineSettingsPath = getInlinePath()
  const blocks: string[] = []
  if (notLoadedEntries.length > 0) {
    blocks.push(
      `These settings files did not load, so nothing in them is in effect, including hooks and permission rules. Each loads again once the problem listed for it is fixed:\n${formatInvalidSettingsEntries(notLoadedEntries, inlineSettingsPath)}`,
    )
  }
  if (skippedEntries.length > 0) {
    blocks.push(
      `These settings entries were skipped because this version of Claude Code can't apply them; the rest of each file is in effect:\n${formatInvalidSettingsEntries(skippedEntries, inlineSettingsPath)}`,
    )
  }
  if (blocks.length > 0) {
    writeStderr(`${blocks.join('\n')}\n`)
  }
}
