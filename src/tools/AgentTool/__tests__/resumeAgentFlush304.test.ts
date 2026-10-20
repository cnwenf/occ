/**
 * CC 2.1.304 changelog #28 — "subagent resume now flushes pending transcript
 * writes before reloading the agent conversation" (byte-verified port notes in
 * docs/gap-research-304/research-R3-session-api.md §#28; official symbol
 * `flushSessionStorage`).
 *
 * THE BUG. A running subagent persists its sidechain transcript through the
 * session-storage write queue: `enqueueWrite` pushes the row onto a per-file
 * queue and schedules a periodic drain (`FLUSH_INTERVAL_MS = 100`). The enqueue
 * is fire-and-forget (`void this.enqueueWrite(...)`), so the newest tail rows
 * sit in memory until the timer ticks. `resumeAgentBackground` reloads the
 * conversation with `getAgentTranscript(agentId)` — a plain disk read. Pre-fix,
 * a resume that fired INSIDE the 100ms window (before the drain) read a stale
 * transcript off disk and silently dropped the agent's latest messages.
 *
 * THE FIX (this WP). `resumeAgentBackground` now `await flushSessionStorage()`
 * BEFORE the `Promise.all([getAgentTranscript(...), readAgentMetadata(...)])`.
 * `flush()` clears the pending timer, waits for any in-flight drain, then
 * drains every queued file (including the agent sidechain file), so the
 * reloaded transcript is complete.
 *
 * Test strategy (two levels, both deterministic — no reliance on a 100ms race):
 *   1. BEHAVIORAL: reproduce the queue/read contract the fix depends on — an
 *      agent sidechain tail enqueued inside the flush window is invisible to a
 *      `getAgentTranscript` read until `flushSessionStorage()` is awaited
 *      (stale read drops the tail; post-flush read includes it). This is the
 *      exact mechanism `resumeAgentBackground` relies on.
 *   2. WIRING: lock the fix in `resumeAgent.ts` — it awaits
 *      `flushSessionStorage()` BEFORE the `getAgentTranscript(asAgentId(...))`
 *      read and before the surrounding `Promise.all`, so the ordering can never
 *      silently regress.
 *
 * Harness pattern: src/utils/__tests__/sessionStorageTornTailSeal300.test.ts
 * (env set before the sessionStorage import; temp CLAUDE_CONFIG_DIR; MACRO
 * polyfill; resetProjectForTesting between tests).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Env MUST be set before sessionStorage is imported (config-home memoization).
process.env.NODE_ENV = 'test'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY

const tmpRoot = mkdtempSync(join(tmpdir(), 'occ-resume-flush-304-'))
process.env.CLAUDE_CONFIG_DIR = tmpRoot

const {
  adoptResumedSessionFile,
  appendEntryForTesting,
  flushSessionStorage,
  getAgentTranscript,
  getAgentTranscriptPath,
  getTranscriptPath,
  resetProjectForTesting,
} = await import('../../../utils/sessionStorage.js')
const { asAgentId } = await import('../../../types/ids.js')

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type EntryParam = Parameters<typeof appendEntryForTesting>[0]

interface SidechainOpts {
  uuid: string
  parentUuid: string | null
  agentId: string
  sessionId: string
  type: 'user' | 'assistant'
  content: unknown
  timestamp: string
}

/**
 * A full sidechain TranscriptMessage row shaped exactly like the one
 * `insertMessageChain` builds for a subagent (parentUuid chain + isSidechain +
 * agentId + timestamp). Passed through `appendEntryForTesting` so it routes to
 * `getAgentTranscriptPath(agentId)` and is queued (not flushed).
 */
function sidechainEntry(o: SidechainOpts): EntryParam {
  return {
    parentUuid: o.parentUuid,
    isSidechain: true,
    agentId: o.agentId,
    type: o.type,
    uuid: o.uuid,
    message: { role: o.type, content: o.content },
    userType: 'external',
    cwd: process.cwd(),
    sessionId: o.sessionId,
    timestamp: o.timestamp,
    version: 'test',
  } as unknown as EntryParam
}

/** Materialize the main session file so `appendEntry` stops buffering rows. */
function materializeSession(): void {
  const mainPath = getTranscriptPath()
  mkdirSync(dirname(mainPath), { recursive: true })
  writeFileSync(mainPath, '', 'utf8')
  adoptResumedSessionFile()
}

const text = (t: string) => [{ type: 'text' as const, text: t }]

beforeEach(() => {
  resetProjectForTesting()
})

afterEach(async () => {
  // Drain + cancel any pending timer before the next test resets the project,
  // so a stray 100ms drain can never write into a later test's agent file.
  try {
    await flushSessionStorage()
  } catch {
    // best effort
  }
  resetProjectForTesting()
})

// ---------------------------------------------------------------------------
// CC 2.1.304 #28 — behavioral: the flush-before-read contract
// ---------------------------------------------------------------------------

