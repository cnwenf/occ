/**
 * K3 (2.1.154): Workflow script primitives — the host functions injected into
 * the vm sandbox for workflow scripts to call.
 *
 * Mirrors the 2.1.200 binary's primitive set:
 *   - agent(prompt, opts?) — spawns a subagent via runAgent().
 *   - parallel(items) — Promise.allSettled with ~10 concurrency cap, 4096 max.
 *   - pipeline(items, ...stages) — stream items through stage chain.
 *   - phase(title) — group subsequent agent() calls.
 *   - log(...args) — append to workflow-scoped logs.
 *   - budget — {total, remaining(), spent()}; throws when exhausted.
 *   - workflow(nameOrRef) / resolveWorkflow(name) — resolve named workflows.
 *
 * REUSE (do not rebuild):
 *   - runAgent() at src/tools/AgentTool/runAgent.ts:252 (async generator;
 *     drain to completion).
 *   - GENERAL_PURPOSE_AGENT for the ephemeral AgentDefinition.
 *   - createAgentWorktree for isolation:'worktree'.
 *   - SYNTHETIC_OUTPUT_TOOL_NAME ('StructuredOutput') for schema opts.
 *   - getTokenCountFromUsage for budget tracking.
 */
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { ToolUseContext, CanUseToolFn, Tools } from '../../Tool.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import { createAgentWorktree } from '../../utils/worktree.js'
import { extractTextContent, getLastAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { createAgentId } from '../../utils/uuid.js'
import { asAgentId } from '../../types/ids.js'
import { logEvent } from '../../services/analytics/index.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import {
  WorkflowAgentCapError,
  WorkflowBudgetExceededError,
  isWorkflowCapError,
} from './errors.js'
import { computeAgentKey, type WorkflowJournal } from './journal.js'
import type { WorkflowMeta } from './scriptLoader.js'
import { getMainLoopModel } from '../../utils/model/model.js'

/** Lifetime cap on total agent() calls across a workflow. Runaway backstop. */
export const WORKFLOW_AGENT_LIFETIME_CAP = 1000

/** Max items in a single parallel()/pipeline() call. */
export const WORKFLOW_PARALLEL_MAX_ITEMS = 4096

/** Default concurrency for parallel()/pipeline(). */
export const WORKFLOW_DEFAULT_CONCURRENCY = 10

/**
 * 2.1.202: Build the OpenTelemetry attributes that tag workflow-spawned agent
 * telemetry with the originating workflow run, so a run's activity can be
 * reconstructed from OTel data. OCC's analytics sink is stubbed, so these
 * attributes are no-op parity — the stubbed logEvent accepts them.
 */
export function workflowAgentTelemetryAttributes(
  runId: string,
  workflowName: string,
): { 'workflow.run_id': string; 'workflow.name': string } {
  return {
    'workflow.run_id': runId,
    'workflow.name': workflowName,
  }
}

/** agent() options shape. */
export interface AgentOpts {
  label?: string
  phase?: string
  schema?: Record<string, unknown> | null
  model?: string
  effort?: string
  isolation?: 'worktree' | 'remote'
}

/** The runtime context the engine passes to createPrimitives. */
export interface WorkflowRuntimeContext {
  runId: string
  /** Workflow meta.name — carried on agent-spawn telemetry (2.1.202). */
  workflowName: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  /** Full tool pool from the parent session. */
  availableTools: Tools
  /** Journal for resume cache. Undefined when resume is not configured. */
  journal?: WorkflowJournal
  /** Cached results keyed by agent key (loaded from journal on resume). */
  cachedResults?: Map<string, unknown>
  /** Token budget target. null/undefined = no budget cap. */
  tokenBudget?: number | null
  /** Mutable counters (shared object so primitives see updates). */
  counters: {
    agentCount: number
    spentTokens: number
    failures: string[]
    logs: string[]
  }
  /** Current phase title (mutable). */
  currentPhase: string
  /** Phase progress entries for onProgress. Includes per-agent stats. */
  workflowProgress: Array<{
    phase: string
    completedAgents: number
    totalAgents: number
    agentCount: number
    agents: Array<{
      id: string
      label: string
      agentType: string
      status: 'running' | 'done' | 'error'
      toolUseCount: number
      latestInputTokens: number
      cumulativeOutputTokens: number
      recentActivities: Array<{
        toolName: string
        input: string
        activityDescription: string
        isSearch: boolean
        isRead: boolean
      }>
      lastActivity?: string
      isResolved: boolean
      isError: boolean
    }>
  }>
  /** Seed phase titles from meta.phases. */
  seedPhaseTitles?: string[]
  /** AbortController for the workflow run. */
  abortController: AbortController
  /** onProgress callback (batched by engine). */
  onProgress?: (data: unknown) => void
  /** Resolve a named workflow to a scriptPath (from discovery). */
  resolveWorkflowScript?: (name: string) => string | null
}

