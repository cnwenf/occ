import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEvidenceWindow,
  type UsageEffortState,
  type UsageEvidenceWindow,
} from '../usageRecommendations.js'
import {
  addProjectCost,
  applyAttachmentEvidence,
  attributeFileEvidence,
  attributeWindowEvidence,
  computeUsageWindows,
  createFileEvidenceCollector,
  createWindowAccumulator,
  accumulateRequest,
  finalizeFileEvidence,
  finalizeWindow,
  noteAssistantEvidence,
  noteLargeResultCandidate,
  noteUserEvidenceLine,
  scanTranscriptFile,
  type EvidenceWindowTarget,
  type FileEvidenceCollector,
  type LargeResultCandidate,
  type ScanRecord,
} from '../usageScan.js'

/**
 * CC 2.1.305 (/usage item): "each warning is now a one-line fix that names
 * its source." This file covers the evidence half of the port — the official
 * per-file collector (`ee`/`ne`/`oe`/`re`, v306 ELF @256635621 region), the
 * window attributor (`te`/`U`), `peakParallel` (`ie`) and the `wYe`
 * orchestrator end-to-end.
 */

const NOW = 1_760_000_000_000

const NO_EFFORT: UsageEffortState = {
  isEffortBelowMaxSaved: false,
  effortBelowMax: undefined,
  isEffortSwitchFree: false,
  isUltracodeOn: false,
}

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
  ts: number
  sessionId?: string
  cwd?: string
  cached?: number
  uncached?: number
  output?: number
  effort?: string
  content?: unknown[]
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    timestamp: new Date(opts.ts).toISOString(),
    sessionId: opts.sessionId ?? 's1',
    isSidechain: false,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    message: {
      id: `msg_${opts.uuid}`,
      model: 'claude-sonnet-4-5',
      ...(opts.content !== undefined ? { content: opts.content } : {}),
      usage: {
        input_tokens: opts.uncached ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: opts.cached ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  })
}

const tempDirs: string[] = []

async function makeTempProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-usage-evidence-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('2.1.305 — collector: assistant lines (official ee/oe)', () => {
  test('captures the cwd of the FIRST assistant line only, sanitized', () => {
    const collector = createFileEvidenceCollector()
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r1' }),
      assistantLine({ uuid: 'r1', ts: NOW, cwd: '/proj' }),
    )
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r2' }),
      assistantLine({ uuid: 'r2', ts: NOW, cwd: '/other' }),
    )
    expect(collector.project).toBe('/proj')
    expect(collector.sawAssistantLine).toBe(true)
    expect(collector.records).toHaveLength(2)
  })

  test('a relative or unparseable cwd stays "" (official A sentinel)', () => {
    const collector = createFileEvidenceCollector()
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r1' }),
      assistantLine({ uuid: 'r1', ts: NOW, cwd: 'relative/proj' }),
    )
    expect(collector.project).toBe('')
  })

  test('tool_use blocks register id → {tool, detail} for Read and Bash', () => {
    const collector = createFileEvidenceCollector()
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r1' }),
      assistantLine({
        uuid: 'r1',
        ts: NOW,
        cwd: '/proj',
        content: [
          { type: 'text', text: 'hi' },
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: { file_path: '/proj/big.log' },
          },
          {
            type: 'tool_use',
            id: 't2',
            name: 'Bash',
            input: { command: 'git status --porcelain' },
          },
          { type: 'tool_use', id: 't3', name: 'Grep', input: {} },
        ],
      }),
    )
    expect(collector.toolUses.get('t1')).toEqual({
      tool: 'Read',
      detail: '/proj/big.log',
    })
    expect(collector.toolUses.get('t2')).toEqual({
      tool: 'Bash',
      detail: 'git status',
    })
    expect(collector.toolUses.get('t3')).toEqual({ tool: 'Grep' })
  })

  test('the tool_use map evicts FIFO above the z=64 cap', () => {
    const collector = createFileEvidenceCollector()
    const blocks = Array.from({ length: 70 }, (_, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: 'Grep',
      input: {},
    }))
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r1' }),
      assistantLine({ uuid: 'r1', ts: NOW, content: blocks }),
    )
    expect(collector.toolUses.size).toBe(64)
    expect(collector.toolUses.has('t0')).toBe(false)
    expect(collector.toolUses.has('t5')).toBe(false)
    expect(collector.toolUses.has('t6')).toBe(true)
    expect(collector.toolUses.has('t69')).toBe(true)
  })
})

