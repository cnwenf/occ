/**
 * ERESPAWN retry loop + orphan recovery for the B daemon.
 *
 * Error codes:
 *   - ERESPAWNING: "supervisor restarting" / "worker stalled, restarting"
 *   - ENOREPLY:    worker spawned but never responded (no reply within window)
 *   - ESTARTING:   worker is still starting up
 *
 * The retry loop bumps its budget to 60 when it sees ERESPAWN, so a
 * supervisor that's repeatedly restarting stays in the loop rather than
 * failing fast.
 *
 * Orphan recovery runs at supervisor startup: it scans the process table
 * for `claude --daemon-worker` children whose parent is gone, and reports:
 *   "background agent(s) orphaned by previous process exit"
 *   "[print.ts] N orphaned background task(s) after restart"
 * The per-worker orphan watchdog ("parent supervisor gone — exiting") lives
 * in workerRegistry.runDaemonWorker; this module handles the supervisor side.
 */

import { execFileSync } from 'child_process'
import { logEvent } from '../services/analytics/index.js'
import type { RespawnError, RespawnErrorCode } from './types.js'
import { isPidAlive } from './process.js'
import { forceRespawnWorker } from './workerRegistry.js'

/** Default retry budget before the supervisor gives up. */
export const DEFAULT_RESPAWN_BUDGET = 10

/** Budget bumped to this on ERESPAWN. */
export const ERESPAWN_BUDGET = 60

/** Create a RespawnError with the given code + message. */
export function createRespawnError(
  code: RespawnErrorCode,
  message: string,
): RespawnError {
  const err = new Error(message) as RespawnError
  err.code = code
  return err
}

/** Is the given error a RespawnError? */
export function isRespawnError(err: unknown): err is RespawnError {
  return (
    err instanceof Error &&
    (err as any).code !== undefined &&
    typeof (err as any).code === 'string'
  )
}

/**
 * Run `fn` with a respawn budget. On ERESPAWN, the budget is bumped to 60
 * and the loop continues. On ENOREPLY / ESTARTING, back off and retry.
 * Any other error rethrows.
 */
export async function retryWithRespawnBudget<T>(
  fn: () => Promise<T>,
  opts?: { budget?: number; backoffMs?: number; onRetry?: (info: RetryInfo) => void },
): Promise<T> {
  let budget = opts?.budget ?? DEFAULT_RESPAWN_BUDGET
  const baseBackoff = opts?.backoffMs ?? 500
  let attempt = 0
  let lastErr: unknown

  while (budget > 0) {
    attempt++
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err
      const code: RespawnErrorCode | undefined = err?.code
      if (!code) throw err

      if (code === 'ERESPAWNING') {
        // Bump budget to 60 — supervisor is restarting, stay in the loop.
        budget = ERESPAWN_BUDGET
        console.log('supervisor restarting')
        opts?.onRetry?.({ attempt, code, reason: 'ERESPAWNING' })
      } else if (code === 'ENOREPLY' || code === 'ESTARTING') {
        opts?.onRetry?.({ attempt, code, reason: code })
      } else {
        throw err
      }
      budget--
      const backoff = baseBackoff * Math.min(8, attempt)
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  throw lastErr ?? new Error('respawn budget exhausted')
}

export interface RetryInfo {
  attempt: number
  code: RespawnErrorCode
  reason: string
}

/**
 * Schedule a respawn after `ms`. Returns a cancel function.
 * Used by the supervisor when a worker stalls but we don't want to respawn
 * immediately (debounce / cooldown).
 */
export function scheduleRespawn(
  ms: number,
  fn: () => void,
): () => void {
  let cancelled = false
  const timer = setTimeout(() => {
    if (cancelled) return
    fn()
  }, ms)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as any).unref?.()
  }
  return () => {
    cancelled = true
    clearTimeout(timer as any)
  }
}

/**
 * Force-respawn a worker by id immediately (SIGKILL + spawn fresh).
 * Logs "ERESPAWNING: worker stalled, restarting".
 */
export function forceRespawn(workerId: string): void {
  console.log(`ERESPAWNING: worker stalled, restarting (id=${workerId})`)
  logEvent('tengu_bg_respawn', { workerId: workerId as any, force: true as any })
  forceRespawnWorker(workerId)
}

/**
 * Scan the process table for orphaned daemon workers — `claude --daemon-worker`
 * children whose parent pid is dead (the previous supervisor exited).
 *
 * Called at supervisor startup. Returns the list of orphaned pids. The
 * supervisor logs "background agent(s) orphaned by previous process exit"
 * and "[print.ts] N orphaned background task(s) after restart".
 */
export function findOrphanedWorkers(): { pid: number; ppid: number; cmd: string }[] {
  let out: string
  try {
    out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
  } catch {
    return []
  }
  const orphans: { pid: number; ppid: number; cmd: string }[] = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const cmd = m[3]
    // Identify daemon-worker children by the --daemon-worker arg.
    if (!cmd.includes('--daemon-worker')) continue
    // Self-skip.
    if (pid === process.pid) continue
    // Orphaned if the parent is dead.
    if (!isPidAlive(ppid)) {
      orphans.push({ pid, ppid, cmd })
    }
  }
  return orphans
}

/**
 * Recover orphaned workers found at supervisor startup.
 *
 * Prints the "[print.ts] N orphaned background task(s) after restart" line
 * and re-adopts (SIGTERM the orphans; the supervisor will prewarm fresh ones
 * in the next sweep). Re-adoption of live work is a future concern (B6+);
 * for B1-B5 we cleanly retire orphans to avoid double-dispatch.
 */
export function recoverOrphanedWorkers(): number {
  const orphans = findOrphanedWorkers()
  if (orphans.length > 0) {
    console.log('background agent(s) orphaned by previous process exit')
    console.log(`[print.ts] ${orphans.length} orphaned background task(s) after restart`)
    logEvent('tengu_bg_orphan_recovery', { count: orphans.length })
    for (const o of orphans) {
      console.log(
        `orphan watchdog: ppid ${o.ppid}→process.ppid, no client found (pid=${o.pid})`,
      )
      try {
        process.kill(o.pid, 'SIGTERM')
      } catch {
        /* already dead */
      }
    }
  }
  return orphans.length
}

/**
 * handleOrphanedPermissionResponse — placeholder for the permission-flow
 * variant of orphan recovery. The binary has handleOrphanedPermission{Response}
 * for re-surfacing a permission prompt whose worker died. Full impl is B6+;
 * here we just log + emit so the hook exists.
 */
export function handleOrphanedPermissionResponse(workerId: string): void {
  logEvent('tengu_bg_orphaned_permission', { workerId: workerId as any })
  console.log(`handleOrphanedPermissionResponse: worker ${workerId} orphaned mid-prompt`)
}
