/**
 * Workflow progress file helpers for the daemon-worker async launch path.
 *
 * When a workflow is launched with `remote: true`, WorkflowTool.call() spawns a
 * separate daemon-worker process (kind 'workflow') that runs runWorkflow with a
 * non-interactive toolUseContext (no Ink renderer — see workflowWorker.ts).
 * Because the worker is a separate process, it CANNOT mutate the main OCC's
 * AppState (that would require a shared store reachable from a background
 * promise, which crashes the Ink renderer via cross-root flushSyncWork).
 *
 * Instead, the worker writes progress snapshots (phases/agents/status/result)
 * to a JSON file at ~/.claude/wf-progress/<runId>.json, and a MAIN-THREAD
 * poller (useWorkflowProgressPoller in the REPL) reads these files and updates
 * AppState from the main thread — safe, no background setAppState, no Ink
 * crash. This is the file channel between the worker process and the REPL.
 *
 * All operations are best-effort: a missing/malformed progress file must never
 * throw (the poller treats it as "no update"; the worker treats a write
 * failure as non-fatal — the run continues, the poller just won't see live
 * progress until it recovers).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

/** Directory holding per-run progress JSON files (~/.claude/wf-progress/). */
export function getWfProgressDir(): string {
  return join(getClaudeConfigHomeDir(), 'wf-progress')
}

/** Shape persisted to disk. `runId` + `updatedAt` are always present; the rest
 *  is whatever the worker's onProgress/terminal handler emitted. */
export type WorkflowProgressFile = {
  runId: string
  updatedAt: number
  /** Discriminated by `type` — matches the engine/worker event types. */
  [key: string]: unknown
}

/**
 * Atomically write a progress snapshot for a run. Writes to a temp file then
 * renames, so the poller never reads a half-written JSON. Best-effort: never
 * throws (a write failure just means the poller won't see this update).
 */
export function writeWorkflowProgress(runId: string, data: Record<string, unknown>): void {
  try {
    const dir = getWfProgressDir()
    mkdirSync(dir, { recursive: true })
    const payload: WorkflowProgressFile = {
      runId,
      updatedAt: Date.now(),
      ...data,
    }
    const target = join(dir, `${runId}.json`)
    const tmp = join(dir, `${runId}.json.tmp`)
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf-8' })
    renameSync(tmp, target)
  } catch {
    // Non-fatal — the worker continues; the poller just misses this update.
  }
}

/**
 * Read the latest progress snapshot for a run. Returns null on a missing or
 * malformed file (never throws — the poller calls this on a hot interval).
 */
export function readWorkflowProgress(runId: string): WorkflowProgressFile | null {
  const path = join(getWfProgressDir(), `${runId}.json`)
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, { encoding: 'utf-8' })
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as WorkflowProgressFile
    if (!parsed || typeof parsed.runId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Delete the progress file for a run (called by the poller once the task has
 * reached a terminal state and been moved into AppState, so stale files don't
 * accumulate). Best-effort.
 */
export function deleteWorkflowProgress(runId: string): void {
  try {
    unlinkSync(join(getWfProgressDir(), `${runId}.json`))
  } catch {
    // ignore — already gone or never written
  }
}

/**
 * List ALL progress files (used by the poller to discover running workflows it
 * doesn't yet know about, e.g. workflows launched in a prior session that the
 * task registry no longer tracks). Returns parsed snapshots, skipping
 * malformed entries. Never throws.
 */
export function listWorkflowProgress(): WorkflowProgressFile[] {
  const dir = getWfProgressDir()
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: WorkflowProgressFile[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const runId = name.slice(0, -5) // strip ".json"
    const snap = readWorkflowProgress(runId)
    if (snap) out.push(snap)
  }
  return out
}
