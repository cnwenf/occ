import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
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
 */
export function routeStartupPermissionWarnings(opts: {
  warnings: string[]
  securityWarnings: string[]
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
  return [...new Set(opts.securityWarnings.map(formatSecurityWarningRow))]
}