/**
 * Build a counting semaphore (cap N concurrent). Adapted from
 * src/utils/sequential.ts queue pattern — cap N instead of 1.
 */
function createSemaphore(cap: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= cap) {
      await new Promise<void>(r => queue.push(r))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = queue.shift()
      if (next) next()
    }
  }
}

/**
 * Drain an async generator into an array of messages.
 */
async function drainGenerator(
  gen: AsyncGenerator<Message, void>,
): Promise<Message[]> {
  const messages: Message[] = []
  for await (const msg of gen) {
    messages.push(msg)
  }
  return messages
}

/**
 * Extract the text result from a drained agent's messages.
 * Returns the concatenated text content of the last assistant message
 * (falling back to the most recent assistant message with text).
 */
function extractAgentTextResult(messages: Message[]): string {
  const last = getLastAssistantMessage(messages)
  if (!last) return ''
  const content = (last.message?.content as Array<{ type: string; text?: string; input?: unknown; name?: string }> | undefined) ?? []
  let textBlocks = content.filter(b => b.type === 'text')
  if (textBlocks.length === 0) {
    // Fall back to most recent assistant message with text content.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.type !== 'assistant') continue
      const blocks = (m.message?.content as Array<{ type: string; text?: string }> | undefined) ?? []
      const texts = blocks.filter(b => b.type === 'text')
      if (texts.length > 0) {
        textBlocks = texts
        break
      }
    }
  }
  return extractTextContent(textBlocks, '\n')
}

/**
 * Extract a StructuredOutput tool_use's input from the drained messages.
 * Returns the structured_output object if the agent called StructuredOutput,
 * else null. Searches from the last assistant message backwards.
 */
function extractStructuredOutput(
  messages: Message[],
): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.type !== 'assistant') continue
    const content = (m.message?.content as Array<{ type: string; name?: string; input?: unknown }> | undefined) ?? []
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
        const input = block.input
        if (input && typeof input === 'object') {
          return input as Record<string, unknown>
        }
      }
    }
  }
  return null
}

/**
 * Extract token usage from drained messages (sum of all assistant message
 * usage). Used for budget tracking.
 */
function extractTokenUsage(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const usage = m.message?.usage as Parameters<typeof getTokenCountFromUsage>[0] | undefined
    if (usage) {
      total += getTokenCountFromUsage(usage)
    }
  }
  return total
}

/**
 * Extract a per-agent token breakdown from drained messages.
 * Returns { latestInputTokens, cumulativeOutputTokens } mirroring the
 * binary's g9n() accumulator: latestInputTokens = the last assistant
 * message's input tokens; cumulativeOutputTokens = sum of output tokens
 * across all assistant turns. Total = h9n(e) = latestInput + cumulative.
 */
function extractTokenBreakdown(messages: Message[]): {
  latestInputTokens: number
  cumulativeOutputTokens: number
} {
  let latestInputTokens = 0
  let cumulativeOutputTokens = 0
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const usage = m.message?.usage as
      | {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      | undefined
    if (!usage) continue
    // Latest input = input + cache tokens of the most recent assistant msg.
    latestInputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    cumulativeOutputTokens += usage.output_tokens ?? 0
  }
  return { latestInputTokens, cumulativeOutputTokens }
}

