/**
 * K3 (2.1.154): The Workflow tool — runs a self-contained workflow script
 * in a sandboxed vm with agent/parallel/pipeline/phase/log/budget primitives.
 *
 * Mirrors the 2.1.200 binary's tool definition (OQt):
 *   name: "Workflow"
 *   inputSchema: { scriptPath, args?, resumeFromRunId?, name?, remote? }
 *   call(): loads the script (scriptLoader), runs the engine (runWorkflow),
 *   returns { result, agentCount, logs, failures, durationMs }.
 *
 * The tool is gated behind feature('WORKFLOW_SCRIPTS') in src/tools.ts
 * (adding it to FEATURE_ALLOWLIST in featureFlags.ts un-gates it).
 *
 * Script format (ESM):
 *   export const meta = { name, description, phases };
 *   export default async ({ agent, parallel, pipeline, phase, log, budget,
 *     workflow, resolveWorkflow, args }) => { ... return result; };
 *   // OR top-level:
 *   const r = await agent('hi');
 *   return r;
 */
import { z } from 'zod/v4'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../types/permissions.js'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { logEvent } from '../../services/analytics/index.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { loadScript, validateScriptPath } from './scriptLoader.js'
import {
  runWorkflow,
  generateWorkflowRunId,
  isValidWorkflowRunId,
} from './WorkflowEngine.js'
import { WorkflowJournal } from './journal.js'
import { resolveWorkflowScript } from '../../utils/effort/workflowDiscovery.js'
import { WorkflowProgressTree } from '../../components/WorkflowProgressTree.js'
import {
  registerWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
  type WorkflowPhaseProgress,
  type WorkflowAgentStat,
  type WorkflowProgressData,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { writeWorkflowProgress } from '../../utils/wfProgress.js'

const inputSchema = lazySchema(() =>
  z.object({
    scriptPath: z
      .string()
      .optional()
      .describe(
        'Absolute path to a self-contained workflow script (.js). The script must begin with `export const meta = { name, description, phases }` and export a default async function receiving { agent, parallel, pipeline, phase, log, budget, workflow, resolveWorkflow, args }. Optional if `name` is provided.',
      ),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arguments object passed to the workflow as `args`.'),
    resumeFromRunId: z
      .string()
      .regex(/^wf_[a-z0-9-]{6,}$/)
      .optional()
      .describe(
        'Resume a previous workflow run by its run ID (wf_...). Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run.',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.',
      ),
    remote: z
      .boolean()
      .optional()
      .describe(
        'Launch the workflow asynchronously in-process (background promise). The tool returns immediately with a "started" status; progress is written to a file (~/.claude/wf-progress/<runId>.json) that the REPL polls from the main thread, so /workflows shows the running + completed workflow. This is the safe async path: the background runWorkflow uses a NO-OP setAppState (prevents Ink cross-root flushSync crash); the main-thread poller reads the progress file and updates AppState safely. The inline (non-remote) path runs in-process for instant live progress.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    result: z.unknown(),
    message: z.string().optional(),
    agentCount: z.number(),
    logs: z.array(z.string()),
    failures: z.array(z.string()),
    durationMs: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

const DESCRIPTION = `Run a multi-step workflow from a self-contained JavaScript script. The script runs in a sandboxed vm with access to primitives: agent(prompt, opts?) to spawn a subagent, parallel(items) for concurrent execution (max 4096 items, ~10 concurrent), pipeline(items, ...stages) for streaming, phase(title) to group agents, log(...args) for workflow-scoped logging, budget {total, remaining(), spent()} for token caps, and workflow(nameOrRef) / resolveWorkflow(name) for sub-workflows. Scripts are deterministic for resume (no Date/Math.random/import). Use the Workflow tool on substantive multi-agent tasks.`

/** Shape of a raw progress event emitted by the workflow engine. */
type WorkflowProgressEvent = {
  type?: string
  phase?: string
  id?: string
  label?: string
  agentType?: string
  status?: 'running' | 'done' | 'error'
  agentCount?: number
  tokens?: number
  toolUseCount?: number
  latestInputTokens?: number
  cumulativeOutputTokens?: number
  recentActivities?: WorkflowAgentStat['recentActivities']
  lastActivity?: string
  line?: string
}

/** A full progress snapshot — the output of the accumulator factory. */
type WorkflowProgressSnapshot = {
  type: 'workflow_progress'
  phases: WorkflowPhaseProgress[]
  narratorLines: string[]
  agentCount: number
  runId: string
}

/**
 * Build a progress handler that accumulates engine events into phase/agent
 * state and emits a full snapshot via `emit`. Shared by the inline path
 * (emit → updateWorkflowProgressBatch + onProgress) and the background path
 * (emit → writeWorkflowProgress file). The optional `onAgentEvent` callback
 * is invoked for agent start/complete events — used by the background path
 * to write subagent-level records for fleet visibility.
 *
 * This eliminates the triplication between the inline handler, the background
 * handler, and the daemon-worker's buildProgressHandler (which remains as a
 * fallback for the separate-process path).
 */
function buildWorkflowProgressHandler(
  runId: string,
  seedPhases: WorkflowPhaseProgress[],
  emit: (snapshot: WorkflowProgressSnapshot) => void,
  onAgentEvent?: (ev: WorkflowProgressEvent) => void,
): (data: unknown) => void {
  const phases: WorkflowPhaseProgress[] = seedPhases.map(p => ({
    ...p,
    agents: [],
  }))
  const narratorLines: string[] = []

  const getOrCreatePhase = (title: string): WorkflowPhaseProgress => {
    let entry = phases.find(p => p.phase === title)
    if (!entry) {
      entry = {
        phase: title,
        completedAgents: 0,
        totalAgents: 0,
        agentCount: 0,
        agents: [],
      }
      phases.push(entry)
    }
    return entry
  }

  return (data: unknown): void => {
    const ev = data as WorkflowProgressEvent
    logEvent('tengu_workflow_progress', {
      workflow_run_id: runId,
      data_type: ev?.type ?? 'unknown',
    })

    const phaseTitle = ev?.phase ?? ''

    switch (ev?.type) {
      case 'workflow_phase': {
        const entry = getOrCreatePhase(phaseTitle)
        entry.agentCount = ev.agentCount ?? entry.agentCount
        break
      }
      case 'workflow_agent_started': {
        const entry = getOrCreatePhase(phaseTitle)
        if (ev.id && !entry.agents.find(a => a.id === ev.id)) {
          entry.agents.push({
            id: ev.id,
            label: ev.label ?? '',
            agentType: ev.agentType ?? 'workflow-agent',
            status: 'running',
            toolUseCount: 0,
            latestInputTokens: 0,
            cumulativeOutputTokens: 0,
            recentActivities: [],
            lastActivity: undefined,
            isResolved: false,
            isError: false,
          })
        }
        break
      }
      case 'workflow_agent_completed': {
        const entry = getOrCreatePhase(phaseTitle)
        let agent = ev.id ? entry.agents.find(a => a.id === ev.id) : undefined
        if (!agent) {
          agent = {
            id: ev.id ?? '',
            label: ev.label ?? '',
            agentType: ev.agentType ?? 'workflow-agent',
            status: 'running',
            toolUseCount: 0,
            latestInputTokens: 0,
            cumulativeOutputTokens: 0,
            recentActivities: [],
            lastActivity: undefined,
            isResolved: false,
            isError: false,
          }
          entry.agents.push(agent)
        }
        agent.status = ev.status ?? 'done'
        agent.toolUseCount = ev.toolUseCount ?? 0
        agent.latestInputTokens = ev.latestInputTokens ?? 0
        agent.cumulativeOutputTokens = ev.cumulativeOutputTokens ?? 0
        agent.recentActivities = ev.recentActivities ?? []
        agent.lastActivity = ev.lastActivity
        agent.isResolved = agent.status === 'done'
        agent.isError = agent.status === 'error'
        if (agent.status === 'done') {
          entry.completedAgents++
        }
        entry.agentCount = ev.agentCount ?? entry.agentCount
        break
      }
      case 'workflow_log': {
        if (ev.line) narratorLines.push(ev.line)
        break
      }
    }

    // Subagent-level callback (background path writes fleet-visibility records).
    if (
      onAgentEvent &&
      ev.id &&
      (ev.type === 'workflow_agent_started' || ev.type === 'workflow_agent_completed')
    ) {
      onAgentEvent(ev)
    }

    emit({
      type: 'workflow_progress',
      phases: phases.map(p => ({ ...p, agents: [...p.agents] })),
      narratorLines: [...narratorLines],
      agentCount: phases.reduce((s, p) => s + p.agentCount, 0),
      runId,
    })
  }
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'run a multi-agent workflow from a script',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return `Use this tool to run a workflow script. The script must start with \`export const meta = { name, description, phases }\` and export a default async function: \`export default async ({ agent, parallel, pipeline, phase, log, budget, workflow, resolveWorkflow, args }) => { ... }\`.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Workflow'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isOpenWorld() {
    return true
  },
  renderToolUseMessage(input: Record<string, unknown>) {
    const name = input.name ?? input.scriptPath
    return typeof name === 'string' ? `Workflow(${name})` : null
  },
  /**
   * Live progress renderer — mounts <WorkflowProgressTree> while call() runs.
   * Reads the latest WorkflowProgressData snapshot from the progress message
   * stream (emitted by the onProgress handler in call()). Mirrors the
   * AgentTool/UI.tsx renderToolUseProgressMessage pattern. Uses
   * React.createElement because this file is .ts (no JSX literals).
   */
  renderToolUseProgressMessage(
    progressMessagesForMessage: Array<{ data?: unknown }>,
    options: {
      tools: unknown
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
): React.ReactNode {
    // Find the latest workflow_progress snapshot in the stream.
    let latest: WorkflowProgressData | undefined
    for (let i = progressMessagesForMessage.length - 1; i >= 0; i--) {
      const data = progressMessagesForMessage[i]?.data as
        | WorkflowProgressData
        | undefined
      if (data && data.type === 'workflow_progress') {
        latest = data
        break
      }
    }
    if (!latest) {
      return React.createElement(
        Box,
        { height: 1 },
        React.createElement(Text, { dimColor: true }, 'Running workflow…'),
      )
    }
    return React.createElement(WorkflowProgressTree, {
      phases: latest.phases,
      narratorLines: latest.narratorLines,
      shouldAnimate: true,
      viewportRows: options.terminalSize?.rows ?? 10,
    })
  },
  async checkPermissions(
    input: { scriptPath?: string; name?: string; remote?: boolean } & {
      [key: string]: unknown
    },
  ): Promise<PermissionResult> {
    // Remote (async) launch is allowed: it runs runWorkflow in a background
    // promise with a NO-OP setAppState (no Ink renderer reachable), so it
    // cannot crash the main OCC. The user pre-approves the workflow launch
    // by invoking the tool.
    return { behavior: 'allow', updatedInput: input }
  },
  mapToolResultToToolResultBlockParam(
    data: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // Serialize the workflow result for the model. Include the result, agent
    // count, failures, and duration. Keep logs out of the model-facing block
    // unless there were failures (logs can be large; failures are actionable).
    const { result, agentCount, logs, failures, durationMs } = data
    const parts: Array<{ type: 'text'; text: string }> = []
    const failSummary =
      failures.length > 0
        ? `\n\nFailures (${failures.length}):\n${failures.map(f => `- ${f}`).join('\n')}`
        : ''
    const logSummary =
      logs.length > 0
        ? `\n\nLogs:\n${logs.map(l => `- ${l}`).join('\n')}`
        : ''
    parts.push({
      type: 'text',
      text: `Workflow completed in ${durationMs}ms with ${agentCount} agent(s).${failSummary}${logSummary}\n\nResult:\n${
        typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2)
      }`,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: parts,
    }
  },
  async call(input, context, canUseTool, _parentMessage, onProgress) {
    const { scriptPath: rawScriptPath, args, resumeFromRunId, name, remote } = input as {
      scriptPath?: string
      args?: Record<string, unknown>
      resumeFromRunId?: string
      name?: string
      remote?: boolean
    }

    // Resolve the script path: by name (discovery) or by path.
    let resolvedScriptPath: string
    if (name) {
      const found = resolveWorkflowScript(name)
      if (!found) {
        throw new Error(
          `Workflow tool: could not resolve workflow "${name}". Add scripts to .claude/workflows/ (project) or ~/.claude/workflows/ (user).`,
        )
      }
      resolvedScriptPath = found
    } else if (rawScriptPath) {
      resolvedScriptPath = validateScriptPath(rawScriptPath)
    } else {
      throw new Error(
        'Workflow tool requires either `scriptPath` or `name`.',
      )
    }

    // Load + parse the script.
    const loaded = loadScript(resolvedScriptPath)

    // Determine run ID.
    let runId: string
    if (resumeFromRunId) {
      if (!isValidWorkflowRunId(resumeFromRunId)) {
        throw new Error(
          `Workflow tool: invalid resumeFromRunId "${resumeFromRunId}". Must match /^wf_[a-z0-9-]{6,}$/.`,
        )
      }
      runId = resumeFromRunId
      // Resume guard: check if a run with this ID is still running.
      const appState = context.getAppState()
      const tasks = appState.tasks ?? {}
      for (const task of Object.values(tasks)) {
        if (
          task &&
          task.type === 'local_workflow' &&
          task.status === 'running' &&
          'workflowRunId' in task &&
          task.workflowRunId === runId
        ) {
          return {
            data: {
              result: false,
              message: `Workflow ${runId} is still running (task ${task.id}). Wait for it to complete before resuming.`,
              agentCount: 0,
              logs: [],
              failures: [],
              durationMs: 0,
            } as Output,
          }
        }
      }
    } else {
      runId = generateWorkflowRunId()
    }

    // Set up journal for resume (if transcriptDir available).
    let journal: WorkflowJournal | undefined
    let cachedResults: Map<string, unknown> | undefined
    let transcriptDir = ''
    try {
      const { getTaskOutputDir } = await import(
        '../../utils/task/diskOutput.js'
      )
      const { join } = await import('path')
      transcriptDir = join(
        getTaskOutputDir(),
        'wf-runs',
        runId,
      )
      const { mkdir } = await import('fs/promises')
      await mkdir(transcriptDir, { recursive: true })
      journal = new WorkflowJournal(transcriptDir)
      if (resumeFromRunId) {
        cachedResults = await journal.load()
      }
    } catch (e) {
      // Journal setup failure is non-fatal — run without resume cache.
      logEvent('tengu_workflow_journal_setup_failed', {
        run_id: runId,
        error: (e as Error).message.slice(0, 100),
      })
    }

    // Register a local_workflow task at call() start so /workflows populates
    // and the live progress tree can read task state. Mirrors binary
    // registerWorkflowTask (line 472281). Seed phases from meta.phases.
    const taskId = `wf_task_${runId}`
    const seedPhases: WorkflowPhaseProgress[] = (loaded.meta.phases ?? []).map(
      p => ({
        phase: p,
        completedAgents: 0,
        totalAgents: 0,
        agentCount: 0,
        agents: [],
      }),
    )
    const initialState: LocalWorkflowTaskState = {
      id: taskId,
      type: 'local_workflow',
      status: 'running',
      description: loaded.meta.description ?? loaded.meta.name ?? runId,
      toolUseId: context.toolUseId,
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      workflowRunId: runId,
      transcriptDir,
      scriptPath: loaded.scriptPath,
      workflowName: loaded.meta.name,
      summary: loaded.meta.description,
      phases: loaded.meta.phases,
      workflowProgress: seedPhases,
      narratorLines: [],
      logs: [],
    }
    registerWorkflowTask(initialState, context.setAppState)

    // Async (remote) launch: run runWorkflow in a BACKGROUND PROMISE
    // (in-process, NOT a separate daemon-worker process) with a NO-OP
    // setAppState. This is the safe async path:
    //   - The background context's setAppState AND setAppStateForTasks are
    //     NO-OPs, so NO state update from the background promise can reach
    //     the Ink store → no cross-root flushSyncWork crash.
    //   - Progress is written to ~/.claude/wf-progress/<runId>.json (a FILE,
    //     not setAppState). A main-thread poller (useWorkflowProgressPoller)
    //     reads the file and updates this task's state safely from the main
    //     thread.
    //   - On completion/failure, completeWorkflowTask/failWorkflowTask are
    //     called via setTimeout(0) using the MAIN THREAD's setAppState (safe —
    //     fires on the next tick, not during a render).
    // We register the task above (running) so /workflows populates immediately,
    // then return "started" without awaiting runWorkflow.
    if (remote) {
      // Create a background context with NO-OP setAppState — prevents Ink crash.
      // createSubagentContext (without shareSetAppState) already makes
      // setAppState a NO-OP, but setAppStateForTasks still reaches the root
      // store. We explicitly NO-OP both so NO state update from the background
      // promise can reach a React reconciler.
      const bgContext = createSubagentContext(context)
      const noop = () => {}
      bgContext.setAppState = noop
      bgContext.setAppStateForTasks = noop

      // Build a file-writing progress handler. Emits snapshots to the
      // wf-progress file (NOT setAppState). Also writes subagent-level
      // records for fleet visibility (the poller creates local_agent tasks).
      const handleBgProgress = buildWorkflowProgressHandler(
        runId,
        seedPhases,
        (snap) => {
          writeWorkflowProgress(runId, {
            ...snap,
            status: 'running',
            workflowName: loaded.meta.name,
            scriptPath: loaded.scriptPath,
            transcriptDir,
          })
        },
        (ev) => {
          // Subagent-level records for fleet visibility.
          if (ev.status === 'running' && ev.id) {
            writeWorkflowProgress(`${runId}.sub.${ev.id}`, {
              type: 'subagent_spawn',
              subagentId: ev.id,
              name: ev.label,
              agentType: ev.agentType,
              status: 'running',
              startedAt: Date.now(),
              runId,
            })
          } else if ((ev.status === 'done' || ev.status === 'error') && ev.id) {
            writeWorkflowProgress(`${runId}.sub.${ev.id}`, {
              type: 'subagent_done',
              subagentId: ev.id,
              status: ev.status,
              tokens: ev.cumulativeOutputTokens,
              runId,
            })
          }
        },
      )

      // Initial 'running' snapshot so the poller sees the run immediately.
      writeWorkflowProgress(runId, {
        type: 'workflow_progress',
        phases: seedPhases.map(p => ({
          phase: p.phase,
          completedAgents: 0,
          totalAgents: 0,
          agentCount: 0,
          agents: [],
        })),
        narratorLines: [],
        agentCount: 0,
        status: 'running',
        workflowName: loaded.meta.name,
        scriptPath: loaded.scriptPath,
        transcriptDir,
      })

      logEvent('tengu_workflow_launched', {
        invocation_mode: 'in_process_async',
        workflow_run_id: runId,
        workflow_name: loaded.meta.name,
        workflow_description: loaded.meta.description,
        is_resume: !!resumeFromRunId,
      })

      // Launch in-process (background promise, NOT awaited). The workflow
      // runs with the NO-OP bgContext; progress goes to the file. On
      // completion/failure, we write a terminal snapshot to the file AND
      // call complete/fail via setTimeout(0) on the MAIN THREAD's setAppState.
      void (async () => {
        try {
          const r = await runWorkflow({
            script: loaded.source,
            scriptPath: loaded.scriptPath,
            meta: loaded.meta,
            body: loaded.body,
            hasDefaultExport: loaded.hasDefaultExport,
            defaultExportExpr: loaded.defaultExportExpr,
            args,
            runId,
            toolUseContext: bgContext,
            canUseTool,
            onProgress: handleBgProgress,
            journal,
            cachedResults,
          })
          // Write terminal snapshot for the poller (debugging + file cleanup).
          writeWorkflowProgress(runId, {
            type: 'workflow_completed',
            status: 'completed',
            result: r.result,
            agentCount: r.agentCount,
            logs: r.logs,
            failures: r.failures,
            durationMs: r.durationMs,
            phases: [],
            narratorLines: [],
          })
          // Complete the task via the MAIN THREAD's setAppState. setTimeout(0)
          // ensures it fires on the next tick, not during a render cycle.
          // The poller's terminal-snapshot handler checks the current task
          // status before calling complete (avoids double-completion race).
          setTimeout(
            () => completeWorkflowTask(taskId, context.setAppState, r.result),
            0,
          )
        } catch (e) {
          const errMsg = (e as Error).message
          writeWorkflowProgress(runId, {
            type: 'workflow_failed',
            status: 'failed',
            error: errMsg,
          })
          setTimeout(
            () => failWorkflowTask(taskId, e as Error, context.setAppState),
            0,
          )
        }
      })()

      return {
        data: {
          result: 'started',
          message: `Workflow ${runId} started in background. Use /workflows to browse progress; the task notification fires on completion.`,
          agentCount: 0,
          logs: [],
          failures: [],
          durationMs: 0,
        } as Output,
      }
    }

    // Inline progress handler: emits snapshots via both
    // updateWorkflowProgressBatch (for /workflows view) and onProgress
    // (for the live tree renderer). Uses the shared factory to avoid
    // duplicating the phase/agent accumulation logic.
    const handleProgress = buildWorkflowProgressHandler(
      runId,
      seedPhases,
      (snap) => {
        updateWorkflowProgressBatch(
          taskId,
          snap.phases,
          snap.narratorLines,
          context.setAppState,
        )
        onProgress?.({
          toolUseID: context.toolUseId ?? '',
          data: snap satisfies WorkflowProgressData,
        })
      },
    )

    logEvent('tengu_workflow_launched', {
      invocation_mode: resumeFromRunId ? 'resume' : 'inline',
      workflow_run_id: runId,
      workflow_name: loaded.meta.name,
      workflow_description: loaded.meta.description,
      is_resume: !!resumeFromRunId,
    })

    // Run the workflow INLINE (await). The official launches async via a remote
    // CCR (separate process); OCC's async path is the `remote: true` branch
    // above (in-process background promise + NO-OP setAppState + progress file
    // + poller). This inline path runs in-process for instant live progress
    // (the handleProgress emit goes directly to setAppState + onProgress).
    let runResult
    try {
      runResult = await runWorkflow({
        script: loaded.source,
        scriptPath: loaded.scriptPath,
        meta: loaded.meta,
        body: loaded.body,
        hasDefaultExport: loaded.hasDefaultExport,
        defaultExportExpr: loaded.defaultExportExpr,
        args,
        runId,
        toolUseContext: context,
        canUseTool,
        onProgress: handleProgress,
        journal,
        cachedResults,
      })
    } catch (e) {
      failWorkflowTask(taskId, e as Error, context.setAppState)
      throw e
    }

    completeWorkflowTask(taskId, context.setAppState, runResult.result)

    return {
      data: {
        result: runResult.result,
        agentCount: runResult.agentCount,
        logs: runResult.logs,
        failures: runResult.failures,
        durationMs: runResult.durationMs,
      } as Output,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

export type { ToolDef }
