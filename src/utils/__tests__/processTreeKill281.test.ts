/**
 * claude-code 2.1.281 #050 — auth-refresh process-tree watchdog.
 *
 * These are REAL e2e process tests (no mocks): each spawns a genuine
 * `sh -c 'sleep 30 & wait'` child whose backgrounded `sleep` is a grandchild in
 * the same session — exactly the orphan-prone shape that wedged v280 (a detached
 * `aws sso`/gcloud helper surviving the direct-child kill and holding the
 * localhost OAuth callback port). We assert the whole tree dies.
 *
 * "Dead" is checked via /proc state (zombie 'Z' counts as gone) so the assertion
 * is robust whether or not the container reaps orphans promptly.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'child_process'
import { readFileSync } from 'fs'

import {
  DEFAULT_WATCHDOG_TIMEOUT_MS,
  enumerateDescendants,
  killProcessTree,
  parseProcStat,
  ProcessTreeWatchdog,
  registerShutdownHook,
} from '../processTreeKill.js'

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const tracked: ChildProcess[] = []

/** Spawn a shell that backgrounds a long sleep then waits on it. */
function spawnSleeper(): ChildProcess {
  const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' })
  tracked.push(child)
  return child
}

/** True once `pid` is gone OR is a zombie (effectively dead, awaiting reap). */
function pidGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]
    return state === 'Z'
  } catch {
    return true // no /proc entry => gone
  }
}

async function waitForGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pidGone(pid)) {
      return true
    }
    await sleep(20)
  }
  return pidGone(pid)
}

async function waitForDescendants(
  pid: number,
  timeoutMs = 4000,
): Promise<Set<number>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const descendants = enumerateDescendants(pid, { sameSession: true })
    if (descendants.size > 0) {
      return descendants
    }
    await sleep(20)
  }
  return enumerateDescendants(pid, { sameSession: true })
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.once('exit', () => resolve())
  })
}

afterEach(async () => {
  // Best-effort cleanup so a mid-test failure never leaks a `sleep 30`.
  while (tracked.length > 0) {
    const child = tracked.pop()
    if (child && child.pid !== undefined && !pidGone(child.pid)) {
      killProcessTree(child, 'SIGKILL')
    }
  }
  await sleep(30)
})

describe('parseProcStat', () => {
  test('parses ppid and session from a real /proc/self/stat line', () => {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const row = parseProcStat(stat)
    expect(row).not.toBeNull()
    // Our parent pid must be a positive integer (the test runner).
    expect(row!.ppid).toBeGreaterThan(0)
    expect(Number.isFinite(row!.session)).toBe(true)
  })

  test('returns null on a malformed line with no closing paren', () => {
    expect(parseProcStat('1234 (broken')).toBeNull()
  })

  test('handles a comm field containing spaces and parens', () => {
    // "(my proc) S 100 100 55 ..." — split must happen after the LAST ')'.
    const row = parseProcStat('999 (my (weird) proc) S 100 100 55 0 -1 4194560')
    expect(row).toEqual({ ppid: 100, session: 55 })
  })
})

describe('enumerateDescendants', () => {
  test('finds the backgrounded grandchild of a real shell (same session)', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    const descendants = await waitForDescendants(pid)
    // The `sleep 30` grandchild must be enumerated.
    expect(descendants.size).toBeGreaterThan(0)
    // The root itself is never included.
    expect(descendants.has(pid)).toBe(false)
    killProcessTree(child, 'SIGKILL')
    await onceExit(child)
  }, 15000)

  test('sameSession filter walks only descendants, never the parent chain', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    await waitForDescendants(pid)
    const descendants = enumerateDescendants(pid, { sameSession: true })
    // Our own test-runner pid must never appear (it is an ancestor, not a descendant).
    expect(descendants.has(process.pid)).toBe(false)
    killProcessTree(child, 'SIGKILL')
    await onceExit(child)
  }, 15000)
})

