import { type ChildProcess, spawnSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'

import { logForDebugging } from './debug.js'

/**
 * Process-tree watchdog (claude-code 2.1.281 #050).
 *
 * The official binary introduced a `ta` class (ELF @196003456) that wraps an
 * auth-refresh child process:
 *
 *   ctor(child, {timeoutMs = 180000, signal}):
 *     - register a process 'exit' shutdown hook
 *     - arm a 3-minute timeout
 *     - listen for an abort signal
 *   kill(reason):
 *     - destroy the child's stdio
 *     - kill the whole process TREE (unix: enumerate descendants that share the
 *       child's session, SIGTERM deepest-first, then the child itself)
 *     - fall back to child.kill("SIGTERM") when the tree walk cannot proceed
 *   killReason: 'abort' | 'shutdown' => silent; 'timeout' => red 3-min message
 *
 * The v280 predecessor (@193334491) relied on Bun's spawn `{timeout, signal}`
 * options, which only terminate the DIRECT child. A detached grandchild — the
 * `aws sso` / `gcloud auth print-access-token` helper the refresh command spawns
 * — survived and kept holding the localhost OAuth callback port, wedging the
 * next refresh. v281 kills the whole tree to prevent the orphan.
 *
 * The shutdown hook is a synchronous `process.on('exit')` handler: async work
 * cannot complete during exit, so the tree walk MUST be synchronous. That is why
 * this does not use the async `tree-kill` npm package (see
 * tasks/LocalShellTask/killShellTasks.ts), which spawns `ps`/`pgrep` and awaits.
 */

/** Default auth-refresh timeout — matches v281's `{timeoutMs = 180000}` and the existing AWS/GCP refresh constants. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 180_000

/** Bound on the synchronous `ps` spawn used to enumerate descendants on macOS (where `/proc` is unavailable). */
export const PROCESS_TABLE_SPAWN_BUDGET_MS = 1_500

/** Why the watchdog terminated its child. Mirrors v281's `ta` killReason union. */
export type KillReason = 'timeout' | 'abort' | 'shutdown'

/** Minimal shape the watchdog needs from a child process (keeps it testable with fakes). */
type WatchableChild = Pick<
  ChildProcess,
  'kill' | 'pid' | 'exitCode' | 'signalCode' | 'stdout' | 'stderr' | 'stdin'
>

// --- shutdown hook registry --------------------------------------------------

type ShutdownHook = () => void

const shutdownHooks = new Set<ShutdownHook>()
let shutdownHookInstalled = false

function runShutdownHooks(): void {
  for (const hook of shutdownHooks) {
    try {
      hook()
    } catch (error) {
      // Best-effort during exit; never let one hook abort the others.
      logForDebugging(
        `auth refresh: shutdown hook failed (${errorMessageSafe(error)})`,
        { level: 'debug' },
      )
    }
  }
}

/**
 * Register a synchronous shutdown hook to run on `process.on('exit')`.
 * Returns an unsubscribe function. Mirrors v281's per-watchdog exit registration.
 */
export function registerShutdownHook(hook: ShutdownHook): () => void {
  if (!shutdownHookInstalled) {
    shutdownHookInstalled = true
    process.on('exit', runShutdownHooks)
  }
  shutdownHooks.add(hook)
  return () => {
    shutdownHooks.delete(hook)
  }
}

function errorMessageSafe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- process-table enumeration ----------------------------------------------

type ProcessTableRow = { ppid: number; session: number }

/**
 * Parse a `/proc/<pid>/stat` line. The comm field (field 2) is parenthesised and
 * may contain spaces/parens, so split AFTER the last `)`. The remaining fields
 * are: state, ppid, pgrp, session, ... at indices 0,1,2,3.
 */
export function parseProcStat(stat: string): ProcessTableRow | null {
  const closeParen = stat.lastIndexOf(')')
  if (closeParen === -1) {
    return null
  }
  const fields = stat.slice(closeParen + 1).trim().split(/\s+/)
  // fields[0]=state fields[1]=ppid fields[2]=pgrp fields[3]=session
  const ppid = Number.parseInt(fields[1] ?? '', 10)
  const session = Number.parseInt(fields[3] ?? '', 10)
  if (Number.isNaN(ppid) || Number.isNaN(session)) {
    return null
  }
  return { ppid, session }
}

/**
 * Build a pid -> {ppid, session} map for the whole machine.
 * Linux reads `/proc` directly (zero spawns). macOS falls back to a bounded
 * synchronous `ps -o pid=,ppid=,sess= -A`.
 */
function readProcessTablePosix(): Map<number, ProcessTableRow> {
  const table = new Map<number, ProcessTableRow>()
  const platform = process.platform
  if (platform === 'linux') {
    let entries: string[]
    try {
      entries = readdirSync('/proc')
    } catch {
      return table
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) {
        continue
      }
      let stat: string
      try {
        stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      } catch {
        continue // process vanished between readdir and read
      }
      const row = parseProcStat(stat)
      if (row !== null) {
        table.set(Number.parseInt(entry, 10), row)
      }
    }
    return table
  }
  // macOS / other unix without /proc.
  const result = spawnSync('ps', ['-o', 'pid=,ppid=,sess=', '-A'], {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_SPAWN_BUDGET_MS,
  })
  if (result.error || typeof result.stdout !== 'string') {
    return table
  }
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) {
      continue
    }
    const pid = Number.parseInt(parts[0] ?? '', 10)
    const ppid = Number.parseInt(parts[1] ?? '', 10)
    const session = Number.parseInt(parts[2] ?? '', 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid) || Number.isNaN(session)) {
      continue
    }
    table.set(pid, { ppid, session })
  }
  return table
}

