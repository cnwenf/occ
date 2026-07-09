# Streaming Response Pipeline

OCC streams Claude API responses token-by-token and dispatches tool calls
mid-stream. This document traces the path from an API request to a rendered
terminal token, including thinking-block handling and partial-JSON tool-input
accumulation.

## The streaming call chain

```
queryLoop()  ──deps.callModel──►  queryModelWithStreaming()   (VCR wrapper)
                                          │
                                          ▼
                                   queryModel()           (src/services/api/claude.ts)
                                          │
                                          ▼
              anthropic.beta.messages.create({...params, stream: true}).withResponse()
                                          │
                                          ▼
                          Stream<BetaRawMessageStreamEvent>
                                          │
                                for await (const part of stream)
                                          │
                          switch (part.type) { … }
```

`queryModelWithStreaming` (line 774) wraps `queryModel` in `withStreamingVCR`
for fixture recording/replay. `queryModel` (line 1108) is the real
implementation; its yield type is
`StreamEvent | AssistantMessage | SystemAPIErrorMessage`.

## Why the raw stream, not `BetaMessageStream`

`queryModel` uses the **raw `messages.create({ ...params, stream: true })`**
with `.withResponse()`, not the SDK's `BetaMessageStream` helper. The comment
at line 1914 explains: the raw stream avoids O(n²) `partialParse()` on every
`input_json_delta` that the higher-level stream would perform. Tool-input JSON
is accumulated as a plain string and parsed once at `content_block_stop`.

## Request-param building (`queryModel`, lines 1108–1820)

Before streaming begins, `queryModel` assembles the request:

1. **Betas** — `getMergedBetas(model, { isAgenticQuery })`. `isAgenticQuery` is
   true for `repl_main_thread*`, `agent:*`, `sdk`, `hook_agent`,
   `verification_agent`.
2. **Tool search** — `isToolSearchEnabled(...)` filters deferred tools
   (`shouldDefer: true`) and adds the provider-specific tool-search beta.
3. **Cached microcompact / global cache scope** —
   `PROMPT_CACHING_SCOPE_BETA_HEADER`.
4. **Tool schemas** — `toolToAPISchema(tool, {...})` per filtered tool;
   advisor schema appended as `extraToolSchemas`.
5. **Message normalization** — `normalizeMessagesForAPI(messages,
   filteredTools)`, then `stripToolReferenceBlocksFromUserMessage`,
   `ensureToolResultPairing` (repairs orphaned tool_use/tool_result on
   resume), `stripExcessMediaItems` (>100 media).
6. **Fingerprint** — `computeFingerprintFromMessages` for the attribution
   header.
7. **Deferred-tools list** — prepends an `<available-deferred-tools>` meta
   user message.
8. **System prompt assembly** —
   `[getAttributionHeader, getCLISyspromptPrefix, ...systemPrompt,
   advisorInstructions?, chromeInstructions?].filter(Boolean)`, then
   `buildSystemPromptBlocks(...)` adds cache-control markers.
9. **Sticky beta-header latches** — `afkHeaderLatched`,
   `fastModeHeaderLatched`, `cacheEditingHeaderLatched`,
   `thinkingClearLatched`: once sent, kept for the session to avoid
   cache-busting; cleared on `/clear`/`/compact`.
10. **`paramsFromContext(retryContext)`** — builds the final
    `BetaMessageStreamParams`: `model`, `messages` (with
    `addCacheBreakpoints`), `system`, `tools`, `tool_choice`, `betas`,
    `metadata`, `max_tokens`, `thinking`, `temperature` (only when thinking
    disabled), `context_management`, `extraBodyParams`, `output_config`,
    `speed`.

The call is wrapped in `withRetry(getAnthropicClient(...), async (anthropic,
attempt, context) => {...})` (line 1869). Headers include
`CLIENT_REQUEST_ID_HEADER` (first-party only) and W3C `traceparent`/
`tracestate`. `timeout: false` when `API_FORCE_IDLE_TIMEOUT` is set (a
Vertex/Foundry stalled-stream workaround).

## Event handlers (lines 2114–2432)

The `for await (const part of stream)` switch accumulates state into
`newMessages: AssistantMessage[]`, `partialMessage`, `contentBlocks[]`,
`usage`, `stopReason`, `ttftMs`, `costUSD`.

### `message_start`
`partialMessage = part.message`; `ttftMs = Date.now() - start`;
`usage = updateUsage(usage, part.message?.usage)`.

### `content_block_start`
Initializes `contentBlocks[part.index]`:
- **`tool_use`** → `{ ...block, input: '' }` (string, not object).
- **`text`** → `{ ...block, text: '' }`.
- **`thinking`** → `{ ...block, thinking: '', signature: '' }`. The signature
  is initialized so the field exists even if `signature_delta` never arrives.
- **`server_tool_use`** → same as tool_use; an `advisor` name sets
  `isAdvisorInProgress`.

### `content_block_delta`
Accumulates into `contentBlocks[part.index]`:
- **`input_json_delta`** → `contentBlock.input += delta.partial_json`
  (**partial-JSON string accumulation**, line 2246). Not parsed per-delta.
- **`text_delta`** → `contentBlock.text += delta.text`.
- **`thinking_delta`** → `contentBlock.thinking += delta.thinking` — extended
  thinking accumulation.
