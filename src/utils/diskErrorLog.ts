import { appendFile, readFile } from 'node:fs/promises'
import { statSync, renameSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../bootstrap/state.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB — rotate when active exceeds
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100MB — hard cap across all rotated files
const MAX_ROTATED_FILES = 10 // 10 × 10MB = 100MB

export type ErrorKind =
  | 'uncaught'
  | 'unhandledRejection'
  | 'api'
  | 'mcp'
  | 'tool'
  | 'generic'

export interface DiskLogEntry {
  ts: string
  level: 'error'
  kind: ErrorKind
  message: string
  stack?: string
  project?: string
  sessionId?: string
}

export function getDiskErrorLogPath(): string {
  return process.env.OCC_ERROR_LOG_PATH ?? join(homedir(), '.claude', 'occ-errors.log')
}

/**
 * Append one error entry to the global rotating JSONL log.
 * Never throws — on fs failure it silently degrades (logger must not throw).
 */
export async function appendToDiskLog(entry: DiskLogEntry): Promise<void> {
  const path = getDiskErrorLogPath()
  try {
    const line = JSON.stringify(entry) + '\n'
    await appendFile(path, line, { flag: 'a' })
    await maybeRotate()
  } catch {
    // logger must never throw
  }
}

async function maybeRotate(): Promise<void> {
  const path = getDiskErrorLogPath()
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size <= MAX_FILE_BYTES) return
  try {
    const oldest = `${path}.${MAX_ROTATED_FILES}`
    if (existsSync(oldest)) rmSync(oldest)
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${path}.${i}`
      const dst = `${path}.${i + 1}`
      if (existsSync(src)) renameSync(src, dst)
    }
    renameSync(path, `${path}.1`)
    // Recreate an empty active file so subsequent appends/statSync have a
    // target (spec §5.1: "rename current → .log.1, create new empty .log").
    writeFileSync(path, '')
    await enforceTotalCap()
  } catch {
    // rotation failure — don't block logging
  }
}

async function enforceTotalCap(): Promise<void> {
  const path = getDiskErrorLogPath()
  const files: Array<{ p: string; size: number; idx: number }> = []
  try {
    files.push({ p: path, size: statSync(path).size, idx: 0 })
  } catch {
    // active missing — ignore
  }
  for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
    const p = `${path}.${i}`
    try {
      files.push({ p, size: statSync(p).size, idx: i })
    } catch {
      // missing rotated file — ignore
    }
  }
  files.sort((a, b) => b.idx - a.idx)
  let total = files.reduce((s, f) => s + f.size, 0)
  for (const f of files) {
    if (total <= MAX_TOTAL_BYTES) break
    if (f.idx === 0) continue // never delete the active file
    try {
      rmSync(f.p)
      total -= f.size
    } catch {
      // ignore
    }
  }
}

/**
 * Read the last n entries from the global log (newest first across active + .1).
 * Skips malformed lines. Returns [] if no file. Never throws.
 */
export async function readErrorLogTail(n: number): Promise<DiskLogEntry[]> {
  if (n <= 0) return []
  const path = getDiskErrorLogPath()
  const entries: DiskLogEntry[] = []
  for (const p of [path, `${path}.1`]) {
    try {
      const content = await readFile(p, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as DiskLogEntry)
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // missing file — ignore
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return entries.slice(-n).reverse() // newest first
}

/** Build a DiskLogEntry from a raw error string + kind. */
export function buildDiskLogEntry(
  errorStr: string,
  kind: ErrorKind,
): DiskLogEntry {
  const entry: DiskLogEntry = {
    ts: new Date().toISOString(),
    level: 'error',
    kind,
    message: errorStr.split('\n')[0] ?? errorStr,
    stack: errorStr.includes('\n') ? errorStr : undefined,
  }
  try {
    entry.project = process.cwd().split('/').pop() || undefined
  } catch {
    // omit
  }
  try {
    entry.sessionId = getSessionId()
  } catch {
    // omit
  }
  return entry
}
