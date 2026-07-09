/**
 * K3 (2.1.154): Workflow engine — the vm-based runtime that executes a
 * workflow script with sandboxed primitives.
 *
 * Mirrors the 2.1.200 binary's mBl/pBl/OQt:
 *   - runWorkflow({script, scriptPath, meta, body, args, runId, ...}):
 *     builds a vm.Context (node:vm) with whitelisted globals + host fns
 *     bound, compiles the body to a vm.Script, runs with timeout + abort,
 *     seals the async result, returns {result, agentCount, logs, failures,
 *     durationMs}.
 *
 * VM EXECUTION (binary): node:vm. Script compiled to vmScript, run via
 * vmScript.runInContext(vmContext, {timeout}). Async sealed via the
 * returned Promise (host awaits it). vmContext is sandboxed: globals
 * whitelisted with fallback allowlist [JSON, Array, Object, ...]. Host fns
 * injected as `runInContext("(hostFn => async (...a) => hostFn(...a))", ctx)`.
 *
 * The body is wrapped in an async IIFE so top-level `await` + `return`
 * work (the vm.Script itself is synchronous; the IIFE returns a Promise
 * the host awaits). When the script has an `export default` function,
 * the engine extracts it and calls it with the primitives object.
 */
import vm from 'node:vm'
import { randomUUID } from 'crypto'
import { logEvent } from '../../services/analytics/index.js'
import { AbortError } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolUseContext, CanUseToolFn } from '../../Tool.js'
import {
  createPrimitives,
  buildPrimitivesObject,
  type WorkflowRuntimeContext,
} from './primitives.js'
import { WorkflowJournal, computeAgentKey } from './journal.js'
import type { WorkflowMeta } from './scriptLoader.js'
import { WorkflowBudgetExceededError } from './errors.js'

/** Default sync timeout for the vm.Script run (the IIFE returns a Promise
 * immediately; the host awaits it separately with its own timeout). */
const VM_SYNC_TIMEOUT_MS = 10_000

/** Default overall workflow timeout (host-side, awaiting the async result). */
const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000 // 10 min

export interface WorkflowRunResult {
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
}

export interface RunWorkflowOptions {
  script: string
  scriptPath: string
  meta: WorkflowMeta
  body: string
  hasDefaultExport: boolean
  defaultExportExpr?: string
  args?: unknown
  runId: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  onProgress?: (data: unknown) => void
  /** Journal for resume (engine creates one if not provided + transcriptDir given). */
  journal?: WorkflowJournal
  cachedResults?: Map<string, unknown>
  /** Token budget target. null/undefined = no cap. */
  tokenBudget?: number | null
  /** AbortController (defaults to toolUseContext's). */
  abortController?: AbortController
}

/**
 * Generate a workflow run ID: `wf_<12-char-uuid>`.
 * Mirrors the binary: `wf_${randomUUID().slice(0,12)}`.
 */
export function generateWorkflowRunId(): string {
  return `wf_${randomUUID().slice(0, 12)}`
}

/**
 * Validate a workflow run ID against the binary's regex.
 */
export function isValidWorkflowRunId(id: string): boolean {
  return /^wf_[a-z0-9-]{6,}$/.test(id)
}

/**
 * Whitelisted globals for the vm sandbox. Mirrors the binary's fallback
 * allowlist. We expose a read-only subset of safe globals.
 */
const SANDBOX_GLOBALS = [
  'JSON',
  'Math',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Error',
  'Promise',
  'console',
  'Symbol',
  'Map',
  'Set',
  'Array',
  'isFinite',
  'isNaN',
  'parseInt',
  'parseFloat',
  'undefined',
  'NaN',
  'Infinity',
]

/**
 * Build the vm sandbox context with whitelisted globals. Host fns are
 * injected by the caller (createPrimitives).
 */
function createSandbox(primitives: Record<string, unknown>): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {}
  // Copy whitelisted globals from the host.
  for (const name of SANDBOX_GLOBALS) {
    const g = (globalThis as Record<string, unknown>)[name]
    if (g !== undefined) {
      sandbox[name] = g
    }
  }
  // Inject primitives as globals (for top-level body shape).
  Object.assign(sandbox, primitives)
  // console with a pass-through log (so log() in scripts works but is scoped).
  sandbox.console = {
    log: (...args: unknown[]) => {
      // Route console.log to the workflow logs via the log primitive.
      ;(primitives.log as ((...a: unknown[]) => void))(...args)
    },
    error: (...args: unknown[]) => {
      ;(primitives.log as ((...a: unknown[]) => void))('ERROR:', ...args)
    },
    warn: (...args: unknown[]) => {
      ;(primitives.log as ((...a: unknown[]) => void))('WARN:', ...args)
    },
  }
  // Provide `args` (the workflow's args param) as a global.
  return sandbox
}

