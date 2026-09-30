import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'

/**
 * 2.1.285 upstream port (changelog item 3): the official `Je` spawn wrapper
 * gained `withoutControllingTerminal` (@196477428):
 *   `L = be && O() !== "windows"` → `...L && { detached: !0 }` on the spawn,
 *   `h = L ? f.pid : void 0`, and in the finally block
 *   `if (h !== void 0 && (g === void 0 || g.exitCode === void 0)) Oe(h)`
 * where `Oe` @196474487 is `if (pid > 1) { try { process.kill(-pid, "SIGTERM") } catch {} }`.
 *
 * We assert ONLY the official observable contract: the detached child runs
 * normally, and a detached child that ends without a normal exit code
 * (timeout/kill) takes its whole process group down — no orphaned
 * grandchildren (the ssh hang the changelog fix targets).
 */

const POSIX = getPlatform() !== 'windows'

/** True when the pid exists and is not a zombie (unreaped kill counts as dead). */
function isProcessAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = stat.lastIndexOf(')')
    const state = stat.slice(closeParen + 2, closeParen + 3)
    return state !== 'Z'
  } catch {
    return false
  }
}

describe('execFileNoThrowWithCwd withoutControllingTerminal (official Je)', () => {
  test('flag off: spawn behavior unchanged', async () => {
    const result = await execFileNoThrowWithCwd('/bin/sh', ['-c', 'echo OK'], {
      timeout: 5000,
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('OK')
  })

  test('flag on (POSIX): detached child still runs and reports output', async () => {
    if (!POSIX) return
    const result = await execFileNoThrowWithCwd('/bin/sh', ['-c', 'echo OK'], {
      timeout: 5000,
      withoutControllingTerminal: true,
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('OK')
  })

  test('flag on (POSIX): a timed-out detached child does not orphan its group', async () => {
    if (!POSIX) return
    const dir = mkdtempSync(join(tmpdir(), 'gkill285-'))
    const pidFile = join(dir, 'sleep.pid')
    try {
      // sh backgrounds a `sleep 10` grandchild (recording its pid), then waits.
      // The grandchild's stdio is redirected so the direct child's pipes close
      // on kill (execa resolves); the official `Oe` group-kill must then also
      // reap the grandchild — without it, `sleep 10` would survive as an
      // orphan (exactly the hung-ssh scenario).
      const started = Date.now()
      const result = await execFileNoThrowWithCwd(
        '/bin/sh',
        ['-c', `sleep 10 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`],
        { timeout: 400, withoutControllingTerminal: true },
      )
      expect(result.code).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(4500)

      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(grandchildPid).toBeGreaterThan(1)

      let alive = true
      for (let i = 0; i < 40 && alive; i++) {
        alive = isProcessAlive(grandchildPid)
        if (alive) await Bun.sleep(50)
      }
      expect(alive).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
