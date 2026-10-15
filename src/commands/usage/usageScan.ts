/**
 * CC 2.1.299 (#017): the local transcript scan that feeds the /usage
 * behavior warnings ("max effort, workflows, always-on context and large
 * tool results" + the 5 pre-existing behaviors).
 *
 * Byte-faithful port of the official pure logic. Forensics (v299 ELF,
 * /tmp/cc-diff-299 — offsets into package/claude):
 *   - Model tier `Kt`: fable→10, opus→5, haiku→1, else/undefined→3.
 *   - Weighted cost `Gt`: (cached + uncached*10 + cacheCreate*12.5 +
 *     output*50) * modelTier.
 *   - Per-file state machine `Z`/`K`/`G`/`ee`/`te` @236979700 region —
 *     tracks carriedTokens / startTokens / pendingToolResultBytes /
 *     largeToolResultTokens and stamps alwaysOnTokens (>40k start context,
 *     non-subagent) + largeToolResultTokens onto each request record.
 *   - Window accumulator `le` @236993641 + finalizer `de` @236994961:
 *     9 behaviors; classifiers — high_parallel: 5-min buckets
 *     (`Ke=300000`) with >=4 (`Ge`) distinct sessions; subagent_heavy:
 *     sessions with >=3 (`Fe`) subagent requests or subagent cost share
 *     >0.5 (`He`); cron: sessions active in >=8 (`qe`) distinct hours.
 *     Thresholds: cache miss uncached >1e5 (`ve`), long context r>150000
 *     (`Ue`); always-on / large-tool-result costs are the request cost
 *     minus output cost, scaled by the token share (min 1).
 *   - Pct mapper `h` @236999640: behaviors kept when
 *     cost/totalCost*100 >= 10 (`AKr`); attribution lists via `B`.
 *   - Orchestrator `ZGt`: day cutoff = now-86400000, week = now-604800000
 *     (`fe`); file walk `zt` lists .jsonl in the projects dir and each
 *     session's `subagents/` tree recursively; `Qt` skips files with
 *     mtime < cutoff; the workflow flag is path-based —
 *     `We = "${sep}subagents${sep}workflows${sep}"` (OPt="workflows"
 *     @222897759).
 *
 * OCC adaptations (documented per site):
 *   - The official line handler `rn` scans RAW BYTES for markers
 *     ('"type":"assistant"', '"usage":{', '"effort":"max"', ...). OCC
 *     transcripts are official-format-compatible JSONL (SerializedMessage
 *     carries type/timestamp/sessionId/message.usage/isSidechain), so this
 *     port JSON.parses each line and reads the same fields structurally.
 *     `cn`'s brace-depth scan for the LAST top-level '"effort":"max"' is
 *     exactly `parsed.effort === 'max'` on the parsed top level.
 *   - The user-line tool_result byte heuristics (`Zt`: raw indexOf of
 *     '"type":"tool_result"' / '"toolUseResult":') are reproduced with the
 *     parsed tool_result blocks' serialized byte sizes, and `K`'s
 *     first-prompt byte accounting uses the raw line length.
 *   - `loops` (loop/fire/command-record parsing) is omitted: it feeds only
 *     the official `loops` output, which formatBehaviors never reads.
 *   - Attribution fields (attributionAgent/Skill/Plugin/McpServer) are
 *     parsed when present; OCC's transcript writer does not currently emit
 *     them, so the Top lists stay empty and formatWindow omits them.
 *   - One file walk serves both windows (records kept at the week cutoff,
 *     day accumulation filtered in-memory) — same result as the official's
 *     per-window cutoffs, half the IO.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  BEHAVIOR_KEYS,
  BEHAVIOR_PCT_THRESHOLD,
  type BehaviorKey,
  type BehaviorWindowPcts,
} from './usageWarnings.js'

// Official constants (v299): fe=604800000 (week), day=86400000, Ue=150000,
// ve=1e5, Fe=3, He=0.5, Ke=300000, Ge=4, qe=8, always-on 40000, large tool
// result 1e4 tokens, bytes→tokens divisor 2.5.
export const WEEK_WINDOW_MS = 604_800_000
export const DAY_WINDOW_MS = 86_400_000
export const LONG_CONTEXT_TOKENS = 150_000
export const CACHE_MISS_UNCACHED_TOKENS = 100_000
export const SUBAGENT_HEAVY_MIN_REQUESTS = 3
export const SUBAGENT_HEAVY_COST_SHARE = 0.5
export const PARALLEL_BUCKET_MS = 300_000
export const PARALLEL_MIN_SESSIONS = 4
export const CRON_MIN_ACTIVE_HOURS = 8
export const ALWAYS_ON_MIN_TOKENS = 40_000
export const LARGE_TOOL_RESULT_MIN_TOKENS = 10_000
export const BYTES_PER_TOKEN = 2.5
const HOUR_MS = 3_600_000

/** Official `Kt` — cost tier by model family. */
export function modelTierOf(model: string | undefined): number {
  if (!model) return 3
  if (model.includes('fable')) return 10
  if (model.includes('opus')) return 5
  if (model.includes('haiku')) return 1
  return 3
}