describe('CC 2.1.304 #28 — subagent tail enqueued inside the flush window', () => {
  test('is invisible to a resume read until flushSessionStorage() is awaited', async () => {
    // Arrange — an agent conversation whose first two rows are already
    // persisted (the periodic drain has fired), then a NEW tail row enqueued
    // but NOT flushed (resume fires inside the 100ms window).
    materializeSession()
    const agentId = 'agent-28-behavior'
    const aid = asAgentId(agentId)
    const sid = 'sess-28-behavior'

    await appendEntryForTesting(
      sidechainEntry({
        uuid: 'aaaaaaaa-0000-0000-0000-000000000001',
        parentUuid: null,
        agentId,
        sessionId: sid,
        type: 'user',
        content: 'baseline-user',
        timestamp: '2026-10-21T00:00:00.000Z',
      }),
    )
    await appendEntryForTesting(
      sidechainEntry({
        uuid: 'aaaaaaaa-0000-0000-0000-000000000002',
        parentUuid: 'aaaaaaaa-0000-0000-0000-000000000001',
        agentId,
        sessionId: sid,
        type: 'assistant',
        content: text('baseline-assistant'),
        timestamp: '2026-10-21T00:00:01.000Z',
      }),
    )
    await flushSessionStorage() // baseline is on disk

    // Act — enqueue the tail WITHOUT flushing (the #28 race window).
    await appendEntryForTesting(
      sidechainEntry({
        uuid: 'aaaaaaaa-0000-0000-0000-000000000003',
        parentUuid: 'aaaaaaaa-0000-0000-0000-000000000002',
        agentId,
        sessionId: sid,
        type: 'assistant',
        content: text('TAIL-MESSAGE-28'),
        timestamp: '2026-10-21T00:00:02.000Z',
      }),
    )

    // PRE-FIX resume read: no flush → the queued tail is still off-disk.
    const stale = await getAgentTranscript(aid)

    // Assert — the stale read DROPS the latest message (the bug).
    expect(stale).not.toBeNull()
    expect(stale!.messages.length).toBe(2)
    expect(stale!.messages.map(m => m.uuid)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
    ])

    // Act — POST-FIX: resumeAgentBackground awaits flushSessionStorage() first.
    await flushSessionStorage()
    const fresh = await getAgentTranscript(aid)

    // Assert — the resumed transcript now INCLUDES the latest message.
    expect(fresh).not.toBeNull()
    expect(fresh!.messages.length).toBe(3)
    expect(fresh!.messages.map(m => m.uuid)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
      'aaaaaaaa-0000-0000-0000-000000000003',
    ])
    const lastContent = (fresh!.messages[2]!.message as { content: unknown[] })
      .content
    expect((lastContent[0] as { text: string }).text).toBe('TAIL-MESSAGE-28')
  })

  test('the queued tail row is absent from the agent file before the flush and present after it', async () => {
    // Arrange
    materializeSession()
    const agentId = 'agent-28-file'
    const aid = asAgentId(agentId)
    const agentPath = getAgentTranscriptPath(aid)
    const sid = 'sess-28-file'

    await appendEntryForTesting(
      sidechainEntry({
        uuid: 'bbbbbbbb-0000-0000-0000-000000000001',
        parentUuid: null,
        agentId,
        sessionId: sid,
        type: 'user',
        content: 'first',
        timestamp: '2026-10-21T00:00:00.000Z',
      }),
    )
    await flushSessionStorage() // first row lands on disk

    // Act — enqueue a second row, read the raw file BEFORE any flush.
    await appendEntryForTesting(
      sidechainEntry({
        uuid: 'bbbbbbbb-0000-0000-0000-000000000002',
        parentUuid: 'bbbbbbbb-0000-0000-0000-000000000001',
        agentId,
        sessionId: sid,
        type: 'assistant',
        content: text('second-tail'),
        timestamp: '2026-10-21T00:00:01.000Z',
      }),
    )

    const before = existsSync(agentPath) ? readFileSync(agentPath, 'utf8') : ''

    // Assert — the queued row is not yet on disk; the flushed one is.
    expect(before).toContain('bbbbbbbb-0000-0000-0000-000000000001')
    expect(before).not.toContain('bbbbbbbb-0000-0000-0000-000000000002')

    // Act — drain the queue.
    await flushSessionStorage()
    const after = readFileSync(agentPath, 'utf8')

    // Assert — both rows are on disk now.
    expect(after).toContain('bbbbbbbb-0000-0000-0000-000000000001')
    expect(after).toContain('bbbbbbbb-0000-0000-0000-000000000002')
  })
})

// ---------------------------------------------------------------------------
// CC 2.1.304 #28 — wiring: resumeAgent.ts flushes BEFORE it reads
// ---------------------------------------------------------------------------

describe('CC 2.1.304 #28 — resumeAgentBackground awaits flushSessionStorage() before the transcript read', () => {
  const resumeSrc = readFileSync(
    join(import.meta.dir, '..', 'resumeAgent.ts'),
    'utf8',
  )

  test('imports flushSessionStorage from sessionStorage', () => {
    expect(resumeSrc).toContain('flushSessionStorage,')
    expect(resumeSrc).toContain("from '../../utils/sessionStorage.js'")
  })

  test('awaits flushSessionStorage() BEFORE getAgentTranscript and before the Promise.all read', () => {
    // Arrange
    const flushIdx = resumeSrc.indexOf('await flushSessionStorage()')
    const readIdx = resumeSrc.indexOf('getAgentTranscript(asAgentId(agentId))')
    const promiseAllIdx = resumeSrc.indexOf('await Promise.all([')

    // Assert — all three anchors exist …
    expect(flushIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeGreaterThan(-1)
    expect(promiseAllIdx).toBeGreaterThan(-1)
    // … and the flush is ordered ahead of the read (the whole point of #28).
    expect(flushIdx).toBeLessThan(readIdx)
    expect(flushIdx).toBeLessThan(promiseAllIdx)
  })
})

// Cleanup the temp config root once at process exit.
process.on('exit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best effort
  }
})
