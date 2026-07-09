# The Agentic Loop

The agentic loop is OCC's heart. It sends messages to the Claude API, streams
the response, dispatches any tool calls, appends tool results, and repeats
until the assistant stops requesting tools. Two files own this:
`src/query.ts` (the streaming generator) and `src/QueryEngine.ts` (the
orchestrator).

## Two layers: `query()` vs `QueryEngine`

```
┌──────────────────────────────────────────────────┐
│  QueryEngine  (src/QueryEngine.ts)               │
│  - one per conversation                          │
│  - owns mutableMessages, totalUsage, readFileState│
│  - submitMessage(prompt) → SDKMessage stream     │
│  - used by headless/SDK/cowork path              │
└───────────────┬──────────────────────────────────┘
                │  calls query()
                ▼
┌──────────────────────────────────────────────────┐
│  query()  (src/query.ts)                         │
│  - async generator: queryLoop()                  │
│  - one iteration = one assistant turn            │
│  - streams API events, executes tools            │
│  - yields Message / StreamEvent / ToolUseSummary │
└──────────────────────────────────────────────────┘
```

The REPL screen (`src/screens/REPL.tsx`) calls `query()` **directly** (not
`QueryEngine`) and owns its own message state in React. `QueryEngine` /
`ask()` are the headless/SDK path (`querySource: 'sdk'`).

## `query()` — the public entry

```ts
// src/query.ts (pattern)
export async function* query(params: QueryParams):
  AsyncGenerator<StreamEvent | RequestStartEvent | Message |
                  TombstoneMessage | ToolUseSummaryMessage, Terminal>
{
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  for (const uuid of consumedCommandUuids)
    notifyCommandLifecycle(uuid, 'completed')
  return terminal
}
```

`QueryParams` (line 192) carries: `messages`, `systemPrompt`, `userContext`,
`systemContext`, `canUseTool`, `toolUseContext`, `fallbackModel?`,
`querySource`, `maxOutputTokensOverride?`, `maxTurns?`, `skipCacheWrite?`,
`taskBudget?` (the API `output_config.task_budget`, distinct from the
+500k auto-continue feature), and `deps?` (injectable dependencies for
testing).

## Per-turn state

`queryLoop()` carries mutable `State` across iterations (line 215):

```ts
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  consecutiveStopHookBlocks: number   // caps infinite stop-hook loops
  turnCount: number
  transition: Continue | undefined     // why the previous iteration continued
}
```

`Continue` sites write `state = { ... }` (immutable replacement) rather than
nine separate assignments.

## The turn cycle (`queryLoop`, `while (true)`)

Each iteration is one assistant turn. In order:

1. **Destructure state** — bare-name reads; only `toolUseContext` is reassigned
   mid-iteration.
2. **Prefetch** — `startRelevantMemoryPrefetch` (once per user turn via `using`)
   and `skillPrefetch?.startSkillDiscoveryPrefetch` (per iteration, gated by
   `EXPERIMENTAL_SKILL_SEARCH`).
3. **`yield { type: 'stream_request_start' }`**.
4. **Query-chain tracking** — increments `depth` on an existing `chainId` or
   seeds a new one.
5. **Slice messages** — `getMessagesAfterCompactBoundary(messages)` so only
   post-compact history is sent.
6. **Tool-result budgeting** — `applyToolResultBudget(...)` caps aggregate
   tool-result size; persists replacements for `agent:`/`repl_main_thread`
   sources.
7. **Snip compaction** (gated `HISTORY_SNIP`) — `snipModule.snipCompactIfNeeded`;
   plumbs `snipTokensFreed` into the autocompact threshold.
8. **Microcompact** — `deps.microcompact(...)`; may defer a boundary message
   until after the API response (cached microcompact).
9. **Context collapse** (gated `CONTEXT_COLLAPSE`) — read-time projection;
   yields nothing.
10. **Build system prompt** — `asSystemPrompt(appendSystemContext(systemPrompt,
    systemContext))`.
