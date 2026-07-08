/**
 * Worker registry for the B daemon supervisor.
 *
 * Tracks worker records { pid, outcome, cliVersion, startedAt, cwd, restart }
 * for each spawned worker subprocess. Reads ~/.claude/daemon.json for
 * configured workers + prewarm count. Pre-warms `tengu_bg_prewarm_per_sweep`
 * (default 3) workers per sweep and respawns stale workers via eStale.
 *
 * Worker subprocesses are spawned as real `claude --daemon-worker <kind>`
 * children (same entry as the supervisor, `process.argv[1]`), routed to
 * runDaemonWorker() via the main.tsx hidden `--daemon-worker` option.
 *
 * Replaces the auto-generated stub.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getCwd } from '../utils/cwd.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  DaemonJsonConfig,
  DaemonJsonWorker,
  WorkerOutcome,
  WorkerRecord,
} from './types.js'
import { isPidAlive, pidRecycled, sigtermWorker } from './process.js'

/** Where daemon.json lives. */
export function getDaemonJsonPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.json')
}

/** Default prewarm count per sweep (tengu_bg_prewarm_per_sweep). */
export const DEFAULT_PREWARM_PER_SWEEP = 3

/** In-memory worker registry: id -> record. */
const registry = new Map<string, WorkerRecord>()

/** Live ChildProcess handles for active workers: id -> child. */
const children = new Map<string, ChildProcess>()

let _nextId = 1
function nextWorkerId(): string {
  return `w${_nextId++}`
}

/**
 * Read + parse ~/.claude/daemon.json.
 *
 * - Missing file → empty config (no workers, default prewarm).
 * - Malformed JSON → logs "daemon.json is malformed", returns empty config.
 */
export function readDaemonJson(): DaemonJsonConfig {
  const path = getDaemonJsonPath()
  if (!existsSync(path)) {
    return { prewarmPerSweep: DEFAULT_PREWARM_PER_SWEEP }
  }
  let raw: string
  try {
    raw = readFileSync(path, { encoding: 'utf-8' })
  } catch {
    return { prewarmPerSweep: DEFAULT_PREWARM_PER_SWEEP }
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('daemon.json is malformed — ignoring worker config')
    logEvent('daemon_json_malformed', {})
    return { prewarmPerSweep: DEFAULT_PREWARM_PER_SWEEP }
  }
  const config: DaemonJsonConfig = {
    workers: Array.isArray(parsed?.workers) ? parsed.workers : undefined,
    scheduled: Array.isArray(parsed?.scheduled) ? parsed.scheduled : undefined,
    prewarmPerSweep:
      typeof parsed?.prewarmPerSweep === 'number' ? parsed.prewarmPerSweep : DEFAULT_PREWARM_PER_SWEEP,
  }
  return config
}

/**
 * Phase 3 (FleetView ↔ daemon bridge): the daemon's running workers live in
 * the in-memory `registry` (only visible inside the daemon process). To let
 * the FleetView panel in ANY OCC process render daemon-managed background
 * sessions, the daemon persists a snapshot of the registry to
 * `~/.claude/daemon-status.json` (array of {pid,outcome,startedAt,cwd,kind,id}).
 * FleetView polls `readDaemonStatus()` and renders the rows.
 *
 * Missing/malformed file → empty array (FleetView shows no daemon sessions).
 */
export function getDaemonStatusPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon-status.json')
}

export function readDaemonStatus(): WorkerRecord[] {
  const path = getDaemonStatusPath()
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, { encoding: 'utf-8' })
  } catch {
    return []
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const values: any[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed)
      : []
  return values.filter(
    (w: any) => w && typeof w.pid === 'number' && typeof w.kind === 'string',
  ) as WorkerRecord[]
}

/** Persist the in-memory registry snapshot so other processes (FleetView) can read it. */
export function writeDaemonStatus(): void {
  try {
    const records = Array.from(registry.values())
    const snapshot = records.map(r => ({
      pid: r.pid,
      outcome: r.outcome,
      cliVersion: r.cliVersion,
      startedAt: r.startedAt,
      cwd: r.cwd,
      restart: r.restart,
      kind: r.kind,
      id: r.id,
      exitCode: r.exitCode,
    }))
    writeFileSync(getDaemonStatusPath(), JSON.stringify(snapshot), { encoding: 'utf-8' })
  } catch {
    // Status file is best-effort — never crash the daemon over it.
  }
}

/**
 * Validate that the workers configured in daemon.json are still reachable
 * (i.e. the kinds are known). Returns a list of warnings for the supervisor
 * to surface as "has configured workers but they do not ...".
 */
export function validateDaemonJsonWorkers(config: DaemonJsonConfig): string[] {
  const warnings: string[] = []
  if (!config.workers || config.workers.length === 0) return warnings
  const knownKinds = new Set(['default', 'prewarm', 'remote_control'])
  for (const w of config.workers) {
    if (!w?.kind || !knownKinds.has(w.kind)) {
      warnings.push(
        `has configured workers but they do not match a known kind: ${w?.kind ?? '(missing)'}`,
      )
    }
  }
  return warnings
}