/** One parsed assistant-request record (official `rn` output). */
export interface ScanRecord {
  ts: number
  sessionId: string
  cached: number
  cacheCreate: number
  uncached: number
  output: number
  isSubagent: boolean
  isMaxEffort: boolean
  isWorkflow: boolean
  alwaysOnTokens: number
  largeToolResultTokens: number
  modelTier: number
  model: string | undefined
  uuid: string
  attributionAgent?: string
  attributionSkill?: string
  attributionPlugin?: string
  attributionMcpServer?: string
}

/** Official `Gt` — weighted request cost. */
export function weightedCost(record: ScanRecord): number {
  return (
    (record.cached +
      record.uncached * 10 +
      record.cacheCreate * 12.5 +
      record.output * 50) *
    record.modelTier
  )
}

/** Official `Z` — per-file scan state. */
export interface ScanState {
  lastRequest: string | undefined
  lastContext: number
  carriedTokens: number
  firstPromptBytes: number
  startTokens: number
  pendingToolResultBytes: number
  largeToolResultTokens: number
}

export function createScanState(): ScanState {
  return {
    lastRequest: undefined,
    lastContext: 0,
    carriedTokens: 0,
    firstPromptBytes: 0,
    startTokens: 0,
    pendingToolResultBytes: 0,
    largeToolResultTokens: 0,
  }
}

/** Official `K(e,n)` — first-prompt byte accounting before any request. */
export function notePromptBytes(state: ScanState, bytes: number): void {
  if (state.lastRequest === undefined) state.firstPromptBytes += bytes
}

/** Official `G(e)` — a tool result counts as large above 1e4 tokens. */
export function isLargeToolResult(bytes: number): boolean {
  return bytes / BYTES_PER_TOKEN > LARGE_TOOL_RESULT_MIN_TOKENS
}

/** Official `ee(e,n)` — accumulate pending large tool-result bytes. */
export function noteToolResultBytes(state: ScanState, bytes: number): void {
  if (isLargeToolResult(bytes)) state.pendingToolResultBytes += bytes
}

/**
 * Official `te(e,n)` — apply one request record to the per-file state and
 * stamp alwaysOnTokens / largeToolResultTokens onto the record (mutates the
 * record's two derived fields exactly as the official does; the record is
 * scan-local, never shared).
 */
export function applyRequestRecord(state: ScanState, record: ScanRecord): void {
  const contextTokens = record.cached + record.cacheCreate + record.uncached
  if (record.uuid === state.lastRequest) {
    state.carriedTokens = Math.max(state.carriedTokens, contextTokens + record.output)
  } else {
    if (state.lastRequest === undefined) {
      state.startTokens =
        contextTokens - Math.round(state.firstPromptBytes / BYTES_PER_TOKEN)
    } else if (contextTokens < state.lastContext) {
      state.largeToolResultTokens = Math.max(
        0,
        state.largeToolResultTokens - (state.lastContext - contextTokens),
      )
    } else {
      const grown = Math.min(
        contextTokens - state.carriedTokens,
        state.pendingToolResultBytes / BYTES_PER_TOKEN,
      )
      if (grown > LARGE_TOOL_RESULT_MIN_TOKENS) {
        state.largeToolResultTokens += grown
      }
    }
    state.startTokens = Math.min(state.startTokens, contextTokens)
    state.lastRequest = record.uuid
    state.lastContext = contextTokens
    state.carriedTokens = contextTokens + record.output
    state.pendingToolResultBytes = 0
  }
  record.largeToolResultTokens = state.largeToolResultTokens
  record.alwaysOnTokens =
    !record.isSubagent && state.startTokens > ALWAYS_ON_MIN_TOKENS
      ? state.startTokens
      : 0
}

interface BehaviorTotals {
  cost: number
  count: number
}

