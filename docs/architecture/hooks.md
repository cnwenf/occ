# Hook System

OCC's hook system lets users run custom logic at well-defined lifecycle points:
before/after tool calls, on session start/stop, on compaction, on permission
decisions, and more. Hooks are configured in `settings.json` and can be shell
commands, LLM prompts, HTTP calls, agent verifiers, or MCP tool invocations.

## Hook events — `src/entrypoints/sdk/coreTypes.ts`

`HOOK_EVENTS` defines 31 events (line 25):

| # | Event | When it fires |
|---|---|---|
| 1 | `PreToolUse` | Before a tool executes; can block/approve |
| 2 | `PostToolUse` | After a tool executes successfully |
| 3 | `PostToolUseFailure` | After a tool throws |
| 4 | `PostToolBatch` | After every tool in a batch resolves (2.1.152) |
| 5 | `Notification` | OS notification requested |
| 6 | `UserPromptSubmit` | User submits a prompt |
| 7 | `UserPromptExpansion` | Slash command/MCP prompt expands (before submit) |
| 8 | `SessionStart` | Session begins |
| 9 | `SessionEnd` | Session ends |
| 10 | `PostSession` | Post-session cleanup (self-hosted runner, 2.1.169) |
| 11 | `Stop` | Agent stops (can prevent continuation) |
| 12 | `StopFailure` | Agent stop failed |
| 13 | `SubagentStart` | Subagent spawns |
| 14 | `SubagentStop` | Subagent completes |
| 15 | `PreCompact` | Before compaction (blockable) |
| 16 | `PostCompact` | After compaction |
| 17 | `PermissionRequest` | Permission requested |
| 18 | `PermissionDenied` | Permission denied |
| 19 | `Setup` | Setup phase (always emitted) |
| 20 | `TeammateIdle` | Team teammate goes idle |
| 21 | `TaskCreated` | Background task created |
| 22 | `TaskCompleted` | Background task completed |
| 23 | `Elicitation` | MCP elicitation requested |
| 24 | `ElicitationResult` | Elicitation result returned |
| 25 | `ConfigChange` | Settings/config changed |
| 26 | `WorktreeCreate` | Worktree created |
| 27 | `WorktreeRemove` | Worktree removed |
| 28 | `InstructionsLoaded` | CLAUDE.md/memory loaded |
| 29 | `CwdChanged` | Working directory changed |
| 30 | `FileChanged` | Watched file changed |
| 31 | `MessageDisplay` | Per-flush streaming display (2.1.152) |

`ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup']` fire even when other
hooks are disabled.

## Hook command types — `src/schemas/hooks.ts`

Five command types (discriminated union on `type`):

| Type | Fields | Behavior |
|---|---|---|
| **`command`** | `command`, `if`, `shell`, `timeout`, `statusMessage`, `once`, `async`, `asyncRewake`, `args`, `continueOnBlock` | Shell command; stdout parsed as JSON |
| **`prompt`** | `prompt`, `model`, `timeout`, `continueOnBlock` | LLM prompt evaluation |
| **`http`** | `url`, `headers` (`$VAR`/`${VAR}` interpolation), `timeout` | POST hook input JSON to URL |
| **`agent`** | `prompt`, `model`, `timeout` | Agentic verifier |
| **`mcp_tool`** | `server`, `tool`, `input` (`${path}` interpolation) | Invoke MCP tool (2.1.118) |

Shared `if` condition (`IfConditionSchema`) uses permission-rule syntax (e.g.
`Bash(git *)`) to filter hooks before spawning. `HooksSchema` is a partial
record of `HOOK_EVENTS` → arrays of `HookMatcherSchema` (`{ matcher?: string,
hooks: HookCommand[] }`).

## Hook execution — `src/utils/hooks.ts`

### JSON output protocol — `processHookJSONOutput` (line 744)

Parses hook stdout JSON (`SyncHookJSONOutput` / `TypedSyncHookOutput`):

- `continue: false` → `preventContinuation = true` (+ `stopReason`).
- `decision: 'approve' | 'block'` → `permissionBehavior: 'allow' | 'deny'`
  (block sets `blockingError`).
- `systemMessage` field → surfaced to the user.
- **PreToolUse-specific** (`hookSpecificOutput.hookEventName === 'PreToolUse'`
  + `permissionDecision`): `'allow' | 'deny' | 'ask' | 'defer'` (2.1.89 defer
  pauses the tool call for resume). Validates `hookEventName` matches
  `expectedHookEvent`.
- `reason` → `hookPermissionDecisionReason`.

### PreToolUse / PostToolUse flow

