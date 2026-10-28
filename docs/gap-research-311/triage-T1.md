# Gap Triage T1 — official claude-code 2.1.310 → 2.1.311, changelog items 1–19

Forensics: read-only string/window diffing of the official Bun-compiled ELFs at
`/tmp/cc-diff-311/v310/package/claude` and `/tmp/cc-diff-311/v311/package/claude`
(`grep -aboF` byte offsets + python normalized-window difflib; binaries never executed).
OCC repo: `/root/multica_workspaces_cnwenf2/864814a3-7dbe-4ab8-99a4-86d3eee1a414/c7d7631d/workdir/occ`.

Verdicts: **PORT** = OCC has the surface, official behavior differs and is byte-verifiable.
**STAGED** = surface exists but the official mechanism is ambiguous / not byte-pinnable /
depends on an unported subsystem. **N-A** = surface absent by design (self-hosted-runner,
Remote Control, cloud/Cowork, VSCode, Claude Tag, artifacts) or no OCC gap.

## Summary table (items 1–19)

| # | Changelog (abridged) | Verdict | One-line reason |
|---|---|---|---|
| 1 | `--hold-idle-file`/`--max-hold-min` for self-hosted-runner | N-A | OCC self-hosted-runner is a 3-line stub; feature flag not allowlisted |
| 2 | Explanatory-output-style tip | PORT | All v311-only tip strings + detector regex + registration byte-pinned; OCC has tip registry but no explanatory tip |
| 3 | Freeze on very long CLAUDE.md list item | STAGED | not byte-pinnable (lexer strings pre-existing in both versions) |
| 4 | Interrupt during MCP resource read / skill download | STAGED | no distinguishing string; OCC readResource lacks abort wiring, skill download is a stub |
| 5 | "Usage credits required for 1M context" on standard context → compact & continue | PORT | v311 `bd()` withhold detector + `compact_after_long_context_refusal` (0/8) byte-pinned; OCC still fatals |
| 6 | Write/Edit 5s stall + 0 lines changed | STAGED | not byte-pinnable (all counter regions normalized-identical) |
| 7 | Subagent MCP tools from late-connecting servers | STAGED | official mechanism pinned (`mcp_handed_listing_check` 0/6) but depends on handed/known-listings substrate OCC lacks |
| 8 | Stale MEMORY.md/CLAUDE.md after auto-compaction | N-A | no gap: OCC already resets memory cache on compaction (`postCompactCleanup.ts:60`); official fix not byte-pinnable |
| 9 | `-p`/SDK transcript out-of-order + kept taken-back messages | PORT | v311 `inCallOrder` serialization + tombstone-persisted-removal pinned; OCC print path never removes tombstoned messages |
| 10 | SubagentStop hooks firing ~2×/min | N-A | no gap: OCC fires SubagentStop once at subagent end; no periodic refire surface; official fix not byte-pinnable |
| 11 | @ picker ignores `.ignore`/`.rgignore` negation re-includes | PORT | full v311 mechanism pinned (rg re-include merge, `[FileIndex] .ignore re-include listing failed:` 0/2); OCC has same gap |
| 12 | Agent worktree removed while background subagent works in it | PORT | v311 findOccupant before/after-check + keep + re-arm + `tengu_agent_worktree_kept` pinned; OCC `cleanupWorktreeIfNeeded` has no occupant check |
| 13 | Background auto-mode agents starting turn on every wake | N-A | CCR/print-session park keepalive machinery (`hasLiveSessionWakeup`) absent by design in OCC |
| 14 | Bash tool description claiming cwd always persists | PORT | v311 `i5t()`/`c8t()` conditional text byte-pinned; OCC ships the old claim |
| 15 | Environment block naming wrong shell (fish vs zsh) | PORT | v311 `$to()`/`VVs()` shell detection byte-pinned; OCC replicates the v310 bug |
| 16 | mcp add/remove//mcp naming current folder vs project entry | N-A | no gap: OCC local scope already keyed by canonical git root; official fix not byte-pinnable |
| 17 | `ENOENT: ENOENT:` doubled error code | N-A | OCC has no `${code}: ${error}` concat surface |
| 18 | Remote Control stuck on "Connecting" ~2 min | N-A | Remote Control absent in OCC |
| 19 | Cloud/RC messages appearing as own message in mobile apps | N-A | Remote Control / cloud sessions absent in OCC |

---

## Item 1 — self-hosted-runner `--hold-idle-file` / `--max-hold-min` — **N-A**

**OCC surface:** `src/self-hosted-runner/main.ts` is a 3-line stub; `src/entrypoints/cli.tsx:317-323`
registers runner subcommands gated on `feature("SELF_HOSTED_RUNNER")` which is NOT in the
6-flag `FEATURE_ALLOWLIST` → dead code. No `hold-idle-file` anywhere in `src/`.

**Official evidence:** `--hold-idle-file` v310: 0 hits / v311: 10 hits; `--max-hold-min`
v310: 0 / v311: 13. Env `SELF_HOSTED_RUNNER_HOLD_IDLE_FILE`, `SELF_HOSTED_RUNNER_MAX_HOLD_MS`
v311-only. Freshness gate `Gh()` with `Ui=180000` ms; `Bh()` reads a 64-byte file of
epoch-seconds. Surface = self-hosted runner idle-hold keepalive while the host reports
leftover processes.

