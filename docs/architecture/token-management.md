# Token Management

OCC bounds context-window usage through a layered pipeline: token counting,
micro-compaction, auto-compaction, reactive compaction, and a tool-result
budget. This document covers each stage and the thresholds that trigger them.

## Token counting — `src/utils/tokens.ts`

The canonical context-size function is **`tokenCountWithEstimation(messages)`**
(line 230). It walks back to the last usage-bearing message, sums
`input + output + cache` tokens from the API's reported usage, then estimates
the tokens of messages added since that point. Special handling exists for
parallel tool calls: it walks back to the first sibling sharing the same
`message.id` so interleaved `tool_result`s are counted together rather than
double-counted.

Related helpers:

- `tokenCountFromLastAPIResponse(messages)` (line 57) — the last API
  response's token count.
- `finalContextTokensFromLastResponse(messages)` (line 81) — uses
  `usage.iterations[-1].input_tokens + output_tokens` for
  `task_budget.remaining` across compaction boundaries.
- `doesMostRecentAssistantMessageExceed200k(messages)` (line 161) — the
  plan-mode 200k gate.
- `getCachedContextUsage(messages, lastAssistantMessageId)` (line 181) — a
  memoized read for the StatusLine context-usage indicator. Cache key =
  `${messages.length}:${lastAssistantMessageId ?? ''}`. The 2.1.203 perf fix:
  StatusLine re-runs its update callback on events that can fire while the
  transcript is unchanged, so without the memo each fire re-analyzed the whole
  transcript; the cache returns the last `getCurrentUsage(messages)` result
  when the key is stable. `_resetContextUsageCacheForTesting` clears it.

## The compaction pipeline (per turn iteration)

Each `queryLoop` iteration runs these stages in order:

```
snip  →  microcompact  →  context-collapse  →  autocompact  →  [API call]
                                                                  │
                                                          (on 413 prompt-too-long)
                                                                  ▼
                                                          reactive-compact
```

### 1. Snip compaction (gated `HISTORY_SNIP`)

`snipModule.snipCompactIfNeeded` removes stale history slices and plumbs
`snipTokensFreed` into the autocompact threshold so freed tokens lower the
compaction pressure. Feature-gated and off in external OCC builds.

### 2. Microcompact — `src/services/compact/microCompact.ts`

`deps.microcompact = microcompactMessages`. Removes low-value messages
(tokens, large tool results) without a full summarization round-trip. A
**cached microcompact** variant (`cachedMicrocompact.ts` / `apiMicrocompact.ts`)
may defer a boundary message until after the API response to preserve the
prompt cache.

### 3. Context collapse (gated `CONTEXT_COLLAPSE`)

`CtxInspectTool`-backed read-time projection that collapses redundant context
without mutating message history. Yields nothing; off in external builds.

### 4. Auto-compact — `src/services/compact/autoCompact.ts`

The primary compaction gate. Key constants (lines 63–71):

