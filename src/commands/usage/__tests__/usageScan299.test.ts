import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  accumulateRequest,
  applyRequestRecord,
  applyUserLine,
  attributionPcts,
  computeUsageBehaviors,
  computeUsageWindows,
  createScanState,
  createWindowAccumulator,
  finalizeWindow,
  isLargeToolResult,
  modelTierOf,
  notePromptBytes,
  noteToolResultBytes,
  parseAssistantRecord,
  type ScanRecord,
  scanTranscriptFile,
  toBehaviorPcts,
  weightedCost,
} from '../usageScan.js'
import { formatBehaviors } from '../usageWarnings.js'

/**
 * CC 2.1.299 (#017): the local transcript scan behind the /usage behavior
 * warnings. Official references (v299 ELF, /tmp/cc-diff-299 — offsets into
 * package/claude): Kt tier, Gt cost, Z/K/G/ee/te state machine @236979700
 * region, le accumulator @236993641, de finalizer @236994961, h pct mapper
 * @236999640, ZGt orchestrator (day=86400000 / week=604800000 cutoffs,
 * zt file walk incl. `<session>/subagents/` recursion, We workflow path
 * marker). Full port notes in ../usageScan.ts.
 */

const NOW = 1_760_000_000_000

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

const tempDirs: string[] = []

async function makeTempProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-usage-scan-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('#017 — modelTierOf / weightedCost (official Kt / Gt)', () => {
  test('tier: fable→10, opus→5, haiku→1, else/undefined→3', () => {
    expect(modelTierOf('claude-fable-1')).toBe(10)
    expect(modelTierOf('claude-opus-5')).toBe(5)
    expect(modelTierOf('claude-haiku-4-5')).toBe(1)
    expect(modelTierOf('claude-sonnet-4-5')).toBe(3)
    expect(modelTierOf(undefined)).toBe(3)
  })

  test('weighted cost = (cached + uncached*10 + cacheCreate*12.5 + output*50) * tier', () => {
    expect(
      weightedCost(
        makeRecord({ cached: 100, uncached: 10, cacheCreate: 8, output: 2, modelTier: 1 }),
      ),
    ).toBe(400) // (100 + 100 + 100 + 100) * 1
    expect(
      weightedCost(makeRecord({ cached: 100, uncached: 0, cacheCreate: 0, output: 0, modelTier: 5 })),
    ).toBe(500)
  })
})

