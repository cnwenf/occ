import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  accumulateRequest,
  computeRecached,
  createWindowAccumulator,
  finalizeWindow,
  parseAssistantRecord,
  scanTranscriptFile,
  type ScanRecord,
} from '../usageScan.js'

/**
 * CC 2.1.311 (triage-T3 Item 44): the `recached` prompt-cache-churn field in
 * the /usage binary-jsonl scanner. Official references (v311 ELF,
 * /tmp/cc-diff-311/v311/package/claude — byte offsets):
 *   - `recached` token: v310 = 0 hits; v311 = 6 hits @126040372 (string pool),
 *     258289975/258289986/258290007 (aggregation), 258292184 (record build
 *     `recached:0`), 258294109 (bucket condition).
 *   - Record build `Vt` @258292184: `{ts:c,sessionId:i,cached:u,
 *     cacheCreate:a,recached:0,uncached:p,output:T,...}`.
 *   - Aggregation @258289975 region:
 *     `let E=u.get(S.isSubagent);
 *      if(E?.cached===S.cached&&E.cacheCreate===S.cacheCreate&&
 *         E.uncached===S.uncached)S.recached=E.recached;
 *      else if(E)S.recached=Math.min(S.cacheCreate,
 *         Math.max(0,E.cached+E.cacheCreate-S.cached));
 *      u.set(S.isSubagent,S)`.
 *   - Compact-boundary reset @258290994 region: marker
 *     `lt=[d.encode('"subtype":"compact_boundary"')]` @258281637;
 *     `if(k(m,lt,f)){u.clear();return}` — v310 scanner region
 *     (256860000–256900000) has ZERO `compact_boundary` hits.
 *   - Bucket `ie` @258294109: `if(n.uncached+n.recached>Ne)e.cacheMissCost+=s,
 *     e.cacheMissCount++` (v310 `re` @256881672: `if(n.uncached>xe)...`).
 *   - Thresholds UNCHANGED: v311 @258280408 `Ne=1e5,Ie=150000`; long-context
 *     stays `r=n.cached+n.cacheCreate+n.uncached; if(r>Ie)` — recached NOT
 *     added (it is a subset of cacheCreate).
 */

const NOW = 1_760_000_000_000
const PATH = `${sep}projects${sep}p${sep}s1.jsonl`

function makeRecord(overrides: Partial<ScanRecord> = {}): ScanRecord {
  return {
    ts: NOW,
    sessionId: 's1',
    cached: 0,
    cacheCreate: 0,
    recached: 0,
    uncached: 0,
    output: 0,
    isSubagent: false,
    isMaxEffort: false,
    isWorkflow: false,
    alwaysOnTokens: 0,
    largeToolResultTokens: 0,
    modelTier: 3,
    model: 'claude-sonnet-4-5',
    uuid: 'r1',
    ...overrides,
  }
}

function assistantLine(opts: {
  uuid: string
  ts?: number
  cached?: number
  cacheCreate?: number
  uncached?: number
  output?: number
  isSidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    timestamp: new Date(opts.ts ?? NOW).toISOString(),
    sessionId: 's1',
    isSidechain: opts.isSidechain ?? false,
    message: {
      id: `msg_${opts.uuid}`,
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: opts.uncached ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cached ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  })
}

/** Official v311 system line carrying the compact_boundary subtype. */
function compactBoundaryLine(uuid: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    timestamp: new Date(NOW).toISOString(),
    sessionId: 's1',
    compactMetadata: { trigger: 'manual', preTokens: 100 },
  })
}

const tempDirs: string[] = []

async function makeTempProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-usage-recached-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('Item 44 — record parse gains recached:0 (official Vt @258292184)', () => {
  test('parseAssistantRecord initializes recached to 0', () => {
    const record = parseAssistantRecord(
      assistantLine({ uuid: 'r1', cached: 1_000, uncached: 20 }),
      PATH,
    )
    expect(record).not.toBeNull()
    expect(record?.recached).toBe(0)
  })
})

