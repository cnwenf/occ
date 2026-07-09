# Sub-Agents

The `AgentTool` spawns sub-agents: independent agent contexts that run their
own `query()` loop with a subset of tools, their own system prompt, and
isolated state. Sub-agents can run synchronously, in the background, in a git
worktree, or on a remote machine.

## AgentTool — `src/tools/AgentTool/`

`AgentTool.tsx` — `name: AGENT_TOOL_NAME`, aliases
`[LEGACY_AGENT_TOOL_NAME]`.

### Input schema (`fullInputSchema`)

```
{
  description: string,
  prompt: string,
  subagent_type?: string,
  model?: 'sonnet' | 'opus' | 'haiku',
  run_in_background?: boolean,
  name?: string,              // teammate name
  team_name?: string,
  mode?: PermissionMode,
  isolation?: 'worktree' | 'remote',   // remote is ant-only
  cwd?: string                          // KAIROS-gated
}
```

### Output schema

Union of `syncOutputSchema` (`status:'completed'` + `agentToolResultSchema` +
`prompt`) and `asyncOutputSchema` (`status:'async_launched'`, `agentId`,
`outputFile`, `canReadOutputFile`). Internal-only types
`TeammateSpawnedOutput` and `RemoteLaunchedOutput` are excluded from the
exported schema for dead-code elimination.

### `call()` data flow

1. **Team resolution** — `resolveTeamName`; if `teamName && name` →
   `spawnTeammate()` (multi-agent swarm path, returns `teammate_spawned`).
2. **Type resolution** — `effectiveType` (subagent_type, or fork path if
   `isForkSubagentEnabled()`, else `GENERAL_PURPOSE_AGENT`). `findAgentDef`
   (case/separator-insensitive). Rejects fork-inside-fork.
3. **MCP requirements** — checks `requiredMcpServers` (waits up to 30s,
   polling every 500ms).
4. **Isolation** — `effectiveIsolation`. `remote` → `teleportToRemote` +
   `registerRemoteAgentTask`. `worktree` → `createAgentWorktree(slug='agent-<id8>')`.
5. **System prompt** — fork path inherits parent's `renderedSystemPrompt`
   (cache-identical) + `buildForkedMessages`; normal path uses
   `selectedAgent.getSystemPrompt({toolUseContext})` +
   `enhanceSystemPromptWithEnvDetails`.
6. **Tool pool** — `assembleToolPool(workerPermissionContext,
   appState.mcp.tools)` with `permissionMode: selectedAgent.permissionMode ??
   'acceptEdits'`.
7. **Async decision** — `shouldRunAsync = (run_in_background ||
   selectedAgent.background || isCoordinator || forceAsync (fork) ||
   assistantForceAsync (KAIROS) || proactiveActive) &&
   !isBackgroundTasksDisabled`. `getAutoBackgroundMs()` returns 120000ms.
8. **Async path** — `registerAsyncAgent` →
   `runWithAgentContext(asyncAgentContext, () => wrapWithCwd(() =>
   runAsyncAgentLifecycle(...)))` (fire-and-forget `void`). Returns
   `{status:'async_launched', agentId, outputFile}`. Name→agentId registered
   in `appState.agentNameRegistry` for SendMessage routing.
9. **Sync path** — `registerAgentForeground` (with `autoBackgroundMs`),
   iterates `runAgent(...)` async generator, racing each `next()` against a
   `backgroundSignal` (auto-background). If backgrounded mid-run,
   transitions to the async closure. Progress forwarded via `onProgress`
   (`agent_progress`), `emitTaskProgress`, `updateAsyncAgentProgress`.

### Worktree-isolation fixes (2.1.204 catchup)

