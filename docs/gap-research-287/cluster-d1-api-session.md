# OCC-105 gap research — cluster D1 (API / session / streaming bug entries)

Round: catch OCC up from official Claude Code **2.1.286 → 2.1.287**.
Method: **byte forensics only** on the linux-x64 Bun ELF binaries (never executed).
Binaries: `/tmp/cc-diff-287/v286/package/claude`, `/tmp/cc-diff-287/v287/package/claude`.
String dumps: `/tmp/cc-diff-287/{s286,s287,new287,del287}.txt`.
Changelog: `/tmp/cc-CHANGELOG.md` (2.1.287 = lines 3–111).
OCC repo (read-only, HEAD 6dcc320): `.../workdir/occ`.

Identifier-normalization regex used for all STRUCT-EQUAL comparisons:
`(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*` → `X` (the `\b` form fails on `$`-prefixed
minified names). Offsets below are decimal byte offsets into the respective binary; the
primary embedded JS copy lives ~199–209M (v287) / ~197–207M (v286), the duplicate copy
~215–233M / ~213–231M. Verbatim code is quoted from the primary copy.

## Verdict summary (16 assigned entries)

| # | CL line | Short title | Verdict |
|---|---------|-------------|---------|
| 1 | 12 | Fast mode off in remote agent sessions | NO-OP{NO-SURFACE} |
| 2 | 15 | Tool heartbeats not reaching SDK hosts on stalled stream | NO-OP{NO-SURFACE} |
| 3 | 16 | Bedrock/Vertex startup checks ignore enforced availableModels | NO-OP{NO-SURFACE} |
| 4 | 18 | Fable `/model` picker saves version id, not alias | **PORT-CANDIDATE** (#1 best) |
| 5 | 19 | Opus5.5↔Sonnet5.5 switch rewrites MCP announcements / drops thinking | NO-OP{NO-SURFACE} (site unrecoverable — see honesty note) |
| 6 | 20 | Bedrock Guardrails mid-response block w/ leading thinking | NO-OP{PLATFORM} |
| 7 | 22 | `-p`/SDK repeats model fallback after mid-reply switch | STAGED (port with #11/#56 suppression) |
| 8 | 23 | Folder CLAUDE.md attached twice after resume/compaction | NO-OP{ALREADY-ALIGNED} (official site unrecoverable) |
| 9 | 29 | Page large MCP JSON with Read offset/limit guidance | **PORT-CANDIDATE** (#2) |
| 10 | 30 | Commit-attribution reminder inside tool result after compaction | NO-OP{NO-SURFACE} |
| 11 | 39 | `--include-partial-messages` message_stop late/never | **PORT-CANDIDATE** (#3) |
| 12 | 54 | MCP connector double-call on protocol-version change | NO-OP{NO-SURFACE} |
| 13 | 61 | Headless MCP needs-auth after one refused call | STAGED |
| 14 | 77 | MCP headless startup transient-connect retry | STAGED |
| 15 | 80 | Large MCP tool results memory/session-file/token-count rework | NO-OP{ALREADY-ALIGNED} (infra STRUCT-EQUAL) |
| 16 | 89 | Effort level kept on automatic model switch | (covered in cluster-c report) |

Ranked port candidates: **#1 item 4** (one-line, high value) → **#2 item 11** (medium, OCC
confirmed affected) → **#3 item 9** (large rewrite, OCC confirmed affected). STAGED items
7/13/14 need prerequisites before they can be ported (details in each section).

---

## Item 1 — CL:12 "Fixed fast mode staying off in remote sessions owned by an agent with no user account, even when the organization allows it"

**Verdict: NO-OP{NO-SURFACE}** (resolved prior session, re-confirmed).

The official fix lives in the remote-session fast-mode gate keyed on the session owner
(`W1e`/`PEn` session-key fast-mode machinery). OCC has no remote-session (cloud / Remote
Control) owner surface: `rg` for the remote-session fast-mode keys returns 0 in `occ/src`.
OCC's fast-mode is a local `↯` pricing/lightning-bolt concern only (see `getFablePricingSuffix`
in `src/utils/model/modelOptions.ts:1308`). No agent-owned remote session concept exists to fix.

## Item 2 — CL:15 "Fixed tool heartbeats not reaching SDK hosts while the model's response stream was stalled with no data arriving"

**Verdict: NO-OP{NO-SURFACE}** (resolved prior session, re-confirmed).

Official fix = `tool_heartbeat` `wakeWaiters` on the stalled-stream path. OCC's stream loop
(`src/services/api/claude.ts`) has an idle-watchdog (`clearStreamIdleTimers`, `streamIdleAborted`)
but emits no `tool_heartbeat` wake events to an SDK host; `rg tool_heartbeat occ/src` = 0.
The heartbeat-to-SDK-host channel does not exist in OCC, so there is nothing to un-stall.

## Item 3 — CL:16 "Fixed Bedrock and Vertex startup model checks ignoring an enforced `availableModels` list, which could collapse `/model` to one Opus row"

**Verdict: NO-OP{NO-SURFACE}** (resolved prior session, re-confirmed).

Official fix = managed-settings enforced-`availableModels` predicate (`d_e`/`TCe`) applied to
the Bedrock/Vertex startup model probe. OCC's Bedrock/Vertex startup probe
(`src/utils/model/bedrock.ts`) does not consult an enforced `availableModels` list from managed
settings — OCC's allowlist filter is `filterModelOptionsByAllowlist` in
`src/utils/model/modelOptions.ts:1512`, applied post-build to the picker, not to the 3P startup
probe. The "collapse `/model` to one Opus row" failure mode is a managed-settings enforcement
path OCC does not implement; `rg 'enforced.*availableModels|availableModels.*enforced' occ/src` = 0.

## Item 4 — CL:18 "Fixed picking Fable in `/model` on a claude.ai login saving the current version's id, so your saved default now follows the newest Fable like Opus and Sonnet do"

**Verdict: PORT-CANDIDATE — ranked #1 (one-line, high value, byte-exact official fix recovered).**

### Official fix (verbatim)

The Fable picker-row builder — official `U8` (v286) → `U3` (v287), primary copy:

- v286 `U8` @ **203061451** region:
  ```js
  function U8(e,n){let r=EM(e)??Cr("fable").displayName,s=ct()?"":Sr(e,n);return{value:e,label:"Fable",description:`${r} \xB7 ${nd}${s}${zh()}`,descriptionForModel:`${r} - most capable for your hardest and longest-running tasks`}}
  ```
- v287 `U3` @ **205079818** region:
  ```js
  function U3(e,n){let r=bM(e)??Or("fable").displayName,s=ft()?"":Sr(e,n);return{value:"fable",label:"Fable",description:`${r} \xB7 ${ed}${s}${Ih()}`,descriptionForModel:`${r} - most capable for your hardest and longest-running tasks`}}
  ```

**The entire delta is `value:e` → `value:"fable"`** (all other differences are minified-name
churn: `EM`→`bM`, `Cr`→`Or`, `ct`→`ft`, `nd`→`ed`, `zh`→`Ih`). The picker row now stores the
family **alias** `'fable'` instead of the passed-in concrete **version id** `e`
(e.g. `claude-n-5-1`), so the saved default follows the newest Fable — exactly like the Opus
and Sonnet rows already store `'opus'`/`'sonnet'` for first-party logins.

### OCC is affected

`src/utils/model/modelOptions.ts:1321` `getFablePickerRow(model, fastMode)` — this is OCC's
`U3`/`U8` equivalent (`getFableMarketingName(model)` ≡ `bM(e)`; `isClaudeAISubscriber()` ≡
`ft()`; `getFablePricingSuffix(model, fastMode)` ≡ `Sr(e,n)`). It currently returns
**`value: model`** (line 1330), i.e. the version id — the pre-fix v286 behavior:

```ts
function getFablePickerRow(model: string, fastMode = false): ModelOption {
  const name = getFableMarketingName(model) ?? 'Fable 5.1'
  const blurb = 'Most capable for your hardest and longest-running tasks'
  const pricingSuffix = isClaudeAISubscriber() ? '' : getFablePricingSuffix(model, fastMode)
  return {
    value: model,          // <-- BUG: version id, not the 'fable' alias
    label: 'Fable',
    description: `${name} · ${blurb}${pricingSuffix}`,
    descriptionForModel: `${name} - most capable for your hardest and longest-running tasks`,
  }
}
```

This row is inserted into the picker at `modelOptions.ts:1416`
(`getFablePickerRow(getDefaultFableModel(), fastMode)`), so selecting it saves the concrete
version id. Compare OCC's first-party Opus/Sonnet rows (`modelOptions.ts:356`, `:374`, `:173`,
`:191`) which already store the `'opus'`/`'sonnet'` alias — Fable is the odd one out.

### Exact port

In `src/utils/model/modelOptions.ts`, `getFablePickerRow` (line 1330):

```ts
-    value: model,
+    value: 'fable',
```

Keep `name`/`description`/`descriptionForModel` computed from `model` (unchanged) — only the
stored `value` becomes the alias. This is byte-faithful to official `U3`. No other call site
changes: the tail-insert path (`modelOptions.ts:1425–1443`, `isFableModelValue(customModel)`)
still rewrites a family-matched row's value in place to `customModel` for a user who already
pinned a specific version, which is the official `YG`/`fi(E)` branch and is correct as-is.

## Item 5 — CL:19 "Fixed switching between Opus 5.5 and Sonnet 5.5 (`/model`, `opusplan`) rewriting earlier MCP tool announcements, which could drop earlier extended thinking"

**Verdict: NO-OP{NO-SURFACE} — with an honesty note: the exact official fix site was NOT localized at line granularity.**

Every dedicated mechanism I probed is **rename-identical (STRUCT-EQUAL) between v286 and v287**:

- Announcement-delta producer `oRo`(v287)/`Awo`(v286) — 4032 B, STRUCT-EQUAL (`/tmp/pool287.js` vs `/tmp/pool286.js`).
- Deferred-tools pool builder — 4032 B, STRUCT-EQUAL.
- Thinking-strip selectors `ZUt`/`y$t`+`FLe`/`EOe`+`Aye`/`Gge` — all STRUCT-EQUAL.
- Live model-switch handler `Cyn`/`afn`, `JXt`/`K5t` — STRUCT-EQUAL.
- Restore-announce string `"available again in this session (announced earlier in this conversation)"` present in BOTH versions.
- The only structural delta near the memory/announce module (`xUt` v287 @208173955 / `YFt` v286 @206152495) is a NEW `onSessionNoticeRender:SXe` key — that is the **asyncRewake wake-notice** machinery (a different changelog item, CL:14), not the announcement-rewrite fix.

**Honesty:** I could not pin the precise byte range where v287 changes the Opus5.5↔Sonnet5.5
switch behavior; the fix is either a small in-place edit inside one of the STRUCT-EQUAL-by-churn
handlers that my normalization masks, or gated behind a feature flag with no new string. I am
NOT claiming a specific site.

**OCC impact:** OCC has no `thinkingStripPlan`, `keepForeignThinking`, or
`nameOnlyAnnouncements` machinery (`rg` = 0 in `occ/src`). MCP announcement deltas exist
(`mcp_instructions_delta` in 7 files, `deferred_tools_delta` in 7 files) but OCC does not
re-run/rewrite earlier announcements on a live model switch, so the "drop earlier extended
thinking" failure mode cannot occur in OCC. NO-SURFACE for the specific bug.

## Item 6 — CL:20 "Fixed Amazon Bedrock Guardrails blocks that arrive mid-response ending the turn with an API error instead of the guardrail's message when the reply began with thinking"

**Verdict: NO-OP{PLATFORM}** (resolved prior session, re-confirmed).

The fix is in the Bedrock Guardrails mid-response block handler when the reply opens with a
`thinking` block. OCC does not implement Amazon Bedrock Guardrails streaming interception;
`rg -i 'guardrail' occ/src` = 0. This is a Bedrock-platform-specific code path with no OCC
surface. (Distinct from OCC's Bedrock model-availability checks in item 3.)

## Item 7 — CL:22 "Fixed `claude -p` and SDK sessions repeating a model fallback on every later message after the model was switched while a reply was running"

**Verdict: STAGED** (resolved prior session; must be ported together with the item-11 / #56
suppression work — shares the stream-state machinery).

Official v287 adds a suppression set so a model fallback fired once (when the model was switched
mid-reply) is not re-fired on every subsequent message: the `QWt`/`iI=20000`/`XNo`/`QNo`/`gdn`
access-fallback suppression constants (v287 primary copy ~206.8M region). v286 lacked the
`gdn` suppression latch. Because this shares the same stream/message-state object that item 11
rewrites (the `nf`/`Ph`/`N_` envelope state and the `Eb` access-fallback path), it should be
ported in the same change as the item-11 flush synthesis, not independently.

**OCC impact:** OCC's `-p`/SDK path (`src/cli/print.ts`, `src/QueryEngine.ts`) does model
fallback via the same `claude.ts` stream loop. Staged rather than NO-OP because OCC *does* have
a mid-reply model-switch surface (`midConversationSystem.ts`), but porting requires the
suppression-latch prerequisite that does not yet exist in OCC.

## Item 8 — CL:23 "Fixed a folder's CLAUDE.md being attached a second time after resuming a session or after a compaction"

**Verdict: NO-OP{ALREADY-ALIGNED} — official fix site UNRECOVERABLE at line granularity (honesty note below).**

### Official-side investigation (all candidate mechanisms are pre-existing / STRUCT-EQUAL)

I probed every plausible dedupe mechanism and found **nothing new in v287**:

- `nestedMemoryAttachmentTriggers` `.includes()` dedupe guard — present in BOTH versions, 4 sites each (v287 @207022372/207025988/207026526/207033355; v286 @205018383/205022050/205022588/205029413), identical idiom `if(X&&!X.includes(Y))X.push(Y)`. Not the fix.
- The empty-triggers `extractAttachments(w,{...,nestedMemoryAttachmentTriggers:[],dynamicSkillDirTriggers:[],pendingNestedMemoryTriggers:[]},...)` call (v287 @207965897 / v286 @205947192) — this is the **fork/skill** path, STRUCT-EQUAL between versions.
- `compact_kept_tail_announcements` compaction filter `!S.has(N.attachment.type)` (v287 @214194816 / v286 @212064336) — STRUCT-EQUAL (identifier churn only).
- `"a second time"` string count v287=6 / v286=5: the +1 (@215510514) is the **workspace-trust-dialog** changelog entry text ("Fixed the workspace trust dialog appearing a second time…"), NOT item 8 code.
- `unseenFiles`/`loadCountsOf`/`withProjectFiles` counts identical (2/2 each) across versions.

**Honesty:** the exact v287 edit that stops the second attach is not localizable with these
needles — it is likely a one-token guard change inside a churn-renamed function that my
normalization masks, or a set-membership check added without a new string literal. I am NOT
inventing a site.

### OCC is already aligned

OCC prevents the double-attach structurally:
- Nested-memory triggers are a **`Set<string>`** (`src/Tool.ts:n?: Set<string>`; `src/QueryEngine.ts`, `src/screens/REPL.tsx`, `src/utils/forkedAgent.ts` all `n: new Set<string>()`), populated via `context.n?.add(fullFilePath)` in `src/tools/FileReadTool/FileReadTool.ts`. A `Set.add` is idempotent, so the same folder CLAUDE.md path can never be recorded twice — OCC does not need the official array `.includes()` guard at all.
- Folder CLAUDE.md load dedupe: `src/utils/claudemd.ts:1529` `const unseen = unseenFiles(candidates, result)` then `:1560` `return withProjectFiles(result, unseen)` — files already in `result` are filtered out before re-attachment, and `resetGetMemoryFilesCache` (`claudemd.ts:1603`, set to `'compact'`) governs the compaction re-load path.

So OCC's Set-based triggers + `unseenFiles` dedupe already cover the resume/compaction re-attach
path. No portable diff was recovered; treat as ALREADY-ALIGNED. (Pairs prior-ledger STAGED #31.)

## Item 9 — CL:29 "Fixed Claude being told to page large MCP results saved as JSON with Read's offset and limit, which cannot split one long line"

**Verdict: PORT-CANDIDATE — ranked #3 (large rewrite; OCC confirmed affected; both official builders recovered verbatim).**

### Official fix (verbatim, v287)

The large-output guidance builder `vsn` (v287) / `ltn` (v286), primary copy head @
**207465427** (v287) / **205457212** (v286). v287 `vsn` is JSON/line-shape aware and no longer
tells Claude to use Read offset/limit on a single-long-line JSON file. Full v287 body:

```js
function vsn(e,n,r,s,g,h){let w=`Error: result (${g!==void 0?`${n.toLocaleString()} characters across ${g.count.toLocaleString()} ${g.count===1?"line":"lines"}`:`${n.toLocaleString()} characters`}) exceeds maximum allowed tokens. Output has been saved to ${e}.
Format: ${r}
`,H=h===void 0?"":`
Note: the output exceeded the persist byte limit; the saved file contains only the first ${pn(h)} of it and may end mid-structure (a JSON parse of the whole file can fail). Any line/character counts or parsing recipes above describe the full output, not the truncated file.`,j=Math.floor(OQ().maxTokens*4*0.8),G=8,K=g!==void 0&&g.count>1&&g.maxLen<=j,he=K?Math.max(1,Math.floor(j/(g.maxLen+8))):void 0,_e=`first probe the structure (e.g., jq 'type, length, keys?' ${Ur([e])}), then extract slices with jq or python`;if(!QMt()){let xe,Ae;if(g===void 0)xe=`Use jq to make structured queries (find a value, filter by field).
`,Ae=`- Note: this file is JSON, so a long value (or the whole file) is a single line. ${dt}'s offset/limit cannot split a line, so reading in chunks works only if every line is short. If a shell tool is available, ${_e}.
`;else if(!K)xe=`Search within the file for specific content, and use jq if the content is JSON.
`,Ae=`- Note: this file's lines are too long for ${dt}'s offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.
`;else xe=`Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.
`,Ae="";return w+xe+`REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:
`+mio(e,s,Ae)+H}let Se,Ee,Ce;if(g===void 0)Se=`- For targeted queries (find a value, filter by field): use jq on the file directly.
`,Ee=`${_e} \u2014 ${dt}'s line-based offset/limit will not chunk this file.`,Ce=`${e} is ${r}; probe the structure with jq (type/length/keys), then extract and read the content in full with jq or python, then summarize and quote any key findings verbatim.`;else if(!K){let xe=j.toLocaleString();Se=`- For targeted searches (find a string): use grep on the file directly.
`;let Ae=O()==="windows"?"python":"python3",Pe=e.replaceAll("\\","/").replaceAll("'","'\\''");Ee=`the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead \u2014 e.g. ${Ae} -c 'print(open("${Pe}").read()[A:B])' in ~${xe}-char spans until you have read 100% of it.`,Ce=`Slice ${e} in ~${xe}-char spans via python (read()[A:B]) until you have read all ${n.toLocaleString()} characters, then summarize and quote any key findings verbatim.`}else Se=`- For targeted searches (find a line, locate a string): use grep on the file directly.
`,Ee=`read ${e} in chunks of ~${he} lines using offset/limit until you have read 100% of it.`,Ce=`Read ${e} in chunks of ~${he} lines using offset/limit until you have read all ${g.count.toLocaleString()} lines, then summarize and quote any key findings verbatim.`;return w+Se+`- For analysis or summarization that requires reading the full content: ${Ee}
- If the ${yt} tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return \u2014 e.g. "${Ce}" A vague "summarize this" may lose detail.
`+H}
```

Key semantics of the fix (`g` = `{count, maxLen}` line-shape stats, `K` = "multi short lines" =
`g.count>1 && g.maxLen<=floor(maxTokens*4*0.8)`):
- **`g===void 0` (JSON / unknown shape):** do NOT recommend offset/limit — "this file is JSON, so a long value (or the whole file) is a single line. `${Read}`'s offset/limit cannot split a line"; instead "first probe the structure (e.g. `jq 'type, length, keys?' <path>`), then extract slices with jq or python."
- **`!K` (lines too long):** "slice by character range (e.g. `python read()[A:B]`, `dd`, or `cut -c`)".
- **`K` (many short lines):** keep the classic offset/limit chunking guidance.
- Two prompt variants gated by `QMt()` (env `MCP_TRUNCATION_PROMPT_OVERRIDE` / flag `tengu_mcp_subagent_prompt`): the `!QMt()` legacy variant and the newer variant that routes full-content reads through a subagent (`${yt}` = Task tool) to keep output out of the main context. `QMt` is NEW in v287: `function QMt(){let e=a.MCP_TRUNCATION_PROMPT_OVERRIDE;return e?e!=="legacy":C("tengu_mcp_subagent_prompt",!1)}`.

The v286 `ltn` builder had none of this line-shape branching — it unconditionally emitted the
"Use offset and limit parameters…" text (the bug).

### OCC is affected

`src/utils/mcpOutputStorage.ts:39` `getLargeOutputInstructions(rawOutputPath, contentLength,
formatDescription, maxReadLength?)` unconditionally emits the buggy guidance at **line 48**:

```
Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.
```

regardless of whether the saved file is single-line JSON. Called from
`src/services/mcp/client.ts:3528` (`return getLargeOutputInstructions(...)`). This is exactly
the pre-fix v286 behavior — Claude is told to page JSON with Read offset/limit, which cannot
split the one long line.

### Port shape

Extend `getLargeOutputInstructions` to take the line-shape stats (`count`, `maxLen`) and branch
as `vsn` does. Minimum viable port (legacy `!QMt()` branch only, since OCC has no
`tengu_mcp_subagent_prompt` flag yet):
1. Add a `lineStats?: { count: number; maxLen: number }` parameter (populate at the
   `client.ts:3528` call site from the saved content).
2. Compute `K = lineStats && lineStats.count > 1 && lineStats.maxLen <= Math.floor(maxTokens*4*0.8)`.
3. Emit the three branches verbatim: `lineStats===undefined` → JSON/single-line warning +
   `jq 'type, length, keys?'` probe; `!K` → char-range slicing (`python read()[A:B]`, `dd`,
   `cut -c`); `K` → existing offset/limit text.
The subagent-routing (`QMt()`) variant can be deferred (OCC lacks the flag); note it as a
follow-up. This is a large-ish port (~60 lines of OCC TS) but mechanically faithful.

## Item 10 — CL:30 "Fixed the commit attribution reminder being delivered inside a tool result after a compaction"

**Verdict: NO-OP{NO-SURFACE}** (resolved this session).

Official machinery (all present in BOTH versions, so the "fix" is a v287 text-constant hoist
only, not a behavior change):
- Attribution-announcement getter `Clt()` — STRUCT-EQUAL 151 B both versions: `attributionAnnouncementEnabled ??= a.CLAUDE_CODE_ATTRIBUTION_ANNOUNCEMENT ?? C(j4n,!0)`.
- Reminder-text builder `L9e`(v287 @206257935)/`t6e`(v286 @204253466) — same semantics; v287 only hoisted literals to constants `P9e`/`I9e` (`P9e="this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder"`).
- Renderer, identical both versions: `remote_session_change:(e)=>{let n=s_e().safeParse(e);if(!n.success)return[];return ya([Re({content:L9e(n.data),isMeta:!0})])}` — the reminder is delivered as a `remote_session_change` **attachment** → user meta message, NOT inside a tool result.

**OCC impact:** OCC has zero surface for this delivery path — `rg remote_session_change occ/src`
= 0, `rg attributionAnnouncement occ/src` = 0, `rg 'End git commit messages' occ/src` = 0.
OCC's `src/utils/attribution.ts` is analytics-only and `commitAttribution.ts` is a 2-line
stub. The compaction-into-tool-result failure mode has no OCC equivalent.

## Item 11 — CL:39 "Fixed `--include-partial-messages` sending a cut-short reply's `message_stop` late or never, so apps could show the reply as still in progress"

**Verdict: PORT-CANDIDATE — ranked #2 (medium; OCC confirmed affected; official fix fully recovered).**

### Official fix (verbatim, v287)

v287 adds a flush generator `Um` + envelope state (`nf`/`Ph`/`N_`) + tool-block suppression set
`INo`, and calls `yield* Um()` at every stream terminal point. Primary copy ~208.25M region:

```js
let si=!1,Sa=!1,ji=!1,wa=null,Ya=new WeakSet,tc=new WeakMap,Rl=!1,nf=!1,Ph=null,N_=!1;
function*Um(){if(!nf)return;let $s=N_?null:Ph;if(nf=!1,Ph=null,N_=!1,$s!==null)yield{type:"stream_event",event:{type:"content_block_stop",index:$s}};yield{type:"stream_event",event:{type:"message_stop"}}}
```

State machine (updated per streamed event `Fs`):
```js
if(Fs.type==="message_start")nf=!0,Ph=null,N_=!1;
else if(Fs.type==="content_block_start")Ph=Fs.index,N_=INo.has(Fs.content_block.type);
else if(Fs.type==="content_block_stop")Ph=null,N_=!1
```

Suppression set (@208171771): `INo=new Set(["tool_use","server_tool_use","mcp_tool_use"]);`
(alongside watchdog constants `$Ut=1e4,PLe=20000,RNo=90000,PNo=30`). A synthetic
`content_block_stop` is suppressed for tool blocks (the tool result supplies its own close);
`message_stop` is always synthesized when the envelope is still open (`nf`).

v286 (`Bl` @206228059) had NO tool-block suppression and flushed on only 3 error/retry paths:
```js
let qs=!1,Xi=!1,Zs=!1,Gi=null,cl=new WeakSet,El=!1;
function*Bl(){if(!El)return;if(Gi!==null)yield{type:"stream_event",event:{type:"content_block_stop",index:Gi}};yield{type:"stream_event",event:{type:"message_stop"}}}
```
v286's `message_stop` case did `El=!1` with **no** flush call. v287 calls `Um()` at 4 additional
terminal points (call-site count `Um()`×7 + def vs `Bl()`×3 + def):
- `ch("stream_completed",Zi??null,il),yield*Um();break e`
- `ch("stream_completed",Zi??null,Au!==null?il:null),yield*Um();break e`
- synthesized stop_reason path: `blocks_yielded…oM(),yield*Um();let EYe=ns({content:ji?…`
- fallback: `XL=Zi,Zi=null,yield*Um(),yield*Lge(),yield{type:"streaming_fallback_began",cause:Ga}` (v286 had only `yield*$pe()`≡`Lge` there).

### OCC is affected

- OCC supports `--include-partial-messages` (surfaced as `n` / `--n`; `src/main.tsx`
  `effectiveIncludePartialMessages = n || isEnvTruthy(CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES)`,
  validated to require `--print` + `--output-format=stream-json`; threaded through
  `src/cli/print.ts` → `src/QueryEngine.ts`).
- `src/QueryEngine.ts:946–985` forwards each `stream_event` to the SDK when
  `includePartialMessages`, and at `:971` accumulates usage on `message_stop` — so it depends on
  receiving a closing `message_stop` stream_event.
- `src/services/api/claude.ts` yields `stream_event` at **exactly one site** (line 3096) — inside
  the `for await` loop, forwarding only *actually received* parts. On a cut-short reply the
  partial-finalize path (`claude.ts:3344–3360`) patches only the **message-level**
  `lastYielded.message.stop_reason` and returns; it never yields a synthetic
  `content_block_stop`/`message_stop` **stream_event**. Likewise the clean-but-open path
  (`:3169`, `messageEnvelopeOpen && !(stopReason!==null && streamReachedTerminal)`) throws
  `StreamTruncatedError` rather than flushing a `message_stop`.
- Net: an SDK/`--include-partial-messages` host sees the reply's `message_stop` **late or never**
  — the exact official bug.

### Port shape

OCC already tracks `openBlockIndex` (`claude.ts:2371`, set at `:2798` on `content_block_start`,
cleared at `:2955` on `content_block_stop`) and `messageEnvelopeOpen` (`:2369`, set `:2700`,
cleared `:3091`). To port:
1. Add `openBlockIsTool: boolean` alongside `openBlockIndex`; on `content_block_start` set
   `openBlockIsTool = INO.has(part.content_block.type)` where
   `const INO = new Set(['tool_use','server_tool_use','mcp_tool_use'])`.
2. Add a generator (≡ `Um`):
   ```ts
   function* flushStreamClose() {
     if (!messageEnvelopeOpen) return
     const idx = openBlockIsTool ? null : openBlockIndex
     messageEnvelopeOpen = false; openBlockIndex = null; openBlockIsTool = false
     if (idx !== null) yield { type: 'stream_event', event: { type: 'content_block_stop', index: idx } }
     yield { type: 'stream_event', event: { type: 'message_stop' } }
   }
   ```
3. `yield* flushStreamClose()` at the terminal points: normal completion (after the loop, before
   the summary logging), the partial-finalize return (`~3360`), and the non-streaming
   fallback-began path — mirroring the 4 official call sites. This pairs with the item-7
   fallback-suppression port (shared state object).

## Item 12 — CL:54 "Fixed an MCP connector tool call occasionally running twice, or the connector's calls failing until restart, when its server changed which MCP protocol version it supports"

**Verdict: NO-OP{NO-SURFACE}** (resolved this session; pairs prior-ledger STAGED #24).

Official machinery = the `claudeai-proxy` connector's `cachedInitResponse` protocol-version
validators — all STRUCT-EQUAL between versions:
- `ir`(v287)/`ir`(v286) validator — STRUCT-EQUAL 507 B.
- `Sr`/`gr` cached-init guard — STRUCT-EQUAL 508 B: `if(e.cachedInitResponse==null)return;let r=jKe.safeParse(...)`.
- `jKe`/`GLe` zod `safeParse` + the log `"carries unsupported protocolVersion … falling back to real initialize"` — identical both versions.
- `tPn` connector-list fetcher — STRUCT-EQUAL 5009/5007 B.
- claudeai-mcp log-line sets identical (40/40 lines, `/tmp/cm287.txt` vs `/tmp/cm286.txt`).

`cached_init_response`/`protocol_version_mismatch` appearing in `new287.txt` is **minification
churn, not novelty** — binary hit counts are 7/7 and 8/8 across both versions. The fix is silent
(no new string) and I could not localize a changed byte range; the double-call/fail-until-restart
behavior is inside the STRUCT-EQUAL-by-churn validator.

**OCC impact:** OCC has no `claudeai-proxy` connector; `rg protocolVersion occ/src` = 1 hit, and
it is a **test fixture** (`src/services/mcp/__tests__/…/chattyStdioServer.ts:53`), not
production protocol-version-negotiation code. No cached-init-response machinery exists → NO-SURFACE.

## Item 13 — CL:61 "Fixed headless sessions reporting an MCP server as needing authentication after one refused call, even though later calls succeed"

**Verdict: STAGED** (official fix fully recovered this session; OCC has the pinning surface but not the clear-on-success reconciliation, and OCC's mechanism differs structurally from official).

### Official fix (verbatim, v287)

New `clearNeedsAuth` on the MCP-connections store `V2e` (@216077001 region):
```js
class V2e{#e;constructor(n){this.#e=n}static over(n){return new V2e(Lue(n.getState,n.setState,"mcp"))}get(){return this.#e.get()}markNeedsAuth(n){this.#e.set((o)=>Flo(o,n))}async clearNeedsAuth(n){let o=this.get().clients.find((e)=>e.name===n);if(o?.type!=="needs-auth")return;let s=await p().peekSettledConnection(n,o.config);if(s?.type!=="connected")return;this.#e.set((e)=>({...e,clients:e.clients.map((c)=>c===o?s:c)}))}…}
```
New call site in the tool-use-success path (@207748271, just before `tengu_tool_use_success`):
```js
if(e.mcpInfo!==void 0&&ke())s.session.mcpSessionWiring.connections()?.clearNeedsAuth(e.mcpInfo.serverName);
```
`ke()` = headless gate. Semantics: when a tool call to an MCP server **succeeds** in headless
mode, clear that server's stale `needs-auth` row — but only if `peekSettledConnection` shows it
is actually `connected` now. Counts: `clearNeedsAuth` v287=2 / v286=0 (NEW); `markNeedsAuth`
5/5; `peekSettledConnection` 11/10 (the +1 is inside `clearNeedsAuth`). The mark trigger
(unchanged): `if(hr instanceof QP)He.markNeedsAuth(hr.serverName)` where `QP` = UnauthorizedError.

### OCC surface

OCC **does** pin needs-auth across a session:
- `src/services/mcp/client.ts:616` `setMcpAuthCacheEntry(name)` writes a 15-min TTL disk cache
  `mcp-needs-auth-cache.json` (`:439`), consulted on connect at `:2923` (`isMcpAuthCached(name)`)
  to **skip reconnection** and immediately emit `{ type: 'needs-auth' }` (`:2929`) with stub
  tools. So one refused (401 → `UnauthorizedError`, `client.ts:1488/1504/3936`) call pins the
  server for 15 min — the same failure shape.
- OCC has `removeMcpAuthCacheEntry(serverId)` (`client.ts:531`) — per-key cache removal — but
  its **only** caller is the `mcp remove` handler (2.1.280 #048 port). There is **no**
  clear-on-tool-success path. `rg 'clearNeedsAuth|markNeedsAuth|peekSettledConnection' occ/src`
  = 0; `src/utils/mcpNeedsAuthNotice.ts` is *notice* tracking (2.1.276 port), not connection state.

**Why STAGED not PORT-CANDIDATE:** OCC's pinning is a **disk TTL cache + connect-time skip**, not
the official in-memory `V2e` connection store. A faithful port must (a) add a headless
tool-success hook (in the tool-execution / `QueryEngine` path) that, on success against an MCP
server, calls `removeMcpAuthCacheEntry(serverName)` and refreshes the in-session client row, and
(b) add an OCC analogue of `peekSettledConnection` to confirm the server is actually connected
before clearing. That prerequisite plumbing does not exist yet → staged. Use the official v287
shape as the reference when the prerequisite lands.

## Item 14 — CL:77 "Improved MCP startup in headless mode: a remote server whose first connect fails transiently is now retried without waiting for the slowest server to finish connecting"

**Verdict: STAGED** (official fix fully recovered; OCC has the deadline-race helper but lacks the per-server retry loop + `discardMemoizedConnectResult` prerequisite).

### Official fix (verbatim, v287 headless-startup module @215588322–215597322)

v286 retried **once at batch end** (after the slowest server settled) via `sSt`; v287 retries
**per-server immediately** on each transient failure, plus a batch-end-gated final attempt and
new telemetry. Backoff constants: `var kso=1000,s6t=[500,1500,4000],D=s6t.reduce((o,r)=>o+r,0);`
(`D`=6000 total). Batch function `k`(v287)/`h`(v286):

```js
function k(o,r,e,l=!1,p,c,s,n){…let g=new Map,u=f.map((M)=>new Promise((S)=>g.set(M,S))),m=Promise.withResolvers(),y=new Set,C=(M)=>{for(let S of Object.keys(M))y.add(S);lEt(M,e,p,void 0,m.promise).catch((S)=>t(`[MCP] ${r} retry error: ${S}`)).finally(()=>{for(let S of Object.keys(M))y.delete(S)})},h=()=>{let M=j(r);…M.getMcpToolsCommandsAndResources((S)=>{pxn(e,S),$wo();let{name:b}=S.client;if(g.get(b)?.(),!y.has(b)){let R=Gr(o,(v,w)=>w===b);if(fxn(R,e).length>0)C(R)}},o,p,c,s).catch(…).finally(()=>{for(let S of g.values())S();m.resolve(performance.now()),C(Gr(o,(S,b)=>!y.has(b)))})};if(l)setImmediate(h);else h();return u}
```

Per-server retry loop `lEt`(v287)/`sSt`(v286) — v287 adds the 5th `m.promise` param, the
identity-change guard (`gr()`), `discardMemoizedConnectResult`, and timing/telemetry:
```js
async function lEt(o,r,e,l=(c)=>pxn(r,c),p){let c=()=>fxn(o,r);if(c().length===0)return;let s=gr(),{signal:n}=r,f=performance.now(),g=0;for(let[m,y]of s6t.entries()){if(await ee(y,n),p!==void 0&&m===s6t.length-1){let v=await p+D+g;await ee(Math.max(0,v-performance.now()),n)}if(n?.aborted)return;if(gr()!==s){t("[MCP] Retry: identity changed during backoff, stopping (these rows belong to the previous account)");return}let C=c();if(C.length===0){t("[MCP] Retry: all remote servers recovered, stopping");return}…let h=[];for(let v of C){if(!await P().discardMemoizedConnectResult(...v))continue;…}…if(await P().getMcpToolsCommandsAndResources((v)=>{…},Object.fromEntries(h),e),g+=performance.now()-b,!n?.aborted)i("tengu_mcp_connect_retry_attempt",{attempt:m+1,delayMs:y,sincePassStartMs:R,retryable:C.length,dialed:h.length,recovered:M,stillRetryable:S});if(c().length===0){…return}}…}
```
Transient-failure predicate `XTe` (@206583498):
```js
function XTe(e){if(e.type!=="failed")return!1;let n=e.config.type??"";if(!dPn.has(n))return!1;if(e.errorCode!==void 0)return ZSe.has(e.errorCode);return n==="sse"}
```
(`ZSe` includes `"CONNECT_TIMEOUT"`; timeout marker `Yr` sets `code:"CONNECT_TIMEOUT"` under
`C("tengu_mcp_connect_timeout_retry",!0)`.) `fxn(o,r)` filters to servers whose memoized client
row is transient-failed (`XTe`) and config-equal. Novelty counts: `tengu_mcp_connect_retry_attempt`
v287=2 / v286=0 (NEW); `"Retry attempt"` 4/2; `discardMemoizedConnectResult` 4/4;
`awaitEachWithDeadline` 4/4. v286 `sSt` @213539533 is the same loop minus the 5th param, minus
timing/telemetry (uses `urr` backoff, logs `"Retry: N transiently-failed remote server(s) after Xms backoff"`).

### OCC surface

`src/services/mcp/client.ts:3042` `waitForMcpConnectionBatch` ≡ official `B` deadline-race
(`MCP_CONNECTION_TIMEOUT_MS=5000`, honors `MCP_CONNECTION_NONBLOCKING`), used at
`src/main.tsx:3124`. OCC has `requestToolsListWithRetry` (3 attempts / 500 ms) but that retries
only `tools/list`, **not** the connect itself. OCC has **no** `discardMemoizedConnectResult`,
**no** memoized-connect-result store, and **no** per-server transient-connect retry loop
(`rg 'discardMemoizedConnectResult|tengu_mcp_connect_retry_attempt' occ/src` = 0).

**Why STAGED:** porting the v287 per-server immediate retry requires first adding a memoized
connect-result store with a `discardMemoizedConnectResult` invalidator (the prerequisite that
lets a retry re-dial instead of re-serving the cached failure). Use the v287 shape (immediate
per-server retry + batch-end-gated final attempt + `s6t=[500,1500,4000]` backoff +
`tengu_mcp_connect_retry_attempt` telemetry), not the v286 batch-end-only shape.

## Item 15 — CL:80 "Improved handling of large MCP tool results: less memory, smaller session files, and no extra upload to count tokens for results far over the limit"

**Verdict: NO-OP{ALREADY-ALIGNED} — the entire persist + token-count infra is STRUCT-EQUAL between versions; no portable diff recovered.**

### Official-side investigation (everything STRUCT-EQUAL)

- Persist wrapper + telemetry: `tengu_tool_result_persisted` function (v287 `P_e` @~205666925 /
  v286 `Yhe` @~203628666) — **STRUCT-EQUAL** 2130 B around the telemetry call
  (`{toolName, originalSizeBytes, persistedSizeBytes}`).
- Token-count callers: the counter `UAe`(v287 @206863422)/`Qke`(v286 @204860305) and its three
  caller sites (v287 @207638402/207639162/207643012; v286 @205629526/205630286/205634137) —
  the whole 7400 B caller region is **STRUCT-EQUAL** (only ≤15-char identifier churn). The
  `countEach`/`GRt`/`Klo`/`Gx`(countToolDefinitionTokens)/`Xlo` token-counting module is
  unchanged.
- Needle counts identical across versions: `source:"count_tokens"` 2/2, `count_tokens` 29/29,
  `tokenCount` 58/58, `originalSize` 56/56, `persistedSizeBytes` 6/6, `maxResultSizeChars`
  107/107, `persistenceThresholdCeiling` 15/15, `skipAggregateToolResultBudget` 12/12,
  `originalSizeBytes` 6/6, `estimatedTokens` 32/32, `approxTokens` 6/6, `tokenEstimate` 4/4.
- The `seenIds`/`replacements` persist state (`lpn`/`_Lo` v287 vs `Xan`/`gIo` v286) is
  STRUCT-EQUAL. No new telemetry name and no distinctive new string ("far over" = 1/1, an
  unrelated thumbnail-limit message).

**Honesty:** the "less memory / smaller session files / no extra token-count upload" improvement
is an in-place micro-optimization inside functions that are STRUCT-EQUAL under identifier
normalization (or realized in the streaming-file-transfer path of CL:78, a different cluster).
I could not isolate a changed byte range, so there is no portable diff to hand a port agent.

**OCC impact:** OCC's `src/utils/mcpOutputStorage.ts` + `persistToolResult` design already
persists over-limit results to disk and replaces them with a pointer + guidance (the item-9
builder), which is the memory/session-file behavior the entry describes. With the official infra
STRUCT-EQUAL between versions and no recovered diff, treat as ALREADY-ALIGNED; the only concrete
OCC-actionable piece of this MCP-large-result cluster is item 9's guidance fix.

## Item 16 — CL:89 "Changed automatic model switches after a flagged message to keep your current effort level instead of the new model's default"

**(covered in cluster-c report)** — one-line pointer per assignment. Mechanism for reference:
NEW v287 `carriedEffort:lt.latchEffort` written into the refusal-fallback model latch
(`wwt` v287 / `v_t` v286); cluster-c owns the full analysis and port recommendation.

---

## Honesty / unrecoverable summary

- **Item 5:** every dedicated MCP-announcement / thinking-strip mechanism is rename-identical
  (STRUCT-EQUAL) between v286 and v287; the exact switch-behavior edit was **not** localized.
  OCC lacks the machinery entirely → NO-SURFACE regardless.
- **Item 8:** all candidate dedupe mechanisms (nested-trigger `.includes()` guard, fork-path
  empty-triggers call, compaction kept-tail filter) are pre-existing/STRUCT-EQUAL; the exact
  v287 edit was **not** localized. OCC is already aligned via `Set`-based triggers +
  `unseenFiles`.
- **Item 12:** the protocol-version double-call fix is silent (no new string) inside
  STRUCT-EQUAL validators; not localized. OCC has no claudeai-proxy connector → NO-SURFACE.
- **Item 15:** persist + token-count infra STRUCT-EQUAL; the optimization is not isolable as a
  portable diff. No new telemetry/string.
- Items 1/2/3/6/10 are genuine NO-OPs (OCC lacks the platform/remote/Bedrock-Guardrail/
  attribution-reminder surface) — not unrecoverable, just no OCC target.

All PORT-CANDIDATE (4, 9, 11) and STAGED (7, 13, 14) official code above is quoted verbatim
from the v287 primary embedded JS copy at the stated byte offsets; nothing is reconstructed from
memory.
