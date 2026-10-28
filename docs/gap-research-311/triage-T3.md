# Triage T3 — official claude-code 2.1.310 → 2.1.311, changelog items 43–64

- Date: 2026-10-28
- OCC revision: `d2ba57a5235b4809fd823a0580e862a1db8bc500`
- Official binaries (read-only forensics, never executed):
  - v310: `/tmp/cc-diff-311/v310/package/claude`
  - v311: `/tmp/cc-diff-311/v311/package/claude`
  - String dumps: `/tmp/cc-diff-311/s310.txt`, `s311.txt`, `new_strings.txt`
- Method: `grep -aboF "LITERAL" <binary>` → byte offset → `dd if=<binary> bs=1 skip=OFFSET count=N`.
  Every candidate string count-verified against BOTH binaries (`new_strings.txt` is line-granular —
  whole minified chunks appear "new" if any string inside changed). Region diffs done token-wise
  with minifier-rename filtering (skip opcodes where token counts are equal and neither side
  contains a string literal). v310↔v311 offsets shift ~1.4–1.9 MB; anchors located separately per build.
- Item text source of truth: `docs/gap-research-311/changelog-310-311-items.txt` (line N = item N).

## Summary table

| # | Changelog (abridged) | Verdict | One-line reason |
|---|---|---|---|
| 43 | `--plugin-dir` folder-of-plugins w/ empty `.mcp.json` | N-A | Fix patches an edge case of folder-of-plugins; OCC loads each `--plugin-dir` path as ONE plugin (no folder-of-plugins mode); logic-only fix, not byte-pinnable |
| 44 | `/usage` large prompt-cache misses never shown | **PORT** | v311 adds `recached` token field + per-stream prev-record aggregation + `compact_boundary` reset; cache-miss bucket becomes `uncached+recached > 1e5`; OCC still v310 (`uncached > 1e5`) |
| 45 | Status line links render plain text in bg sessions | N-A | Hyperlink caps-propagation mechanism identical in both builds (all strings 1=1/4=4/16=16); fix not byte-pinnable; OCC lacks official bg-sessions/attach |
| 46 | `/rewind` "will be forked" wording | **PORT** | v310 `"The conversation will be forked."` → v311 `"This message and everything after it will be removed."` (pinned); OCC `MessageSelector.tsx:446` still v310 text |
| 47 | `/rewind` manual/Bash edits warning | **PORT** | v310 `"Rewinding does not affect files edited manually or via bash."` → v311 `"Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone."` (pinned @238723329); OCC `MessageSelector.tsx:381–386` still v310 text |
| 48 | Plan approval SR mode Escape-dismissed feedback | N-A | Plan-approval region diff is renames-only (±8000 B window); fix not byte-pinnable; OCC Escape path already drops dismissed feedback (same behavior as described fix) |
| 49 | Retry watchdog (`CLAUDE_CODE_RETRY_WATCHDOG`) | **PORT** | v311 moves the `x-should-retry:false` + watchdog-gate early-return BEFORE all force-retry-true branches in `shouldRetry`; OCC `withRetry.ts:2707` has the v310 ordering bug |
| 50 | Linux bwrap "Can't create file" w/ plugin-dir + `blockReadsOutsideWorkingDirectories` | N-A | `'Can't create file'` 0=0 in both binaries (bwrap's own message); setting absent from OCC `PermissionsSchema` (staged per OCC-107/108); OCC sandbox-adapter has no such cross-list conflict |
| 51 | Self-hosted runner rate-limit repo | N-A | No self-hosted runner in OCC |
| 52 | Startup: skip two network requests within an hour (Pro/Max) | N-A | NO code diff — all strings 2=2/5=5, region diff renames-only; it's a `tengu_cicada_nap_ms` gate-value rollout; OCC `main.tsx:2860–2897` already has the identical gate |
| 53 | `/teleport` compaction warning | N-A | No teleport in OCC |
| 54 | Bg-session process-exit messages | N-A (STAGED note) | Official exit/attach messages fully pinned, but they belong to the official bg-sessions/attach system OCC doesn't have; OCC has its own daemon (`src/daemon/*`, attach is a stub) |
| 55 | Artifacts views | N-A | No Artifacts in OCC |
| 56 | Shell timeout shows output-so-far + still-running | **PORT** | v311 `OLr` builder pinned: partial output inlined, new "It is running now: do not start a second copy…" line, new no-output buffering warning, new `subagentCapApplied`/`noOutputSeenAtTimeout` params; OCC discards partial stdout on auto-background and lacks all three |
| 57 | Compaction re-ask for missing summary | **PORT** | v311 reactive-compact path re-asks ONCE for a missing `<summary>` block (gated on `compactionApiAttemptsLeft`); pinned strings + full control flow; OCC throws `no_summary` immediately |
| 58 | Artifact tool page-vs-document | N-A | No Artifact tool in OCC |
| 59 | Startup time: options-only args (`claude --model opus`) | N-A (not byte-pinnable) | No string-level evidence in `new_strings.txt` (`optionsOnly`/`onlyOptions`/`lastLaunch` absent); likely runtime/argv-handling optimization; perf-only |
| 60 | "Connection dropped" error improvement | **PORT** | v311 appends proxy/gateway or VPN/firewall advice sentence to `API Error: Connection dropped (…)`, fully pinned incl. prefix `"API Error"`; OCC has no Connection-dropped mapping at all |
| 61 | SR: "Deleted allow rule …" immediately | **PORT** | v311 delete handler calls `K0("[Deleted <behavior> rule <value>]")` on success (and a could-not-delete variant) immediately; `K0` identity confirmed = screen-reader announce fn; OCC buffers the message until dialog exit, no SR announcement |
| 62 | Pasted sign-in code refused message | **PORT** | v311 adds `AuthCodeRefusedError` ("That code wasn't accepted…") thrown when token exchange fails on a manually-pasted code (`_q` invalid-grant predicate); telemetry `oauth_pasted_code_refused`; OCC shows generic token-exchange failure |
| 63 | Slack connector | N-A | No Slack connector in OCC |
| 64 | SR: "Questions: Color (answered), Pages" listing | **PORT** | v311 SR-mode question nav builds `Questions: <labels joined ", ">` with `(answered)` suffix (v310=0→v311=2); OCC has per-tab inline "answered " prefix, no SR listing |

**PORT: 44, 46, 47, 49, 56, 57, 60, 61, 62, 64** (10) · **N-A: 43, 45, 48, 50, 51, 52, 53, 54, 55, 58, 59, 63** (12)

---

## Item 43 — `--plugin-dir` pointing at a folder-of-plugins with an empty `.mcp.json`

**Verdict: N-A** (fix patches an edge case of a feature OCC does not have; also not byte-pinnable)

**Official evidence.** All plugin-dir detection strings are PRE-EXISTING (v310 count = v311 count):
`'Skipping out-of-directory MCP source'` 2=2, `'declare MCP servers inline'` 1=1, `'has no plugin content'` 9=9
(code offsets v310 242304263/244664335/244664583/247378508/251393042; v311 244164889/246512729/246512977/249161049/252933776),
`'plugin-shaped root'` 2=2 (v310@251393346, v311@252934080), `'monitors","workflows'` 2=2
(v310 244660533/261453155, v311 246508927/263572571 — both regions token-diffed: renames only),
`watchCollections` 5=5, folder-failed 4=4, hadLoaded 3=3. Detection constants (both builds,
`new_strings.txt` @24610482):

```js
pmn=".claude-plugin"
_Wt=["commands","skills","agents","hooks","themes","output-styles","monitors","workflows"]
$e=["SKILL.md",".mcp.json",".lsp.json"]
SSt=[pmn,..._Wt,...$e]
NWr(e){return SSt.includes(e)}          // entry looks like plugin content
wSt(e)                                   // readdir → filter → some(NWr)
mmn(e)                                   // single-wrapper-dir resolver
```

No new/removed strings and no non-rename code diff found in the plugin-load regions → the fix is a
logic-only adjustment (empty `.mcp.json` no longer makes a folder-of-plugins root look "plugin-shaped" /
no longer aborts the folder load). **Not byte-pinnable.**

**OCC surface.** `src/main.tsx:1146` (`--plugin-dir` flag); `src/services/plugins/pluginLoader.ts:3166`
`loadSessionOnlyPlugins()` loads each path as ONE plugin via
`createPluginFromPath(resolvedPath, \`${dirName}@inline\`, true, dirName)`. OCC has **no folder-of-plugins
mode** — the fixed edge case cannot occur.

**Action.** None now. STAGED note: when OCC adds folder-of-plugins support, treat an empty `.mcp.json`
as "no plugin content" for the root itself but still scan children, and don't let a zero-byte `.mcp.json`
fail the folder load.

---

## Item 44 — `/usage`: large prompt-cache misses were never shown

**Verdict: PORT** (special attention — fully decoded)

**Official evidence.** The novel token is **`recached`**: v310 = **0** hits, v311 = **6**
(v311 offsets 126040372 string pool; 258289975 / 258289986 / 258290007 / 258292184 / 258294109 code).
Classification function anchors: `cacheMissCost` v310 125979404/256880478/256881672/256882783,
v311 126040524/258292918/258294123/258295234. `isMaxEffort` v310 256879819/256881755, v311 258292259/258294206.

Four coordinated changes in the /usage binary-jsonl scanner (v310 fn names → v311 fn names in parens):

1. **Record parse gains `recached:0`** — v310 (`jt`):
   `return{ts:c,sessionId:i,cached:u,cacheCreate:a,uncached:d,output:T,isSubagent:...}` →
   v311 (`Vt`, @~258292184):
   ```js
   return{ts:c,sessionId:i,cached:u,cacheCreate:a,recached:0,uncached:p,output:T,
          isSubagent:Hh(e,ze,n,o)>=0||Hh(e,Ve,n,o)>=0,isMaxEffort:Qt(e.subarray(n,o),Qe),
          isWorkflow:s,alwaysOnTokens:0,largeToolResultTokens:0,modelTier:Pt(R),model:R,uuid:...,
          ...g&&{attributionAgent:...,attributionSkill:...,attributionPlugin:...,attributionMcpServer:...}}
   ```
2. **New per-stream prev-record aggregation** — v311 record callback (@258292918 region), absent in v310:
   ```js
   let S=Vt(m,0,f,o);
   if(S){J(p,S);
     let E=u.get(S.isSubagent);
     if(E?.cached===S.cached&&E.cacheCreate===S.cacheCreate&&E.uncached===S.uncached)
       S.recached=E.recached;
     else if(E)
       S.recached=Math.min(S.cacheCreate,Math.max(0,E.cached+E.cacheCreate-S.cached));
     u.set(S.isSubagent,S)}
   ```
   `u` = `Map<isSubagent, previousRecord>` — semantics: of this request's `cacheCreate` tokens, the
   part that re-caches content the previous request already had cached (`E.cached+E.cacheCreate`) but
   that this request did NOT read as cached (`S.cached`) = cache churn. Identical prev numbers (retry /
   duplicate) inherit `E.recached`.
3. **New reset at compaction boundaries** — v311-only branch, marker resolved:
   `lt=[d.encode('"subtype":"compact_boundary"'),...[]]`; `if(k(m,lt,f)){u.clear();return}` —
   recached is never computed across a `compact_boundary` line.
4. **Cache-miss bucket condition changed** — v310 (`re`): `if(n.uncached>xe)e.cacheMissCost+=s,e.cacheMissCount++`
   → v311 (`ie`): `if(n.uncached+n.recached>Ne)e.cacheMissCost+=s,e.cacheMissCount++`.
   Threshold constants verified UNCHANGED in both builds: cache-miss `=1e5` (100 000), long-context
   `=150000` (v310 `xe=1e5,Ne=150000`; v311 `Ne=1e5,Ie=150000` — minifier names reshuffled, values identical).
   Long-context bucket unchanged: `r=n.cached+n.cacheCreate+n.uncached; if(r>Ie)...` (recached NOT added —
   it is a subset of cacheCreate).

Everything else in the region is renames-only; behavior advice strings unchanged
(`'Compact before you step away'` 2=2, `cache_missed_input_tokens` 3=3, `tengu_prompt_cache_diagnosis_received` 2=2,
`subagent_heavy` 5=5). Advice chunk (both builds): `case"cache_miss":return{title:"Compact before you step away",action:{kind:"command",command:"/compact"}}`.

**OCC surface.** `src/commands/usage/usageScan.ts`:
- record type ~:110–130 (`cached`, `cacheCreate`, `uncached`, `isSubagent`, …) — **no `recached`**;
- record build :500–516 (`Number(usage.input_tokens)` etc., `isSubagent: parsed.isSidechain === true`) — no prev-record tracking, no `compact_boundary` reset;
- classification :290–298: `const contextTokens = record.cached + record.cacheCreate + record.uncached; if (record.uncached > CACHE_MISS_UNCACHED_TOKENS) { … }` — exactly v310 behavior;
- constants :92 `CACHE_MISS_UNCACHED_TOKENS = 100_000`, :94-ish `LONG_CONTEXT_TOKENS = 150_000` (values match official — keep);
- header doc comment :20 ("cache miss uncached >1e5") — update alongside.

**Action (PORT).**
1. Add `recached: number` to the usage-record type; initialize `recached: 0` where records are built.
2. In the scan loop keep `Map<boolean, UsageRecord>` (key = `isSubagent`) of the previous record; for each
   new record apply the official aggregation verbatim (inherit on identical cached/cacheCreate/uncached,
   else `recached = min(cacheCreate, max(0, prev.cached + prev.cacheCreate − cur.cached))`), then store.
3. On encountering a transcript line with `"subtype":"compact_boundary"`, clear the map and skip the line.
4. Change the cache-miss bucket condition to `record.uncached + record.recached > CACHE_MISS_UNCACHED_TOKENS`.
   Leave long-context (`cached+cacheCreate+uncached > 150 000`) and all thresholds unchanged.
5. Update the file-header comment and any evidence text mentioning the old condition.

---

## Item 45 — status line links rendered as plain text in background sessions

**Verdict: N-A** (mechanism pre-existing in both builds; fix not byte-pinnable; OCC lacks the official bg-session/attach system)

**Official evidence.** All hyperlink/statusline caps strings identical across builds:
`'?.hyperlinks'` 1=1, `FORCE_HYPERLINK` 4=4, `wheelFlood` 16=16, `'progressReporting:'` 2=2,
`assumeSupport` 16=16, `shownUrlStart` 4=4 (code offsets v310 253383586/253401759/253401911,
v311 254728557/254747241/254747393 — formatter region token-diff: renames only). Mechanism present in
BOTH builds: caps dispatch schema `caps:u({imark:…,hyperlinks:M().optional(),progressReporting:M().optional(),…})`;
caps builder `ur(){return{imark:!0,…,hyperlinks:Ew(),progressReporting:sut(),…}}`; detection
`K1e(r){let n=Du()?.hyperlinks;if(n!==void 0)return n;if("FORCE_HYPERLINK"in(r?.env??process.env))…}`;
`Ew()` TERM_PROGRAM fallback chain (ghostty/Hyper/kitty/alacritty/iTerm/Warp, JediTerm, WT_SESSION, tmux);
OSC-8 formatter `fv(e,r,t)` with `x$n="\x1B]8;;"`, `P$n="\x07"`. No new strings for this item → not byte-pinnable.

**OCC surface.** `src/components/StatusLine.tsx:335–337` renders raw `<Ansi>`; `src/ink/supports-hyperlinks.ts`
(not memoized); `src/bridge/bridgeUI.ts:244` + `bridgeStatusUtil.ts:161–163` emit OSC-8 unconditionally.
OCC has no official-style bg sessions receiving `caps` from a dispatcher.

**Action.** None. If OCC later ports the official bg-session dispatch, ensure `caps.hyperlinks` travels with
the session and the statusline formatter honors it (plain text when false).

---

## Item 46 — `/rewind`: "will be forked" wording

**Verdict: PORT** (pinned, one-line string swap)

**Official evidence.** v310 (`AUe`): `case"both":case"conversation":return"The conversation will be forked.";`
v311 (`zje`, full switch in `/tmp` dump rw311.txt):
```js
function zje(h){switch(h){
 case"summarize":return"Messages after this point will be summarized.";
 case"summarize_up_to":return"Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.";
 case"both":case"conversation":return"This message and everything after it will be removed.";
 case"code":case"nevermind":return"The conversation will be unchanged."}}
```
Count: `"will be forked"` v310=2, v311=0. Other cases unchanged.

**OCC surface.** `src/components/MessageSelector.tsx:446`: `return 'The conversation will be forked.';` (both/conversation case).

**Action (PORT).** Replace the both/conversation return with byte-verbatim
`"This message and everything after it will be removed."`. Verify the summarize / summarize_up_to / code /
nevermind cases already match the v311 switch (they were unchanged between builds).

---

## Item 47 — `/rewind`: warning about manual/Bash edits

**Verdict: PORT** (pinned, one-line string swap)

**Official evidence.** v310 `_Ue="Rewinding does not affect files edited manually or via bash."`
(render context in rm310.txt: `En&&Yn?r(s,{flexDirection:"column",children:[jn,e(n,{dimColor:!0,children:_Ue})]}):jn`).
v311 (offset **238723329**): `vls="Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone."`
Render position identical: `children:[jn,e(n,{dimColor:!0,children:vls})]}):jn`.
Secondary check: `'the tracked path is'` (skipped-links explainer) v310=2=v311 → PRE-EXISTING, not part of
this change. Skipped-files message unchanged: `` `Restored the code, but skipped ${Qr} ${Qr===1?"file":"files"}: ${kdr}. Skipped files were left untouched — run with --debug for the paths.` ``

**OCC surface.** `src/components/MessageSelector.tsx:381–386` renders
`{figures.warning} Rewinding does not affect files edited manually or via bash.`

**Action (PORT).** Swap to byte-verbatim
`Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone.`
(keep OCC's warning-icon prefix and dimColor styling; the official renders the same position with dimColor).

---

## Item 48 — plan approval in screen-reader mode sends Escape-dismissed feedback

**Verdict: N-A** (official fix location not byte-pinnable; OCC already matches the described post-fix behavior)

**Official evidence.** Plan-approval region diff (v310@274051801 vs v311@275701647, ±8000 B): pure
minifier renames only (incl. `onCancel:()=>je("cancelled")`→`onCancel:()=>Ge("cancelled")`, announce fn
`PF`→`VF`). `refuseInput` 70=70. No new strings found for this item → not byte-pinnable.
v311 option/result builders for reference (new_strings @10424678):
`He.push({type:"input",label:"No, keep planning",value:"no",placeholder:"Tell Claude what to change",…})`;
allow path `{behavior:"allow",updatedInput:Ge,permissionUpdates:je.applies,feedback:Z}`;
deny path `if(h==="no"){if(!we&&!Ce)return null;return{behavior:"deny",feedback:we||(Ce?"(See attached image)":void 0),contentBlocks:…}}`.

**OCC surface.** `src/components/permissions/ExitPlanModePermissionRequest.tsx`: feedback is the 'no'
Select option (:766–773), `planFeedback` state (:154), submitted with approval (:295–296, :441/:472/:497,
shift+tab :287–291), Enter-on-'no' → onReject (:532). Escape → `select:cancel`
(`src/ink/hooks/use-select-input.ts:150–177`) → `handleCancelRef` (:546–557) which **drops the typed
feedback** — i.e., OCC already does NOT send Escape-dismissed feedback.

**Action.** None. (If the official fix was the opposite direction — ensuring SR mode *doesn't* silently send
dismissed feedback — OCC's current drop-on-Escape behavior is consistent.)

---

## Item 49 — retry watchdog (`CLAUDE_CODE_RETRY_WATCHDOG`)

**Verdict: PORT** (special attention — fully decoded; OCC has the v310 ordering bug)

**Official evidence.** v311 `shouldRetry` (`Qur`) code @251052058 / 251052567 / 251053118. NEW early gate
placed BEFORE all force-retry-true branches:
```js
if(ZXe(e)&&e.headers?.get("x-should-retry")==="false"
   &&(e.status===429||e.status===529||e.status===503&&cs())
   &&e.headers?.get(O0e)!=="fetch_error"
   &&(aAe()||gfn(e)))return!1;
```
Helpers (all pinned in v311):
```js
ZXe(e){return k2(e)||e instanceof Mt&&e.status===429}
k2(e){ … e.status===529||(e.message?.includes('"type":"overloaded_error"')??!1) }
aAe(){return i.CLAUDE_CODE_RETRY_WATCHDOG}
cs(){return Te()==="firstParty"&&xi()}
O0e="anthropic-ratelimit-unified-overage-disabled-reason"
gfn(e){if(e.headers?.get("x-should-retry")!=="false")return!1;
       let n=e.status!==void 0&&e.status>=500;return!0}
```
v310 (`w_r` @~249441200) instead had `if(IMe()&&pkn(e))return!0;if(nU(e))return!0;` BEFORE the
header-false check — i.e., server `x-should-retry:false` was ignored for overloaded/429/529 cases.
Count: `x-should-retry` v310=25, v311=27 (the 2 new = the gate + `gfn`).

**OCC surface.** `src/services/api/withRetry.ts`:
- `shouldRetry(error)` :2707 — SAME v310 ordering bug: force-true branches run first
  (persistent-mode bypass :2715–2717; `CLAUDE_CODE_REMOTE` 401/403 :2723–2728; `overloaded_error`→true :2748–2750),
  and the `x-should-retry:false` branch (:2757–2777) additionally carries an ant-5xx exception the official lacks;
- watchdog plumbing already exists: `isRetryWatchdogEnabled()` :112–117 (reads `CLAUDE_CODE_RETRY_WATCHDOG`),
  `WATCHDOG_DEFAULT_MAX_RETRIES=300` :91, retry-count gate :1393–1398.

**Action (PORT).** In `shouldRetry`, insert the official early-return gate as the FIRST check (before the
persistent-mode bypass, remote 401/403, and overloaded branches):
retry-eligible error (overloaded-shape OR 429) AND `x-should-retry === "false"` AND
(status 429 || 529 || (503 && firstParty-auth)) AND
`anthropic-ratelimit-unified-overage-disabled-reason !== "fetch_error"` AND
(watchdog env enabled OR generic header-false predicate) → return false.
Remove OCC's non-official ant-5xx exception from the header-false branch so semantics match `gfn` exactly.

---

## Item 50 — Linux sandbox: bwrap "Can't create file" with plugin dir + `blockReadsOutsideWorkingDirectories`

**Verdict: N-A**

**Official evidence.** `'Can't create file'` = 0 hits in BOTH binaries — it is bubblewrap's own error text,
not claude-code's; the fix is in how official sandbox setup orders `--ro-bind`/deny rules (logic-only, not
byte-pinnable). `permissions.blockReadsOutsideWorkingDirectories` does not appear as an OCC setting.

**OCC surface.** `src/utils/settings/types.ts:46–89` `PermissionsSchema` has no
`blockReadsOutsideWorkingDirectories` (staged per OCC-107/108). `src/utils/sandbox-adapter.ts`: plugin
dirs → denyWrite (:665–681, :1005–1041), `additionalDirs` → allowWrite (:691–700); no cross-list dedup —
but with vendored sandbox-runtime bwrap and no block-reads setting, the official failure mode (a plugin dir
ro-bind conflicting with a blanket read-deny producing "Can't create file") is not reachable today.

**Action.** None now. When `blockReadsOutsideWorkingDirectories` lands (OCC-107/108), order bwrap args so
plugin-dir binds are applied AFTER/above the blanket read-deny and verify with a folder containing an empty
`.mcp.json`.

---

## Item 51 — self-hosted runner rate-limit repository

**Verdict: N-A** — no self-hosted runner in OCC (feature absent; runner-region strings in official binary confirmed unrelated to OCC surfaces).

---

## Item 52 — startup: skip two network requests if run within an hour (Pro/Max)

**Verdict: N-A** (no code diff — remote gate-value rollout; OCC already aligned)

**Official evidence.** ALL strings pre-existing with identical counts: `'Skipping startup prefetches'` 2=2,
`'Starting background startup prefetches'` 2=2, `startupPrefetchedAt` 5=5, `tengu_cicada_nap_ms` 2=2.
±5000 B token-diff of the prefetch region (v310@257338647 vs v311@258757102): renames ONLY. v311 code
(both builds identical, new_strings @1782946):
```js
let mr=k("tengu_cicada_nap_ms",0); … let Jo=ue().startupPrefetchedAt??0;
if(!(Sr()||mr>0&&Date.now()-Jo<mr)){ … y_t(y,S).catch(…), NGt(whe(S,y)), qYs(y,S), m$e(S,y),
  if(mr>0) xe((v)=>({...v,startupPrefetchedAt:Date.now()}),S).catch(l) }
else { t(`Skipping startup prefetches, last ran ${Math.round((Date.now()-Jo)/1000)}s ago`); … }
```
Conclusion: the changelog entry is the **rollout of a non-zero `tengu_cicada_nap_ms` gate value** (≈1 h),
not a binary change.

**OCC surface.** `src/main.tsx:2860–2897` implements the identical gate (reads `tengu_cicada_nap_ms`,
persists `startupPrefetchedAt`, logs the same skip/start messages).

**Action.** None — code already at parity. Behavior follows the same remote gate default OCC's statsig
config provides.

---

## Item 53 — `/teleport` compaction warning

**Verdict: N-A** — no teleport in OCC (teleport code confirmed present in official binary via region diffs; nothing to port).

---

## Item 54 — background sessions: clearer process-exit messages

**Verdict: N-A for OCC** (official bg-sessions/attach system absent; evidence pinned here for the future STAGED port)

**Official evidence.** Attach-flow diff (v310@254295534 vs v311@255416532 ±3000). Key change,
`outcome==="disconnected"` branch — v310: `` process.stderr.write(`Session ${l} has exited${C}.`) `` → v311:
```js
process.stderr.write(v?.state==="done"&&await G_r(v,n)
  ? `Session ${l} has exited — run \`claude attach ${l}\` to resume it.\n`
  : `Session ${l} has exited${x}.\n`)
// x = v?.state==="failed"&&v.detail ? ` (${Ot(v.detail)})` : ""
```
preceded by: `` if(v?.state==="failed"&&v.detail===a2e) process.stderr.write(`Session ${l}'s terminal host died — run \`claude attach ${l}\` again to restart it on a fresh host.\n`) ``.
Error-outcome variants all PRE-EXISTING (2=2/1=1): `` `${tZe}.` ``, `` `${eZe} — run \`claude attach ${l}\` again to restart it on a fresh host.` ``,
`` `${YIt} — \`claude stop ${l}\` stops it (it runs a shell command, which is not run again for you).` ``,
`` `${YIt} — \`claude stop ${l}\`, then \`claude attach ${l}\` restarts it (the conversation is saved).` ``,
`Job is respawning after an upgrade — try attach again in a moment.`, `${$ye()} is restarting — try again in a moment.`
→ wrapped as `` `Couldn't attach to ${l} — ${N}` ``.
NEW container-restart durable-watch subagent notices: `'Each goes on where it stopped'` v310=0→v311=2;
`'The container was restarted in the middle of a turn'` 2→4; `'Every other stopped task listed here is lost'` 2→5
(v311: 120815772/120816180 pool; 276624180/276624595/276625037 code); `'has exited'` 10→11. v311 notice text:
`` `…restored from their saved transcripts: ${h.join(", ")}. Each goes on where it stopped and reports back to you in a notification when it is done, so you need not launch it again.${n(Pn)?` If one does not report back, send a message to its agent id with the ${Pn} tool to resume it.`:""} ${P||"Every other stopped task listed here is lost: do not se…"}` ``.
(`G_r` = resume-eligibility check — inferred from usage, not separately pinned.)

**OCC surface.** OCC's own daemon system: `src/daemon/respawn.ts:78/:127/:181–182`,
`src/daemon/agents.ts:95–96/:203–205`, `occ attach` = stub (`src/daemon/daemon.ts:496–509`). No official
bg-sessions, no `claude attach`/`claude stop` commands.

**Action.** None (N-A). STAGED principle worth adopting in OCC's own daemon exit messages: always say HOW to
resume (`run \`occ attach <id>\` to resume it`) and include the failure detail in parentheses.

---

## Item 55 — Artifacts views

**Verdict: N-A** — no Artifacts in OCC (Artifacts/ultraplan code confirmed present in official binary; nothing to port).

---

## Item 56 — shell command timeout: show output-so-far and that it's still running

**Verdict: PORT** (special attention — fully pinned incl. `Yl` identity)

**Official evidence.** Message builder `OLr` v311 @251496383 (v310 counterpart `pIr` @~249971000).
New params: `subagentCapApplied:S`, `noOutputSeenAtTimeout:w`. `Yl` RESOLVED = **"TaskStop"**
(`Yl="TaskStop"` v311@246947125; TaskStop counts 43=43; KillShell 6=6, KillBash 3=3, BashOutput 13=13 — unchanged).

Verbatim strings:
- Existing timeout branch (unchanged text):
  `` `Command did not complete within its ${q}s timeout and was moved to the background (ID: ${e}). Output is being written to: ${n}.` ``
  where `q=Math.max(1,Math.round((y??0)/1000))`.
- NEW backgrounded-by-cap branch:
  `` `Command was moved to the background (ID: ${e}) after running for ${q}s. Output is being written to: ${n}.` ``
- NEW still-running line (v310=0, v311=2: @124557352 pool, @251498022 code):
  `Ee=ve&&!r?` `` `It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with ${Yl}.` `` :void 0
  where `ve=y!==void 0||r||s||h` (timed out OR any backgrounding), `r` = already-completed flag.
- NEW no-output warning (v310=0, v311=2: @124557792 pool, @251498557 code):
  `"No output had been read from it when it was moved. A program that buffers its output, or a pipe into one such as tail, can keep the output file empty until the command finishes."`
- Return composition v311: `[Q,we,Oe,Ee,noOutputWarning,De].filter(Boolean).join(" ")` vs v310 `[D,V,be,we]`.
- Companion (context @4514016 in new_strings):
  `Ae=ve&&!H?ZFr(void 0):void 0, Oe=Ae!==void 0?` `` `If it is still running after ${an(Ae,{hideTrailingZeros:!0})} in the background, it will be stopped and you will be notified.` `` `:void 0`
- Schema additions: `timedOutAfterMs` — "Set when the command hit its timeout and was auto-backgrounded; the
  timeout value in ms"; `subagentCapApplied` — "@internal True if the async subagent foreground cap
  shortened the command's timeout".
- Caller @253219662: `noOutputSeenAtTimeout:G!==void 0&&!je`; result
  `content:[je,Qe,Ge,Ae,Oe].filter(Boolean).join("\n")` — **je = trimmed stdout, i.e. the partial output IS
  inlined into the tool result** alongside the message.
- Pre-existing in both: `Do not start it again; to restart it, stop it with` 2=2.

**OCC surface.** `src/tools/BashTool/BashTool.tsx`:
- timeout message :713–723 (v310-style text);
- **Path A** (auto-background at cap, :1329–1339) returns `stdout:''` — partial output NOT inlined (GAP);
- **Path B** (kill on timeout): partial stdout preserved internally by `src/utils/ShellCommand.ts:317–354`
  `#handleExit` (prepends `Command timed out after ${formatDuration(this.#timeout)}` to stderr) but
  `BashTool.call()` :854–862 discards it;
- generic background message :743–754; no "It is running now…" line, no no-output warning;
- timeouts: `DEFAULT_TIMEOUT_MS=120_000`, `MAX_TIMEOUT_MS=600_000` (`src/utils/timeouts.ts:2–3`).

**Action (PORT).**
1. Extend the timeout/backgrounded message builder with the official params and compose in official order:
   base line (timeout vs moved-after-Ns variant), the "still running after X in background it will be
   stopped" line, then verbatim
   `It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with TaskStop.`
   (OCC's stop tool name — confirm OCC's TaskStop equivalent; official uses `TaskStop`), then the verbatim
   no-output warning when no output had been read at move time.
2. Inline the partial output: include trimmed stdout collected so far in the tool result content
   (join with `\n`, filter(Boolean)) for BOTH the timeout-kill path and the auto-background path
   (Path A must stop returning `stdout:''`).
3. Add `timedOutAfterMs` to the tool-result schema with the official description; add internal
   `subagentCapApplied` if/when OCC has the async-subagent foreground cap (otherwise omit — it only feeds
   the "moved after Ns" variant selection).
4. Keep `Do not start it again; to restart it, stop it with …` behavior for the already-notified case.

---

## Item 57 — compaction: re-ask once when the summary is missing

**Verdict: PORT** (special attention — fully pinned)

**Official evidence.** The re-ask lives in the REACTIVE compact path (`Ken`, v311 ~250554455–250569303),
NOT the manual path (`_Nr` — still throws directly). v311 code:
```js
let je=xbe(Oe.messages);
if(!je) return l(Error("Reactive compact: empty summary text in summarization response")),
  {ok:!1,reason:"error",…,errorKind:"empty_summary",…};
if(jbe({path:"reactive",reply:je,…attempt:Se?2:1}), !FJ(je)&&!Mbe(je)){
  if(Se) return {ok:!1,reason:"error",detail:"no <summary> block in the second reply either",errorKind:"unknown",…};
  if(R6s()&&n.toolUseContext.compactionApiAttemptsLeft?.count!==0){
    t("Reactive compact: the reply has no <summary> block, asking for the summary once more",{level:"info"});
    let Ge=await Ken(e,n,r,s,h,y,S,w,H,G,q,Q,!0);   // 12th arg = isReask
    if(n.toolUseContext.abortController.signal.aborted) return {ok:!1,reason:"aborted"};
    if(Ge.ok) return Ge}}
```
Counts: `'asking for the summary once more'` v310=0 → v311=2 (@124303780 pool, @250556205 code);
`'no <summary> block in the second reply either'` v310=0 → v311=2 (@124303672, @250555990);
`'its reply has no <summary> block'` 2=2 (pre-existing log); `'Reactive compact: empty summary text'` 2=2.
Manual path `_Nr`: `for(;;)` PROMPT_TOO_LONG retry loop, throws
`"Failed to generate conversation summary - response did not contain valid text content"` (unchanged).

**OCC surface.** `src/services/compact/compact.ts`: throws `no_summary` immediately at :566–579; partial
handling :1017–1030; PROMPT_TOO_LONG retry :522–564; circuit breaker `src/services/compact/autoCompact.ts:458–506`.

**Action (PORT).** In the reactive/auto compaction path only:
1. Parse the summarization reply; if non-empty but lacking a `<summary>` block (and not otherwise acceptable):
2. If this is already the re-ask attempt → fail with detail `"no <summary> block in the second reply either"`.
3. Else if the feature gate is on and `compactionApiAttemptsLeft.count !== 0` → log
   `Reactive compact: the reply has no <summary> block, asking for the summary once more` (level info) and
   recurse ONCE with an isReask flag; honor abort (`{ok:false,reason:"aborted"}`); return the re-ask result if ok.
4. Leave the manual `/compact` path throwing as today.

---

## Item 58 — Artifact tool page-vs-document

**Verdict: N-A** — no Artifact tool in OCC.

---

## Item 59 — faster startup when only option-like args are passed (`claude --model opus`)

**Verdict: N-A / not byte-pinnable.** No candidate strings in `new_strings.txt`
(`optionsOnly`, `onlyOptions`, `'only arguments'`, `36e5`, `lastLaunch` — none present); `positional` hits
belong to self-hosted-runner (@3894092) and cloud-session (@5542309) code, unrelated. Almost certainly a
runtime/argv-handling fast path with no string footprint. Perf-only; no OCC action (OCC may adopt the same
idea independently: skip full config/project resolution when argv contains only flags and no prompt/REPL work — STAGED perf note).

---

## Item 60 — "Connection dropped" error improvement

**Verdict: PORT** (special attention — fully pinned incl. prefix)

**Official evidence.** Prefix RESOLVED: `var Vl="API Error"` (v310) / `var ed="API Error"` (v311);
`les="Connection dropped"`. v310 (@~248272900):
```js
let K=Ym(e)?.code??"",V;
if(vai.has(K))V="tls_untrusted_ca";
else if(K==="BedrockUnexpectedContentType")V="gateway_content_type";
return Xs({content:`${Vl}: ${Sbe(e)}`,error:"server_error",apiError:V})
```
v311 (@~250055088):
```js
let G=ig(e)?.code??"",q;
if(Igi.has(G))q="tls_untrusted_ca";
else if(G==="BedrockUnexpectedContentType")q="gateway_content_type";
let Q=YSe(e),Se="";
if(Q===`${les} (${G})`&&!oYe()&&Te()==="firstParty"&&i.ANTHROPIC_UNIX_SOCKET===void 0){
  let we=YB(),ve=[
    ...we&&!Yy(j2r())?[`the proxy set in ${we.source}`]:[],
    ...NFe()!==void 0?["the gateway set in ANTHROPIC_BASE_URL"]:[]];
  Se=ve.length>0
    ? `. Check ${ve.join(" and ")}, then try again.`
    : ". A VPN, firewall, or security software can cause this. Check those or switch networks, then try again."}
return Ws({content:`${ed}: ${Q}${Se}`,error:"server_error",apiError:q})
```
`oYe()` = host-managed gate; `YSe` (connection-error formatter) IDENTICAL in both builds:
ECONNRESET/EPIPE/ECONNABORTED/ConnectionClosed/ERR_SOCKET_CLOSED/UND_ERR_SOCKET → `` `${les} (${a})` ``;
ECONNREFUSED → `` `Connection refused — a firewall or proxy may be blocking it (${a})` ``;
ENOTFOUND/EAI_AGAIN/FailedToOpenSocket → `` `Can't reach the API server — check your internet or DNS (${a})` ``;
ENETUNREACH/ENETDOWN/EHOSTUNREACH/EHOSTDOWN → `` `No internet route — check your connection or VPN (${a})` ``;
ERR_PROXY_TUNNEL → `` `Couldn't connect through your proxy (${a}) — the proxy refused the tunnel: check its credentials and that it allows this host` ``.
Counts: `'A VPN, firewall, or security software can cause this'` v310=0 → v311=2 (@124169494, @250055449);
`'the gateway set in ANTHROPIC_BASE_URL'` v310=0 → v311=2 (@124169400, @250055340); `'the proxy set in '` 2→4.
Also new in v311: `Qdr(e)` diagnostic shape `{message,status,requestId,formatted:YSe(e),connection:ig(e),isNetworkDown:he(e),rateLimits:{rateLimitType,resetsAt}|null,noResponse:{waitedMs,retryWaitMs}|null}`.

**OCC surface.** NO `"Connection dropped"` anywhere in `src/`; `formatAPIError`
(`src/services/api/errorUtils.ts:201–261`) has no per-code connection-error switch.

**Action (PORT).**
1. Add the `YSe`-equivalent per-code formatter (byte-verbatim strings above; `les="Connection dropped"`).
2. In the server_error construction path, when the formatted message is exactly `Connection dropped (<code>)`
   AND not host-managed AND firstParty auth AND `ANTHROPIC_UNIX_SOCKET` unset, append the advice sentence:
   proxy/gateway variant `` `. Check ${ve.join(" and ")}, then try again.` `` (ve built from proxy-config
   source and `ANTHROPIC_BASE_URL` presence) or fallback
   `". A VPN, firewall, or security software can cause this. Check those or switch networks, then try again."`
3. Final content: `` `API Error: ${formatted}${suffix}` ``.

---

## Item 61 — screen reader: "Deleted allow rule …" announced immediately

**Verdict: PORT** (pinned incl. `K0` identity)

**Official evidence.** v311 delete handler (code @284334717; context new_strings @38655662):
```js
fu=()=>{ … pLr({rule:X, …}).then(()=>{
    A((Oh)=>[...Oh,`Deleted ${hu} rule ${he.bold(Ci)}`]),
    K0(`[Deleted ${hu} rule ${yu}]`)
  }).catch(($h)=>{
    l($h),
    A((Bh)=>[...Bh,`Could not delete ${he.bold(Ci)} — the rule is unchanged`]),
    K0(`[Could not delete ${yu} — the rule is unchanged]`)
  }), ge(void 0)}
```
`K0` identity CONFIRMED = screen-reader announcement fn: `function VF(h){K0(\`[${vW(h)} on]\`,{hold:!0})}`
matches OCC's `pushScreenReaderAnnouncement(\`[${permissionModeIndicator(mode)} on]\`,{hold:true})` exactly.
Counts: `'[Deleted '` v310=0 → v311=2 (@129910068 pool, @284334717 code); `'[Could not delete '` 0→2;
`'the rule is unchanged'` 4→5. Auto-mode variant (new_strings @36992172):
`` `Deleted auto mode ${fe($e.section).toLowerCase()} rule ${he.bold(ka(_a($e.text).text))}` ``.
Anchor: `'Permissions dialog dismissed'` offsets v310 129840696/282380859/282381183, v311 129910032/284333770/284334094.

**OCC surface.** `src/components/permissions/rules/PermissionRuleList.tsx:915` buffers
`` `Deleted ${selectedRule.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(selectedRule.ruleValue))}` ``
into `changes`, surfaced ONLY on dialog exit (:842–854); no SR announcement at delete time.

**Action (PORT).** In the delete `.then()`, keep the buffered visible message AND immediately call
`pushScreenReaderAnnouncement(\`[Deleted ${ruleBehavior} rule ${plainValue}]\`)`; in the `.catch()`, buffer
`` `Could not delete ${chalk.bold(value)} — the rule is unchanged` `` and announce
`[Could not delete ${plainValue} — the rule is unchanged]`. Use the unstyled rule value inside the SR brackets
(official passes `yu=ra(Ci)` — the plain string — to `K0`, bold only in the visual message).

---

## Item 62 — pasted sign-in code that was refused: clearer message

**Verdict: PORT** (fully pinned incl. throw site)

**Official evidence.** New v311 class (string pool @123203984; code @243338209):
```js
class GRe extends Error{constructor(){
  super("That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.");
  this.name="AuthCodeRefusedError"}}
```
Throw site (new_strings @20840543, inside `V$.startOAuthFlow` token-exchange catch):
```js
}catch(c){
  let u=!h&&_q(c);
  if(m("oauth_login",u?"oauth_pasted_code_refused":"oauth_login_failed"),
     h) this.authCodeListener?.handleErrorRedirect();
  if(!r?.inferenceOnly&&!r?.oauthClient) efe({action:"login",success:!1,authMethod:"oauth",error:c});
  throw u?new GRe:c
}finally{this.authCodeListener?.close()}
```
where `h=this.authCodeListener?.hasPendingResponse()??!1` (h=false ⇒ code was manually pasted, not
browser-redirected) and `_q` = pre-existing invalid-grant predicate. v310 counterpart (@252085000):
`catch(c){if(m("oauth_login","oauth_login_failed"),h)this.authCodeListener?.handleErrorRedirect();…throw c}`
— no GRe, no `oauth_pasted_code_refused`. Counts: `'That code wasn't accepted'` v310=0 → v311=2
(@123203984, @243338209); `'AuthCodeRefusedError'` 0→2 (@123204132, @243338363); `'pasted_code_refused'`
0→2 (@123204426, @243340954). Catch sites: design login `rt instanceof GRe` → "Design login failed: …";
CLI login: `if(i instanceof GRe||Np(i,_qt)||i instanceof zee||i instanceof err||i instanceof k)
t(\`OAuth login failed: ${d(i)}\`,{level:"error"}); else l(i)` and `let o=i instanceof zee?i.displayMessage:d(i)`;
result `{ok:!1,reason:"code_refused",message:a.message}`. Nearby new constants:
`err`=CallbackListenerUnavailableError("Couldn't start the local listener that receives the browser sign-in. Try again."),
`trr="The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown."`,
`nrr="Paste code here > "`.

**OCC surface.** `src/components/ConsoleOAuthFlow.tsx`: `PASTE_HERE_MSG` :62
`'Paste code here if prompted > '`, malformed-paste message :234
`'Invalid code. Please make sure the full code was copied'`, error render :741
`OAuth error: {oauthStatus.message}`, retry hint :749. Server refusal today:
`src/services/oauth/client.ts:146–150` — `'Authentication failed: Invalid authorization code'` for 401,
else `` `Token exchange failed (${response.status}): ${response.statusText}` ``.

**Action (PORT).**
1. Add `AuthCodeRefusedError` with the byte-verbatim message above.
2. In the token-exchange catch of the OAuth flow: if the code was MANUALLY PASTED (no pending browser
   response) and the error is invalid-grant-shaped, emit telemetry `oauth_pasted_code_refused` (else
   `oauth_login_failed`) and throw `AuthCodeRefusedError`; browser-redirect failures keep the
   error-redirect handling and rethrow the original.
3. Login catch sites: treat `AuthCodeRefusedError` as a displayable message (show it verbatim to the user,
   log `OAuth login failed: <message>`), and surface `{ok:false,reason:"code_refused"}` where OCC's flow
   returns structured results.
4. Optional parity (same region, cheap): paste prompt `"Paste code here > "` and listener-unavailable /
   manual-paste-fallback messages — adopt only if OCC's current strings diverge after review.

---

## Item 63 — Slack connector

**Verdict: N-A** — no Slack connector in OCC.

---

## Item 64 — screen reader: question list "Questions: Color (answered), Pages"

**Verdict: PORT** (pinned)

**Official evidence.** v311 (new_strings @9634381):
```js
mn=(Pn,ho)=>{
  let qo=Pn?.displayHeader||`Q${ho+1}`;
  let un=qo.includes(",")||/answered/i.test(qo)?_(qo):qo;
  return hp(H,Pn?.key)?`${un} (answered)`:un}
…
let vn=x.map(mn);
let An=x.length===1?"Question":"Questions";
…
wt=vn.join(", ")
…
const mn=`${dt}: ${wt}`   // rendered via e(Uo,{children:mn})  — SR-only element
```
Count: `"(answered)"` v310=0 → v311=2. Non-SR branch keeps arrow keys `["←"," "]` (unchanged).

**OCC surface.** `src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx`:
`srEnabled` :28; per-tab inline `"answered "` prefix :120; no SR listing of all questions.

**Action (PORT).** When screen-reader mode is enabled, render an SR-only text element with
`` `${Questions|Question}: ${labels.join(", ")}` `` where each label =
`displayHeader ?? \`Q${index+1}\``, quoted if it contains a comma or matches `/answered/i`, suffixed with
`" (answered)"` for answered questions; singular/plural header by count. Keep the visual (non-SR) tab bar unchanged.

---

## PORT work packages (consolidated)

| WP | Item(s) | Files | Size |
|---|---|---|---|
| WP1 rewind wording | 46, 47 | `src/components/MessageSelector.tsx` (:446, :381–386) | 2 string swaps |
| WP2 retry watchdog gate | 49 | `src/services/api/withRetry.ts` (shouldRetry :2707; drop ant-5xx exception :2757–2777) | reorder + 1 gate |
| WP3 bash timeout UX | 56 | `src/tools/BashTool/BashTool.tsx` (:713–723, :743–754, :854–862, :1329–1339), `src/utils/ShellCommand.ts` (:317–354), result schema | medium |
| WP4 compact re-ask | 57 | `src/services/compact/compact.ts` (reactive path near :566–579) | small-medium |
| WP5 connection advice | 60 | `src/services/api/errorUtils.ts` (:201–261) + server_error construction path | medium |
| WP6 SR permissions/questions | 61, 64 | `PermissionRuleList.tsx` (:915, :842–854), `QuestionNavigationBar.tsx` (:28, :120) | small |
| WP7 auth code refused | 62 | `ConsoleOAuthFlow.tsx`, `src/services/oauth/client.ts` (:146–150), new error class | medium |
| WP8 usage recached | 44 | `src/commands/usage/usageScan.ts` (:110–130, :290–298, :500–516, header :20) | medium |

All byte-verbatim strings and their v311 offsets are in the per-item sections above. Nothing in this
triage was invented; unpinnable items (43, 45, 48, 59, and the bwrap side of 50) are marked explicitly.
