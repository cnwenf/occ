/**
 * Agents subcommand handler.
 *
 * Default (`claude agents`): a background-sessions dashboard showing running
 * daemon workers (live via the remote-control client, or from the on-disk
 * status snapshot when the daemon is unreachable).
 *
 * `claude agents --definitions`: the original behaviour — list configured
 * agent definitions from ~/.claude/agents/ and other sources.
 *
 * `--json`: emit a JSON array (sessions for the dashboard, definitions for
 * `--definitions`) for programmatic access.
 *
 * Dynamically imported only when `claude agents` runs.
 */

import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  type ResolvedAgent,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { readDaemonStatus } from '../../daemon/workerRegistry.js'
import { isPidAlive } from '../../daemon/process.js'
import { readLockfile } from '../../daemon/lockfile.js'
import {
  connectRemoteControlClient,
  resolveRemoteControlEndpoint,
  type RemoteControlStatus,
} from '../../daemon/remoteControlClient.js'
import type { WorkerRecord } from '../../daemon/types.js'

export interface AgentsHandlerOptions {
  /** Show configured agent definitions instead of the sessions dashboard. */
  definitions?: boolean
  /** Emit a JSON array instead of human-readable text. */
  json?: boolean
  /** Comma-separated list of setting sources to load (passed to config). */
  settingSources?: string
}

/** A normalized background-session row used for both display and JSON output. */
interface SessionRow {
  id: string
  kind: string
  /** Derived status: 'running' when alive, else the settled outcome (or 'dead'). */
  status: string
  pid: number
  startedAt: number
  cwd: string
  restart: number
  /** Whether the worker's pid is currently alive. */
  alive: boolean
  /** Where the row came from. */
  source: 'daemon-rc' | 'daemon-snapshot'
  /** Supervisor pid, when known from the RC client / lockfile. */
  supervisorPid?: number
}

export async function agentsHandler(opts: AgentsHandlerOptions = {}): Promise<void> {
  if (opts.definitions) {
    await listAgentDefinitions(opts.json)
    return
  }
  await agentsDashboard(opts.json)
}

// ─── Background-sessions dashboard ──────────────────────────────────────

/**
 * Render the background-sessions dashboard.
 *
 * Prefers live data from the daemon's remote-control HTTP server
 * (authoritative when the daemon is running). Falls back to the on-disk
 * status snapshot (~/.claude/daemon-status.json) when the RC server is not
 * reachable. Each row is enriched with a real liveness check (isPidAlive).
 */
async function agentsDashboard(json: boolean | undefined): Promise<void> {
  const rows = await collectSessionRows()

  if (json) {
    console.log(JSON.stringify(rows))
    return
  }

  const supervisorPid = rows[0]?.supervisorPid
  if (rows.length === 0) {
    console.log('No background sessions found.')
    console.log('\nStart the daemon with: claude daemon start')
    return
  }

  const running = rows.filter(r => r.alive).length
  const header = supervisorPid
    ? `Background sessions (supervisor pid=${supervisorPid})`
    : 'Background sessions'
  console.log(header)
  console.log()
  console.log(renderSessionTable(rows))
  console.log(
    `\n${rows.length} session${rows.length === 1 ? '' : 's'} · ${running} running`,
  )
}

/**
 * Gather session rows from the live RC server, falling back to the on-disk
 * snapshot. Enriches each row with a live pid liveness check.
 */
async function collectSessionRows(): Promise<SessionRow[]> {
  // 1. Try the live remote-control endpoint (authoritative when daemon is up).
  const rcRows = await collectFromRemoteControl()
  if (rcRows.length > 0) {
    return rcRows
  }

  // 2. Fall back to the on-disk status snapshot.
  const snapshotRows = collectFromSnapshot()
  // Even from the snapshot, try to report the supervisor pid from the lockfile.
  if (snapshotRows.length > 0) {
    const lf = await readLockfile().catch(() => null)
    const supervisorPid = lf?.supervisorPid
    if (supervisorPid !== undefined) {
      return snapshotRows.map(r => ({ ...r, supervisorPid }))
    }
    return snapshotRows
  }

  // 3. RC was reachable but reported zero workers — preserve the supervisor pid.
  return rcRows
}

