// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.300 #43 — `occ daemon stop --any` must NOT print "Stopped …" while
 * a stuck background service keeps running: it waits, force-kills, and says
 * so with exit 1 if the holder is still there.
 *
 * Byte evidence (v300 ELF @111238330-@111240708; v299 counts in parens):
 *   `the daemon was not stopped: pid=` + `is still running ` +
 *   `after SIGKILL. A process that outlives SIGKILL is usually waiting
 *    inside the operating system, … restart the computer.` (@111238886, 0)
 *   `after SIGKILL, and could no longer be verified as the daemon. It should
 *    exit shortly. … in a minute, restart the computer.` (@111239232, 0)
 *   `… could not be verified as the daemon, so it was not signalled. …
 *    Re-run \`claude daemon stop --any\` … run \`ps -ww -o args= -p <pid>\` …`
 *   (@111239622/@111239722, 0)
 *   `could not stop the daemon (pid=…): it belongs to another user, so this
 *    account cannot signal it. Stop it from that account. No sessions were
 *    ended.` (@111238507/@111238596, 0)
 *   `… is holding <lockfile> and this command never signals pid 1. If that is
 *    a container's entrypoint, stop the container; if not, delete that file.`
 *   (@111240364, 0)
 *   analytics: `daemon_stop_still_running` (@111240268, 0),
 *   `daemon_stop_holder_unverified` (@111240708), `daemon_stop_holder_is_init`
 *   (@111240672, 0), `daemon_stop_failed` (@111247128).
 *
 * OCC adaptations (documented deviations): label `daemon` (official `of()`
 * branch), `claude`→`occ` command renames, "Claude Code started with" →
 * "OCC started with", single `…/occ daemon …` example, and the unverified
 * variant omits the "Ns after SIGTERM" claim because OCC's fail-safe never
 * signals an unverifiable holder (no SIGTERM was sent — "so it was not
 * signalled" @104541844 wording used instead).
 *
 * Also folds in the entry-44 second symptom: after a successful displace,
 * ~/.claude/daemon-status.json is refreshed so killed workers don't stay
 * listed as running (SIGKILL displacement bypasses supervisor.shutdown()'s
 * stopAllWorkers → writeDaemonStatus path).
 */
import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Mock seams (OCC-97 pattern: snapshot real exports, override narrowly) --

// lockfile.js — real module except displaceHolder (scripted per test).
const actualLockfile = await import('../../../daemon/lockfile.js')
type DisplaceResult = {
  displaced: boolean
  survived: boolean
  unverified: boolean
  eperm: boolean
  isInit: boolean
  holder: { supervisorPid: number; supervisorProcStart: number; holderPid: number } | null
}
let mockDisplaceResult: DisplaceResult
mock.module('../../../daemon/lockfile.js', () => ({
  ...actualLockfile,
  displaceHolder: async () => mockDisplaceResult,
}))

// supervisor.js — stubbed: the stop --any path must not touch the supervisor,
// and stubbing keeps the heavy spawn/registry chain out of this test.
mock.module('../../../daemon/supervisor.js', () => ({
  daemonInstall: async () => {},
  daemonRestart: async () => {},
  daemonUninstall: async () => {},
  displaceAny: async () => mockDisplaceResult,
  getDaemonColdStart: () => 'transient',
  runSupervisor: async () => {},
  stopExistingSupervisor: async () => ({ stopped: false, holder: null, eperm: false }),
}))

// analytics — capture logEvent calls (analytics are stubbed in OCC, but the
// official records these keys at the call sites; we mirror the call sites).
const analyticsCalls: Array<{ name: string; meta: Record<string, unknown> }> = []
const actualAnalytics = await import('../../../services/analytics/index.js')
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, meta: Record<string, unknown> = {}) => {
    analyticsCalls.push({ name, meta })
  },
}))

const { daemonSubcommand } = await import('../daemon.js')
const { getDaemonLockfilePath } = await import('../../../daemon/lockfile.js')
const { getDaemonStatusPath } = await import('../../../daemon/workerRegistry.js')

const HOLDER_PID = 4242
const HOLDER = { supervisorPid: HOLDER_PID, supervisorProcStart: 1_700_000_000_000, holderPid: HOLDER_PID }

let tmpConfigHome: string
let savedConfigDir: string | undefined
let errLines: string[]
let logLines: string[]
let exitCodes: number[]
let errSpy: ReturnType<typeof spyOn>
let logSpy: ReturnType<typeof spyOn>
let exitSpy: ReturnType<typeof spyOn>

function resultWith(overrides: Partial<DisplaceResult>): DisplaceResult {
  return {
    displaced: false,
    survived: false,
    unverified: false,
    eperm: false,
    isInit: false,
    holder: HOLDER,
    ...overrides,
  }
}