describe('killProcessTree (#050)', () => {
  test('kills the whole tree — the orphaned grandchild sleep does not survive', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    const descendants = await waitForDescendants(pid)
    expect(descendants.size).toBeGreaterThan(0)
    const grandchildPids = [...descendants]

    killProcessTree(child, 'SIGTERM')
    await onceExit(child)

    // Child gone.
    expect(await waitForGone(pid)).toBe(true)
    // EVERY descendant gone — this is the regression v280 had (orphan survived).
    for (const gpid of grandchildPids) {
      expect(await waitForGone(gpid)).toBe(true)
    }
  }, 15000)

  test('is a safe no-op for an already-exited child', async () => {
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    tracked.push(child)
    await onceExit(child)
    // Should not throw even though the process is already reaped.
    expect(() => killProcessTree(child, 'SIGTERM')).not.toThrow()
  }, 15000)
})

describe('ProcessTreeWatchdog (#050)', () => {
  test('default timeout constant is 3 minutes (180000ms), matching v281', () => {
    expect(DEFAULT_WATCHDOG_TIMEOUT_MS).toBe(180_000)
  })

  test('timeout kills the process tree and records reason=timeout', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    const descendants = await waitForDescendants(pid)
    const grandchildPids = [...descendants]

    const watchdog = new ProcessTreeWatchdog(child, { timeoutMs: 150 })
    await onceExit(child)

    expect(watchdog.killReason).toBe('timeout')
    expect(await waitForGone(pid)).toBe(true)
    for (const gpid of grandchildPids) {
      expect(await waitForGone(gpid)).toBe(true)
    }
  }, 15000)

  test('abort signal kills silently with reason=abort (no timeout wait)', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    await waitForDescendants(pid)

    const controller = new AbortController()
    // Long timeout — only the abort should trigger the kill, and promptly.
    const watchdog = new ProcessTreeWatchdog(child, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    const started = Date.now()
    controller.abort()
    await onceExit(child)

    expect(watchdog.killReason).toBe('abort')
    // Killed by abort well before the 60s timeout.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await waitForGone(pid)).toBe(true)
  }, 15000)

  test('an already-aborted signal kills immediately at construction', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    await waitForDescendants(pid)

    const controller = new AbortController()
    controller.abort()
    const watchdog = new ProcessTreeWatchdog(child, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    expect(watchdog.killReason).toBe('abort')
    await onceExit(child)
    expect(await waitForGone(pid)).toBe(true)
  }, 15000)

  test('normal exit + settle() => no kill, killReason stays undefined', async () => {
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    tracked.push(child)
    const watchdog = new ProcessTreeWatchdog(child, { timeoutMs: 60_000 })
    await onceExit(child)
    // The caller settles on the normal completion path.
    watchdog.settle()
    expect(watchdog.killReason).toBeUndefined()
    expect(watchdog.settled).toBe(true)
  }, 15000)

  test('settle() before the timeout prevents the kill', async () => {
    const child = spawn('sh', ['-c', 'sleep 5'], { stdio: 'ignore' })
    tracked.push(child)
    const watchdog = new ProcessTreeWatchdog(child, { timeoutMs: 100 })
    // Settle immediately (simulating a fast normal completion).
    watchdog.settle()
    await sleep(250) // past the 100ms timeout
    expect(watchdog.killReason).toBeUndefined()
    // Child was NOT killed by the watchdog; clean it up.
    killProcessTree(child, 'SIGKILL')
    await onceExit(child)
  }, 15000)

  test('the first kill reason wins (later triggers are memoised away)', async () => {
    const child = spawnSleeper()
    const pid = child.pid!
    await waitForDescendants(pid)
    const controller = new AbortController()
    const watchdog = new ProcessTreeWatchdog(child, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    controller.abort()
    await onceExit(child)
    expect(watchdog.killReason).toBe('abort')
    // A second abort is a no-op — reason is memoised.
    controller.abort()
    expect(watchdog.killReason).toBe('abort')
  }, 15000)
})

describe('registerShutdownHook', () => {
  test('returns an unsubscribe function that is safe to call twice', () => {
    let calls = 0
    const unsubscribe = registerShutdownHook(() => {
      calls += 1
    })
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
    unsubscribe() // idempotent
    // We cannot fire process 'exit' in-test, but unsubscribing must not throw.
    expect(calls).toBe(0)
  })
})
