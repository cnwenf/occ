# impl-d1-item11 — CL:39 (2.1.287) `--include-partial-messages` cut-short `message_stop` flush

**Verdict: PORTED (4 of 4 official v287-added terminal call sites; 3 v286-baseline retry sites NO-SURFACE).**
Byte-verified against the live official 2.1.287 linux-x64 ELF (`/tmp/cc-diff-287/v287/package/claude`).
File lane respected: only `src/services/api/claude.ts` (+147 / −0, pure insertions — no existing line altered, nothing reverted) and one new test file `src/services/api/__tests__/partialMessagesFlush287.test.ts`.

---

## 1. Needle re-verification (official 2.1.287 ELF, read-only)

| Needle | Official bytes (verified) | Offset |
|---|---|---|
| Suppression set `INo` | `INo=new Set(["tool_use","server_tool_use","mcp_tool_use"])` | @208171771 |
| Flush generator `Um` | `function*Um(){if(!nf)return;let $s=N_?null:Ph;if(nf=!1,Ph=null,N_=!1,$s!==null)yield{type:"stream_event",event:{type:"content_block_stop",index:$s}};yield{type:"stream_event",event:{type:"message_stop"}}}` | ~208.25M |
| Envelope state decl | `nf=!1,Ph=null,N_=!1` | (same region) |
| State machine | `message_start)nf=!0,Ph=null,N_=!1; else if(...content_block_start)Ph=Fs.index,N_=INo.has(Fs.content_block.type); else if(...content_block_stop)Ph=null,N_=!1; else if(...message_stop)nf=!1,Ph=null,N_=!1` | loop body |
| `Um()` call count | 9 total (= 7 `yield*Um()` sites + 1 def + 1 in the `function*Um` token) | — |

v286 baseline `Bl` (@206228059) had **no** `INo` suppression and flushed on only **3** error/retry paths; v287 renames it `Um`, adds the tool-block suppression, and adds **4** terminal call sites (`Um()×7` vs `Bl()×3`). CL:39 is exactly this v287 delta.

---

## 2. Changed sites (`src/services/api/claude.ts`, before → after line numbers)

All additions; the "before" column is the pre-edit anchor from the task brief (line numbers drifted because sibling ports landed since — located by content with `rg -n`).

| # | What | Before (anchor) | After (line) |
|---|---|---|---|
| S1 | `export const OPEN_BLOCK_TOOL_TYPES = new Set(['tool_use','server_tool_use','mcp_tool_use'])` (≡ `INo`) | new | `claude.ts:1386` |
| S2 | `export interface StreamEnvelopeState { messageEnvelopeOpen; openBlockIndex; openBlockIsTool }` (≡ `nf`/`Ph`/`N_`) | new | `claude.ts:1401` |
| S3 | `export type StreamCloseEvent` (the two synthetic `stream_event` shapes) | new | `claude.ts:1411` |
| S4 | `export function* flushStreamClose(state)` — the pure `Um` generator (single source of truth) | new | `claude.ts:1435` |
| S5 | `let openBlockIsTool = false` local (+ comment) alongside `openBlockIndex` | `~2371` | `claude.ts:2451` |
| S6 | `function* flushStreamCloseLocal()` closure adapter (projects locals → state, delegates to S4, writes reset back) | new | `claude.ts:2469` |
| S7 | per-attempt reset adds `openBlockIsTool = false` | `~2577` | `claude.ts:2678` |
| S8 | `content_block_start`: `openBlockIsTool = OPEN_BLOCK_TOOL_TYPES.has(part.content_block.type)` | `~2798` | `claude.ts:2903` |
| S9 | `content_block_stop`: `openBlockIsTool = false` | `~2955` | `claude.ts:3062` |
| C-G | **call site G** `yield* flushStreamCloseLocal()` — normal completion | `~3169`→after | `claude.ts:3292` |
| C-B | **call site B** `yield* flushStreamCloseLocal()` — responseAlreadyComplete return | `~3340` | `claude.ts:3463` |
| C-C | **call site C** `yield* flushStreamCloseLocal()` — partial-finalize (before notice yield) | `~3360` | `claude.ts:3502` |
| C-F | **call site F** `yield* flushStreamCloseLocal()` — non-streaming fallback (before request) | `~3500` | `claude.ts:3646` |

The `message_stop` case (`claude.ts:3167`, `messageEnvelopeOpen = false`) and the single real `stream_event` forwarding yield (`claude.ts:~3199`, `{ type:'stream_event', event: part, … }`) are **unchanged** — the synthetic events from `flushStreamCloseLocal()` use the identical wrapper shape (`{ type:'stream_event', event:{…} }`, assignable to `StreamEvent = { type:string; [key:string]:unknown }`) and flow out through the same generator → `queryModelWithStreaming` → `QueryEngine.ts:946` `case 'stream_event'` includePartialMessages forwarding path.

Guard (item 6): `flushStreamClose` returns immediately when `!state.messageEnvelopeOpen` (the official `nf` check). A normal complete stream receives a real `message_stop` (clears `messageEnvelopeOpen` at `:3167`), so every terminal flush is a **no-op** — verified by test (5c).

