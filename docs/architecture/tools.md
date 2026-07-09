# Tool System

OCC's tools are the agent's hands. Each tool is a self-contained module with a
Zod input schema, an async `call()`, permission logic, and React/Ink renderers.
This document covers the `Tool` type, the registry, how tools execute, and how
results are rendered.

## The `Tool` type — `src/Tool.ts`

`Tool` is a generic interface `Tool<Input, Output, P>` (line 364) where `Input`
is a Zod schema, `Output` the result type, and `P` the progress type.

### Identity & schema

- `name: string` (line 458)
- `aliases?: string[]` (line 373) — backwards-compat for renamed tools.
- `searchHint?: string` (line 380) — 3–10 word phrase for ToolSearch keyword
  matching.
- `readonly inputSchema: Input` (line 396) — Zod schema; MCP tools may set
  `inputJSONSchema` instead (line 399).
- `outputSchema?: z.ZodType<unknown>` (line 402).
- `maxResultSizeChars: number` (line 468) — persistence threshold. Set to
  `Infinity` for tools whose output must never persist (e.g. Read, to avoid a
  circular Read→file→Read loop).
- `readonly shouldDefer?: boolean` / `readonly alwaysLoad?: boolean`
  (lines 444, 451) — ToolSearch deferral control.
- `mcpInfo?: { serverName; toolName }` (line 457).
- `readonly strict?: boolean` (line 474) — strict tool mode.

### Execution & validation

- **`call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>`**
  (line 381) — the execution entrypoint.
- `description(input, options): Promise<string>` (line 388) — the
  model-facing description.
- `validateInput?(input, context): Promise<ValidationResult>` (line 515) —
  schema + tool-specific validation before permissions.
- `checkPermissions(input, context): Promise<PermissionResult>` (line 526) —
  tool-specific permission logic. General logic is in `permissions.ts`.
- `coerceInput?(input)` (line 495) — auto-repair malformed `tool_use` input
  before schema validation (e.g. model wraps single-task tools in arrays).
- `validationErrorSteer?(input)` (line 507) — tool-specific steering message
  appended to validation errors.
- `backfillObservableInput?(input)` (line 483) — mutate copies for observers
  (SDK stream, transcript, hooks). The original API-bound input is never
  mutated (preserves prompt cache).
- `preparePermissionMatcher?(input)` (line 540) — builds a closure for hook
  `if` conditions (permission-rule patterns like `Bash(git *)`).

### Behavioral predicates

- `isEnabled(): boolean` (line 405)
- `isReadOnly(input): boolean` (line 406)
- `isConcurrencySafe(input): boolean` (line 404) — whether it can run in
  parallel with other tools in the same batch.
- `isDestructive?(input): boolean` (line 408)
- `isSearchOrReadCommand?(input)` (line 431) — `{ isSearch, isRead, isList? }`
  for UI collapse.
- `isOpenWorld?(input)`, `requiresUserInteraction?()` (lines 436, 437)
- `interruptBehavior?(): 'cancel' | 'block'` (line 418) — what happens when
  the user submits a new message while this tool runs.
- `toAutoClassifierInput(input): unknown` (line 582) — compact representation
  for the auto-mode classifier; `''` skips.

### Rendering (React/Ink)

- `renderToolUseMessage(input, options): React.ReactNode` (line 631)
- `renderToolResultMessage?(...)` (line 592)
- `renderToolUseProgressMessage?(...)` (line 651)
- `renderToolUseRejectedMessage?(...)` (line 667)
- `renderToolUseErrorMessage?(...)` (line 685)
- `renderGroupedToolUse?(...)` (line 704) — parallel instances as a group.
- `mapToolResultToToolResultBlockParam(content, toolUseID)` (line 583) —
  model-facing serialization (distinct from UI rendering).
- `extractSearchText?(out)` (line 625) — transcript search indexing.

### Utilities

- `toolMatchesName(tool, name)` (line 350) — checks `name` or `aliases`.
- `findToolByName(tools, name)` (line 360).
- `buildTool<D>(def: D): BuiltTool<D>` (line 809) — fills in `TOOL_DEFAULTS`
  (line 783): `isEnabled→true`, `isConcurrencySafe→false`,
  `isReadOnly→false`, `isDestructive→false`, `checkPermissions→allow`,
  `toAutoClassifierInput→''`, `userFacingName→name`.