/**
 * Enumerate every descendant of `pid`, optionally restricted to those sharing
 * `pid`'s session (v281's `sameSession` filter — avoids killing unrelated
 * processes that happen to share a controlling terminal). BFS from the root;
 * the returned Set never includes `pid` itself.
 */
export function enumerateDescendants(
  pid: number,
  options: { sameSession?: boolean; table?: Map<number, ProcessTableRow> } = {},
): Set<number> {
  const table = options.table ?? readProcessTablePosix()
  const rootSession = options.sameSession ? table.get(pid)?.session : undefined

  // Index children by parent once.
  const childrenByPpid = new Map<number, number[]>()
  for (const [childPid, row] of table) {
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings === undefined) {
      childrenByPpid.set(row.ppid, [childPid])
    } else {
      siblings.push(childPid)
    }
  }

  const descendants = new Set<number>()
  const queue: number[] = [pid]
  while (queue.length > 0) {
    const current = queue.shift() as number
    for (const childPid of childrenByPpid.get(current) ?? []) {
      if (descendants.has(childPid)) {
        continue
      }
      if (
        options.sameSession &&
        rootSession !== undefined &&
        table.get(childPid)?.session !== rootSession
      ) {
        continue
      }
      descendants.add(childPid)
      queue.push(childPid)
    }
  }
  return descendants
}

function killPidSafe(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, or not ours to signal. Best-effort.
  }
}

function destroyStream(
  stream: { destroy?: (error?: Error) => void } | null | undefined,
): void {
  try {
    stream?.destroy?.()
  } catch {
    // stream already destroyed / not destroyable
  }
}

/**
 * Kill a child process and its entire tree.
 *
 * Order (faithful to v281 `ta.kill`):
 *   1. destroy the child's stdio so no half-buffered output is processed
 *   2. on unix, SIGTERM every same-session descendant, DEEPEST FIRST (reversed
 *      BFS order) so parents cannot reparent/reap-and-respawn before children die
 *   3. finally signal the child itself
 *   4. if the tree walk throws, fall back to signalling the child only
 *
 * On win32 there is no session/`/proc` model, so use `taskkill /T /F` (tree).
 */