Worktree-isolated subagents now run their shell commands and filesystem
operations inside the worktree cwd via `runWithCwdOverride(worktreePath, fn)`,
not the parent checkout (#29 — previously a subagent's `Bash`/file tools
touched the parent repo). Worktree creation no longer rejects nested repos in
a multi-repo workspace (#30). The AgentTool system prompt
(`src/tools/AgentTool/prompt.ts`) also carries a no-re-delegation guideline: a
subagent must do the delegated work itself and may not spawn further
subagents to offload it (#39).

## `runAgent` — `src/tools/AgentTool/runAgent.ts`

Async generator yielding `Message`s. Calls `query()` (the core LLM loop).
Builds a subagent `ToolUseContext` via `createSubagentContext`
(`src/utils/forkedAgent.ts`). Sets `subagentDepth: (parentDepth)+1`,
`transcriptSubdir`, records sidechain transcripts. Connects MCP servers
per-agent via `connectToServer`/`fetchToolsForClient`.

### `createSubagentContext`

- `subagentDepth` increments from parent.
- `setAppState` is a **NO-OP** for async agents (use `setAppStateForTasks`
  for shared infra that outlives a single turn).
- `localDenialTracking` — for async subagents whose `setAppState` is a no-op,
  so the denial counter accumulates and the fallback-to-prompting threshold
  is reached.
- `contentReplacementState` — cloned from parent by default (cache-sharing
  forks need identical decisions).
- `renderedSystemPrompt` — parent's prompt bytes frozen at turn start, used
  by fork subagents to share the parent's prompt cache.

## Built-in agents — `src/tools/AgentTool/built-in/`

`generalPurposeAgent.ts`, `exploreAgent.ts`, `planAgent.ts`,
`verificationAgent.ts`, `statuslineSetup.ts`, `claudeCodeGuideAgent.ts`.
`ONE_SHOT_BUILTIN_AGENT_TYPES` excludes Explore/Plan from the
agentId/usage trailer.

Custom agents are loaded from `.claude/agents/*.md` via
`loadAgentsDir.ts` (`AgentDefinition`, `filterAgentsByMcpRequirements`,
`hasRequiredMcpServers`, `isBuiltInAgent`).

## Worktree isolation

### `EnterWorktreeTool` — `src/tools/EnterWorktreeTool/`

Input `{name?, path?}` (mutually exclusive). `name` →
`createWorktreeForSession(getSessionId(), slug)`, then `process.chdir`/
`setCwd`/`setOriginalCwd`/`saveWorktreeState`, clears
`clearSystemPromptSections` + `clearMemoryFileCaches`. `path` →
`enterExistingWorktree` (validates via `git worktree list --porcelain` +
`realpath`). Rejects if already in a worktree session (unless `path`).

### `ExitWorktreeTool` — `src/tools/ExitWorktreeTool/`

Input `{action: 'keep'|'remove', discard_changes?}`. `keep` → `keepWorktree`;
`remove` → `cleanupWorktree` (refuses if uncommitted/unmerged unless
`discard_changes:true`). Restores `originalCwd`/`projectRoot`, kills tmux
session if present.

## Background execution — `src/utils/background/`

`remote/remoteSession.ts` — `checkBackgroundRemoteSessionEligibility(...)` returns
preconditions (`not_logged_in`, `no_remote_environment`, `not_in_git_repo`,
`no_git_remote`, `github_app_not_installed`, `policy_blocked`). Checks
`isPolicyAllowed('allow_remote_sessions')` first.

## Task types — `src/tasks/`

`TaskState` union (in `types.ts`):

| Type | File | Key fields |
|---|---|---|
| `local_agent` | `LocalAgentTask/` | `agentId`, `agentType`, `prompt`, `isBackgrounded`, `progress: AgentProgress`, `outputFile`, `abortController` |
| `in_process_teammate` | `InProcessTeammateTask/` | `identity: TeammateIdentity`, `abortController` (whole teammate), `currentWorkAbortController` (current turn), `messages?` (capped 50), `permissionMode`, `isIdle` |
| `remote_agent` | `RemoteAgentTask/` | `remoteTaskType` (`remote-agent`/`ultraplan`/`ultrareview`/`autofix-pr`/`background-pr`), `sessionId`, `log: SDKMessage[]`, polls `pollRemoteSessionEvents` |
| `local_workflow` | `LocalWorkflowTask/` | `workflowRunId`, `phases`, `workflowProgress` |
| `local_shell` | `LocalShellTask/` | terminal shell task |
| `monitor_mcp` | `MonitorMcpTask/` | monitor tool task |
| `dream` | `DreamTask/` | dream task |

`isBackgroundTask(task)` checks `status==='running'|'pending'` and
`isBackgrounded !== false`.

Progress tracking: `ProgressTracker { toolUseCount, latestInputTokens,
cumulativeOutputTokens, recentActivities[] }`.

## SendMessageTool — `src/tools/SendMessageTool/`

`name: SEND_MESSAGE_TOOL_NAME`, `isEnabled: isAgentSwarmsEnabled()`. Input
`{to, summary?, message: string | StructuredMessage}`. `StructuredMessage` is
a discriminated union of `shutdown_request`, `shutdown_response` (approve +
reason), `plan_approval_response` (approve + feedback).

### `call()` routing

1. UDS_INBOX feature: `bridge:<session>` → cross-machine; `uds:<socket>` →
   `sendToUdsSocket`.
2. String message to a registered agent name/raw ID (`agentNameRegistry`):
   if task running → `queuePendingMessage`; if stopped →
   `resumeAgentBackground` with the message; if no task → resume from disk
   transcript.
3. `to: '*'` → `handleBroadcast` (all team members).
4. Named teammate → `handleMessage` → `writeToMailbox`.
5. Structured: `shutdown_request` → `handleShutdownRequest`;
   `shutdown_response` approve → `handleShutdownApproval` (in-process: aborts
   `task.abortController`); reject → `handleShutdownRejection`;
   `plan_approval_response` → `handlePlanApproval`/`handlePlanRejection`
   (team-lead only).

## Key files

| File | Role |
|---|---|
| `src/tools/AgentTool/AgentTool.tsx` | The Agent tool |
| `src/tools/AgentTool/runAgent.ts` | Sub-agent query generator |
| `src/tools/AgentTool/loadAgentsDir.ts` | `AgentDefinition`, custom agent loading |
| `src/tools/AgentTool/forkSubagent.ts` | `buildForkedMessages`, `isForkSubagentEnabled` |
| `src/tools/AgentTool/agentToolUtils.ts` | `runAsyncAgentLifecycle`, `finalizeAgentTool` |
| `src/tools/AgentTool/resumeAgent.ts` | `resumeAgentBackground` |
| `src/tools/EnterWorktreeTool/` | Worktree creation |
| `src/tools/ExitWorktreeTool/` | Worktree teardown |
| `src/tools/SendMessageTool/` | Inter-agent messaging |
| `src/tasks/` | Task type implementations |
| `src/utils/forkedAgent.ts` | `createSubagentContext` |
