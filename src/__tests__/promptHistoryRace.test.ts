import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { addToHistory, historyFs, readHistoryForTest } from '../history.js'

/**
 * Claude Code 2.1.218 #21: "Fixed prompt history entries being dropped or
 * duplicated when history writes raced or failed."
 *
 * OCC persists prompt history (previously-typed prompts) to
 * `<config>/history.jsonl`. The old flush path cleared the in-memory pending
 * buffer (`pendingEntries = []`) BEFORE confirming the disk write succeeded,
 * and used a non-atomic `appendFile`. When two writes raced or a write failed
 * mid-flight, entries were silently lost (buffer cleared, nothing retried)
 * or duplicated (partial append + retry).
 *
 * The fix: writes are serialized and atomic — existing content + new lines
 * are written to a temp file then `rename`d into place, so a failed write
 * leaves the existing history untouched, and the flushed entries are
 * re-queued (not dropped) for the next retry.
 *
 * The fs surface used by the flush is exposed via `historyFs` so a transient
 * write failure can be injected without mocking the whole `fs/promises`
 * module (which leaks process-wide and breaks the cross-process lockfile,
 * which uses `graceful-fs` over the sync `fs`, not `fs/promises`).
 */

describe('2.1.218 #21: race-safe prompt-history writes', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  const savedSkip = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  let tmpConfig: string
  let originalWriteFile: typeof historyFs.writeFile

  beforeEach(() => {
    tmpConfig = ''
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    originalWriteFile = historyFs.writeFile
  })

  afterEach(async () => {
    historyFs.writeFile = originalWriteFile
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedSkip === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = savedSkip
    // Refresh the memoized config-dir lookup for the next test.
    const cache = (getClaudeConfigHomeDir as unknown as { cache?: { clear?: () => void } }).cache
    cache?.clear?.()
    if (tmpConfig) await rm(tmpConfig, { recursive: true, force: true })
  })

  async function useTmpConfig(): Promise<string> {
    tmpConfig = await mkdtemp(join(tmpdir(), 'occ-history-race-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfig
    const cache = (getClaudeConfigHomeDir as unknown as { cache?: { clear?: () => void } }).cache
    cache?.clear?.()
    // tmpConfig (from mkdtemp) is the config dir; history.jsonl is a file in it.
    return tmpConfig
  }

  async function historyPath(): Promise<string> {
    return join(getClaudeConfigHomeDir(), 'history.jsonl')
  }

  /**
   * Throws on the first call, then delegates to the real writeFile. Simulates
   * a transient write failure that races with concurrent history appends.
   */
  function makeWriteFileFailOnce(real: typeof historyFs.writeFile) {
    let failed = false
    return (async (...args: Parameters<typeof real>) => {
      if (!failed) {
        failed = true
        throw Object.assign(new Error('E synthetic history write failure'), {
          code: 'ESYNTHETIC',
        })
      }
      // @ts-expect-error: spread into the real writeFile signature
      return real(...args)
    }) as typeof real
  }

  test('(a) N concurrent appends with a racing write failure — no drops, no dupes', async () => {
    await useTmpConfig()

    // Inject a one-shot write failure on the atomic temp-file write.
    historyFs.writeFile = makeWriteFileFailOnce(originalWriteFile)

    const N = 50
    const entries = Array.from({ length: N }, (_, i) => `prompt-${i}`)
    // Fire all appends "concurrently" — they are serialized internally, but
    // the first flush hits the injected failure and must retry without losing
    // any of the 50 distinct entries.
    await Promise.all(entries.map(e => addToHistory(e)))

    // Drain: poll until the retry flush lands all entries (the retry backs off
    // ~500ms after a failure), with a generous timeout for slow CI.
    const deadline = Date.now() + 10_000
    let lines: string[] = []
    while (Date.now() < deadline) {
      lines = await readHistoryForTest(await historyPath())
      if (lines.length >= N) break
      await new Promise(r => setTimeout(r, 50))
    }

    const displays = lines
      .map(l => {
        try {
          return JSON.parse(l).display
        } catch {
          return null
        }
      })
      .filter((d): d is string => typeof d === 'string')

    // No drops: every distinct entry persisted exactly once.
    expect(displays).toHaveLength(N)
    expect(new Set(displays).size).toBe(N)
    for (const e of entries) {
      expect(displays.filter(d => d === e)).toHaveLength(1)
    }
  })

  test('(b) a write that fails mid-way preserves existing history and retries the entry', async () => {
    const dir = await useTmpConfig()
    const path = join(dir, 'history.jsonl')

    // Pre-seed two existing entries on disk.
    const existing = [
      JSON.stringify({ display: 'old-1', pastedContents: {}, timestamp: 1, project: '/p' }) + '\n',
      JSON.stringify({ display: 'old-2', pastedContents: {}, timestamp: 2, project: '/p' }) + '\n',
    ].join('')
    await writeFile(path, existing, { encoding: 'utf8', mode: 0o600 })

    // Inject a one-shot write failure on the atomic temp-file write.
    historyFs.writeFile = makeWriteFileFailOnce(originalWriteFile)

    addToHistory('new-prompt')

    // Drain: the failed write is re-queued and retried.
    const deadline = Date.now() + 10_000
    let lines: string[] = []
    while (Date.now() < deadline) {
      lines = await readHistoryForTest(path)
      if (lines.some(l => l.includes('new-prompt'))) break
      await new Promise(r => setTimeout(r, 50))
    }

    const displays = lines
      .map(l => {
        try {
          return JSON.parse(l).display
        } catch {
          return null
        }
      })
      .filter((d): d is string => typeof d === 'string')

    // Existing history is preserved (not corrupted/emptied by the failed write).
    expect(displays).toContain('old-1')
    expect(displays).toContain('old-2')
    // The failed entry was retried, not silently lost.
    expect(displays).toContain('new-prompt')
    // Exactly one copy of each (no duplication from the race/retry).
    expect(displays.filter(d => d === 'old-1')).toHaveLength(1)
    expect(displays.filter(d => d === 'old-2')).toHaveLength(1)
    expect(displays.filter(d => d === 'new-prompt')).toHaveLength(1)
  })

  test('(c) plain concurrent appends with no failure — all present once', async () => {
    await useTmpConfig()

    const N = 50
    const entries = Array.from({ length: N }, (_, i) => `clean-${i}`)
    await Promise.all(entries.map(e => addToHistory(e)))

    // Drain the in-flight flush.
    const deadline = Date.now() + 5_000
    let lines: string[] = []
    while (Date.now() < deadline) {
      lines = await readHistoryForTest(await historyPath())
      if (lines.length >= N) break
      await new Promise(r => setTimeout(r, 50))
    }

    const displays = lines
      .map(l => {
        try {
          return JSON.parse(l).display
        } catch {
          return null
        }
      })
      .filter((d): d is string => typeof d === 'string')

    expect(displays).toHaveLength(N)
    expect(new Set(displays).size).toBe(N)
  })
})
