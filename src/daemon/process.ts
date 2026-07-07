/**
 * Process-identity helpers for the B daemon.
 *
 * The official binary does NOT use OS pid namespaces — it tracks pids via
 * `supervisorPid`+`supervisorProcStart` and a `pidRecycled()` check that
 * compares a process's actual start time against the recorded start time.
 * If a pid was recycled (a different process now owns the number), the
 * record is stale.
 *
 * These helpers wrap `process.kill(pid, 0)` for liveness and `ps` for the
 * process start time, with graceful fallbacks on platforms without `ps`.
 */

import { execFileSync } from 'child_process'

/**
 * Is the given pid alive? Uses signal-0 probe (no signal sent, just a check).
 * Returns false if the pid is dead OR if we lack permission to signal it.
 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // ESRCH = no such process → dead. EPERM = alive but not ours.
    return err?.code === 'EPERM'
  }
}

/**
 * Get the start time of a process (epoch ms), or null if unresolvable.
 *
 * Uses `ps -o lstart= -p <pid>` (portable across mac/linux). The lstart
 * field is the wall-clock start time. We parse the date string.
 *
 * Used by pidRecycled() and lockfile contention checks to distinguish a
 * live holder from a pid that was reused by a different process.
 */
export function getProcessStartMs(pid: number): number | null {
  if (!pid || pid <= 0) return null
  let out: string
  try {
    out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
  } catch {
    return null
  }
  if (!out) return null
  const ms = Date.parse(out)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Has a pid been recycled? True if the pid is alive BUT the process now
 * occupying it started AFTER the recorded startedAt (within a tolerance).
 *
 * @param pid         the pid to check
 * @param startedAt   the start time we recorded for this pid (epoch ms)
 * @returns true if a *different* process now owns the pid number
 */
export function pidRecycled(pid: number, startedAt: number): boolean {
  if (!isPidAlive(pid)) {
    // Dead pid — not "recycled", just gone.
    return false
  }
  const actualStart = getProcessStartMs(pid)
  if (actualStart === null) {
    // Can't determine — assume not recycled (avoid false-positive kills).
    return false
  }
  // If the actual process started strictly later than our record (beyond
  // tolerance), a new process took the pid number.
  const tolerance = 2000
  return actualStart > startedAt + tolerance
}

/**
 * Send SIGTERM to a worker pid and return whether the signal was delivered.
 */
export function sigtermWorker(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * Send SIGKILL to a worker pid (force-kill) and return whether delivered.
 */
export function sigkillWorker(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/**
 * daemon_ensure_zombie_kill — escalate from SIGTERM to SIGKILL after a
 * grace period. Used when a supervisor restart cannot cleanly stop a
 * previous supervisor (EPERM / unresponsive holder).
 */
export async function ensureZombieKill(pid: number, graceMs = 3000): Promise<boolean> {
  if (!isPidAlive(pid)) return true
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise(r => setTimeout(r, 150))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  await new Promise(r => setTimeout(r, 200))
  return !isPidAlive(pid)
}
