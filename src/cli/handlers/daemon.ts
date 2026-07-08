/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits: the preAction hook's init (enableConfigs, initSinks, analytics) starts timers that keep the event loop alive; explicit exit matches the pattern in auth.ts / mcp.ts. */
/**
 * CLI handlers for `claude daemon ...` and the top-level
 * `claude stop|attach|logs <id>` commands.
 *
 * Dynamically imported by main.tsx only when a daemon subcommand runs, so
 * the daemon modules don't load during normal `claude -p` / REPL startup
 * (the daemon must NOT auto-start in pipe mode).
 *
 * Subcommands:
 *   claude daemon install|status|stop|logs|uninstall|scheduled|
 *             remote-control|start|restart|hub|--help
 *   claude daemon stop --any
 *   claude daemon scheduled add|remove <task-id>
 *
 * Top-level:
 *   claude stop <id>    "Stop a background session"
 *   claude attach <id>  "Open/join the background session"
 *   claude logs <id>    "Print the background session..."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  daemonInstall,
  daemonRestart,
  daemonUninstall,
  displaceAny,
  getDaemonColdStart,
  runSupervisor,
  stopExistingSupervisor,
} from '../../daemon/supervisor.js'
import { readLockfile, lockfileMtime } from '../../daemon/lockfile.js'
import { getDaemonJsonPath, listWorkers, getWorker, settleWorker } from '../../daemon/workerRegistry.js'
import type { ScheduledTask } from '../../daemon/types.js'
import { isPidAlive } from '../../daemon/process.js'

/** ~/.claude/daemon.log — supervisor + worker stdout/stderr. */
function daemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

/** ~/.claude/daemon.scheduled.status.json — scheduled-task status snapshot. */
function scheduledStatusPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.scheduled.status.json')
}

/** Print usage for `claude daemon`. */
function printDaemonUsage(): void {
  console.log(`Usage: claude daemon <subcommand>

Subcommands:
  start              Start the supervisor (default)
  stop [--any]       Stop the supervisor (or displace any holder with --any)
  restart            Restart the supervisor
  status             Show supervisor + worker status
  logs               Tail the daemon log
  install            Install a persistent service (launchd/systemd)
  uninstall          Remove the persistent service
  scheduled add|rm   Manage scheduled tasks
  remote-control     Configure the remote-control daemon worker
  hub                Interactive daemon hub (TTY)
  --help             Show this help
`)
}

/**
 * Dispatcher for `claude daemon <sub>`. Called by main.tsx's `daemon`
 * command tree action, and by daemonMain() in src/daemon/main.ts for the
 * (feature-gated) fast-path.
 */