- **`signature_delta`** → `contentBlock.signature = delta.signature` —
  thinking signatures are model-bound; stripped before fallback retry
  (`stripSignatureBlocks`).
- **`connector_text_delta`** (gated `CONNECTOR_TEXT`) → accumulates.
- **`citations_delta`** → TODO (ignored).

### `content_block_stop`
Builds an `AssistantMessage` from `partialMessage` +
`normalizeContentFromAPI([contentBlock])`, pushes to `newMessages`, and
**yields it** (line 2345). This is the token-by-token UI delivery point — one
assistant message per completed content block. (The per-block granularity, not
per-delta, is why the UI updates per content block.)

### `message_delta`
`usage = updateUsage(usage, part.usage)`; `stopReason = part.delta.stop_reason`.
It **directly mutates** `newMessages.at(-1).message.usage`/`.stop_reason`
(line 2381) rather than replacing, so the lazy transcript-write queue's held
reference captures final values. Handles `max_tokens` and
`model_context_window_exceeded` (→ `max_output_tokens` recovery path).

### `message_stop`
No-op.

Every event is also re-yielded as `{ type: 'stream_event', event: part }`
(line 2434) — consumed by `QueryEngine` for usage tracking and by
`includePartialMessages` callers for live streaming.

## How tokens reach the UI

```
queryModel yields → queryModelWithStreaming (VCR) → deps.callModel
   → queryLoop's for-await → query() yields
       → REPL onQueryEvent(event)  /  QueryEngine switch
```

`content_block_stop`-produced `AssistantMessage`s are what render
token-by-token. The REPL's `onQueryEvent` updates React state (messages,
spinner, permission prompts) as events arrive.

The live streaming text is held in a module-level external store,
`src/components/streamingTextStore.ts` (`streamingTextStore`), not in REPL
React state. Only the `<StreamingPreview>` leaf subscribes via
`useSyncExternalStore`, so each token re-renders that leaf alone — not the
entire REPL tree (2.1.203 perf fix: previously every token re-rendered the
whole screen). The store is reset to `null` on query end / interrupt.

## Mid-stream finalization

On overloaded / server-error / idle-timeout **mid-stream** (lines 2599–2620):
if partial output (text/tool_use) was already yielded, the partial is
**finalized** — a synthesized stop_reason, a
`tengu_streaming_partial_finalized` event, and an incomplete-response notice
are appended — rather than discarded. This avoids duplicate content and double
tool execution.

## Streaming tool execution

`src/services/tools/StreamingToolExecutor.ts` (`export class
StreamingToolExecutor`) lets tools start executing while the model is still
streaming the rest of its response:

- `addTool(block, assistantMessage)` — registers a tool as soon as its
  `tool_use` block arrives.
- `getCompletedResults()` — sync generator draining finished results.
- `getRemainingResults()` — async generator draining after streaming ends.
- `discard()` — for fallback/abort.

`streamingToolExecution` is **on by default** (`src/query/config.ts`
`buildQueryConfig()`).

## Streaming-fallback tombstoning

If `onStreamingFallback` fired during a request, orphaned partial assistant
messages (especially thinking blocks with invalid signatures) are yielded as
`tombstone` events and cleared before the fallback retry (query.ts lines
756–785). Thinking signatures are stripped via `stripSignatureBlocks` before
retrying on a different model, since signatures are model-bound.

## Multi-provider support

`getAnthropicClient(...)` (`src/services/api/client.ts` line 123) returns a
different SDK client per `getAPIProvider()`:

| Provider | SDK / transport |
|---|---|
| `firstParty` (default) | `new Anthropic(...)` against `ANTHROPIC_BASE_URL` |
| `bedrock` | `@anthropic-ai/bedrock-sdk` → `AnthropicBedrock` |
| `vertex` | `@anthropic-ai/vertex-sdk` + `google-auth-library` → `AnthropicVertex` |
| `foundry` (Azure) | `@anthropic-ai/foundry-sdk` |
| `anthropic_aws` | `Anthropic` SDK against `aws-external-anthropic.${region}.api.aws` |
| `mantle` | `Anthropic` SDK against `bedrock-mantle.${region}.api.aws` |
| `gateway` | custom gateway |

Provider selection (`src/utils/model/providers.ts`): env-var priority chain
`CLAUDE_CODE_USE_BEDROCK` → `CLAUDE_CODE_USE_FOUNDRY` →
`CLAUDE_CODE_USE_ANTHROPIC_AWS` → `CLAUDE_CODE_USE_MANTLE` →
`CLAUDE_CODE_USE_VERTEX` → default `firstParty`.

## Key files

| File | Role |
|---|---|
| `src/services/api/claude.ts` | `queryModel` / `queryModelWithStreaming` — streaming + param building |
| `src/services/api/client.ts` | `getAnthropicClient` — multi-provider client factory |
| `src/services/api/withRetry.ts` | `withRetry`, `FallbackTriggeredError` |
| `src/services/tools/StreamingToolExecutor.ts` | Overlap stream + tool execution |
| `src/utils/model/providers.ts` | `getAPIProvider()` — provider selection |
| `src/utils/betas.ts` | `getMergedBetas`, `getModelBetas` |
| `src/utils/api.ts` | `toolToAPISchema`, `appendSystemContext`, `CacheScope` |
| `src/utils/tokens.ts` | Token counting (see [token-management.md](./token-management.md)) |
