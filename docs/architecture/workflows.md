# Workflow Engine

The workflow engine lets users write multi-agent scripts that run in a
VM sandbox with primitives like `agent()`, `parallel()`, `pipeline()`,
`phase()`, and `log()`. Workflows are gated live via `WORKFLOW_SCRIPTS`.

## Overview

```
WorkflowTool.call()
   ├─ loadScript(path) → {body, meta, hasDefaultExport, defaultExportExpr?}
   ├─ registerWorkflowTask(...)  → seeds local_workflow task
   ├─ remote: true  → in-process async (NO-OP setAppState) → runWorkflow()
   └─ inline        → runWorkflow() awaited
                          │
                          ▼
                   WorkflowEngine.runWorkflow()
                          │
                   createPrimitives(ctx) + buildPrimitivesObject
                          │
                   vm.createContext(sandbox)
                          │
                   vm.runInContext(compiledScript)
                          │
                   await workflowFn(primitivesObj)  (or async IIFE)
```

## WorkflowTool — `src/tools/WorkflowTool/WorkflowTool.ts`

`buildTool`, `name: WORKFLOW_TOOL_NAME`. Input schema:

```
{
  scriptPath?: string,
  args?: Record<string, unknown>,
  resumeFromRunId?: string,   // /^wf_[a-z0-9-]{6,}$/
  name?: string,              // named workflow from discovery
  remote?: boolean            // async in-process launch
}
```

Output schema: `{result, message?, agentCount, logs[], failures[],
durationMs}`.

The tool description carries an advisory size hint derived from the
`dynamicWorkflowSize` setting (`small` | `medium` | `large`, default
`medium`) — advisory, not a cap (2.1.204).

### `call()` flow

1. Resolves script: `name` → `resolveWorkflowScript(name)` (from
   `workflowDiscovery.js`); else `validateScriptPath(scriptPath)`. Then
   `loadScript(path)`.
2. `runId` = `resumeFromRunId` or `generateWorkflowRunId()` →
   `wf_<12-char-uuid>`. Resume guard: if a task with that runId is still
   running, returns early.
3. Sets up `WorkflowJournal` at `<taskOutputDir>/wf-runs/<runId>/journal.jsonl`;
   loads `cachedResults` if resuming.
4. `registerWorkflowTask(initialState, context.setAppState)` — seeds
   `local_workflow` task with `seedPhases` from `meta.phases`.
5. **`remote: true` (async, in-process)**: Creates
   `bgContext = createSubagentContext(context)` then **NO-OPs both
   `setAppState` and `setAppStateForTasks`** (`const noop = () => {}`).
   Builds `handleBgProgress` (writes to file via `writeWorkflowProgress`,
   plus subagent-level records `<runId>.sub.<id>.json`). Writes initial
   'running' snapshot. Launches `void (async () => { ... runWorkflow(...)
   ... })()` — NOT awaited. On completion: `writeWorkflowProgress(runId,
   {type:'workflow_completed',...})` + `setTimeout(() =>
   completeWorkflowTask(...), 0)`. Returns `{result:'started', ...}`.
6. **Inline path**: `handleProgress` emits to both
   `updateWorkflowProgressBatch` + `onProgress`. Awaits `runWorkflow(...)`.
   Then `completeWorkflowTask`. Returns full result.

`buildWorkflowProgressHandler(runId, seedPhases, emit, onAgentEvent?)` —
shared accumulator factory. Handles events: `workflow_phase`,
`workflow_agent_started`, `workflow_agent_completed` (with
`toolUseCount`/`latestInputTokens`/`cumulativeOutputTokens`/`recentActivities`),
`workflow_log`. Emits `WorkflowProgressSnapshot {type:'workflow_progress',
phases, narratorLines, agentCount, runId}`.

## WorkflowEngine — `src/tools/WorkflowTool/WorkflowEngine.ts`

`runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult>`.

1. Builds `WorkflowRuntimeContext` (mutable `counters: {agentCount,
   spentTokens, failures, logs}`, `workflowProgress[]`, `currentPhase`,
   `abortController`, `resolveWorkflowScript`).
