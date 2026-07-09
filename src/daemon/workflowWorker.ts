/**
 * runWorkflowWorker — the 'workflow' daemon-worker entry point.
 *
 * NOTE: As of the in-process async refactor, this is a FALLBACK path. The
 * primary async launch path is now in-process (WorkflowTool.ts `remote: true`
 * branch runs runWorkflow in a background promise with NO-OP setAppState +
 * progress file + poller). This daemon worker is retained for cases that need
 * true process isolation (e.g. if the in-process path is unstable or for
 * future separate-process fleet management). The worker can still be spawned
 * manually if needed, but WorkflowTool.call() no longer uses spawnWorker.
 *
 * Spawned by spawnWorker('workflow', { env, id: runId }). The worker is a
 * SEPARATE OCC process (same entrypoint cli.tsx → main.tsx fast-path →
 * runDaemonWorker), so it has NO Ink renderer and NO shared AppState store
 * with the main OCC.
 *
 * This is the crux of the async-launch safety model: the worker constructs a
 * NON-INTERACTIVE toolUseContext (mirroring mcp.ts) whose setAppState is a
 * NO-OP. runWorkflow's agent() primitive spawns subagents that SHARE this
 * no-op setAppState (createSubagentContext shareSetAppState:true). Because
 * setAppState is a no-op, NO state update can ever reach a React reconciler
 * → no cross-root flushSyncWork → no Ink crash. This is exactly why the
 * daemon-worker approach is safe where the in-process async approach crashes
 * (there the workflow's toolUseContext IS the REPL's, so shared setAppState
 * reaches the root Ink store).
 *
 * The worker's handleProgress writes progress snapshots (phases/agents/status)
 * to ~/.claude/wf-progress/<runId>.json (a FILE, not AppState). A MAIN-THREAD
 * poller in the REPL (useWorkflowProgressPoller) reads these files and updates
 * AppState from the main thread — safe.
 *
 * Params are passed via env vars (matches the existing
 * CLAUDE_CODE_DAEMON_WORKER_KIND pattern; the worker also inherits
 * ...process.env so ANTHROPIC_API_KEY / model env is present):
 *   CLAUDE_WORKFLOW_SCRIPT_PATH  — resolved absolute path to the script
 *   CLAUDE_WORKFLOW_ARGS         — JSON.stringify(args ?? {})
 *   CLAUDE_WORKFLOW_RUN_ID       — wf_<12-char>
 *   CLAUDE_WORKFLOW_NAME         — meta.name (for display)
 *   CLAUDE_WORKFLOW_RESUME_FROM  — resumeFromRunId (or empty)
 */
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../Tool.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { createAbortController } from '../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { loadScript } from '../tools/WorkflowTool/scriptLoader.js'
import {
  runWorkflow,
  isValidWorkflowRunId,
} from '../tools/WorkflowTool/WorkflowEngine.js'
import { WorkflowJournal } from '../tools/WorkflowTool/journal.js'
import { isPidAlive } from './process.js'
import { logEvent } from '../services/analytics/index.js'
import { writeWorkflowProgress } from '../utils/wfProgress.js'
import type {
  WorkflowPhaseProgress,
  WorkflowAgentStat,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/** Polling interval for the orphan watchdog (parent liveness). */
const ORPHAN_WATCH_INTERVAL_MS = 5000

/**
 * Build a non-interactive toolUseContext for the worker. Mirrors mcp.ts:112-134:
 * no-op setAppState (no shared store, no renderer reachable), non-interactive
 * session, disabled thinking, empty MCP. CRITICAL: the no-op setAppState is
 * what makes the cross-process approach crash-safe (see file header).
 */
function buildWorkerToolUseContext(): ToolUseContext {
  const readFileStateCache = createFileStateCacheWithSizeLimit(100)
  const toolPermissionContext = getEmptyToolPermissionContext()
  const tools = getTools(toolPermissionContext)
  return {
    abortController: createAbortController(),
    options: {
      commands: [],
      tools,
      mainLoopModel: getMainLoopModel(),
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    // NO-OP — no Ink store in the worker. This is the safety guarantee: no
    // setAppState call (from runWorkflow's agents or otherwise) can reach a
    // React reconciler, so no cross-root flushSyncWork crash.
    getAppState: () => getDefaultAppState(),
    setAppState: () => {},
    messages: [],
    readFileState: readFileStateCache,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}

/**
 * Build the progress handler. Mirrors WorkflowTool's handleProgress accumulator
 * (phases/narratorLines), but instead of calling updateWorkflowProgressBatch +
 * onProgress (which would touch AppState/the live tree), it writes a full
 * snapshot to the wf-progress file via writeWorkflowProgress. The REPL poller
 * reads this file from the main thread.
 */
function buildProgressHandler(runId: string, seedPhases: string[]): (data: unknown) => void {
  const phases: WorkflowPhaseProgress[] = seedPhases.map(p => ({
    phase: p,
    completedAgents: 0,
    totalAgents: 0,
    agentCount: 0,
    agents: [],
  }))
  const narratorLines: string[] = []

  const getOrCreatePhase = (title: string, ev: { agentCount?: number }): WorkflowPhaseProgress => {
    let entry = phases.find(p => p.phase === title)
    if (!entry) {
      entry = {
        phase: title,
        completedAgents: 0,
        totalAgents: 0,
        agentCount: ev.agentCount ?? 0,
        agents: [],
      }
      phases.push(entry)
    }
    return entry
  }

  const flush = (): void => {
    writeWorkflowProgress(runId, {
      type: 'workflow_progress',
      phases: phases.map(p => ({ ...p, agents: [...p.agents] })),
      narratorLines: [...narratorLines],
      agentCount: phases.reduce((s, p) => s + p.agentCount, 0),
      status: 'running',
    })
  }

  return (data: unknown): void => {
    const ev = data as {
      type?: string
      phase?: string
      id?: string
      label?: string
      agentType?: string
      status?: 'running' | 'done' | 'error'
      agentCount?: number
      toolUseCount?: number
      latestInputTokens?: number
      cumulativeOutputTokens?: number
      recentActivities?: WorkflowAgentStat['recentActivities']
      lastActivity?: string
      model?: string
      startTime?: number
      elapsedMs?: number
      line?: string
    }
    logEvent('tengu_workflow_progress', {
      workflow_run_id: runId,
      data_type: ev?.type ?? 'unknown',
    })

    const phaseTitle = ev?.phase ?? ''

    switch (ev?.type) {
      case 'workflow_phase': {
        const entry = getOrCreatePhase(phaseTitle, ev)
        entry.agentCount = ev.agentCount ?? entry.agentCount
        break
      }
      case 'workflow_agent_started': {
        const entry = getOrCreatePhase(phaseTitle, ev)
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
            model: ev.model,
            startTime: ev.startTime,
            elapsedMs: undefined,
            isResolved: false,
            isError: false,
          })
        }
        break
      }
      case 'workflow_agent_completed': {
        const entry = getOrCreatePhase(phaseTitle, ev)
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
            model: ev.model,
            startTime: ev.startTime,
            elapsedMs: undefined,
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
        if (ev.model !== undefined) agent.model = ev.model
        if (ev.startTime !== undefined) agent.startTime = ev.startTime
        if (ev.elapsedMs !== undefined) agent.elapsedMs = ev.elapsedMs
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

    flush()
  }
}

/**
 * runWorkflowWorker — entry point called by runDaemonWorker when kind==='workflow'.
 *
 * Reads launch params from env, builds a non-interactive context, runs the
 * workflow, and writes progress + terminal status to the wf-progress file.
 * Installs SIGTERM/SIGINT + orphan handlers that flush 'aborted' before exit
 * so the REPL poller always sees a terminal state (never a stuck 'running').
 */
export async function runWorkflowWorker(): Promise<void> {
  const scriptPath = process.env.CLAUDE_WORKFLOW_SCRIPT_PATH ?? ''
  const argsRaw = process.env.CLAUDE_WORKFLOW_ARGS
  const runId = process.env.CLAUDE_WORKFLOW_RUN_ID ?? ''
  const name = process.env.CLAUDE_WORKFLOW_NAME ?? ''
  const resumeFromRunId = process.env.CLAUDE_WORKFLOW_RESUME_FROM || undefined
  const parentPpid = process.ppid

  if (!scriptPath) {
    console.error('[workflow-worker] missing CLAUDE_WORKFLOW_SCRIPT_PATH')
    writeWorkflowProgress(runId || 'unknown', {
      type: 'workflow_failed',
      status: 'failed',
      error: 'missing CLAUDE_WORKFLOW_SCRIPT_PATH',
    })
    process.exit(1)
  }
  if (!runId || !isValidWorkflowRunId(runId)) {
    console.error(`[workflow-worker] invalid runId "${runId}"`)
    process.exit(1)
  }

  // Auth/config bootstrap — the --daemon-worker fast-path (main.tsx) skips
  // enableConfigs(). The worker MUST call it before constructing the context
  // or runAgent's model calls 401. (main.tsx comment: "If a worker kind needs
  // configs/auth, it calls them inside its run() fn.")
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()

  logEvent('tengu_workflow_launched', {
    invocation_mode: resumeFromRunId ? 'resume' : 'worker',
    workflow_run_id: runId,
    workflow_name: name,
    is_resume: !!resumeFromRunId,
  })

  // Signal + orphan handlers: flush 'aborted' to the progress file BEFORE
  // exiting, else the REPL poller never sees a terminal state and the task
  // stays 'running' forever. (runDaemonWorker's keepalive handlers are NOT
  // used for the workflow branch — we install our own.)
  let settled = false
  const flushAborted = (reason: string): void => {
    if (settled) return
    settled = true
    writeWorkflowProgress(runId, {
      type: 'workflow_aborted',
      status: 'aborted',
      reason,
    })
  }
  process.on('SIGTERM', () => {
    flushAborted('SIGTERM')
    process.exit(0)
  })
  process.on('SIGINT', () => {
    flushAborted('SIGINT')
    process.exit(0)
  })
  // Orphan watchdog: if the parent (main OCC) exits, the worker is orphaned.
  // Flush aborted so the poller sees a terminal state, then exit.
  const orphanWatch = setInterval(() => {
    if (!isPidAlive(parentPpid)) {
      flushAborted('orphaned')
      clearInterval(orphanWatch)
      process.exit(0)
    }
  }, ORPHAN_WATCH_INTERVAL_MS)
  // Don't keep the event alive solely for the watchdog (runWorkflow's pending
  // promises keep the process alive; if those settle, exit happens in finally).
  orphanWatch.unref?.()

  // Load + parse the script (path was already resolved by WorkflowTool).
  let loaded
  try {
    loaded = loadScript(scriptPath)
  } catch (e) {
    flushAborted(`script load failed: ${(e as Error).message}`)
    writeWorkflowProgress(runId, {
      type: 'workflow_failed',
      status: 'failed',
      error: `script load failed: ${(e as Error).message}`,
    })
    process.exit(1)
  }

  // Set up journal for resume (mirrors WorkflowTool call() L289-315).
  let journal: WorkflowJournal | undefined
  let cachedResults: Map<string, unknown> | undefined
  let transcriptDir = ''
  try {
    const { getTaskOutputDir } = await import('../utils/task/diskOutput.js')
    const { join } = await import('path')
    transcriptDir = join(getTaskOutputDir(), 'wf-runs', runId)
    const { mkdir } = await import('fs/promises')
    await mkdir(transcriptDir, { recursive: true })
    journal = new WorkflowJournal(transcriptDir)
    if (resumeFromRunId) {
      cachedResults = await journal.load()
    }
  } catch (e) {
    logEvent('tengu_workflow_journal_setup_failed', {
      run_id: runId,
      error: (e as Error).message.slice(0, 100),
    })
  }

  // Build the non-interactive context + progress handler.
  const toolUseContext = buildWorkerToolUseContext()
  const handleProgress = buildProgressHandler(
    runId,
    loaded.meta.phases ?? [],
  )

  // Initial 'running' snapshot so the poller sees the run immediately.
  writeWorkflowProgress(runId, {
    type: 'workflow_progress',
    phases: (loaded.meta.phases ?? []).map(p => ({
      phase: p,
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

  // Run the workflow. canUseTool = hasPermissionsToUseTool (auto-allow/deny
  // based on permissions; no UI in the worker — the user pre-approved the
  // workflow launch). The empty toolPermissionContext means most tools
  // resolve to allow/deny without a prompt.
  try {
    const args = argsRaw ? JSON.parse(argsRaw) : undefined
    const runResult = await runWorkflow({
      script: loaded.source,
      scriptPath: loaded.scriptPath,
      meta: loaded.meta,
      body: loaded.body,
      hasDefaultExport: loaded.hasDefaultExport,
      defaultExportExpr: loaded.defaultExportExpr,
      args,
      runId,
      toolUseContext,
      canUseTool: hasPermissionsToUseTool,
      onProgress: handleProgress,
      journal,
      cachedResults,
    })
    settled = true
    clearInterval(orphanWatch)
    writeWorkflowProgress(runId, {
      type: 'workflow_completed',
      status: 'completed',
      result: runResult.result,
      agentCount: runResult.agentCount,
      logs: runResult.logs,
      failures: runResult.failures,
      durationMs: runResult.durationMs,
      phases: [],
      narratorLines: [],
    })
    logEvent('tengu_workflow_task_completed', { task_id: runId })
    process.exit(0)
  } catch (e) {
    settled = true
    clearInterval(orphanWatch)
    const errMsg = (e as Error).message
    writeWorkflowProgress(runId, {
      type: 'workflow_failed',
      status: 'failed',
      error: errMsg,
    })
    logEvent('tengu_workflow_task_failed', {
      task_id: runId,
      error: errMsg.slice(0, 100),
    })
    process.exit(1)
  }
}