```
AUTOCOMPACT_BUFFER_TOKENS       = 13_000
WARNING_THRESHOLD_BUFFER        = 20_000
ERROR_THRESHOLD_BUFFER          = 20_000
MANUAL_COMPACT_BUFFER           = 3_000
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

- **`getEffectiveContextWindowSize(model)`** (line 34) —
  `getContextWindowForModel(model, getSdkBetas())` minus
  `min(maxOutputTokens, 20_000)` reserved for the summary.
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can shrink it.
- **`getAutoCompactThreshold(model)`** (line 73) —
  `effectiveContextWindow - 13_000`. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for
  testing.
- **`calculateTokenWarningState(tokenUsage, model)`** (line 94) — returns
  `{ percentLeft, isAboveWarningThreshold, isAboveErrorThreshold,
  isAboveAutoCompactThreshold, isAtBlockingLimit }`.
- **`isAutoCompactEnabled()`** (line 148) — false if `DISABLE_COMPACT` /
  `DISABLE_AUTO_COMPACT` / `userConfig.autoCompactEnabled === false`.
- **`shouldAutoCompact(messages, model, querySource, snipTokensFreed)`**
  (line 161) — false for `session_memory` / `compact` / `marble_origami`
  sources; suppressed when reactive-compact or context-collapse is active;
  otherwise `calculateTokenWarningState(tokenCount - snipTokensFreed,
  model).isAboveAutoCompactThreshold`.
- **`autoCompactIfNeeded(...)`** (line 242) — the production
  `deps.autocompact`. Circuit-breaker after 3 consecutive failures. Tries
  `trySessionMemoryCompaction` first, then `compactConversation(...)`. Resets
  `lastSummarizedMessageId`, runs `runPostCompactCleanup`, notifies
  prompt-cache-break detection.

### 5. Reactive compact — `src/services/compact/reactiveCompact.ts`

The fallback that reacts to a **real API 413 prompt-too-long** error. The
error is withheld from SDK callers, `tryReactiveCompact` runs, and the loop
`continue`s. Feature-gated `REACTIVE_COMPACT`.

## Blocking-limit check

Unless reactive-compact or context-collapse owns overflow recovery,
`calculateTokenWarningState(...).isAtBlockingLimit` yields a `prompt_too_long`
assistant error and the loop returns `{ reason: 'blocking_limit' }`.

## Compact summarization — `src/services/compact/compact.ts`

**`compactConversation(messages, context, cacheSafeParams, suppressFollowUpQuestions,
customInstructions?, isAutoCompact?, recompactionInfo?)`** (line 405) is the
core summarization function:

1. Runs `executePreCompactHooks` (blockable via exit code 2 / `decision:block`
   → `PRECOMPACT_BLOCK_SENTINEL` error).
2. Builds `getCompactPrompt(customInstructions)`.
3. A `for(;;)` retry loop (line 477) around `streamCompactSummary`.

**`streamCompactSummary(...)`** (line 1169) prefers
`runForkedAgent({ querySource: 'compact', maxTurns: 1, skipCacheWrite: true })`
to reuse the main thread's prompt cache (`tengu_compact_cache_prefix`, default
true); falls back to regular streaming. Sends keep-alive signals during
compaction.

**`buildPostCompactMessages(result)`** (line 348) assembles:
`[boundaryMarker, ...summaryMessages, ...(messagesToKeep ?? []), ...attachments,
...hookResults]`.

### Post-compact restoration

- `createPostCompactFileAttachments` (line 1449) — restores up to 5 files @ 5k
  tokens each, 50k budget.
- `createPlanAttachmentIfNeeded`, `createSkillAttachmentIfNeeded`,
  `createPlanModeAttachmentIfNeeded`, `createAsyncAgentAttachmentsIfNeeded`.

## `max_output_tokens` recovery

Distinct from compaction. When the API returns `max_tokens` /
`model_context_window_exceeded`:

1. Escalate to `ESCALATED_MAX_TOKENS` once (gated `tengu_otk_slot_v1`).
2. Up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` multi-turn resume messages
   (`"Output token limit hit. Resume directly..."`).

Both `continue` the loop. Recovery exhausted → surface the withheld error.

## Token budget (the +500k auto-continue feature)

`src/query/tokenBudget.ts` — `createBudgetTracker`, `checkTokenBudget`
(feature `TOKEN_BUDGET`). This is the auto-continue feature that lets the
agent keep working past the normal context limit using a token budget. It is
**distinct from the API `task_budget`** (`output_config.task_budget`, beta
`task-budgets-2026-03-13`), which is configured via `configureTaskBudgetParams`
in `claude.ts` and bounds the *whole agentic turn*; `remaining` is computed
per iteration from cumulative API usage.

## Tool-result budget

`applyToolResultBudget(...)` (in `query.ts`, line 393) caps aggregate
tool-result size per turn. When a tool result exceeds
`tool.maxResultSizeChars`, it is persisted to disk and the model receives a
preview with the file path instead of the full content. The
`contentReplacementState` (on `ToolUseContext`) tracks per-conversation-thread
replacements; replacements persist for `agent:`/`repl_main_thread` sources.

## Key files

| File | Role |
|---|---|
| `src/utils/tokens.ts` | `tokenCountWithEstimation` and friends |
| `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded`, thresholds, warning state |
| `src/services/compact/compact.ts` | `compactConversation`, `streamCompactSummary`, `buildPostCompactMessages` |
| `src/services/compact/microCompact.ts` | `microcompactMessages` |
| `src/services/compact/cachedMicrocompact.ts` | Cache-preserving microcompact |
| `src/services/compact/apiMicrocompact.ts` | API-side microcompact |
| `src/services/compact/reactiveCompact.ts` | 413-recovery compaction |
| `src/services/compact/snipCompact.ts` | Snip compaction (gated) |
| `src/services/compact/sessionMemoryCompact.ts` | Session-memory compaction |
| `src/services/compact/postCompactCleanup.ts` | Post-compact restoration |
| `src/query/tokenBudget.ts` | `createBudgetTracker`, `checkTokenBudget` (gated) |
| `src/query/deps.ts` | `productionDeps()` wires the compaction functions |
