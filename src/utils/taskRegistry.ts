/**
 * CC 2.1.212: per-session task registry — shared primitive backing the
 * `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` cap (and, since CC 2.1.217, the
 * concurrent-subagent slot count).
 *
 * CC 2.1.224: the `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` total-spawn cap
 * was removed upstream, so the total-spawn counter
 * (get/increment/resetTotalAgentSpawns) was removed here too — its only
 * consumer (assertSubagentCapAndIncrement) is gone.
 *
 * The official binary stores a `taskRegistry` object on the tool-use context.
 * This module provides the real implementation (mutable counters by nature —
 * that is what the upstream does) plus a no-op stub variant for
 * headless/SDK/pipe contexts where no registry exists so those paths don't
 * crash when the registry is absent.
 *
 * CC 2.1.311 Item 12: the registry also became the *occupant index* the agent
 * worktree cleanup consults before deleting a worktree — "is another task
 * still working inside this directory?". Official v311 (@256785050):
 *
 *   let F=(te)=>Nn(q.all(),E===void 0?[r]:[r,E],te)
 *
 * where `Nn` scans every registry task for a `cwd` inside one of the candidate
 * paths. OCC ports that as `registerAgentTask`/`updateAgentTask`/
 * `unregisterAgentTask`/`allAgentTasks`/`findOccupant` plus the pure helpers
 * `isTerminalAgentTaskStatus` (official `Go` @246833024),
 * `isPathInsideOrEqual` (official `ax` @251643778) and `findAgentTaskOccupant`
 * (official `Nn` @256753600).
 */

import { sep } from 'node:path'

/**
 * Task statuses OCC's local-agent tasks can hold. Mirrors the official union
 * that `Go` (@246833024) tests for terminality:
 *   function Go(e){return e==="completed"||e==="failed"||e==="killed"}
 */
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

/**
 * One tracked subagent task. `cwd` is the directory the task runs in — for a
 * worktree-isolated subagent that is the worktree path, and for a nested
 * subagent spawned inside one it is inherited from the ambient cwd override.
 *
 * `parked` marks the official `d4n` state: the task itself reached a terminal
 * status but was backgrounded and still owns live work (a background shell,
 * workflow or child agent) inside its directory. A parked task still counts as
 * an occupant, which is why the official telemetry distinguishes
 * `parked_task` from `live_task`.
 */
export interface AgentTaskRecord {
  readonly id: string
  readonly type: string
  readonly status: AgentTaskStatus
  readonly cwd?: string
  readonly parked?: boolean
}

/** Copy-on-update patch — `id` is the key and can never be rewritten. */
export type AgentTaskPatch = Partial<Omit<AgentTaskRecord, 'id'>>

/**
 * Occupant filter. The official default is `(h)=>!Go(h.status)` (non-terminal
 * only); the second scan replaces it wholesale with
 * `(te)=>te.id!==ye&&Gt(te,q)` so terminal-but-still-relevant tasks are seen.
 */
export type AgentTaskPredicate = (task: AgentTaskRecord) => boolean