**Action:** none — self-hosted-runner is intentionally stubbed in OCC.

## Item 2 — Explanatory output style tip — **PORT**

**OCC surface:**
- `src/services/tips/tipRegistry.ts` (721 lines) — registers spinner tips; NO
  `explanatory-output-style` tip.
- `src/services/tips/tipScheduler.ts` — `getTipToShowOnSpinner(context)` →
  `getRelevantTips(context)` → `selectTipWithLongestTimeSinceShown`; `recordShownTip`
  logs `tengu_tip_shown`.
- `src/screens/REPL.tsx:1654-1680` — `pickNewSpinnerTip` consumes the scheduler.
- `src/utils/outputStyles.ts:78` — the `Explanatory` output style exists.

**Official evidence (v311-only, string table @119525248, code @266639667):**
```
C$n="Just want the answer? Run /focus now to hide the steps along the way"
nCs="Focus view is on and the steps are hidden. Run /focus to show them"
rCs=10
oCs="Want Claude to teach as it works?"
R$n=`${"Want Claude to teach as it works?"} \xB7 /${"config"} outputStyle=explanatory`
```
Tip registration (v311 @266639667 region):
```
{id:"explanatory-output-style",priority:1,providerAgnostic:!0,
 content:async()=>R$n,cooldownSessions:15,maxLifetimeShows:3,
 advertisedCommand:"config",
 isRelevant:async(e)=>(e.explanationRequestCount??0)>=J&&!Rt()&&Jt("localSettings")
   &&pe("flagSettings")?.outputStyle===void 0
   &&pe("policySettings")?.outputStyle===void 0&&await ayt()===null}
```
with `J=2` (two explanation-request prompts). Request detector `mSs(e)` runs on the
lowercased, `’`→`'`-normalized user text:
```
/^(?:(?:ok|okay|please|pls|can you|could you|would you),? )*(?:explain|walk me through|help me understand|teach me)\b|^(?:why (?:does|do|is|are|was|were|would|should) (?!you\b|u\b)(?![^.?!]*\b(?:still|again)\b)|how (?:come|does|do (?:these|those)) |what (?:does|do) (?!you\b|u\b|we\b|i\b)|what(?:'s| is) (?:this|that)\b|i (?:don'?t|do not) (?:understand\b|get (?:this|it|why|how|what)\b))/
```
Engine side: `_explanationRequestIds=new Set`, and tip context carries
`explanationRequestCount:this._explanationRequestIds.size`.

**Action (OCC):**
1. `src/services/tips/tipRegistry.ts` — add the `explanatory-output-style` tip with the
   verbatim content `` `Want Claude to teach as it works? · /config outputStyle=explanatory` ``
   (the `·` is `\xB7`), `priority:1`, `cooldownSessions:15`, `maxLifetimeShows:3`,
   `advertisedCommand:'config'`, and the `isRelevant` gate above (threshold 2; only when
   no flag/policy outputStyle override and local settings writable).
2. Add the `mSs` regex detector (verbatim above) to the user-prompt path; track matched
   prompt ids in a session set; expose `explanationRequestCount` on `TipContext`
   (`src/services/tips/types.ts`).
3. Skip the `/focus`-related strings (`C$n`/`nCs`/`rCs`) — OCC has no `/focus` command;
   they belong to a different tip family.
4. Extend OCC's `Tip` type if `maxLifetimeShows`/`providerAgnostic`/`advertisedCommand`
   fields are missing.

## Item 3 — freeze on very long CLAUDE.md list item — **STAGED (not byte-pinnable)**

**OCC surface:** `src/components/Markdown.tsx` — marked-based serializer with
`listHasTaskItems()` (line 36) and per-token rendering; CLAUDE.md content is rendered
through this path at startup/context display.

**Official evidence:** markdown-lexer strings are pre-existing in BOTH versions
(`nextLines` 4/4, `lineBreak` 10/10, `hiddenLines` 9/9). No new lexer/render surface and
no distinguishing string found → **not byte-pinnable**. The fix is presumably a
complexity guard inside the renderer with no new literals.

**Action:** none this round. If OCC ever shows a freeze with a multi-KB single-bullet
CLAUDE.md, revisit; no verbatim change can be specified without inventing.

## Item 4 — interrupt blocked by MCP resource read / skill download — **STAGED**

**OCC surface:**
- `src/utils/attachments.ts:2631` — `await client.client.readResource({ uri })` with NO
  abort signal / timeout option; the enclosing attachment pass creates
  `abortController` + 1000 ms `setTimeout(...abort...)` (line 946) but that signal is
  never threaded into `readResource`, so an unanswered MCP resource read keeps the
  promise pending.
- Skill download: `src/skills/mcpSkills.ts` is an auto-generated stub returning `[]` →
  the skill-download half of this fix has no OCC surface (N-A half).

