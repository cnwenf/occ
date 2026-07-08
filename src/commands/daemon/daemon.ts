import { existsSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import type { LocalCommandCall } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  stopExistingSupervisor,
  getDaemonColdStart,
} from '../../daemon/supervisor.js'
import { readLockfile, lockfileMtime } from '../../daemon/lockfile.js'
import {
  readDaemonStatus,
  readDaemonJson,
  getDaemonJsonPath,
} from '../../daemon/workerRegistry.js'
import { isPidAlive } from '../../daemon/process.js'
import { installPersistentService } from '../../daemon/install.js'

function daemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * /daemon — manage the background-agent daemon from inside the REPL.
 *
 * Subcommands mirror the `claude daemon <sub>` CLI handler:
 *   install    → installPersistentService() (launchd/systemd)
 *   status     → lockfile + daemon-status.json snapshot
 *   stop       → stopExistingSupervisor()
 *   logs       → tail ~/.claude/daemon.log
 *   scheduled  → daemon.json `scheduled` list
 */
export const call: LocalCommandCall = async (args) => {
  const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()
  switch (sub) {
    case '':
    case 'help':
    case '--help':
    case '-h':
      return { type: 'text', value: usage() }
    case 'install':
      return { type: 'text', value: await handleInstall() }
    case 'status':
      return { type: 'text', value: await handleStatus() }
    case 'stop':
      return { type: 'text', value: await handleStop() }
    case 'logs':
      return { type: 'text', value: handleLogs() }
    case 'scheduled':
      return { type: 'text', value: handleScheduled() }
    default:
      return {
        type: 'text',
        value: `Unknown daemon subcommand: ${sub}\n${usage()}`,
      }
  }
}

function usage(): string {
  return [
    'Usage: /daemon <subcommand>',
    '',
    'Subcommands:',
    '  install    Install the daemon as a persistent service (launchd/systemd)',
    '  status     Show supervisor + worker status',
    '  stop       Stop the running daemon supervisor',
    '  logs       Tail the daemon log (last ~200 lines)',
    '  scheduled  List scheduled tasks from daemon.json',
  ].join('\n')
}

async function handleInstall(): Promise<string> {
  try {
    // daemonInstall() wraps installPersistentService() + console.log; call the
    // underlying installer directly so we can return the result as text.
    return installPersistentService()
  } catch (err: unknown) {
    return `daemon install failed: ${toMessage(err)}`
  }
}

async function handleStatus(): Promise<string> {
  const lines: string[] = ['Daemon status']
  const lf = await readLockfile()
  const mtime = lockfileMtime()
  // getDaemonColdStart() reads globalConfig, which can throw if config isn't
  // bootstrapped yet (e.g. early invocation). Fall back to 'transient'.
  let cold: string = 'transient'
  try {
    cold = getDaemonColdStart()
  } catch {
    /* config not yet initialized — use default */
  }
  const workers = readDaemonStatus()

  if (!lf) {
    lines.push('  supervisor: not running (no lockfile)')
  } else {
    const alive = isPidAlive(lf.supervisorPid)
    lines.push(
      `  supervisor: pid=${lf.supervisorPid} ${alive ? 'running' : 'dead'} ` +
        `start=${new Date(lf.supervisorProcStart).toISOString()}` +
        `${mtime ? ` (lockfile mtime=${new Date(mtime).toISOString()})` : ''}`,
    )
  }
  lines.push(`  coldStart: ${cold}`)
  lines.push(
    `  daemon.json: ${getDaemonJsonPath()} (${existsSync(getDaemonJsonPath()) ? 'present' : 'absent'})`,
  )
  lines.push(`  workers: ${workers.length}`)
  for (const w of workers) {
    const alive = isPidAlive(w.pid)
    lines.push(
      `    id=${w.id} kind=${w.kind} pid=${w.pid} ${alive ? 'alive' : 'dead'} ` +
        `outcome=${w.outcome} started=${new Date(w.startedAt).toISOString()}`,
    )
  }
  return lines.join('\n')
}

async function handleStop(): Promise<string> {
  try {
    const res = await stopExistingSupervisor()
    if (res.holder && !res.stopped) {
      return 'Existing daemon refused to yield. Try /daemon stop again or check permissions.'
    }
    if (res.stopped && res.holder) {
      return `Stopped daemon (pid=${res.holder.supervisorPid}).`
    }
    return 'No daemon running.'
  } catch (err: unknown) {
    return `daemon stop failed: ${toMessage(err)}`
  }
}

function handleLogs(): string {
  const path = daemonLogPath()
  if (!existsSync(path)) {
    return `No daemon log at ${path}`
  }
  try {
    const out = execSync(`tail -n 200 ${JSON.stringify(path)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out
  } catch {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    return raw.split('\n').slice(-200).join('\n')
  }
}

function handleScheduled(): string {
  const scheduled = readDaemonJson().scheduled ?? []
  if (scheduled.length === 0) {
    return `No scheduled tasks in ${getDaemonJsonPath()}`
  }
  const lines: string[] = ['Scheduled tasks:']
  for (const t of scheduled) {
    lines.push(
      `  ${t.id}  ${t.schedule}  ${t.enabled ? 'enabled' : 'disabled'}  "${t.prompt}"`,
    )
  }
  return lines.join('\n')
}