---

## 3. Official call-site → OCC-site mapping

Official v287 has 7 `yield*Um()` sites. 3 are the v286-inherited `Bl()` error/retry baseline; **4 are the v287 additions** (the CL:39 delta). Mapping:

| Official site (verbatim) | Class | OCC counterpart | Status |
|---|---|---|---|
| **G** `…}finally{…}ch("stream_completed",Zi??null,Au!==null?il:null),yield*Um();break e` @208282711 | v287-added | Normal-completion fall-through, after the `StreamTruncatedError` guard, before the stall summary — `claude.ts:3292` | **PORTED** |
| **B** `if(Xmn&&sS&&wa===null){…tengu_streaming_close_after_complete…ch("stream_completed",Zi??null,il),yield*Um();break e}` @208275702 | v287-added | `responseAlreadyComplete` early-return (close-after-complete) — `claude.ts:3463` (before `return`) | **PORTED** |
| **C** `…has_output:ji,synthesized_stop_reason:c(Bge),cause:SYe…oM(),yield*Um();let EYe=ns({content:ji?…` | v287-added | Partial-finalize path (`tengu_streaming_partial_finalized`, synthesizes `stop_reason`, yields incomplete-response notice) — `claude.ts:3502`, placed **after** the analytics log and **before** the notice yield, matching official order (`yield*Um()` precedes `ns({content:…})`) | **PORTED** |
| **F** `…XL=Zi,Zi=null,yield*Um(),yield*Lge(),yield{type:"streaming_fallback_began",cause:Ga}` | v287-added | Mid-stream non-streaming fallback — `claude.ts:3646`, immediately before `yield* executeNonStreamingRequest`. The `streaming_fallback_began` **yielded message is NO-SURFACE** in OCC (it signals fallback via the `onStreamingFallback()` callback + `tengu_streaming_fallback_to_non_streaming` analytics, not a stream message); the **flush itself is ported** at the same point. | **PORTED (flush); message NO-SURFACE** |
| **A** `…after_thinking_only:!0…oM(),Zf(),yield*Um(),Zi=null,Uu…` | v286 baseline | — | **NO-SURFACE** (see §5) |
| **D** `…if(Rl&&Fv!=="credited")oM(),yield*Um();Zi=null…` | v286 baseline | — | **NO-SURFACE** (see §5) |
| **E** `…ch("attempt_errored",Zi??null,null),yield*Um(),Zi=null,LW=!0…` | v286 baseline | — | **NO-SURFACE** (see §5) |

