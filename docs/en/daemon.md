# Daemon

The OCC daemon is a background-agent supervisor process. It manages background agents, async workflows, and the remote-control HTTP server. It lets you move tasks to the background, dispatch workers, and run scheduled tasks.

## Architecture

All daemon code lives in `src/daemon/`:

| File | Role |
|---|---|
| `main.ts` | Entry point for `occ daemon [sub]` |
| `supervisor.ts` | The supervisor main loop (lockfile, orphan recovery, sweep, idle shutdown, RC server) |
| `workerRegistry.ts` | In-memory worker map; spawns `occ --daemon-worker` subprocesses; persists `daemon-status.json` |
| `workflowWorker.ts` | The `kind: 'workflow'` worker entry (separate-process workflow execution) |
| `remoteControlServer.ts` | Token-authenticated HTTP server on a Unix socket |
| `remoteControlClient.ts` | Client that connects to the RC server via the lockfile |
| `respawn.ts` | Respawn retry loop + orphan recovery |
| `lockfile.ts` | `~/.claude/daemon.lock` — atomic acquire, pid-recycling guard |
| `install.ts` | Persistent-service install (launchd/systemd) |
| `process.ts` | pid liveness, process start-time, SIGTERM→SIGKILL escalation |
| `types.ts` | Shared types (`WorkerRecord`, `LockfileContents`, etc.) |

## Lifecycle

### Install

`/daemon install` (or `occ daemon install`) writes a persistent service:
- **macOS**: launchd plist (`~/Library/LaunchAgents/com.anthropic.claude.daemon.plist`, `RunAtLoad`+`KeepAlive`)
- **Linux**: systemd user unit (`~/.config/systemd/user/claude-daemon.service`, `Restart=on-failure`) + `enable-linger`
- Other platforms: not available

`occ daemon uninstall` removes it.

### Start

`runSupervisor()`:
1. Binary-identity check (refuses if the entry was deleted).
2. Acquire lockfile (atomic O_EXCL; on contention, yields if holder is alive, steals if dead).
3. Recover orphaned workers (SIGTERM `--daemon-worker` children with dead parents).
4. Read + validate `~/.claude/daemon.json`.
5. Start the Remote Control HTTP server.
6. Install SIGTERM/SIGINT handlers.
7. **Sweep loop** (every 5s): mark dead workers, detect pid recycling, pre-warm workers, spawn configured workers, retire settled workers.
8. **Idle shutdown** (after 60s with no workers): `shutdown('idle')`.

### Shutdown

`shutdown(cause)` stops all workers (3s grace), stops the RC server, releases the lockfile, exits 0. Causes: `idle`, `sigterm`, `sigint`, `displaced`, `binary_deleted`, `error`, etc.

### Cold-start policy

`getDaemonColdStart()`: priority `CLAUDE_CODE_DAEMON_COLD_START` env > `globalConfig.daemonColdStart` > `'transient'` (default). `transient` = short-lived daemon that exits when idle; `ask` = prompt before starting.

## Workers

`spawnWorker(kind, opts?)` spawns `occ --daemon-worker <kind>` as a child process. Worker kinds: `default`, `prewarm`, `remote_control`, `workflow`.

Each worker gets a `WorkerRecord { pid, outcome, cliVersion, startedAt, cwd, restart, kind, id, exitCode? }`. The registry persists a snapshot to `~/.claude/daemon-status.json` so FleetView in any OCC process can render daemon-managed sessions.

`runDaemonWorker(workerId)` is the worker entry: for `workflow` kind it runs `runWorkflowWorker()`; otherwise it installs signal handlers, an orphan watchdog (checks parent liveness every 5s), and a 30-min idle cap.

## Commands

### `/daemon`

```
> /daemon status     # supervisor + worker status
> /daemon stop       # stop the supervisor
> /daemon logs       # tail ~/.claude/daemon.log (last 200 lines)
> /daemon install    # install persistent service
> /daemon scheduled  # list scheduled tasks
```

### CLI

```bash
occ daemon start                 # start the supervisor (default)
occ daemon stop [-a]             # stop; -a/--any forces it
occ daemon restart
occ daemon status
occ daemon logs
occ daemon install
occ daemon uninstall
occ daemon scheduled add <id> [--schedule <cron>] [--prompt <text>]
occ daemon scheduled remove <id>
occ daemon scheduled list
occ daemon remote-control        # report RC status
occ daemon hub                   # interactive hub (TTY)
```

### `/background`

```
> /background
```

Moves the current task to a background daemon worker (kind `default`) in the current cwd. Returns the worker id/pid. Use `/stop <id>` to stop it later.

### `/stop`

```
> /stop           # list all running tasks + daemon workers
> /stop <id>      # stop by ID
> /stop <pid>     # stop by PID
```

Looks up the target in three places: `appState.tasks` (REPL background tasks), the in-process worker registry, and the persisted `daemon-status.json` snapshot. Falls back to a bare PID SIGTERM.

### `/tasks` (`/bashes`)

Opens `BackgroundTasksDialog` to list and manage background tasks.

### CLI (background sessions)

```bash
occ stop <id>     # stop a background session
occ attach <id>   # open/join a background session
occ logs <id>     # print a background session log
```

## Config files

All under `~/.claude/`:

| File | Purpose |
|---|---|
| `daemon.lock` | `{ supervisorPid, supervisorProcStart, holderPid, remoteControlToken?, remoteControlSocketPath? }` |
| `daemon.json` | `{ workers?: [{kind, prompt?, schedule?, id?, restart?}], scheduled?: [{id, schedule, prompt, enabled?}], prewarmPerSweep? }` |
| `daemon-status.json` | Persisted WorkerRecord snapshot (for FleetView) |
| `daemon.log` | Supervisor/worker log output |
| `daemon-remote.sock` | RC Unix socket |
| `daemon-remote-prompts.json` | RC prompt-queue mirror |
| `daemon-remote-channel.json` | RC channel mirror |
| `wf-progress/<runId>.json` | Workflow progress files |

## Connecting to a running daemon

`connectRemoteControlClient()` reads the daemon lockfile to discover the RC socket path + auth token, probes the socket, and returns a client with methods: `getStatus()`, `sendPrompt()`, `stopTask()`, `drainPrompts()`, `setChannel()`. See [Remote Control](./remote-control.md).

## Related

- [Remote Control](./remote-control.md) — the RC HTTP server
- [Workflows](./workflows.md) — workflow worker fallback
- [FleetView](./fleetview.md) — daemon sessions in the fleet view
- [Sub-agents](./sub-agents.md) — background agents
