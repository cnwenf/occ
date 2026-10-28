import { createHash } from 'node:crypto'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { normalizeConfigStringArray } from '../configStringArray.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'

/**
 * CC 2.1.305 — startup permission-warning routing (official 2.1.305 fix:
 * "startup warnings go to the debug log instead of raw text above the logo"
 * in interactive sessions; permission rules that restrict nothing surface as
 * warning rows under the banner).
 *
 * All shapes below are byte-verified against the official v306 binary:
 *  - `fd` @238646126 — `bE(R_(e)).replace(/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,"")`
 *    (R_ ≡ strip-ansi; bE ≡ String coercion).
 *  - `vn` @237692316 — `e.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu," ")`.
 *  - `Zo` @257109508 — `vn(fd(e)).trim()` (single sanitized line).
 *  - `UB` @242376611 — `process.stderr.write(he.yellow(fd(r))+"\n")`
 *    (he ≡ chalk) — the yellow stderr writer (v304 `_v` equivalent).
 *  - `cz` @257109508 — builds `[Zo(e), ...items.map(u=>`  - ${Zo(u)}`)].join("\n")`
 *    then `if(_e()){UB(o+r);return}t(r,{level:"warn"})` (_e ≡ non-interactive
 *    check, t ≡ debug-log writer). This module only needs the default
 *    `{stderrPrefix:"",items:[]}` shape used by the permission-warning site.
 *  - emission gate @257152404 —
 *    `(!_e()||L!=="json"&&L!=="stream-json"&&a.CLAUDE_CODE_SESSION_KIND!=="bg")
 *       ? (hs.forEach(s=>cz(s)), rs.push(...D(Lo.securityWarnings.map(Zo))))
 *       : hs.forEach(s=>t(`[permissions] ${fd(s)}`,{level:"warn"}))`
 *    (D ≡ dedupe; rs ≡ banner rows).
 */

/** Official `fd` — strip ANSI escapes, then drop control/format chars except \t and \n. */
export function sanitizeWarningText(text: string): string {
  return stripAnsi(String(text)).replace(
    /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    '',
  )
}

/** Official `Zo` — one sanitized, single-spaced, trimmed line. */
export function formatSecurityWarningRow(row: string): string {
  return sanitizeWarningText(row)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .trim()
}

/** Official `UB` — yellow stderr writer (headless print-text path). */
export function writeWarningToStderr(message: string): void {
  process.stderr.write(`${chalk.yellow(sanitizeWarningText(message))}\n`)
}

export type StartupWarningChannel =
  | 'debug-log'
  | 'stderr'
  | 'permissions-debug-log'

/**
 * CC 2.1.311 Item 70 — startup permission warnings shown once per user.
 * Official shapes byte-verified against the v311 binary:
 *  - `var a=256` @258610748 — cap on the persisted seen-list.
 *  - `xvs` @258610758 — filter:
 *    `function xvs(e){let n=new Set(yi(ue().seenSecurityWarnings));
 *     return e.filter((r)=>r.seenKey===void 0||!n.has(r.seenKey))}`
 *    (yi ≡ the string-array normalizer OCC shares as
 *    `normalizeConfigStringArray`; ue ≡ getGlobalConfig).
 *  - `Pvs` @258610879 — mark-seen:
 *    `function Pvs(e,n){if(e.length===0)return;xe((r)=>{let
 *     i=yi(r.seenSecurityWarnings),o=new Set(i),t=L(e).filter((s)=>!o.has(s));
 *     if(t.length===0)return r;return{...r,seenSecurityWarnings:
 *     [...i,...t].slice(-a)}})}` (L ≡ `[...new Set(e)]` @238678950-region;
 *    `slice(-a)` keeps the NEWEST 256 keys — oldest entries are evicted).
 *  - `fe` @256832132 —
 *    `function fe(e){return xe("sha256").update(e.join("\n")).digest("hex")}`
 *    (xe ≡ node:crypto createHash).
 *  - seenKey builder `oe` @256851566 —
 *    `{text:o,seenKey:fe([e.source,n,o])}` where n is the settings file path
 *    for the rule's source.
 *  - emission site @258740951 —
 *    `_s.push(...xvs(Wo.securityWarnings.map((s)=>({...s,text:pn(s.text)}))))`
 *    — the text is sanitized at emission but the seenKey hashes the RAW text.
 *  - `RI`/`bl` @273602023/@273602551 — the banner render effect collects
 *    `K.seenKey===void 0?[]:[K.seenKey]` per row and calls `Pvs` once the
 *    rows are actually on screen.
 *  - config key `seenSecurityWarnings` @116993972/@241899727 (v310: 0 hits —
 *    new in 2.1.311).
 */

/** Official `a` (@258610748) — cap on the persisted seen-key list. */
export const SEEN_SECURITY_WARNINGS_CAP = 256

/** Official v311 row shape: `{text, seenKey?}` (seenKey absent pre-2.1.311). */
export type StartupSecurityWarningRow = {
  text: string
  seenKey?: string
}

/** Input accepted by the router: legacy plain strings or v311 row objects. */
export type SecurityWarningInput =
  | string
  | (StartupSecurityWarningRow & {
      /** Rule source; combined with settingsPath+text into the seenKey. */
      source?: string
      /** Settings file path the rule came from (official `un(source)`). */
      settingsPath?: string
    })

/** Official `fe` (@256832132) — sha256 hex of the parts joined by newline. */
export function buildSecurityWarningSeenKey(parts: {
  source: string
  settingsPath: string
  text: string
}): string {
  return createHash('sha256')
    .update([parts.source, parts.settingsPath, parts.text].join('\n'))
    .digest('hex')
}