- `ToolDef` (line 747) — `Tool` with defaultable keys optional.
- `Tools = readonly Tool[]` (line 727).

## `ToolUseContext` — `src/Tool.ts` (line 158)

The per-turn mutable bag passed into every `call()`. Carries `options`
(commands, tools, mcpClients, agentDefinitions, thinkingConfig,
mainLoopModel), `abortController`, `readFileState`, `getAppState()` /
`setAppState()`, `setAppStateForTasks?` (always-shared for session-scoped
infrastructure), `messages`, `agentId`, `subagentDepth`, `toolDecisions`,
`contentReplacementState`, `requestPrompt?`, and dozens of optional hooks for
progress, notifications, and SDK status. Subagents get a context built by
`createSubagentContext` (`src/utils/forkedAgent.ts`); `setAppState` is a NO-OP
for async agents (use `setAppStateForTasks` for shared infra).

## The registry — `src/tools.ts`

**`getAllBaseTools(): Tools`** (line 194) is the source of truth: a flat array
literal. Conditional loading mechanisms:

| Mechanism | Example tools |
|---|---|
| `process.env.USER_TYPE === 'ant'` | `REPLTool`, `SuggestBackgroundPRTool`, `ConfigTool`, `TungstenTool` |
| `feature('<FLAG>')` | `MonitorTool` (MONITOR_TOOL), `WorkflowTool` (WORKFLOW_SCRIPTS), `SleepTool` (PROACTIVE\|KAIROS), `ListPeersTool` (UDS_INBOX), `SnipTool` (HISTORY_SNIP), `CtxInspectTool` (CONTEXT_COLLAPSE), `OverflowTestTool` (OVERFLOW_TEST_TOOL), `TerminalCaptureTool` (TERMINAL_PANEL) |
| `process.env` checks | `LSPTool` (ENABLE_LSP_TOOL), `TestingPermissionTool` (NODE_ENV=test), `VerifyPlanExecutionTool` (CLAUDE_CODE_VERIFY_PLAN) |
| Runtime predicates | `ToolSearchTool` (isToolSearchEnabledOptimistic), `TaskCreate/Get/Update/List` (isTodoV2Enabled), `EnterWorktree/ExitWorktree` (isWorktreeModeEnabled), `PowerShellTool` (isPowerShellToolEnabled) |
| Unconditional | `BashTool`, `FileRead/Edit/WriteTool`, `NotebookEditTool`, `GlobTool`, `GrepTool`, `AgentTool`, `WebFetchTool`, `WebSearchTool`, `TodoWriteTool`, `SkillTool`, `AskUserQuestionTool`, `EnterPlanModeTool`, `ExitPlanModeV2Tool`, `WebBrowser*Tool`, `CronCreate/Delete/ListTool`, `SendMessageTool` |

Other exports:

- `getTools(permissionContext)` (line 275) — filters by deny rules
  (`filterToolsByDenyRules`), `isEnabled()`, REPL mode hiding, embedded-search
  re-add.
- `assembleToolPool(permissionContext, mcpTools)` (line 372) — built-in + MCP,
  sorted for prompt-cache stability (built-ins as a contiguous prefix), deduped
  by name.
- `getMergedTools(permissionContext, mcpTools)` (line 410).

## Tool directory structure

Each tool lives in `src/tools/<Name>/`. Common pattern: a `buildTool({...})`
export, a `prompt.ts` (description/system prompt text), `UI.tsx` (React
renderers), optional `constants.ts`, `utils.ts`, and a `src/` subdirectory for
modular concerns.

### Representative tools