11. **Autocompact** — `deps.autocompact(...)`. On success, yields each
    `buildPostCompactMessages(...)` entry, resets tracking. Circuit-breaker
    after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`.
12. **Blocking-limit check** — `calculateTokenWarningState(...).isAtBlockingLimit`
    yields a `prompt_too_long` error and returns `{ reason: 'blocking_limit' }`.
13. **Model selection** — `getRuntimeMainLoopModel(...)`; Fable credit debit;
    ordered fallback chain via `getOrderedFallbackModels`.
14. **API streaming** — the inner `while (attemptWithFallback)` loop calls
    `deps.callModel(...)` (= `queryModelWithStreaming` in production) and
    `for await` consumes streamed events.

### Harness-reminder injection (2.1.201+)

For Sonnet-5 (and other `shouldUseSystemRoleForHarnessReminders` models) the
loop injects a harness-reminder message into the API request
mid-conversation via `buildHarnessReminderMessage`
(`src/query/harnessReminder.ts`, imported by `query.ts`). On Sonnet-5 it is a
standalone **system-role** message (mandatory, 2.1.201); on other models it is
a user-role `isMeta` message. `shouldUseSystemRoleForHarnessReminders`
(`src/utils/model/harnessReminderRole.ts`) is the per-model gate.

## Consuming streamed events

`deps.callModel` yields `StreamEvent | AssistantMessage | SystemAPIErrorMessage`.
For each yielded message the loop:

- **Streaming-fallback tombstoning** — if `onStreamingFallback` fired, orphaned
  partial assistant messages (especially thinking blocks with invalid
  signatures) are yielded as `tombstone` events and cleared.
- **Tool-input backfill** — if an assistant message has `tool_use` blocks, the
  matching tool's `backfillObservableInput` is invoked. The message is cloned
  for yielding only if new fields were *added* (preserves prompt-cache
  byte-matching; the original flows back to the API untouched).
- **Withholding of recoverable errors** — prompt-too-long, media-size, and
  `max_output_tokens` errors are withheld from SDK callers until recovery is
  attempted, so cowork/desktop (which terminate on any `error` field) don't
  kill the session mid-recovery.
- **Assistant accumulation** — pushed to `assistantMessages`; its `tool_use`
  blocks pushed to `toolUseBlocks` and `needsFollowUp = true`. If the
  `StreamingToolExecutor` is enabled, each block is registered via
  `streamingToolExecutor.addTool(...)` so tool execution overlaps with
  continued streaming.
- **Streaming tool results** — `streamingToolExecutor.getCompletedResults()`
  yields finished tool-result messages immediately.

## Fallback handling

`FallbackTriggeredError` (from `src/services/api/withRetry.ts`) advances
through `fallbackModelList[fallbackModelIndex]`; clears accumulated messages,
yields synthetic error tool-results via `yieldMissingToolResultBlocks`,
discards and recreates the `StreamingToolExecutor`, optionally strips thinking
signatures (`stripSignatureBlocks`), yields a `warning` system message, and
`continue`s.

## Tool execution and turn continuation

If `needsFollowUp` is false → the turn ends (see stop conditions). Otherwise:

1. `streamingToolExecutor.getRemainingResults()` or
   `runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)`
   drains tool results. Each `update.message` is yielded and pushed to
   `toolResults`. `runTools` lives in `src/services/tools/toolOrchestration.ts`
   and dispatches serially or concurrently based on `isConcurrencySafe`.
2. **Tool-use summary** — if `config.gates.emitToolUseSummaries` and not a
   subagent, `generateToolUseSummary` (Haiku) fires non-blocking, producing a
   `ToolUseSummaryMessage` for the *next* iteration.
3. **Abort handling** — on signal abort, yields `createUserInterruptionMessage`;
   checks `maxTurns`; returns `{ reason: 'aborted_tools' }`.
4. **Queued-command drain** — `getCommandsByMaxPriority('next'|'later')`
   filtered by main-thread vs. subagent `agentId`; consumed commands removed
   from the queue and lifecycle-notified.
5. **Attachment injection** — `getAttachmentMessages(...)`, memory-prefetch
   consume, skill-prefetch consume.
6. **maxTurns check** — yields `max_turns_reached` attachment; returns
   `{ reason: 'max_turns', turnCount }`.
7. **Continue** — builds the next `State` with
   `messages: [...messagesForQuery, ...assistantMessages, ...toolResults]`,
   incremented `turnCount`, reset recovery counters,
   `transition: { reason: 'next_turn' }`.

## Stop conditions

The loop exits when `needsFollowUp` is false. `stop_reason` itself is **not**
the loop-exit signal (it's unreliable); `needsFollowUp` (set when any
`tool_use` block arrives) is the sole exit signal. After it, terminal paths
are evaluated in order:

1. **Prompt-too-long recovery** — context-collapse drain
   (`recoverFromOverflow`) → reactive compact (`tryReactiveCompact`); both
   `continue`. If neither recovers, the withheld error is yielded and
   `executeStopFailureHooks` fires; returns `{ reason: 'prompt_too_long' }`.
2. **`max_output_tokens` recovery** — escalate to `ESCALATED_MAX_TOKENS` once,
   then up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` multi-turn resume
   messages (`"Output token limit hit. Resume directly..."`). Both `continue`.
