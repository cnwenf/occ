/**
 * K3 (2.1.154): Workflow journal — per-run append-only log of completed
 * agent() calls, used for resume.
 *
 * Mirrors the 2.1.200 binary's LocalFileJournal class:
 *   - path = <transcriptDir>/journal.jsonl
 *   - load(): read lines, JSON.parse each, skip unparseable (warn), return
 *     Map<key, result> of completed agents.
 *   - append({type:"started", key, agentId}) before each agent() spawn.
 *   - append({type:"result", key, agentId, result}) after each agent()
 *     completes. One {"type":"result",...} line per completed agent.
 *   - invalidate() clears the file + cache.
 *
 * Cache key = stableStringify(prompt) + stableStringify(opts) hash — "the
 * longest unchanged prefix of agent() calls returns cached results
 * instantly; only edited or new calls re-run."
 *
 * Appends are serialized (sequential()) to avoid concurrent-write
 * corruption when parallel()/pipeline() branches complete simultaneously.
 */
import { createHash } from 'crypto'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { sequential } from '../../utils/sequential.js'

export interface JournalStartedEntry {
  type: 'started'
  key: string
  agentId: string
  /** ISO timestamp for debugging (NOT used for resume logic — resume is
   * deterministic via cache key, not time). */
  ts: number
}

export interface JournalResultEntry {
  type: 'result'
  key: string
  agentId: string
  result: unknown
  /** Token count spent by this agent (for budget tracking on resume). */
  tokens?: number
  ts: number
}

export type JournalEntry = JournalStartedEntry | JournalResultEntry

/**
 * Compute a stable cache key for an agent() call from its prompt + opts.
 * Mirrors the binary: "Completed agent() calls with unchanged (prompt,
 * opts) return their cached results instantly."
 */
export function computeAgentKey(
  prompt: string,
  opts: Record<string, unknown> = {},
): string {
  // Stable stringify: sort object keys recursively.
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    const keys = Object.keys(v as Record<string, unknown>).sort()
    return `{${keys.map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}`
  }
  const material = stable({ prompt, opts })
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/**
 * Append-only JSONL journal for workflow agent results.
 */
export class WorkflowJournal {
  readonly path: string
  private appendSeq: (entry: JournalEntry) => Promise<void>

  constructor(transcriptDir: string) {
    this.path = join(transcriptDir, 'journal.jsonl')
    this.appendSeq = sequential(async (entry: JournalEntry) => {
      await mkdir(join(this.path, '..'), { recursive: true })
      await writeFile(this.path, JSON.stringify(entry) + '\n', {
        flag: 'a',
        encoding: 'utf8',
      })
    })
  }

  /**
   * Load all entries. Returns a Map<key, result> of completed agents
   * (type:"result" entries). Skips unparseable lines (warns via
   * logForDebugging, matching the binary: "LocalFileJournal: skipping
   * unparseable line").
   */
  async load(): Promise<Map<string, unknown>> {
    const cache = new Map<string, unknown>()
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return cache // no journal yet — fresh run
    }
    const lines = text.split('\n').filter(l => l.trim())
    for (const line of lines) {
      let entry: JournalEntry
      try {
        entry = JSON.parse(line) as JournalEntry
      } catch {
        logForDebugging(
          `LocalFileJournal: skipping unparseable line in ${this.path}`,
        )
        continue
      }
      if (entry.type === 'result') {
        cache.set(entry.key, entry.result)
      }
    }
    return cache
  }

  /**
   * Append a "started" marker (pre-spawn). Used to detect respawn attempts
   * on resume (tengu_workflow_journal_started_hit_respawn).
   */
  async appendStarted(key: string, agentId: string): Promise<void> {
    await this.appendSeq({ type: 'started', key, agentId, ts: Date.now() })
  }

  /**
   * Append a "result" entry (post-completion). This is what resume reads.
   */
  async appendResult(
    key: string,
    agentId: string,
    result: unknown,
    tokens?: number,
  ): Promise<void> {
    await this.appendSeq({
      type: 'result',
      key,
      agentId,
      result,
      tokens,
      ts: Date.now(),
    })
  }

  /**
   * Mark an agent as "skipped" — on resume it replays as null. Used by
   * skipWorkflowAgent.
   */
  async markSkipped(key: string): Promise<void> {
    await this.appendSeq({
      type: 'result',
      key,
      agentId: 'skipped',
      result: null,
      ts: Date.now(),
    })
  }

  /**
   * Delete all journal entries for a given agent key (so it re-runs on next
   * resume). Used by retryWorkflowAgent. Rewrites the file without the
   * matching entries.
   */
  async deleteKey(key: string): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n').filter(l => l.trim())
    const kept: string[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry
        if (entry.key === key) continue
      } catch {
        continue
      }
      kept.push(line)
    }
    if (kept.length === 0) {
      try {
        await unlink(this.path)
      } catch {
        // ignore
      }
    } else {
      await writeFile(this.path, kept.join('\n') + '\n', 'utf8')
    }
  }

  /**
   * Invalidate (clear) the journal. Busts the cache entirely.
   */
  async invalidate(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      // ignore — file may not exist
    }
  }
}
