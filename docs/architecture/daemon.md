# Daemon

The daemon is a persistent supervisor process that manages background workers
(keepalive, prewarm, remote-control, workflow), recovers orphaned workers,
and exposes a remote-control HTTP-over-Unix-socket API. FleetView renders the
daemon's task list in the REPL.

## Supervisor — `src/daemon/supervisor.ts`

`runSupervisor(args)` is the main loop. Lifecycle:

1. **`checkBinaryIdentity()`** — refuses if `process.execPath`/
   `process.argv[1]` is deleted ("binary identity unresolvable" / "binary at
   X was deleted").
2. **`acquireLockfile(identity)`** — O_EXCL atomic; on contention prints
   "lockfile now held by pid=X — displaced, yielding" and exits.
3. **`recoverOrphanedWorkers()`** — scans the process table for
   `claude --daemon-worker` children with a dead parent.
4. **`readDaemonJson()` + `validateDaemonJsonWorkers(config)`** — known
   kinds: `default`, `prewarm`, `remote_control`, `workflow`.
5. Starts the remote-control server: `generateRemoteControlToken()` +
   `startRemoteControlServer(token)` + `updateLockfileRemoteControl(identity,
   token, socketPath)`.
6. Signal handlers (SIGTERM → `shutdown('sigterm')`, SIGINT →
   `shutdown('sigint')`).
7. **Sweep loop** (`SWEEP_INTERVAL_MS=5000`): `sweepWorkers(config)`, idle
   shutdown after `IDLE_SHUTDOWN_MS=60000` ("idle Ns with no workers").

`shutdown(cause)`: logs "shutting down (cause=X, uptime=Ys)",
`stopAllWorkers(3000)`, `stopRemoteControlServer`, `releaseLockfile`,
`process.exit(0)`.

Other exports: `getDaemonColdStart()` (env `CLAUDE_CODE_DAEMON_COLD_START` >
globalConfig > 'transient'; enum `transient|ask`), `checkBinaryIdentity`,
`holderRefusesToYield`, `stopExistingSupervisor` (SIGTERM +
`ensureZombieKill` on EPERM), `displaceAny` (`claude daemon stop --any`),
`daemonInstall`/`daemonUninstall`/`daemonRestart`.

## Worker registry — `src/daemon/workerRegistry.ts`

In-memory `registry: Map<id, WorkerRecord>` + `children: Map<id,
ChildProcess>`. `getDaemonJsonPath()` = `~/.claude/daemon.json`.
`DEFAULT_PREWARM_PER_SWEEP=3`.

- `readDaemonJson()` parses `{workers?, scheduled?, prewarmPerSweep?}`.
- `readDaemonStatus()` / `writeDaemonStatus()` — persists a registry snapshot
  to `~/.claude/daemon-status.json` (array of `{pid, outcome, cliVersion,
  startedAt, cwd, kind, id, exitCode}`) for **FleetView cross-process
  visibility**.
- `spawnWorker(kind, opts?)` — spawns `process.execPath <entry>
  --daemon-worker <kind>`; workflow kind uses `stdio:'ignore'`.
- `settleWorker(id, graceMs)`, `sweepWorkers(config)` (marks dead pids
  exited, detects `pidRecycled`, respawns stale via `eStale`, pre-warms up to
  `prewarmPerSweep`).
- `stopAllWorkers`, `forceRespawnWorker(id)`.
- `runDaemonWorker(workerId)` — worker entry: workflow branch →
  `runWorkflowWorker()`; else a keepalive loop with an orphan watchdog
  checking `process.ppid` every 5s, idle cap 30min.
- `autoAddRemoteControlDaemonWorker()` adds a `remote_control` worker to
  daemon.json.

## Lockfile — `src/daemon/lockfile.ts`

Path: `~/.claude/daemon.lock`.

```ts
type LockfileContents = {
  supervisorPid: number
  supervisorProcStart: number
  holderPid: number
  remoteControlToken?: string
  remoteControlSocketPath?: string
}
```

- `acquireLockfile(identity)` — O_EXCL (`open 'ax'`); steals the lock if the
  holder is dead (via `isPidAlive` + `getProcessStartMs` within a 2000ms
  tolerance).
- `releaseLockfile`, `updateLockfileRemoteControl`, `displaceHolder`
  (SIGTERM → wait 5s → SIGKILL), `lockfileExists`, `lockfileMtime`.

## Process utilities — `src/daemon/process.ts`

`isPidAlive(pid)` (`process.kill(pid, 0)`, EPERM=alive),
`getProcessStartMs(pid)` (`ps -o lstart=`), `pidRecycled(pid, startedAt)`
(actual start > recorded + 2000ms tolerance), `sigtermWorker`,
`sigkillWorker`, `ensureZombieKill(pid, graceMs)` (SIGTERM → wait → SIGKILL).

## Respawn — `src/daemon/respawn.ts`

`DEFAULT_RESPAWN_BUDGET=10`, `ERESPAWN_BUDGET=60`. `retryWithRespawnBudget(fn,
opts?)` — on `ERESPAWNING` bumps budget to 60; on `ENOREPLY`/`ESTARTING`
retries with backoff. `createRespawnError`, `isRespawnError`,
`scheduleRespawn`, `forceRespawn(workerId)`, `findOrphanedWorkers()` (`ps -e
-o pid=,ppid=,command=`, filters `--daemon-worker` with dead ppid),
`recoverOrphanedWorkers()` (SIGTERMs orphans, logs "background agent(s)
orphaned by previous process exit"), `handleOrphanedPermissionResponse`.

## Remote control — `src/daemon/remoteControlServer.ts` + `remoteControlClient.ts`

### Server

Unix socket `~/.claude/daemon-remote.sock` (falls back to `127.0.0.1:0` if
path > 100 chars). Bearer token auth (constant-time compare). Endpoints:

| Method | Path | Behavior |
|---|---|---|
| GET | `/health` | Unauth health check |
| GET | `/status` | `supervisorPid`, `pendingPrompts`, `workers`, `channel` |
| POST | `/prompt` | Queues `{content, source?}`, binds Slack channel if present |
| POST | `/prompts/drain` | Drain pending prompts |
| POST | `/channel` | Set/clear Slack channel |
| POST | `/stop` | Stop task by id or pid |

Prompt queue + active channel mirrored to disk
(`daemon-remote-prompts.json`, `daemon-remote-channel.json`). Exports
`generateRemoteControlToken`, `startRemoteControlServer`,
`stopRemoteControlServer`, `drainPendingPrompts`, `peekPendingPrompts`,
`getActiveChannel`, `setActiveChannel`.

### Client

`connectRemoteControlClient()` — resolves endpoint from `readLockfile()`
(`remoteControlToken` + `remoteControlSocketPath`), probes socket via
`isSocketReachable`, returns `{getStatus, sendPrompt, stopTask,
drainPrompts, setChannel}`. `fetchRemoteControlStatus()` — non-throwing
status fetch for REPL pollers.

## FleetView — `src/components/FleetView/`

**`FleetView.tsx`** — presentational component. Props: `rows: {running:
BackgroundTaskState[], done: BackgroundTaskState[]}`, `focused`,
`selectedIndex`, `showPreview`, `now`, `terminalRows`, `onDispatch?`. Reads
from `appState.tasks` (Phase 1 — no daemon/heartbeat; "there is no
daemon/heartbeat/host"). Renders `FleetRow` per task: `isLocalAgentTask` →
`AgentProgressLine` (tree char, agentType, toolUseCount, tokens, status);
else `BackgroundTask` (local_bash/remote_agent/in_process_teammate/
local_workflow/monitor_mcp/dream). Empty state shows `fleetAgentSuggestions()`.

### FleetView ↔ daemon bridge

The daemon persists `~/.claude/daemon-status.json` via `writeDaemonStatus()`;
FleetView / `/daemon status` reads via `readDaemonStatus()`. For workflows,
the `useWorkflowProgressPoller` reads `~/.claude/wf-progress/<runId>.json`
files and creates `local_agent`/`local_workflow` tasks in `appState.tasks`
so FleetView renders them.

`rowHelpers.ts` (`actionableStatus`, `fleetAgentSuggestions`, `fleetTitle`,
`fleetVerticalBudget`, `formatJobAge`, `glyphColor`, `jobDescription`,
`jobLabel`). `FleetViewScreen.tsx` handles navigation (Up/Down/Enter/Esc via
`useInput`).

## `/daemon` command — `src/commands/daemon/`

`daemon.ts` — `call(args)`. Subcommands:

- `install` → `installPersistentService()`.
- `status` → reads `readLockfile()` + `lockfileMtime()` +
  `getDaemonColdStart()` + `readDaemonStatus()` (lists each worker:
  id/kind/pid/alive/outcome/started).
- `stop` → `stopExistingSupervisor()`.
- `logs` → `tail -n 200 ~/.claude/daemon.log`.
- `scheduled` → `readDaemonJson().scheduled`.

## Key files

| File | Role |
|---|---|
| `src/daemon/supervisor.ts` | `runSupervisor`, `shutdown`, install/uninstall |
| `src/daemon/workerRegistry.ts` | `spawnWorker`, `sweepWorkers`, `runDaemonWorker`, `writeDaemonStatus` |
| `src/daemon/lockfile.ts` | `acquireLockfile`, `releaseLockfile`, `displaceHolder` |
| `src/daemon/process.ts` | `isPidAlive`, `getProcessStartMs`, `ensureZombieKill` |
| `src/daemon/respawn.ts` | `retryWithRespawnBudget`, `recoverOrphanedWorkers` |
| `src/daemon/remoteControlServer.ts` | `startRemoteControlServer`, prompt queue |
| `src/daemon/remoteControlClient.ts` | `connectRemoteControlClient` |
| `src/daemon/workflowWorker.ts` | Workflow daemon worker (fallback path) |
| `src/daemon/main.ts` | `daemonMain` entry dispatch |
| `src/components/FleetView/` | Task list UI |
| `src/commands/daemon/` | `/daemon` command |

## How it differs from Claude Code

OCC's daemon is a reimplementation of Claude Code's supervisor/worker model.
The lockfile, sweep loop, orphan recovery, remote-control socket, and
`daemon-status.json` bridge are all present. The main OCC-specific detail is
the workflow worker integration: `runDaemonWorker` dispatches to
`runWorkflowWorker()` for the `workflow` kind, but this is a fallback — the
primary async workflow path runs in-process with the NO-OP `setAppState`
pattern (see [workflows.md](./workflows.md)).
