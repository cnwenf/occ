# Cluster F — Session Durability / Headless / Resume / Scheduled Tasks (2.1.289 → 2.1.291)

Gap research for OCC (tracks official 2.1.289) vs official claude-code 2.1.290 + 2.1.291.
Forensic sources (read-only, never executed): `/tmp/cc289/package/claude` (md5 5c920e4c2e6c73c2858cc48e5123582e), `/tmp/cc290/package/claude` (md5 acc2b427816611d7c48666fd4b1cf9b7), `/tmp/cc291/package/claude` (md5 82c1f303d0dd7ef19d869f7b3d886043). 2.1.291 banner @~219753906: `VERSION:"2.1.291", BUILD_TIME:"2026-10-06T02:24:19Z", GIT_SHA:"f7d32cfe47f735a7e70c5cce1ff6044b24692b4c"`.

Verdict legend: **PORT** = actionable port recommended this round · **STAGED** = real gap, port deferred/gated · **NO-OP** = OCC architecture already produces the fixed behavior · **N-A** = surface absent in OCC (grep-proven).

## Verdict table

| # | Version | Changelog entry (abridged) | Verdict | OCC target |
|---|---------|---------------------------|---------|-----------|
| A | 2.1.291 | Last messages of a session could be lost when quitting (2.1.288 regression) | **PORT (removal)** | `src/utils/transcriptRewriteCoordinator.ts`, `src/utils/sessionStorage.ts`, `src/main.tsx` |
| B | 2.1.291 | Cloud sessions could drop answers to permission prompts | **STAGED** (narrow live surface) | `src/remote/RemoteSessionManager.ts`, `src/remote/SessionsWebSocket.ts` |
| C | 2.1.290 | `--json-schema` headless exits non-zero / `is_error:true` on success after post-delivery connection drop | **PORT** | `src/QueryEngine.ts`, `src/cli/print.ts` |
| D | 2.1.290 | `--include-partial-messages` reply stays open after interrupted turn | **PORT** (residual "interrupted" clause) | `src/services/api/claude.ts`, `src/query.ts` |
| E | 2.1.290 | Plan mode not restored on `--continue` / `--resume <id>` | **PORT** | `src/utils/sessionRestore.ts`, `src/main.tsx` |
| F | 2.1.290 | `/rewind` doesn't list a prompt sent while Claude was working | **PORT** | `src/components/MessageSelector.tsx` |
| G | 2.1.290 | Scheduled tasks not coming back on resume after compaction | **N-A / NO-OP** (dormant, different mechanism) | `src/utils/cronTasks.ts` (behind `AGENT_TRIGGERS`) |
| H | 2.1.290 | Recurring session-only tasks run extra time after sandboxed Bash (Linux) or after `scheduled_tasks.json` deleted | **STAGED** (dormant; deletion half reproducible) | `src/utils/cronScheduler.ts:440-459` |
| I | 2.1.290 | Foreground scheduled tasks never fire after ← / `/background` hand-off; extra run on resume/respawn/fork | **N-A** (← absent) / **NO-OP** (rest) | — |
| J | 2.1.290 | Resumed subagents/teammates lose earlier thinking + prompt cache after mid-run message | **NO-OP** (2 narrow caveats) | `src/tools/AgentTool/resumeAgent.ts` (watch) |
| K | 2.1.290 | Effort level changes when flagged message retried on fallback model with different saved level | **STAGED** (general fallback drift live; flagged-retry trigger absent) | `src/services/api/claude.ts:2117`, `src/query.ts:1050-1067` |
| L | 2.1.290 | Responsiveness while resuming large sessions | **STAGED** (larger refactor) | `src/main.tsx:3544-3566,4107-4165`, `src/replLauncher.tsx` |

---

## A. (2.1.291) Last messages lost when quitting — 2.1.288 regression — HIGHEST PRIORITY

### 官方机制 (byte forensics)

**The 290→291 fix is fully localized: official 2.1.291 REMOVED the entire 2.1.288 transcript rewrite↔load coordination barrier.**

Evidence (counts are `grep -aboF` occurrence counts against the raw ELFs):

| Anchor | cc289 | cc290 | cc291 |
|---|---|---|---|
| `loadWaitMs` | 4 | 5 | **0** |
| `abandonedLoads` | 4 | 5 | **0** |
| `lastProgressMs` | — | 5 | **0** |
| `Transcript rewrite stopped waiting` (string) | 2 (@99524452-region) | 2 (@99556336, @214505966) | **0** |
| `using X=await EI(path)` rewrite-lease sites | (lease fn named `wM` in 289) | 7 | **0** |

The lease function in cc290 (`function EI(` @214505608, verbatim):

```js
function EI(e){let n=ybe(e),r=E8e.of(F().host),s=[...r.loads.get(n)??[]].filter((w)=>!r.abandonedLoads.has(w)),
{promise:g,resolve:h}=Promise.withResolvers(),S=U0r(r.rewrites,n,g,h);while(s.length>0){let w=performance.now(),
H=[],W=0;for(let Y of s){if(Y.settled)continue;if(w-Y.lastProgressMs<r.loadWaitMs)H.push(Y);else r.abandonedLoads.add(Y),W++}
if(W>0)t(`Transcript rewrite stopped waiting for ${W} load(s) of file ${on(n)} after ${r.loadWaitMs}ms without progress`,
{level:"warn"});if(H.length===0)break;let q=Math.min(...H.map((Y)=>Y.lastProgressMs));
await Qe(Promise.all(H.map((Y)=>Y.done)),q+r.loadWaitMs-w),s=H}return S}
```

In cc290 the 7 lease call sites (span `214539720..214616154`, dump saved `/tmp/gap291/span290.txt`) were: `performRemoveByUuid` (tombstone removal — the splice path shown below), `performCompactTranscript`, `relocateSessionTranscript` (×2 nested), remote hydration, session-file create/materialize, CCR-v2 foreground hydration. Verbatim (cc290, span offset ~8375):

