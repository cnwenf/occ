# Workflows

The Workflow tool runs self-contained multi-agent workflow scripts in a sandboxed VM. It enables orchestrated patterns like parallel agent dispatch, pipelines, and phased execution. Gated on the `WORKFLOW_SCRIPTS` feature flag (live in OCC).

## The Workflow tool

| Field | Value |
|---|---|
| Name | `Workflow` |
| Input | `scriptPath` (optional), `args` (optional), `resumeFromRunId` (optional), `name` (optional), `remote` (optional) |
| Output | `{ result, message?, agentCount, logs, failures, durationMs }` |
| File | `src/tools/WorkflowTool/WorkflowTool.ts` |

Requires either `scriptPath` (absolute path to a `.js` script) or `name` (resolved from `.claude/workflows/<name>.js` or `~/.claude/workflows/<name>.js`). `checkPermissions` always returns `allow` (you pre-approve by invoking the tool).

## Workflow script format

A workflow script is an ESM file:

```js
export const meta = {
  name: 'my-workflow',
  description: 'Does X by dispatching agents',
  phases: ['research', 'implement', 'review']
};

export default async ({ agent, parallel, pipeline, phase, log, budget, workflow, resolveWorkflow, args }) => {
  const result = await agent('Analyze the codebase structure');
  phase('implementation');
  const [a, b] = await parallel([
    () => agent('Implement feature A'),
    () => agent('Implement feature B'),
  ]);
  log('Both features done');
  return { a, b, result };
};
```

- `meta` must be the first statement; `name` and `description` are required (non-empty); `phases` is optional.
- The body is either a default-export function (called with the primitives object) or top-level code (wrapped in an async IIFE).

### Determinism validation

`validateBodyDeterminism` hard-blocks `new Date()`, `Date.now()`, `Math.random()`, and `import()` — these break deterministic resume. `validateScriptPath` rejects UNC paths and path traversal.

## Primitives

The host functions injected into the sandbox (`src/tools/WorkflowTool/primitives.ts`):

| Primitive | Description |
|---|---|
| `agent(prompt, opts?)` | Spawn a subagent via `runAgent()` (general-purpose); returns its result. `opts: { label?, phase?, schema?, model?, effort?, isolation? }`. Lifetime cap 1000 calls. |
| `parallel(items)` | `Promise.allSettled` with concurrency cap (default 10), max 4096 items |
| `pipeline(items, ...stages)` | Stream items through a stage chain, max 4096 items |
| `phase(title)` | Group subsequent `agent()` calls; emits `workflow_phase` progress |
| `log(...args)` | Append to workflow-scoped logs |
| `budget` | `{ total, remaining(), spent() }`; throws `WorkflowBudgetExceededError` when exhausted |
| `workflow(nameOrRef, args?)` | Resolve and run named sub-workflows |
| `resolveWorkflow(name)` | Resolve a named workflow script |

Agent calls are resume-cached: `computeAgentKey(prompt, opts)` keys the cache. On resume, unchanged `(prompt, opts)` calls return cached results instantly; only edited/new calls re-run.

## The VM sandbox

`runWorkflow()` (`src/tools/WorkflowTool/WorkflowEngine.ts`) builds a `node:vm` context with a whitelisted globals allowlist (JSON, Math, Array, Object, String, Number, Boolean, Error, Promise, console, Symbol, Map, Set, etc.) and `codeGeneration: { strings: false, wasm: false }`. Timeouts: 10s for sync, 10 min overall. Run IDs: `wf_<12-char-uuid>`.

## Inline vs async execution

The Workflow tool has two paths:

### Inline (default)

Runs `runWorkflow()` in-process with `await`. Progress goes directly to the live `WorkflowProgressTree` React component for instant updates.

### Async (`remote: true`)

Runs `runWorkflow()` in a background promise with a NO-OP `setAppState` (prevents Ink cross-root crashes). Progress is written to a file `~/.claude/wf-progress/<runId>.json`. The tool returns immediately with `result: 'started'`. On completion/failure, terminal snapshots are written to the file and the main thread's `setAppState` is updated via `setTimeout(0)`.

## Progress polling

`useWorkflowProgressPoller()` (mounted in REPL.tsx) polls every 1500ms. For each running `local_workflow` task, it reads the progress file and updates the task registry: `workflow_progress` → update batch; `workflow_completed` → complete + delete files; `workflow_failed`/`workflow_aborted` → fail + delete files. It also polls subagent-level records for fleet visibility.

## Resume

`resumeFromRunId` resumes a prior run. The journal (`src/tools/WorkflowTool/journal.ts`) persists to `<transcriptDir>/wf-runs/<runId>/`. On resume, `load()` returns a `Map<string, unknown>` of cached results; `agent()` calls with unchanged `(prompt, opts)` return cached results instantly.

## `/workflows`

```
> /workflows
```

Opens `WorkflowDetailDialog` — a live, auto-refreshing browser of running and completed workflow runs, grouped by launch type, with a detail view for a selected run. Completed workflows are retained in the task registry for browsing.

## `/goal`

```
> /goal all tests pass
```

Sets a session-scoped Stop hook that blocks stopping until the condition holds. Max 4000 chars. Auto-clears on achievement; marks `failed` if assessed impossible. Clear with `/goal clear` (aliases: `stop`, `off`, `reset`, `none`, `cancel`). Gated by hooks/trust.

## Daemon worker fallback

A daemon-worker path (`src/daemon/workflowWorker.ts`, kind `'workflow'`) exists for true process isolation — but the Workflow tool no longer uses it by default; it's retained for cases needing separate-process fleet management. The worker reads params from env vars: `CLAUDE_WORKFLOW_SCRIPT_PATH`, `CLAUDE_WORKFLOW_ARGS`, `CLAUDE_WORKFLOW_RUN_ID`, `CLAUDE_WORKFLOW_NAME`, `CLAUDE_WORKFLOW_RESUME_FROM`.

## Related

- [Sub-agents](./sub-agents.md) — the `agent()` primitive uses the Agent tool
- [Daemon](./daemon.md) — workflow worker fallback
- [FleetView](./fleetview.md) — workflow rows in the fleet view
- [Slash Commands](./slash-commands.md) — `/workflows`, `/goal`