Task enumeration cross-walk: (a) normal completion = **G**; (b) partial-finalize return = **C**; (c) fallback-began = **F**; (d) synthesized-stop_reason terminal = **C** (OCC's partial-finalize *is* the synthesized-stop_reason path — it sets `lastYielded.message.stop_reason = tool_use|end_turn` then logs `blocks_yielded`). **B** (responseAlreadyComplete) is an additional distinct v287 site the report's 3-point sketch folded into "normal completion"; ported separately to its own OCC counterpart.

### Truncation-throw path (item 4 IMPORTANT note)
OCC's clean-but-open `throw new StreamTruncatedError()` (`claude.ts:3276–3282`) is **left as-is — no flush added**. Verified faithful: the official post-loop throw sequence (`…if(Rl&&wa!==null)throw…; if(!ef||…)throw…tengu_stream_no_events…; if(Rl&&!(Au!==null&&sS))throw t("Stream ended cleanly mid-response…"),new qnr`) contains **no `yield*Um()`** — official throws without flushing here too. The thrown error lands in the catch block, which then reaches a flushing terminal (B/C/F) in the normal case, so the consumer still gets its `message_stop` via the official-equivalent path.

---

## 4. Tests

New file `src/services/api/__tests__/partialMessagesFlush287.test.ts` (matches the `__tests__/*NNN.test.ts` convention; closest sibling `streamIntegrity281.test.ts`).

**Block A — pure unit tests of the exported `flushStreamClose(state)` (≡ `Um`) + `OPEN_BLOCK_TOOL_TYPES` (≡ `INo`):** no network, no mocks.
- (1) envelope open + open non-tool block → `content_block_stop(index)` then `message_stop`; state reset asserted.
- (2) envelope open + open **tool** block → **only** `message_stop` (suppression); (2b) open envelope, `index null` → only `message_stop`.
- (3) envelope closed → nothing; state untouched.
- (4) double-flush idempotent → second call yields nothing.
- `OPEN_BLOCK_TOOL_TYPES` membership: contains exactly `tool_use`/`server_tool_use`/`mcp_tool_use` (size 3), excludes `text`/`thinking`/`redacted_thinking`.

**Block B — realistic harness (real `queryModelWithStreaming` over an HTTP-layer fetch mock, VCR pass-through, no network):** verifies the state-machine wiring (item 5) and that synthetic events traverse the real forwarding path.
- (5a) `content_block_start(tool_use)` + terminal `message_delta` + clean EOF (no `content_block_stop`/`message_stop`) → flushed stream ends in `message_stop`, **no** `content_block_stop` (proves `openBlockIsTool` set per type at `content_block_start`).
- (5b) `content_block_start(text)` + terminal `message_delta` + clean EOF → flush appends `content_block_stop(index 0)` then `message_stop` (proves `openBlockIndex` set, `openBlockIsTool` false).
- (5c) fully-closed stream (real `content_block_stop` + `message_stop`) → exactly one `content_block_stop` and one `message_stop`, no synthetic duplicates (proves `message_stop` clears the envelope → flush no-op; `content_block_stop` clears `openBlockIndex`).

**Results:**
- `bun test src/services/api/__tests__/partialMessagesFlush287.test.ts` → **9 pass / 0 fail / 27 expect()**.
- With closest regressions `streamIntegrity281` + `outputContentFiltered285` + `nonstreamingTimeoutRetries285` → **50 pass / 0 fail / 141 expect()** (4 files).
- Retry/fallback regressions `withRetryIntegration286` + `retryWatchdogRetryAfter281` + `modelCallRetries286` → **50 pass / 0 fail / 432 expect()** (3 files).
- `bun build src/services/api/claude.ts --target bun` → bundles clean (5593 modules, exit 0).
- `biome lint` on the two files → 3 warnings, **all pre-existing** `suppressions/unused` on `biome-ignore` comments at `:746/:1164/:2581` (untouched by this diff — `git diff` shows 0 deletions); **no new lint findings** in added code.

---

## 5. Deviations / PARTIALs / NO-SURFACE (honest boundaries)

1. **Naming.** The exported pure generator is `flushStreamClose(state)` (the `Um` equivalent, unit-tested). The closure-internal adapter called at the 4 terminal sites is `flushStreamCloseLocal()` — it projects the local `let`s (`messageEnvelopeOpen`/`openBlockIndex`/`openBlockIsTool`) into a `StreamEnvelopeState`, delegates emission to the single-source-of-truth `flushStreamClose`, and writes the reset state back. This keeps DRY (no duplicated event shapes) while matching OCC's existing separate-`let` state style (the task said add `openBlockIsTool` "alongside `openBlockIndex`", not refactor into a state object). Call sites read `yield* flushStreamCloseLocal()`.

2. **In-place mutation.** `flushStreamClose` mutates its `state` argument — a faithful port of official `Um`, which mutates the closure variables `nf`/`Ph`/`N_`. OCC's existing stream-integrity code already mutates these locals directly (`messageEnvelopeOpen = false`, etc.), so mutation is the established pattern here; the global immutability rule is overridden by byte-faithful-port priority (documented in the function JSDoc).

3. **`N_` lifecycle at `message_start`/`message_stop` — minor, semantically-equivalent divergence.** Official clears `N_` (and `Ph`) at `message_start` (`nf=!0,Ph=null,N_=!1`) and `message_stop` (`nf=!1,Ph=null,N_=!1`). OCC sets/clears `openBlockIsTool` only at `content_block_start` (set per type), `content_block_stop` (clear), the flush (reset), and the per-attempt reset (`:2678`) — per the task's explicit instruction. This is **semantically equivalent**: the flush is gated on `messageEnvelopeOpen`, and `message_stop` already clears that flag (`:3167`), so a stale `openBlockIsTool`/`openBlockIndex` after `message_stop` can never affect output; `message_start` precedes any `content_block_start` within an attempt (state is `false`/`null` from the per-attempt reset). I deliberately did **not** add `openBlockIndex`/`openBlockIsTool` clearing to OCC's `message_stop` case because OCC's pre-existing #018 port does not clear `openBlockIndex` there either (it clears at `content_block_stop`), and `openBlockIndex === null` is consulted by the `responseAlreadyComplete` check (`:3416`) — changing it is out of scope and risks the #018–#021 logic. Nothing reverted.

4. **A/D/E (3 v286-baseline retry flush sites) — NO-SURFACE, and out of CL:39 scope.** These are the pre-existing v286 `Bl()` error/retry flushes (`continue e` retry paths), **not** part of the v287 delta. OCC has no counterpart: OCC's streaming retry lives at **stream creation** (the `withRetry` generator drained at `:2557–2566`, before any `message_start`); the `for await` over the stream is **not** re-run per attempt — on mid-stream failure the catch block either finalizes (C), falls back to non-streaming (F), returns (B), or rethrows to the outer error handler. Envelope state is reset per-attempt at `:2668–2679`. So there is no "flush-before-streaming-retry-continue" surface in OCC. (If a future item wants the SDK consumer to also receive a synthetic `message_stop` before a *pure API-level retry*, that is a separate v286-baseline gap, not CL:39.)

5. **`streaming_fallback_began` message — NO-SURFACE.** OCC does not yield a `streaming_fallback_began` stream message (it uses the `onStreamingFallback()` callback + analytics). Only the **flush** at that transition is ported (site F). The `Lge()`/`iYe()` helpers official yields around the message have no OCC equivalent and were not invented.

6. **Item 7 (CL:22 model-fallback suppression latch) — NOT ported** (STAGED pending prerequisites), per instruction. No suppression logic added beyond `openBlockIsTool`.