**Official evidence:** no distinguishing string for this fix. Related v311-only export:
`isCancelAbortReason` (0/2) — `var x=new Set(["user-cancel","remote-cancel"]);function
AAt(e){return x.has(Ri(e))}` @241654464, exported @270377077, used @275877549 /
@275877864 / @275895229 / @276944238 — engine abort classification, attribution to this
item unproven. `readResource` 7/7 hits with 1 changed window @248372171 that is
chunk-import churn. One v311 mechanism that IS signal-aware: the item-7 handed-listing
check awaits via `Gne(L,{signal:_,timeoutMs:2*vl(),serverName:e.name,context:"MCP tool
check"})` — evidence the general direction is signal+timeout wrapping, but the exact
resource-read/skill-download change is **not byte-pinnable**.

**Action:** none this round (would require inventing the wiring). Candidate OCC hardening
for a future round: pass `{ signal }` / `timeout` into `client.readResource` in
`attachments.ts` so the existing 1 s abortController actually cancels.

## Item 5 — standard-context "Usage credits required for 1M context" → compact & continue — **PORT**

**OCC surface:**
- `src/services/api/errors.ts:709-717` — on `error.message.includes('Extra usage is
  required for long context')` OCC returns a FATAL assistant error message:
  `` `${API_ERROR_MESSAGE_PREFIX}: Extra usage is required for 1M context · ${hint}` ``
  and the session stops.
- `src/services/compact/reactiveCompact.ts` — auto-generated stubs:
  `isWithheldPromptTooLong=()=>false` (line 14), `tryReactiveCompact=async()=>null`.
- `src/query.ts:995-1013` + `1337-1461` — the withheld-413 reactive path exists but is
  inert because the predicates are stubs.
- Grep confirms no `Usage credits required for 1M context` handling and no
  compact-after-refusal latch anywhere in `src/`.

**Official evidence (v311):**
- Withhold detector `bd(e,n,r)` @~257405921:
  `e.type==="assistant"&&SHr(e)&&n.contextWindow<=g6&&!RTt(n.model,np())&&aYn({hasAttempted:!1,querySource:r,aborted:!1})&&v6s()`
  with `g6=200000` (standard context) and refusal-text predicate
  `z_e(e){return e.includes("Extra usage is required for long context")||e.includes("Usage credits are required for long context")}`,
  one-shot latch `fBe`.
- Wiring @257496863: `if(!ve.needsFollowUp&&bd(I,Mt,M))Jt=!0,ss=I;` — the refusal message
  is WITHHELD (not surfaced), compaction runs, and the loop merges on
  `Q=E!==void 0&&E===ss`.
- Telemetry `compact_after_long_context_refusal`: v310 0 / v311 8 hits, with outcomes
  `rapid_refill_breaker`, `too_few_groups`, `aborted`, `still_refused`, `not_compacted`.

**Action (OCC):**
1. In the query loop (`src/query.ts`, alongside the existing withheld-413 path at
   1337-1461), add the credits-refusal detector: assistant error text matching
   `"Extra usage is required for long context"` OR `"Usage credits are required for long
   context"`, only when the session context window ≤ 200000 and not already attempted
   (one-shot latch per session).
2. On detection: withhold the fatal message (do NOT emit the errors.ts fatal branch),
   run compaction, and continue the turn; if the refusal recurs after compaction
   (`still_refused`) or the breaker trips (`rapid_refill_breaker`), surface the original
   fatal message.
3. Requires giving `reactiveCompact.ts` real implementations (or routing through OCC's
   existing compact pipeline in `src/services/compact/compact.ts`) — the stubs must stop
   returning `false`/`null` for this predicate.
4. Log outcome names verbatim: `rapid_refill_breaker` / `too_few_groups` / `aborted` /
   `still_refused` / `not_compacted`.

## Item 6 — Write/Edit 5 s stall + "0 lines changed" on huge edits — **STAGED (not byte-pinnable)**

**OCC surface:** `src/tools/FileEditTool/utils.ts:405` builds the patch with
`structuredPatch` synchronously inside `call()`; result carries
`structuredPatch` (`FileEditTool.ts:845`, `FileWriteTool.ts:748`, schema
`FileEditTool/types.ts:71`); UI renders via `FileEditToolUpdatedMessage`
(`FileEditTool/UI.tsx:79-90`, `FileWriteTool/UI.tsx:365-401`).

**Official evidence:** all counter/diff surfaces unchanged in counts: `linesAdded`
60/60, `linesRemoved` 21/21, `structuredPatch` 15/15, `diffLines` 3/3, `diffStat` 16/16.
Normalized-window diffs: toolStats region (anchor
`readCount:0,searchCount:0,bashCount:0,editFileCount:0`, v310 @255310132 / v311
@256686880) normalized-IDENTICAL; Edit-tool region (anchors `File has not been read yet`
3/3, `File has been modified since read` 2/2) shows only chunk-import churn.
`TURN_DIFF_COUNTING_MS` exists in BOTH (2/2). → **not byte-pinnable**.

**Action:** none this round. OCC note: OCC computes `structuredPatch` synchronously —
if a multi-thousand-line edit ever stalls OCC's UI, the same class of problem applies,
but no official diff can be copied verbatim.

## Item 7 — subagent MCP tools from servers that connect after spawn — **STAGED**

