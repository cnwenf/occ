/**
 * pid-holder lockfile for the B daemon supervisor.
 *
 * Path: ~/.claude/daemon.lock
 *
 * The lockfile holds { supervisorPid, supervisorProcStart, holderPid }.
 * On contention the loser prints:
 *   "lockfile now held by pid=X — displaced, yielding"
 * and yields. `claude daemon stop --any` displaces the holder (SIGTERM) and
 * reports on it.
 *
 * All fs ops use the real node fs module (the lockfile is a single small
 * JSON file; no need for the FsOperations abstraction).
 */

import { open, readFile, unlink, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import type { LockfileContents, SupervisorIdentity } from './types.js'
import { isPidAlive, getProcessStartMs } from './process.js'

/** Where the lockfile lives. */
export function getDaemonLockfilePath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.lock')
}

/**
 * Read the current lockfile, or null if absent / unreadable.
 * Returns the parsed contents on success.
 */
export async function readLockfile(): Promise<LockfileContents | null> {
  const path = getDaemonLockfilePath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = await readFile(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as LockfileContents
    if (
      typeof parsed?.supervisorPid !== 'number' ||
      typeof parsed?.supervisorProcStart !== 'number'
    ) {
      return null
    }
    return {
      supervisorPid: parsed.supervisorPid,
      supervisorProcStart: parsed.supervisorProcStart,
      holderPid: typeof parsed.holderPid === 'number' ? parsed.holderPid : parsed.supervisorPid,
      remoteControlToken:
        typeof parsed.remoteControlToken === 'string' ? parsed.remoteControlToken : undefined,
      remoteControlSocketPath:
        typeof parsed.remoteControlSocketPath === 'string'
          ? parsed.remoteControlSocketPath
          : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Atomically acquire the lockfile for the given supervisor identity.
 *
 * Uses O_EXCL (open 'ax') so two supervisors racing for the lock cannot both
 * win. If the lock is held by a live process that does NOT match our identity,
 * we are "displaced" and yield (return false). If the holder is dead, we steal
 * the lock.
 *
 * Returns true if we now hold the lock.
 */
export async function acquireLockfile(identity: SupervisorIdentity): Promise<boolean> {
  const path = getDaemonLockfilePath()
  // Ensure parent dir exists.
  const { mkdir } = await import('fs/promises')
  await mkdir(getClaudeConfigHomeDir(), { recursive: true }).catch(() => {})

  // Fast path: no existing lockfile — create atomically.
  if (!existsSync(path)) {
    try {
      const fh = await open(path, 'ax')
      const contents: LockfileContents = {
        supervisorPid: identity.supervisorPid,
        supervisorProcStart: identity.supervisorProcStart,
        holderPid: identity.supervisorPid,
      }
      await fh.writeFile(JSON.stringify(contents), { encoding: 'utf-8' })
      await fh.close()
      return true
    } catch (err: any) {
      // EEXIST means a race loser — fall through to contention handling.
      if (err?.code !== 'EEXIST') {
        // Some other error — give up rather than corrupt state.
        return false
      }
    }
  }

  // Lockfile exists — check if the holder is alive and is really our supervisor.
  const existing = await readLockfile()
  if (!existing) {
    // Corrupt lockfile — steal it.
    try {
      await unlink(path)
    } catch {
      /* ignore */
    }
    return acquireLockfile(identity)
  }

  // Is the holder us (same pid + procStart)? Then we already hold it.
  if (
    existing.supervisorPid === identity.supervisorPid &&
    existing.supervisorProcStart === identity.supervisorProcStart
  ) {
    return true
  }

  // Is the holder alive? Use the procStart to guard against pid recycling.
  const holderAlive = isPidAlive(existing.supervisorPid)
  const holderStartMs = getProcessStartMs(existing.supervisorPid)
  const startMatches =
    holderStartMs !== null && Math.abs(holderStartMs - existing.supervisorProcStart) < 2000

  if (holderAlive && startMatches) {
    // Genuine contention — yield.
    console.log(
      `lockfile now held by pid=${existing.supervisorPid} — displaced, yielding`,
    )
    return false
  }

  // Holder is dead (or pid was recycled) — steal the lock.
  try {
    await unlink(path)
  } catch {
    /* ignore */
  }
  try {
    const fh = await open(path, 'ax')
    const contents: LockfileContents = {
      supervisorPid: identity.supervisorPid,
      supervisorProcStart: identity.supervisorProcStart,
      holderPid: identity.supervisorPid,
    }
    await fh.writeFile(JSON.stringify(contents), { encoding: 'utf-8' })
    await fh.close()
    return true
  } catch {
    return false
  }
}

/**
 * Release the lockfile if we still hold it. Called on supervisor shutdown.
 */
export async function releaseLockfile(identity: SupervisorIdentity): Promise<void> {
  const existing = await readLockfile()
  if (!existing) return
  if (
    existing.supervisorPid === identity.supervisorPid &&
    existing.supervisorProcStart === identity.supervisorProcStart
  ) {
    try {
      await unlink(getDaemonLockfilePath())
    } catch {
      /* ignore */
    }
  }
}

/**
 * Update the lockfile with remote-control connection details (B7).
 *
 * Called by the supervisor after it starts the RC server: writes the auth
 * token + socket path back into the lockfile so clients (mobile, Slack,
 * `claude remote-control`) can discover how to connect. Only the current
 * holder may update it.
 */
export async function updateLockfileRemoteControl(
  identity: SupervisorIdentity,
  token: string,
  socketPath: string,
): Promise<void> {
  const existing = await readLockfile()
  if (!existing || existing.supervisorPid !== identity.supervisorPid) {
    return
  }
  const updated: LockfileContents = {
    ...existing,
    remoteControlToken: token,
    remoteControlSocketPath: socketPath,
  }
  try {
    await writeFile(getDaemonLockfilePath(), JSON.stringify(updated), {
      encoding: 'utf-8',
    })
  } catch {
    // best-effort — clients fall back to no RC info
  }
}

/**
 * Displace the current holder (used by `claude daemon stop --any`).
 *
 * CC 2.1.300 #43: the official stop flow is SIGTERM → wait → SIGKILL →
 * liveness RE-CHECK — success is claimed only once the holder is really
 * gone (binary @111238330-@111240268). The result therefore distinguishes:
 *   - displaced:  holder gone (or was already dead / pid recycled), lock cleared
 *   - survived:   holder is STILL alive after SIGKILL ("outlives SIGKILL")
 *   - unverified: holder alive but its identity could not be verified, so it
 *                 was not signalled at all (fail-safe; official "could not be
 *                 verified as the daemon, so it was not signalled" family) —
 *                 or, combined with survived, alive after SIGKILL with an
 *                 unreadable identity (official variant-2 message)
 *   - eperm:      holder belongs to another user (EPERM) — not signalable
 *   - isInit:     holder pid is 1 — this command never signals pid 1
 * The lockfile is kept in every failure case: the holder still owns it.
 */

/** How long to wait for a graceful SIGTERM exit before escalating. */
const SIGTERM_GRACE_MS = 5000
/** Settle window after SIGKILL before the liveness re-check. */
const SIGKILL_SETTLE_MS = 300
/** Liveness poll interval during the SIGTERM grace window. */
const LIVENESS_POLL_MS = 200
/** Tolerance when comparing recorded vs actual process start times. */
const PROC_START_TOLERANCE_MS = 2000

/** Immutable outcome of a `displaceHolder()` attempt. */
export interface DisplaceHolderResult {
  readonly displaced: boolean
  readonly survived: boolean
  readonly unverified: boolean
  readonly eperm: boolean
  readonly isInit: boolean
  readonly holder: LockfileContents | null
}

/** Test-tunable timing overrides; production uses the constants above. */
export interface DisplaceHolderOptions {
  readonly sigtermGraceMs?: number
  readonly sigkillSettleMs?: number
}

function displaceResult(
  outcome: Partial<Omit<DisplaceHolderResult, 'holder'>>,
  holder: LockfileContents | null,
): DisplaceHolderResult {
  return {
    displaced: false,
    survived: false,
    unverified: false,
    eperm: false,
    isInit: false,
    ...outcome,
    holder,
  }
}

function startMsMatches(actual: number | null, recorded: number): boolean {
  return actual !== null && Math.abs(actual - recorded) < PROC_START_TOLERANCE_MS
}

function isEperm(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'EPERM'
}

export async function displaceHolder(
  opts: DisplaceHolderOptions = {},
): Promise<DisplaceHolderResult> {
  const sigtermGraceMs = opts.sigtermGraceMs ?? SIGTERM_GRACE_MS
  const sigkillSettleMs = opts.sigkillSettleMs ?? SIGKILL_SETTLE_MS
  const existing = await readLockfile()
  if (!existing) {
    return displaceResult({}, null)
  }

  const pid = existing.supervisorPid
  const identity = {
    supervisorPid: pid,
    supervisorProcStart: existing.supervisorProcStart,
  }

  // Never signal pid 1 (official `daemon_stop_holder_is_init` guard).
  if (pid === 1) {
    return displaceResult({ isInit: true }, existing)
  }

  // Already gone — just clear the lockfile.
  if (!isPidAlive(pid)) {
    await releaseLockfile(identity).catch(() => {})
    return displaceResult({ displaced: true }, existing)
  }

  // Alive: verify identity via process start time before signalling.
  const holderStartMs = getProcessStartMs(pid)
  if (holderStartMs === null) {
    // Unverifiable liveness/identity — fail safe: do NOT signal, do NOT
    // claim success, keep the lockfile (CC 2.1.300 #43).
    return displaceResult({ unverified: true }, existing)
  }
  if (!startMsMatches(holderStartMs, existing.supervisorProcStart)) {
    // Pid was recycled by an unrelated process — our holder is gone.
    await releaseLockfile(identity).catch(() => {})
    return displaceResult({ displaced: true }, existing)
  }

  // SIGTERM the holder supervisor.
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err: unknown) {
    if (isEperm(err)) {
      // Foreign-user holder — official: "it belongs to another user, so
      // this account cannot signal it … No sessions were ended."
      return displaceResult({ eperm: true }, existing)
    }
    // ESRCH — died between the liveness check and the signal; fall through
    // to the cleanup below.
  }

  // Wait for graceful exit.
  const deadline = Date.now() + sigtermGraceMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break
    await new Promise(r => setTimeout(r, LIVENESS_POLL_MS))
  }

  // Escalate to SIGKILL if still alive — and SAY SO (official note
  // "… is still running; force-killing it (SIGKILL)" @111238440).
  if (isPidAlive(pid)) {
    console.error(`note: the daemon (pid=${pid}) is still running; force-killing it (SIGKILL)`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err: unknown) {
      if (isEperm(err)) {
        return displaceResult({ eperm: true }, existing)
      }
      /* ESRCH — killed by someone else / just exited; re-check below. */
    }
    await new Promise(r => setTimeout(r, sigkillSettleMs))

    // CC 2.1.300 #43: re-check liveness after SIGKILL instead of assuming
    // displacement (process.ts ensureZombieKill pattern).
    if (isPidAlive(pid)) {
      const startAfterKill = getProcessStartMs(pid)
      return displaceResult(
        { survived: true, unverified: !startMsMatches(startAfterKill, existing.supervisorProcStart) },
        existing,
      )
    }
  }

  await releaseLockfile(identity).catch(() => {})
  return displaceResult({ displaced: true }, existing)
}

/**
 * Whether a lockfile currently exists on disk (does not check liveness).
 * Used by `claude daemon status` for a quick "is there a lockfile?" check.
 */
export function lockfileExists(): boolean {
  return existsSync(getDaemonLockfilePath())
}

/** Stat mtime of the lockfile, for status display. */
export function lockfileMtime(): number | null {
  try {
    return statSync(getDaemonLockfilePath()).mtimeMs
  } catch {
    return null
  }
}
