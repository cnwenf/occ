# Remote Control

OCC has two distinct "remote control" concepts. This page covers both: the daemon's local HTTP server (Unix-socket bridge) and the CCR bridge to claude.ai (gated off in OCC).

## Concept A: Daemon Remote Control HTTP server

This is the daemon's local HTTP API. It lets other devices or channels (mobile, Slack, another machine via SSH tunnel) query session state and send commands to a running OCC daemon. It is **fully implemented** in OCC.

### How it works

When the supervisor starts, it generates a random token (`randomBytes(24).toString('hex')`), starts an HTTP server on a Unix socket (`~/.claude/daemon-remote.sock`), and writes the token + socket path into the daemon lockfile (`~/.claude/daemon.lock`). If the socket path exceeds 100 chars, it falls back to ephemeral localhost TCP.

### Authentication

All routes except `GET /health` require an `Authorization: Bearer <token>` header. The token is compared in constant time. Unauthorized requests get `401 { error: 'unauthorized' }`.

### Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok: true }` (unauthenticated liveness probe) |
| GET | `/status` | — | `{ supervisorPid, pendingPrompts, workers[], channel }` |
| POST | `/prompt` | `{ content, source?, channel? }` | `202 { id, accepted: true }` (queues a prompt) |
| POST | `/prompts/drain` | — | `200 { drained: [...] }` (returns + clears pending prompts) |
| POST | `/channel` | `{ name, source? }` (empty clears) | `200 { channel }` (set/clear Slack channel binding) |
| POST | `/stop` | `{ id? }` or `{ pid? }` | `200 { id, stopped, outcome }` or `{ pid, stopped }` |

Max POST body: 256 KiB. State is mirrored to disk (`daemon-remote-prompts.json`, `daemon-remote-channel.json`) for cross-process visibility and RC restart survival.

### Client

`connectRemoteControlClient()` reads the lockfile to discover the socket path + token, probes the socket, and returns a client with methods: `getStatus()`, `sendPrompt()`, `stopTask()`, `drainPrompts()`, `setChannel()`. `fetchRemoteControlStatus()` is a non-throwing variant for REPL pollers.

### REPL integration

`useRemoteControlChannel()` polls `fetchRemoteControlStatus()` every 5s for the active Slack channel binding so the REPL can render a `#channel` header.

### Starting remote control

```bash
occ daemon start          # starts the supervisor + RC server
occ daemon remote-control # reports RC status (connects via client)
```

The `/remote-control` REPL command and `--remote-control`/`--rc` CLI flags are gated on `BRIDGE_MODE` (see Concept B) and are inactive in OCC. To use remote control, start the daemon — the RC server starts automatically.

## Concept B: CCR Bridge (`/remote-control` command)

This is a separate, higher-level feature: connecting the REPL bidirectionally to claude.ai (Claude Code Remote) so the session is controllable from mobile/web/Slack. **This is gated off in OCC.**

### Why it's off

The `BRIDGE_MODE` feature flag is not in the `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts`). Consequences:

- `/remote-control` (alias `/rc`) command is hidden (`isEnabled` returns false).
- `isBridgeEnabled()` returns false.
- `occ remote-control` CLI fast-path is dead code.
- `src/bridge/peerSessions.ts` (the bridge-peer messaging path) is a stub (`postInterClaudeMessage` returns `{ ok: false }`).

### What it would do (when enabled)

The `BridgeToggle` component (`src/commands/bridge/bridge.tsx`) would check prerequisites (policy `allow_remote_control`, subscription, version), then set `replBridgeEnabled: true` in AppState. This triggers `useReplBridge` in REPL.tsx, which calls `initReplBridge` → connects to CCR (creates a session, polls for work, connects an ingress WebSocket for bidirectional messaging). The bridge subsystem (`src/bridge/`) is large and compiled in, but inert without the flag.

### Related commands (also gated)

| Command | Status |
|---|---|
| `/remote-env` | Cloud-agent environment selection (gated on subscriber + policy) |
| `/web-setup` | Setup Claude Code on the web (gated on GrowthBook + policy) |
| `/teleport` | Stub (`isEnabled: false`) |

## Feature gating summary

The `FEATURE_ALLOWLIST` contains: `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`. It does **not** contain `BRIDGE_MODE`, `DAEMON`, `UDS_INBOX`, `CCR_AUTO_CONNECT`, or `CCR_MIRROR`.

- `feature('BRIDGE_MODE')` → false → Concept B is off.
- `feature('DAEMON')` → false → the `occ daemon` CLI fast-paths in `cli.tsx` are dead. The daemon is reachable only via the `main.tsx` Commander tree (the live path), and the RC HTTP server code runs when a supervisor is started through that path.
- `feature('UDS_INBOX')` → false → SendMessage UDS/bridge addressing is disabled; ListPeers cloud/remote_bridge scans stay stubbed.

## Related

- [Daemon](./daemon.md) — the supervisor that runs the RC server
- [FleetView](./fleetview.md) — daemon sessions in the fleet view
- [Settings](./settings.md) — `remote`, `sshConfigs`