3. **API error short-circuit** — if the last message is an API error, skip
   stop hooks (death-spiral guard), fire `executeStopFailureHooks`; subagents
   return `{ reason: 'model_error' }`, main thread returns
   `{ reason: 'completed' }`.
4. **Stop hooks** — `handleStopHooks(...)`; `preventContinuation` →
   `{ reason: 'stop_hook_prevented' }`; blocking errors or
   `additionalContexts` `continue` (capped by `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`,
   default 8 → `{ reason: 'stop_hook_block_cap' }`).
5. **Token-budget continuation** (gated `TOKEN_BUDGET`) —
   `checkTokenBudget(...)` may `continue` with a nudge message.
6. **Normal completion** — `return { reason: 'completed' }`.

## `QueryEngine` orchestrator

`export class QueryEngine` (line 186). One engine per conversation; each
`submitMessage` is a new turn. Holds:

- `mutableMessages: Message[]` — the conversation log.
- `abortController: AbortController`.
- `permissionDenials: SDKPermissionDenial[]`.
- `totalUsage: NonNullableUsage` — accumulated via `accumulateUsage`.
- `readFileState: FileStateCache` — persisted across turns.
- `discoveredSkillNames` / `loadedNestedMemoryPaths` — cleared per
  `submitMessage`.

`async *submitMessage(prompt, options?)` (line 211) yields `SDKMessage`. It:

1. Clears turn-scoped skill tracking, sets cwd.
2. Wraps `canUseTool` to track permission denials.
3. Resolves model + thinking config (default `{ type: 'adaptive' }`).
4. Fetches system prompt parts via `fetchSystemPromptParts(...)`.
5. Builds `systemPrompt` (custom | default + memory-mechanics + append).
6. Builds `processUserInputContext` with `setMessages` writing back to
   `mutableMessages`.
7. Calls `processUserInput({ input: prompt, mode: 'prompt', ... })` →
   `messagesFromUserInput, shouldQuery, allowedTools, model, resultText`.
8. Persists the user message to transcript *before* the query loop (so
   `--resume` works even if killed mid-request).
9. If `!shouldQuery` (slash command only): replays local-command output,
   yields `result` (subtype `success`), returns.
10. Makes a file-history snapshot per selectable user message.
11. **Main loop**: `for await (const message of query({...}))` consumes the
    generator. Per message type: `assistant`/`user`/`compact_boundary` →
    pushed + transcript-recorded; `stream_event` → usage tracking (only
    yielded if `includePartialMessages`); `attachment` → handles
    `structured_output`, `max_turns_reached`, queued-command replay; `system`
    → snip-boundary replay, compact-boundary GC, `api_error` → `api_retry`.
