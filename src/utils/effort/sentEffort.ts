import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

/**
 * claude-code 2.1.312 items 9+16 — the "sentEffort" in-force effort state.
 *
 * Official v312 adds a `sentEffort` field to the per-agent turn-state store
 * (new-in-312, 0 hits in v311; byte-verified):
 *   - store default/reset (@259429372):
 *     `...turnEffort:null,turnModel:null,sentEffort:null,retryStatus:null,...`
 *   - setter (@259428400): `function h(r){g(t,(o)=>o.sentEffort===r?o:
 *     {...o,sentEffort:r})}` exposed as `setSentEffort`
 *   - stream handler populate (@277260243): on `message_start`
 *     `te.main.setSentEffort(h.sentEffort??null)`; on assistant message
 *     `if(h.effort!==void 0)te.main.setSentEffort(h.effort)`
 *   - query engine emit (@251161309): the message_start stream_event wrapper
 *     carries `...Yh!==void 0&&{sentEffort:Yh}` where `Yh` is the normalized
 *     `output_config.effort` of the request that was actually sent
 *     (`Yh=typeof My==="string"&&Fw(My)?My:void 0`).
 *
 * It records the effort level IN FORCE — what the model last applied — as
 * opposed to `turnEffort` (this turn's ultrathink boost) and the app-state
 * `effortValue` (the user's latest /effort pick, which mid-task has NOT been
 * applied yet). Changelog #9: the spinner / OTel effort values / transcripts
 * must show the level in force, not a newly picked level.
 *
 * OCC reduction: OCC has no per-agent turn-state store object, so the slot is
 * module-scoped — the exact pattern of the neighboring `turnEffort.ts`
 * (2.1.311 item 65). Official's store default and `resetOverrides` both hold
 * `null`, mirrored by `resetSentEffort()`. NAMING NOTE: this slot's reader is
 * `getSentEffort()` — deliberately distinct from effort.ts's pre-existing
 * `getSentEffortLevel()` (the official `kWe` display RESOLVER, CC 2.1.304
 * #35), which computes what WOULD be sent from configuration. Do not conflate.
 */

let currentSentEffort: EffortLevel | null = null

/** Official `setSentEffort(r)` — the level the model actually applied. */
export function setSentEffort(level: EffortLevel | null): void {
  currentSentEffort = level
}

/** Official read side of the turn-state store's `sentEffort` field. */
export function getSentEffort(): EffortLevel | null {
  return currentSentEffort
}

/**
 * Official store default / `resetOverrides()` (@259429372) both reset
 * `sentEffort:null` — new conversation / session start clears the in-force
 * level. Per-turn it is deliberately NOT cleared: the whole point of the 312
 * fix is that the surfaces keep showing the level in force until the model
 * applies a new one (the next message_start overwrites via `?? null`).
 */
export function resetSentEffort(): void {
  currentSentEffort = null
}