describe('2.1.305 — collector: attachment lines (official ne)', () => {
  function attachmentLine(attachment: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'user',
      message: { content: 'x' },
      attachment,
    })
  }

  test('instructions → memory tokens + the largest CLAUDE.md-family file', () => {
    const collector = createFileEvidenceCollector()
    const line = attachmentLine({
      type: 'instructions',
      files: [
        { type: 'Project', path: '/proj/CLAUDE.md', content: 'a'.repeat(400) },
        { type: 'User', path: '/home/u/.claude/CLAUDE.md', content: 'b'.repeat(800) },
        { type: 'Other', path: '/proj/notes.md', content: 'c'.repeat(4000) },
        { type: 'Local', path: 'relative.md', content: 'd'.repeat(4000) },
      ],
    })
    applyAttachmentEvidence(collector, line)
    expect(collector.parts.memory).toBe(Math.round(Buffer.byteLength(line) / 4))
    // 'Other' is not a memory file type; the relative path fails sanitize.
    expect(collector.largestFile).toEqual({
      path: '/home/u/.claude/CLAUDE.md',
      tokens: 200,
    })
  })

  test('skill_listing / mcp deltas / agent_listing route to their part buckets', () => {
    const collector = createFileEvidenceCollector()
    const skills = attachmentLine({ type: 'skill_listing' })
    const mcp = attachmentLine({ type: 'mcp_instructions_delta' })
    const deferred = attachmentLine({ type: 'deferred_tools_delta' })
    const agents = attachmentLine({ type: 'agent_listing_delta' })
    const unknown = attachmentLine({ type: 'queued_command' })
    applyAttachmentEvidence(collector, skills)
    applyAttachmentEvidence(collector, mcp)
    applyAttachmentEvidence(collector, deferred)
    applyAttachmentEvidence(collector, agents)
    applyAttachmentEvidence(collector, unknown)
    expect(collector.parts.skills).toBe(Math.round(Buffer.byteLength(skills) / 4))
    expect(collector.parts.mcp).toBe(
      Math.round(Buffer.byteLength(mcp) / 4) +
        Math.round(Buffer.byteLength(deferred) / 4),
    )
    expect(collector.parts.agents).toBe(
      Math.round(Buffer.byteLength(agents) / 4),
    )
    expect(collector.parts.memory).toBe(0)
  })

  test('attachments only count BEFORE the first assistant line (official d gate)', () => {
    const collector = createFileEvidenceCollector()
    const line = attachmentLine({ type: 'skill_listing' })
    noteUserEvidenceLine(collector, line)
    expect(collector.parts.skills).toBeGreaterThan(0)
    const before = collector.parts.skills
    noteAssistantEvidence(
      collector,
      makeRecord({ uuid: 'r1' }),
      assistantLine({ uuid: 'r1', ts: NOW, cwd: '/proj' }),
    )
    noteUserEvidenceLine(collector, line)
    expect(collector.parts.skills).toBe(before)
  })

  test('malformed JSON and non-attachment user lines are ignored', () => {
    const collector = createFileEvidenceCollector()
    applyAttachmentEvidence(collector, 'not json')
    applyAttachmentEvidence(collector, JSON.stringify({ type: 'user' }))
    expect(collector.parts).toEqual({ memory: 0, skills: 0, mcp: 0, agents: 0 })
  })
})

