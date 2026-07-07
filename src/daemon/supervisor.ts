/**
 * The B daemon supervisor process.
 *
 * Self-identifies via { supervisorPid: process.pid, supervisorProcStart: Date.now() }.
 * Lifecycle:
 *   1. binary-identity check (self-update safety)
 *   2. acquire lockfile (contention → "existing daemon refused to yield")
 *   3. recover orphaned workers from a previous supervisor exit
 *   4. read daemon.json + validate configured workers
 *   5. sweep loop — prewarm, respawn stale, retire settled
 *   6. idle shutdown ("idle Ns with no workers") when no workers for a while
 *   7. on shutdown: "shutting down (cause=Y, uptime=M)", stop all workers,
 *      release lockfile
 *
 * EPERM restart: if the previous supervisor can't be cleanly stopped
 * ("could not restart supervisor (EPERM)"), daemon_ensure_zombie_kill
 * escalates SIGTERM → SIGKILL.
 *
 * daemonColdStart: enum [transient|ask], CLAUDE_CODE_DAEMON_COLD_START env.
 *   transient = a short-lived daemon that exits when idle (default).
 *   ask       = prompt the user before starting (handled at the CLI layer).
 */

import { existsSync, statSync } from 'fs'
import { logEvent } from '../services/analytics/index.js'
import { getGlobalConfig } from '../utils/config.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import type { DaemonColdStart, DaemonJsonConfig, ShutdownCause, SupervisorIdentity } from './types.js'
import { acquireLockfile, displaceHolder, readLockfile, releaseLockfile } from './lockfile.js'
import { ensureZombieKill, isPidAlive, sigtermWorker } from './process.js'
import { recoverOrphanedWorkers } from './respawn.js'
import {
  readDaemonJson,
  stopAllWorkers,
  sweepWorkers,
  validateDaemonJsonWorkers,
} from './workerRegistry.js'
import { installPersistentService, uninstallPersistentService } from './install.js'

/** Idle threshold (ms) before an empty supervisor shuts itself down. */
const IDLE_SHUTDOWN_MS = 60_000 // "idle 60s with no workers"

/** Sweep interval (ms). */
const SWEEP_INTERVAL_MS = 5_000

/** Whether the supervisor is running (set true once the main loop starts). */
let running = false

/** The supervisor's identity. */
function buildIdentity(): SupervisorIdentity {
  return {
    supervisorPid: process.pid,
    supervisorProcStart: Date.now(),
  }
}

/**
 * getDaemonColdStart — read the cold-start policy.
 *
 * Priority: CLAUDE_CODE_DAEMON_COLD_START env > globalConfig.daemonColdStart
 * > 'transient' (default).
 *
 * The settings.ts schema field is a follow-up; for now we read the env var
 * and the raw globalConfig field so the knob works without modifying
 * settings.ts.
 */
export function getDaemonColdStart(): DaemonColdStart {
  const env = process.env.CLAUDE_CODE_DAEMON_COLD_START
  if (env === 'transient' || env === 'ask') return env
  const fromConfig = (getGlobalConfig() as any).daemonColdStart
  if (fromConfig === 'transient' || fromConfig === 'ask') return fromConfig
  return 'transient'
}

/**
 * Binary-identity check. The official binary refuses to start a supervisor
 * if its own executable was deleted (self-update in progress) or is
 * unresolvable — "binary identity unresolvable" / "binary at g was deleted".
 *
 * Returns null if OK, or an error string explaining why the binary is bad.
 */
export function checkBinaryIdentity(): string | null {
  const execPath = process.execPath
  const entry = process.argv[1]
  try {
    if (!execPath || !existsSync(execPath)) {
      return 'binary identity unresolvable'
    }
    // execPath resolves (no throw) — confirm it's still on disk.
    statSync(execPath)
  } catch {
    return 'binary identity unresolvable'
  }
  if (entry) {
    try {
      if (!existsSync(entry)) {
        return `binary at ${entry} was deleted`
      }
    } catch {
      return `binary at ${entry} was deleted`
    }
  }
  return null
}

/**
 * "existing daemon refused to yield" — when a live holder won't give up the
 * lock. Returns true if the holder is live and we should NOT start.
 */
export async function holderRefusesToYield(): Promise<boolean> {
  const existing = await readLockfile()
  if (!existing) return false
  return isPidAlive(existing.supervisorPid)
}

/**
 * Stop the existing supervisor (used by `claude daemon stop`).
 * SIGTERM the holder; if EPERM, escalate via ensureZombieKill.
 */
