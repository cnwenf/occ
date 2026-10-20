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
 *
 * CC 2.1.304 (#49 — official `JC`, byte-verified @273485431 region):
 * "Improved the `claude -p` invalid-settings warning: a file that did not
 * load lists only what stopped it, and long lists are capped per file."
 * - Grouping changed: `h=s.filter(w=>w.severity!=="warning")` — the
 *   did-not-load block now lists ONLY the blocking entries themselves (the
 *   303 shape listed ALL entries of the failed files);
 *   `S=new Set(h.map(w=>w.file))`; `y=s.filter(w=>!S.has(w.file))`.
 * - Formatter `YC` replaces `CC`: entries are grouped BY FILE (official
 *   `Map.groupBy(e,h=>h.file)`; OCC uses a manual Map for target
 *   compatibility), each file's group capped at `Zh`=10 lines, overflow
 *   `  … and ${n} more in ${file}` (the 303 cap was per whole group with
 *   `  … and ${n} more`).
 * - Skipped-entries header shortened to `These settings entries were
 *   skipped; the rest of each file is in effect:` (the long 303 text has 0
 *   hits in the 304 binary).
 * - Telemetry (`tengu_own_settings_validation_errors`,
 *   not_loaded_file_count/skipped_entry_count), the per-entry debug log, the
 *   json/stream-json stderr suppression, the inline-JSON file label and the
 *   `Ks` sanitizer are all unchanged.
 */

/**
 * Official `wh` (303) / `Zh` (304) — since #49 the cap applies PER FILE
 * group, overflow line `  … and N more in <file>`.
 */
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

/**
 * Official `YC` (304): indented entry lines with the inline-JSON file label,
 * GROUPED BY FILE. Each file's group is capped at
 * `MAX_REPORTED_ENTRIES_PER_GROUP`(=10) lines; overflow renders
 * `  … and N more in <file>`. The official uses `Map.groupBy(e,h=>h.file)`;
 * OCC uses a manual Map for target compatibility (Map.groupBy is ES2024).
 * Grouping is on the RENDERED label so the overflow `in <file>` matches the
 * entry lines' label (only the single `--settings` flag path maps to the
 * inline-JSON label, so label-grouping ≡ file-grouping).
 */
export function formatInvalidSettingsEntries(
  entries: ValidationError[],
  inlineSettingsPath: string | undefined = getFlagSettingsPath(),
): string {
  const fileLabel = (e: ValidationError): string =>
    e.file !== undefined && e.file === inlineSettingsPath
      ? '--settings (inline JSON)'
      : (e.file ?? 'settings')

  // Group by rendered file label, preserving first-seen order.
  const groups = new Map<string, ValidationError[]>()
  for (const e of entries) {
    const label = fileLabel(e)
    const bucket = groups.get(label)
    if (bucket) bucket.push(e)
    else groups.set(label, [e])
  }

  const lines: string[] = []
  for (const [label, group] of groups) {
    for (const e of group.slice(0, MAX_REPORTED_ENTRIES_PER_GROUP)) {
      const [file, path, message] = [label, e.path, e.message].map(
        sanitizeSettingsField,
      )
      lines.push(`  ${file}${path ? ` (${path})` : ''}: ${message}`)
    }
    if (group.length > MAX_REPORTED_ENTRIES_PER_GROUP) {
      lines.push(
        `  … and ${group.length - MAX_REPORTED_ENTRIES_PER_GROUP} more in ${label}`,
      )
    }
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
  // CC 2.1.304 (#49 — official `JC`): the did-not-load block now lists ONLY
  // the blocking (non-warning) entries themselves — "what stopped the file
  // from loading" — not every entry of the failed files (the 303 shape).
  const notLoadedEntries = reportable.filter(e => e.severity !== 'warning')
  const notLoadedFiles = new Set(notLoadedEntries.map(e => e.file))
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
    // CC 2.1.304 (#49): header shortened — the long 303 text has 0 hits in
    // the 304 binary. Verbatim official string.
    blocks.push(
      `These settings entries were skipped; the rest of each file is in effect:\n${formatInvalidSettingsEntries(skippedEntries, inlineSettingsPath)}`,
    )
  }
  if (blocks.length > 0) {
    writeStderr(`${blocks.join('\n')}\n`)
  }
}