describe('2.1.305 — collector: large tool_result candidates (official user branch)', () => {
  function toolResultLine(id: string, filler: string): string {
    return JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: filler, tool_use_id: id }],
      },
    })
  }

  function collectorWithTool(id: string, tool: string, detail?: string) {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.sawAssistantLine = true
    collector.toolUses.set(id, {
      tool,
      ...(detail !== undefined ? { detail } : {}),
    })
    collector.records.push(makeRecord({ uuid: 'r1' }))
    return collector
  }

  test('a >25KB span with a known tool_use id becomes a candidate', () => {
    const collector = collectorWithTool('t1', 'Read', '/proj/big.log')
    const line = toolResultLine('t1', 'x'.repeat(60_000))
    noteLargeResultCandidate(collector, line)
    const span = line.slice(line.indexOf('"type":"tool_result"'))
    expect(collector.largeResults).toEqual([
      {
        tool: 'Read',
        detail: '/proj/big.log',
        recordIndex: 1,
        tokens: Math.round(span.length / 2.5),
        attributedTokens: 0,
      },
    ])
  })

  test('spans under the 10k-token gate ($3t) are skipped', () => {
    const collector = collectorWithTool('t1', 'Read', '/proj/a.log')
    noteLargeResultCandidate(collector, toolResultLine('t1', 'x'.repeat(100)))
    expect(collector.largeResults).toEqual([])
  })

  test('an unknown tool_use_id is skipped (official `if(g&&$3t(m))`)', () => {
    const collector = collectorWithTool('t1', 'Read')
    noteLargeResultCandidate(collector, toolResultLine('nope', 'x'.repeat(60_000)))
    expect(collector.largeResults).toEqual([])
  })

  test('the span stops at "toolUseResult": (official marker cut)', () => {
    const collector = collectorWithTool('t1', 'Read')
    // Raw-marker line (the gates are substring checks, not JSON): the cut
    // marker sits right after the tool_result marker, so the measured span
    // is tiny even though the line itself is huge → no candidate.
    const line = `"type":"tool_result","toolUseResult":{"content":"${'x'.repeat(60_000)}"}`
    noteLargeResultCandidate(collector, line)
    expect(collector.largeResults).toEqual([])
  })

  test('candidates cap at K=100 per file', () => {
    const collector = collectorWithTool('t1', 'Read')
    const line = toolResultLine('t1', 'x'.repeat(60_000))
    for (let i = 0; i < 105; i++) noteLargeResultCandidate(collector, line)
    expect(collector.largeResults).toHaveLength(100)
  })

  test('finalizeFileEvidence re-stamps tokens from the record delta (official end)', () => {
    const collector = createFileEvidenceCollector()
    collector.records.push(
      makeRecord({ uuid: 'r1', largeToolResultTokens: 0 }),
      makeRecord({ uuid: 'r2', largeToolResultTokens: 12_000 }),
      makeRecord({ uuid: 'r3', largeToolResultTokens: 12_000 }),
    )
    const candidates: LargeResultCandidate[] = [
      // Attributed: delta on records[1] is 12_000; raw tokens cap the stamp.
      { tool: 'Read', recordIndex: 1, tokens: 20_000, attributedTokens: 0 },
      // Dropped: records[2] - records[1] = 0 (never attributed downstream).
      { tool: 'Grep', recordIndex: 2, tokens: 15_000, attributedTokens: 0 },
      // Dropped: recordIndex past the record list.
      { tool: 'Bash', recordIndex: 9, tokens: 15_000, attributedTokens: 0 },
    ]
    collector.largeResults = candidates
    expect(finalizeFileEvidence(collector)).toEqual([
      { tool: 'Read', recordIndex: 1, tokens: 20_000, attributedTokens: 12_000 },
    ])
  })
})

