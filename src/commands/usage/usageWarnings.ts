/**
 * CC 2.1.299 (#017): "Added `/usage` warnings for max effort, workflows,
 * always-on context and large tool results."
 * CC 2.1.305 (/usage item): "each warning is now a one-line fix that names
 * its source" — the v299 behavior-template rows are REPLACED by the
 * recommendation rows built in usageRecommendations.ts.
 *
 * Forensics (v306 ELF, /tmp/cc-diff-306 — offsets into package/claude):
 *   - v306 text formatter module @261447620, exports `{G as call, S as
 *     formatBehaviors, v as formatRateLimits}`. `S` (=formatBehaviors):
 *     `[heading, "Approximate · sessions on this machine only · shares
 *     overlap", "", windows.join("\n\n")].join("\n")` — the long v299
 *     disclaimer is GONE (0 hits in v306).
 *   - `h(label, window)` (=formatWindow): header
 *     `${label} · ${requests} · ${sessions}`, then recommendation rows
 *     `  ${String(pct).padStart(2)}%  ${title}${detail ? ` · ${detail}` : ""}`,
 *     then the Top lists. The v299 BEHAVIOR_WARNING_TEMPLATES strings
 *     (">100k-token cache miss" etc.) have 0 hits in v306 (3 in v304) —
 *     officially deleted, so they are removed here too.
 *   - `m(label, entries, prefix)` (=formatTopList): unchanged from v299 —
 *     `g=8` cap, `, +N more` overflow.
 *   - Heading `y` ("What's contributing to your limits usage?") unchanged.
 */
import type { UsageRecommendation } from './usageRecommendations.js'

/**
 * Official `I(count, noun)` — singular/plural helper. Inlined (identical to
 * utils/oauthLoginExpiry.pluralize) so this module keeps ZERO runtime
 * imports: oauthLoginExpiry pulls auth.js at runtime, which collides with
 * mock.module-based tests of the /usage command (OCC-97 mock leakage).
 */
function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

/** Behavior keys, in the official catalog's declaration order (S @237017933
 * in v299; still the accumulator key set in v306). */
export const BEHAVIOR_KEYS = [
  'cache_miss',
  'long_context',
  'subagent_heavy',
  'high_parallel',
  'cron',
  'max_effort',
  'workflow',
  'always_on_context',
  'large_tool_results',
] as const

export type BehaviorKey = (typeof BEHAVIOR_KEYS)[number]

/** Official `y` — the behaviors section heading. */
export const LIMITS_USAGE_HEADING = "What's contributing to your limits usage?"

/** Official v306 disclaimer line inside `S` (formatBehaviors) — verbatim.
 * Replaces the long v299 disclaimer (deleted upstream in v305). */
export const BEHAVIORS_DISCLAIMER =
  'Approximate · sessions on this machine only · shares overlap'

/** Official `P$e=10` — minimum pct for a behavior to be shown. */
export const BEHAVIOR_PCT_THRESHOLD = 10

/** Official `g=8` (`y` in the v306 formatter module) — Top-list cap. */
export const TOP_LIST_CAP = 8

/** Official behavior pct payload (v306: + the recommendation rows). */
export interface BehaviorWindowPcts {
  request_count: number
  session_count: number
  behaviors: Array<{ key: BehaviorKey; pct: number; count: number }>
  agents: Array<{ name: string; pct: number }>
  skills: Array<{ name: string; pct: number }>
  plugins: Array<{ name: string; pct: number }>
  mcp_servers: Array<{ name: string; pct: number }>
  /** CC 2.1.305: official `e.recommendations ?? []` rows. */
  recommendations?: UsageRecommendation[]
}

/** Official `m(s,e,n)` — `Top <label>: name pct%, ...` with `, +N more`. */
export function formatTopList(
  label: string,
  entries: Array<{ name: string; pct: number }>,
  namePrefix?: (name: string) => string,
): string | null {
  if (entries.length === 0) return null
  const shown = entries
    .slice(0, TOP_LIST_CAP)
    .map((i) => `${namePrefix ? namePrefix(i.name) : i.name} ${i.pct}%`)
    .join(', ')
  const overflow = entries.length - TOP_LIST_CAP
  return `${label}: ${shown}${overflow > 0 ? `, +${overflow} more` : ''}`
}

/** Official v306 `h(a,e)` — one time window's rendered block, or null. */
export function formatWindow(
  label: string,
  window: BehaviorWindowPcts,
): string | null {
  const recommendations = window.recommendations ?? []
  const topLists = [
    formatTopList('Top skills', window.skills, (r) => `/${r}`),
    formatTopList('Top subagents', window.agents),
    formatTopList('Top plugins', window.plugins),
    formatTopList('Top MCP servers', window.mcp_servers),
  ].filter((r) => r !== null)
  if (recommendations.length === 0 && topLists.length === 0) return null
  const requests = `${window.request_count} ${pluralize(window.request_count, 'request')}`
  const sessions = `${window.session_count} ${pluralize(window.session_count, 'session')}`
  return [
    `${label} · ${requests} · ${sessions}`,
    ...recommendations.map(
      (r) =>
        `  ${String(r.pct).padStart(2)}%  ${r.title}${r.detail ? ` · ${r.detail}` : ''}`,
    ),
    ...topLists.map((r) => `  ${r}`),
  ].join('\n')
}

/** Official `S` (formatBehaviors) — the whole section, or null. */
export function formatBehaviors(data: {
  day: BehaviorWindowPcts
  week: BehaviorWindowPcts
}): string | null {
  const windows = [
    formatWindow('Last 24h', data.day),
    formatWindow('Last 7d', data.week),
  ].filter((a) => a !== null)
  if (windows.length === 0) return null
  return [
    LIMITS_USAGE_HEADING,
    BEHAVIORS_DISCLAIMER,
    '',
    windows.join('\n\n'),
  ].join('\n')
}