```js
async performRemoveByUuid(e,n,r){using s=await EI(e);let g=r!==void 0?z_(e):void 0; ...}
```

In cc291 the same span (`214494687..214570937`, `/tmp/gap291/span291.txt`) has **all 7 `using` declarations gone** (structural token counts: `using ` 10→3 — the 3 remaining are the English phrase "using the raw tail"; `await` 242→233):

```js
async performRemoveByUuid(e,n,r){let s=r!==void 0?G_(e):void 0; ...}
```

(The `EI` symbol in cc291 is a *different* function — minifier collision: `await EI(dir,{withFileTypes:!0})` is readdir. Verified all 8 cc291 `await EI(` sites are readdir calls.)

Everything else in the exit-durability machinery is **byte-identical (modulo renames) across 289/290/291** — verified region-by-region: `flushSessionStorageAtExit` (291 `Xgs` @214484199; 500 ms `xRn` backend race + sync re-stamp `QWr` on `process.on("exit")` + degraded-writer warning), `wT`/`kyn` append serializer (291 @214570937/@214571532), exit registries `He`/`pt` (`cleanup`/`preExitFlush`, 291 @~202162082), shutdown orchestrator (`...await ATe(); await Ghe(); await u0n()...` 291 @210190911), relaunch pre-exit-flush timeout (`$t(u0n(),2000,...)` 291 @216630533), held-results `zm`/`flushBeforeResult` (291 @229416512 vs 290 @229463271 — diff is renames only: `$R`→`KR`, `KR`→`VR`, `VR`→`GR`, `zR`→`YR`, `YR`→`JR`). Verbatim cc291 `flushSessionStorageAtExit` core:

```js
var xRn=500,Z0r=3;async function Xgs(){...await Qe(Promise.allSettled([...e.exitDrains].map(...)),500),
await e.project?.flush(),await kyn();let n=e.project,r=n?.exitReStampSource();
if(B()&&n!==null&&r!==void 0){if(await Qe(n.reStampAtExitAsync(r).then(()=>!0),xRn)!==!0)
t(`Exit re-stamp through the storage backend did not finish within ${xRn} ms; the synchronous re-stamp runs instead`,{level:"warn"})}
...finally{QWr();...}}
```

**Mechanism of the bug/fix:** the 2.1.288 barrier made every whole-file rewrite *first wait (progress-polled, `loadWaitMs` per round) for in-flight transcript loads of the same path*. When quitting while a load was registered (resume picker preview, classifier scan, dedupe read), an exit-path rewrite (tombstone removal / compaction / relocation / owed-line chain feeding `reStampAtExitAsync`) could stall inside the lease wait. The exit budget is only `xRn=500` ms for the backend re-stamp (plus the 500 ms `exitDrains` race), so the flush timed out, the sync re-stamp ran against a stale view, and queued trailing entries were lost. 2.1.291's fix: rip the barrier out — rewrites proceed immediately; torn-tail protection is left to the retained `tornTailToSeal`/`sealTornTailSync`/`owedLines` machinery (all still present in 291: `sealTornTailSync` @214491054/214494450/214494686, `tornTailToSeal` @214488413, `appendOwedEntryAtExit` @214483363, `sessionRewritesPending` 7 hits, `compactAwaitingSummary` 10 hits — unchanged counts).

### OCC 现状

- **OCC ported the 2.1.288 barrier verbatim** — `src/utils/transcriptRewriteCoordinator.ts` (whole file, 199 lines; header cites "port of the official Claude Code v2.1.288 module @211467183", `LOAD_WAIT_MS = 5000` at :46, `acquireRewriteCoordination` :128-156, `acquireLoadCoordination` :165-177, warn message byte-exact :150).
- Rewrite call sites: `src/utils/sessionStorage.ts:1069` (`removeMessageByUuid` — comment at :1057 quotes official `performRemoveByUuid(e,n,r){using s=await wM(e);...}` @211508839), `:1818` (remote hydration), `:1877` (CCR-v2 fg hydration), `:1918` (agent-file hydration). Load side: `:4211` in `loadTranscriptFile`.
- Quit path: `renderAndRun` (`src/interactiveHelpers.tsx:98-103`) awaits `root.waitUntilExit()` then `gracefulShutdown(0)`; `/exit` → `src/commands/exit/exit.tsx:30` `await gracefulShutdown(0,'prompt_input_exit')`. `gracefulShutdown` runs `runCleanupFunctions()` (which includes the `getProject()`-registered `project.flush()` + `reAppendSessionMetadata()`, `sessionStorage.ts:604-631`) **raced against a 2000 ms timeout whose failure is silently ignored**, then `forceExit`.
- **Risk 1 (the official regression, amplified):** OCC's rewrite wait is `LOAD_WAIT_MS=5000` but the cleanup race is **2000 ms**. A quit while a coordinated load of the same transcript is in flight (e.g. `removeMessageByUuid` fired fire-and-forget from rewind, or a hydration rewrite pending) can push `flush()`/`reAppendSessionMetadata()` past the 2000 ms race → cleanup abandoned silently → the 100 ms-debounced write queue (`FLUSH_INTERVAL_MS=100`, `enqueueWrite`/`drainWriteQueue` :780-869) exits with pending entries → **trailing messages lost**. OCC has **no synchronous exit re-stamp** equivalent to official `QWr` on `process.on("exit")` (grep: `process.on('exit')` handlers exist only for cursor reset `main.tsx:628`, stats, telemetry, processTreeKill, growthbook, pidLock — none touches the transcript).
- **Risk 2 (OCC-specific sync-exit hole):** `src/main.tsx:631-638` registers `process.on('SIGINT', ...)` **early in `main()`** that calls bare `process.exit(0)` in non-print mode. `setupGracefulShutdown` registers its SIGINT listener later (`src/utils/gracefulShutdown.ts:261-272`, → `void gracefulShutdown(0)`). Node fires listeners in registration order and `process.exit()` terminates synchronously inside the first listener → the graceful listener never runs → **SIGINT (`kill -INT`, terminal-generated SIGINT when raw mode is off) exits without any transcript flush**, losing up to the full debounce window + in-flight appends.
- Raw `process.exit` elsewhere: `setup.ts` (pre-REPL error paths, exit(1) — no transcript yet, benign), `interactiveHelpers.tsx:79` (`exitWithMessage` — fatal-error path *after* optional `beforeExit`; used pre-conversation, benign), `main.tsx` subcommand error paths (benign), `print.ts` SIGINT → own handler → `gracefulShutdown` (OK).

