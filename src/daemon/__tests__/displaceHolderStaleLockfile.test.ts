/**
 * CC 2.1.216 #11 — `claude daemon stop --any` stale legacy lockfile guard.
 *
 * Characterization test (ALREADY DONE): OCC's `displaceHolder()` (the
 * `stop --any` path) validates the lockfile PID against the recorded
 * `supervisorProcStart` (process start time) BEFORE issuing a kill signal.
 * A stale lockfile whose PID was recycled by an unrelated process fails
 * the `startMatches` check and is treated as "already gone" — the lockfile
 * is cleared and NO kill signal is sent. This prevents terminating an
 * unrelated process.
 *
 * This test documents/locks that existing guard so a future refactor
 * cannot silently remove it.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Mutable mock state ----------------------------------------------------
let mockIsPidAlive: (pid: number) => boolean
let mockGetProcessStartMs: (pid: number) => number | null
let tmpConfigHome: string
let killCalls: Array<{ pid: number; signal?: string | number }>
let savedConfigDir: string | undefined

// `process.js` is a daemon-local dependency (only daemon modules import it);
// stubbing the live pid/start-time helpers is local + benign + does not leak
// into other test files' surfaces.
mock.module('../process.js', () => ({
  isPidAlive: (pid: number) => mockIsPidAlive(pid),
  getProcessStartMs: (pid: number) => mockGetProcessStartMs(pid),
  pidRecycled: (pid: number, startedAt: number) => {
    if (!mockIsPidAlive(pid)) return false
    const actual = mockGetProcessStartMs(pid)
    if (actual === null) return false
    return actual > startedAt + 2000
  },
  sigtermWorker: () => {},
}))

// Redirect the lockfile to a temp dir via CLAUDE_CONFIG_DIR (memoized keyed
// on the env var, so a fresh value is computed without a module mock that
// could leak into other test files in the shared bun process).
const { displaceHolder, getDaemonLockfilePath } = await import(
  '../lockfile.js'
)

const ORIGINAL_KILL = process.kill

describe('CC 2.1.216 #11 — daemon stop --any stale-lockfile guard', () => {
  beforeEach(() => {
    tmpConfigHome = mkdtempSync(join(tmpdir(), 'occ-daemon-stale-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpConfigHome
    killCalls = []
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal })
      return true
    }) as typeof process.kill
  })

  afterEach(() => {
    process.kill = ORIGINAL_KILL
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    try {
      rmSync(tmpConfigHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  /** Write a lockfile with the given PID + procStart. */
  function writeLockfile(pid: number, procStart: number): void {
    writeFileSync(
      getDaemonLockfilePath(),
      JSON.stringify({ supervisorPid: pid, supervisorProcStart: procStart, holderPid: pid }),
      'utf-8',
    )
  }

  test('does NOT kill a recycled PID whose start time mismatches (stale lockfile)', async () => {
    // Lockfile says pid=99999 started at T=1000. But the process now
    // occupying pid 99999 started at T=500000 — a different, unrelated
    // process (PID was recycled).
    writeLockfile(99999, 1000)
    mockIsPidAlive = () => true // pid 99999 is alive (but it's a different process)
    mockGetProcessStartMs = () => 500000 // actual start ≠ recorded 1000

    const res = await displaceHolder()

    // Treated as "already gone" — lockfile cleared, no kill signal sent.
    expect(killCalls.length).toBe(0)
    expect(res.displaced).toBe(true)
    expect(res.holder).not.toBeNull()
    // Lockfile was removed (releaseLockfile).
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('does NOT kill when getProcessStartMs is unresolvable (fail-safe)', async () => {
    // Lockfile says pid=88888 started at T=2000. The pid is alive but we
    // can't determine its start time (e.g. platform without `ps`).
    // Must fail SAFE — no kill, just clear the lockfile.
    writeLockfile(88888, 2000)
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => null

    const res = await displaceHolder()

    expect(killCalls.length).toBe(0)
    expect(res.displaced).toBe(true)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('does NOT kill a dead PID (already gone)', async () => {
    writeLockfile(77777, 3000)
    mockIsPidAlive = () => false // process is dead
    mockGetProcessStartMs = () => 3000

    const res = await displaceHolder()

    expect(killCalls.length).toBe(0)
    expect(res.displaced).toBe(true)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('DOES kill when the PID is alive and start time matches (genuine holder)', async () => {
    // The lockfile's PID is alive AND its start time matches the recorded
    // supervisorProcStart — this is the genuine daemon holder. Kill it.
    writeLockfile(55555, 4000)
    // The holder "dies" after the first SIGTERM — flip isPidAlive to false
    // once the kill signal lands so displaceHolder's graceful-exit poll
    // resolves immediately (avoids the 5s wait).
    let killed = false
    mockIsPidAlive = () => !killed
    mockGetProcessStartMs = () => 4000 // matches (within tolerance)
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal })
      if (signal === 'SIGTERM' || signal === undefined) killed = true
      return true
    }) as typeof process.kill

    const res = await displaceHolder()

    // Kill signal was sent to the genuine holder.
    expect(killCalls.length).toBeGreaterThan(0)
    expect(killCalls[0]!.pid).toBe(55555)
    expect(res.displaced).toBe(true)
  })

  test('returns displaced=false, holder=null when no lockfile exists', async () => {
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => Date.now()

    const res = await displaceHolder()

    expect(res.displaced).toBe(false)
    expect(res.holder).toBeNull()
    expect(killCalls.length).toBe(0)
  })
})