export async function stopExistingSupervisor(): Promise<{
  stopped: boolean
  holder: { supervisorPid: number; supervisorProcStart: number } | null
  eperm: boolean
}> {
  const existing = await readLockfile()
  if (!existing) {
    return { stopped: false, holder: null, eperm: false }
  }
  if (!isPidAlive(existing.supervisorPid)) {
    // Already dead — clear the lockfile.
    await releaseLockfile({
      supervisorPid: existing.supervisorPid,
      supervisorProcStart: existing.supervisorProcStart,
    }).catch(() => {})
    return { stopped: true, holder: existing, eperm: false }
  }

  let eperm = false
  try {
    process.kill(existing.supervisorPid, 'SIGTERM')
  } catch (err: any) {
    if (err?.code === 'EPERM') {
      eperm = true
      console.error('could not restart supervisor (EPERM)')
      // daemon_ensure_zombie_kill — escalate.
      await ensureZombieKill(existing.supervisorPid, 4000)
    }
  }

  // Wait for graceful exit.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isPidAlive(existing.supervisorPid)) break
    await new Promise(r => setTimeout(r, 200))
  }

  if (isPidAlive(existing.supervisorPid)) {
    // Refused.
    console.error('existing daemon refused to yield')
    return { stopped: false, holder: existing, eperm }
  }

  await releaseLockfile({
    supervisorPid: existing.supervisorPid,
    supervisorProcStart: existing.supervisorProcStart,
  }).catch(() => {})
  return { stopped: true, holder: existing, eperm }
}

/**
 * displaceAny — `claude daemon stop --any` path. Displaces the holder
 * regardless of identity and reports on it.
 */
export async function displaceAny(): Promise<{ displaced: boolean; holder: any }> {
  return displaceHolder()
}

/**
 * Run the supervisor main loop. Called by daemonMain() in main.ts.
 *
 * @param args  the argv slice after `daemon` (e.g. ['start'] or ['restart'])
 */
export async function runSupervisor(args: string[]): Promise<void> {
  const sub = args[0] ?? 'start'
  const identity = buildIdentity()

  logEvent('tengu_bg_supervisor_start', {
    sub: sub as any,
    coldStart: getDaemonColdStart() as any,
  })

  // 1. binary-identity check
  const binaryErr = checkBinaryIdentity()
  if (binaryErr) {
    console.error(binaryErr)
    logEvent('tengu_bg_supervisor_binary_bad', { reason: binaryErr as any })
    process.exit(1)
  }

  // 2. acquire lockfile
  const acquired = await acquireLockfile(identity)
  if (!acquired) {
    // Either displaced (yielding) or refused. If there's a live holder, the
    // acquireLockfile path already printed "displaced, yielding".
    if (await holderRefusesToYield()) {
      console.error('existing daemon refused to yield')
    }
    process.exit(0)
  }

  // 3. recover orphaned workers from a previous supervisor exit
  const orphanCount = recoverOrphanedWorkers()
  void orphanCount

  // 4. read + validate daemon.json
  const config = readDaemonJson()
  const warnings = validateDaemonJsonWorkers(config)
  for (const w of warnings) {
    console.warn(w)
  }

  // 5. signal handlers
  let shutdownCause: ShutdownCause | null = null
  const handleSignal = (signal: 'SIGTERM' | 'SIGINT', cause: ShutdownCause) => {
    if (shutdownCause) return
    shutdownCause = cause
    shutdown(cause).catch(() => process.exit(0))
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM', 'sigterm'))
  process.on('SIGINT', () => handleSignal('SIGINT', 'sigint'))

  // 6. sweep loop
  running = true
  const startedAt = Date.now()
  let lastActivityAt = startedAt
  let lastSweepAt = 0

  console.log(
    `[daemon] supervisor pid=${identity.supervisorPid} start=${identity.supervisorProcStart} coldStart=${getDaemonColdStart()}`,
  )

  while (running) {
    const now = Date.now()
    if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
      lastSweepAt = now
      const alive = await sweepWorkers(config)
      if (alive > 0) {
        lastActivityAt = now
      }
      const idleMs = now - lastActivityAt
      if (alive === 0 && idleMs >= IDLE_SHUTDOWN_MS) {
        // "idle Ns with no workers"
        const idleSec = Math.round(idleMs / 1000)
        console.log(`idle ${idleSec}s with no workers`)
        await shutdown('idle')
        break
      }
    }
    await new Promise(r => setTimeout(r, 500))
  }

  async function shutdown(cause: ShutdownCause): Promise<void> {
    running = false
    const uptime = Date.now() - startedAt
    const uptimeS = Math.round(uptime / 1000)
    console.log(`shutting down (cause=${cause}, uptime=${uptimeS}s)`)
    logEvent('tengu_bg_supervisor_shutdown', {
      cause: cause as any,
      uptimeS,
    })
    await stopAllWorkers(3000)
    await releaseLockfile({
      supervisorPid: identity.supervisorPid,
      supervisorProcStart: identity.supervisorProcStart,
    }).catch(() => {})
    process.exit(0)
  }
}

/**
 * `claude daemon install` — install the persistent service (launchd/systemd).
 */
export async function daemonInstall(): Promise<void> {
  const msg = installPersistentService()
  console.log(msg)
}

/**
 * `claude daemon uninstall` — remove the persistent service.
 */
export async function daemonUninstall(): Promise<void> {
  // Also stop a running supervisor before removing the unit.
  await stopExistingSupervisor().catch(() => {})
  const msg = uninstallPersistentService()
  console.log(msg)
}

/**
 * `claude daemon restart` — stop the existing supervisor, then start fresh.
 */
export async function daemonRestart(): Promise<void> {
  await stopExistingSupervisor().catch(() => {})
  // The caller (CLI handler) will re-invoke `daemon start` as a fresh process,
  // or we can runSupervisor in-process here. For faithful behavior we exit
  // and let the persistent service (or the user) start it again.
  console.log('supervisor restarting')
  process.exit(0)
}
