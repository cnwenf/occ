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