/**
 * Run a workflow script in a sandboxed vm context.
 *
 * The body is either:
 *   (a) a default-export function expression (hasDefaultExport=true) —
 *       the engine compiles it, calls it with the primitives object, and
 *       awaits the result.
 *   (b) top-level code (hasDefaultExport=false) — the engine wraps it in
 *       an async IIFE and awaits the returned Promise.
 */
export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const startTime = Date.now()
  const {
    body,
    hasDefaultExport,
    defaultExportExpr,
    meta,
    runId,
    toolUseContext,
    canUseTool,
    args,
    onProgress,
    journal,
    cachedResults,
    tokenBudget,
  } = options

  const abortController =
    options.abortController ?? toolUseContext.abortController

  logEvent('tengu_workflow_launched', {
    invocation_mode: 'inline',
    workflow_run_id: runId,
    workflow_name: meta.name,
    workflow_description: meta.description,
  })

  // Build the runtime context (mutable counters shared with primitives).
  const counters = {
    agentCount: 0,
    spentTokens: 0,
    failures: [] as string[],
    logs: [] as string[],
  }
  const workflowProgress: WorkflowRuntimeContext['workflowProgress'] = []
  const seedPhaseTitles = meta.phases

  // Resolve workflow scripts from discovery (lazy import to avoid cycles).
  let resolveWorkflowScript: ((name: string) => string | null) | undefined
  try {
    const mod = await import('../../utils/effort/workflowDiscovery.js')
    resolveWorkflowScript = mod.resolveWorkflowScript
  } catch {
    // discovery not available — sub-workflow resolution disabled
  }

  const runtimeCtx: WorkflowRuntimeContext = {
    runId,
    workflowName: meta.name,
    toolUseContext,
    canUseTool,
    availableTools: toolUseContext.options.tools,
    journal,
    cachedResults,
    tokenBudget: tokenBudget ?? null,
    counters,
    currentPhase: seedPhaseTitles?.[0] ?? '',
    workflowProgress,
    seedPhaseTitles,
    abortController,
    onProgress,
    resolveWorkflowScript,
  }

  // Build primitives.
  const primitives = buildPrimitivesObject(runtimeCtx)
  const { agent: agentFn, parallel: parallelFn, pipeline: pipelineFn, phase: phaseFn, log: logFn, budget: budgetObj, workflow: workflowFn, resolveWorkflow: resolveWorkflowFn } =
    createPrimitives(runtimeCtx)

  // Rebuild primitives object with the bound functions from createPrimitives
  // (these are the actual closures over runtimeCtx).
  const primitivesObj = {
    agent: agentFn,
    parallel: parallelFn,
    pipeline: pipelineFn,
    phase: phaseFn,
    log: logFn,
    budget: budgetObj,
    workflow: workflowFn,
    resolveWorkflow: resolveWorkflowFn,
    args,
  }

  // Build the sandbox.
  const sandbox = createSandbox(primitivesObj)
  // Also expose `args` as a top-level global.
  sandbox.args = args
  const vmContext = vm.createContext(sandbox, {
    name: `workflow-${runId}`,
    codeGeneration: { strings: false, wasm: false },
  })

  let result: unknown
  try {
    if (hasDefaultExport && defaultExportExpr) {
      // Shape (a): default export function. Compile the expression, call it.
      const expr = defaultExportExpr.replace(/;\s*$/, '')
      const compiled = new vm.Script(`(${expr})`)
      const workflowFn = compiled.runInContext(vmContext, {
        timeout: VM_SYNC_TIMEOUT_MS,
      })
      if (typeof workflowFn !== 'function') {
        throw new Error(
          `Workflow script's export default must be a function; got ${typeof workflowFn}`,
        )
      }
      // Call with the primitives object. The function may be async.
      result = await workflowFn(primitivesObj)
    } else {
      // Shape (b): top-level code. Wrap in async IIFE.
      const wrapped = `(async () => {\n${body}\n})()`
      const compiled = new vm.Script(wrapped)
      const promise = compiled.runInContext(vmContext, {
        timeout: VM_SYNC_TIMEOUT_MS,
      })
      result = await promise
    }
  } catch (e) {
    if (e instanceof AbortError || abortController.signal.aborted) {
      throw new Error('REPL execution interrupted')
    }
    if (e instanceof WorkflowBudgetExceededError) {
      // Budget exhausted at the top level — return partial result.
      logForDebugging(
        `Workflow ${runId} budget exhausted: ${e.spent}/${e.total}`,
      )
      result = undefined
    } else {
      // Re-throw script errors.
      throw e
    }
  }

  const durationMs = Date.now() - startTime

  logEvent('tengu_workflow_completed', {
    workflow_run_id: runId,
    durationMs,
    agent_count: counters.agentCount,
    workflow_name: meta.name,
  })

  return {
    result,
    agentCount: counters.agentCount,
    logs: counters.logs,
    failures: counters.failures,
    durationMs,
  }
}