function newBehaviorTotals(): BehaviorTotals {
  return { cost: 0, count: 0 }
}

interface SessionTotals {
  cost: number
  requests: number
  subCost: number
  subCount: number
  hours: Set<number>
}

interface BucketTotals {
  sids: Set<string>
  cost: number
  count: number
}

/** Official `ae` — window accumulator. */
export interface WindowAccumulator {
  totalCost: number
  requestCount: number
  sessions: Map<string, SessionTotals>
  buckets: Map<number, BucketTotals>
  behaviors: Record<BehaviorKey, BehaviorTotals>
  byAgent: Map<string, number>
  bySkill: Map<string, number>
  byPlugin: Map<string, number>
  byMcp: Map<string, number>
}

export function createWindowAccumulator(): WindowAccumulator {
  const behaviors = {} as Record<BehaviorKey, BehaviorTotals>
  for (const key of BEHAVIOR_KEYS) behaviors[key] = newBehaviorTotals()
  return {
    totalCost: 0,
    requestCount: 0,
    sessions: new Map(),
    buckets: new Map(),
    behaviors,
    byAgent: new Map(),
    bySkill: new Map(),
    byPlugin: new Map(),
    byMcp: new Map(),
  }
}

function addAttribution(map: Map<string, number>, name: string | undefined, cost: number): void {
  if (name) map.set(name, (map.get(name) ?? 0) + cost)
}

/** Official `le` (minus the loops branch) — accumulate one request. */
export function accumulateRequest(acc: WindowAccumulator, record: ScanRecord): void {
  const cost = weightedCost(record)
  acc.totalCost += cost
  acc.requestCount++
  addAttribution(acc.byAgent, record.attributionAgent, cost)
  addAttribution(acc.bySkill, record.attributionSkill, cost)
  addAttribution(acc.byPlugin, record.attributionPlugin, cost)
  addAttribution(acc.byMcp, record.attributionMcpServer, cost)

  const contextTokens = record.cached + record.cacheCreate + record.uncached
  if (record.uncached > CACHE_MISS_UNCACHED_TOKENS) {
    acc.behaviors.cache_miss.cost += cost
    acc.behaviors.cache_miss.count++
  }
  if (contextTokens > LONG_CONTEXT_TOKENS) {
    acc.behaviors.long_context.cost += cost
    acc.behaviors.long_context.count++
  }
  if (record.isMaxEffort) {
    acc.behaviors.max_effort.cost += cost
    acc.behaviors.max_effort.count++
  }
  if (record.isWorkflow) {
    acc.behaviors.workflow.cost += cost
    acc.behaviors.workflow.count++
  }
  // Official: `i = s - output*50*modelTier` — input-side cost only, scaled
  // by the token share.
  const inputCost = cost - record.output * 50 * record.modelTier
  if (record.alwaysOnTokens > 0) {
    acc.behaviors.always_on_context.cost +=
      inputCost * Math.min(1, record.alwaysOnTokens / contextTokens)
    acc.behaviors.always_on_context.count++
  }
  if (record.largeToolResultTokens > 0) {
    acc.behaviors.large_tool_results.cost +=
      inputCost * Math.min(1, record.largeToolResultTokens / contextTokens)
    acc.behaviors.large_tool_results.count++
  }

  const session = acc.sessions.get(record.sessionId) ?? {
    cost: 0,
    requests: 0,
    subCost: 0,
    subCount: 0,
    hours: new Set<number>(),
  }
  const updated = {
    ...session,
    cost: session.cost + cost,
    requests: session.requests + 1,
    subCost: record.isSubagent ? session.subCost + cost : session.subCost,
    subCount: record.isSubagent ? session.subCount + 1 : session.subCount,
    hours: new Set(session.hours).add(Math.floor(record.ts / HOUR_MS)),
  }
  acc.sessions.set(record.sessionId, updated)

  const bucketKey = Math.floor(record.ts / PARALLEL_BUCKET_MS)
  const bucket = acc.buckets.get(bucketKey) ?? {
    sids: new Set<string>(),
    cost: 0,
    count: 0,
  }
  bucket.sids.add(record.sessionId)
  bucket.cost += cost
  bucket.count++
  acc.buckets.set(bucketKey, bucket)
}

interface WindowSummary {
  totalCost: number
  requestCount: number
  sessionCount: number
  behaviors: Array<{ key: BehaviorKey; cost: number; count: number }>
  byAgent: Map<string, number>
  bySkill: Map<string, number>
  byPlugin: Map<string, number>
  byMcp: Map<string, number>
}