/**
 * Extract tool-use stats from drained messages: toolUseCount + a small ring
 * of recentActivities ({ toolName, input, activityDescription, isSearch,
 * isRead }). Mirrors the binary's g9n().recentActivities. Cap at 5 to keep
 * the progress payload small.
 */
function extractToolUseStats(messages: Message[]): {
  toolUseCount: number
  recentActivities: Array<{
    toolName: string
    input: string
    activityDescription: string
    isSearch: boolean
    isRead: boolean
  }>
  lastActivity: string | undefined
} {
  const recentActivities: Array<{
    toolName: string
    input: string
    activityDescription: string
    isSearch: boolean
    isRead: boolean
  }> = []
  let toolUseCount = 0
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = (m.message?.content as Array<{ type: string; name?: string; input?: unknown }> | undefined) ?? []
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      toolUseCount++
      const toolName = block.name ?? 'unknown'
      const inputStr =
        typeof block.input === 'string'
          ? block.input
          : (() => {
              try {
                return JSON.stringify(block.input).slice(0, 120)
              } catch {
                return String(block.input ?? '').slice(0, 120)
              }
            })()
      const isSearch = /^(Grep|Glob)$/.test(toolName)
      const isRead = toolName === 'Read'
      recentActivities.push({
        toolName,
        input: inputStr,
        activityDescription: inputStr,
        isSearch,
        isRead,
      })
    }
  }
  // Cap the ring at 5 most-recent activities.
  const capped = recentActivities.slice(-5)
  const lastActivity = capped.length > 0 ? capped[capped.length - 1].activityDescription : undefined
  return { toolUseCount, recentActivities: capped, lastActivity }
}

/**
 * Create the primitive set bound to a workflow runtime context.
 */