**OCC surface:** `src/tools/AgentTool/runAgent.ts:944-980` — at spawn:
```
const { clients: mergedMcpClients, tools: agentMcpTools, cleanup: mcpCleanup } =
  await initializeAgentMcpServers(agentDefinition, toolUseContext.options.mcpClients)
...
agentOptions = { ..., tools: allTools, mcpClients: mergedMcpClients, ... }
```
`allTools` is a STATIC array snapshotted at spawn; a parent MCP server that finishes
connecting later never surfaces its tools to the running subagent. OCC has
`ensureConnectedClient` (`src/services/mcp/client.ts:2957`) but NO
known/handed-listing substrate (grep `knownListings|handed|cachedListing` → none).

**Official evidence (v311-only, byte-pinned):** `mcp_handed_listing_check` v310: 0 /
v311: 6; `could not be checked against what MCP server` 0/2; `handshake_differs` 0/2;
`listToolsRaw` 4/5. Wrapper `N(e,o,n,M,m)` @258819480 region:
- `dyr(tools)`: `e.every((o)=>/^[A-Za-z0-9_-]+$/.test(o.name)) && new Set(names).size===len`
- Per-tool first-call check `P(toolUseId)`:
  `M.ensureConnectedClient(e,{context:"MCP tool call",toolUseId})`, compare
  `instructions` (→ telemetry `instructions_differ`) and
  `capabilities`/`serverInfo.name`/`serverInfo.version` (→ `handshake_differs`), then
  `M.listToolsRaw(p.client,{timeout:vl()})`, awaited through
  `Gne(L,{signal,timeoutMs:2*vl(),serverName,context:"MCP tool check"})`; results memoized
  per tool name; success marker `g("mcp_handed_listing_check")`.
- Verbatim refusal strings:
  - `D="Call the tool again: it is checked again each time, and Claude Code replaces it with the server's own tool once that is loaded."`
  - `S(r,p)=\`The tool "${r}" could not be checked against what MCP server "${e.name}" lists (${p}), so the call was not made.\``
  - handshake: `MCP server "${e.name}" does not match what Claude Code was given at start-up (in its capabilities, name, version or instructions), so the call was not made. ${D}` (telemetry `handshake`)
  - `tool_gone`: `MCP server "${e.name}" no longer offers the tool "${r}", so the call was not made.`
  - `tool_differs`: `MCP server "${e.name}" lists the tool "${r}" differently from the definition that Claude Code was given at start-up, so the call was not made. ${D}`
  - `not_compared` variants: `the server did not answer in time`, `the server's list could not be matched tool by tool`, `the list given at start-up could not be matched tool by tool`, `Claude Code could not tell which of the server's tools this is`
  - refusal error: `new R(y,"MCP tool refused by the check of its handed listing")`;
    validateInput failure returns `{result:!1,message,errorCode:3}`; checkPermissions
    returns `{behavior:"deny",message,decisionReason:{type:"other",reason}}`.
- Feed-in: connect orchestrator `Xgs({... knownListings ...})` — tools built from
  cached/handed listings BEFORE the server connects, wrapped by `N()`.

**Why STAGED not PORT:** the mechanism depends on the `knownListings` handed-listing
substrate (build tool objects from a cached listing pre-connect) which OCC has not
ported. Porting = new subsystem, not a diff. Evidence recorded here so a future round
can port it wholesale.

## Item 8 — stale MEMORY.md/CLAUDE.md right after auto-compaction — **N-A (no OCC gap)**

**OCC surface:** `src/services/compact/postCompactCleanup.ts:60` calls
`resetGetMemoryFilesCache('compact')` — the memoized `getMemoryFiles`
(`src/utils/claudemd.ts:1201`) cache is cleared on EVERY compaction, so the post-compact
context rebuild re-reads CLAUDE.md/MEMORY.md from disk. The stale-after-compaction window
the official fixed does not exist in OCC's memoize+reset design. (OCC's residual
behavior — edits mid-session without compaction not invalidating the memo — is the
opposite direction and matches pre-existing design with the InstructionsLoaded-hook
bookkeeping at `claudemd.ts:1652-1684`.)

**Official evidence:** no distinguishing string: `MEMORY.md` 25/25, `refreshMemory`
26/26, `claudemd` 19/19, `memory file` 177/177 → **not byte-pinnable**. Adjacent v311
change: new background-task type `post_turn_memory` (0/27) and the stop-hook payload
collector now skipping it (`if(!My(r)||r.type==="post_turn_memory")continue`, anchor
`hook_event_name:"StopFailure"` v310 @250296462 / v311 @251823911) — ambient-memory
subsystem, not portable to OCC (no ambient memory).

**Action:** none.

## Item 9 — `claude -p`/SDK transcript ordering + taken-back messages kept — **PORT**

**OCC surface:**
- `src/QueryEngine.ts:1124-1126` (print path):
  `case 'tombstone': // Tombstone messages are control signals for removing messages, skip them → break`
  — tombstoned (taken-back) messages are NEVER removed from the persisted transcript in
  `-p`/SDK mode. `src/QueryEngine.ts:1579` comment confirms: "OCC's `case 'tombstone'`
  only skips the control signal and tracks no retractions" (`retractionExhausted`
  hardcoded false).