describe('Item 44 — computeRecached aggregation (official @258289975)', () => {
  test('no previous record → recached stays 0', () => {
    const current = makeRecord({ cacheCreate: 50_000, cached: 10_000 })
    const result = computeRecached(undefined, current)
    expect(result.recached).toBe(0)
  })

  test('identical cached/cacheCreate/uncached → inherit previous recached', () => {
    const prev = makeRecord({
      cached: 10_000,
      cacheCreate: 5_000,
      uncached: 200,
      recached: 4_321,
      uuid: 'r1',
    })
    const current = makeRecord({
      cached: 10_000,
      cacheCreate: 5_000,
      uncached: 200,
      uuid: 'r2',
    })
    expect(computeRecached(prev, current).recached).toBe(4_321)
  })

  test('churn formula: min(cacheCreate, max(0, prev.cached+prev.cacheCreate−cur.cached))', () => {
    const prev = makeRecord({ cached: 50_000, cacheCreate: 20_000, uuid: 'r1' })
    const current = makeRecord({
      cached: 30_000,
      cacheCreate: 40_000,
      uuid: 'r2',
    })
    // min(40_000, max(0, 50_000+20_000−30_000)) = min(40_000, 40_000)
    expect(computeRecached(prev, current).recached).toBe(40_000)
  })

  test('formula clamps at cacheCreate when the churn exceeds it', () => {
    const prev = makeRecord({ cached: 90_000, cacheCreate: 0, uuid: 'r1' })
    const current = makeRecord({ cached: 10_000, cacheCreate: 5_000, uuid: 'r2' })
    // min(5_000, max(0, 80_000)) = 5_000
    expect(computeRecached(prev, current).recached).toBe(5_000)
  })

  test('formula clamps at 0 when the cached prefix fully grew', () => {
    const prev = makeRecord({ cached: 10_000, cacheCreate: 5_000, uuid: 'r1' })
    const current = makeRecord({ cached: 50_000, cacheCreate: 5_000, uuid: 'r2' })
    // min(5_000, max(0, 15_000−50_000)) = 0
    expect(computeRecached(prev, current).recached).toBe(0)
  })

  test('immutable: neither the previous nor the current record is mutated', () => {
    const prev = makeRecord({ cached: 50_000, cacheCreate: 20_000, recached: 7, uuid: 'r1' })
    const current = makeRecord({ cached: 30_000, cacheCreate: 40_000, uuid: 'r2' })
    const result = computeRecached(prev, current)
    expect(result).not.toBe(current)
    expect(current.recached).toBe(0)
    expect(prev.recached).toBe(7)
    expect(result.recached).toBe(40_000)
  })
})

describe('Item 44 — scan-loop prev tracking + compact_boundary reset', () => {
  async function writeTranscript(lines: string[]): Promise<string> {
    const dir = await makeTempProjectsDir()
    const projectDir = join(dir, 'proj')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, 's1.jsonl')
    await writeFile(file, lines.join('\n'))
    return file
  }

  test('second request in the same stream gets the churn recached value', async () => {
    const file = await writeTranscript([
      assistantLine({ uuid: 'r1', ts: NOW - 2_000, cached: 50_000, cacheCreate: 20_000 }),
      assistantLine({ uuid: 'r2', ts: NOW - 1_000, cached: 30_000, cacheCreate: 40_000 }),
    ])
    const records = await scanTranscriptFile(file, NOW - 86_400_000)
    expect(records).toHaveLength(2)
    expect(records[0].recached).toBe(0)
    expect(records[1].recached).toBe(40_000)
  })

  test('main and subagent streams track prev records independently', async () => {
    const file = await writeTranscript([
      assistantLine({ uuid: 'm1', ts: NOW - 4_000, cached: 50_000, cacheCreate: 20_000 }),
      assistantLine({
        uuid: 'a1',
        ts: NOW - 3_000,
        cached: 1_000,
        cacheCreate: 2_000,
        isSidechain: true,
      }),
      assistantLine({ uuid: 'm2', ts: NOW - 2_000, cached: 30_000, cacheCreate: 40_000 }),
      assistantLine({
        uuid: 'a2',
        ts: NOW - 1_000,
        cached: 1_500,
        cacheCreate: 900,
        isSidechain: true,
      }),
    ])
    const records = await scanTranscriptFile(file, NOW - 86_400_000)
    expect(records).toHaveLength(4)
    // Main stream: min(40_000, 70_000−30_000) = 40_000.
    expect(records[2].recached).toBe(40_000)
    // Subagent stream vs its OWN prev (1_000+2_000−1_500=1_500):
    // min(900, 1_500) = 900 — NOT vs the main-stream record.
    expect(records[3].recached).toBe(900)
  })

  test('compact_boundary clears the prev tracking (no churn across it)', async () => {
    const file = await writeTranscript([
      assistantLine({ uuid: 'r1', ts: NOW - 3_000, cached: 50_000, cacheCreate: 20_000 }),
      compactBoundaryLine('cb1'),
      assistantLine({ uuid: 'r2', ts: NOW - 1_000, cached: 30_000, cacheCreate: 40_000 }),
    ])
    const records = await scanTranscriptFile(file, NOW - 86_400_000)
    expect(records).toHaveLength(2)
    // Without the boundary r2 would carry recached 40_000; the reset makes
    // it a fresh stream start → 0.
    expect(records[1].recached).toBe(0)
  })

  test('tracking resumes after the boundary line', async () => {
    const file = await writeTranscript([
      compactBoundaryLine('cb1'),
      assistantLine({ uuid: 'r1', ts: NOW - 3_000, cached: 50_000, cacheCreate: 20_000 }),
      assistantLine({ uuid: 'r2', ts: NOW - 2_000, cached: 30_000, cacheCreate: 40_000 }),
      compactBoundaryLine('cb2'),
      assistantLine({ uuid: 'r3', ts: NOW - 1_000, cached: 0, cacheCreate: 60_000 }),
    ])
    const records = await scanTranscriptFile(file, NOW - 86_400_000)
    expect(records).toHaveLength(3)
    expect(records[0].recached).toBe(0)
    expect(records[1].recached).toBe(40_000)
    expect(records[2].recached).toBe(0)
  })

  test('identical duplicate requests inherit the previous recached value', async () => {
    const file = await writeTranscript([
      assistantLine({ uuid: 'r1', ts: NOW - 4_000, cached: 50_000, cacheCreate: 20_000 }),
      assistantLine({ uuid: 'r2', ts: NOW - 3_000, cached: 30_000, cacheCreate: 40_000 }),
      // Same numbers as r2 (retry/duplicate) → inherits r2's recached.
      assistantLine({ uuid: 'r2', ts: NOW - 2_000, cached: 30_000, cacheCreate: 40_000 }),
    ])
    const records = await scanTranscriptFile(file, NOW - 86_400_000)
    expect(records).toHaveLength(3)
    expect(records[1].recached).toBe(40_000)
    expect(records[2].recached).toBe(40_000)
  })
})