12. Budget/structured-output guards: `maxBudgetUsd` → `error_max_budget_usd`;
    `MAX_STRUCTURED_OUTPUT_RETRIES` (5) → `error_max_structured_output_retries`.
13. Result extraction: `isResultSuccessful(result, lastStopReason)` → success
    `result` with `textResult`, `stop_reason`, `usage`, `structured_output`;
    else `error_during_execution`.

`interrupt()` aborts the controller. `ask()` (line 1211) is a one-shot
convenience wrapper that constructs a `QueryEngine`, calls `submitMessage`,
and writes back the readFile cache in `finally`.

## How the REPL uses the loop

`src/screens/REPL.tsx` (line ~2883) calls `query()` directly:

```ts
// pattern
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt, userContext, systemContext,
  canUseTool, toolUseContext,
  querySource: getQuerySourceForREPL()
})) {
  onQueryEvent(event)
}
```

The REPL owns its own `mutableMessages` in React state and routes events
through `onQueryEvent`, which updates UI state (messages, spinner, permission
prompts) as events arrive.

The live streaming-assistant text is **not** held in REPL React state: it lives
in a module-level external store, `src/components/streamingTextStore.ts`
(`streamingTextStore`), updated imperatively per token. Only the
`<StreamingPreview>` leaf subscribes via `useSyncExternalStore`, so a per-token
update re-renders just that leaf — not the whole REPL (prompt input, footer,
message list). This is the 2.1.203 fix for "the whole screen re-rendered while
a long response streamed." The store is reset to `null` on query end / interrupt.

## Tool execution: `runTools`

`src/services/tools/toolOrchestration.ts` exports `runTools(...)` (line 19),
`runToolsSerially` (line 118), `runToolsConcurrently` (line 152). A tool's
`isConcurrencySafe(input)` predicate decides whether it can run in parallel
with others in the same batch. Each tool runs through:

1. `validateInput()` — schema + tool-specific validation.
2. `checkPermissions()` → `hasPermissionsToUseTool` (rules → classifier →
   prompt UI). See [permissions.md](./permissions.md).
3. PreToolUse hooks. See [hooks.md](./hooks.md).
4. `tool.call(args, context, canUseTool, parentMessage, onProgress)` →
   `ToolResult`.
5. PostToolUse hooks.
6. The `ToolResult` is wrapped into a `tool_result` user message and appended.

## Streaming tool execution

`src/services/tools/StreamingToolExecutor.ts` (`export class
StreamingToolExecutor`) lets tools start executing while the model is still
streaming the rest of its response. `addTool(block, assistantMessage)`
registers a tool as soon as its `tool_use` block arrives;
`getCompletedResults()` (sync generator) drains finished results;
`getRemainingResults()` (async generator) drains after streaming; `discard()`
for fallback/abort. `streamingToolExecution` is **on by default**
(`src/query/config.ts` `buildQueryConfig()`).

## Key files

| File | Role |
|---|---|
| `src/query.ts` | `query()` / `queryLoop()` — the turn loop |
| `src/QueryEngine.ts` | `QueryEngine` class + `ask()` |
| `src/query/deps.ts` | `QueryDeps` + `productionDeps()` (wires callModel/microcompact/autocompact) |
| `src/query/config.ts` | `buildQueryConfig()` — gates (streaming tool exec, summaries) |
| `src/query/transitions.ts` | `Terminal` / `Continue` types (stub: `any`) |
| `src/query/tokenBudget.ts` | `createBudgetTracker`, `checkTokenBudget` (gated `TOKEN_BUDGET`) |
| `src/query/stopHooks.ts` | `handleStopHooks(...)` |
| `src/services/tools/toolOrchestration.ts` | `runTools` / serial / concurrent dispatch |
| `src/services/tools/StreamingToolExecutor.ts` | Overlapping stream+execute |
| `src/services/api/claude.ts` | `queryModelWithStreaming` (see [streaming.md](./streaming.md)) |