- **`executePreToolHooks(toolName, toolUseID, toolInput, context,
  permissionMode, signal, timeoutMs, requestPrompt, toolInputSummary)`**
  (line 3927) — builds `PreToolUseHookInput` (`{ ...createBaseHookInput(),
  hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id }`),
  yields via `executeHooks({ hookInput, matchQuery: toolName, ... })`.
- **`executePostToolHooks(...)`** (line 3984) — `PostToolUseHookInput` adds
  `tool_response` and `duration_ms`.
- `executePostToolUseFailureHooks`, `executePermissionDeniedHooks`.

### Other event executors

`executeStopHooks` (line 4187), `executeStopFailureHooks`,
`executeTeammateIdleHooks`, `executeTaskCreatedHooks`,
`executeTaskCompletedHooks`, `executeUserPromptSubmitHooks`,
`executeUserPromptExpansionHooks`, `executeSessionStartHooks`,
`executeSessionEndHooks`, `executePostSessionHooks`,
`executePreCompactHooks` (blockable), `executePostCompactHooks`,
`executePermissionRequestHooks`, `executeConfigChangeHooks`,
`executeCwdChangedHooks`, `executeFileChangedHooks`,
`executeInstructionsLoadedHooks`, `executeElicitationHooks`,
`executeElicitationResultHooks`, `executeSubagentStartHooks`,
`executeSubagentStopHooks`, `executeWorktreeCreateHook`,
`executeWorktreeRemoveHook`, `executePostToolBatchHooks`,
`executeMessageDisplayHooks`, `executeSetupHooks`, `executeNotificationHooks`.

`executeSessionStartHooks` and `executeSetupHooks` are async generators that
`yield` `AggregatedHookResult` progress as each hook resolves, so in
headless/SDK mode (`CLAUDE_CODE_REMOTE` / `includeHookEvents`) SessionStart
output streams to the caller as it is produced instead of buffering until all
hooks finish (2.1.204).

### Matching and gating

- **`getMatchingHooks(hookEvent, matchQuery, appState, sessionId)`** (line
  1977) — retrieves configured hooks for an event.
- `hasHookForEvent` / `shouldSkipHookDueToTrust` (line 292) gate execution.
- `createBaseHookInput` (line 307) — builds the common input object.
- `AggregatedHookResult` (line 518) — aggregates results across multiple hooks.

## Per-type executors — `src/utils/hooks/`

| File | Role |
|---|---|
| `execAgentHook.ts` | Agent verifier execution |
| `execHttpHook.ts` | HTTP hook execution (with `ssrfGuard.ts`) |
| `execMcpToolHook.ts` | MCP tool hook execution |
| `execPromptHook.ts` | LLM prompt hook execution |
| `AsyncHookRegistry.ts` | Tracks async hooks |
| `sessionHooks.ts` | Session-scoped hook registration |
| `hooksConfigManager.ts` | Hook config lifecycle |
| `hooksConfigSnapshot.ts` | Snapshot of config |
| `hooksSettings.ts` | Equality/parsing helpers |
| `registerFrontmatterHooks.ts` | Register hooks from skill frontmatter |
| `registerSkillHooks.ts` | Register hooks from skills |
| `fileChangedWatcher.ts` | Backs `FileChanged` event |
| `ssrfGuard.ts` | SSRF protection for http hooks |
| `hookEvents.ts` | Event broadcast (`emitHookStarted`/`emitHookProgress`/`emitHookResponse`, `registerHookEventHandler`) |

SDK consumers opt into hook events via `includeHookEvents` or
`CLAUDE_CODE_REMOTE` mode.

## Stop-hook continuation

`handleStopHooks(...)` (in `src/query/stopHooks.ts`) runs `Stop` hooks at the
end of a turn. A stop hook can:

- `preventContinuation` → loop returns `{ reason: 'stop_hook_prevented' }`.
- Return blocking errors or `additionalContexts` → `continue` (capped by
  `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8 →
  `{ reason: 'stop_hook_block_cap' }`).

This is how `/goal` tracking works: a Stop hook evaluates whether the goal is
met and prevents continuation if not.

## Configuration

Hooks are configured in `settings.json` under a top-level `hooks` key matching
`HooksSchema`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "biome lint --fix \"$FILE_PATH\"",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

`matcher` is a tool-name regex/filter; `if` (inside each hook) is a
permission-rule pattern like `Bash(git *)`.

## How it differs from Claude Code

OCC's hook system is functionally aligned with Claude Code's. All 31 events
and 5 command types are present. The difference is runtime: Claude Code may
gate some hook behaviors via Statsig; OCC runs them unconditionally when
configured. The SSRF guard, async registry, and skill-frontmatter hook
registration are all present.