export async function daemonSubcommand(
  sub: string,
  args: string[],
): Promise<void> {
  switch (sub) {
    case 'start':
      await runSupervisor(['start', ...args])
      return // supervisor handles its own exit (process.exit in shutdown)
    case 'stop': {
      const any = args.includes('--any') || args.includes('-a')
      if (any) {
        const res = await displaceAny()
        if (res.displaced && res.holder) {
          console.log(
            `Stopped background sessions held by pid=${res.holder.supervisorPid}.`,
          )
        } else if (!res.holder) {
          console.log('No background sessions found.')
        }
      } else {
        const res = await stopExistingSupervisor()
        if (res.holder && !res.stopped) {
          console.error('Run `claude daemon stop --any` to stop any background sessions and report on the holder')
          process.exitCode = 1
        } else if (res.stopped && res.holder) {
          console.log(`Stopped daemon (pid=${res.holder.supervisorPid}).`)
        } else {
          console.log('No daemon running.')
        }
      }
      break
    }
    case 'restart':
      await daemonRestart()
      break // daemonRestart() calls process.exit(0) internally
    case 'status':
      await statusHandler()
      break
    case 'logs':
      await logsHandlerDaemon()
      break
    case 'install':
      await daemonInstall()
      break
    case 'uninstall':
      await daemonUninstall()
      break
    case 'scheduled':
      await scheduledHandler(args)
      break
    case 'remote-control': {
      // B7: report the local remote-control bridge status. Connects to the
      // daemon's RC HTTP server via the lockfile-discovered endpoint.
      logEvent('daemon_remote_control_cli', {})
      const { connectRemoteControlClient, resolveRemoteControlEndpoint } =
        await import('../../daemon/remoteControlClient.js')
      const endpoint = await resolveRemoteControlEndpoint()
      if (!endpoint) {
        console.log(
          'remote-control: daemon not running or RC server not configured. Run `claude daemon start` first.',
        )
        break
      }
      try {
        const client = await connectRemoteControlClient()
        const status = await client.getStatus()
        console.log(`remote-control: connected (socket ${endpoint.socketPath})`)
        console.log(`  supervisor pid: ${status.supervisorPid}`)
        console.log(`  workers: ${status.workers.length}`)
        console.log(`  pending prompts: ${status.pendingPrompts.length}`)
        console.log(
          `  channel: ${status.channel ? `#${status.channel.name}` : '(none)'}`,
        )
        for (const w of status.workers) {
          console.log(`    - ${w.id} kind=${w.kind} pid=${w.pid} outcome=${w.outcome}`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`remote-control: unable to connect — ${msg}`)
      }
      break
    }
    case 'hub':
      await renderDaemonHubStandalone()
      break
    case '--help':
    case '-h':
    case 'help':
      printDaemonUsage()
      break
    default:
      console.error(`Unknown daemon subcommand: ${sub}`)
      printDaemonUsage()
      process.exitCode = 1
  }
  // CLI subcommand handlers exit explicitly: the preAction hook's init
  // (enableConfigs, initSinks, analytics) starts timers/handles that keep
  // the event loop alive. Matches the pattern in auth.ts / mcp.ts.
  process.exit(process.exitCode ?? 0)
}

/** `claude daemon status` — print supervisor + worker status. */
async function statusHandler(): Promise<void> {
  const lf = await readLockfile()
  const mtime = lockfileMtime()
  const cold = getDaemonColdStart()
  const workers = listWorkers()

  console.log('Daemon status')
  if (!lf) {
    console.log('  supervisor: not running (no lockfile)')
  } else {
    const alive = isPidAlive(lf.supervisorPid)
    console.log(
      `  supervisor: pid=${lf.supervisorPid} ${alive ? 'running' : 'dead'} start=${new Date(lf.supervisorProcStart).toISOString()}${mtime ? ` (lockfile mtime=${new Date(mtime).toISOString()})` : ''}`,
    )
  }
  console.log(`  coldStart: ${cold}`)
  console.log(`  daemon.json: ${getDaemonJsonPath()} (${existsSync(getDaemonJsonPath()) ? 'present' : 'absent'})`)
  console.log(`  workers: ${workers.length}`)
  for (const w of workers) {
    const alive = isPidAlive(w.pid)
    console.log(
      `    id=${w.id} kind=${w.kind} pid=${w.pid} ${alive ? 'alive' : 'dead'} outcome=${w.outcome} restart=${w.restart} started=${new Date(w.startedAt).toISOString()}`,
    )
  }
}

/** `claude daemon logs` — tail the daemon log (last ~200 lines). */
async function logsHandlerDaemon(): Promise<void> {
  const path = daemonLogPath()
  if (!existsSync(path)) {
    console.log(`No daemon log at ${path}`)
    return
  }
  try {
    const out = execSync(`tail -n 200 ${JSON.stringify(path)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.stdout.write(out)
  } catch (err) {
    // Fallback: read the file directly.
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const lines = raw.split('\n').slice(-200).join('\n')
    process.stdout.write(lines)
  }
}

/** `claude daemon scheduled add|remove <task-id>` */
async function scheduledHandler(args: string[]): Promise<void> {
  const op = args[0]
  if (op !== 'add' && op !== 'remove' && op !== 'rm' && op !== 'list') {
    console.error('Usage: claude daemon scheduled add|remove <task-id> [--schedule <cron>] [--prompt <text>]')
    process.exitCode = 1
    return
  }

  const config = readScheduledConfig()

  if (op === 'list') {
    console.log('Scheduled tasks:')
    for (const t of config) {
      console.log(`  ${t.id}  ${t.schedule}  ${t.enabled ? 'enabled' : 'disabled'}  "${t.prompt}"`)
    }
    return
  }

  const taskId = args[1]
  if (!taskId) {
    console.error('task-id required')
    process.exitCode = 1
    return
  }

  if (op === 'add') {
    const schedule = flagValue(args, '--schedule') ?? '0 * * * *'
    const prompt = flagValue(args, '--prompt') ?? ''
    const task: ScheduledTask = { id: taskId, schedule, prompt, enabled: true }
    const idx = config.findIndex(t => t.id === taskId)
    if (idx >= 0) config[idx] = task
    else config.push(task)
    writeScheduledConfig(config)
    logEvent('daemon_scheduled_add', { taskId: taskId as any })
    console.log(`Scheduled task ${taskId} added.`)
  } else {
    const idx = config.findIndex(t => t.id === taskId)
    if (idx < 0) {
      console.error(`Scheduled task ${taskId} not found.`)
      process.exitCode = 1
      return
    }
    config.splice(idx, 1)
    writeScheduledConfig(config)
    logEvent('daemon_scheduled_remove', { taskId: taskId as any })
    console.log(`Scheduled task ${taskId} removed.`)
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

/** Read the scheduled-task list from daemon.json (scheduled field). */
function readScheduledConfig(): ScheduledTask[] {
  const path = getDaemonJsonPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' }))
    return Array.isArray(parsed?.scheduled) ? parsed.scheduled : []
  } catch {
    return []
  }
}

/** Write the scheduled-task list back to daemon.json (preserving other fields). */
function writeScheduledConfig(tasks: ScheduledTask[]): void {
  const path = getDaemonJsonPath()
  let current: any = {}
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, { encoding: 'utf-8' }))
    } catch {
      current = {}
    }
  }
  current.scheduled = tasks
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(current, null, 2), { encoding: 'utf-8' })
  // Mirror to daemon.scheduled.status.json (the status snapshot the binary emits).
  writeFileSync(scheduledStatusPath(), JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2), {
    encoding: 'utf-8',
  })
}

/**
 * renderDaemonHubStandalone — `claude daemon hub`.
 *
 * The full Ink TTY hub (renderDaemonHubStandalone in the binary) is a
 * follow-up; for B1-B5 we emit a real, refreshed status table so the
 * subcommand is functional, not a stub.
 */
async function renderDaemonHubStandalone(): Promise<void> {
  console.log('Claude daemon hub')
  await statusHandler()
  console.log('\n(Press q to quit — interactive hub is a follow-up.)')
}

// ─── Top-level commands: claude stop|attach|logs <id> ────────────────────

/**
 * `claude stop <id>` — "Stop a background session".
 * SIGTERM the worker with the given id and settle it.
 */
export async function stopHandler(id: string): Promise<void> {
  const w = getWorker(id)
  if (!w) {
    // No in-process worker — try the lockfile holder (a supervisor) by id.
    // For ids that match a supervisor pid, stop the supervisor.
    const pid = Number(id)
    if (Number.isFinite(pid) && isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
        console.log(`Sent SIGTERM to pid ${pid}.`)
        process.exit(0)
      } catch {
        /* fall through */
      }
    }
    console.error(`No background session "${id}" found.`)
    process.exitCode = 1
    process.exit(process.exitCode ?? 1)
    return
  }
  await settleWorker(id, 3000)
  console.log(`Stopped background session ${id} (pid=${w.pid}).`)
  process.exit(process.exitCode ?? 0)
}

/**
 * `claude attach <id>` — "Open/join the background session".
 *
 * Full attach (reconnect to the worker's IPC) is a follow-up; for B1-B5 we
 * report the worker's status + log path so the user can tail it.
 */
export async function attachHandler(id: string): Promise<void> {
  const w = getWorker(id)
  if (!w) {
    console.error(`No background session "${id}" found.`)
    process.exitCode = 1
    process.exit(process.exitCode ?? 1)
    return
  }
  console.log(
    `Background session ${id}: kind=${w.kind} pid=${w.pid} outcome=${w.outcome} started=${new Date(w.startedAt).toISOString()}`,
  )
  console.log(`Log: ${daemonLogPath()}`)
  console.log('(Interactive attach is a follow-up.)')
  process.exit(process.exitCode ?? 0)
}

/**
 * `claude logs <id>` — "Print the background session...".
 * Tails the daemon log filtered to the worker's pid.
 */
export async function logsHandler(id: string): Promise<void> {
  const path = daemonLogPath()
  if (!existsSync(path)) {
    console.log(`No daemon log at ${path}`)
    process.exit(0)
  }
  // If a worker id is given, try to filter to its pid.
  const w = getWorker(id)
  const pid = w?.pid ?? Number(id)
  try {
    const grep = Number.isFinite(pid) ? `grep -F "[pid=${pid}]" ${JSON.stringify(path)} || true` : null
    const cmd = grep
      ? `${grep} | tail -n 200`
      : `tail -n 200 ${JSON.stringify(path)}`
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    process.stdout.write(out)
  } catch {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    process.stdout.write(raw.split('\n').slice(-200).join('\n'))
  }
  process.exit(process.exitCode ?? 0)
}

/** Append a line to the daemon log (used by the supervisor for structured logs). */
export function appendDaemonLog(line: string): void {
  try {
    mkdirSync(join(daemonLogPath(), '..'), { recursive: true })
    appendFileSync(daemonLogPath(), line.endsWith('\n') ? line : line + '\n', {
      encoding: 'utf-8',
    })
  } catch {
    /* ignore */
  }
}