/** Official `de` — classify sessions/buckets into the 9 behavior totals. */
export function finalizeWindow(acc: WindowAccumulator): WindowSummary {
  let parallelCost = 0
  let parallelCount = 0
  for (const bucket of acc.buckets.values()) {
    if (bucket.sids.size >= PARALLEL_MIN_SESSIONS) {
      parallelCost += bucket.cost
      parallelCount += bucket.count
    }
  }
  acc.behaviors.high_parallel.cost = parallelCost
  acc.behaviors.high_parallel.count = parallelCount

  let subagentCost = 0
  let subagentCount = 0
  let cronCost = 0
  let cronCount = 0
  for (const session of acc.sessions.values()) {
    if (
      session.subCount >= SUBAGENT_HEAVY_MIN_REQUESTS ||
      (session.cost > 0 && session.subCost / session.cost > SUBAGENT_HEAVY_COST_SHARE)
    ) {
      subagentCost += session.cost
      subagentCount += session.requests
    }
    if (session.hours.size >= CRON_MIN_ACTIVE_HOURS) {
      cronCost += session.cost
      cronCount += session.requests
    }
  }
  acc.behaviors.subagent_heavy.cost = subagentCost
  acc.behaviors.subagent_heavy.count = subagentCount
  acc.behaviors.cron.cost = cronCost
  acc.behaviors.cron.count = cronCount

  const behaviors = BEHAVIOR_KEYS.map((key) => ({
    key,
    cost: acc.behaviors[key].cost,
    count: acc.behaviors[key].count,
  })).sort((a, b) => b.cost - a.cost)

  return {
    totalCost: acc.totalCost,
    requestCount: acc.requestCount,
    sessionCount: acc.sessions.size,
    behaviors,
    byAgent: acc.byAgent,
    bySkill: acc.bySkill,
    byPlugin: acc.byPlugin,
    byMcp: acc.byMcp,
  }
}

/** Official `B(e,n)` — cost map → sorted {name,pct} list (pct>0 only). */
export function attributionPcts(
  costs: Map<string, number>,
  totalCost: number,
): Array<{ name: string; pct: number }> {
  if (totalCost <= 0) return []
  return [...costs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost]) => ({ name, pct: Math.round((cost / totalCost) * 100) }))
    .filter((entry) => entry.pct > 0)
}

/** Official `h(e)` — window summary → pct payload for the formatters. */
export function toBehaviorPcts(summary: WindowSummary): BehaviorWindowPcts {
  return {
    request_count: summary.requestCount,
    session_count: summary.sessionCount,
    behaviors: summary.behaviors
      .filter(
        (b) =>
          summary.totalCost > 0 &&
          (b.cost / summary.totalCost) * 100 >= BEHAVIOR_PCT_THRESHOLD,
      )
      .map((b) => ({
        key: b.key,
        pct: Math.round((b.cost / summary.totalCost) * 100),
        count: b.count,
      })),
    agents: attributionPcts(summary.byAgent, summary.totalCost),
    skills: attributionPcts(summary.bySkill, summary.totalCost),
    plugins: attributionPcts(summary.byPlugin, summary.totalCost),
    mcp_servers: attributionPcts(summary.byMcp, summary.totalCost),
  }
}

/** Official `We` — workflow transcripts live under subagents/workflows/. */
const WORKFLOW_PATH_MARKER = `${sep}subagents${sep}workflows${sep}`

/**
 * sessionStorage.getProjectsDir() (:285-287) recomputed locally — importing
 * sessionStorage would pull the whole auth/query module graph into the
 * /usage command for one join().
 */