- REPL does it right: `src/screens/REPL.tsx:2888-2889` —
  `setMessages(old => old.filter(m => m !== tombstonedMessage)); void removeTranscriptMessage(tombstonedMessage.uuid);`
- Tombstone producers: `src/query.ts:901-917` (streaming-fallback orphans,
  `tengu_orphaned_messages_tombstoned`) and `src/query.ts:1589-1592`
  (malformed-tool-use retry, 2.1.307 B12 port).
- Ordering: `src/QueryEngine.ts:1094` persists assistant messages fire-and-forget
  (`void recordTranscript(messages)` — comment: "enqueueWrite is order-preserving so
  fire-and-forget here is safe"), while `removeTranscriptMessage`
  (`src/utils/sessionStorage.ts:1797`) → `removeMessageByUuid` (@1105) does a positional
  tail-splice under `trackWrite` (@1106) against a lazy 100 ms write queue
  (`FLUSH_INTERVAL_MS = 100` @758). A removal can race pending queued appends: the
  splice reads the file BEFORE queued appends land → out-of-order / resurrected rows.
  `recordTranscript` itself @1733; `flush()` @1075 drains queue + `pendingWriteCount`.

**Official evidence (v311-only):**
- Write serialization @248834517:
  `inCallOrder(e){this.releaseWaitsForUploads();let n=this.lastWriteInCallOrder,{promise:r,resolve:s}=Promise.withResolvers();return this.lastWriteInCallOrder=r,this.trackWrite(async()=>{try{if(n!==void 0)await n;return await e()}finally{if(this.lastWriteInCallOrder===r)this.lastWriteInCallOrder=void 0;s()}})}`
  + module wrapper `async function rFr(e){return await ca().inCallOrder(e)}` @248893468.
- BOTH transcript writers in the print path now go through `rFr`: append `ve()`
  @277222803 and tombstone removal `Ze()` @277223629 (the latter also emits
  `tengu_tombstone_persisted_removal`). v310 calls the writers unordered.

**Action (OCC):**
1. `src/QueryEngine.ts` print path `case 'tombstone'` (~line 1124): mirror REPL.tsx:2888 —
   call `void removeTranscriptMessage(tombstonedMessage.uuid)` (import from
   `src/utils/sessionStorage.ts`) instead of bare `break`, and log/telemetry the removal
   (official event name: `tengu_tombstone_persisted_removal`).
2. `src/utils/sessionStorage.ts`: serialize removals AFTER queued appends — in
   `removeTranscriptMessage` (@1797) drain the pending write queue (await the equivalent
   of `flush()`/@1075 for the session file, or chain on a `lastWriteInCallOrder` promise
   exactly like the official `inCallOrder` snippet) before running `removeMessageByUuid`'s
   tail-splice. Simplest faithful port: add a per-storage `lastWrite` promise chain and
   route BOTH `enqueueWrite`-backed appends and `removeMessageByUuid` through it.
3. Verify with an e2e: `-p` run that triggers a streaming-fallback tombstone, then assert
   the JSONL on disk no longer contains the retracted uuid and row order matches call order.

## Item 10 — SubagentStop hooks running ~twice a minute — **N-A (no OCC gap)**

**OCC surface:** SubagentStop fires once per subagent completion:
`src/tools/AgentTool/runAgent.ts:829-853` passes `isAgent=true` ("converts Stop to
SubagentStop") into the subagent's query engine; `src/query/stopHooks.ts:299` selects
`'SubagentStop'` at stop-hook time. No timer/keepalive loop re-runs stop hooks in OCC.

**Official evidence:** `SubagentStop` 63/63 hits (52 code-region hits in both);
normalized-context classification: ZERO new/removed SubagentStop contexts. The only
changed window near the stop-hook payload (anchor `hook_event_name:"StopFailure"` v310
@250296462 / v311 @251823911) is the `post_turn_memory` background-task filter (ambient
memory — item 8 territory). No hook-related entries in the new-events diff → **not
byte-pinnable**; the official's twice-a-minute refire lived in its bg-wait/keepalive
machinery, which OCC does not have.

**Action:** none.

## Item 11 — @ file picker ignores `.ignore`/`.rgignore` negation re-includes — **PORT**

**OCC surface:** `src/hooks/fileSuggestions.ts` (839 lines):
- `loadRipgrepIgnorePatterns` (@202-247) loads `.ignore`/`.rgignore` from repoRoot+cwd
  dirs into an `ignore` npm instance (cache @66-67, log
  `[FileIndex] loaded ignore patterns from ${paths[i]}` @239).
- `getFilesUsingGit` (@257+): tracked via `git ls-files --recurse-submodules`; untracked
  via `git ls-files --others --exclude-standard` when `respectGitignore` (args @~331-338,
  10 s timeout, `cacheGeneration` guard), then `ignorePatterns.filter(...)` on the
  results. **The bug:** a gitignored file never appears in `--exclude-standard` output,
  so a `!pattern` negation in `.ignore` that RE-INCLUDES it can never add it back — the
  `ignore` filter can only remove files git already listed.

**Official evidence (v311-only):** `[FileIndex] .ignore re-include listing failed: `
v310: 0 / v311: 2 (table @126918168, code @263877990). Full mechanism:
- State (factory `j()` @263867357, reset `fvo` @263867910): new fields
  `ignoreReincludeGlobs:[]`, `lastReincludedFiles:[]`, `reincludeRetryAtMs:0`.
- Loader `_()` @263870217: for each ignore file, parse lines (`trimEnd` unless ending
  `\ `; skip empty/`#`), feed the `ignore` instance, and run `U(lines, relDir)` →
  `{hasNegation, augmentations, rules}`; if ANY file `hasNegation`:
  `ignoreReincludeGlobs=[...augmentations,...rules]`, else `[]`.
- `U(e,i)` (verbatim semantics): negated line `!pat` → `hasNegation=true`,
  `rules.push(q(pat,rel))`, and if the glob doesn't end with `**`:
  `m=glob.replace(/\/+$/,"")`, `augmentations.push(M(m)?`**/${m}/**`:`${m}/**`)`;
  non-negated line → `rules.push(`!${q(pat,rel)}`)` (becomes an rg EXCLUDE glob).
  `M(e)=!e.startsWith("/")&&!e.replace(/\/+$/,"").includes("/")` (bare pattern);
  `W(e)=e.replace(/[[\]{}*?\\]/g,"\\$&").replace(/^[!#]/,"\\$&")` (escape relDir);
  `q(e,i)= i===""?e : e.startsWith("/")?`${i}${e}` : M(e)?`${i}/**/${e}` : `${i}/${e}``.
- Fetch `ae()` @263877675: when `respectGitignore && ignoreReincludeGlobs.length>0 &&
  Date.now()>=reincludeRetryAtMs`, run ripgrep
  `["--files","--hidden",...ignoreReincludeGlobs.flatMap(g=>["--glob",g]),...Q]` on `"."`
  with `AbortSignal.timeout(1e4)`, cwd = repoRoot, `rejectOnPartial:!0`; where
  `var v=[".git",".svn",".hg",".bzr",".jj",".sl"], Q=v.flatMap((e)=>["--glob",`!${e}`])`
  (@263873106). Success caches `lastReincludedFiles` under a `cacheGeneration` guard;
  failure logs `` `[FileIndex] .ignore re-include listing failed: ${msg}` `` and sets
  `reincludeRetryAtMs=Date.now()+backoff`; when not due, reuse `lastReincludedFiles`.
  Result is `Promise.all`-merged with the `git ls-files --others` output into the
  untracked list (normalized, deduped).
- Bonus perf guard in the same region: the ignore filter `G()` yields every 256 entries
  when it exceeds a time budget (`if((o&255)===255&&performance.now()-n>jAn)await Tg()`).

**Action (OCC):** in `src/hooks/fileSuggestions.ts`:
1. Extend the ignore-pattern cache state with `ignoreReincludeGlobs`,
   `lastReincludedFiles`, `reincludeRetryAtMs` (reset in the existing cache-clear path,
   cf. lines 97-98).
2. In `loadRipgrepIgnorePatterns`, while reading each file also derive the re-include
   globs per `U()` above (negation detection; bare-pattern `**/x/**` augmentations;
   non-negated patterns become `!glob` excludes) relative to the file's dir.
3. In the untracked background fetch, when `respectGitignore && globs.length>0`, run the
   existing `ripGrep` util (already imported @33) with
   `["--files","--hidden",...globs.flatMap(g=>["--glob",g]),"--glob","!.git","--glob","!.svn","--glob","!.hg","--glob","!.bzr","--glob","!.jj","--glob","!.sl"]`,
   10 s timeout, `Promise.all` with the git untracked result, merge + normalize; on
   failure log the verbatim `[FileIndex] .ignore re-include listing failed: <msg>` and
   apply a retry backoff; cache successes under `cacheGeneration`.
4. Optionally adopt the every-256-entries yield in the `ignorePatterns.filter` loops for
   large repos.

## Item 12 — subagent worktree removed while background subagent still in it — **PORT**

**OCC surface:** `src/tools/AgentTool/AgentTool.tsx:753-795` `cleanupWorktreeIfNeeded`:
- hook-based branch keeps (line 770: `` logForDebugging(`Hook-based agent worktree kept at: ${worktreePath}`) `` — already matches official),
- then `if (await shouldRemoveUnchangedAgentWorktree({ worktreePath, headCommit })) { await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot); ... return {} }` (780-782),
- else keeps with `Agent worktree has changes, keeping: ${worktreePath}` (791).
NO check whether another (background) subagent task is still running with its cwd inside
the worktree. OCC HAS background subagents (`run_in_background` @AgentTool.tsx:100,
120 s auto-background @74-80) and a `src/utils/taskRegistry.ts` (which currently tracks
no cwd), so the official's exact bug (parent agent finishes → worktree deleted under a
running background child) is reachable. Removal helpers:
`src/utils/worktree.ts:1397 removeAgentWorktree`, `:1677 shouldRemoveUnchangedAgentWorktree`.

**Official evidence (v311-only):** `tengu_agent_worktree_kept` in the new-events set;
`is still the working directory of` v310: 0 / v311: 2 (table @125785316 — alongside
`parked_task`, `live_task`, `before_check`, `after_check`, `Agent worktree kept at `,
`: backgrounded owner awaits keepalive, resume pending`, `Hook-based agent worktree kept
at: `; code @256785765). Cleanup `We=async()=>{...}` verbatim core:
```
if(W&&(V===void 0||E===void 0))return t(`Hook-based agent worktree kept at: ${r}`),{worktreePath:r};
if(d4n(q.get(ye)))return t(`Agent worktree kept at ${r}: backgrounded owner awaits keepalive, resume pending`),{worktreePath:r,worktreeBranch:_};
... let F=(te)=>Nn(q.all(),E===void 0?[r]:[r,E],te),
    ee=()=>F()??F((te)=>te.id!==ye&&Gt(te,q)), J=ee(),
    j = <async dirty-check: sln(r,v) or KGe(...).then(te=>te.dirty||te.checkoutMoved===!0)>,
    oe=J??ee();
if(oe){ t(`Agent worktree ${r} is still the working directory of ${oe.type} task ${oe.id}; kept`),
        a("tengu_agent_worktree_kept",{reason:Go(oe.status)?b("parked_task"):b("live_task"),
          task_type:c(oe.type), seen:J?b("before_check"):b("after_check"), changed:j}),
        C&&Fn({worktreePath:r,gitRoot:C,taskRegistry:q,findOccupant:F});   // re-arm cleanup
        return {worktreePath:r,worktreeBranch:_} }
if(!j&&(await Jde(r,_,C,W??!1,"agent_tool")).outcome==="removed") ...
```
Semantics: scan the task registry for any task whose working dir is the worktree (or its
vetted real path) — BEFORE and AFTER the async dirty check (`seen: before_check /
after_check`); keep + re-arm deferred cleanup when occupied; also keep when the OWNER
itself was backgrounded awaiting keepalive (`d4n(q.get(ye))`).

**Action (OCC):**
1. Give OCC a way to find occupants: record each spawned subagent's cwd/worktreePath in
   a live registry (extend `src/utils/taskRegistry.ts` or a module-level map in
   AgentTool) keyed by task id, including background runs.
2. In `cleanupWorktreeIfNeeded` (AgentTool.tsx:753): BEFORE calling
   `shouldRemoveUnchangedAgentWorktree`, look up any OTHER running/parked task whose cwd
   is inside `worktreePath`; run the lookup again AFTER the async unchanged/dirty check
   (mirroring before_check/after_check); on hit, keep the worktree, log
   `` `Agent worktree ${worktreePath} is still the working directory of ${type} task ${id}; kept` ``
   and re-arm cleanup for when the occupant finishes.
3. Also keep when this agent itself was auto-backgrounded and its run is still pending.
4. Optional telemetry parity: `tengu_agent_worktree_kept` with
   `reason: parked_task|live_task`, `seen: before_check|after_check`.

## Item 13 — background auto-mode agents starting a turn on every wake — **N-A**

**OCC surface:** none — this is the official print-session/CCR background-wait park
machine (`Mh` class keepalive). OCC runs background sessions through its own daemon
supervisor (see CLAUDE.md "Background Task Safety" / `occ daemon` subcommands); there is
no park/keepalive state machine with `otherWork`/`ownedWorkPending` classification.

**Official evidence (v311-only, pinned for the record):** `hasLiveSessionWakeup` 0/4
(table @120537644; class fields @276925142/276925645/276926091; use @276929060);
`hasWakeSince` 0/2 (table @118453972; code @257362035/@257367847). Park keepalive now
passes `ownedWorkPending:{schedule_wakeup:ve||this.hasLiveSessionWakeup(S),eval_tool:he}`;
construction @277504178:
`hasLiveSessionWakeup:(pe)=>Sn()&&(!$e.inputClosed||iQe())&&(Dt>0||Rh(hm(),{now:pe,parkedSince:0}))`.
`hasWakeSince` gates the StreamingToolExecutor drain loop
(`!A.hasUnfinishedTools()&&!A.hasWakeSince(S)`, yielding `{type:"tool_drain_tick"}`).

**Action:** none — absent subsystem by design.

## Item 14 — Bash tool description claiming cwd always persists — **PORT**

**OCC surface:** `src/tools/BashTool/prompt.ts:505` (description join @502-516):
```
"The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh)."
```
plus the fallback in `src/tools/BashTool/BashTool.tsx:525`. This is the OLD claim the
official corrected (and diverges from the v310 official text too).

**Official evidence:** v310 @248157888 old bullet:
```
- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.
```
v311 replaces it with `let G=s?vti:`- ${i5t()} Prefer absolute paths — ...`` where:
```
function i5t(){return c8t()
  ? "Every call starts in the start folder: a `cd` does not carry over."
  : "`cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was."}
function c8t(){return Le(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)}
```
`Every call starts in the start folder` is v311-only (table @120190604, code @249946543).

**Action (OCC):** in `src/tools/BashTool/prompt.ts` replace the line-505 sentence with
the official conditional bullet: when
`isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)` →
`` "Every call starts in the start folder: a `cd` does not carry over." `` else →
`` "`cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was." ``,
followed by the official tail `Prefer absolute paths — ...` (recover the exact v311 tail
bytes at @249946543 during implementation), keeping OCC's existing
"Shell state (env vars, functions) does not persist; the shell is initialized from the
user's profile." sentence per the official layout. Update the BashTool.tsx:525 fallback
consistently. NOTE: OCC's actual runtime cwd behavior must be checked — if OCC's BashTool
really does persist cwd across calls unconditionally (persistent shell process), the
description must match OCC's real behavior OR the behavior must be aligned first; do not
ship a description that lies in the other direction.