describe('#017 — state machine (official Z/K/G/ee/te)', () => {
  test('first request derives startTokens from context minus first-prompt tokens', () => {
    const state = createScanState()
    notePromptBytes(state, 25_000) // → 10_000 tokens at 2.5 bytes/token
    const record = makeRecord({ cached: 50_000, uncached: 100, uuid: 'r1' })
    applyRequestRecord(state, record)
    expect(state.startTokens).toBe(40_100)
    // >40k start context on a non-subagent request → always-on flagged.
    expect(record.alwaysOnTokens).toBe(40_100)
    expect(state.lastRequest).toBe('r1')
    expect(state.lastContext).toBe(50_100)
    expect(state.carriedTokens).toBe(50_100) // output defaults to 0
  })

  test('subagent requests never carry always-on context', () => {
    const state = createScanState()
    notePromptBytes(state, 25_000)
    const record = makeRecord({
      cached: 50_000,
      uncached: 100,
      isSubagent: true,
    })
    applyRequestRecord(state, record)
    expect(record.alwaysOnTokens).toBe(0)
  })

  test('a repeated requestId only bumps carriedTokens (official same-uuid branch)', () => {
    const state = createScanState()
    applyRequestRecord(state, makeRecord({ cached: 1_000, uncached: 100, output: 10, uuid: 'r1' }))
    expect(state.carriedTokens).toBe(1_110)
    applyRequestRecord(state, makeRecord({ cached: 1_000, uncached: 100, output: 50, uuid: 'r1' }))
    expect(state.carriedTokens).toBe(1_150)
    expect(state.lastContext).toBe(1_100)
  })

  test('pending large tool-result bytes accrue into largeToolResultTokens on growth', () => {
    const state = createScanState()
    applyRequestRecord(state, makeRecord({ cached: 1_000, uncached: 100, output: 10, uuid: 'r1' }))
    expect(isLargeToolResult(100_000)).toBe(true) // 40_000 tokens > 10_000
    expect(isLargeToolResult(20_000)).toBe(false) // 8_000 tokens ≤ 10_000
    noteToolResultBytes(state, 100_000)
    expect(state.pendingToolResultBytes).toBe(100_000)
    const r2 = makeRecord({ cached: 30_000, uncached: 100, output: 5, uuid: 'r2' })
    applyRequestRecord(state, r2)
    // grown = min(30_100 - 1_110, 100_000/2.5) = 28_990 > 10_000
    expect(state.largeToolResultTokens).toBe(28_990)
    expect(r2.largeToolResultTokens).toBe(28_990)
    expect(state.pendingToolResultBytes).toBe(0)
  })

  test('small pending tool results do not accrue (official 1e4-token gate)', () => {
    const state = createScanState()
    applyRequestRecord(state, makeRecord({ cached: 1_000, uncached: 100, uuid: 'r1' }))
    noteToolResultBytes(state, 10_000) // 4_000 tokens — not large
    const r2 = makeRecord({ cached: 5_000, uncached: 100, uuid: 'r2' })
    applyRequestRecord(state, r2)
    expect(state.largeToolResultTokens).toBe(0)
    expect(r2.largeToolResultTokens).toBe(0)
  })

  test('a shrinking context reduces largeToolResultTokens (official shrink branch)', () => {
    const state = createScanState()
    applyRequestRecord(state, makeRecord({ cached: 50_000, uncached: 0, uuid: 'r1' }))
    state.largeToolResultTokens = 8_000
    const r2 = makeRecord({ cached: 30_000, uncached: 0, uuid: 'r2' })
    applyRequestRecord(state, r2)
    expect(r2.largeToolResultTokens).toBe(0) // max(0, 8_000 - 20_000)
    expect(state.lastContext).toBe(30_000)
  })

  test('user lines: prompts feed firstPromptBytes only before the first request', () => {
    const state = createScanState()
    const line = JSON.stringify({
      type: 'user',
      message: { content: 'hello world' },
    })
    applyUserLine(state, line)
    expect(state.firstPromptBytes).toBe(Buffer.byteLength(line))
    applyRequestRecord(state, makeRecord({ uuid: 'r1' }))
    applyUserLine(state, line)
    expect(state.firstPromptBytes).toBe(Buffer.byteLength(line))
  })

  test('user lines: large tool_results feed pendingToolResultBytes', () => {
    const state = createScanState()
    const big = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'x'.repeat(60_000) }],
      },
    })
    applyUserLine(state, big)
    expect(state.pendingToolResultBytes).toBeGreaterThan(0)
    const small = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'tiny' }] },
    })
    const state2 = createScanState()
    applyUserLine(state2, small)
    expect(state2.pendingToolResultBytes).toBe(0)
  })
})