export function killProcessTree(
  child: WatchableChild,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  // Always drop stdio first — even if the child already exited, an open pipe
  // can keep delivering 'data' into a torn-down auth handler.
  destroyStream(child.stdout)
  destroyStream(child.stderr)
  destroyStream(child.stdin)

  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    // Never spawned, or already terminated — nothing to tree-kill.
    return
  }

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: PROCESS_TABLE_SPAWN_BUDGET_MS,
      })
    } else {
      const descendants = enumerateDescendants(pid, { sameSession: true })
      // Deepest-first: reversed insertion order is deepest-last-first because BFS
      // appends parents before children.
      for (const descendantPid of [...descendants].reverse()) {
        killPidSafe(descendantPid, signal)
      }
    }
  } catch (error) {
    logForDebugging(
      `auth refresh: process-tree kill failed (${errorMessageSafe(error)}); signalling the command only`,
      { level: 'debug' },
    )
  } finally {
    // Signal the direct child last (or as the sole fallback on error).
    try {
      child.kill(signal)
    } catch {
      // child.kill throws if already exited between the guard and here.
    }
  }
}

// --- watchdog ----------------------------------------------------------------

/**
 * Wraps an auth-refresh child with v281's three kill triggers: a timeout, an
 * optional AbortSignal, and a process-exit shutdown hook. On any trigger it
 * kills the whole process tree and records WHY, so the caller can decide whether
 * to surface a message (timeout => red 3-minute message; abort/shutdown => silent).
 *
 * The caller is expected to invoke {@link ProcessTreeWatchdog.settle} from the
 * child's 'close'/'exit' handler on the NORMAL completion path so the timeout and
 * shutdown hook are released and no late kill fires.
 */
export class ProcessTreeWatchdog {
  readonly #child: WatchableChild
  readonly #signal: AbortSignal | undefined
  #timeoutHandle: ReturnType<typeof setTimeout> | undefined
  #removeShutdownHook: (() => void) | undefined
  #killReason: KillReason | undefined
  #settled = false
  readonly #onAbort: () => void

  constructor(
    child: WatchableChild,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS
    this.#child = child
    this.#signal = options.signal

    this.#onAbort = () => {
      this.#kill('abort')
    }

    // 1. process-exit shutdown hook (synchronous tree kill).
    this.#removeShutdownHook = registerShutdownHook(() => {
      this.#kill('shutdown')
    })

    // 2. timeout.
    this.#timeoutHandle = setTimeout(() => {
      this.#kill('timeout')
    }, timeoutMs)
    // Don't hold the event loop open just for the timeout.
    this.#timeoutHandle.unref?.()

    // 3. abort signal — honour an already-aborted signal immediately.
    if (this.#signal !== undefined) {
      if (this.#signal.aborted) {
        this.#kill('abort')
      } else {
        this.#signal.addEventListener('abort', this.#onAbort, { once: true })
      }
    }
  }

  /** Why the watchdog killed its child, or undefined if it never did. */
  get killReason(): KillReason | undefined {
    return this.#killReason
  }

  /** True once {@link settle} has been called (normal completion). */
  get settled(): boolean {
    return this.#settled
  }

  /**
   * Release all triggers without killing. Call from the child's normal
   * completion ('close') path. Idempotent and safe to call after a kill.
   */
  settle(): void {
    this.#settled = true
    if (this.#timeoutHandle !== undefined) {
      clearTimeout(this.#timeoutHandle)
      this.#timeoutHandle = undefined
    }
    this.#removeShutdownHook?.()
    this.#removeShutdownHook = undefined
    this.#signal?.removeEventListener('abort', this.#onAbort)
  }

  /** Kill the tree and memoise the first reason. Later triggers are ignored. */
  #kill(reason: KillReason): void {
    if (this.#killReason !== undefined) {
      return
    }
    this.#killReason = reason
    killProcessTree(this.#child)
    this.settle()
  }
}
