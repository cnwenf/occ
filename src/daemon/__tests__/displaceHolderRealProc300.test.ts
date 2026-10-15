/**
 * CC 2.1.300 #43 — real-process e2e for the `daemon stop --any` displace
 * flow: a fake holder that TRAPS SIGTERM must be force-killed (SIGKILL) and
 * only reported displaced once liveness is re-checked and it is really gone.
 *
 * No module mocks here — real `isPidAlive` / `getProcessStartMs` / real
 * signals against a real `bash` process. Lockfile fixture lives in a tmp
 * CLAUDE_CONFIG_DIR so the developer's ~/.claude is never touched.
 *
 * Byte evidence (v300 ELF): official flow @111238330-@111240268 —
 * SIGTERM → wait → "is still running; force-killing it (SIGKILL)" @111238440
 * → SIGKILL → liveness re-check → success only when it is gone.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

const { displaceHolder, getDaemonLockfilePath } = await import('../lockfile.js')
const { isPidAlive, getProcessStartMs } = await import('../process.js')

let tmpConfigHome: string
let savedConfigDir: string | undefined
const spawned: number[] = []

/** Spawn a fake holder. `trapTerm` makes it ignore SIGTERM (stuck service). */
function spawnFakeHolder(trapTerm: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const script = trapTerm
      ? // Chained short sleeps: after the bash is SIGKILLed, an orphaned
        // `sleep 1` lingers at most ~1s (no long-lived test residue).
        'trap "" TERM; echo ready; sleep 1; sleep 1; sleep 1; sleep 1; sleep 1; sleep 1; sleep 1; sleep 1'
      : 'echo ready; sleep 30'
    const child = spawn('bash', ['-c', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout?.once('data', () => {
      if (child.pid !== undefined) {
        spawned.push(child.pid)
        resolve(child.pid)
      } else {
        reject(new Error('no pid'))
      }
    })
    child.on('error', reject)
  })
}

describe('CC 2.1.300 #43 — displaceHolder against real processes', () => {
  beforeEach(() => {
    tmpConfigHome = mkdtempSync(join(tmpdir(), 'occ-daemon-real-300-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpConfigHome
  })

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
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

  function writeLockfileFor(pid: number): void {
    const startMs = getProcessStartMs(pid)
    expect(startMs).not.toBeNull() // platform must expose `ps -o lstart=`
    writeFileSync(
      getDaemonLockfilePath(),
      JSON.stringify({ supervisorPid: pid, supervisorProcStart: startMs, holderPid: pid }),
      'utf-8',
    )
  }

  test('SIGTERM-trapping holder is force-killed (SIGKILL) and reported displaced only once dead', async () => {
    // Arrange: a real stuck service that ignores SIGTERM.
    const pid = await spawnFakeHolder(true)
    writeLockfileFor(pid)

    // Act: short grace so the SIGTERM wait doesn't burn the full 5s.
    const startedAt = Date.now()
    const res = await displaceHolder({ sigtermGraceMs: 600, sigkillSettleMs: 400 })
    const elapsed = Date.now() - startedAt

    // Assert: the trap survived SIGTERM, so SIGKILL was escalated; the
    // process is really gone and success is reported only after re-check.
    // The grace/settle options must be honored (elapsed ≈ 1s, not the 5.3s
    // production defaults).
    expect(elapsed).toBeLessThan(4000)
    expect(res.displaced).toBe(true)
    expect(res.survived).toBe(false)
    expect(res.unverified).toBe(false)
    expect(isPidAlive(pid)).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  }, 15000)

  test('cooperative holder dies on SIGTERM alone → clean displaced stop', async () => {
    const pid = await spawnFakeHolder(false)
    writeLockfileFor(pid)

    const res = await displaceHolder({ sigtermGraceMs: 3000, sigkillSettleMs: 300 })

    expect(res.displaced).toBe(true)
    expect(res.survived).toBe(false)
    expect(isPidAlive(pid)).toBe(false)
    expect(existsSync(getDaemonLockfilePath())).toBe(false)
  }, 15000)
})