describe('2.1.305 — window attribution (official te/U)', () => {
  function makeTarget(sinceMs: number): EvidenceWindowTarget {
    return {
      evidence: createEvidenceWindow(),
      sinceMs,
      seen: new Set(),
    }
  }

  test('addProjectCost accumulates per behavior + project', () => {
    const evidence: UsageEvidenceWindow = {
      projects: new Map(),
      alwaysOnStarts: new Map(),
      largeResults: new Map(),
      workflowAgents: 0,
    }
    addProjectCost(evidence, 'workflow', '/proj', 10)
    addProjectCost(evidence, 'workflow', '/proj', 5)
    addProjectCost(evidence, 'workflow', '/other', 1)
    expect(evidence.projects.get('workflow')?.get('/proj')).toBe(15)
    expect(evidence.projects.get('workflow')?.get('/other')).toBe(1)
  })

  test('workflow records bump workflowAgents once per file and log project cost', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.records.push(
      makeRecord({ uuid: 'w1', isWorkflow: true, cached: 1_000 }),
      makeRecord({ uuid: 'w2', isWorkflow: true, cached: 1_000 }),
    )
    const target = makeTarget(NOW - 1_000)
    attributeWindowEvidence(collector, [], target)
    expect(target.evidence.workflowAgents).toBe(1)
    // Each record costs 1_000 * 3 = 3_000.
    expect(target.evidence.projects.get('workflow')?.get('/proj')).toBe(6_000)
  })

  test('always-on records record the newest start snapshot with parts + largestFile', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.parts = { memory: 800, skills: 100, mcp: 50, agents: 50 }
    collector.largestFile = { path: '/proj/CLAUDE.md', tokens: 600 }
    collector.records.push(
      makeRecord({ uuid: 'r1', ts: NOW - 2_000, cached: 50_000, alwaysOnTokens: 50_000 }),
      makeRecord({ uuid: 'r2', ts: NOW - 1_000, cached: 50_000, alwaysOnTokens: 50_000 }),
    )
    const target = makeTarget(NOW - 3_000)
    attributeWindowEvidence(collector, [], target)
    const start = target.evidence.alwaysOnStarts.get('/proj')
    expect(start?.ts).toBe(NOW - 1_000)
    expect(start?.parts).toEqual({ memory: 800, skills: 100, mcp: 50, agents: 50 })
    expect(start?.largestFile).toEqual({ path: '/proj/CLAUDE.md', tokens: 600 })
    // inputCost share = 50_000/50_000 = 1 → full input cost per record.
    expect(target.evidence.projects.get('always_on_context')?.get('/proj')).toBe(
      50_000 * 3 * 2,
    )
  })

  test('records older than sinceMs and already-seen uuids are skipped', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.records.push(
      makeRecord({ uuid: 'old', ts: NOW - 100_000, isWorkflow: true, cached: 10 }),
      makeRecord({ uuid: 'dup', ts: NOW, isWorkflow: true, cached: 10 }),
    )
    const target = makeTarget(NOW - 1_000)
    target.seen.add('dup')
    attributeWindowEvidence(collector, [], target)
    expect(target.evidence.workflowAgents).toBe(0)
    expect(target.evidence.projects.size).toBe(0)
  })

  test('large-result candidates merge by project/tool/detail with max tokens + weighted cost', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.records.push(
      makeRecord({ uuid: 'r1', cached: 1_000 }),
      makeRecord({ uuid: 'r2', cached: 40_000, largeToolResultTokens: 20_000 }),
    )
    const candidates: LargeResultCandidate[] = [
      {
        tool: 'Read',
        detail: '/proj/big.log',
        recordIndex: 1,
        tokens: 24_000,
        attributedTokens: 20_000,
      },
    ]
    const target = makeTarget(NOW - 1_000)
    attributeWindowEvidence(collector, candidates, target)
    const key = `/proj\u0000Read\u0000/proj/big.log`
    const entry = target.evidence.largeResults.get(key)
    expect(entry).toBeDefined()
    expect(entry?.tool).toBe('Read')
    expect(entry?.detail).toBe('/proj/big.log')
    expect(entry?.project).toBe('/proj')
    expect(entry?.tokens).toBe(20_000)
    expect(entry?.count).toBe(1)
    // r2: cost 120_000, output 0 → inputCost 120_000; share 20_000/40_000.
    expect(entry?.cost).toBeCloseTo(120_000 * 0.5, 6)
  })

  test('a second hit on the same key bumps count and keeps max tokens', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.records.push(
      makeRecord({ uuid: 'r2', cached: 40_000, largeToolResultTokens: 20_000 }),
    )
    const candidates: LargeResultCandidate[] = [
      {
        tool: 'Read',
        detail: '/proj/big.log',
        recordIndex: 0,
        tokens: 24_000,
        attributedTokens: 20_000,
      },
      {
        tool: 'Read',
        detail: '/proj/big.log',
        recordIndex: 0,
        tokens: 24_000,
        attributedTokens: 15_000,
      },
    ]
    const target = makeTarget(NOW - 1_000)
    attributeWindowEvidence(collector, candidates, target)
    const entry = target.evidence.largeResults.get(`/proj\u0000Read\u0000/proj/big.log`)
    expect(entry?.count).toBe(2)
    expect(entry?.tokens).toBe(20_000)
  })

  test('candidates with zero attributed tokens contribute nothing', () => {
    const collector = createFileEvidenceCollector()
    collector.records.push(
      makeRecord({ uuid: 'r1', cached: 40_000, largeToolResultTokens: 20_000 }),
    )
    const target = makeTarget(NOW - 1_000)
    attributeWindowEvidence(
      collector,
      [
        {
          tool: 'Read',
          recordIndex: 0,
          tokens: 24_000,
          attributedTokens: 0,
        },
      ],
      target,
    )
    expect(target.evidence.largeResults.size).toBe(0)
  })
})

