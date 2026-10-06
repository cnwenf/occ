/**
 * CC 2.1.291 regression fix #2 — transcript rewrite↔load coordination
 * barrier REMOVED (official 291 deleted the 2.1.288 `EI`/`wM`/`Kyn`
 * registry wholesale; byte evidence in
 * `docs/gap-research-291/cluster-f-session-durability.md` item A:
 * cc290 `loadWaitMs`/`abandonedLoads` counts 5 → 0 in cc291, all seven
 * `using s=await EI(e)` lease sites gone).
 *
 * OCC ported the 288 barrier verbatim as `transcriptRewriteCoordinator.ts`
 * (OCC-106 P2-2). This round removes it to match 291:
 *
 *  1. The coordinator module must no longer exist.
 *  2. `removeTranscriptMessage` must no longer park behind an in-flight
 *     load — the tombstone splice completes promptly (the pre-removal code
 *     waited up to LOAD_WAIT_MS=5000ms, which also raced OCC's 2000ms
 *     graceful-shutdown cleanup budget).
 *  3. Tombstone behavior itself is unchanged: fast-path tail splice and
 *     slow-path whole-file rewrite still remove exactly the target row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadTranscriptFile,
  removeTranscriptMessage,
  setSessionFileForTesting,
} from '../sessionStorage.js'

// ---------------------------------------------------------------------------
// Fixture plumbing (convention: sessionStorageTombstoneCoordination288)
// ---------------------------------------------------------------------------

let tempDir = ''
let savedConfigDir: string | undefined
let savedSkip: string | undefined

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-coord-removed-291-'))
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

const SESSION_ID = randomUUID()

function baseFields(): Record<string, unknown> {
  return {
    cwd: tempDir,
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: '2026-10-07T00:00:00.000Z',
    version: '2.1.291',
    isSidechain: false,
  }
}

function userRow(uuid: UUID, parentUuid: UUID | null): string {
  return JSON.stringify({
    ...baseFields(),
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: 'hi' },
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
    .map(line => `${line}\n`)
    .join('')
  await writeFile(file, content, 'utf8')
  return { file, a, b, c }
}

// ---------------------------------------------------------------------------

describe('CC 2.1.291 — transcript rewrite/load coordination barrier removed', () => {
  test('the transcriptRewriteCoordinator module no longer exists', async () => {
    // Official 291 deleted the whole registry (EI/loadWaitMs/abandonedLoads
    // string counts 5 → 0). OCC matches by deleting the module.
    await expect(import('../transcriptRewriteCoordinator.js')).rejects.toThrow()
  })

  test('removeTranscriptMessage does not park behind a concurrent load (no 5000ms wait)', async () => {
    // Arrange — mid-row target forces the two-syscall tail splice.
    const { file, a, b, c } = await writeTranscript()
    setSessionFileForTesting(file)

    // Act — fire a real load and the removal concurrently. Pre-removal code
    // registered the load and parked the rewrite for up to LOAD_WAIT_MS.
    const started = Date.now()
    const [loaded] = await Promise.all([
      loadTranscriptFile(file),
      removeTranscriptMessage(b),
    ])
    const elapsed = Date.now() - started

    // Assert — prompt completion (the old barrier waited ≥5s when a load
    // was in flight and unresolved; even the coordinated happy path paid
    // the registry round-trip). Generous bound, still 25× below 5000ms.
    expect(elapsed).toBeLessThan(2000)
    // The load still produced a usable transcript (either pre- or
    // post-splice content is valid — the barrier's absence means we do NOT
    // assert which; official 291 accepts the same).
    expect(loaded).toBeDefined()

    // Final file state: exactly row b spliced out.
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`"uuid":"${a}"`)
    expect(lines[1]).toContain(`"uuid":"${c}"`)
    // The session TAIL survives the rewrite intact and parseable — this is
    // the durability property the 288 barrier put at risk: a rewrite parked
    // behind an in-flight load (up to LOAD_WAIT_MS=5000ms) outlived
    // gracefulShutdown's 2000ms cleanup budget, so the tail row was lost on
    // quit. No park → the splice lands inside the budget with the tail kept.
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(lines[1]).uuid).toBe(c)
  })

  test('fast-path tail splice still removes the LAST row (single ftruncate)', async () => {
    const { file, a, b, c } = await writeTranscript()
    setSessionFileForTesting(file)

    await removeTranscriptMessage(c)

    const lines = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`"uuid":"${a}"`)
    expect(lines[1]).toContain(`"uuid":"${b}"`)
  })

  test('slow path still removes a row beyond the tail window', async () => {
    // Arrange — build a transcript whose last row is > LITE_READ_BUF_SIZE
    // (64KB) past the target, forcing the whole-file rewrite slow path.
    const target = randomUUID()
    const file = join(tempDir, `${randomUUID()}.jsonl`)
    const rows: string[] = [userRow(target, null)]
    let prev: UUID = target
    const fillerCount = 40 // ~40 × 2KB padding rows > 64KB after the target
    for (let i = 0; i < fillerCount; i++) {
      const uuid = randomUUID()
      rows.push(
        JSON.stringify({
          ...baseFields(),
          type: 'user',
          uuid,
          parentUuid: prev,
          message: { role: 'user', content: 'x'.repeat(2000) },
        }),
      )
      prev = uuid
    }
    await writeFile(file, `${rows.join('\n')}\n`, 'utf8')
    setSessionFileForTesting(file)

    // Act
    await removeTranscriptMessage(target)

    // Assert — target gone, all filler rows kept.
    const lines = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(line => line.trim() !== '')
    expect(lines).toHaveLength(fillerCount)
    for (const line of lines) {
      expect(line).not.toContain(`"uuid":"${target}"`)
    }
  })

  test('loadTranscriptFile still hydrates a transcript end-to-end', async () => {
    const { file, a, b, c } = await writeTranscript()

    const result = await loadTranscriptFile(file)

    expect(result.messages.size).toBe(3)
    expect(result.messages.has(a)).toBe(true)
    expect(result.messages.has(b)).toBe(true)
    expect(result.messages.has(c)).toBe(true)
    expect(result.leafUuids.has(c)).toBe(true)
  })
})
