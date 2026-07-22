/**
 * CC 2.1.212: per-session task registry — shared primitive backing the
 * `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` and
 * `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` caps.
 *
 * The official binary stores a `taskRegistry` object on the tool-use context
 * with six methods (get/increment/reset for both web searches and agent
 * spawns). This module provides the real implementation (mutable counters
 * by nature — that is what the upstream does) plus a no-op stub variant for
 * headless/SDK/pipe contexts where no registry exists so those paths don't
 * crash when the registry is absent.
 */

export interface TaskRegistry {
  getTotalAgentSpawns(): number
  incrementTotalAgentSpawns(): void
  resetTotalAgentSpawns(): void
  getWebSearchCalls(): number
  incrementWebSearchCalls(): void
  resetWebSearchCalls(): void
  // CC 2.1.217: concurrent-running subagent cap. Slot pattern mirroring the
  // official `takeConcurrencySlot`/`getConcurrentSubagents`: take a slot on
  // spawn (inc), return an idempotent release function to call on settle
  // (dec, clamped at 0). `getConcurrentSubagents` reads the running count.
  takeConcurrencySlot(): () => void
  getConcurrentSubagents(): number
}

/**
 * Real per-session TaskRegistry. Counters are mutable by design — the
 * upstream binary mutates them in place via increment/reset.
 */
export class TaskRegistryImpl implements TaskRegistry {
  private totalAgentSpawns = 0
  private webSearchCalls = 0
  // CC 2.1.217: concurrently-running subagent count (slot pattern).
  private runningSubagents = 0

  getTotalAgentSpawns(): number {
    return this.totalAgentSpawns
  }

  incrementTotalAgentSpawns(): void {
    this.totalAgentSpawns += 1
  }

  resetTotalAgentSpawns(): void {
    this.totalAgentSpawns = 0
  }

  getWebSearchCalls(): number {
    return this.webSearchCalls
  }

  incrementWebSearchCalls(): void {
    this.webSearchCalls += 1
  }

  resetWebSearchCalls(): void {
    this.webSearchCalls = 0
  }

  /**
   * Take a concurrency slot (increment running count), returning an
   * idempotent release function. Mirrors the official `takeConcurrencySlot`:
   *   t(i => ({...i, runningSubagents: i.runningSubagents + 1}));
   *   let o = false;
   *   return () => { if (o) return; o = true;
   *     t(i => ({...i, runningSubagents: Math.max(0, i.runningSubagents - 1)})) }
   * OCC uses a mutable counter (matching the existing totalAgentSpawns
   * idiom) rather than the immutable-state store; the release is still
   * idempotent (the `released` flag) and clamped at 0, matching upstream.
   */
  takeConcurrencySlot(): () => void {
    this.runningSubagents += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.runningSubagents = Math.max(0, this.runningSubagents - 1)
    }
  }

  getConcurrentSubagents(): number {
    return this.runningSubagents
  }
}

/** Object literal is fine — biome's noStaticOnlyClass is off anyway. */

const noopRegistry: TaskRegistry = {
  getTotalAgentSpawns() {
    return 0
  },
  incrementTotalAgentSpawns() {},
  resetTotalAgentSpawns() {},
  getWebSearchCalls() {
    return 0
  },
  incrementWebSearchCalls() {},
  resetWebSearchCalls() {},
  // CC 2.1.217: headless never blocks — no-op slot (no-op release) + 0
  // concurrent subagents. Mirrors the official no-op stub.
  takeConcurrencySlot() {
    return () => {}
  },
  getConcurrentSubagents() {
    return 0
  },
}

/**
 * No-op stub for non-session/SDK/headless/pipe contexts where no per-session
 * registry exists. Every getter returns 0; every increment/reset is a no-op.
 * This is so headless/SDK paths don't crash when the registry is absent.
 */
export function getNoopTaskRegistry(): TaskRegistry {
  // Return the same frozen instance every call — the stub is stateless.
  return noopRegistry
}
