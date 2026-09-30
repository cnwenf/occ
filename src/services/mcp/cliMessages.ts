/**
 * CC 2.1.285 — CLI display sanitizer + `mcp` not-found message builders.
 *
 * Byte-verified port from the official 2.1.285 linux-x64 ELF:
 *   - `Tn` @195723710 (v284 @197882531 named `Rn` — helper pre-exists; what
 *     is NEW in 2.1.285 are the mcp-CLI call sites):
 *       function Tn(e){return e.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu," ")}
 *     applied by `claude mcp list` (row pipeline `d.map(Fe).filter(Fr).map(Tn)`)
 *     and `claude mcp get` (v284 `M.join("\n")` → v285 `R.map(Tn).join("\n")`)
 *     and inside every not-found builder below.
 *   - `iQn` @231333109 region (v284 counterpart `wQn` @234837544 region —
 *     templates IDENTICAL between versions; v285 only adds the `Tn` mapping):
 *       function iQn(t,n){let e=Tn(t),r=n.map(Tn).sort(),
 *         s=c7(e,r.map((d)=>({name:d})),{maxEditDistance:2});
 *         if(s)return`No MCP server named "${e}". Did you mean "${s}"? ...`
 *         ...cap 8 with " (and ${r.length-o} more — run `claude mcp list` ...)"}
 *   - `u2t` @231333600 region (v284 counterpart `Czt` — same template, no Tn):
 *     the pending-`.mcp.json`-approval variant used by get/login/logout.
 *   - fuzzy matcher `c7` + Damerau-Levenshtein `rY` @196259522 region —
 *     byte-identical in BOTH versions (4 `maxEditDistance` hits each), so the
 *     matcher is replicated here unchanged.
 *
 * Call-site map (v285): `mcp get`/`mcp login`/`mcp logout` not-found use
 * `u2t(name, configuredNames, hasPending)`; `mcp remove` not-found uses
 * `iQn(name, dedupe(localNames+projectNames+userNames))`.
 *
 * Branding: per OCC convention (see mcp.tsx `occ mcp add` / `occ mcp remove`
 * hints), command names inside user-facing strings are rebranded
 * `claude` → `occ`; every other character (wording, em-dash —,
 * backticks, the cap of 8) is byte-identical to the binary.
 */

/**
 * Binary `Tn` — collapse runs of control/format characters (plus the JS
 * line/paragraph separators U+2028/U+2029, which terminals render
 * unpredictably) into a single space, so a hostile server name or config
 * value cannot inject line breaks or ANSI escape sequences into
 * `claude mcp list` / `claude mcp get` / not-found output.
 */
export function sanitizeMcpCliText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
}

/** Binary cap `let o=8` inside `iQn`: at most 8 configured names listed. */
const MAX_CONFIGURED_NAMES_SHOWN = 8

/** Binary `maxEditDistance:2` at the `iQn` → `c7` call site. */
const NOT_FOUND_MAX_EDIT_DISTANCE = 2

/** Binary pending-approval note inside `u2t` (rebranded `claude` → `occ`). */
const PENDING_APPROVAL_NOTE =
  '.mcp.json servers are awaiting approval — run `occ` in this directory to review them.'

/**
 * Binary `rY` — Damerau-Levenshtein distance (full matrix + adjacent
 * transposition at cost 1). Byte-faithful replication; identical in the
 * 2.1.284 and 2.1.285 binaries.
 */
function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  const aLen = a.length
  const bLen = b.length
  const matrix = Array.from({ length: aLen + 1 }, (_, i) =>
    Array.from({ length: bLen + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  )
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      )
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + 1)
      }
    }
  }
  return matrix[aLen]![bLen]!
}

/**
 * Binary `c7` specialized to the `iQn` call site (names only — the builder
 * passes `{name}` objects, never aliases): skip candidates whose length
 * differs by more than `maxEditDistance`, then keep the STRICTLY lowest
 * distance (first wins ties). Returns undefined when nothing is within
 * the budget.
 */
function findClosestServerName(
  query: string,
  names: string[],
  maxEditDistance: number,
): string | undefined {
  let best: string | undefined
  let bestDistance = maxEditDistance + 1
  for (const name of names) {
    if (Math.abs(name.length - query.length) > maxEditDistance) continue
    const distance = damerauLevenshteinDistance(query, name)
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/**
 * Binary `iQn` — plain not-found builder used by `claude mcp remove`.
 * Both the queried name and every configured name pass through `Tn`
 * (2.1.285 fix), names are sorted, a fuzzy match within edit distance 2
 * yields the "Did you mean" variant, and the enumeration caps at 8.
 */
export function mcpServerNotFoundMessage(
  name: string,
  configuredNames: string[],
): string {
  const sanitized = sanitizeMcpCliText(name)
  const names = configuredNames.map(sanitizeMcpCliText).sort()
  const suggestion = findClosestServerName(
    sanitized,
    names,
    NOT_FOUND_MAX_EDIT_DISTANCE,
  )
  if (suggestion) {
    return `No MCP server named "${sanitized}". Did you mean "${suggestion}"? Run \`occ mcp list\` to see all.`
  }
  if (names.length === 0) {
    return `No MCP server named "${sanitized}". Run \`occ mcp add\` to add one.`
  }
  const shown = names.slice(0, MAX_CONFIGURED_NAMES_SHOWN).join(', ')
  const overflow =
    names.length > MAX_CONFIGURED_NAMES_SHOWN
      ? ` (and ${names.length - MAX_CONFIGURED_NAMES_SHOWN} more — run \`occ mcp list\` to see all)`
      : ''
  return `No MCP server named "${sanitized}". Configured servers: ${shown}${overflow}`
}

/**
 * Binary `u2t` — pending-approval-aware not-found builder used by
 * `claude mcp get` / `login` / `logout`. When `.mcp.json` servers are
 * awaiting approval: with no other configured names the note stands
 * alone after the sentence; otherwise it is appended parenthesized to
 * the `iQn` message.
 */
export function mcpServerNotFoundMessageWithPending(
  name: string,
  configuredNames: string[],
  hasPendingApproval: boolean,
): string {
  if (hasPendingApproval && configuredNames.length === 0) {
    return `No MCP server named "${sanitizeMcpCliText(name)}". ${PENDING_APPROVAL_NOTE}`
  }
  return (
    mcpServerNotFoundMessage(name, configuredNames) +
    (hasPendingApproval ? ` (${PENDING_APPROVAL_NOTE})` : '')
  )
}
