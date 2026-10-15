/**
 * CC 2.1.300 #43 — `daemon stop --any` post-SIGKILL liveness re-check.
 *
 * Official fix: stop no longer claims success while a stuck service keeps
 * running — it waits, force-kills, re-checks liveness, and reports failure
 * with exit 1 if the holder survives.
 *
 * Byte evidence (v300 ELF, /tmp/cc-diff-300; v299 counts in parens):
 *   @111238440 `force-killing it (SIGKILL)` (0)
 *   @111238886 `outlives SIGKILL` (0)
 *   @111240268 `daemon_stop_still_running` (0)
 *   @111240672 `daemon_stop_holder_is_init` (0)
 *   @111240708 `daemon_stop_holder_unverified` (pre-existing for install)
 *   Official flow @111238330-@111240268: SIGTERM → wait → SIGKILL →
 *   liveness re-check (`jt`): verified-alive → "timed-out" (survived);
 *   alive-but-unreadable identity → "unverified"; never signals pid 1.
 *
 * Contract under test (displaceHolder result):
 *   { displaced, survived, unverified, eperm, isInit, holder }
 *   - survived: still alive (identity verified) after SIGKILL → lockfile kept
 *   - survived+unverified: alive after SIGKILL but identity unreadable
 *   - unverified (alone): alive before any signal but identity unreadable →
 *     NOT signalled (fail-safe), lockfile kept
 *   - eperm: holder belongs to another user → not signalled further
 *   - isInit: holder pid is 1 → never signalled
 */
import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Mutable mock state ----------------------------------------------------
let mockIsPidAlive: (pid: number) => boolean
let mockGetProcessStartMs: (pid: number) => number | null
let tmpConfigHome: string
let killCalls: Array<{ pid: number; signal?: string | number }>
let killImpl: ((pid: number, signal?: string | number) => void) | null
let savedConfigDir: string | undefined
let errLines: string[]
let errSpy: ReturnType<typeof spyOn>

// Same local seam as displaceHolderStaleLockfile.test.ts: stub the daemon-local
// pid helpers (module is only imported by daemon modules; benign + no leak).
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

const { displaceHolder, getDaemonLockfilePath } = await import('../lockfile.js')

const ORIGINAL_KILL = process.kill
const HOLDER_PID = 424242
const PROC_START = 1_700_000_000_000

/** Fast waits — the defaults (5s SIGTERM grace) are for production only. */
const FAST_OPTS = { sigtermGraceMs: 300, sigkillSettleMs: 30 }