## Item 15 — environment block naming the wrong shell — **PORT**

**OCC surface:** `src/constants/prompts.ts:783-794` `getShellInfoLine()` (used @654 and
@699 in the environment block) replicates the v310 behavior: it names `$SHELL` (e.g.
fish) even when the Bash tool actually runs zsh/bash. OCC's shell picker:
`src/utils/Shell.ts` `findSuitableShell()`.

**Official evidence (v311):**
```
function $to(){ /* win32 same as v310 */ ;
  let r=VVs(); if(r===void 0) return n;
  let s=cDe(r);
  if(!i.SHELL||cDe(i.SHELL)===s) return s;
  return `${s} (login shell: ${cDe(i.SHELL)})`}
VVs(){ if(Kv())return;                       // win32 → undefined
  return Km(yL("zsh"),yL("bash")).find((e)=>{ try{return yxt(e,i.PATH??"")!==null}catch{return!1} }) }
yxt(t,o){ return h(t,Bun.which(t,{PATH:o})) }
cDe = basename; Km = candidate builder from CLAUDE_CODE_SHELL / SHELL plus
["/bin","/usr/bin","/usr/local/bin","/opt/homebrew/bin"]; memoized via
`e.shellDescription??=$to()`.
```
i.e. the block names the shell commands ACTUALLY run in (zsh/bash detection), and only
mentions `$SHELL` as `(login shell: X)` when it differs.