describe('#017 — accumulator + finalizer (official le / de)', () => {
  test('cache_miss (>1e5 uncached) and long_context (>150k total)', () => {
    const acc = createWindowAccumulator()
    accumulateRequest(acc, makeRecord({ uncached: 200_000 }))
    const summary = finalizeWindow(acc)
    const cost = 200_000 * 10 * 3
    expect(summary.behaviors.find((b) => b.key === 'cache_miss')).toEqual({
      key: 'cache_miss',
      cost,
      count: 1,
    })
    expect(summary.behaviors.find((b) => b.key === 'long_context')?.count).toBe(1)
  })

  test('max_effort and workflow flags accumulate cost and count', () => {
    const acc = createWindowAccumulator()
    accumulateRequest(acc, makeRecord({ cached: 1_000, isMaxEffort: true, uuid: 'r1' }))
    accumulateRequest(acc, makeRecord({ cached: 1_000, isWorkflow: true, uuid: 'r2' }))
    const summary = finalizeWindow(acc)
    expect(summary.behaviors.find((b) => b.key === 'max_effort')).toEqual({
      key: 'max_effort',
      cost: 3_000,
      count: 1,
    })
    expect(summary.behaviors.find((b) => b.key === 'workflow')?.count).toBe(1)
  })

  test('high_parallel: 4+ distinct sessions in one 5-minute bucket', () => {
    const acc = createWindowAccumulator()
    for (const sessionId of ['s1', 's2', 's3']) {
      accumulateRequest(acc, makeRecord({ sessionId, cached: 100, uuid: `r-${sessionId}` }))
    }
    expect(finalizeWindow(acc).behaviors.find((b) => b.key === 'high_parallel')?.count).toBe(0)
    accumulateRequest(acc, makeRecord({ sessionId: 's4', cached: 100, uuid: 'r-s4' }))
    const summary = finalizeWindow(acc)
    expect(summary.behaviors.find((b) => b.key === 'high_parallel')?.count).toBe(4)
    expect(summary.behaviors.find((b) => b.key === 'high_parallel')?.cost).toBe(400 * 3)
  })

  test('subagent_heavy: 3+ subagent requests or >50% subagent cost share', () => {
    const byCount = createWindowAccumulator()
    for (let i = 0; i < 3; i++) {
      accumulateRequest(
        byCount,
        makeRecord({ isSubagent: true, cached: 100, uuid: `r${i}` }),
      )
    }
    const countSummary = finalizeWindow(byCount)
    expect(countSummary.behaviors.find((b) => b.key === 'subagent_heavy')).toEqual({
      key: 'subagent_heavy',
      cost: 900,
      count: 3,
    })

    const byShare = createWindowAccumulator()
    accumulateRequest(byShare, makeRecord({ isSubagent: true, cached: 300, uuid: 'r1' }))
    accumulateRequest(byShare, makeRecord({ cached: 100, uuid: 'r2' }))
    // subCost/cost = 900/1200 > 0.5 → whole session flagged.
    expect(finalizeWindow(byShare).behaviors.find((b) => b.key === 'subagent_heavy')?.count).toBe(2)
  })

  test('cron: sessions active in 8+ distinct hours', () => {
    const acc = createWindowAccumulator()
    for (let hour = 0; hour < 8; hour++) {
      accumulateRequest(
        acc,
        makeRecord({ ts: NOW + hour * 3_600_000, cached: 10, uuid: `r${hour}` }),
      )
    }
    expect(finalizeWindow(acc).behaviors.find((b) => b.key === 'cron')?.count).toBe(8)

    const short = createWindowAccumulator()
    for (let hour = 0; hour < 7; hour++) {
      accumulateRequest(
        short,
        makeRecord({ ts: NOW + hour * 3_600_000, cached: 10, uuid: `r${hour}` }),
      )
    }
    expect(finalizeWindow(short).behaviors.find((b) => b.key === 'cron')?.count).toBe(0)
  })

  test('always-on / large-tool-result costs scale by token share of input cost', () => {
    const acc = createWindowAccumulator()
    accumulateRequest(
      acc,
      makeRecord({
        cached: 100_000,
        output: 10,
        modelTier: 1,
        alwaysOnTokens: 20_000,
      }),
    )
    // cost = (100_000 + 500) * 1; inputCost = 100_000; share = 0.2 → 20_000
    expect(
      finalizeWindow(acc).behaviors.find((b) => b.key === 'always_on_context'),
    ).toEqual({ key: 'always_on_context', cost: 20_000, count: 1 })
  })
})

describe('#017 — pct mapping (official h / B)', () => {
  test('behaviors below the 10% cost threshold are dropped; pcts round', () => {
    const acc = createWindowAccumulator()
    accumulateRequest(acc, makeRecord({ cached: 1_000, isMaxEffort: true, uuid: 'r1' }))
    accumulateRequest(acc, makeRecord({ cached: 9_000, uuid: 'r2' }))
    const pcts = toBehaviorPcts(finalizeWindow(acc))
    // max_effort cost 3_000 of 30_000 → 10% (threshold inclusive).
    expect(pcts.behaviors).toEqual([{ key: 'max_effort', pct: 10, count: 1 }])
    expect(pcts.request_count).toBe(2)
    expect(pcts.session_count).toBe(1)
  })

  test('attributionPcts sorts desc and drops 0% entries', () => {
    const costs = new Map([
      ['a', 300],
      ['b', 700],
      ['c', 4],
    ])
    expect(attributionPcts(costs, 1_000)).toEqual([
      { name: 'b', pct: 70 },
      { name: 'a', pct: 30 },
    ])
    expect(attributionPcts(costs, 0)).toEqual([])
  })
})