/** Official `oe` seenKey branch (@256851566) — row with a persisted-dedup key. */
export function buildSecurityWarningRow(input: {
  source: string
  settingsPath: string
  text: string
}): StartupSecurityWarningRow {
  return { text: input.text, seenKey: buildSecurityWarningSeenKey(input) }
}

/** Normalize a router input into the official `{text, seenKey?}` row shape. */
function toSecurityWarningRow(
  input: SecurityWarningInput,
): StartupSecurityWarningRow {
  if (typeof input === 'string') return { text: input }
  if (input.seenKey !== undefined) {
    return { text: input.text, seenKey: input.seenKey }
  }
  if (input.source !== undefined && input.settingsPath !== undefined) {
    return buildSecurityWarningRow({
      source: input.source,
      settingsPath: input.settingsPath,
      text: input.text,
    })
  }
  return { text: input.text }
}

function readPersistedSeenKeys(): string[] {
  try {
    const config = getGlobalConfig() as unknown as {
      seenSecurityWarnings?: unknown
    }
    return normalizeConfigStringArray(config.seenSecurityWarnings)
  } catch (error) {
    // Fail open: an unreadable config must never hide security warnings.
    logForDebugging(
      `Failed to read seenSecurityWarnings: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    return []
  }
}

/** Official `xvs` (@258610758) — drop rows whose seenKey was already shown. */
export function filterUnseenSecurityWarnings(
  rows: readonly StartupSecurityWarningRow[],
): StartupSecurityWarningRow[] {
  const seen = new Set(readPersistedSeenKeys())
  return rows.filter(
    row => row.seenKey === undefined || !seen.has(row.seenKey),
  )
}

/** Official `Pvs` (@258610879) — persist the seenKeys of shown rows, capped. */
export function markSecurityWarningsSeen(
  rows: readonly StartupSecurityWarningRow[],
): void {
  if (rows.length === 0) return
  const keys = [...new Set(rows.flatMap(row => (row.seenKey === undefined ? [] : [row.seenKey])))]
  try {
    saveGlobalConfig(current => {
      const persisted = normalizeConfigStringArray(
        (current as unknown as { seenSecurityWarnings?: unknown })
          .seenSecurityWarnings,
      )
      const persistedSet = new Set(persisted)
      const fresh = keys.filter(key => !persistedSet.has(key))
      if (fresh.length === 0) return current
      return {
        ...current,
        seenSecurityWarnings: [...persisted, ...fresh].slice(
          -SEEN_SECURITY_WARNINGS_CAP,
        ),
      } as typeof current
    })
  } catch (error) {
    logForDebugging(
      `Failed to persist seenSecurityWarnings: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Official emission gate @257152404 + the `_e()` branch inside `cz`:
 *  - interactive TTY → debug log (the 2.1.305 fix — nothing raw above logo),
 *  - headless print-text (not json/stream-json, not bg session) → yellow stderr,
 *  - headless json/stream-json/bg → `[permissions] `-prefixed debug-log lines.
 */
export function resolveStartupWarningChannel(opts: {
  isNonInteractiveSession: boolean
  outputFormat: string | undefined
  sessionKind: string | undefined
}): StartupWarningChannel {
  const { isNonInteractiveSession, outputFormat, sessionKind } = opts
  if (
    !isNonInteractiveSession ||
    (outputFormat !== 'json' &&
      outputFormat !== 'stream-json' &&
      sessionKind !== 'bg')
  ) {
    return isNonInteractiveSession ? 'stderr' : 'debug-log'
  }
  return 'permissions-debug-log'
}

/**
 * The full official emission site: routes every startup warning through the
 * `cz`-equivalent and returns the deduped, single-line `securityWarnings`
 * banner rows (empty on the json/stream-json/bg branch — the official only
 * pushes `rs` rows in the first branch).
 *
 * CC 2.1.311 Item 70: banner rows are `{text, seenKey}` — the seenKey hashes
 * the RAW text (@258740951 sanitizes via `pn` AFTER the key was built), rows
 * whose seenKey is already persisted are filtered before emission (official
 * `xvs`), and the surviving rows' keys are marked seen after (official `Pvs`,
 * which the banner render effect fires once rows are on screen — OCC's router
 * is the emission point, so mark-seen happens here on the returned rows).
 */
export function routeStartupPermissionWarnings(opts: {
  warnings: string[]
  securityWarnings: SecurityWarningInput[]
  isNonInteractiveSession: boolean
  outputFormat: string | undefined
  sessionKind: string | undefined
}): string[] {
  const channel = resolveStartupWarningChannel(opts)
  if (channel === 'permissions-debug-log') {
    for (const warning of opts.warnings) {
      logForDebugging(`[permissions] ${sanitizeWarningText(warning)}`, {
        level: 'warn',
      })
    }
    return []
  }
  for (const warning of opts.warnings) {
    const row = formatSecurityWarningRow(warning)
    if (channel === 'stderr') {
      writeWarningToStderr(row)
    } else {
      logForDebugging(row, { level: 'warn' })
    }
  }
  const rows = filterUnseenSecurityWarnings(
    opts.securityWarnings.map(toSecurityWarningRow),
  )
  markSecurityWarningsSeen(rows)
  return [
    ...new Set(rows.map(securityWarning =>
      formatSecurityWarningRow(securityWarning.text),
    )),
  ]
}