/** Query the daemon's RC server for live worker data. Returns [] if unreachable. */
async function collectFromRemoteControl(): Promise<SessionRow[]> {
  let endpoint
  try {
    endpoint = await resolveRemoteControlEndpoint()
  } catch {
    return []
  }
  if (!endpoint) return []

  let status: RemoteControlStatus
  try {
    const client = await connectRemoteControlClient()
    status = await client.getStatus()
  } catch {
    return []
  }

  return status.workers.map(w => {
    const alive = isPidAlive(w.pid)
    return {
      id: w.id,
      kind: w.kind,
      status: alive ? 'running' : deriveDeadStatus(w.outcome),
      pid: w.pid,
      startedAt: w.startedAt,
      cwd: w.cwd,
      restart: w.restart,
      alive,
      source: 'daemon-rc' as const,
      supervisorPid: status.supervisorPid,
    }
  })
}

/** Read the persisted status snapshot. Returns [] if missing/malformed. */
function collectFromSnapshot(): SessionRow[] {
  const records = readDaemonStatus()
  return records.map(w => toSessionRow(w, 'daemon-snapshot'))
}

/** Convert a WorkerRecord (snapshot) to a SessionRow with a liveness check. */
function toSessionRow(
  w: WorkerRecord,
  source: 'daemon-rc' | 'daemon-snapshot',
): SessionRow {
  const alive = isPidAlive(w.pid)
  return {
    id: w.id,
    kind: w.kind,
    status: alive ? 'running' : deriveDeadStatus(w.outcome),
    pid: w.pid,
    startedAt: w.startedAt,
    cwd: w.cwd,
    restart: w.restart,
    alive,
    source,
  }
}

/**
 * Map a settled worker outcome to a display status when the pid is no longer
 * alive. 'running' with a dead pid means the process died unexpectedly.
 */
function deriveDeadStatus(outcome: string): string {
  if (outcome === 'running') return 'dead'
  return outcome
}

/** Render session rows as a fixed-column table. */
function renderSessionTable(rows: SessionRow[]): string {
  const idW = Math.max(2, ...rows.map(r => r.id.length))
  const kindW = Math.max(4, ...rows.map(r => r.kind.length))
  const statusW = Math.max(6, ...rows.map(r => r.status.length))
  const cwdMax = 40

  const fmtLine = (r: SessionRow): string => {
    const started = new Date(r.startedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
    const cwd = r.cwd.length > cwdMax ? `…${r.cwd.slice(-(cwdMax - 1))}` : r.cwd
    return [
      r.id.padEnd(idW),
      r.kind.padEnd(kindW),
      r.status.padEnd(statusW),
      String(r.pid).padStart(7),
      started,
      cwd,
    ].join('  ')
  }

  const header = [
    'ID'.padEnd(idW),
    'KIND'.padEnd(kindW),
    'STATUS'.padEnd(statusW),
    'PID'.padStart(7),
    'STARTED',
    'CWD',
  ].join('  ')

  return [header, ...rows.map(fmtLine)].join('\n')
}

// ─── Agent definitions (`--definitions`) ─────────────────────────────────

/** List configured agent definitions (the original `claude agents` behaviour). */
async function listAgentDefinitions(json: boolean | undefined): Promise<void> {
  const cwd = getCwd()
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const activeAgents = getActiveAgentsFromList(allAgents)
  const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

  if (json) {
    const payload = resolvedAgents.map(a => ({
      agentType: a.agentType,
      source: a.source,
      model: resolveAgentModelDisplay(a) ?? null,
      memory: a.memory ?? null,
      overriddenBy: a.overriddenBy ?? null,
      whenToUse: a.whenToUse ?? null,
    }))
    console.log(JSON.stringify(payload))
    return
  }

  const lines: string[] = []
  let totalActive = 0

  for (const { label, source } of AGENT_SOURCE_GROUPS) {
    const groupAgents = resolvedAgents
      .filter(a => a.source === source)
      .sort(compareAgentsByName)

    if (groupAgents.length === 0) continue

    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      if (agent.overriddenBy) {
        const winnerSource = getOverrideSourceLabel(agent.overriddenBy)
        lines.push(`  (shadowed by ${winnerSource}) ${formatAgent(agent)}`)
      } else {
        lines.push(`  ${formatAgent(agent)}`)
        totalActive++
      }
    }
    lines.push('')
  }

  if (lines.length === 0) {
    console.log('No agents found.')
  } else {
    console.log(`${totalActive} active agents\n`)
    console.log(lines.join('\n').trimEnd())
  }
}

function formatAgent(agent: ResolvedAgent): string {
  const model = resolveAgentModelDisplay(agent)
  const parts = [agent.agentType]
  if (model) {
    parts.push(model)
  }
  if (agent.memory) {
    parts.push(`${agent.memory} memory`)
  }
  return parts.join(' · ')
}