function assistantLine(opts: {
  uuid: string
  ts: number
  sessionId?: string
  cached?: number
  uncached?: number
  output?: number
  effort?: string
  model?: string
  isSidechain?: boolean
  messageEffort?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    timestamp: new Date(opts.ts).toISOString(),
    sessionId: opts.sessionId ?? 's1',
    isSidechain: opts.isSidechain ?? false,
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    message: {
      id: `msg_${opts.uuid}`,
      model: opts.model ?? 'claude-sonnet-4-5',
      ...(opts.messageEffort !== undefined ? { effort: opts.messageEffort } : {}),
      usage: {
        input_tokens: opts.uncached ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: opts.cached ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  })
}

describe('#017 — parseAssistantRecord (official rn adaptation)', () => {
  const path = `${sep}projects${sep}p${sep}s1.jsonl`

  test('top-level effort:"max" flags isMaxEffort (official nt marker)', () => {
    const record = parseAssistantRecord(
      assistantLine({ uuid: 'r1', ts: NOW, effort: 'max', cached: 10 }),
      path,
    )
    expect(record?.isMaxEffort).toBe(true)
  })

  test('other top-level effort values and nested effort do not flag', () => {
    expect(
      parseAssistantRecord(
        assistantLine({ uuid: 'r1', ts: NOW, effort: 'xhigh', cached: 10 }),
        path,
      )?.isMaxEffort,
    ).toBe(false)
    // A nested `"effort":"max"` inside message must NOT flag (official cn
    // only honors the LAST TOP-LEVEL occurrence).
    expect(
      parseAssistantRecord(
        assistantLine({ uuid: 'r1', ts: NOW, messageEffort: 'max', cached: 10 }),
        path,
      )?.isMaxEffort,
    ).toBe(false)
  })

  test('workflow detection is path-based (official We marker)', () => {
    const line = assistantLine({ uuid: 'r1', ts: NOW, cached: 10 })
    expect(
      parseAssistantRecord(
        line,
        `${sep}projects${sep}p${sep}s1${sep}subagents${sep}workflows${sep}run1${sep}agent-w.jsonl`,
      )?.isWorkflow,
    ).toBe(true)
    expect(
      parseAssistantRecord(
        line,
        `${sep}projects${sep}p${sep}s1${sep}subagents${sep}agent-a.jsonl`,
      )?.isWorkflow,
    ).toBe(false)
  })

  test('all-zero usage, non-assistant lines, bad JSON and bad timestamps → null', () => {
    expect(parseAssistantRecord(assistantLine({ uuid: 'r1', ts: NOW }), path)).toBeNull()
    expect(
      parseAssistantRecord(JSON.stringify({ type: 'user', message: {} }), path),
    ).toBeNull()
    expect(parseAssistantRecord('not json', path)).toBeNull()
    expect(
      parseAssistantRecord(
        JSON.stringify({
          type: 'assistant',
          timestamp: 'nope',
          message: { usage: { input_tokens: 5 } },
        }),
        path,
      ),
    ).toBeNull()
  })

  test('sidechain, model tier and token fields parse from the record', () => {
    const record = parseAssistantRecord(
      assistantLine({
        uuid: 'r1',
        ts: NOW,
        cached: 1_000,
        uncached: 20,
        output: 5,
        model: 'claude-haiku-4-5',
        isSidechain: true,
      }),
      path,
    )
    expect(record).toMatchObject({
      isSubagent: true,
      modelTier: 1,
      cached: 1_000,
      uncached: 20,
      output: 5,
      sessionId: 's1',
    })
  })
})

describe('#017 — file scan + orchestrator (official Qt/zt/ZGt)', () => {
  test('records before the cutoff are excluded but still drive the state machine', async () => {
    const dir = await makeTempProjectsDir()
    const projectDir = join(dir, 'proj')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, 's1.jsonl')
    await writeFile(
      file,
      [
        assistantLine({ uuid: 'old', ts: NOW - 10 * 86_400_000, cached: 500 }),
        assistantLine({ uuid: 'new', ts: NOW - 60_000, cached: 1_000 }),
      ].join('\n'),
    )
    const records = await scanTranscriptFile(file, NOW - 7 * 86_400_000)
    expect(records).toHaveLength(1)
    // uuid falls back requestId → message.id → uuid (official Xe ?? msg_ ?? _e).
    expect(records[0].uuid).toBe('msg_new')
    // The old record still set lastContext (state machine ran over it).
    expect(records[0].largeToolResultTokens).toBe(0)
  })

  test('files with mtime before the cutoff are skipped entirely (official Qt)', async () => {
    const dir = await makeTempProjectsDir()
    const file = join(dir, 's1.jsonl')
    await writeFile(file, assistantLine({ uuid: 'r1', ts: NOW, cached: 100 }))
    // Cutoff in the future → the fresh file is older than the cutoff.
    expect(await scanTranscriptFile(file, Date.now() + 60_000)).toEqual([])
  })

  test('computeUsageBehaviors walks projects + subagents/workflows and renders the official section', async () => {
    const dir = await makeTempProjectsDir()
    const projectDir = join(dir, 'proj')
    const workflowDir = join(projectDir, 's1', 'subagents', 'workflows', 'run1')
    await mkdir(workflowDir, { recursive: true })
    const ts = NOW - 60_000
    // Main-session record at max effort; cost (1000 + 100*10 + 10*50)*3 = 7500
    await writeFile(
      join(projectDir, 's1.jsonl'),
      assistantLine({
        uuid: 'r1',
        ts,
        sessionId: 's1',
        cached: 1_000,
        uncached: 100,
        output: 10,
        effort: 'max',
      }),
    )
    // Workflow subagent record with identical cost.
    await writeFile(
      join(workflowDir, 'agent-w.jsonl'),
      assistantLine({
        uuid: 'r2',
        ts,
        sessionId: 's2',
        cached: 1_000,
        uncached: 100,
        output: 10,
        isSidechain: true,
      }),
    )
    const behaviors = await computeUsageBehaviors(NOW, dir)
    expect(behaviors).not.toBeNull()
    expect(behaviors?.week.request_count).toBe(2)
    expect(behaviors?.week.session_count).toBe(2)
    const weekKeys = behaviors?.week.behaviors.map((b) => [b.key, b.pct])
    expect(weekKeys).toContainEqual(['max_effort', 50])
    expect(weekKeys).toContainEqual(['workflow', 50])
    // Both records are inside the last 24h as well.
    expect(behaviors?.day.request_count).toBe(2)

    // CC 2.1.305: the v299 prose templates (">100k-token cache miss" etc.)
    // are officially deleted (3 hits in v304, 0 in v306) — the rendered
    // section now carries recommendation rows instead. Drive it through
    // computeUsageWindows (official wYe), which attaches recommendations.
    const windows = await computeUsageWindows(
      {
        isEffortBelowMaxSaved: false,
        effortBelowMax: undefined,
        isEffortSwitchFree: false,
        isUltracodeOn: false,
      },
      NOW,
      dir,
    )
    expect(windows).not.toBeNull()
    const section = formatBehaviors({
      day: {
        ...windows!.day.pcts,
        recommendations: windows!.day.recommendations,
      },
      week: {
        ...windows!.week.pcts,
        recommendations: windows!.week.recommendations,
      },
    })
    expect(section).toContain("What's contributing to your limits usage?")
    expect(section).toContain('Last 24h · 2 requests · 2 sessions')
    expect(section).toContain('Last 7d · 2 requests · 2 sessions')
    expect(section).toContain('  50%  Save max effort for hard tasks')
    expect(section).toContain(
      '  50%  Save workflows for big tasks · 1 agent ran',
    )
  })

  test('an empty projects dir → null (no section rendered)', async () => {
    const dir = await makeTempProjectsDir()
    expect(await computeUsageBehaviors(NOW, dir)).toBeNull()
    expect(await computeUsageBehaviors(NOW, join(dir, 'missing'))).toBeNull()
  })
})