**Verdict: OCC CAN lose trailing messages on quit** — via (1) the 288-barrier stall it faithfully ported (the exact regression official 291 removed) amplified by the 5000 ms wait vs 2000 ms cleanup race, and (2) the main.tsx synchronous SIGINT exit with no flush and no sync exit seal.

### 判定

**PORT (removal port, 2.1.291 alignment).** Two changes, both small:

1. **Remove the rewrite-wait barrier** (align to 291): delete `src/utils/transcriptRewriteCoordinator.ts` and its 5 call sites (`sessionStorage.ts:1069/1818/1877/1918/4211` + import :89-92), replacing each `try { handle = await acquireRewriteCoordination(f) ... } finally { handle[Symbol.dispose]() }` with the bare operation. Keep `sessionRewritesPending`/`compactAwaitingSummary`-equivalent logic untouched (official kept them). Update/remove `test/**` coordinator tests and the `removeMessageByUuid` comment block (:1057-1067) to cite 2.1.291 instead of 2.1.288 #12.
   - Note the tradeoff the official made: removing the barrier re-exposes 288's original "resume loaded a transcript cut short by a concurrent rewrite" race; official judged torn-tail sealing (`tornTailToSeal`/`sealTornTailSync`) sufficient. OCC should port faithfully rather than keep a mechanism upstream deleted — but if the team wants belt-and-braces, the minimal alternative is capping `LOAD_WAIT_MS` below the 2000 ms cleanup race (e.g. 500 ms, matching official `xRn`). Faithful removal is the recommended path.
2. **Close the SIGINT sync-exit hole:** in `src/main.tsx:631-638`, replace `process.exit(0)` with `void gracefulShutdown(0)` (or drop the handler entirely once `setupGracefulShutdown()` is guaranteed registered before SIGINT can arrive — but `main()` runs before REPL launch, so converting the handler is safer). Optionally add a synchronous last-resort tail seal on `process.on('exit')` mirroring official `QWr` semantics (flush is async in OCC, so a true sync seal would need `appendFileSync` of the pending queue — evaluate separately; not required for 291 parity).

### 测试计划

