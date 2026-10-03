/**
 * CC 2.1.288 #12 (OCC-106 P2-2) — tombstone removal coordination regression.
 *
 * Acceptance finding: `removeMessageByUuid`'s tail-splice FAST path
 * (`fh.truncate(absLineStart)` + trailing `fh.write`) was the only
 * uncoordinated whole-file mutation of a live transcript — every sibling
 * mutation (slow path, hydrate, fg rewrite, agentFile) acquires
 * `acquireRewriteCoordination`, and REPL.tsx fires the tombstone
 * fire-and-forget (`void removeTranscriptMessage(...)`). A positional
 * ftruncate is still two non-atomic syscalls, so a concurrent
 * loadTranscriptFile (/resume, fork, hydrate, lite-metadata) could observe
 * the transcript cut short — re-opening the exact #12 failure.
 *
 * Fix under test: the WHOLE method body is wrapped in
 * `acquireRewriteCoordination(this.sessionFile)` (official
 * `performRemoveByUuid(e,n,r){using s=await wM(e);...}` @211508839 shape).
 *
 * Deterministic discrimination (no sleeps-as-races):
 * `acquireRewriteCoordination` registers the rewrite, then waits ≤5s for
 * in-flight loads. Holding a real load handle therefore parks the removal
 * BEFORE any mutation; the pre-fix code never consulted the coordinator and
 * spliced immediately. Assertions read the file while the removal is parked
 * (must be untouched) and after the dispose chain (must be spliced).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  acquireLoadCoordination,
  getTranscriptRewriteCoordinatorForTesting,
  resetTranscriptRewriteCoordinatorForTesting,
  type TranscriptCoordinationHandle,
} from '../transcriptRewriteCoordinator.js'
import {
  loadTranscriptFile,
  removeTranscriptMessage,
  setSessionFileForTesting,
} from '../sessionStorage.js'

// ---------------------------------------------------------------------------
// Fixture plumbing (convention: transcriptWriteWarnings.test.ts)
// ---------------------------------------------------------------------------

let tempDir = ''
let savedConfigDir: string | undefined
let savedSkip: string | undefined

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-tombstone-coord-288-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedSkip = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  process.env.CLAUDE_CONFIG_DIR = tempDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
})

afterAll(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedSkip === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = savedSkip
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  await rm(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetTranscriptRewriteCoordinatorForTesting()
})

afterEach(() => {
  resetTranscriptRewriteCoordinatorForTesting()
})

const SESSION_ID = randomUUID()

function baseFields(): Record<string, unknown> {
  return {
    cwd: tempDir,
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: '2026-10-04T00:00:00.000Z',
    version: '2.1.288',
    isSidechain: false,
  }
}

function userRow(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown = 'hi',
): string {
  return JSON.stringify({
    ...baseFields(),
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content },
  })
}

/** Three-line transcript; returns the file path and the three UUIDs. */
async function writeTranscript(): Promise<{
  file: string
  a: UUID
  b: UUID
  c: UUID
}> {
  const a = randomUUID()
  const b = randomUUID()
  const c = randomUUID()
  const file = join(tempDir, `${randomUUID()}.jsonl`)
  const content = [userRow(a, null), userRow(b, a), userRow(c, b)]
    .map((line) => `${line}\n`)
    .join('')
  await writeFile(file, content, 'utf8')
  return { file, a, b, c }
}

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------

describe('OCC-106 P2-2 — tombstone fast path runs under rewrite coordination', () => {
  test('the tail-splice fast path waits for an in-flight load before mutating the file', async () => {
    // Arrange — mid-row target forces the two-syscall splice (truncate + write)
    const { file, a, b, c } = await writeTranscript()
    setSessionFileForTesting(file)
    const original = await readFile(file, 'utf8')

    // A concurrent reader (/resume, fork, hydrate) is mid-load.
    const heldLoad: TranscriptCoordinationHandle =
      await acquireLoadCoordination(file)

    // Act — REPL fires this fire-and-forget; do NOT await yet.
    let removalSettled = false
    const removal = removeTranscriptMessage(b as UUID).then(() => {
      removalSettled = true
    })
    await tick()

    // Assert — parked at acquireRewriteCoordination: no mutation, no settle.
    // The pre-fix fast path consulted no coordinator and had spliced by now.
    expect(removalSettled).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(original)
    // The rewrite IS registered (readers chained after us will wait for it).
    // The registry keys on resolve(filePath).
    const coordinator = getTranscriptRewriteCoordinatorForTesting()
    expect(coordinator.rewrites.get(resolve(file))?.size ?? 0).toBe(1)

    // Release the reader; the removal proceeds and splices row b out.
    heldLoad[Symbol.dispose]()
    await removal

    const lines = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`"uuid":"${a}"`)
    expect(lines[1]).toContain(`"uuid":"${c}"`)
    expect(removalSettled).toBe(true)
    // Registry cleaned up — the finally-dispose ran.
    expect(coordinator.rewrites.has(resolve(file))).toBe(false)
  })

  test('a concurrent loadTranscriptFile never observes the truncated mid-splice state', async () => {
    // Arrange
    const { file, a, b, c } = await writeTranscript()
    setSessionFileForTesting(file)
    const heldLoad: TranscriptCoordinationHandle =
      await acquireLoadCoordination(file)

    // Act — removal parks behind heldLoad (rewrite registered), then a real
    // production load chains behind the registered rewrite.
    const removal = removeTranscriptMessage(b as UUID)
    await tick()
    let loadDone = false
    const load = loadTranscriptFile(file).then((result) => {
      loadDone = true
      return result
    })
    await tick()

    // Assert — the load is serialized behind the tombstone splice.
    expect(loadDone).toBe(false)

    heldLoad[Symbol.dispose]()
    await removal
    const { messages } = await load

    // The reader sees the FINAL spliced transcript — rows a and c, never the
    // cut-short file (the #12 failure mode this coordination closes).
    expect(loadDone).toBe(true)
    expect(messages.has(a)).toBe(true)
    expect(messages.has(b)).toBe(false)
    expect(messages.has(c)).toBe(true)
  })
})