/**
 * Get the CLI version string for worker records (MACRO.VERSION).
 */
function getCliVersion(): string {
  const macro = (globalThis as any).MACRO
  return macro?.VERSION ?? 'unknown'
}

/**
 * Spawn a worker subprocess of the given kind.
 *
 * The child runs `process.execPath <entry> --daemon-worker <kind>` where
 * <entry> is process.argv[1] (the same entry the supervisor was launched
 * with). The main.tsx hidden --daemon-worker option routes the child into
 * runDaemonWorker(kind).
 */
export function spawnWorker(kind: string, opts?: { cwd?: string; id?: string }): WorkerRecord {
  const id = opts?.id ?? nextWorkerId()
  const cwd = opts?.cwd ?? getCwd()
  const entry = process.argv[1] ?? 'dist/cli.js'

  // Stop any existing worker with this id first.
  const existing = registry.get(id)
  if (existing && isPidAlive(existing.pid)) {
    sigtermWorker(existing.pid)
  }

  const child = spawn(process.execPath, [entry, '--daemon-worker', kind], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      CLAUDE_CODE_DAEMON_WORKER: '1',
      CLAUDE_CODE_DAEMON_WORKER_KIND: kind,
    },
  })

  const record: WorkerRecord = {
    pid: child.pid ?? -1,
    outcome: 'running',
    cliVersion: getCliVersion(),
    startedAt: Date.now(),
    cwd,
    restart: (existing?.restart ?? 0),
    kind,
    id,
  }
  registry.set(id, record)
  children.set(id, child)
  writeDaemonStatus()

  child.on('exit', (code, signal) => {
    const rec = registry.get(id)
    if (!rec) return
    rec.exitCode = code ?? undefined
    if (signal === 'SIGTERM') rec.outcome = 'sigterm'
    else if (signal === 'SIGKILL') rec.outcome = 'sigkill'
    else if (code === 0) rec.outcome = 'exited_clean'
    else rec.outcome = 'exited_error'
    children.delete(id)
    writeDaemonStatus()
  })

  child.on('error', () => {
    const rec = registry.get(id)
    if (rec) rec.outcome = 'exited_error'
    children.delete(id)
    writeDaemonStatus()
  })

  return record
}

/**
 * Settle a worker: SIGTERM, wait briefly, then record outcome.
 * Used when a worker slot is being retired (supervisor shutdown / sweep).
 */
export async function settleWorker(id: string, graceMs = 3000): Promise<void> {
  const rec = registry.get(id)
  if (!rec) return
  const child = children.get(id)
  if (child && isPidAlive(rec.pid)) {
    sigtermWorker(rec.pid)
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (!isPidAlive(rec.pid)) break
      await new Promise(r => setTimeout(r, 100))
    }
  }
  if (rec && isPidAlive(rec.pid)) {
    // Still alive after grace — leave it; the supervisor will escalate.
    rec.outcome = 'stalled'
  }
}

/**
 * Snapshot of the current registry (for status display + FleetView host adapter).
 */
export function listWorkers(): WorkerRecord[] {
  return Array.from(registry.values())
}

/**
 * Find a worker by id (for `claude stop|attach|logs <id>`).
 */
export function getWorker(id: string): WorkerRecord | undefined {
  return registry.get(id)
}

/**
 * Sweep the registry:
 *  - mark workers whose pid is dead as exited (if still 'running')
 *  - detect pid recycling via pidRecycled()
 *  - respawn stale workers (eStale("prewarm")) up to prewarmPerSweep
 *  - SIGTERM workers that have settled
 *
 * Returns the count of currently-alive workers.
 */
export async function sweepWorkers(config: DaemonJsonConfig): Promise<number> {
  const prewarmPerSweep = config.prewarmPerSweep ?? DEFAULT_PREWARM_PER_SWEEP
  let alive = 0

  for (const rec of registry.values()) {
    if (rec.outcome !== 'running') continue
    if (!isPidAlive(rec.pid)) {
      rec.outcome = 'exited_clean'
      continue
    }
    if (pidRecycled(rec.pid, rec.startedAt)) {
      // The pid was reused by a different process — stale record.
      rec.outcome = 'stalled'
      eStale(rec, 'pid_recycled')
      continue
    }
    alive++
  }

  // Pre-warm: ensure at least prewarmPerSweep 'prewarm' workers are alive.
  const prewarmAlive = Array.from(registry.values()).filter(
    w => w.kind === 'prewarm' && w.outcome === 'running' && isPidAlive(w.pid),
  ).length
  const toPrewarm = Math.max(0, prewarmPerSweep - prewarmAlive)
  for (let i = 0; i < toPrewarm; i++) {
    const rec = spawnWorker('prewarm')
    logEvent('tengu_bg_prewarm_per_sweep', {
      kind: 'prewarm' as any,
      pid: rec.pid,
    })
  }

  // Spawn any daemon.json-configured workers that aren't running.
  if (config.workers) {
    for (const w of config.workers) {
      const kind = w.kind
      const has = Array.from(registry.values()).some(
        r => r.kind === kind && r.outcome === 'running' && isPidAlive(r.pid),
      )
      if (!has) {
        spawnWorker(kind, { cwd: w?.['cwd'] as string | undefined })
      }
    }
  }

  return alive
}