2. `createPrimitives(runtimeCtx)` + `buildPrimitivesObject` →
   `{agent, parallel, pipeline, phase, log, budget, workflow,
   resolveWorkflow, args}`.
3. `createSandbox(primitives)` — copies `SANDBOX_GLOBALS` (`JSON, Math, Array,
   Object, String, Number, Boolean, Error, Promise, console, Symbol, Map, Set,
   ...`) from `globalThis`, injects primitives, overrides `console` to route
   to the `log` primitive.
4. `vm.createContext(sandbox, {name: 'workflow-'+runId, codeGeneration:
   {strings: false, wasm: false}})`.
5. **Two shapes**:
   - `hasDefaultExport && defaultExportExpr` → compile `(${expr})`,
     `runInContext` (timeout `VM_SYNC_TIMEOUT_MS=10000`), call
     `workflowFn(primitivesObj)`, await.
   - else wrap body in `(async () => { ...body... })()`, compile, run, await
     the promise.
6. Catches `AbortError`, `WorkflowBudgetExceededError` (returns partial),
   rethrows others. `WORKFLOW_TIMEOUT_MS = 10min`.

## Primitives — `src/tools/WorkflowTool/primitives.ts`

`createPrimitives(ctx)` returns:

- **`agent(prompt, opts?)`** — `AgentOpts {label?, phase?, schema?, model?,
  effort?, isolation?}`. Caps: `WORKFLOW_AGENT_LIFETIME_CAP=1000`, budget
  check. Resume cache via `computeAgentKey`. Spawns `runAgent` with
  `GENERAL_PURPOSE_AGENT` def, `querySource:'workflow'`, drains generator,
  extracts text result (or `StructuredOutput` tool input if `opts.schema`).
  Emits `workflow_agent_started`/`workflow_agent_completed`. Tracks
  `extractTokenUsage`/`extractTokenBreakdown`/`extractToolUseStats`. Agent
  telemetry events carry `workflow.run_id` + `workflow.name` OTel attributes
  via `workflowAgentTelemetryAttributes(runId, workflowName)` (2.1.204).
- **`parallel(items)`** — `Promise.allSettled` with `createSemaphore`
  (default `WORKFLOW_DEFAULT_CONCURRENCY=10`, or `tokenBudget/100000`). Max
  `WORKFLOW_PARALLEL_MAX_ITEMS=4096`. Budget/cap errors → `null` per branch.
- **`pipeline(items, ...stages)`** — streams items through stage chain (no
  barrier; `stage(prev, original, index)`). Same semaphore/cap.
- **`phase(title)`** — sets `ctx.currentPhase`, pushes progress entry.
- **`log(...args)`** — appends to `counters.logs` + emits `workflow_log`.
- **`budget`** — `{total, remaining(), spent()}`.
- **`workflow(nameOrRef, args?)`** — recursively runs a named sub-workflow.
- **`resolveWorkflow(name)`** — returns scriptPath or null.

## Journal — `src/tools/WorkflowTool/journal.ts`

`WorkflowJournal` class — append-only JSONL at
`<transcriptDir>/journal.jsonl`.

- `computeAgentKey(prompt, opts)` = sha256 of stable-stringified `{prompt,
  opts}` (first 32 hex chars).
- `load()` → `Map<key, result>` of `type:'result'` entries (skips unparseable
  lines).
- `appendStarted(key, agentId)`, `appendResult(key, agentId, result, tokens?)`,
  `markSkipped(key)`, `deleteKey(key)` (rewrites file), `invalidate()`.
- Appends serialized via `sequential()` to prevent concurrent-write
  corruption.