**Action (OCC):** rewrite `getShellInfoLine()` in `src/constants/prompts.ts`:
1. Resolve the shell the BashTool actually uses (reuse `findSuitableShell()` from
   `src/utils/Shell.ts` — same zsh-then-bash candidate order, honoring
   `CLAUDE_CODE_SHELL`/`SHELL` + the standard bin dirs, verified via a `which`-style PATH
   lookup).
2. If detection fails → keep the current text.
3. Else emit `basename(detected)`; when `$SHELL` is set and its basename differs, emit
   `` `${detected} (login shell: ${basename(process.env.SHELL)})` `` — verbatim official
   format.
4. Memoize per session (`shellDescription ??=` pattern).

## Item 16 — mcp add/remove//mcp naming current folder vs project entry — **N-A (no OCC gap)**

**OCC surface:** OCC's local-scope server storage is ALREADY keyed by the project entry,
not the current folder: `src/utils/config.ts:1717-1726` `getProjectPathForConfig()` →
`findCanonicalGitRoot(originalCwd)` → `normalizePathForConfigKey(gitRoot)` (fallback:
resolved cwd when not in a repo); `getCurrentProjectConfig()` (@1729) /
`saveCurrentProjectConfig()` (@1752) read/write `config.projects[thatKey]`.
`addMcpConfig`/`removeMcpConfig` local cases (`src/services/mcp/config.ts:848-857,
897-908, 959-979`) go through those helpers, and OCC's messages ("already exists in
local config", "No project-local MCP server found with name: …") name no folder at all.

