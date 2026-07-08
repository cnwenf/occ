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
 * Sends SIGTERM to the holder's supervisor pid, waits briefly, escalates to
 * SIGKILL if still alive. Returns a description of the holder for reporting.
 */
export async function displaceHolder(): Promise<{
  displaced: boolean
  holder: LockfileContents | null
}> {
  const existing = await readLockfile()
  if (!existing) {
    return { displaced: false, holder: null }
  }

  const holderStartMs = getProcessStartMs(existing.supervisorPid)
  const startMatches =
    holderStartMs !== null && Math.abs(holderStartMs - existing.supervisorProcStart) < 2000

  if (!isPidAlive(existing.supervisorPid) || !startMatches) {
    // Already gone — just clear the lockfile.
    await releaseLockfile({
      supervisorPid: existing.supervisorPid,
      supervisorProcStart: existing.supervisorProcStart,
    }).catch(() => {})
    return { displaced: true, holder: existing }
  }

  // SIGTERM the holder supervisor.
  try {
    process.kill(existing.supervisorPid, 'SIGTERM')
  } catch {
    /* already dead */
  }

  // Wait up to ~5s for graceful exit.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isPidAlive(existing.supervisorPid)) break
    await new Promise(r => setTimeout(r, 200))
  }

  // Escalate to SIGKILL if still alive.
  if (isPidAlive(existing.supervisorPid)) {
    try {
      process.kill(existing.supervisorPid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    await new Promise(r => setTimeout(r, 300))
  }

  await releaseLockfile({
    supervisorPid: existing.supervisorPid,
    supervisorProcStart: existing.supervisorProcStart,
  }).catch(() => {})

  return { displaced: true, holder: existing }
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