/** Official `Go` @246833024 — is this status a settled one? */
export function isTerminalAgentTaskStatus(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * Official `ax` @251643778, verbatim:
 *   function ax(e,n){return e===n||e.startsWith(n.endsWith(wSn)?n:n+wSn)}
 * with `wSn` bound to `sep` from "path" (@251642260). The separator boundary
 * is what stops `/wt-x` from matching an occupant in `/wt-xy`.
 */
export function isPathInsideOrEqual(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const boundary = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate.startsWith(boundary)
}

/** Default occupant predicate — a task that has not settled yet. */
function isNonTerminal(task: AgentTaskRecord): boolean {
  return !isTerminalAgentTaskStatus(task.status)
}

/**
 * Official `Nn` @256753600, verbatim:
 *   function Nn(n,e,s=(h)=>!Go(h.status)){
 *     for(let h of Object.values(n)){
 *       let y=h.cwd;
 *       if(y===void 0||!s(h))continue;
 *       if(e.some((S)=>Kc(y,S)))return h
 *     }
 *     return
 *   }
 * Returns the first task whose `cwd` is one of `roots` or nested inside one.
 */
export function findAgentTaskOccupant(
  tasks: ReadonlyArray<AgentTaskRecord>,
  roots: ReadonlyArray<string>,
  predicate: AgentTaskPredicate = isNonTerminal,
): AgentTaskRecord | undefined {
  for (const task of tasks) {
    const cwd = task.cwd
    if (cwd === undefined) continue
    if (!predicate(task)) continue
    if (roots.some(root => isPathInsideOrEqual(cwd, root))) return task
  }
  return undefined
}

export interface TaskRegistry {
  getWebSearchCalls(): number
  incrementWebSearchCalls(): void
  resetWebSearchCalls(): void
  // CC 2.1.217: concurrent-running subagent cap. Slot pattern mirroring the
  // official `takeConcurrencySlot`/`getConcurrentSubagents`: take a slot on
  // spawn (inc), return an idempotent release function to call on settle
  // (dec, clamped at 0). `getConcurrentSubagents` reads the running count.
  takeConcurrencySlot(): () => void
  getConcurrentSubagents(): number
  // CC 2.1.311 Item 12: subagent occupant index (see filedoc). Records are
  // stored copy-on-update; `findOccupant` is the official `Nn` scan.
  registerAgentTask(record: AgentTaskRecord): void
  updateAgentTask(id: string, patch: AgentTaskPatch): void
  unregisterAgentTask(id: string): void
  getAgentTask(id: string): AgentTaskRecord | undefined
  allAgentTasks(): ReadonlyArray<AgentTaskRecord>
  findOccupant(
    roots: ReadonlyArray<string>,
    predicate?: AgentTaskPredicate,
  ): AgentTaskRecord | undefined
}

/**
 * Real per-session TaskRegistry. Counters are mutable by design — the
 * upstream binary mutates them in place via increment/reset.
 */
export class TaskRegistryImpl implements TaskRegistry {
  private webSearchCalls = 0
  // CC 2.1.217: concurrently-running subagent count (slot pattern).
  private runningSubagents = 0
  // CC 2.1.311 Item 12: tracked subagent tasks, keyed by task id. The Map
  // itself is the mutable holder; the records inside it are never mutated —
  // every write replaces the entry with a fresh object so a caller holding an
  // earlier record still sees the state it read.
  private readonly agentTasks = new Map<string, AgentTaskRecord>()

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
   * OCC uses a mutable counter rather than the immutable-state store; the
   * release is still idempotent (the `released` flag) and clamped at 0,
   * matching upstream.
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

  /** CC 2.1.311 Item 12: index a spawned subagent by id (copy-on-write). */
  registerAgentTask(record: AgentTaskRecord): void {
    this.agentTasks.set(record.id, { ...record })
  }

  /**
   * CC 2.1.311 Item 12: patch a tracked task. Unknown ids are ignored — the
   * settle path can run after an explicit unregister, and that is not an error.
   *
   * `id` is re-pinned last: it is the Map key, so a patch that rewrote it would
   * desync key from record. The patch type already Omit-s `id`; re-pinning
   * makes the guarantee hold at runtime too, not just at the type level.
   */
  updateAgentTask(id: string, patch: AgentTaskPatch): void {
    const existing = this.agentTasks.get(id)
    if (existing === undefined) return
    this.agentTasks.set(id, { ...existing, ...patch, id })
  }

  /** CC 2.1.311 Item 12: drop a task once it has fully settled. */
  unregisterAgentTask(id: string): void {
    this.agentTasks.delete(id)
  }

  getAgentTask(id: string): AgentTaskRecord | undefined {
    return this.agentTasks.get(id)
  }

  /** Official `q.all()` — insertion-ordered snapshot of every tracked task. */
  allAgentTasks(): ReadonlyArray<AgentTaskRecord> {
    return [...this.agentTasks.values()]
  }

  /** Official `Nn(q.all(), roots, predicate)` — first task working in `roots`. */
  findOccupant(
    roots: ReadonlyArray<string>,
    predicate?: AgentTaskPredicate,
  ): AgentTaskRecord | undefined {
    return findAgentTaskOccupant(this.allAgentTasks(), roots, predicate)
  }
}

/** Object literal is fine — biome's noStaticOnlyClass is off anyway. */

const noopRegistry: TaskRegistry = {
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
  // CC 2.1.311 Item 12: the stub tracks no occupants, so `findOccupant`
  // returns undefined and cleanup falls back to the unchanged-only decision.
  registerAgentTask() {},
  updateAgentTask() {},
  unregisterAgentTask() {},
  getAgentTask() {
    return undefined
  },
  allAgentTasks() {
    return []
  },
  findOccupant() {
    return undefined
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

/**
 * CC 2.1.311 Item 12: process-wide occupant index.
 *
 * Deviation from the official, which hangs the registry off the tool-use
 * context (`q`). OCC cannot use that carrier here for two reasons:
 *
 * 1. Headless/SDK/pipe contexts carry `getNoopTaskRegistry()`, so occupant
 *    tracking would be dead exactly where `run_in_background` subagents also
 *    run — the bug this item fixes would survive in print mode.
 * 2. `bootstrap/state.ts` nulls the session registry on `switchSession`, so a
 *    worktree armed for deferred cleanup across a session switch would lose
 *    its occupant view and could delete a directory a task is still in.
 *
 * A single process-lifetime registry keeps the invariant "no task is inside
 * this directory" decidable from anywhere in the process, and stays injectable
 * (`cleanupAgentWorktree` takes the registry as a parameter) for tests.
 */
let processTaskRegistry: TaskRegistry | null = null

export function getProcessTaskRegistry(): TaskRegistry {
  if (processTaskRegistry === null) {
    processTaskRegistry = new TaskRegistryImpl()
  }
  return processTaskRegistry
}