export function defaultProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/** Official `rn` (JSON.parse adaptation) — parse one assistant line. */
export function parseAssistantRecord(
  line: string,
  filePath: string,
): ScanRecord | null {
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed?.type !== 'assistant') return null
  const usage = parsed.message?.usage
  if (!usage) return null
  const cached = Number(usage.cache_read_input_tokens ?? 0)
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0)
  const uncached = Number(usage.input_tokens ?? 0)
  const output = Number(usage.output_tokens ?? 0)
  // Official: skip records whose token counts are all zero.
  if (cached === 0 && cacheCreate === 0 && uncached === 0 && output === 0) {
    return null
  }
  const ts = Date.parse(parsed.timestamp)
  if (Number.isNaN(ts)) return null
  const model = parsed.message?.model
  return {
    ts,
    sessionId: String(parsed.sessionId ?? ''),
    cached,
    cacheCreate,
    uncached,
    output,
    isSubagent: parsed.isSidechain === true,
    // Official marker `nt='"effort":"max"'` (last TOP-LEVEL occurrence —
    // `cn`); on the parsed record that is exactly parsed.effort.
    isMaxEffort: parsed.effort === 'max',
    isWorkflow: filePath.includes(WORKFLOW_PATH_MARKER),
    alwaysOnTokens: 0,
    largeToolResultTokens: 0,
    modelTier: modelTierOf(model),
    model,
    uuid: String(parsed.requestId ?? parsed.message?.id ?? parsed.uuid ?? ''),
    ...(parsed.attributionAgent !== undefined ||
    parsed.attributionSkill !== undefined ||
    parsed.attributionPlugin !== undefined ||
    parsed.attributionMcpServer !== undefined
      ? {
          attributionAgent: parsed.attributionAgent,
          attributionSkill: parsed.attributionSkill,
          attributionPlugin: parsed.attributionPlugin,
          attributionMcpServer: parsed.attributionMcpServer,
        }
      : {}),
  }
}

/**
 * Official `Zt` user-line branch (adaptation): user lines either carry
 * tool_results (large ones feed `ee`'s pending bytes) or are prompts
 * (feed `K`'s first-prompt bytes).
 */
export function applyUserLine(state: ScanState, line: string): void {
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (parsed?.type !== 'user') return
  const content = parsed.message?.content
  const toolResults = Array.isArray(content)
    ? content.filter((block: any) => block?.type === 'tool_result')
    : []
  if (toolResults.length === 0) {
    notePromptBytes(state, Buffer.byteLength(line))
    return
  }
  for (const toolResult of toolResults) {
    const bytes = Buffer.byteLength(JSON.stringify(toolResult))
    if (isLargeToolResult(bytes)) noteToolResultBytes(state, bytes)
  }
}

/** Official `zt` — list .jsonl transcripts: projects/* plus each session's
 * subagents/ tree, recursively. */
export async function listTranscriptFiles(projectsDir: string): Promise<string[]> {
  const files: string[] = []
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return files
  }
  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir)
    let entries
    try {
      entries = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(projectPath, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath)
      } else if (entry.isDirectory()) {
        // Session dir — walk its subagents/ tree (official recursive scan).
        const subagentsPath = join(entryPath, 'subagents')
        await walkJsonl(subagentsPath, files)
      }
    }
  }
  return files
}

async function walkJsonl(dir: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath)
    } else if (entry.isDirectory()) {
      await walkJsonl(entryPath, files)
    }
  }
}

/** Official `Qt`+`be`+`Zt` — scan one file into records at/after cutoff. */
export async function scanTranscriptFile(
  filePath: string,
  cutoff: number,
): Promise<ScanRecord[]> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return []
  }
  if (info.mtimeMs < cutoff) return []
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const state = createScanState()
  const records: ScanRecord[] = []
  for (const line of content.split('\n')) {
    if (line === '') continue
    const record = parseAssistantRecord(line, filePath)
    if (record !== null) {
      applyRequestRecord(state, record)
      if (record.ts >= cutoff) records.push(record)
      continue
    }
    applyUserLine(state, line)
  }
  return records
}

/**
 * Official `ZGt`/`iwn({includeBehaviors})` — scan local transcripts and
 * return the pct payloads for the "Last 24h" / "Last 7d" windows, or null
 * when there is nothing to report.
 */
export async function computeUsageBehaviors(
  now: number = Date.now(),
  projectsDir: string = defaultProjectsDir(),
): Promise<{ day: BehaviorWindowPcts; week: BehaviorWindowPcts } | null> {
  const weekCutoff = now - WEEK_WINDOW_MS
  const dayCutoff = now - DAY_WINDOW_MS
  const files = await listTranscriptFiles(projectsDir)
  const dayAcc = createWindowAccumulator()
  const weekAcc = createWindowAccumulator()
  let sawAny = false
  for (const file of files) {
    const records = await scanTranscriptFile(file, weekCutoff)
    for (const record of records) {
      sawAny = true
      accumulateRequest(weekAcc, record)
      if (record.ts >= dayCutoff) accumulateRequest(dayAcc, record)
    }
  }
  if (!sawAny) return null
  return {
    day: toBehaviorPcts(finalizeWindow(dayAcc)),
    week: toBehaviorPcts(finalizeWindow(weekAcc)),
  }
}