describe('2.1.305 — peakParallel (official ie)', () => {
  test('max distinct sessions in any 5-minute bucket, below the >=4 gate too', () => {
    const acc = createWindowAccumulator()
    accumulateRequest(acc, makeRecord({ sessionId: 's1', cached: 10, uuid: 'r1' }))
    accumulateRequest(acc, makeRecord({ sessionId: 's2', cached: 10, uuid: 'r2' }))
    const summary = finalizeWindow(acc)
    expect(summary.peakParallel).toBe(2)
    expect(summary.behaviors.find((b) => b.key === 'high_parallel')?.count).toBe(0)
  })
})

describe('2.1.305 — computeUsageWindows end-to-end (official wYe)', () => {
  test('recommendations name their source from the local transcript', async () => {
    const dir = await makeTempProjectsDir()
    const projectDir = join(dir, 'proj')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, 's1.jsonl')
    const filler = 'x'.repeat(60_000)
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: filler, tool_use_id: 't1' },
        ],
      },
    })
    await writeFile(
      file,
      [
        assistantLine({
          uuid: 'r1',
          ts: NOW - 60_000,
          cwd: '/proj',
          cached: 1_000,
          output: 10,
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/proj/big.log' },
            },
          ],
        }),
        toolResultLine,
        assistantLine({ uuid: 'r2', ts: NOW - 30_000, cwd: '/proj', cached: 40_000 }),
      ].join('\n'),
    )
    const windows = await computeUsageWindows(NO_EFFORT, NOW, dir)
    expect(windows).not.toBeNull()
    expect(windows?.week.pcts.request_count).toBe(2)
    const recs = windows?.week.recommendations ?? []
    expect(recs).toHaveLength(1)
    expect(recs[0]?.key).toBe('large_tool_results')
    // The warning names its source: the exact file the Read tool returned.
    expect(recs[0]?.title).toBe('Read /proj/big.log in parts')
    expect(recs[0]?.detail).toBe('up to 24k tokens')
    expect(recs[0]?.action?.kind).toBe('prompt')
    expect(recs[0]?.pct).toBeGreaterThanOrEqual(50)
    // The day window sees the same records.
    expect(windows?.day.recommendations[0]?.title).toBe(
      'Read /proj/big.log in parts',
    )
  })

  test('workflow transcripts count agents and always-on snapshots name the CLAUDE.md', async () => {
    const dir = await makeTempProjectsDir()
    const projectDir = join(dir, 'proj')
    const workflowDir = join(projectDir, 's1', 'subagents', 'workflows', 'run1')
    await mkdir(workflowDir, { recursive: true })
    // Main session: a fat first request (always-on) + a big instructions
    // attachment. The attachment must be >~143KB so its memory tokens
    // (lineBytes/4) clear the official 25%-of-start-tokens dominance gate
    // while the first-prompt deduction (lineBytes/2.5) keeps startTokens
    // above the 40k always-on floor: 200_000 - 0.4*B > 40_000 and
    // 0.25*B >= 0.25*(200_000 - 0.4*B).
    const attachmentLine = JSON.stringify({
      type: 'user',
      message: { content: 'x' },
      attachment: {
        type: 'instructions',
        files: [
          {
            type: 'Project',
            path: '/proj/CLAUDE.md',
            content: 'a'.repeat(150_000),
          },
        ],
      },
    })
    await writeFile(
      join(projectDir, 's1.jsonl'),
      [
        attachmentLine,
        assistantLine({
          uuid: 'r1',
          ts: NOW - 60_000,
          cwd: '/proj',
          cached: 200_000,
        }),
      ].join('\n'),
    )
    await writeFile(
      join(workflowDir, 'agent-w.jsonl'),
      assistantLine({
        uuid: 'w1',
        ts: NOW - 120_000,
        sessionId: 's2',
        cwd: '/proj',
        cached: 100_000,
      }),
    )
    const windows = await computeUsageWindows(NO_EFFORT, NOW, dir)
    const weekRecs = windows?.week.recommendations ?? []
    const keys = weekRecs.map((r) => r.key)
    expect(keys).toContain('always_on_context')
    expect(keys).toContain('workflow')
    const workflow = weekRecs.find((r) => r.key === 'workflow')
    expect(workflow?.title).toBe('Save workflows for big tasks')
    expect(workflow?.detail).toBe('1 agent ran, mostly in /proj')
    const alwaysOn = weekRecs.find((r) => r.key === 'always_on_context')
    expect(alwaysOn?.title).toBe('Trim /proj/CLAUDE.md')
    expect(alwaysOn?.detail).toBe('38k tokens per request')
    expect(alwaysOn?.action?.kind).toBe('prompt')
  })

  test('an empty projects dir → null', async () => {
    const dir = await makeTempProjectsDir()
    expect(await computeUsageWindows(NO_EFFORT, NOW, dir)).toBeNull()
  })

  test('attributeFileEvidence fans one file out to both window targets', () => {
    const collector = createFileEvidenceCollector()
    collector.project = '/proj'
    collector.records.push(
      makeRecord({ uuid: 'w1', isWorkflow: true, cached: 100 }),
    )
    const day: EvidenceWindowTarget = {
      evidence: {
        projects: new Map(),
        alwaysOnStarts: new Map(),
        largeResults: new Map(),
        workflowAgents: 0,
      },
      sinceMs: NOW - 1_000,
      seen: new Set(),
    }
    const week: EvidenceWindowTarget = {
      evidence: {
        projects: new Map(),
        alwaysOnStarts: new Map(),
        largeResults: new Map(),
        workflowAgents: 0,
      },
      sinceMs: NOW - 100_000,
      seen: new Set(),
    }
    attributeFileEvidence(collector, [day, week])
    expect(day.evidence.workflowAgents).toBe(1)
    expect(week.evidence.workflowAgents).toBe(1)
  })

  test('scanTranscriptFile threads the evidence collector without changing records', async () => {
    const dir = await makeTempProjectsDir()
    const file = join(dir, 's1.jsonl')
    await writeFile(
      file,
      assistantLine({ uuid: 'r1', ts: NOW, cwd: '/proj', cached: 100 }),
    )
    const collector: FileEvidenceCollector = createFileEvidenceCollector()
    const records = await scanTranscriptFile(file, NOW - 1_000, collector)
    expect(records).toHaveLength(1)
    expect(collector.records).toHaveLength(1)
    expect(collector.project).toBe('/proj')
    // Without a collector the scan behaves exactly as before.
    const plain = await scanTranscriptFile(file, NOW - 1_000)
    expect(plain).toEqual(records)
  })
})