- Unit: `sessionStorage` — `removeMessageByUuid`/hydration rewrites no longer register coordination (coordinator module deleted; grep test); existing transcript write/dedupe tests stay green.
- Unit: `gracefulShutdown` — SIGINT emission in non-print mode routes to `gracefulShutdown(0)` (spy), never bare `process.exit`.
- E2E (real REPL, per project rules): (a) interactive session, send a message, wait for reply, `/exit` immediately (<100 ms after final chunk) → assert the transcript JSONL on disk contains the final assistant entry; (b) same via `kill -INT $PID` → assert final entries present + exit code 0; (c) rewind a message (fires `removeMessageByUuid`) and `/exit` within the same second → assert no loss and no 5 s stall (process exits < 2.5 s after /exit); (d) `-p` print mode with SIGINT → existing print handler unchanged.
- Regression: resume-after-rewrite race (the 288 #12 scenario) — concurrent `loadTranscriptFile` during `removeMessageByUuid` must not crash; document that torn-tail tolerance is now the only protection (same as official 291).

---

## B. (2.1.291) Cloud sessions drop answers to permission prompts

### 官方机制

Cloud ask/answer relay hardening: cc291 `stale_answer` @94151596/@205922518/@226551100/@226565199 (cc289 already had 13 hits — the machinery predates 291; the 290→291 string churn adds the drop-reason taxonomy `stale_answer`/`host_stopped`/`record_evicted`/`ask_superseded` and `windowMs`/`dated_ask_age` staleness judgment — heavy presence in `/tmp/gap291/new-in-291.txt`). Semantics: the cloud host no longer silently discards an answer that arrives for an ask it considers live; stale answers are classified with a reason and the ask is re-issued or the answer re-delivered instead of vanishing.

### OCC 现状

OCC **does** have a cloud/remote-session surface (contrary to the initial "likely N/A" hypothesis): `src/remote/RemoteSessionManager.ts` (pendingPermissionRequests map :97, control_request handling :189-215, `respondToPermissionRequest` :248-283 — **deletes the pending entry at :262 then calls `sendControlResponse` at :282**), `src/remote/SessionsWebSocket.ts:328-336` — `sendControlResponse` **silently returns when `state !== 'connected'`** (logError + drop, no queue/retry), `src/hooks/useRemoteSession.ts:423-433` — `onReconnecting` clears running tasks but does **not** reconcile pending permission answers. So an answer given during a reconnect window is dropped exactly like the upstream bug, and worse, the pending entry is already deleted so a server re-ask creates a new requestId the old UI callback can't answer.

Reachability: `--remote` TUI backend gated on `tengu_remote_backend` (defaults false — GrowthBook stubbed, `growthbook.ts:734`; `main.tsx:3868-3876` prints URL + exits); `/teleport` = disabled stub (`src/commands/teleport/index.js`); `--remote-control` gated on `BRIDGE_MODE` (not in the 6-flag allowlist → dead). **Live-ish paths:** `occ assistant` bridge-attach (`main.tsx:3700-3745`) and `ultrareview` cloud review — both exercise RemoteSessionManager/SessionsWebSocket.

### 判定

**STAGED** — the pattern is real in `src/remote/` but the exposed surface is narrow (assistant attach / ultrareview only in default builds). Prior rounds classed cloud items NO-OP PLATFORM (`docs/upstream-version-gap-occ144-2026-10.md:145` #53); given the code above that is only defensible for the flag-dead paths.

移植方案: in `respondToPermissionRequest`, do not delete the pending entry until the send actually succeeds; when `sendControlResponse` cannot send, enqueue the response and flush on `onReconnecting`→connected (with the upstream reason taxonomy: mark answers whose ask is re-issued with a new requestId as `stale_answer` and surface the re-ask to the UI instead of dropping). 测试计划: unit — disconnect between prompt and answer → answer delivered after reconnect; server re-ask with new id → old answer classified stale, UI re-prompts; e2e against a mock wss server that drops the connection mid-answer.

---

## C. (2.1.290) `--json-schema` exits non-zero with `is_error:true` on success after post-delivery drop

### 官方机制

Official headless semantics (changelog `docs/gap-research-291/changelog-entries-290.txt:23`): once the StructuredOutput tool has delivered the validated structured output, a subsequent connection drop on the follow-up turn must not flip the result envelope to error — the run already succeeded; exit stays 0. Official held-result envelope machinery anchors verified identical 290↔291 (`flushBeforeResult(){return zm(this.sessionMirror,this.flushSessionStorage)}` 290 @229463271 / 291 @229416512), i.e. the 290 fix lives in the result-envelope decision (is_error computation), not the flush path. `structured_output` in cc290 @93956516/95325346.

### OCC 现状

`--json-schema` fully wired: flag `src/main.tsx:1063`, parse+synthetic tool `:2232-2256`, capture `src/services/tools/toolExecution.ts:1295-1304` → `src/QueryEngine.ts:1009-1012` (`structuredOutputFromTool`). **The pre-fix pattern is intact:** `QueryEngine.ts:1339-1359` computes `is_error: isApiError` where `isApiError = Boolean(result.isApiErrorMessage)` with **no guard on `structuredOutputFromTool`** (grep: the identifier appears only at :812, :1011, :1353 — never in the error decision). A mid-turn-2 drop yields an `isApiErrorMessage:true` assistant message (`claude.ts:3502-3507` J1 partial-finalize, or `:3859/3917` non-streaming-fallback failure) → envelope `subtype:'success', is_error:true, structured_output:{...}` → `print.ts:1092-1094` exits **1**.

### 判定

**PORT.** 移植方案: in `QueryEngine.ts` result-envelope construction, when `structuredOutputFromTool !== undefined`, emit `is_error: false` regardless of a trailing API-error message (the structured output was delivered — the run succeeded); keep the error message in the stream for diagnostics. 测试计划: unit — envelope with structured output + isApiErrorMessage → `is_error:false`; e2e `-p --json-schema` against a stub API that delivers the tool call then drops turn 2 → exit code 0, stdout result carries `structured_output`.

---

## D. (2.1.290) `--include-partial-messages` reply stays open after turn end (interrupted clause)

### 官方机制

Every stream-terminal path must close the forwarded envelope (`content_block_stop` + `message_stop`) — official `Um`/flush semantics. OCC already byte-ported the 2.1.287 CL:39 flush (`flushStreamClose`, 4 call sites). 290 extends the close to the *interrupted* turn (changelog `changelog-entries-290.txt:123` region).

### OCC 现状

Covered: cut/partial-finalize (`claude.ts:3502`), close-after-complete (`:3463`), clean-terminal (`:3292`), non-streaming fallback pre-flush (`:3646`) — tests `partialMessagesFlush287.test.ts`. **Not covered:** user abort — `APIUserAbortError` rethrow (`claude.ts:3362-3379`) and swallow (`:3854-3857`, `:3910-3915` `releaseStreamResources(); return`) emit nothing; `query.ts:1183-1228` interrupted unwind and `print.ts:2973-2991`/`:1154-1160` interrupt handlers emit no `stream_event` close (grep-proven: `flushStreamClose` absent from query.ts/QueryEngine.ts/print.ts; zero `message_stop` in query.ts/print.ts). Also `disableFallback` rethrow (`:3560-3585`) and output-content-filter rethrow (`:3525-3545`) skip the flush.

### 判定

**NO-OP / N-A**（CORRECTED 2026-10-07 — 原 PORT 指令经官方 ELF 复核后作废；per `aligning-with-official-binary`：read the binary, not the subagent summary）.

**原 §D 移植指令与官方 2.1.290 二进制矛盾，不得实施**（会 INVENT 官方没有的行为）：

- 官方 user-abort 路径**不调用** `Wh()`（=flushStreamClose/envelope-close）。cc290 @212886852 字节证据：`if(wa instanceof $d){if(g.aborted)throw yield*fz(),t("Streaming aborted by user: …"),wa;else if(!Ap){…SDK timeout…}}`。`fz()`（@212868091）= `Ig("aborted",…) telemetry` + `OE()` server_fallback drain + `tk()` keepPartialMessageOnAbort partial-message（仅 `querySource==="sdk"||keepPartialMessageOnAbort===true`）+ `tengu_advisor_tool_interrupted`。clean-exit abort 同形：`if(g.aborted){yield*fz();return}`（@212882820）。cc289 完全相同（`OT()`/`G9()` @209697136、@209693188）——user-abort 路径 289→290 **零变化**，两版都不 flush envelope。
- 因此 OCC 现状（abort swallow `:3854/:3910`、abort rethrow `:3379` 不 flush）**已经是官方 parity**；`disableFallback`/output-filter rethrow 不 flush 亦然。原指令要求在这些点加 `flushStreamCloseLocal()` 属 INVENT，禁止。

**changelog :123（"reply stays open after turn ended when its stream was cut, interrupted or fell back to non-streaming"）的真实 cc290 delta = 中途 RETRY 点 +2 flush**（`yield*Wh()` 站点 cc289 7 → cc290 9）：

1. **新 `tengu_streaming_output_filter_retry` 路径**（telemetry 0→2 hits；cc290 @212893568 `…Q_(),Ig("attempt_errored"…),td)rp();yield*Wh(),Ji=null;continue e`）——即"输出内容过滤在 thinking 中截断→重试一次"新特性，**= cluster E item #9，已判 STAGED**（新特性，非 flush 接线）。
2. **watchdog/undoLastCount before-content retry**（cc290 @212895753 `if(!$i&&Ou===null&&!m_.outOfApiAttempts()&&yve(wa)!==void 0){…yield*Wh(),Ji=null;continue e}`）。

两处都挂在官方**内层 `for(;;){…continue e}` mid-stream retry 循环**上：官方在同一 generator 内重开 stream，envelope 状态（`Fu`/`h_`/`oS`）跨 attempt 存活，故 retry 前必须 flush 旧 envelope，否则 --include-partial-messages host 看到失败 attempt 的 reply "still open"。

**OCC 无该内层 mid-stream retry 循环**：`queryModelWithStreaming` 的 `withRetry(getClient, cb)` 只包 **stream 创建**（callback `:2541` 结束于 `return result.data`；`for await (const part of stream)` 消费循环 `:2759` 在 withRetry **之外**）。grep 证据：`claude.ts` 无 `continue e`/`outOfApiAttempts`/`undoLastCount`/`stale_connection_retry`/`529_retry`/`watchdog_retry`/`output_filter_retry`（全在 `withRetry.ts`，且是 stream-creation 层）。OCC 的 mid-stream 错误只走四条终点：finalize（flush ✓ `:3502`）/ close-after-complete（flush ✓ `:3463`）/ non-streaming fallback（flush ✓ `:3646`）/ terminal throw（generator 终止，envelope 局部状态随之丢弃，不重开）。**没有"重开 envelope 的 mid-stream streaming retry"路径 → cc290 修的这个 bug 在 OCC 架构下不可达。**

**结论**：item D 对 OCC = **NO-OP**（架构无对应可达路径）。唯一真正可移植的是 output-filter-retry **新特性本身**（cluster E #9，STAGED，含其内嵌 flush 站点），非本节原描述的 abort-flush 接线。不写 RED 测试（原测试计划断言的是官方没有的 invented 行为）。

---

## E. (2.1.290) Plan mode not restored on `--continue` / `--resume <id>`

### 官方机制

Official persists permission mode per user message and, on resume, seeds the active permission context from the transcript (changelog `changelog-entries-290.txt`). The restore must apply the *last persisted* mode unless the user explicitly overrides via `--permission-mode`.

### OCC 现状

Write side present: every user message is stamped with `permissionMode` (`processTextPrompt.ts:117,130-133`, `processUserInput.ts:167,186`; field comment `messages.ts:688-689` "for rewind restoration"). Resume side **absent**: initial mode comes solely from CLI/settings (`main.tsx:1692-1698` `initialPermissionModeFromCLI`, `permissionSetup.ts:792-798`, `main.tsx:2084-2092`); `processResumedConversation` (`sessionRestore.ts:409-551`) restores agent/coordinator/worktree/attribution/todos but not permission mode; `conversationRecovery.ts:254-265` loads + sanitizes `msg.permissionMode` without applying it; `restoreSessionMetadata` (`sessionStorage.ts:3432-3459`) has no permission-mode field. The **only** consumer is rewind (`REPL.tsx:3937-3940`). Bug reproducible as written: quit in plan mode → `--continue` → default mode.

### 判定

**PORT.** 移植方案: after `loadConversationForResume`, take the last user message's (sanitized) `permissionMode`; when present and `--permission-mode` was not explicitly passed, seed `effectiveToolPermissionContext.mode` with it before `launchRepl` (`main.tsx:3341-3372` + `sessionRestore.ts` initialState merge — mirror the rewind restore logic). 测试计划: unit — resume fixture whose last user message carries `permissionMode:'plan'` → initialState mode `plan`; explicit `--permission-mode default` overrides; e2e: transcript written in plan mode, `occ --continue --print`-adjacent interactive check via REPL smoke that `/status` shows plan mode.

---

## F. (2.1.290) `/rewind` doesn't list a prompt sent while Claude was working

### 官方机制 (byte forensics — 100% recovered)

290 delta = NEW transform `LMe(h)` + memoizing rewind-screen wrapper `nSt`; the selector component (`DMe`) and its `m3` filter are byte-identical 289↔290 (cc289 `vht` @228917878 passed `messages:Pe` straight through; cc290 `nSt` does `Me=X(()=>LMe(Pe),[Pe])` then `e(DMe,{messages:Me,…})`).

`LMe(h)` verbatim (cc290, NEW — zero `function LMe(` in cc289):

```js
function LMe(h){let k=new Set;for(let J of h)if(J.type==="user")k.add(J.uuid);let N=!1,H=h.map((J,he)=>{if(J.type!=="attachment"||J.attachment.type!=="queued_command"||J.attachment.commandMode!=="prompt"||!tU(J))return J;let Se=Rln(J.attachment,J.uuid);if(Se===void 0||Se.isMeta||k.has(Se.uuid)||nNe(h,he)||Array.isArray(Se.content)&&Se.content.some((Pe)=>typeof Pe!=="object"||Pe===null))return J;return k.add(Se.uuid),N=!0,Re({content:Se.content,uuid:Se.uuid,timestamp:J.timestamp,imagePasteIds:J.attachment.imagePasteIds,origin:Se.origin})});return N?H:h}
```

Supporting symbols (all offsets cc290 linux-x64):
- `Rln(e,o)` @217805353 (NEW, exported): `{uuid: source_uuid || row uuid, content: prompt, isMeta, origin: b3(origin, commandMode)}`; skips forwarded-intent attachments (`yte`, existed in 289 as `qV`).
- `tU(e)` @204690011 (289: `Uy`): queued_command branch = `type==="queued_command" && n_(origin) && verifiedSlackHumanTurn!==!0`, try/catch→false.
- `n_(e)` @204689971: `e?.kind==="human"` (strict). Official keyboard enqueue stamps `origin:{kind:"human"}` on the QueuedCommand (@232019514 `uuid:so,origin:{kind:"human"}`), and the attachment creator @213645650 carries `origin:_3(w.origin)` (`_3` @210033549 = task-notification normalizer, otherwise identity).
- `nNe(h,he)` @229151684 (NEW): tool-call-split guard — true if `messages[he]` is a tool_result row or any earlier tool_use's result lands at index ≥ he (289 had the shape with count 0).
- `Re` = createUserMessage. Identity return `N?H:h` when nothing qualified.
- Restore chain: `xMe` @232103682 (`lastIndexOf` → `i2r(h,k.uuid)`), `i2r` @210039574 (`findIndex t.uuid===n` → `findIndex E(t)===n`), `E/G` @210039160 (queued_command `source_uuid` reader) — restore onto a synthesized row resolves back to the attachment row; truncation consumes the queued prompt; `restoreDraftFrom` prefills its text. `handleRestoreMessage=async(h,k)=>{setImmediate((N,H,J)=>N(H,J),this.restoreMessageSync,h,k)}` @232098075-region — same setImmediate shape OCC already has.
- `/rewind` command entry `fZ` unchanged 289↔290 (`{commandName:"rewind",immediate:!1,hidesPrompt:!0,retireAtTurnBoundary:!1}`).
- Eliminated with byte evidence: popQueuedIntoDraft (5/5/5), namesQueuedWork (prewaitLatch remote-intent), queuedAt +6 cluster (auto-bg watcher + intake telemetry), getCommandQueue +2 (fold-in-flight), `sht/hjt` (prompt-shell handoff + compaction later_input, NOT rewind), all rewind UI strings count-identical, selector list construction identical (`Kt=X(()=>[...],…)` cc290 @232106718 ≡ cc289 @228906517 modulo `m3`/`Rj` rename). cc291: all mechanism counts identical (queued_command 95, commandMode 27).

### OCC 现状

`/rewind` (+`/undo`,`/checkpoint`,Esc-Esc) opens `MessageSelector` whose options are built **exclusively** from in-memory `messages` (`MessageSelector.tsx:61-66`, filter :767-792; REPL passes `messages` at `REPL.tsx:5243`). A prompt submitted mid-turn is diverted to the module-level `commandQueue` (`handlePromptSubmit.ts:313-351` — enqueue + clear input, **no `setMessages`**; `messageQueueManager.ts:60,135-142`). `MessageSelector.tsx` has zero references to the queue (grep-proven). Esc-Esc is suppressed while a query is active (`escEscGate.ts:26-38`), single Esc pops the queued prompt back to input (`PromptInput.tsx:2255-2267`). Bug reproducible as written.

### 判定

**PORT — DONE (this round).** OCC has no queued_command attachment rows (queue is module-level state), so the faithful adaptation synthesizes virtual user rows from `commandQueue` entries and APPENDS them after real messages (queued prompts are always newer; `nNe` split guard therefore structurally N/A). Keyboard convention mapping: OCC `origin===undefined` = human ≡ official `{kind:"human"}` stamp; `bridgeOrigin:true` excluded (OCC's remote-input marker ≡ official strict-`n_` exclusion of non-human origins).
- `src/utils/queuedRewindMessages.ts` — `withQueuedPromptMessages(messages, queue)` (LMe port: mode==='prompt' only, isMeta/bridgeOrigin/non-human-origin skips, malformed-content guard, uuid dedup vs existing user rows, identity return when nothing qualified, imagePasteIds via getImagePasteIds) + `findQueuedCommandForMessage` (WeakMap synthesized→entry, official source_uuid-resolution analogue).
- `src/components/RewindMessageSelector.tsx` — nSt analogue: leaf `useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)`, `useMemo(withQueuedPromptMessages)` (official `Me=X(()=>LMe(Pe),[Pe])` shape), restore wrapper removes the queue entry (≡ official truncation consuming the attachment row) then delegates to the standard `onRestoreMessage` (draft prefill via textForResubmit; rewindConversationTo lastIndexOf −1 → no truncation, correct since nothing was delivered after the queued prompt).
- `REPL.tsx:5243` — `<MessageSelector>` → `<RewindMessageSelector>` (selector component untouched, matching official DMe-unchanged structure).
- Tests: `src/utils/__tests__/queuedRewindMessages290.test.ts` — 19 GREEN (identity returns, append order, source_uuid, dedup incl. delivered-while-open, mode/isMeta/origin/bridgeOrigin skips, content guards, imagePasteIds, WeakMap lookup, synthesized row passes the real `selectableUserMessagesFilter` = the listing fix).
- e2e (tmux A/B vs official 2.1.291): start long turn → type prompt (queued) → `/rewind` lists it → restore consumes queue entry + prefills draft. (Pending in task #4.)

---

## G. (2.1.290) Scheduled tasks not coming back on resume after compaction

### 官方机制

Official registry is re-derived from transcript messages on resume, so compaction can drop the derivation inputs; the 290 fix makes the tasks come back on resume for compactions made from that version on.

### OCC 现状

Whole subsystem gated on `feature('AGENT_TRIGGERS')` — **not in the 6-flag allowlist** (`featureFlags.ts:13-59`), so scheduler/`/loop`/Cron* tools are dead in shipped builds (gate sites: `REPL.tsx:211,4355`; `print.ts:377-385,2846-2851`; `skills/bundled/index.ts:57-64`; `ScheduleCronTool/prompt.ts:36-45`; `tools.ts:180-184`). Even flag-on: OCC's mechanism is **different** — durable tasks in `<projectRoot>/.claude/scheduled_tasks.json` (`cronTasks.ts:75-84`), session-only tasks in process memory (`bootstrap/state.ts:151-160,1340-1374`), and **nothing re-derives the registry from the transcript** (grep: no CronCreate consumers outside the tool dir; `scheduled_task_fire` system messages are render-only, `SystemTextMessage.tsx:138`). Compaction never touches either store (`services/compact/*` zero cron references), so the upstream compaction bug cannot occur. Real adjacent gap: session-only `/loop` tasks die on **every** resume (no persistence, `restoreSessionMetadata` has no cron field) — by construction, not a regression.

### 判定

**N-A / NO-OP** (dormant surface + different mechanism). No port. Revisit only if `AGENT_TRIGGERS` is ever enabled — then the durable question becomes "should session-only /loop tasks survive resume" (upstream 290 says yes; OCC would need a persistence path, e.g. stamping session tasks into session metadata).

---

## H. (2.1.290) Recurring session-only tasks run an extra time (sandboxed Bash on Linux / after `scheduled_tasks.json` deleted)

### 官方机制

Official recurring session-only schedules must not be re-anchored by file events on the durable task file; the fix keeps session-only timers independent of `scheduled_tasks.json` mtime/watch churn.

### OCC 现状 (dormant — behind `AGENT_TRIGGERS`)

Watcher: `cronScheduler.ts:440-459` chokidar on `scheduled_tasks.json`; **`unlink` handler clears the global `nextFireAt` map** (:447-452) — including entries of *session-only* tasks, which have no `lastFiredAt` (`bootstrap/state.ts:1340-1352`) and therefore re-anchor from `createdAt` (:253-277) → anchor in the past → **immediate extra fire** (:283-284). Deletion half of the upstream bug is reproducible as written. Sandbox-Bash-on-Linux half: no analog (OCC sandbox never writes/deletes the JSON; `sandbox-adapter.ts:522-570` denyWrite set doesn't include it). OCC's own removal path writes an empty file rather than unlinking (`cronTasks.ts:161-165`) so self-deletes don't trigger it; the trigger is external deletion (git clean, worktree switch, user rm). Second milder instance: `seen.size===0` → `nextFireAt.clear()` (:380-393).

### 判定

**STAGED** (dormant). 移植方案 (ready for when/if the flag flips): in the `unlink` handler and the `seen.size===0` branch, clear only file-backed task ids from `nextFireAt`, leaving session-task entries intact (or keep a separate `sessionNextFireAt` map that file events never touch). 测试计划: unit (flag forced on) — session task scheduled, delete the JSON, advance fake timers 1 s tick → no extra fire; file-backed task deletion still resets file tasks.

---

## I. (2.1.290) Foreground scheduled tasks never fire after ← / `/background` hand-off; extra run on resume/respawn/fork

### 官方机制

Scheduled tasks must keep firing after a session is backgrounded (← confirm or `/background`), and recurring tasks must not fire an extra run on resume/respawn/fork. (290 also changed the "Press ← again" confirm — `changelog-entries-290.txt` context entries.)

### OCC 现状

- **← hand-off: ABSENT** (grep-proven: no left-arrow binding backgrounds a session — `defaultBindings.ts` `left` hits are tabs/attachments/footer/diff/effort only; `task:background` is `ctrl+b` @:230; `SessionBackgroundHint.tsx:50-57` double-press Ctrl+B). `/background`(+`bg`) present (`commands/background/index.ts:10-24`).
- Scheduler lifetime is the REPL's, not the query's (`useScheduledTasks.ts:116-126` stop only on unmount); hand-off aborts the query and spawns an in-process bg loop (`REPL.tsx:2717-2775`, `LocalMainSessionTask.ts:330-400`) without touching the scheduler → "never firing after hand-off" structurally unlikely. Residual: fires land in the **foreground** queue (`useScheduledTasks.ts:71-114` → `enqueuePendingNotification`), so a backgrounded session's /loop runs in the foreground conversation — a divergence from official session-binding, not the upstream bug.
- Extra-run-on-resume: mitigated — durable recurring fires persist `lastFiredAt` (`cronScheduler.ts:315-324` → `cronTasks.ts:266-283`), lock PID-refreshed on resume (`cronTasksLock.ts:137-145`), re-anchor reasoning documented at `cronScheduler.ts:255-263`. Remaining behavior is the intentional catch-up fire after an elapsed window. Respawn/daemon: `src/daemon/` never re-registers cron state; `occ daemon scheduled add|remove|list` writes `~/.claude/daemon.json scheduled[]` but **nothing fires it** (write-only store); SDK `forkSession` throws (`agentSdkTypes.ts:350-355`); `--fork-session` only mints a new session id.

### 判定

**N-A** for the ← hand-off (surface absent) and the respawn/fork extra-run (no live surface); **NO-OP** for `/background` non-firing (scheduler survives hand-off). Document the foreground-routing divergence + the write-only daemon `scheduled[]` store as known quirks; no port this round (subsystem dormant behind `AGENT_TRIGGERS` anyway).

---

## J. (2.1.290) Resumed subagents/teammates lose earlier thinking + prompt cache after a mid-run message

### 官方机制

A message delivered to a running subagent/teammate must be appended without rebuilding earlier history — thinking blocks and the cached wire prefix must survive.

### OCC 现状

Mid-run messaging appends, never rebuilds: SendMessage to a RUNNING task → `queuePendingMessage` (`SendMessageTool.ts:800-812`, `LocalAgentTask.tsx:138-195`) → drained as `agent_pending_messages` attachment → `queued_command` isMeta messages **appended** to `[...messagesForQuery, ...assistantMessages, ...toolResults]` (`attachments.ts:1172-1188`, `query.ts:1892-1920`). `cache_control` is never persisted; a single marker is re-placed at the list tail per request (`claude.ts:4195-4225`) → appending preserves the cached prefix. Teammates keep in-memory `allMessages` + persisted `contentReplacementState` for byte-identical prefixes (`inProcessRunner.ts:1086-1088,1183-1186`). Two caveats: (1) fork-context runs `filterIncompleteToolCalls` (`runAgent.ts:503,1117-1155`) which drops whole assistant messages (thinking with them) when a fork lands mid-tool-round — `forkedAgent.ts:616` carries an explicit "Do NOT filter here" caution for the sibling path; (2) STOPPED/evicted-agent resume reconstructs from disk (`resumeAgent.ts:96-101`) — thinking kept except orphaned/unresolved rows, but the reconstructed prefix differs byte-wise → first post-resume request is a likely cache miss (cost, not loss).

### 判定

**NO-OP** — OCC's append-not-rebuild architecture already produces the fixed behavior for the primary scenario. Watch-items (no port now): the `filterIncompleteToolCalls` fork caveat and the disk-resume cache miss; revisit if teammate usage grows.

---

## K. (2.1.290) Effort level changes when a flagged message is retried on a fallback model

### 官方机制

On a retry against a fallback model, the effort level in effect for the turn must be preserved — the retry must not silently re-read the fallback model's saved/settings level.

### OCC 现状

Both concepts live: fallback chain (`query.ts:689-696,801-839`; `FallbackTriggeredError` from `withRetry.ts:409,763-864` on 529-exhaustion / model_not_found / permission_denied / 5xx; ordered list `fallbackModel.ts`, cap 3). On hop, `currentModel` swaps and the loop re-invokes `callModel` (`query.ts:1050-1067`); `claude.ts:2117` then does `resolveAppliedEffort(options.model, options.effortValue)` — re-resolving against the **fallback** model's default and settings cap (`effort.ts:362-386`, `effort/cap.ts:63,117`). Effort is nowhere pinned from the original attempt → drift occurs whenever the fallback model has a different saved level/cap (mitigated only when `appState.effortValue` is set and no cap clamps). The *exact* upstream trigger (flagged message retried) is absent: output-content-filtered errors throw immediately, never fallback (`claude.ts:3510-3546`); the 2.1.287-era sibling fix is already recorded STAGED (`docs/upstream-version-gap-occ144-2026-10.md:105` #87).

### 判定

**STAGED** — general fallback effort drift is live and worth fixing with the same pin semantics. 移植方案: resolve effort once per turn (first attempt) and carry the resolved value across fallback hops (pass the pinned effort in `callModel` options instead of re-resolving at `claude.ts:2117`; still clamp to hard capability limits of the new model, but never adopt its settings default/cap mid-turn). 测试计划: unit — turn started on model A (effort high) falls back to model B whose settings cap is low → request to B carries the pinned effort (modulo hard capability clamp); `resolveAppliedEffort` invoked once per turn.

---

## L. (2.1.290) Responsiveness while resuming large sessions

### 官方机制

Official keeps timers/input/rendering alive while the transcript loads (async hydration behind a live UI); a `resume_load` watchdog warns on slow loads — verified identical in 290/291 (290 @229464690 region; the held-results dump shows `FF("resume_load",d_);let n=setTimeout(KR,l_,r)` 290 / `setTimeout(VR,l_,r)` 291 — rename only).

### OCC 现状

Every resume path awaits the **full** transcript read+parse before mounting the REPL: `--continue` `main.tsx:3544→3551→3566` (`await loadConversationForResume` → `await processResumedConversation` → `launchRepl({initialMessages})`), `--resume <id>` `:4107→4116→4165`, picker `ResumeConversation.tsx:182-195,280-287` (spinner, then load, then mount). `launchRepl` → `renderAndRun` (`replLauncher.tsx:12-22`) is the first render; `REPL.tsx:1268` `useState(initialMessages ?? [])`. Load-side memory optimizations exist (`SKIP_PRECOMPACT_THRESHOLD` chunked scan, dead-fork skip `sessionStorage.ts:4212-4265`; picker list from 16 KB tail read) but the conversation UI is not live during the parse — the pre-fix blocking pattern.

### 判定

**STAGED** (P2 — larger refactor). 移植方案 direction: mount the REPL immediately with a "resuming session…" affordance, hydrate `messages` asynchronously post-mount (initial `[]` + one `setMessages` on parse completion), keep input enabled (queued or accepted) during hydration; add the `resume_load` slow-warning timer for parity. Touch points: `main.tsx` resume branches, `replLauncher.tsx`, `REPL.tsx` initialMessages handling. 测试计划: e2e — resume a multi-MB transcript: first paint < 500 ms, keystrokes registered during load, final message list complete; unit — hydration race (input submitted before hydration completes) preserves order.

---

## Cross-item notes

- Official exit-flush machinery OCC already matches (verified byte-identical 289/290/291): exitDrains + project.flush + `kyn` settle + 500 ms backend re-stamp race + sync `QWr` re-stamp on `process.on("exit")` + degraded-writer warning. OCC's analog: cleanup-registry flush + 2000 ms race + failsafe — **but missing the sync exit re-stamp** (see item A Risk 1/2).
- The 290→291 whole-bundle text diff is rename-noise; the ONLY semantic delta found in the session-persistence region is the barrier removal (item A). Held-results, registry, orchestrator, wT/kyn: renames only.
- Items G/H/I are all doubly-gated: dormant behind `AGENT_TRIGGERS` (not in the allowlist). Their STAGED/N-A dispositions carry "if the flag ever flips" fix notes rather than immediate work.
- Item B reverses the initial "cloud → N/A" hypothesis: OCC has real remote-session code with the identical drop pattern; only its reachability is narrow.
