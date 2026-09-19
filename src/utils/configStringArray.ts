/**
 * CC 2.1.277 (C2/C7): the official binary shares ONE string-array normalizer
 * (`fa`, byte-verified @0xb7256bf in the v277 ELF) across every persisted
 * string[] config field that gained a malformed-value guard:
 *
 *   function fa(n){if(!Array.isArray(n))return[];return n.every((e)=>
 *     typeof e==="string")?n:n.filter((e)=>typeof e==="string")}
 *
 * Consumers (byte-verified):
 *   - `HR`  customApiKeyResponsesOf  → {approved: fa(n?.approved),
 *                                        rejected: fa(n?.rejected)}
 *   - `LMe` claudeAiMcpEverConnectedOf → fa(e.claudeAiMcpEverConnected)
 *   - `pee` mcpNeedsAuthNoticed accessor (v276; OCC's copy lives in
 *     utils/mcpNeedsAuthNotice.ts as normalizeMcpNeedsAuthNoticed — the same
 *     body, kept there per the OCC-130 file layout).
 *
 * This module is the shared OCC copy for the 2.1.277 ports. Semantics are
 * byte-identical to the official `fa`: non-array → []; all-strings array →
 * returned UNCHANGED (identity fast path via `every`); mixed array → only
 * string entries kept (filter).
 */
export function normalizeConfigStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.every(entry => typeof entry === 'string')
    ? value
    : value.filter((entry): entry is string => typeof entry === 'string')
}
