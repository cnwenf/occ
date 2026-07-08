# FleetView

FleetView is the inline navigable agent/workflow row list rendered below the input box in the REPL. It shows live (running/pending) background jobs first, then recently-completed jobs folded below, plus cross-process daemon-managed sessions.

## What it shows

FleetView reads from `appState.tasks` (in-process background agents and workflows) and the daemon status snapshot (`~/.claude/daemon-status.json`). It renders:

- **`local_agent`** tasks — spawned subagents, shown as `AgentProgressLine`
- **`local_workflow`** tasks — workflow runs
- **`local_bash`** / **`remote_agent`** / **`in_process_teammate`** / **`monitor_mcp`** tasks — shown as `BackgroundTask` rows
- **Daemon sessions** — workers from separate processes, shown below in-process rows

Running jobs appear first (sorted by start time, oldest first). Recently-completed jobs (ended within a 60s fold window) appear folded below ("N done"). A 1s tick re-renders ages and evicts expired done rows.

## Interacting with FleetView

FleetView mounts in the REPL when fullscreen env mode is enabled. Key bindings (preempt the text input):

| Key | Action |
|---|---|
| `Up`/`Down` (while active) | Navigate rows |
| `Enter` (on a running row) | Open `SessionPreview` (peek at last ~6 tool activities) |
| `Enter` (on empty input) | Dispatch a suggested prompt (Researcher/Reviewer/Workflow) |
| `x` (on a running row) | Stop the focused job |
| `Ctrl+G` | Toggle group mode |
| `Esc` | Exit fleet navigation |

Down/left-arrow on an empty input enters fleet navigation.

## Session preview

`SessionPreview` shows a peek pane for a focused row:
- **Agents**: last ~6 tool activities
- **Workflows**: narrator/phase lines
- **Shells**: exit code
- **Teammates**: activity summary

## Daemon bridge

FleetView polls `readDaemonStatus()` (reads `~/.claude/daemon-status.json`) every 5s and renders daemon-managed sessions below the in-process rows. This lets you see workers spawned by the daemon (separate process) alongside your in-process background tasks. The daemon persists this snapshot via `writeDaemonStatus()` on spawn/exit/error.

A heartbeat writes `.fleetview-heartbeat-<pid>` files to the temp directory every 5s for the daemon's orphan watchdog.

## Dispatching a fleet

There is no separate fleet dispatcher. Agents are spawned via the [Agent tool](./sub-agents.md) (with `run_in_background: true`) or the [Workflow tool](./workflows.md), which register tasks in `appState.tasks`. FleetView then surfaces those tasks. The empty state offers three dispatch suggestions (Researcher, Reviewer, Workflow); pressing `Enter` on a selected suggestion sets the prompt buffer and submits it.

For team coordination, see [Sub-agents](./sub-agents.md) (the `name` parameter, `SendMessage`, `TeamCreate`).

## Peer discovery

The `ListAgents` tool (formerly `ListPeers`) lists agents you can `SendMessage` to, in four categories:

| Category | Source | Status in OCC |
|---|---|---|
| `in_process` | Spawned subagent tasks from `appState.tasks` | Implemented |
| `local` | Other Claude sessions on this machine (`~/.claude/sessions/*.json`) | Implemented |
| `cloud` | `listCloudSessions()` | Stub (returns `[]`) |
| `remote_bridge` | `listRemoteBridgeSessions()` | Stub (returns `[]`) |

The `local` scan reads `~/.claude/sessions/*.json` PID files directly (not via UDS), so it works regardless of the `UDS_INBOX` flag.

## What's implemented vs stubbed

- FleetView UI: **fully implemented** (local rows, daemon bridge, preview, group/stop).
- `isAgentsFleetEnabled()`: stubbed to `return true` (the GrowthBook gate is forced open).
- Daemon status bridge: **implemented** (real read/write of `daemon-status.json`).
- Cross-session messaging (`uds:`/`bridge:` schemes in SendMessage): **stubbed** (`UDS_INBOX` is off; `peerSessions.ts` and `udsClient.ts` are auto-generated stubs).
- `claude agents` CLI dashboard: **implemented** (prefers live RC data, falls back to the snapshot).

## Related

- [Sub-agents](./sub-agents.md) — spawning background agents
- [Daemon](./daemon.md) — daemon-managed workers
- [Workflows](./workflows.md) — workflow rows
- [Remote Control](./remote-control.md) — cross-device sessions