The journal enables **resume**: when `resumeFromRunId` is set, completed
agents are skipped (cache hit) and only unfinished work re-runs. Resuming an
agent by ID does a direct worktree-path lookup from the saved run meta
(`meta.worktreePath`, stat-checked; falls back to the parent cwd if the
worktree no longer exists) rather than re-discovering it (#14, 2.1.204).

## Progress polling

### `useWorkflowProgressPoller.ts` — `src/hooks/`

React hook mounted in the REPL. `POLL_INTERVAL_MS=1500`. Reads
`store.getState().tasks`, filters running `local_workflow` tasks.
`setTimeout(0)` defers state updates (avoids cross-root `flushSync` crash
during in-flight render). For each: `readWorkflowProgress(runId)` — if
`updatedAt <= lastSeen` skip. Handles `workflow_progress` →
`updateWorkflowProgressBatch`; `workflow_completed` → `completeWorkflowTask`
+ delete files; `workflow_failed`/`workflow_aborted` → `failWorkflowTask`.
Also polls `listSubagentProgress(runId)` → creates/updates `local_agent`
tasks (`wf_sub_<runId>_<subagentId>`) for fleet visibility.

### `wfProgress.ts` — `src/utils/`

`getWfProgressDir()` = `~/.claude/wf-progress/`. `writeWorkflowProgress(runId,
data)` — atomic temp+`renameSync`. `readWorkflowProgress(runId)` — null on
missing/malformed, never throws. `deleteWorkflowProgress`,
`listWorkflowProgress`, `listSubagentProgress(runId)`,
`deleteSubagentProgress(runId)`.

## The NO-OP setAppState pattern

The async workflow path (in-process `remote:true`) NO-OPs `setAppState` and
`setAppStateForTasks` to prevent Ink's cross-root `flushSyncWork` crash when
a background promise mutates the root React store. Progress flows via files
(`~/.claude/wf-progress/`) → main-thread poller → safe `setAppState`. The
commit `2a6e802` ("revert(workflow): in-process async crashes Ink — keep
inline + retain fix") documents this: a prior attempt to run truly
in-process async crashed Ink, so the file-polling bridge was retained.

## Daemon worker (fallback path) — `src/daemon/workflowWorker.ts`

`runWorkflowWorker()` — spawned by `runDaemonWorker` when `kind==='workflow'`.
Reads params from env (`CLAUDE_WORKFLOW_SCRIPT_PATH`, `CLAUDE_WORKFLOW_ARGS`,
`CLAUDE_WORKFLOW_RUN_ID`, `CLAUDE_WORKFLOW_NAME`,
`CLAUDE_WORKFLOW_RESUME_FROM`). Builds `buildWorkerToolUseContext()` (NO-OP
`setAppState`, `isNonInteractiveSession: true`, `mcpClients: []`).
SIGTERM/SIGINT/orphan-watchdog flush `workflow_aborted`. Runs `runWorkflow`,
writes `workflow_completed`/`workflow_failed`, `process.exit`. This is a
**fallback** — the primary async path is now in-process; WorkflowTool no
longer calls `spawnWorker`.

## Bundled workflows — `src/tools/WorkflowTool/bundled/`

`bundled/index.js` contains bundled workflow scripts discoverable via
`/workflows`. The `/workflows` listing lays out each run's agents as a
navigable per-agent list (one row per agent with progress/tokens) rather than
a flat log (2.1.204).

## Key files

| File | Role |
|---|---|
| `src/tools/WorkflowTool/WorkflowTool.ts` | The Workflow tool + progress handler |
| `src/tools/WorkflowTool/WorkflowEngine.ts` | `runWorkflow` — VM sandbox |
| `src/tools/WorkflowTool/primitives.ts` | `createPrimitives`, `buildPrimitivesObject` |
| `src/tools/WorkflowTool/journal.ts` | `WorkflowJournal` — resume cache |
| `src/tools/WorkflowTool/scriptLoader.ts` | `loadScript` |
| `src/tools/WorkflowTool/errors.ts` | `WorkflowBudgetExceededError` |
| `src/hooks/useWorkflowProgressPoller.ts` | REPL progress poller |
| `src/utils/wfProgress.ts` | File-based progress store |
| `src/daemon/workflowWorker.ts` | Daemon worker (fallback) |