/**
 * eStale — respawn a stale worker. Bumps the restart counter and spawns a
 * fresh worker for the same kind. The old record is marked 'stalled'.
 *
 * @param rec    the stale worker record
 * @param reason why it's stale ('prewarm' | 'pid_recycled' | 'stalled')
 */
export function eStale(rec: WorkerRecord, reason: 'prewarm' | 'pid_recycled' | 'stalled'): void {
  rec.outcome = 'stalled'
  logEvent('tengu_bg_worker_stale', {
    kind: rec.kind as any,
    reason: reason as any,
    pid: rec.pid,
    restart: rec.restart,
  })
  const fresh = spawnWorker(rec.kind, { cwd: rec.cwd })
  fresh.restart = rec.restart + 1
  registry.set(fresh.id, fresh)
}

/**
 * SIGTERM all workers and clear the registry (supervisor shutdown).
 */
export async function stopAllWorkers(graceMs = 3000): Promise<void> {
  const ids = Array.from(registry.keys())
  await Promise.all(ids.map(id => settleWorker(id, graceMs)))
  registry.clear()
  writeDaemonStatus()
  children.clear()
}

/**
 * Force-respawn a worker by id (used by the ERESPAWN path). SIGKILLs the
 * current process and spawns a fresh one in the same slot.
 */
export function forceRespawnWorker(id: string): WorkerRecord | null {
  const rec = registry.get(id)
  if (!rec) return null
  if (isPidAlive(rec.pid)) {
    try {
      process.kill(rec.pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
  }
  const fresh = spawnWorker(rec.kind, { cwd: rec.cwd, id })
  fresh.restart = rec.restart + 1
  registry.set(id, fresh)
  return fresh
}

/**
 * runDaemonWorker — the worker entry point. Spawned per-worker by the
 * supervisor (and by `claude --daemon-worker <kind>` via the main.tsx
 * hidden option). Keeps alive until SIGTERM/SIGINT or the orphan watchdog
 * detects the parent supervisor is gone.
 *
 * This replaces the auto-generated stub. Real implementation: signal
 * handlers + orphan watchdog (ppid liveness check) + keepalive loop.
 */
export const runDaemonWorker: (workerId: string) => Promise<void> = async (
  workerId: string,
): Promise<void> => {
  const kind = workerId || process.env.CLAUDE_CODE_DAEMON_WORKER_KIND || 'default'
  const startMs = Date.now()
  const parentPpid = process.ppid

  console.log(`[daemon-worker] kind=${kind} pid=${process.pid} parent=${parentPpid} ready`)

  let settling = false
  const shutdown = async (signal: string) => {
    if (settling) return
    settling = true
    console.log(`[daemon-worker] kind=${kind} received ${signal}, settling`)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Orphan watchdog: if our parent supervisor exits, we're orphaned.
  // "parent supervisor gone — exiting"
  const orphanWatch = setInterval(() => {
    if (!isPidAlive(parentPpid)) {
      console.log(
        `orphan watchdog: ppid ${parentPpid}→process.ppid, no client found`,
      )
      console.log('parent supervisor gone — exiting')
      clearInterval(orphanWatch)
      process.exit(0)
    }
  }, 5000)

  // Keepalive — exit after a long idle so the supervisor can respawn fresh.
  // (In production this loop runs until work dispatch or signal.)
  const idleCapMs = 30 * 60 * 1000 // 30 min
  const idleDeadline = startMs + idleCapMs
  while (!settling) {
    const now = Date.now()
    if (now > idleDeadline) {
      console.log(`[daemon-worker] kind=${kind} idle cap reached, exiting`)
      process.exit(0)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// B7 (2.1.200): auto-add a Remote Control daemon worker (subtype: "remote_control").
export async function autoAddRemoteControlDaemonWorker(opts?: { caCertsPath?: string }) {
  // The RC worker is a daemon worker of kind "remote_control" that maintains
  // the CCR (Claude Code Remote) session bridge. When the daemon is running,
  // it keeps the RC session alive across REPL restarts.
  const config = await readDaemonJson()
  if (!config.workers?.some(w => w.kind === "remote_control")) {
    config.workers = [...(config.workers ?? []), {
      kind: "remote_control",
      id: "rc-" + Date.now(),
      restart: true,
    }]
    await writeDaemonJson(config)
  }
}