**BashTool** (`src/tools/BashTool/`): `buildTool` export, plus
`bashPermissions.ts` (~119KB, the heavy permission logic),
`bashSecurity.ts` (~102KB), `readOnlyValidation.ts`, `pathValidation.ts`,
`prompt.ts`, `UI.tsx`, `BashToolResultMessage.tsx`. `isConcurrencySafe(input)`
→ `isReadOnly(input)`; `call()` handles a `_simulatedSedEdit` shortcut then
`runShellCommand({...})` (async generator), emitting `bash_progress` events.
When the sandboxed shell spawn hits the OS `E2BIG` argument limit (common in
repos with many git worktrees, whose per-worktree deny paths grow the sandbox
command line without bound), `src/utils/bash/e2bigError.ts` (`isE2BIG`,
`isWorktreeDenyPath`, `formatE2BigError`) turns the opaque "argument list too
long" into a human-readable, actionable diagnostic (2.1.201+).

**GrepTool** (`src/tools/GrepTool/`): `searchHint: 'search file contents with
regex (ripgrep)'`, `maxResultSizeChars: 20_000`, `strict: true`.
`isConcurrencySafe() → true`, `isReadOnly() → true`. `validateInput` blocks
UNC paths (NTLM credential leak prevention). `call()` calls the `ripGrep`
utility.

**FileEditTool** (`src/tools/FileEditTool/`): `checkPermissions` + `call` +
`mapToolResultToToolResultBlockParam`.

## Tool execution flow

When the model emits `tool_use` blocks, `queryLoop` dispatches them via
`src/services/tools/toolOrchestration.ts`:

```
runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
  ├─ runToolsSerially   (line 118)  — for non-concurrency-safe tools
  └─ runToolsConcurrently (line 152) — for concurrency-safe tools
```

Each tool runs through:

1. `coerceInput` — auto-repair malformed input.
2. `inputSchema.safeParse` — schema validation.
3. `validateInput()` — tool-specific validation.
4. `checkPermissions()` → `hasPermissionsToUseTool` (rules → classifier →
   prompt UI). See [permissions.md](./permissions.md).
5. PreToolUse hooks. See [hooks.md](./hooks.md).
6. `tool.call(args, context, canUseTool, parentMessage, onProgress)` →
   `ToolResult`.
7. PostToolUse hooks.
8. The `ToolResult` is wrapped into a `tool_result` user message and appended.

`ToolResult<T>` (line 323) = `{ data, newMessages?, contextModifier?,
mcpMeta? }`. `contextModifier` is only honored for non-concurrency-safe tools.

## Streaming tool execution

`src/services/tools/StreamingToolExecutor.ts` lets tools start executing
while the model is still streaming the rest of its response. `addTool(block,
assistantMessage)` registers a tool as soon as its `tool_use` block arrives;
`getCompletedResults()` (sync) drains finished results; `getRemainingResults()`
(async) drains after streaming. On by default (`src/query/config.ts`).

## Tool result rendering

Rendering is React-based (Ink). Each tool's `renderToolUseMessage` /
`renderToolResultMessage` return `React.ReactNode`, typically imported from a
co-located `UI.tsx`. `mapToolResultToToolResultBlockParam` produces the
model-facing `ToolResultBlockParam` (Anthropic API content block) — distinct
from UI rendering. `renderGroupedToolUse` handles parallel tool instances in
non-verbose mode. `extractSearchText` feeds transcript search indexing.

## Tool deferral (ToolSearch)

Tools marked `shouldDefer: true` are sent to the API with
`defer_loading: true`; the model must use the `ToolSearchTool` to load their
full schema before calling them. Tools marked `alwaysLoad: true` always appear
in the initial prompt. For MCP tools, `alwaysLoad` is set via
`_meta['anthropic/alwaysLoad']`.

## Key files

| File | Role |
|---|---|
| `src/Tool.ts` | `Tool` type, `ToolUseContext`, `buildTool`, `findToolByName` |
| `src/tools.ts` | `getAllBaseTools`, `getTools`, `assembleToolPool` |
| `src/tools/<Name>/` | One directory per tool |
| `src/services/tools/toolOrchestration.ts` | `runTools`, serial/concurrent dispatch |
| `src/services/tools/StreamingToolExecutor.ts` | Overlap stream + execute |
| `src/utils/api.ts` | `toolToAPISchema` |
| `src/constants/tools.ts` | `ALL_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS` |