export function createPrimitives(ctx: WorkflowRuntimeContext): {
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>
  parallel: <T>(items: Array<() => Promise<T>>) => Promise<Array<T>>
  pipeline: <T>(items: T[], ...stages: Array<(prev: T, original: T, index: number) => Promise<T>>) => Promise<Array<T>>
  phase: (title: string) => void
  log: (...args: unknown[]) => void
  budget: {
    total: number | null
    remaining: () => number
    spent: () => number
  }
  workflow: (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>
  resolveWorkflow: (name: string) => string | null
} {
  const concurrency =
    ctx.tokenBudget && ctx.tokenBudget > 0
      ? Math.max(1, Math.floor(ctx.tokenBudget / 100_000))
      : WORKFLOW_DEFAULT_CONCURRENCY

  /**
   * agent(prompt, opts?) — spawn a subagent, drain to completion, return
   * its result (text, or structured_output if opts.schema given).
   */
  const agent = async (prompt: string, opts: AgentOpts = {}): Promise<unknown> => {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('agent() requires a non-empty string prompt')
    }
    // Lifetime cap check (runaway backstop).
    if (ctx.counters.agentCount >= WORKFLOW_AGENT_LIFETIME_CAP) {
      logEvent('tengu_workflow_agent_cap_exceeded', {
        agentCount: ctx.counters.agentCount,
      })
      throw new WorkflowAgentCapError(ctx.counters.agentCount)
    }
    // Budget cap check.
    if (
      ctx.tokenBudget != null &&
      ctx.tokenBudget > 0 &&
      ctx.counters.spentTokens >= ctx.tokenBudget
    ) {
      logEvent('tengu_workflow_budget_cap_exceeded', {
        spent: ctx.counters.spentTokens,
        budget: ctx.tokenBudget,
        agentCount: ctx.counters.agentCount,
      })
      throw new WorkflowBudgetExceededError(
        ctx.counters.spentTokens,
        ctx.tokenBudget,
      )
    }

    // Set phase if provided.
    if (opts.phase) {
      ctx.currentPhase = opts.phase
    }

    // Resume cache check.
    const key = computeAgentKey(prompt, opts as Record<string, unknown>)
    if (ctx.cachedResults?.has(key)) {
      logEvent('tengu_workflow_journal_started_hit_respawn', {
        attempts: 1,
      })
      return ctx.cachedResults.get(key)
    }

    // isolation:'remote' is not available in this build.
    if (opts.isolation === 'remote') {
      throw new Error(
        'agent({isolation:\'remote\'}) is not available in this build',
      )
    }

    // Append "started" marker to journal (for respawn detection).
    if (ctx.journal) {
      await ctx.journal
        .appendStarted(key, asAgentId(createAgentId('wf')).slice(0, 16) as string)
        .catch(() => {})
    }

    // Build the ephemeral AgentDefinition.
    const agentDef = {
      ...GENERAL_PURPOSE_AGENT,
      agentType: opts.label ? `wf-${opts.label}` : 'workflow-agent',
      ...(opts.effort ? { effort: opts.effort } : {}),
    }

    // Set up worktree isolation if requested.
    let worktreePath: string | undefined
    if (opts.isolation === 'worktree') {
      const slug = `wf-${ctx.runId.slice(3, 11)}`
      try {
        const wt = await createAgentWorktree(slug)
        worktreePath = wt.worktreePath
      } catch (e) {
        // Fall back to no worktree if creation fails (not in a git repo, etc.)
        ctx.counters.logs.push(
          `Warning: worktree isolation failed: ${(e as Error).message}`,
        )
      }
    }

    // Build prompt messages. If schema is given, add a nudge to call
    // StructuredOutput.
    const effectivePrompt = opts.schema
      ? `${prompt}\n\nYou MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once at the end of your response to provide your structured output matching this schema: ${JSON.stringify(opts.schema)}`
      : prompt

    const promptMessages = [
      createUserMessage({
        content: effectivePrompt,
      }),
    ]

    // Track tokens for budget.
    let agentTokens = 0
    const onQueryProgress = (): void => {
      // Liveness callback — no-op (budget tracked post-completion).
    }

    // Spawn the subagent via runAgent and drain to completion.
    const agentId = createAgentId('wf')
    const agentShortId = agentId.slice(0, 16)
    const agentLabel = opts.label ?? prompt.slice(0, 80)
    const gen = runAgent({
      agentDefinition: agentDef,
      promptMessages: promptMessages as unknown as Parameters<typeof runAgent>[0]['promptMessages'],
      toolUseContext: ctx.toolUseContext,
      canUseTool: ctx.canUseTool,
      isAsync: false,
      canShowPermissionPrompts: false,
      querySource: 'workflow' as never,
      model: opts.model as never,
      subagentDepth: (ctx.toolUseContext.subagentDepth ?? 0) + 1,
      maxTurns: opts.schema ? 30 : undefined,
      availableTools: ctx.availableTools,
      // Don't restrict allowedTools — inherit parent rules so the agent can
      // use the full tool pool (Bash, Read, etc.). StructuredOutput is
      // already in the pool in non-interactive mode.
      worktreePath,
      description: opts.label ?? prompt.slice(0, 80),
      transcriptSubdir: `workflows/${ctx.runId}`,
      onQueryProgress,
      override: { agentId: agentId as AgentId },
    })

    // Emit workflow_agent_started BEFORE drain so the live tree shows the
    // agent as "running" immediately (binary: narrator line + phase group
    // populate before the agent finishes). Includes id/label/phase/agentType.
    // Capture the wall-clock start + resolved model for the /workflows agent
    // list's dedicated time column and short model-name column.
    const agentStartTime = Date.now()
    const agentModel = (opts.model as string | undefined) ?? getMainLoopModel()
    // 2.1.202: tag agent-spawn telemetry with the workflow run so its
    // activity can be reconstructed from OTel data (sink is stubbed in OCC).
    logEvent('tengu_workflow_agent_started', {
      ...workflowAgentTelemetryAttributes(ctx.runId, ctx.workflowName),
      agent_id: agentShortId,
      phase: ctx.currentPhase,
      model: agentModel,
    })
    ctx.onProgress?.({
      type: 'workflow_agent_started',
      id: agentShortId,
      label: agentLabel,
      phase: ctx.currentPhase,
      agentType: agentDef.agentType,
      model: agentModel,
      startTime: agentStartTime,
    })

    let messages: Message[]
    try {
      messages = await drainGenerator(gen)
    } catch (e) {
      // Record failure but rethrow — the workflow script decides how to handle.
      const msg = `Agent "${opts.label ?? prompt.slice(0, 40)}" failed: ${(e as Error).message}`
      ctx.counters.failures.push(msg)
      // Emit workflow_agent_completed with status:'error' so the tree
      // transitions running→error (binary includes id/label/status).
      logEvent('tengu_workflow_agent_completed', {
        ...workflowAgentTelemetryAttributes(ctx.runId, ctx.workflowName),
        agent_id: agentShortId,
        status: 'error',
        elapsed_ms: Math.max(0, Date.now() - agentStartTime),
      })
      ctx.onProgress?.({
        type: 'workflow_agent_completed',
        id: agentShortId,
        label: agentLabel,
        phase: ctx.currentPhase,
        agentType: agentDef.agentType,
        status: 'error',
        agentCount: ctx.counters.agentCount,
        tokens: 0,
        toolUseCount: 0,
        latestInputTokens: 0,
        cumulativeOutputTokens: 0,
        recentActivities: [],
        lastActivity: `Error: ${(e as Error).message.slice(0, 100)}`,
        model: agentModel,
        startTime: agentStartTime,
        elapsedMs: Math.max(0, Date.now() - agentStartTime),
      })
      throw e
    }

    // Track tokens.
    agentTokens = extractTokenUsage(messages)
    ctx.counters.spentTokens += agentTokens

    // Extract per-agent stats for the rich workflow_agent_completed emit.
    const tokenBreakdown = extractTokenBreakdown(messages)
    const toolUseStats = extractToolUseStats(messages)

    // Extract result.
    let result: unknown
    if (opts.schema) {
      const structured = extractStructuredOutput(messages)
      if (structured) {
        result = structured
      } else {
        // Retry once with a stronger nudge if StructuredOutput wasn't called.
        ctx.counters.logs.push(
          `Warning: agent(${opts.label ? `"${opts.label}"` : 'schema'}) did not call StructuredOutput; returning text result.`,
        )
        result = extractAgentTextResult(messages)
      }
    } else {
      result = extractAgentTextResult(messages)
    }

    // Append "result" to journal for resume cache.
    if (ctx.journal) {
      await ctx.journal
        .appendResult(key, agentId.slice(0, 16), result, agentTokens)
        .catch(() => {})
    }

    // Increment agent count.
    ctx.counters.agentCount++

    // Update phase progress.
    if (ctx.currentPhase) {
      let entry = ctx.workflowProgress.find(
        p => p.phase === ctx.currentPhase,
      )
      if (!entry) {
        entry = {
          phase: ctx.currentPhase,
          completedAgents: 0,
          totalAgents: 0,
          agentCount: 0,
          agents: [],
        }
        ctx.workflowProgress.push(entry)
      }
      entry.completedAgents++
      entry.agentCount = ctx.counters.agentCount
    }

    // Fire progress. Rich payload mirrors the binary's workflow_agent_completed:
    // includes id/label/status so the live tree transitions running→done, plus
    // toolUseCount + token breakdown (latestInputTokens/cumulativeOutputTokens)
    // + recentActivities for the per-agent row.
    logEvent('tengu_workflow_agent_completed', {
      ...workflowAgentTelemetryAttributes(ctx.runId, ctx.workflowName),
      agent_id: agentShortId,
      status: 'done',
      tokens: agentTokens,
      tool_use_count: toolUseStats.toolUseCount,
      elapsed_ms: Math.max(0, Date.now() - agentStartTime),
    })
    ctx.onProgress?.({
      type: 'workflow_agent_completed',
      id: agentShortId,
      label: agentLabel,
      phase: ctx.currentPhase,
      agentType: agentDef.agentType,
      status: 'done',
      agentCount: ctx.counters.agentCount,
      tokens: agentTokens,
      toolUseCount: toolUseStats.toolUseCount,
      latestInputTokens: tokenBreakdown.latestInputTokens,
      cumulativeOutputTokens: tokenBreakdown.cumulativeOutputTokens,
      recentActivities: toolUseStats.recentActivities,
      lastActivity: toolUseStats.lastActivity,
      model: agentModel,
      startTime: agentStartTime,
      elapsedMs: Math.max(0, Date.now() - agentStartTime),
    })

    return result
  }

  /**
   * parallel(items) — concurrent execution with ~10 cap, 4096 max.
   * Returns results array (preserve order). Budget/cap errors per-branch
   * return null (matching the binary: results preserved, branch halted).
   */
  const parallel = async <T>(
    items: Array<() => Promise<T>>,
  ): Promise<Array<T>> => {
    if (!Array.isArray(items)) {
      throw new Error('parallel() requires an array of thunks')
    }
    if (items.length > WORKFLOW_PARALLEL_MAX_ITEMS) {
      throw new Error(
        `parallel() accepts at most ${WORKFLOW_PARALLEL_MAX_ITEMS} items; ` +
          `got ${items.length}`,
      )
    }
    const sem = createSemaphore(concurrency)
    const settled = await Promise.allSettled(
      items.map(thunk => sem(() => thunk())),
    )
    const results: T[] = []
    let budgetHits = 0
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value as T)
      } else {
        // Budget/cap errors are swallowed per-branch (return null).
        if (isWorkflowCapError(s.reason)) {
          budgetHits++
          results.push(null as T)
        } else {
          // Other errors: record + push null (don't abort the whole parallel).
          const msg = `parallel branch failed: ${(s.reason as Error)?.message ?? String(s.reason)}`
          ctx.counters.failures.push(msg)
          results.push(null as T)
        }
      }
    }
    if (budgetHits > 0) {
      ctx.counters.logs.push(
        `parallel: ${budgetHits} branch(es) halted due to budget/cap exhaustion`,
      )
    }
    return results
  }

  /**
   * pipeline(items, ...stages) — stream items through stage chain.
   * No barrier between stages; each item flows independently through all
   * stages. stage fns receive (prevResult, originalItem, index).
   */
  const pipeline = async <T>(
    items: T[],
    ...stages: Array<(prev: T, original: T, index: number) => Promise<T>>
  ): Promise<Array<T>> => {
    if (!Array.isArray(items)) {
      throw new Error('pipeline() requires an array of items')
    }
    if (items.length > WORKFLOW_PARALLEL_MAX_ITEMS) {
      throw new Error(
        `pipeline() accepts at most ${WORKFLOW_PARALLEL_MAX_ITEMS} items; ` +
          `got ${items.length}`,
      )
    }
    for (let i = 0; i < stages.length; i++) {
      if (typeof stages[i] !== 'function') {
        throw new Error(
          `pipeline() stages must be functions: pipeline(items, item => ..., result => ...)`,
        )
      }
    }
    if (stages.length === 0) {
      return items
    }
    const sem = createSemaphore(concurrency)
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        return sem(async () => {
          let prev: T = item
          for (const stage of stages) {
            prev = await stage(prev, item, index)
          }
          return prev
        })
      }),
    )
    const results: T[] = []
    let budgetHits = 0
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value as T)
      } else {
        if (isWorkflowCapError(s.reason)) {
          budgetHits++
          results.push(null as T)
        } else {
          const msg = `pipeline branch failed: ${(s.reason as Error)?.message ?? String(s.reason)}`
          ctx.counters.failures.push(msg)
          results.push(null as T)
        }
      }
    }
    if (budgetHits > 0) {
      ctx.counters.logs.push(
        `pipeline: ${budgetHits} branch(es) halted due to budget/cap exhaustion`,
      )
    }
    return results
  }

  /**
   * phase(title) — start a new phase; subsequent agent() calls are grouped.
   */
  const phase = (title: string): void => {
    if (typeof title !== 'string') {
      throw new Error('phase() requires a string title')
    }
    ctx.currentPhase = title
    // Push a new progress entry per phase() call (binary: "entry per phase() call").
    ctx.workflowProgress.push({
      phase: title,
      completedAgents: 0,
      totalAgents: 0,
      agentCount: ctx.counters.agentCount,
      agents: [],
    })
    logEvent('tengu_workflow_phase_started', {
      workflow_run_id: ctx.runId,
      workflow_phase: title,
    })
    ctx.onProgress?.({
      type: 'workflow_phase',
      phase: title,
      agentCount: ctx.counters.agentCount,
    })
  }

  /**
   * log(...args) — append to workflow-scoped logs + emit a workflow_log
   * narrator event (binary: "shown as a narrator line above the progress tree").
   */
  const log = (...args: unknown[]): void => {
    const msg = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    ctx.counters.logs.push(msg)
    // Emit workflow_log so the live tree renders the narrator line.
    ctx.onProgress?.({
      type: 'workflow_log',
      line: msg,
    })
  }

  /**
   * budget — {total, remaining(), spent()}.
   */
  const budget = {
    get total(): number | null {
      return ctx.tokenBudget ?? null
    },
    remaining(): number {
      if (ctx.tokenBudget == null || ctx.tokenBudget <= 0) return Infinity
      return Math.max(0, ctx.tokenBudget - ctx.counters.spentTokens)
    },
    spent(): number {
      return ctx.counters.spentTokens
    },
  }

  /**
   * workflow(nameOrRef, args?) — resolve + run a named/sub workflow.
   * "workflow() expects a workflow name (string) or {scriptPath: string}".
   * Re-runs the named workflow via the engine (recursively).
   */
  const workflow = async (
    nameOrRef: string | { scriptPath: string },
    _args?: unknown,
  ): Promise<unknown> => {
    let scriptPath: string | null
    if (typeof nameOrRef === 'string') {
      scriptPath = ctx.resolveWorkflowScript?.(nameOrRef) ?? null
      if (!scriptPath) {
        throw new Error(`workflow() could not resolve workflow "${nameOrRef}"`)
      }
    } else if (nameOrRef && typeof nameOrRef === 'object' && 'scriptPath' in nameOrRef) {
      scriptPath = (nameOrRef as { scriptPath: string }).scriptPath
    } else {
      throw new Error(
        'workflow() expects a workflow name (string) or {scriptPath: string}',
      )
    }
    // Lazy-load the engine to avoid circular import.
    const { runWorkflow } = await import('./WorkflowEngine.js')
    const { loadScript } = await import('./scriptLoader.js')
    const loaded = loadScript(scriptPath)
    const result = await runWorkflow({
      script: loaded.source,
      scriptPath: loaded.scriptPath,
      meta: loaded.meta,
      body: loaded.body,
      hasDefaultExport: loaded.hasDefaultExport,
      defaultExportExpr: loaded.defaultExportExpr,
      args: _args,
      runId: ctx.runId + '_sub',
      toolUseContext: ctx.toolUseContext,
      canUseTool: ctx.canUseTool,
      onProgress: ctx.onProgress,
    })
    return result.result
  }

  /**
   * resolveWorkflow(name) — resolve a named workflow to its scriptPath.
   */
  const resolveWorkflow = (name: string): string | null => {
    return ctx.resolveWorkflowScript?.(name) ?? null
  }

  return {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    budget,
    workflow,
    resolveWorkflow,
  }
}

/**
 * Build the primitives object that gets passed to the script's default
 * export function (when hasDefaultExport). This is the destructured arg
 * `{ agent, parallel, ... }`.
 */
export function buildPrimitivesObject(ctx: WorkflowRuntimeContext): Record<
  string,
  unknown
> {
  const p = createPrimitives(ctx)
  return {
    agent: p.agent,
    parallel: p.parallel,
    pipeline: p.pipeline,
    phase: p.phase,
    log: p.log,
    budget: p.budget,
    workflow: p.workflow,
    resolveWorkflow: p.resolveWorkflow,
  }
}
