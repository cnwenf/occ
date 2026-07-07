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

const inputSchema = lazySchema(() =>
  z.object({
    scriptPath: z
      .string()
      .describe(
        'Absolute path to a self-contained workflow script (.js). The script must begin with `export const meta = { name, description, phases }` and export a default async function receiving { agent, parallel, pipeline, phase, log, budget, workflow, resolveWorkflow, args }.',
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
        'Launch the workflow in a remote CCR environment (always async). Not available in this build.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    result: z.unknown(),
    agentCount: z.number(),
    logs: z.array(z.string()),
    failures: z.array(z.string()),
    durationMs: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

const DESCRIPTION = `Run a multi-step workflow from a self-contained JavaScript script. The script runs in a sandboxed vm with access to primitives: agent(prompt, opts?) to spawn a subagent, parallel(items) for concurrent execution (max 4096 items, ~10 concurrent), pipeline(items, ...stages) for streaming, phase(title) to group agents, log(...args) for workflow-scoped logging, budget {total, remaining(), spent()} for token caps, and workflow(nameOrRef) / resolveWorkflow(name) for sub-workflows. Scripts are deterministic for resume (no Date/Math.random/import). Use the Workflow tool on substantive multi-agent tasks.`

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
  async checkPermissions(
    input: { scriptPath?: string; name?: string; remote?: boolean } & {
      [key: string]: unknown
    },
  ): Promise<PermissionResult> {
    if (input.remote) {
      return {
        behavior: 'deny',
        message: 'Remote workflow execution is not available in this build.',
        updatedInput: input,
      }
    }
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
  async call(input, context, canUseTool) {
    const { scriptPath: rawScriptPath, args, resumeFromRunId, name } = input as {
      scriptPath?: string
      args?: Record<string, unknown>
      resumeFromRunId?: string
      name?: string
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
    try {
      const { getTaskOutputDir } = await import(
        '../../utils/task/diskOutput.js'
      )
      const { join } = await import('path')
      const transcriptDir = join(
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

    logEvent('tengu_workflow_launched', {
      invocation_mode: resumeFromRunId ? 'resume' : 'inline',
      workflow_run_id: runId,
      workflow_name: loaded.meta.name,
      workflow_description: loaded.meta.description,
      is_resume: !!resumeFromRunId,
    })

    // Run the workflow.
    const runResult = await runWorkflow({
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
      onProgress: (data) => {
        // Progress is surfaced via the tool result; no separate stream.
        logEvent('tengu_workflow_progress', {
          workflow_run_id: runId,
          data_type: (data as { type?: string })?.type ?? 'unknown',
        })
      },
      journal,
      cachedResults,
    })

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
