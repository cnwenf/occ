/**
 * CC 2.1.299 (#017): "Added `/usage` warnings for max effort, workflows,
 * always-on context and large tool results."
 *
 * Byte-exact port of the official behavior-warning catalog + formatters.
 * Forensics (v299 ELF, /tmp/cc-diff-299 — offsets into package/claude):
 *   - Catalog `S` @237017933: 9 keys. v296's catalog (@228835711) had only
 *     5 (cache_miss, long_context, subagent_heavy, high_parallel, cron) —
 *     the 4 new keys (max_effort, workflow, always_on_context,
 *     large_tool_results) ARE the #017 delta.
 *   - `AKr=10` @236999598 (v296 `Djr=10` @228817688) — a behavior is only
 *     shown when it accounts for >=10% of weighted usage cost.
 *   - Window formatter `d(s,e)`: header `${s} · ${reqs} · ${sessions}`
 *     ("·" = U+00B7), behavior rows indented 2 spaces, then the Top lists.
 *   - Top-list formatter `m(s,e,n)`: `g=8` cap, `, +N more` overflow.
 *   - `formatBehaviors` (`_`): heading `y`, disclaimer, then the non-null
 *     "Last 24h" / "Last 7d" windows joined by a blank line; null when
 *     both windows render nothing.
 */

/**
 * Official `I(count, noun)` — singular/plural helper. Inlined (identical to
 * utils/oauthLoginExpiry.pluralize) so this module keeps ZERO runtime
 * imports: oauthLoginExpiry pulls auth.js at runtime, which collides with
 * mock.module-based tests of the /usage command (OCC-97 mock leakage).
 */
function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

/** Behavior keys, in the official catalog's declaration order (S @237017933). */
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

/** Official `S` @237017933 — byte-exact warning templates keyed by behavior. */
export const BEHAVIOR_WARNING_TEMPLATES: Record<
  BehaviorKey,
  (pct: number) => string
> = {
  cache_miss: (s) => `${s}% of your usage hit a >100k-token cache miss`,
  long_context: (s) => `${s}% of your usage was at >150k context`,
  subagent_heavy: (s) =>
    `${s}% of your usage came from subagent-heavy sessions`,
  high_parallel: (s) =>
    `${s}% of your usage was while 4+ sessions ran in parallel`,
  cron: (s) => `${s}% of your usage came from sessions active for 8+ hours`,
  // The four keys new in 2.1.299 (#017):
  max_effort: (s) => `${s}% of your usage was at max effort`,
  workflow: (s) => `${s}% of your usage came from workflows`,
  always_on_context: (s) =>
    `${s}% of your usage went to always-on context over 40k tokens`,
  large_tool_results: (s) =>
    `${s}% of your usage went to tool results over 10k tokens`,
}

/** Official `y` — the behaviors section heading. */
export const LIMITS_USAGE_HEADING = "What's contributing to your limits usage?"

/** Official disclaimer line inside `_` (formatBehaviors). */
export const BEHAVIORS_DISCLAIMER =
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.'

/** Official `AKr=10` @236999598 — minimum pct for a behavior to be shown. */
export const BEHAVIOR_PCT_THRESHOLD = 10

/** Official `g=8` — cap on entries per Top list before `+N more`. */
export const TOP_LIST_CAP = 8

/** Official behavior pct payload (output of `h`, input of `d`). */
export interface BehaviorWindowPcts {
  request_count: number
  session_count: number
  behaviors: Array<{ key: BehaviorKey; pct: number; count: number }>
  agents: Array<{ name: string; pct: number }>
  skills: Array<{ name: string; pct: number }>
  plugins: Array<{ name: string; pct: number }>
  mcp_servers: Array<{ name: string; pct: number }>
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

/** Official `d(s,e)` — one time window's rendered block, or null. */
export function formatWindow(
  label: string,
  window: BehaviorWindowPcts,
): string | null {
  const behaviors = window.behaviors.filter(
    (r) => r.pct >= BEHAVIOR_PCT_THRESHOLD,
  )
  const topLists = [
    formatTopList('Top skills', window.skills, (r) => `/${r}`),
    formatTopList('Top subagents', window.agents),
    formatTopList('Top plugins', window.plugins),
    formatTopList('Top MCP servers', window.mcp_servers),
  ].filter((r) => r !== null)
  if (behaviors.length === 0 && topLists.length === 0) return null
  const requests = `${window.request_count} ${pluralize(window.request_count, 'request')}`
  const sessions = `${window.session_count} ${pluralize(window.session_count, 'session')}`
  return [
    `${label} · ${requests} · ${sessions}`,
    ...behaviors.map((r) => `  ${BEHAVIOR_WARNING_TEMPLATES[r.key](r.pct)}`),
    ...topLists.map((r) => `  ${r}`),
  ].join('\n')
}

/** Official `_` (formatBehaviors) — the whole section, or null. */
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
