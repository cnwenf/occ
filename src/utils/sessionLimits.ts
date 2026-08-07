/**
 * CC 2.1.212: per-session cap primitives for WebSearch spawns.
 *
 * Defaults to `200`. Read from env with `?? 200` semantics — if the env
 * value is present but not a finite positive integer, fall back to 200
 * (match the upstream `??` semantics; do not throw on bad input).
 *
 *   function getMaxWebSearchesPerSession() { return process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION ?? 200 }
 *
 * The WebSearch cap is enforced inline in WebSearchTool.call() (see that
 * file).
 *
 * CC 2.1.224: the official REMOVED the companion 200-subagent total-spawn
 * cap ("Removed the 200-subagent-per-session spawn cap; long-running
 * sessions no longer refuse new agents (concurrency and depth limits still
 * apply)"). Verified against the 2.1.224 linux-x64 ELF: the
 * `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` getter and the spawn-site assert
 * ("Subagent spawn limit reached (N of M agents spawned)...") are gone; the
 * name survives only in the env allowlist arrays. OCC parity:
 * `assertSubagentCapAndIncrement` and `getMaxSubagentsPerSession` were
 * removed together with their spawn-site call sites, and the total-spawn
 * counter left the TaskRegistry. The concurrency cap (20), the spawn-depth
 * cap (3), and the WebSearch cap (200) all REMAIN in the 224 binary and stay
 * enforced here.
 */

import type { TaskRegistry } from './taskRegistry.js'

const DEFAULT_MAX_WEB_SEARCHES_PER_SESSION = 200

// CC 2.1.217: concurrent-running subagent cap + nested-subagent spawn depth.
// Reverse-engineered from the 2.1.217 native ELF (aligning-with-official-binary):
//   function Bvu(){ return Z.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? TUg }   // TUg = 20
//   function Nue(){ let e = Z.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
//                   if (e !== void 0) return e;            // env wins if set
//                   ... growthbook flag "tengu_hazel_trellis", default Avu=1,
//                       accepted only if Number.isInteger(r) && r >= 1 }
// OCC stubs growthbook (feature()=false), so the depth getter collapses to:
// env-if-set-else-default. These two knobs are SCHEMA/ENV-ONLY in Stage 1 — the
// concurrent-run counter and depth enforcement land in Stage 2 (do not wire here).
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20
// CC 2.1.219: nested-subagent spawn depth default raised 1 → 3 ("Subagents can
// now spawn nested subagents up to depth 3 by default (was 1); set
// CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 to disable nesting"). The growthbook
// default `Avu` moved from 1 (2.1.217) to 3 (2.1.219); with growthbook stubbed
// (feature()=false) the getter collapses to env-if-set-else-3. Env override
// (`=1` to disable, or any positive int) still wins — see OCC-34 gap doc §5 P0-A.
const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 3

/**
 * Parse an env value as an integer, returning `null` if absent or not a
 * finite positive integer. Mirrors the upstream `?? 200` fallback: a
 * missing env var yields `null` (→ default); a present-but-bad value also
 * yields `null` (→ default) rather than throwing.
 */
function parsePositiveIntEnv(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null
  }
  // Number() accepts scientific notation and rejects trailing garbage with NaN.
  // parseInt('1e6', 10) stops at 'e' and returns 1 — we must not replicate that.
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return null
  }
  return n
}

export function getMaxWebSearchesPerSession(): number {
  return (
    parsePositiveIntEnv(process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION) ??
    DEFAULT_MAX_WEB_SEARCHES_PER_SESSION
  )
}

/**
 * CC 2.1.217: cap on **concurrently-running** subagents (default 20).
 *
 * Bounds how many subagents may run at once within a single message/turn, so
 * one message can't fan out unbounded background agents. (The 2.1.212
 * *total-spawn* cap of 200 was removed upstream in CC 2.1.224 — this
 * concurrency cap and the spawn-depth cap are what remain.) Env:
 * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`.
 */
export function getMaxConcurrentSubagents(): number {
  return (
    parsePositiveIntEnv(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) ??
    DEFAULT_MAX_CONCURRENT_SUBAGENTS
  )
}

/**
 * CC 2.1.219: max **nested-subagent spawn depth** (default 3).
 *
 * Subagents can now spawn nested subagents up to depth 3 by default (was 1 in
 * 2.1.217); set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` to disable nesting
 * (the 2.1.217 behavior). The official
 * also consults a growthbook flag (`tengu_hazel_trellis`, default 1, accepted
 * only if an integer ≥ 1); OCC stubs growthbook, so this collapses to
 * env-if-set-else-1. `parsePositiveIntEnv` enforces the integer-≥-1 invariant
 * (a 0 or negative env value falls back to the default, matching the
 * official's `r >= 1` guard).
 *
 * Stage 1 (schema/env only): the getter + default exist; depth enforcement at
 * the spawn sites lands in Stage 2.
 */
export function getMaxSubagentSpawnDepth(): number {
  return (
    parsePositiveIntEnv(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) ??
    DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH
  )
}

/** Minimal structural shape the cap helpers read. Keeping it local avoids
 *  a circular import on ToolUseContext. */
type ContextWithTaskRegistry = {
  taskRegistry?: TaskRegistry
}

/**
 * CC 2.1.217: claim a concurrent-running subagent slot.
 *
 * Mirrors the official spawn-site flow
 *   D = () => { let Me = getMaxConcurrentSubagents();
 *                if (taskRegistry.getConcurrentSubagents() < Me) return;   // under cap → OK
 *                ... growthbook `tengu_amber_kestrel` + ultracode exemptions (OCC stubs both) ...
 *                throw "Concurrent subagent limit reached. You can run ${Me} subagents at once. ..." }
 *   U = async () => { let Me = D(); if (Me) throw Me; return taskRegistry.takeConcurrencySlot() }
 *
 * I.e.: if the running count is already >= the cap (default 20), throw the
 * official `subagent_concurrency_cap` message; otherwise take a slot and
 * return its idempotent release function. The caller MUST release the slot
 * when the subagent settles (complete/abort/error) — typically in a
 * `finally` block — so the running count stays accurate.
 *
 * OCC stubs the two official exemptions (growthbook flag
 * `tengu_amber_kestrel`, and the ultracode/effort/model exemption `j8(...)`),
 * so the cap applies uniformly; that is stricter than upstream when ultracode
 * is on, but ultracode itself is feature-flagged in OCC. The headless/noop
 * registry returns 0 running → never blocks (matches the official no-op stub).
 */
export function claimConcurrentSubagentSlot(
  context: ContextWithTaskRegistry,
): () => void {
  const max = getMaxConcurrentSubagents()
  const running = context.taskRegistry?.getConcurrentSubagents() ?? 0
  if (running >= max) {
    throw new Error(
      `Concurrent subagent limit reached. You can run ${max} subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.`,
    )
  }
  return context.taskRegistry?.takeConcurrencySlot() ?? (() => {})
}
