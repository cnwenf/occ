/**
 * Official Claude Code 2.1.299 (#074): scheduled cron tools report the ACTUAL
 * next run time (cron expression + the scheduler's deterministic per-job
 * jitter offset), instead of only the human schedule string.
 *
 * Byte-exact ports from the v299 ELF (offsets into
 * /tmp/cc-diff-299/v299/package/claude):
 *
 *   `Oat` @223031378:
 *     `function Oat(e){return new Date(Math.round(e/60000)*60000)}`
 *   `Vke` @248814432:
 *     `function Vke(e,r){return e.toLocaleString("en-US",{month:"short",
 *       day:"numeric",...r?.includeYear&&{year:"numeric"},hour:"numeric",
 *       minute:"2-digit",timeZone:DUn()})
 *       .replace(/,? at |, (?=\d{1,2}:)/," ")
 *       .replace(/[ \u202f]([AP]M)/i,(o,t)=>t.toLowerCase())}`
 *   result-text fragment @248823098:
 *     `t=e.nextFireAt===void 0?"":` Next run: ${Vke(Oat(e.nextFireAt))}.``
 *   UI suffix `oT` @243490620 region:
 *     `function oT(m){let l=Oat(m??Number.NaN);return Number.isNaN(
 *       l.getTime())?"":`, next run ${NMe(l.toISOString())}`}`
 *
 * OCC deviations (documented, minimal):
 * - `DUn()` resolves an optional user timezone setting and falls back to the
 *   system zone; OCC has no timezone setting, so `getTimeZone()` (the system
 *   resolved zone) is passed — same observable output.
 * - `oT` feeds the official smart message-timestamp formatter `NMe`
 *   (today/week/older buckets driven by the date-display setting subsystem,
 *   which OCC does not have). This port formats the UI suffix with `Vke`
 *   instead — the same formatter the tool-result text uses.
 */

import { getTimeZone } from '../../utils/intl.js'

/** Official `Oat`: round epoch ms to the nearest whole minute. */
export function roundToMinute(epochMs: number): Date {
  return new Date(Math.round(epochMs / 60000) * 60000)
}

/** Official `Vke`: e.g. `Jan 15 2:30pm` (en-US, lowercase meridiem). */
export function formatNextRunDate(
  date: Date,
  opts?: { includeYear?: boolean },
): string {
  return date
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      ...opts?.includeYear && { year: 'numeric' },
      hour: 'numeric',
      minute: '2-digit',
      timeZone: getTimeZone(),
    })
    .replace(/,? at |, (?=\d{1,2}:)/, ' ')
    .replace(/[ \u202f]([AP]M)/i, (_match, meridiem: string) =>
      meridiem.toLowerCase(),
    )
}

/**
 * Official tool-result sentence fragment (CronCreate @248823098):
 * `` ` Next run: ${Vke(Oat(nextFireAt))}.` `` — empty when absent.
 */
export function nextRunSentence(nextFireAt: number | undefined): string {
  return nextFireAt === undefined
    ? ''
    : ` Next run: ${formatNextRunDate(roundToMinute(nextFireAt))}.`
}

/**
 * Official UI suffix (`oT`): `` `, next run ${NMe(Oat(m).toISOString())}` ``
 * — empty for undefined/NaN input (OCC adaptation: `Vke` in place of `NMe`,
 * see the header note).
 */
export function nextRunUiSuffix(nextFireAt: number | undefined): string {
  const rounded = roundToMinute(nextFireAt ?? Number.NaN)
  return Number.isNaN(rounded.getTime())
    ? ''
    : `, next run ${formatNextRunDate(rounded)}`
}