describe('CC 2.1.300 #43 — daemon stop --any honest reporting', () => {
  beforeEach(() => {
    tmpConfigHome = mkdtempSync(join(tmpdir(), 'occ-daemon-stop-300-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpConfigHome
    process.exitCode = 0
    errLines = []
    logLines = []
    exitCodes = []
    analyticsCalls.length = 0
    errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '))
    })
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    })
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0)
      return undefined
    }) as unknown as (code?: number) => never)
  })

  afterEach(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
    exitSpy.mockRestore()
    process.exitCode = 0
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

  const stderr = () => errLines.join('\n')
  const stdout = () => logLines.join('\n')

  test('holder SURVIVED SIGKILL → official still-running message + exit 1, no "Stopped"', async () => {
    mockDisplaceResult = resultWith({ survived: true })

    await daemonSubcommand('stop', ['--any'])

    expect(stderr()).toContain(`the daemon was not stopped: pid=${HOLDER_PID} is still running after SIGKILL.`)
    expect(stderr()).toContain('A process that outlives SIGKILL is usually waiting inside the operating system')
    expect(stderr()).toContain('`occ daemon status` says "not running" once it has gone; if it never goes, restart the computer.')
    expect(stdout()).not.toContain('Stopped background sessions')
    expect(process.exitCode).toBe(1)
    expect(exitCodes).toEqual([1])
    expect(analyticsCalls.map(c => c.name)).toContain('daemon_stop_still_running')
  })

  test('survived + identity unreadable → "could no longer be verified" variant + exit 1', async () => {
    mockDisplaceResult = resultWith({ survived: true, unverified: true })

    await daemonSubcommand('stop', ['--any'])

    expect(stderr()).toContain(`the daemon was not stopped: pid=${HOLDER_PID} is still running after SIGKILL, and could no longer be verified as the daemon.`)
    expect(stderr()).toContain('It should exit shortly.')
    expect(stderr()).toContain('still cannot start a new daemon in a minute, restart the computer.')
    expect(process.exitCode).toBe(1)
    expect(analyticsCalls.map(c => c.name)).toContain('daemon_stop_still_running')
  })

  test('holder alive but UNVERIFIED before any signal → ps-hint message + exit 1, never claims SIGKILL', async () => {
    mockDisplaceResult = resultWith({ unverified: true })

    await daemonSubcommand('stop', ['--any'])

    expect(stderr()).toContain(`the daemon was not stopped: pid=${HOLDER_PID} is still running`)
    expect(stderr()).toContain('could not be verified as the daemon, so it was not signalled.')
    expect(stderr()).toContain('Re-run `occ daemon stop --any`.')
    expect(stderr()).toContain(`run \`ps -ww -o args= -p ${HOLDER_PID}\``)
    expect(stderr()).toContain(`stop it with \`kill -9 ${HOLDER_PID}\``)
    expect(stderr()).toContain(`delete ${getDaemonLockfilePath()}.`)
    // Must NOT claim SIGKILL was sent, and must NOT claim "after SIGTERM".
    expect(stderr()).not.toContain('SIGKILL.')
    expect(stderr()).not.toContain('after SIGTERM')
    expect(stdout()).not.toContain('Stopped background sessions')
    expect(process.exitCode).toBe(1)
    expect(analyticsCalls.map(c => c.name)).toContain('daemon_stop_holder_unverified')
  })

  test('foreign-user holder (EPERM) → "belongs to another user … No sessions were ended." + exit 1', async () => {
    mockDisplaceResult = resultWith({ eperm: true })

    await daemonSubcommand('stop', ['--any'])

    expect(stderr()).toContain(`could not stop the daemon (pid=${HOLDER_PID}): it belongs to another user, so this account cannot signal it.`)
    expect(stderr()).toContain('Stop it from that account. No sessions were ended.')
    expect(stdout()).not.toContain('Stopped background sessions')
    expect(process.exitCode).toBe(1)
    expect(exitCodes).toEqual([1])
  })

  test('holder pid is 1 → never signalled message + exit 1', async () => {
    mockDisplaceResult = resultWith({
      isInit: true,
      holder: { supervisorPid: 1, supervisorProcStart: 0, holderPid: 1 },
    })

    await daemonSubcommand('stop', ['--any'])

    expect(stderr()).toContain(`the daemon was not stopped: pid=1 is holding ${getDaemonLockfilePath()} and this command never signals pid 1.`)
    expect(stderr()).toContain("If that is a container's entrypoint, stop the container; if not, delete that file.")
    expect(process.exitCode).toBe(1)
    expect(analyticsCalls.map(c => c.name)).toContain('daemon_stop_holder_is_init')
  })

  test('clean displace → "Stopped …" + exit 0 + daemon-status.json pruned of dead workers', async () => {
    mockDisplaceResult = resultWith({ displaced: true })
    // daemon-status.json lists one dead worker + this (alive) test process.
    const deadPid = 2_147_480_001
    writeFileSync(
      getDaemonStatusPath(),
      JSON.stringify([
        { pid: deadPid, kind: 'default', id: 'w-dead', outcome: 'running', startedAt: 1, cwd: tmpConfigHome, restart: 0 },
        { pid: process.pid, kind: 'default', id: 'w-live', outcome: 'running', startedAt: 1, cwd: tmpConfigHome, restart: 0 },
      ]),
      'utf-8',
    )

    await daemonSubcommand('stop', ['--any'])

    expect(stdout()).toContain(`Stopped background sessions held by pid=${HOLDER_PID}.`)
    expect(process.exitCode).toBe(0)
    expect(exitCodes).toEqual([0])
    // Entry-44 fold-in: killed sessions must not stay listed as running.
    expect(existsSync(getDaemonStatusPath())).toBe(true)
    const refreshed = JSON.parse(readFileSync(getDaemonStatusPath(), 'utf-8'))
    expect(refreshed.map((r: { pid: number }) => r.pid)).toEqual([process.pid])
  })

  test('no holder at all → "No background sessions found." + exit 0', async () => {
    mockDisplaceResult = resultWith({ holder: null })

    await daemonSubcommand('stop', ['--any'])

    expect(stdout()).toContain('No background sessions found.')
    expect(process.exitCode).toBe(0)
  })
})