describe('CC 2.1.300 #43 — displaceHolder post-SIGKILL liveness re-check', () => {
  beforeEach(() => {
    tmpConfigHome = mkdtempSync(join(tmpdir(), 'occ-daemon-300-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpConfigHome
    killCalls = []
    killImpl = null
    errLines = []
    errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '))
    })
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal })
      killImpl?.(pid, signal)
      return true
    }) as typeof process.kill
  })

  afterEach(() => {
    process.kill = ORIGINAL_KILL
    errSpy.mockRestore()
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

  function writeLockfile(pid: number, procStart: number): void {
    writeFileSync(
      getDaemonLockfilePath(),
      JSON.stringify({ supervisorPid: pid, supervisorProcStart: procStart, holderPid: pid }),
      'utf-8',
    )
  }

  function signalsSent(): Array<string | number | undefined> {
    return killCalls.filter(c => c.pid === HOLDER_PID).map(c => c.signal)
  }

  test('holder that OUTLIVES SIGKILL → survived:true, displaced:false, lockfile kept', async () => {
    // Arrange: genuine holder (start time matches) that ignores every signal.
    writeLockfile(HOLDER_PID, PROC_START)
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => PROC_START

    // Act
    const res = await displaceHolder(FAST_OPTS)

    // Assert: SIGTERM then SIGKILL were sent, but success is NOT claimed.
    expect(signalsSent()).toContain('SIGTERM')
    expect(signalsSent()).toContain('SIGKILL')
    expect(res.displaced).toBe(false)
    expect(res.survived).toBe(true)
    expect(res.unverified).toBe(false)
    expect(res.holder?.supervisorPid).toBe(HOLDER_PID)
    // Lockfile stays — the holder still owns it (official keeps it too).
    expect(existsSync(getDaemonLockfilePath())).toBe(true)
    // Official force-kill note (@111238440) is announced as it happens.
    expect(
      errLines.some(l =>
        l.includes(`(pid=${HOLDER_PID}) is still running; force-killing it (SIGKILL)`),
      ),
    ).toBe(true)
  })

  test('holder that dies on SIGKILL → displaced:true, survived:false, lockfile cleared', async () => {
    // Arrange: ignores SIGTERM, dies on SIGKILL.
    writeLockfile(HOLDER_PID, PROC_START)
    let sigkilled = false
    mockIsPidAlive = () => !sigkilled
    mockGetProcessStartMs = () => PROC_START
    killImpl = (_pid, signal) => {
      if (signal === 'SIGKILL') sigkilled = true
    }

    // Act
    const res = await displaceHolder(FAST_OPTS)

    // Assert
    expect(signalsSent()).toContain('SIGTERM')
    expect(signalsSent()).toContain('SIGKILL')
    expect(res.displaced).toBe(true)
    expect(res.survived).toBe(false)
    expect(res.unverified).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('holder dies on SIGTERM alone → displaced:true, no SIGKILL sent', async () => {
    writeLockfile(HOLDER_PID, PROC_START)
    let termed = false
    mockIsPidAlive = () => !termed
    mockGetProcessStartMs = () => PROC_START
    killImpl = (_pid, signal) => {
      if (signal === 'SIGTERM') termed = true
    }

    const res = await displaceHolder(FAST_OPTS)

    expect(signalsSent()).toEqual(['SIGTERM'])
    expect(res.displaced).toBe(true)
    expect(res.survived).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('alive after SIGKILL but identity unreadable → survived:true AND unverified:true', async () => {
    // Official `jt`: after SIGKILL, if the command line can no longer be read
    // while the pid is alive → "unverified" (variant-2 message territory).
    writeLockfile(HOLDER_PID, PROC_START)
    mockIsPidAlive = () => true
    let startReadable = true
    mockGetProcessStartMs = () => (startReadable ? PROC_START : null)
    killImpl = (_pid, signal) => {
      if (signal === 'SIGKILL') startReadable = false
    }

    const res = await displaceHolder(FAST_OPTS)

    expect(res.displaced).toBe(false)
    expect(res.survived).toBe(true)
    expect(res.unverified).toBe(true)
    expect(existsSync(getDaemonLockfilePath())).toBe(true)
  })

  test('alive before any signal but identity unreadable → unverified, NOT signalled', async () => {
    // Fail-safe (pre-existing guard) + CC 2.1.300 #43: no longer claims
    // displaced — the official holder-unverified path does not signal and
    // keeps the lockfile ("so it was not signalled" @104541844 family).
    writeLockfile(HOLDER_PID, PROC_START)
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => null

    const res = await displaceHolder(FAST_OPTS)

    expect(killCalls.length).toBe(0)
    expect(res.displaced).toBe(false)
    expect(res.survived).toBe(false)
    expect(res.unverified).toBe(true)
    expect(existsSync(getDaemonLockfilePath())).toBe(true)
  })

  test('SIGTERM throws EPERM (foreign user) → eperm:true, no further signals', async () => {
    writeLockfile(HOLDER_PID, PROC_START)
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => PROC_START
    killImpl = () => {
      const err = new Error('EPERM: operation not permitted') as Error & { code: string }
      err.code = 'EPERM'
      throw err
    }

    const res = await displaceHolder(FAST_OPTS)

    expect(res.eperm).toBe(true)
    expect(res.displaced).toBe(false)
    expect(res.survived).toBe(false)
    expect(signalsSent()).toEqual(['SIGTERM']) // gave up after EPERM — no SIGKILL
    expect(existsSync(getDaemonLockfilePath())).toBe(true)
  })

  test('holder pid 1 → isInit:true, never signalled, lockfile kept', async () => {
    // Official: "this command never signals pid 1" (@111240364) +
    // analytics daemon_stop_holder_is_init (@111240672).
    writeLockfile(1, PROC_START)
    mockIsPidAlive = () => true
    mockGetProcessStartMs = () => PROC_START

    const res = await displaceHolder(FAST_OPTS)

    expect(killCalls.length).toBe(0)
    expect(res.isInit).toBe(true)
    expect(res.displaced).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(true)
  })

  test('SIGTERM throws ESRCH (died mid-check) → displaced:true, lockfile cleared', async () => {
    writeLockfile(HOLDER_PID, PROC_START)
    let dead = false
    mockIsPidAlive = () => !dead
    mockGetProcessStartMs = () => PROC_START
    killImpl = (_pid, signal) => {
      if (signal === 'SIGTERM') {
        dead = true
        const err = new Error('ESRCH: no such process') as Error & { code: string }
        err.code = 'ESRCH'
        throw err
      }
    }

    const res = await displaceHolder(FAST_OPTS)

    expect(res.displaced).toBe(true)
    expect(res.eperm).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  })

  test('each call returns a fresh result object (no shared mutable state)', async () => {
    writeLockfile(HOLDER_PID, PROC_START)
    mockIsPidAlive = () => false
    mockGetProcessStartMs = () => PROC_START

    const first = await displaceHolder(FAST_OPTS)

    // Second call: lockfile is gone now → distinct "no holder" result.
    const second = await displaceHolder(FAST_OPTS)

    expect(first).not.toBe(second)
    expect(first.displaced).toBe(true)
    expect(first.holder?.supervisorPid).toBe(HOLDER_PID)
    expect(second.displaced).toBe(false)
    expect(second.holder).toBeNull()
  })
})
