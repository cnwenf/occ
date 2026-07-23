import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendEntryForTesting,
  resetProjectForTesting,
  resetTranscriptWriteWarnings,
  setSessionFileForTesting,
  transcriptWriteFs,
} from '../utils/sessionStorage.js'

/**
 * Claude Code 2.1.217 #2: "Added warnings when transcript writes are failing
 * (e.g. disk full) or when session saving is off due to an inherited
 * environment variable, instead of losing transcripts silently."
 *
 * OCC persists session transcripts to `<config>/projects/<slug>/<session>.jsonl`.
 * Before this fix, two silent-loss paths existed:
 *
 *  (a) Write failure: when the underlying `appendFile` failed (disk full /
 *      EACCES / EIO / ENOSPC), the error propagated through the drain-queue
 *      `setTimeout` callback as an unhandled rejection — swallowed silently,
 *      no user-facing warning. The user had no idea transcripts were being
 *      lost.
 *
 *  (b) Session-saving-off: when `CLAUDE_CODE_SKIP_PROMPT_HISTORY` (an env var
 *      inherited from the parent process, set by tmux test harnesses) was
 *      truthy, `shouldSkipPersistence()` returned true and `appendEntry()`
 *      returned early — silently, no warning. The user had no idea
 *      transcripts were not being saved.
 *
 * The fix: both paths now emit a one-time, user-facing `process.stderr.write`
 * warning (deduplicated to avoid spam) so the user knows transcripts are
 * being lost / not saved.
 */

describe('2.1.217 #2: transcript write / session-saving-off warnings', () => {
  const savedSkip = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tmpConfig: string
  let originalAppendFile: typeof transcriptWriteFs.appendFile
  let stderrSpy: string[]
  let originalStderrWrite: typeof process.stderr.write

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
    process.env.NODE_ENV = 'test'
    tmpConfig = ''
    originalAppendFile = transcriptWriteFs.appendFile
    resetTranscriptWriteWarnings()
    resetProjectForTesting()

    stderrSpy = []
    originalStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrSpy.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stderr.write
  })

  afterEach(async () => {
    process.stderr.write = originalStderrWrite
    transcriptWriteFs.appendFile = originalAppendFile
    if (savedSkip === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = savedSkip
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    resetTranscriptWriteWarnings()
    resetProjectForTesting()
    if (tmpConfig) await rm(tmpConfig, { recursive: true, force: true })
  })

  /**
   * Captures whether the stderr spy received a warning matching a substring.
   */
  function stderrIncludes(substr: string): boolean {
    return stderrSpy.some(s => s.includes(substr))
  }

  test('(i) a failed transcript write (ENOSPC) emits a warning, not silent', async () => {
    // Point the session file at a real temp path so the mkdir retry path
    // is exercised — but make appendFile always fail with ENOSPC.
    tmpConfig = await mkdtemp(join(tmpdir(), 'occ-transcript-warn-'))
    const sessionFile = join(tmpConfig, 'projects', 'slug', 'test-session.jsonl')

    // Inject a persistent ENOSPC failure on every appendFile call.
    transcriptWriteFs.appendFile = (async () => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
      err.code = 'ENOSPC'
      throw err
    }) as typeof transcriptWriteFs.appendFile

    setSessionFileForTesting(sessionFile)

    // Trigger a drain by enqueuing a write. appendEntry buffers if
    // sessionFile was null, but we set it above so it goes straight to
    // enqueueWrite → drainWriteQueue → appendToFile.
    await appendEntryForTesting({
      type: 'summary',
      summary: 'test summary for ENOSPC warning',
      leafUuid: 'test-uuid',
      timestamp: '2025-01-01T00:00:00Z',
    })

    // Wait for the drain timer (FLUSH_INTERVAL_MS = 100ms) + margin.
    await new Promise(r => setTimeout(r, 300))

    // The warning must have been emitted to stderr — not silent.
    expect(stderrIncludes('transcript')).toBe(true)
    expect(stderrIncludes('ENOSPC') || stderrIncludes('disk') || stderrIncludes('fail')).toBe(true)
  })

  test('(ii) session-saving-off env var emits a one-time warning, not silent', async () => {
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = 'true'

    // Call appendEntry — shouldSkipPersistence returns true, so it returns
    // early. Without the fix, this was silent. With the fix, a one-time
    // warning is emitted to stderr.
    await appendEntryForTesting({
      type: 'summary',
      summary: 'test summary for skip warning',
      leafUuid: 'test-uuid-2',
      timestamp: '2025-01-01T00:00:00Z',
    })

    // The warning must mention that session saving / transcripts are off
    // and name the env var.
    expect(stderrIncludes('transcript') || stderrIncludes('session')).toBe(true)
    expect(stderrIncludes('CLAUDE_CODE_SKIP_PROMPT_HISTORY')).toBe(true)

    // Call again — should NOT emit a second warning (dedup / no spam).
    const spyCountBefore = stderrSpy.length
    await appendEntryForTesting({
      type: 'summary',
      summary: 'second call should not re-warn',
      leafUuid: 'test-uuid-3',
      timestamp: '2025-01-01T00:00:00Z',
    })
    const spyCountAfter = stderrSpy.length
    expect(spyCountAfter).toBe(spyCountBefore)
  })
})