describe('Item 44 — cache-miss bucket uncached+recached > 1e5 (official ie @258294109)', () => {
  function cacheMissOf(record: ScanRecord): { cost: number; count: number } {
    const acc = createWindowAccumulator()
    accumulateRequest(acc, record)
    const summary = finalizeWindow(acc)
    const found = summary.behaviors.find((b) => b.key === 'cache_miss')
    return { cost: found?.cost ?? 0, count: found?.count ?? 0 }
  }

  test('recached pushes the record over the 1e5 threshold', () => {
    // uncached alone (60_000) would NOT trip v310's `uncached>1e5`.
    const record = makeRecord({ uncached: 60_000, recached: 50_000 })
    expect(cacheMissOf(record).count).toBe(1)
  })

  test('sum exactly at 100_000 does NOT count (strict >)', () => {
    expect(cacheMissOf(makeRecord({ uncached: 60_000, recached: 40_000 })).count).toBe(0)
  })

  test('sum 100_001 counts', () => {
    expect(cacheMissOf(makeRecord({ uncached: 60_000, recached: 40_001 })).count).toBe(1)
  })

  test('plain uncached > 1e5 still counts (v310 behavior preserved)', () => {
    expect(cacheMissOf(makeRecord({ uncached: 200_000 })).count).toBe(1)
  })

  test('long-context bucket stays cached+cacheCreate+uncached > 150_000 (recached NOT added)', () => {
    const acc = createWindowAccumulator()
    // context = 50_000+60_000+45_000 = 155_000 > 150_000 → long_context,
    // even though recached is huge; and uncached+recached trips cache_miss.
    accumulateRequest(
      acc,
      makeRecord({ cached: 50_000, cacheCreate: 60_000, uncached: 45_000, recached: 999_999 }),
    )
    const summary = finalizeWindow(acc)
    expect(summary.behaviors.find((b) => b.key === 'long_context')?.count).toBe(1)
    expect(summary.behaviors.find((b) => b.key === 'cache_miss')?.count).toBe(1)

    // recached alone can never create a long_context hit:
    const acc2 = createWindowAccumulator()
    accumulateRequest(
      acc2,
      makeRecord({ cached: 40_000, cacheCreate: 60_000, uncached: 45_000, recached: 999_999 }),
    )
    // context = 145_000 ≤ 150_000 → no long_context despite recached.
    expect(finalizeWindow(acc2).behaviors.find((b) => b.key === 'long_context')?.count).toBe(0)
  })
})
