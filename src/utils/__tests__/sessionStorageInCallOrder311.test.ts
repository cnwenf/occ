/**
 * CC 2.1.311 (item 9 @248834517 / rFr @248893468) — transcript write
 * serialization: a removal (`removeMessageByUuid`) must be ordered AFTER
 * appends that were enqueued before it in call order.
 *
 * Official mechanism (byte-verified from /tmp/cc-diff-311/v311/package/claude):
 *   inCallOrder(e){this.releaseWaitsForUploads();let n=this.lastWriteInCallOrder,
 *     {promise:r,resolve:s}=Promise.withResolvers();return this.lastWriteInCallOrder=r,
 *     this.trackWrite(async()=>{try{if(n!==void 0)await n;return await e()}
 *     finally{if(this.lastWriteInCallOrder===r)this.lastWriteInCallOrder=void 0;s()}})}
 *   async function rFr(e){return await ca().inCallOrder(e)}
 * Both print-path transcript writers route through `rFr`: the append `ve()`
 * (@277222803) and the tombstone removal `Ze()` (@277223629). v310 calls the
 * writers unordered (`lastWriteInCallOrder` = 0 hits in v310).
 *
 * OCC adaptation (documented): OCC's append path is a lazy 100 ms batched
 * queue (`enqueueWrite`/`FLUSH_INTERVAL_MS`), not a per-write `rFr` call, and
 * existing tests pin that batching. So only the REMOVAL is routed through the
 * `lastWriteInCallOrder` chain, and it first drains any queued appends
 * (`drainQueuedAppends`) before the tail-splice reads the file. Observable
 * guarantee is identical: a removal never reads the file before appends that
 * were enqueued ahead of it have landed, and overlapping removals run in call
 * order. `releaseWaitsForUploads()` is omitted — OCC has no upload-wait
 * subsystem.
 *
 * Harness pattern: transcriptCoordinationRemoved291.test.ts /
 * sessionStorageTornTailSeal300.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Env MUST be set before sessionStorage is imported (config-home memoization).
process.env.NODE_ENV = 'test'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY

let tempDir = ''
let savedConfigDir: string | undefined
let savedSkip: string | undefined

const {
  getProjectInstanceForTesting,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  setSessionFileForTesting,
} = await import('../sessionStorage.js')

const SESSION_ID = randomUUID()

function baseFields(): Record<string, unknown> {
  return {
    cwd: tempDir,
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: '2026-10-28T00:00:00.000Z',
    version: '2.1.311',
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

/** A summary entry enqueued through the lazy 100 ms write queue. */
function queuedSummary(marker: string) {
  return {
    type: 'summary' as const,
    summary: marker,
    leafUuid: randomUUID(),
    timestamp: '2026-10-28T00:00:01.000Z',
  }
}

async function writeTranscript(rows: string[]): Promise<string> {
  const file = join(tempDir, `${randomUUID()}.jsonl`)
  await writeFile(file, rows.map(r => `${r}\n`).join(''), 'utf8')
  return file
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-incallorder-311-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedSkip = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  process.env.CLAUDE_CONFIG_DIR = tempDir
  resetProjectForTesting()
  resetProjectFlushStateForTesting()
})

afterEach(async () => {
  resetProjectForTesting()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedSkip === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = savedSkip
  await rm(tempDir, { recursive: true, force: true })
})

describe('CC 2.1.311 item 9 — removal is serialized after queued appends', () => {
  test('a queued append is on disk before a later removal returns (drain-first)', async () => {
    // Arrange — [keep, target]; `target` is the row the tombstone retracts.
    const keep = randomUUID()
    const target = randomUUID()
    const file = await writeTranscript([userRow(keep, null), userRow(target, keep)])
    setSessionFileForTesting(file)
    // Capture ONE Project instance across every await below so a concurrent
    // test file's resetProjectForTesting() (which nulls the shared singleton)
    // cannot redirect removeMessageByUuid onto a fresh Project whose
    // sessionFile === null (→ early-return, target never removed).
    const project = getProjectInstanceForTesting()

    // Act — enqueue an append (fires the 100 ms queue; resolves without
    // waiting for the drain), then remove `target` WITHOUT letting the timer
    // fire or calling flush() in between.
    const queued = project.appendEntry(queuedSummary('queued-append-X'))
    await project.removeMessageByUuid(target)
    await queued

    // Assert — drain-first guarantee: the append enqueued ahead of the
    // removal has already landed (no flush(), no 100 ms wait), and the
    // retracted row is gone while the kept row survives.
    const content = await readFile(file, 'utf8')
    expect(content).toContain('queued-append-X')
    expect(content).not.toContain(`"uuid":"${target}"`)
    expect(content).toContain(`"uuid":"${keep}"`)
  })

  test('the retracted row is never resurrected by a subsequent flush', async () => {
    const keep = randomUUID()
    const target = randomUUID()
    const file = await writeTranscript([userRow(keep, null), userRow(target, keep)])
    setSessionFileForTesting(file)
    const project = getProjectInstanceForTesting()

    const queued = project.appendEntry(queuedSummary('append-before-remove'))
    await project.removeMessageByUuid(target)
    await queued
    // A later flush (e.g. graceful shutdown) must not bring `target` back.
    await project.flush()

    const lines = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(line => line.trim() !== '')
    expect(lines.some(l => l.includes(`"uuid":"${target}"`))).toBe(false)
    expect(lines.some(l => l.includes('append-before-remove'))).toBe(true)
    expect(lines.some(l => l.includes(`"uuid":"${keep}"`))).toBe(true)
  })

  test('two concurrent removals both land (inCallOrder chain, no clobber)', async () => {
    const a = randomUUID()
    const x = randomUUID()
    const y = randomUUID()
    const file = await writeTranscript([
      userRow(a, null),
      userRow(x, a),
      userRow(y, x),
    ])
    setSessionFileForTesting(file)
    const project = getProjectInstanceForTesting()

    // Fire both removals without awaiting individually — the chain must
    // serialize them so neither tail-splice clobbers the other.
    await Promise.all([
      project.removeMessageByUuid(x),
      project.removeMessageByUuid(y),
    ])

    const content = await readFile(file, 'utf8')
    expect(content).toContain(`"uuid":"${a}"`)
    expect(content).not.toContain(`"uuid":"${x}"`)
    expect(content).not.toContain(`"uuid":"${y}"`)
  })
})
