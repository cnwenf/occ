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
}

/**
 * Real per-session TaskRegistry. Counters are mutable by design — the
 * upstream binary mutates them in place via increment/reset.
 */
export class TaskRegistryImpl implements TaskRegistry {
  private totalAgentSpawns = 0
  private webSearchCalls = 0

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
