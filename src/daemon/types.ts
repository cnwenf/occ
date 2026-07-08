/**
 * Shared types for the B daemon (background-agent supervisor).
 *
 * Mirrors the official 2.1.200 binary's daemon field shapes:
 *   - supervisor identity: { supervisorPid, supervisorProcStart }
 *   - lockfile:            { supervisorPid, supervisorProcStart, holderPid }
 *   - worker record:       { pid, outcome, cliVersion, startedAt, cwd, restart }
 *   - daemon.json:         { workers: [...], scheduled: [...] }
 *
 * These types are the contract between supervisor.ts, lockfile.ts,
 * workerRegistry.ts, respawn.ts, and the CLI handlers.
 */

/** Reasons the supervisor is shutting down. Mirrors binary cause strings. */
export type ShutdownCause =
  | 'idle'
  | 'sigterm'
  | 'sigint'
  | 'displaced'
  | 'binary_deleted'
  | 'binary_unresolvable'
  | 'epERM_restart'
  | 'stop_requested'
  | 'error'

/** Worker outcome — written to a worker record when it settles. */
export type WorkerOutcome =
  | 'running'
  | 'exited_clean'
  | 'exited_error'
  | 'sigterm'
  | 'sigkill'
  | 'stalled'
  | 'orphaned'
  | 'respawned'

/** A single worker record. Persisted in-memory by the registry. */
export interface WorkerRecord {
  /** The worker's process id. */
  pid: number
  /** Last-settled outcome. 'running' while alive. */
  outcome: WorkerOutcome
  /** CLI version string (MACRO.VERSION) the worker was spawned with. */
  cliVersion: string
  /** Date.now() when the worker was spawned. */
  startedAt: number
  /** Working directory the worker was spawned in. */
  cwd: string
  /** Restart counter — bumped each time this worker slot is respawned. */
  restart: number
  /** Worker kind (e.g. 'default', 'remote_control', 'prewarm'). */
  kind: string
  /** Optional friendly id (used by `claude stop|attach|logs <id>`). */
  id: string
  /** Exit code if known. */
  exitCode?: number
}

/** Lockfile contents at ~/.claude/daemon.lock. */
export interface LockfileContents {
  supervisorPid: number
  supervisorProcStart: number
  /** pid of the process that holds the lockfile (== supervisorPid in normal op). */
  holderPid: number
  /** Remote-control auth token (B7). Present when the RC server is running. */
  remoteControlToken?: string
  /** Unix-socket path the RC server listens on (B7). */
  remoteControlSocketPath?: string
}

/** A configured worker in ~/.claude/daemon.json. */
export interface DaemonJsonWorker {
  kind: string
  /** Optional prompt/work payload for the worker. */
  prompt?: string
  /** Repeat schedule hint (cron-ish). */
  schedule?: string
  /** Optional friendly id (used by `claude stop|attach|logs <id>`). */
  id?: string
  /** Whether the supervisor should respawn this worker on exit. */
  restart?: boolean
}

/** A scheduled task entry in ~/.claude/daemon.json + daemon.scheduled.status.json. */
export interface ScheduledTask {
  id: string
  /** Cron-style schedule. */
  schedule: string
  /** Prompt to dispatch when the task fires. */
  prompt: string
  /** Whether the task is currently enabled. */
  enabled?: boolean
}

/** Shape of ~/.claude/daemon.json. */
export interface DaemonJsonConfig {
  workers?: DaemonJsonWorker[]
  scheduled?: ScheduledTask[]
  /** Prewarm count per sweep (default 3). tengu_bg_prewarm_per_sweep. */
  prewarmPerSweep?: number
}

/** Respawn error codes used over the supervisor↔worker channel. */
export type RespawnErrorCode = 'ERESPAWNING' | 'ENOREPLY' | 'ESTARTING'

/** A respawn error object (code + message). */
export interface RespawnError extends Error {
  code: RespawnErrorCode
}

/** daemonColdStart setting enum. */
export type DaemonColdStart = 'transient' | 'ask'

/** Identity tuple a supervisor uses to self-identify. */
export interface SupervisorIdentity {
  supervisorPid: number
  supervisorProcStart: number
}