**Official evidence:** **not byte-pinnable** — `project entry` 3/3 (all history-purge,
normalized-identical), `local MCP server` 5/5 normalized-identical, mcp-add region
(anchor `Added stdio MCP server` v310 @267919582 / v311 @269616517, ±6000 B)
normalized-identical except chunk churn; `mcp remove` 9→12 is string-table region growth
only; `gitRoot` 62→64.

**Action:** none — the fixed behavior is OCC's existing behavior.

## Item 17 — doubled error code (`ENOENT: ENOENT:`) — **N-A**

**OCC surface:** OCC never concatenates `${code}: ${error}` — checked
`src/cli/handlers/mcp.tsx:68`, `src/services/mcp/utils.ts:452-472/479-486/528/555-580`,
`src/services/mcp/client.ts:4559/2772/2840-2850`. Nothing to dedupe.

**Official evidence (for the record):** v310 `Pus` @280122420 unconditionally builds
`${code}: ${error}`; v311 `B_s` (chunk anchored `"INVALID_CONFIG","UNCONFIGURED"`
@282066555) adds the guard `` c===i||c.startsWith(`${i}: `)?c:`${i}: ${c}` `` over the
16-code named set.

**Action:** none. (Incidental note from earlier rounds: OCC uses ✗ U+2717 where official
uses ✘ U+2718 in mcp list output — unrelated cosmetic divergence, tracked separately.)

## Item 18 — Remote Control stuck on "Connecting" ~2 min — **N-A**

Remote Control is absent from OCC by design (no remote-control subsystem in `src/`).
No official evidence gathered; surface N-A.

## Item 19 — cloud/RC messages appearing as own message in mobile apps — **N-A**

Cloud sessions / Remote Control absent from OCC by design. No action.

---

## Items 20–92 (parallel triage agents)

*(Sections appended from the three background triage agents — items 20-42, 43-64,
65-92 + env sweep — when they complete.)*
