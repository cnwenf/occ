/**
 * CC 2.1.277 C7: "Fixed an issue where a malformed claudeAiMcpEverConnected
 * value in ~/.claude.json crashed /mcp and /plugin manage with a Type error."
 * A hand-edited/corrupted value (`{}`, a number, a bare string, mixed arrays)
 * previously reached `.includes` / spread and threw a TypeError.
 *
 * Official v277 mechanism (byte-verified @0xbd3aeef in the v277 ELF) — the
 * field is a string[] (NOT a Record; the report sketch was wrong), guarded by
 * an accessor over the shared `fa` normalizer:
 *
 *   function LMe(e){return fa(e.claudeAiMcpEverConnected)}
 *
 * Consumers (byte-verified):
 *   - `k2t(e){return LMe(ae()).includes(e)}`        — hasEverConnected read
 *   - `A2t(){return new Set(LMe(ae()))}`            — bulk set read
 *   - `Z5e` mark: `ke((r)=>{let s=LMe(r);if(s.includes(e))return r;
 *     return{...r,claudeAiMcpEverConnected:[...s,e]}},n)` — the write path
 *     normalizes BEFORE merging, so a malformed value self-heals on persist.
 *
 * Follows the OCC-130 normalize-on-read pattern established by
 * utils/mcpNeedsAuthNotice.ts.
 */
import { normalizeConfigStringArray } from './configStringArray.js'

/** Structural config view — persisted value may be any malformed shape. */
export type ConfigWithClaudeAiMcpEverConnected = {
  claudeAiMcpEverConnected?: unknown
}

/**
 * Official `LMe` — the ever-connected list, normalized: non-array → [];
 * all-strings array → unchanged (identity fast path); mixed array → string
 * entries only. Never throws.
 */
export function claudeAiMcpEverConnectedOf(
  config: ConfigWithClaudeAiMcpEverConnected,
): string[] {
  return normalizeConfigStringArray(config.claudeAiMcpEverConnected)
}
