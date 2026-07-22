/**
 * CC 2.1.212: per-session cap primitives for WebSearch and subagent spawns.
 *
 * Both default to `200`. Read from env with `?? 200` semantics — if the env
 * value is present but not a finite positive integer, fall back to 200
 * (match the upstream `??` semantics; do not throw on bad input).
 *
 *   function getMaxWebSearchesPerSession() { return process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION ?? 200 }
 *   function getMaxSubagentsPerSession()   { return process.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION   ?? 200 }
 *
 * The subagent cap is enforced at every spawn site via
 * `assertSubagentCapAndIncrement(context)`, which throws when the cap is
 * exceeded and increments only on the proceeding path. The WebSearch cap is
 * enforced inline in WebSearchTool.call() (see that file).
 */

import type { TaskRegistry } from './taskRegistry.js'

const DEFAULT_MAX_WEB_SEARCHES_PER_SESSION = 200
const DEFAULT_MAX_SUBAGENTS_PER_SESSION = 200

// CC 2.1.217: concurrent-running subagent cap + nested-subagent spawn depth.
// Reverse-engineered from the 2.1.217 native ELF (aligning-with-official-binary):
//   function Bvu(){ return Z.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? TUg }   // TUg = 20
//   function Nue(){ let e = Z.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
//                   if (e !== void 0) return e;            // env wins if set
//                   ... growthbook flag "tengu_hazel_trellis", default Avu=1,
//                       accepted only if Number.isInteger(r) && r >= 1 }
// OCC stubs growthbook (feature()=false), so the depth getter collapses to:
// env-if-set-else-1. These two knobs are SCHEMA/ENV-ONLY in Stage 1 — the
// concurrent-run counter and depth enforcement land in Stage 2 (do not wire here).
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20
const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 1

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

export function getMaxSubagentsPerSession(): number {
  return (
    parsePositiveIntEnv(process.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION) ??
    DEFAULT_MAX_SUBAGENTS_PER_SESSION
  )
}

/**
 * CC 2.1.217: cap on **concurrently-running** subagents (default 20).
 *
 * Distinct from `getMaxSubagentsPerSession()` (the 2.1.212 *total-spawn*
 * cap, default 200): this bounds how many subagents may run at once within a
 * single message/turn, so one message can't fan out unbounded background
 * agents. Env: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`.
 *
 * Stage 1 (schema/env only): the getter + default exist; the concurrent-run
 * counter and enforcement at spawn sites land in Stage 2.
 */
export function getMaxConcurrentSubagents(): number {
  return (
    parsePositiveIntEnv(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) ??
    DEFAULT_MAX_CONCURRENT_SUBAGENTS
  )
}

/**
 * CC 2.1.217: max **nested-subagent spawn depth** (default 1 = no nesting).
 *
 * Subagents no longer spawn nested subagents by default; set
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to allow deeper nesting. The official
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

/** Minimal structural shape `assertSubagentCapAndIncrement` reads. Keeping
 *  it local avoids a circular import on ToolUseContext. */
type ContextWithTaskRegistry = {
  taskRegistry?: TaskRegistry
}

/**
 * Check the per-session subagent-spawn cap and increment the counter.
 *
 * MUST be called at every site that spawns a subagent (the normal `runAgent`
 * path, the teammate/foreground path, and the fork path). The increment
 * happens AFTER the cap passes, BEFORE the actual spawn — matching the
 * official: throw (do not silently return) on cap exceeded.
 */
export function assertSubagentCapAndIncrement(
  context: ContextWithTaskRegistry,
): void {
  const max = getMaxSubagentsPerSession()
  const count = context.taskRegistry?.getTotalAgentSpawns() ?? 0
  if (count >= max) {
    throw new Error(
      `Subagent spawn limit reached (${count} of ${max} agents spawned). Complete the remaining work directly with your tools instead of spawning more agents. If more agents are genuinely needed, ask the user to raise CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION.`,
    )
  }
  context.taskRegistry?.incrementTotalAgentSpawns()
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
