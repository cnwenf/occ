# Gap Research R6 — NEW ENV VARS + WORKTREE + MISC / N-A CONFIRMATION

Official Claude Code **2.1.303 → 2.1.304** alignment for OCC (HEAD `87974fd7`).
Static byte forensics only — **no official binaries executed**.

- vprev ELF: `/tmp/cc-diff-304/vprev/package/claude` (285,809,912 B)
- vver  ELF: `/tmp/cc-diff-304/vver/package/claude`  (288,730,480 B)
- new_strings: `/tmp/cc-diff-304/new_strings.txt` (27,042 lines)

Cluster items: **2 new env vars** (`CLAUDE_CODE_ATTRIBUTION_PROJECT`, `CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT`) + changelog **#30, #5, #45, #56, #37, #38, #16, #18, #19, #20, #23, #24, #46, #47, #51, #53, #54, #71, #72, #73, #74, #75, #76**.

> Changelog numbering note: task item numbers map to changelog *content* (there is a ~1–2 line drift vs the literal `changelog-entry-304.txt` line numbers in the #45–#56 range). Content descriptions below are authoritative; the literal changelog line is cited per item.

---

## Verdict table

| Item | Description (changelog) | Verdict | Effort | Key evidence |
|------|-------------------------|---------|--------|--------------|
| ENV-1 | `CLAUDE_CODE_ATTRIBUTION_PROJECT` (prev=0, ver=10) | **N-A** | – | claude.ai Project-ID host-integration var; validated @245166482, propagated to jobs/teammates/bridge children @271952185; OCC has no claude.ai Projects attribution (`commitAttribution.ts` = unrelated git-trailer) |
| ENV-2 | `CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT` (prev=0, ver=14) | **N-A** | – | bridge-child spawn protocol for claude.ai Projects entrypoints; consume @256049514, spawn @262657392; OCC bridge host-spawn DORMANT (`feature('BRIDGE_MODE')` off), `sessionRunner.ts:305-321` sets none of the 4 `BRIDGE_CHILD_*` flags |
| #30 | `claude --worktree` removing worktree+branch without asking at exit when HEAD detached/on-another-branch (could lose commits) | **PORT** | L | OCC has LIVE, currently-affected `--worktree` surface; `WorktreeExitDialog.tsx:87` + `ExitWorktreeTool.ts:79-113` carry the exact 303 bug. Official at-stake subsystem `G$r`/`nOt`/`tOt`/`wV`/`QEn`/`mRn` recovered verbatim @249016065 |
| #5 | `/claude-api managed-agents-secure` (prev=0, ver=24) | **N-A** | – | OCC `src/skills/bundled/claude-api/*.md` = 1-byte stubs; no `managed-agents-secure` subcommand surface |
| #45 | Artifacts with several views: Claude writes each view's link | **N-A** | – | OCC has no artifacts surface (only `CLAUDE_CODE_ARTIFACT_ROOM`/`PRESENCE` env allowlist in `managedEnv.ts:366-367`, no artifact feature) |
| #56 | `/artifacts` delete confirmation → numbered choices (1/Enter keep, 2 delete) | **N-A** | – | no `/artifacts` command / artifact-delete surface in OCC |
| #37 | Self-paced `/loop` wakeups at 1-hour max firing after prompt-cache expiry | **N-A** | – | OCC has NO `ScheduleWakeup` tool (only a dangling text ref `BashTool.tsx:507`); `/loop` uses `CronCreateTool`; MonitorTool `3600000` = monitor deadline, unrelated |
| #38 | Agent teams: approving a shutdown request from the main session no longer exits the whole CLI | **PORT** | S | OCC `SendMessageTool.ts:305-399` `handleShutdownApproval` LACKS the new teammate guard AND has `setImmediate(gracefulShutdown(0,'other'))` @387-389 → main-session approval exits the CLI = exact 303 bug. Official 304 guard @271277338 (new; prev=0) |
| #16 | Scheduled Cowork cloud sessions re-waiting 5 min for subagent WebFetch URL approval | **N-A** | – | OCC has only vestigial `CLAUDE_CODE_IS_COWORK` env awareness (QueryEngine ×6) + 2 telemetry names; no Cowork cloud-session scheduler / WebFetch approval queue |
| #18 | claude.ai Directory plugin's skills not running as commands from "/" in Cowork | **N-A** | – | OCC plugin sources = github/git/marketplace/local only (`marketplaceHelpers.ts:373-480`); no claude.ai Directory sync, no Cowork |
| #19 | Remote Control withholding desktop history when a different account is signed in | **N-A** | – | OCC remote-control server DORMANT (`commands.ts:92-95` gates on `feature('DAEMON') && feature('BRIDGE_MODE')`, both off); Claude-Desktop-history integration absent |
| #20 | Remote Control failing to start from Claude Desktop when DISABLE_TELEMETRY/DO_NOT_TRACK set | **N-A** | – | same dormant remote-control server; no Claude-Desktop launch path |
| #23 | OTel settings via server-managed settings ignored for whole session after sign-in (first-run / first start after /logout) | **STAGED (flagged — LIVE surface)** | M? | OCC OTel is REAL (`utils/telemetry/instrumentation.ts`, prometheus/bigquery exporters) + `remoteManagedSettings` live; `telemetryInitialized` (init.ts:55) is one-shot, `refreshRemoteManagedSettings()` on login (login.tsx:89) does NOT re-init telemetry → OCC likely shares bug. Official fix mechanism not cleanly byte-identifiable (+2 "server-managed settings" sites are WSL-policy doc). Needs first-run timing trace |
| #24 | Unsandboxed Bash in Claude Desktop **Code tab** not seeing shell-startup (`~/.zshrc`) env | **N-A** | – | OCC `subprocessEnv.ts:81` inherits `process.env` (no startup-file sourcing); OCC is a terminal CLI launched from a shell (env already sourced); no Code-tab GUI-launch surface (`desktop` cmd hands off to real Claude Desktop) |
| #46 | Cloud sessions: first turn waits for local stdio MCP servers of claude.ai-synced plugins | **N-A** | – | OCC has claude.ai-connector dedup (`main.tsx:3220`) + `alwaysLoad` (`Tool.ts:549`) but no cloud-session first-turn scheduling / claude.ai plugin sync |
| #47 | Remote session recovers status when server refuses a status update carrying other data | **N-A** | – | OCC bridge/remote session layer DORMANT (DAEMON/BRIDGE_MODE off) |
| #51 | Responsiveness/throughput when many subagents run at once | **N-A / STAGED-vague** | – | diffuse perf; `maxConcurrent`/`MAX_CONCURRENT`/`semaphore`/`pLimit`/`workerPool` counts ALL unchanged (prev=ver); no byte-identifiable discrete change |
| #53 | Self-hosted runner: better error when git host answers "not found" | **N-A** | – | OCC `self-hosted-runner/main.ts:3` = `() => Promise.resolve()` stub, gated `feature('SELF_HOSTED_RUNNER')` (off) |
| #54 | Windows: run git.exe directly instead of through cmd launcher | **N-A** | – | Windows-only startup perf; official adds git-launcher probe (`gitExecutable`+2, `MSYSTEM`+1, `ucrt64"]`+1, `gitLauncherProbe`/`gitBehindLauncher` in `Lt()` @237686735); OCC has no git-executable-resolution subsystem (generic `execFileNoThrow`→execa) |
| #71 | Cloud sessions: folders in composer's @ list showing no name | **N-A** | – | no cloud composer UI (OCC "composer" hits = BriefTool/dormant KAIROS, composer.json lockfile) |
| #72 | Claude Tag: Claude silent when channel becomes shared across Enterprise Grid | **N-A** | – | no Claude Tag / Enterprise Grid / shared-channel surface in OCC |
| #73 | Claude Tag: `@Claude !fork` outside a thread gets no visible reply | **N-A** | – | no Claude Tag; OCC `!fork`/`forkSession` hits = session forking (ResumeConversation/AgentTool), unrelated |
| #74 | Code Review: review levels Quick/Standard/Deep (org + per-repo) | **N-A** | – | server-side GitHub-App backend; OCC has only `constants/github-app.ts` install text + workflow template, no review-level backend |
| #75 | Code Review: option to review every repo in a GitHub org | **N-A** | – | same — hosted GitHub-App admin backend, absent in OCC |
| #76 | Code Review: PRs opened right after admin enables review silently skipped → retried | **N-A** | – | same — hosted GitHub-App backend, absent in OCC |
| #52 | Memory use when sending requests in long/resumed conversations | **STAGED / N-A** | – | (also covered by R3) vague perf; `structuredClone`/`JSON.parse(JSON.stringify`/`WeakRef`/`heapUsed` counts ALL unchanged; no discrete portable change |

**Summary: 2 PORT (#30, #38) · 1 STAGED-flagged (#23, live surface) · 20 N-A (incl. #51/#52 diffuse-perf, #54 Windows-perf, #23-mechanism-unrecoverable noted separately).**

The two PORTs are both **live-surface correctness bugs OCC currently shares with official 303** — highest-value findings of this cluster.

---

## ENV-1 — `CLAUDE_CODE_ATTRIBUTION_PROJECT` → **N-A**

### Official evidence (byte-verified)

New env var: `grep -aboF` count **prev=0, ver=10**.

**Validation** (vver @245166482) — a claude.ai Project ID (UUID or `claude_proj_…`):
```js
var N=/^\s*(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|claude_proj_(?:staging_|local_)?01[1-9A-HJ-NP-Za-km-z]{22})\s*$/;
function VOs(n){ … e==="CLAUDE_CODE_ATTRIBUTION_PROJECT" && !N.test(o) ? "not a claude.ai Project ID" : void 0 …
  t(`[jobs] ignored these saved environment entries in the job's state.json: ${r.join(", ")}` …) }
```

**Propagation to subprocesses/jobs** (vver @271952185):
```js
e.push(`CLAUDE_CODE_ATTRIBUTION_PROJECT=${go([a.CLAUDE_CODE_ATTRIBUTION_PROJECT ?? ""])}`)
```

### Feature determination

An **unlisted host-integration** env var (not in the changelog). It carries a **claude.ai Project ID** used to attribute a session's work to a claude.ai Project. It is validated (rejecting non-Project-ID values), persisted through the `[jobs] … state.json` background-job environment, and propagated into spawned subprocesses (background jobs / teammates / bridge children). This is the claude.ai **Projects** attribution plumbing — the host (claude.ai / Claude Desktop) sets it so CLI-spawned work is attributed back to a Project.

### OCC cross-check

- `rg "CLAUDE_CODE_ATTRIBUTION_PROJECT" src/` → **0 hits**.
- `rg "claude_proj_|attributionProject|ATTRIBUTION_PROJECT" src/` → 0.
- OCC's `src/utils/commitAttribution.ts` is **git-trailer / `Co-Authored-By` commit attribution** — completely unrelated to claude.ai Project IDs.
- OCC has no claude.ai **Projects** concept, no `[jobs] state.json` saved-environment filter, and no host that would set this var.

### Verdict: **N-A**

The entire claude.ai-Projects attribution subsystem this var feeds is absent from OCC. Nothing to port. (If OCC ever adds claude.ai Project attribution, this var + its UUID/`claude_proj_` validation regex is the entry point — recorded here for completeness.)

---

## ENV-2 — `CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT` → **N-A**

### Official evidence (byte-verified)

New env var: `grep -aboF` count **prev=0, ver=14**.

**Child consume + unset** (vver @256049514):
```js
function Tn(){
  { let n = a.CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT === !0;
    a.unset("CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT"),
    n && cA() && (V6n() ? g("bridge_projects_entrypoint_name")
                        : f("bridge_projects_entrypoint_name","host_name_kept")) }
}
```

**Host spawn sets it** (vver @262657392):
```js
if(l.projectsEntrypoint) T.CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT="1"
```

### Subsystem determination

Part of the **bridge-child spawn protocol**: when the host launches a bridge child that should run a claude.ai **Projects entrypoint**, it sets `CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT=1`; the child consumes it, **unsets** it (so it doesn't leak to grandchildren), and records a telemetry marker (`bridge_projects_entrypoint_name`). It is one of a family of `CLAUDE_CODE_BRIDGE_CHILD_*` flags the host sets and the child clears.

### OCC cross-check

- OCC's bridge host-side spawn is **DORMANT**: `commands.ts:89-90` `const bridge = feature('BRIDGE_MODE') ? require('./commands/bridge/index.js').default : null` — `BRIDGE_MODE ∉ FEATURE_ALLOWLIST` (featureFlags.ts:13-64) → `null`.
- OCC's actual bridge-child spawn env (`src/bridge/sessionRunner.ts:305-321`) sets only `CLAUDE_CODE_OAUTH_TOKEN:undefined`, `CLAUDE_CODE_ENVIRONMENT_KIND:'bridge'`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2`, and conditionally `CLAUDE_CODE_USE_CCR_V2` + `CLAUDE_CODE_WORKER_EPOCH`. **None** of the four `CLAUDE_CODE_BRIDGE_CHILD_*` flags are set.
- `rg "BRIDGE_CHILD_PROJECTS_ENTRYPOINT|projectsEntrypoint|bridge_projects_entrypoint" src/` → 0.

### Verdict: **N-A**

The var belongs to a claude.ai-Projects bridge-child protocol on a subsystem (BRIDGE_MODE host spawn) that is dormant in OCC and whose live spawn path (`sessionRunner.ts`) sets none of the `BRIDGE_CHILD_*` family. Nothing to port.

---

## #30 — `claude --worktree` exit cleanup guard (detached / another-branch HEAD) → **PORT (L)**

Changelog (literal line 32): *"Fixed `claude --worktree` removing the worktree and its branch without asking at exit when HEAD was detached or on another branch, which could lose commits."*

This is the **highest-value finding** of the cluster: OCC has a **live, currently-affected** `--worktree` surface that carries the exact 303 bug.

### OCC current state (the bug)

**`src/main.tsx:1444-1470`** — `--worktree` startup flag is live (creates a worktree session).

**`src/components/WorktreeExitDialog.tsx`** — the exit dialog, aligned to official **2.1.301 #7**. Its auto-remove guard (line 87):
```js
// If no changes and no commits, clean up silently
if (changeLines.length === 0 && (count === 0 || hookForcedAsk)) { … removing-clean … }
else { setStatus('asking') }
```
where `count` (line 60-67) is a **simple** `git rev-list --count ${originalHeadCommit}..HEAD`:
```js
let count = null;
if (worktreeSession.originalHeadCommit) {
  const { stdout: commitsStr, code } = await execFileNoThrow('git', ['rev-list','--count',`${worktreeSession.originalHeadCommit}..HEAD`]);
  count = code === 0 ? parseInt(commitsStr.trim()) || 0 : null;
}
```
**The bug:** `rev-list --count <base>..HEAD` counts commits reachable from **HEAD** but not `<base>`. If HEAD is **detached** or **on another branch**, commits made on the *worktree's own branch* (`refs/heads/<worktreeBranch>`) are **not** reachable from HEAD → `count===0` → with no uncommitted changes, the dialog **silently removes** the worktree and deletes the branch, losing those branch commits.

`WorktreeExitDialog.tsx:253-256` even documents the reduction: *"OCC has no submodule/moved-off surface, so the official `Et!==null`/`nt!==null` branches reduce to their `Et===null && nt===null` form here."* — i.e. OCC deliberately dropped the detached/another-branch classification that 304 now restores.

**`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:79-113`** — `countWorktreeChanges()` returns only `{changedFiles, commits}` (fail-closed `null`), same simple `rev-list --count ${originalHeadCommit}..HEAD`. No at-stake / detached / another-branch classification. `validateInput` (line 190-221) gates removal on `changedFiles>0 || commits>0` — misses detached/another-branch commits identically.

### Official 304 at-stake subsystem (verbatim, byte-recovered @249016065)

**`wV`** — count commits on given positive refs, excluding given negative refs (null on git failure / non-numeric):
```js
async function wV(e,n,r){
  let s=await aot(e,["rev-list","--count",...n,...r.map((y)=>`^${y}`),"--"]),h=s.stdout.trim();
  return s.code===0 && /^\d+$/.test(h) ? Number(h) : null
}
```

**`QEn`** — true iff `refs/heads/<n>` does not exist (for-each-ref count=1 returns empty):
```js
async function QEn(e,n){
  let r=await aot(e,["for-each-ref","--count=1","--format=%(refname)",`refs/heads/${n}`]);
  return r.code===0 && r.stdout.trim()==="" && r.stderr.trim()===""
}
```

**`G$r`** — the HEAD classifier (the core of the fix). Reads `symbolic-ref -q HEAD` and classifies into `its_branch` / `another_branch` / `like_its_branch` / `detached` / `unreadable`, counting at-stake commits per case:
```js
async function G$r({worktreePath:e,worktreeBranch:n,originalHeadCommit:r,hookBased:s}){
  if(s||!n) return null;
  let h=`refs/heads/${n}`,
      y=await aot(e,["symbolic-ref","-q","HEAD"]),
      [,S]=/^refs\/heads\/(.+)$/.exec(y.stdout.replace(/\r?\n$/,""))??[],
      w=y.exitCode===1 && y.stdout.trim()==="" && y.stderr.trim()==="";   // detached
  if(S===void 0 && !w) return {head:"unreadable",commits:null};
  if(S!==void 0 && S!==n && hh(S)===hh(n)) return {head:"like_its_branch",commits:null};
  let H=r;
  if(S===n) return {head:"its_branch",commits: H ? await wV(e,[h],[H]) : null};
  if(S!==void 0){                                                          // another branch checked out
    let K=H ? await wV(e,[h],[`refs/heads/${S}`,H]) ?? (await QEn(e,n)?0:null) : null;
    return {head:"another_branch",branch:S,commits:K}
  }
  return {head:"detached",                                                 // detached HEAD
    commits: H ? await wV(e,[h,"HEAD"],[H]) ?? (await QEn(e,n)?await wV(e,["HEAD"],[H]):null) : null}
}
```
Key: for `another_branch`/`detached`, commits are counted on the **worktree branch ref** `refs/heads/<n>` (not HEAD), so branch commits are no longer invisible.

**`tOt`** — human formatter for the at-stake phrase:
```js
function tOt(e,n,r){switch(e.head){
  case"another_branch":case"like_its_branch":return`on ${n} that ${r} doesn't have`;
  case"detached":return`on ${n} or at the detached HEAD`;
  case"its_branch":case"unreadable":case"not_read":return`on ${n}`}}
```

**`nOt`** — entry point: gated by `tengu_wary_ladle` (default `{safe:!0}` = ON); falls back to `{head:"not_read"}` + HEAD-rev-list when not read; adds `onKeptBranch` when the worktree moved to another branch whose commits are already on a kept branch:
```js
async function nOt(e,n){
  let {worktreePath:r,originalHeadCommit:s}=e,
      h = n || ui("tengu_wary_ladle",{safe:!0}) ? await G$r(e) : null;
  if(h===null) return {head:"not_read",commits: s?await wV(r,["HEAD"],[s]):null};
  if(n || h.head!=="another_branch" || h.commits!==0) return h;
  let y = s ? await wV(r,[`refs/heads/${h.branch}`],[s]) ?? null : null;
  return y===0 ? h : {head:h.head,branch:h.branch,commits:0,onKeptBranch:y}
}
```

**`mRn`** — branch delete helper (`branch -D --end-of-options`), part of cleanup.

**Dialog auto-remove guard** (vver @269341114) — now also requires `!("onKeptBranch" in Cn)`:
```js
if(No.length===0 && (Cn.commits===0||pn) && !("onKeptBranch" in Cn) && !wo && !Uo){ …removing-clean… }
else ve("asking")
// where Cn = ro.hookBased && !ro.originalHeadCommit
//   ? {head:"not_read",commits: ln||Ko?0:null}
//   : await nOt(ro,Ewe())
```

**ExitWorktreeTool onKeptBranch message** (vver @254108820):
```js
if(S!==void 0 && "onKeptBranch" in S){let R=S.onKeptBranch;return{result:!1,
  message:`The worktree is now on another branch, which has ${R} ${R===1?"commit":"commits"} that this session's starting commit lacks. Removing the worktree keeps that branch, so no commit is lost, but the user may still be working there.${f} ${Dt}`,
  errorCode:2}}
```

**Telemetry formatter `Ww(h,R)`** (vver @269337347):
```js
{commits:h.commits??-1, … h.head!=="not_read" && {head:c(h.head)},
 … "onKeptBranch" in h && {commits_on_kept_branch:h.onKeptBranch??-1},
 … R!==0 && {worktrees_inside:R??-1}}
```

### Port recipe for OCC

1. **`src/utils/worktree.ts`** — add the git helpers `wV` (rev-list with positive/negative refs), `QEn` (branch-exists check), the HEAD classifier `G$r` (via `symbolic-ref -q HEAD`), the entry `nOt`, and the formatter `tOt`. Reuse OCC's `execFileNoThrow('git', …)` for `aot`. Add the `tengu_wary_ladle` gate — OCC's `feature()` returns `false` for unregistered names, so to reproduce the official default-ON `{safe:!0}`, either add `tengu_wary_ladle` to `FEATURE_ALLOWLIST` or treat the gate as always-on (matching `ui(...,{safe:!0})`).
2. **Extend the worktree session state** with an `atStake: {head, commits, branch?, onKeptBranch?}` classification (replacing the bare `count:number|null`).
3. **`WorktreeExitDialog.tsx`** — replace the `count===0` auto-remove guard (line 87) with the official form: `changeLines.length===0 && (atStake.commits===0||hookForcedAsk) && !("onKeptBranch" in atStake)`. Update the subtitle/`removeDescription` to use `tOt`-style phrasing for detached/another-branch. Add `head`/`commits_on_kept_branch`/`worktrees_inside` to the `tengu_worktree_kept`/`removed` events (line 136/153/169).
4. **`ExitWorktreeTool.ts`** — `countWorktreeChanges()` must classify HEAD (detached/another-branch) and count commits on `refs/heads/<worktreeBranch>`, not HEAD. Add the `onKeptBranch` refusal message (errorCode 2) in `validateInput`.
5. **Tests** — detached-HEAD-with-branch-commits and another-branch-with-commits cases must now **ask** (not silently remove); `onKeptBranch` case must **refuse** with the "keeps that branch, no commit lost" message.

---

## #5 — `/claude-api managed-agents-secure` → **N-A**

Changelog (literal line 7): *"Added `/claude-api managed-agents-secure`, which compares a Managed Agents agent's settings with Anthropic's published security guide, without changing anything."*

New string `managed-agents-secure`: **prev=0, ver=24**.

### OCC cross-check

- `src/skills/bundled/claude-api/` — all `.md` files are intentional **1-byte stubs**; the real content lives in `src/skills/bundled/claude-api/claudeApiContent.ts` (a 247 KB bundled `.md`), which is the skill body, not a `managed-agents-secure` subcommand.
- `rg "managed-agents-secure|managedAgentsSecure|Managed Agents" src/` → no subcommand surface.
- "Managed Agents" is an Anthropic-platform product; OCC ships the `claude-api` skill as a stubbed reference, with no subcommand dispatcher for `managed-agents-secure`.

### Verdict: **N-A**

Consistent with OCC's documented "skill `.md` files are intentional 1-byte stubs" trim (see OCC-44 gap note re: `prompt-audit` claude-api subcommand). No `managed-agents-secure` surface to port.

---

## #45 / #56 — artifacts multi-view links + `/artifacts` delete confirmation → **N-A**

Changelog (literal line 47, #45): *"Improved artifacts with several views: when you ask for links to them, Claude now writes out each view's link and explains that the address bar stays the same as you switch views."*
Changelog (literal line 58, #56): *"Changed the `/artifacts` delete confirmation to show numbered choices: 1 or Enter keeps the artifact, 2 deletes it, and y, n and Esc still work."*

### OCC cross-check

- OCC has **no artifacts surface**: no `/artifacts` command, no artifact multi-view / address-bar concept, no artifact-delete confirmation dialog.
- The only artifact-adjacent tokens are env-var allowlist entries `CLAUDE_CODE_ARTIFACT_ROOM` / `CLAUDE_CODE_ARTIFACT_PRESENCE` in `src/utils/managedEnv.ts:366-367` — these are managed-env passthrough allowlist keys, **not** an artifacts feature.
- `rg "/artifacts|artifactView|artifact.*delete|ARTIFACT_ROOM" src/` → no feature surface (only the two env keys).

### Verdict: **N-A** (both)

No artifacts UI/command in OCC. Nothing to port.

---

## #37 — self-paced `/loop` wakeups at 1-hour max firing after prompt-cache expiry → **N-A**

Changelog (literal line 39): *"Fixed self-paced `/loop` wakeups scheduled at the 1-hour maximum firing just after the 1-hour prompt cache expired, so those wakeups no longer re-read the conversation uncached."*

The official fix clamps the `ScheduleWakeup` self-paced interval to fire *just before* the 1-hour (3600 s) prompt-cache expiry rather than at/after it.

### OCC cross-check

- OCC has **no `ScheduleWakeup` tool**. `rg "ScheduleWakeup" src/` → only a **dangling text reference** in `src/tools/BashTool/BashTool.tsx:507` (not a registered tool). Official-only tool per OCC's CLAUDE.md stream-json init divergence list.
- OCC's `/loop` (`src/skills/bundled/loop.ts`) is implemented via **`CronCreateTool`** (`src/tools/ScheduleCronTool/CronCreateTool.ts`, registered `tools.ts:15,237`) — a cron-schedule mechanism, not the self-paced `ScheduleWakeup` interval clamp.
- The `3600000` constant in OCC's MonitorTool is the **monitor deadline** (max monitor runtime), unrelated to prompt-cache-aware wakeup scheduling.
- Compared `ScheduleWakeup` tool description 303 vs 304: the tool itself is absent from OCC, so there is no description to diff.

### Verdict: **N-A**

OCC's `/loop` is cron-based and has no self-paced `ScheduleWakeup` 1-hour-max wakeup path. The prompt-cache-expiry clamp has no OCC surface.

---

## #38 — agent teams: approving a shutdown request from the main session no longer exits the whole CLI → **PORT (S)**

Changelog (literal line 40): *"Fixed agent teams: approving a shutdown request from the main session no longer exits the whole CLI."*

### Official evidence (byte-verified)

New guard strings (both **prev=0, ver=2**): `"…is not running as one"` and `"The teammate is the one that approves"`.
`shutdown_request` count prev=18→ver=20 (+2); `shutdown request` prev=22→ver=24 (+2).

**Official 304 `handleShutdownApproval` (`Et`, vver @271277338) — NEW guard at top:**
```js
async function Et(s,h){
  if(h.teammateContext===void 0 && !hN())                                   // ← NEW in 304
    throw new De("Only a teammate can approve a shutdown request, and this session is not running as one. Nothing was sent. To shut down a teammate, send that teammate a shutdown_request message. The teammate is the one that approves it.");
  let e=cd(),i=oP(),r=_S()||"teammate";
  t(`[SendMessageTool] handleShutdownApproval: teamName=${e}, agentId=${i}, agentName=${r}`);
  let y,b; if(e){let j=await nS(e,h.storageV5); if(j&&i){let q=j.members.find(se=>se.agentId===i); if(q)y=q.tmuxPaneId,b=q.backendType}}
  let S=KCo({requestId:s,from:r,paneId:y,backendType:b}), I=await pv(Ua,…), R=…, w=…;
  if(h.teammateContext!==void 0)                                            // ← NEW branch: in-process teammate aborts its OWN loop
    t(`[SendMessageTool] In-process teammate ${r} approving shutdown - aborting its own loop`), h.teammateContext.abortController.abort();
  else if(b==="in-process"){ … q.abortController.abort() … }
  else { if(i){ …fallback in-process abort… } setImmediate(async()=>{await Yn(0,"other")}) }   // Yn = gracefulShutdown — TEAMMATE's own process
  return{data:{success:!0,message:`Shutdown approved. ${R} Agent ${r} is now exiting.`,request_id:s},…w}
}
```
`hN()` = `isTeammate` (confirmed: guard semantics = "only a teammate can approve"). `De` = tool error class.

**Official 303 `handleShutdownApproval` (`kt`, vprev @269970727) — NO guard:**
```js
async function kt(s,h){
  let e=ad(),i=Ux(),r=Zb()||"teammate";    // ← starts DIRECTLY; no teammateContext/isTeammate guard
  t(`[SendMessageTool] handleShutdownApproval: …`); … if(w==="in-process"){…} else { … setImmediate(async()=>{await Yn(0,"other")}) } …
}
```

**The 303 bug:** the `else` branch ends in `setImmediate(gracefulShutdown(0,'other'))`. A teammate approving shutdown legitimately exits *its own* process. But the **main session / team-lead** (no `backendType`, no pane, no in-process fallback task) also falls into this `else` → `gracefulShutdown` → **exits the whole CLI**. 304's guard `if(teammateContext===undefined && !isTeammate()) throw` blocks the main session from ever reaching it.

### OCC cross-check — OCC carries the exact 303 bug

**`src/tools/SendMessageTool/SendMessageTool.ts:305-399` `handleShutdownApproval`:**
```ts
async function handleShutdownApproval(requestId, context) {
  const teamName = getTeamName()                    // ← NO guard; starts directly like official 303
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'
  …
  if (ownBackendType === 'in-process') { …abort own task… }
  else {
    if (agentId) { const task = findTeammateTaskByAgentId(agentId, appState.tasks)
                   if (task?.abortController) { …abort…; return {fallback path} } }
    setImmediate(async () => { await gracefulShutdown(0, 'other') })   // ← lines 387-389: SAME bug
  }
  …
}
```
- **Call site** `SendMessageTool.ts:888-893`: `case 'shutdown_response': if (input.message.approve) return handleShutdownApproval(input.message.request_id, context)`. When the main session's model emits a `shutdown_response{approve:true}` (the prompt `SendMessageTool/prompt.ts:40` instructs responding to a received `shutdown_request` with the matching `_response`), this runs in the **main session**.
- For the main session / team-lead: `getTeamName()` may be set, but the lead is **not** a member with a pane → `ownBackendType===undefined` → `else` branch; `findTeammateTaskByAgentId` finds no in-process task (lead isn't a teammate task) → **`setImmediate(gracefulShutdown(0,'other'))`**.
- **`gracefulShutdown`** (`src/utils/gracefulShutdown.ts:417`) → `commitExit()` (line 434) + failsafe `forceExit` → **exits the whole CLI**. Confirmed the bug is live.
- **`isTeammate()`** (`src/utils/teammate.ts:125-131`) returns `true` only for in-process teammates (`getTeammateContext()`) or tmux teammates (`dynamicTeamContext.agentId && .teamName`). Per `TeamCreateTool.ts:225-227` ("The lead is not a 'teammate' — `isTeammate()` should return false for them"), the lead/main session → `isTeammate()===false`. So the guard correctly distinguishes lead from teammate.
- OCC has `getTeammateContext()` + `isInProcessTeammate()` (`src/utils/teammateContext.ts:47,70`) — the OCC equivalents of the official `h.teammateContext` context field.

Note: OCC's *other* shutdown path — the leader-side inbox approval in `useInboxPoller.ts:655-760` (`killPane`) — already kills only the teammate pane (does not exit the CLI). The bug is specifically the **`SendMessageTool.handleShutdownApproval`** path, which OCC shares verbatim with official 303.

### Port recipe for OCC

Add the guard at the top of `handleShutdownApproval` (`SendMessageTool.ts:305`):
```ts
// Official 2.1.304 #38: only a teammate can approve a shutdown. Before this guard,
// the main session / team-lead approving one fell through to the else branch and
// gracefulShutdown(0,'other'), exiting the WHOLE CLI.
if (!getTeammateContext() && !isTeammate()) {
  throw new Error(
    "Only a teammate can approve a shutdown request, and this session is not running as one. Nothing was sent. To shut down a teammate, send that teammate a shutdown_request message. The teammate is the one that approves it.",
  )
}
```
- `isTeammate()` is already imported (`SendMessageTool.ts:33`); add `import { getTeammateContext } from '../../utils/teammateContext.js'` for the in-process-context half of the guard.
- OCC's existing `ownBackendType === 'in-process'` branch (line 348) + `findTeammateTaskByAgentId` fallback already abort the teammate's own task — functionally equivalent to the official's new `teammateContext.abortController.abort()` first branch. So the **guard alone** closes the CLI-exit bug; the in-process abort path needs no change.
- **Tests** — main-session/lead approval of a `shutdown_response{approve:true}` must throw "Only a teammate can approve…" and must NOT call `gracefulShutdown`; teammate (in-process + tmux) approval must still abort its own task / exit its own process.

---

## Batch N-A confirmations (#16, #18, #19, #20, #24, #46, #47, #53, #54, #71–#76) + STAGED (#23)

One-liner per item — OCC-trimmed surface + evidence:

- **#16** (changelog line 18 — scheduled Cowork cloud sessions re-waiting 5 min for subagent WebFetch URL approval) → **N-A**: OCC has only vestigial `CLAUDE_CODE_IS_COWORK` env checks (`QueryEngine.ts` ×6) + 2 telemetry event names (`classifierDecisionTelemetry.ts:162-163`); no Cowork cloud-session scheduler, no WebFetch URL-approval queue.
- **#18** (line 20 — claude.ai Directory plugin skills not running as commands from "/" in Cowork) → **N-A**: OCC plugin sources are `github`/`git`/`marketplace`/local only (`marketplaceHelpers.ts:373-480`, `marketplacePolicyValidation.ts:347-355`); no claude.ai Directory plugin sync, no Cowork cloud sessions.
- **#19** (line 21 — Remote Control withholding desktop history when a different account is signed in to the terminal) → **N-A**: remote-control server command DORMANT — `commands.ts:92-95` `remoteControlServerCommand = feature('DAEMON') && feature('BRIDGE_MODE') ? require(...) : null`; both flags ∉ allowlist → `null`. Claude-Desktop conversation-history integration absent. (OCC's `useRemoteControlChannel`/`SlackChannelHeader` in REPL.tsx are the Slack-based remote-control surface, not the Claude-Desktop history sync; and the server command that would activate it is gated off.)
- **#20** (line 22 — Remote Control failing to start from Claude Desktop when DISABLE_TELEMETRY/DO_NOT_TRACK set on a paid plan) → **N-A**: same dormant remote-control server (`DAEMON && BRIDGE_MODE` off); OCC has no Claude-Desktop launch path. (`DISABLE_TELEMETRY`/`DO_NOT_TRACK` are honored in `privacyLevel.ts:15-24` for privacy tiering, unrelated to a Desktop-launched remote-control start.)
- **#23** (line 25 — OTel settings via server-managed settings ignored for whole session after sign-in / first start after /logout) → **STAGED (flagged — LIVE surface)**: OCC's OTel is REAL, not stubbed (`utils/telemetry/instrumentation.ts` reads `OTEL_METRICS_EXPORTER`/`OTEL_LOGS_EXPORTER`; `prometheusExporter.ts`, `sessionTracing.ts`, `bigqueryExporter.ts`; `@opentelemetry/sdk-{logs,metrics,trace-base}` in `bootstrap/state.ts:2-6`), and `remoteManagedSettings` is live (`index.ts` `refreshRemoteManagedSettings`/`loadRemoteManagedSettings`/`isEligibleForRemoteManagedSettings`). `initializeTelemetryAfterTrust` (`init.ts:247-286`) waits for remote settings + `applyConfigEnvironmentVariables()` before init **when eligible**, but `telemetryInitialized` (`init.ts:55,289`) is a **one-shot** guard and `refreshRemoteManagedSettings()` on login (`login.tsx:89`, `main.tsx:2738`) only calls `settingsChangeDetector.notifyChange('policySettings')` — it does **not** re-init telemetry. So if telemetry initializes before sign-in delivers OTel settings (first-run / post-/logout), OCC likely ignores them for the whole session = the official 303 bug. **Official 304 fix mechanism not cleanly byte-identifiable**: the +2 `server-managed settings` sites are WSL-policy doc text (@237362702), `telemetryInitialized` count unchanged (6=6), no new `reinitializeTelemetry`/`resetTelemetry`. Verdict STAGED pending (a) first-run sign-in timing trace in OCC and (b) locating the official re-init/re-read path. **Flagged per task: unexpectedly LIVE OCC surface.**
- **#24** (line 26 — unsandboxed Bash in Claude Desktop **Code tab** not seeing `~/.zshrc`-exported env) → **N-A**: OCC `subprocessEnv.ts:81` builds env from `process.env` (+ `AI_AGENT`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_PID`/proxy) and does **not** source shell-startup files; OCC is a terminal CLI launched from a shell whose env already has the startup exports. The affected surface is the GUI-launched Claude Desktop **Code tab**, which OCC lacks (`commands/desktop/index.ts` + `DesktopHandoff.tsx` hand off to the real Claude Desktop app; OCC does not run bash inside a Code tab). No live OCC bug. (Note: OCC has no shell-startup-env sourcing at all, so it would only matter if OCC gained a GUI-launch path — it has none.)
- **#46** (line 48 — cloud sessions: first turn waits for local stdio MCP servers of claude.ai-synced plugins unless `alwaysLoad:true`) → **N-A**: OCC has claude.ai-connector **dedup** (`main.tsx:3220-3242`) + `alwaysLoad` (`Tool.ts:549-554`, used by ToolSearch deferral), but no cloud-session first-turn MCP scheduling and no claude.ai plugin sync. The `alwaysLoad` semantics OCC has are for tool-search deferral, not cloud-session first-turn gating.
- **#47** (line 49 — remote session recovers status when server refuses a status update carrying other session data) → **N-A**: OCC's bridge/remote-session layer is DORMANT (`DAEMON`/`BRIDGE_MODE` off; `sessionRunner.ts` is the trimmed bridge-child path). No remote-session status-recovery surface.
- **#53** (line 55 — self-hosted runner: better error when git host answers "not found" for a session's repo) → **N-A**: `src/self-hosted-runner/main.ts:3` = `export const selfHostedRunnerMain = () => Promise.resolve();` (auto-generated stub), gated behind `feature('SELF_HOSTED_RUNNER')` (`cli.tsx:320`, off). No runner error surface.
- **#54** (line 56 — Windows: run git.exe directly instead of through the cmd launcher) → **N-A**: Windows-only startup **perf**. Official adds a git-launcher probe — `gitExecutable` prev=5→ver=7, `MSYSTEM` prev=8→ver=9, `ucrt64"]` prev=0→ver=1, new `gitLauncherProbe`/`gitBehindLauncher` in `Lt()` (@237686735): `…e.gitExecutable??=GF("git")||"git"; …as(r).then(o=>{…e.gitBehindLauncher={launcher:r,program:o}}); return n?.launcher===e.gitExecutable && process.env.MSYSTEM===void 0 ? n.program : e.gitExecutable` with `ss=["mingw64","ucrt64"]`. The git.exe **validation** messages ("only git.exe counts", "must hold git.exe itself") are unchanged (prev=ver). OCC has **no git-executable-resolution subsystem** — it runs git via generic `execFileNoThrow('git', …)` → execa ("cross-platform .bat/.cmd compatibility", `execFileNoThrow.ts:124`). No live correctness bug; porting would mean adding the whole probe subsystem for a Windows-only perf gain → N-A (low-priority Windows perf, no OCC surface).
- **#71** (line 73 — cloud sessions: folders in composer's @ list showing no name) → **N-A**: no cloud composer UI. OCC "composer" hits = `BriefTool/upload.ts` (MessageComposer, dormant KAIROS), `remote-setup/api.ts`, `claudeApi.ts` (`composer.json` PHP), lockfile regexes. None is a cloud-session @-list composer.
- **#72** (line 74 — Claude Tag: Claude silent when its channel becomes shared across Enterprise Grid workspaces) → **N-A**: no Claude Tag / Enterprise Grid / shared-channel surface (`rg` → 0 relevant).
- **#73** (line 75 — Claude Tag: `@Claude !fork` outside a thread gets no visible reply) → **N-A**: no Claude Tag. OCC `!fork`/`forkSession`/`forkEnabled` hits are **session forking** (`ResumeConversation.tsx:224,262`, `AgentTool/prompt.ts:299`, `planModeResume.ts:333`) — unrelated to the Claude Tag Slack `!fork` command.
- **#74** (line 76 — Code Review: review levels Quick/Standard/Deep, org + per-repo) → **N-A**: server-side hosted **GitHub App** backend. OCC has only `constants/github-app.ts` (install `PR_BODY`, `CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT` GitHub-Actions template) + `RemoteAgentTask.tsx:175` install-check text; `rg "review level|reviewLevel|Quick.*Standard.*Deep"` → 0. No review-level backend.
- **#75** (line 77 — Code Review: option to review every repo in a GitHub org incl. later-added) → **N-A**: same hosted GitHub-App admin backend; `rg "organization.*repositor|review every repo"` → 0.
- **#76** (line 78 — Code Review: PRs opened within a minute of enabling review silently skipped → retried) → **N-A**: same hosted GitHub-App backend (PR-intake retry), absent in OCC.

---

## Item 9 — #51 (many-subagents responsiveness) + #52 (memory) — quick check

- **#51** (line 53 — *"Improved responsiveness and throughput when many subagents are running at the same time"*) → **N-A / STAGED-vague**: byte-checks show `maxConcurrent` (47=47), `MAX_CONCURRENT` (15=15), `semaphore` (14=14), `pLimit` (17=17), `workerPool` (0=0) **all unchanged**; `concurrency` +2 and `subagent` +22 are diffuse (spread across many unrelated subagent items this release). No byte-identifiable discrete concurrency-limit / worker-pool change. This is an internal scheduling/rendering perf optimization, not a portable discrete diff.
- **#52** (line 54 — *"Improved memory use when sending requests in long or resumed conversations"*; also covered by R3) → **STAGED / N-A**: byte-checks show `structuredClone` (33=33), `JSON.parse(JSON.stringify` (12=12), `WeakRef` (53=53), `heapUsed` (36=36) **all unchanged**; `memory` +48 and `gc(` +13 are diffuse/common-token noise. No byte-identifiable discrete change. R3 records the plausible OCC target (`claude.ts:2022-2098` multiple full `messagesForAPI` copies) but the official change is logic-only/vague. Consistent with R3's #52 = STAGED/N-A.

Both are **performance-only, diffuse, not byte-identifiable** → no discrete port target. Recorded as N-A/STAGED-vague per task guidance.

---

## Cross-cluster notes

- **#30 (worktree) is the cluster's flagship PORT** and interacts with the worktree subsystem other clusters may touch: the official `tengu_wary_ladle` gate (default ON via `{safe:!0}`) must be reconciled with OCC's `feature()`-returns-false-for-unregistered semantics (add to `FEATURE_ALLOWLIST` or hardcode-on). The at-stake classifier `G$r` supersedes the 2.1.301 #7 nullable-count logic already in `WorktreeExitDialog.tsx` — port it as a replacement, not an addition.
- **#38 (agent-teams shutdown) PORT** is small but a **live correctness bug**: any OCC code path that lets the main session/lead emit `shutdown_response{approve:true}` exits the CLI. The `useInboxPoller.ts` leader-side `killPane` path is already correct (teammate-scoped); only `SendMessageTool.handleShutdownApproval` needs the guard. Coordinate with any agent-teams cluster on the `getTeammateContext()` import.
- **#23 (OTel/server-managed settings) is the one flagged LIVE-surface STAGED item.** Unlike the cleanly-trimmed Cowork/cloud/Claude-Tag/Code-Review/remote-control surfaces, OCC's OTel + remoteManagedSettings are both real and wired. A follow-up should trace OCC's first-run sign-in ordering (does `initializeTelemetryAfterTrust` run before `login` delivers remote settings?) and locate the official re-init path (not found via `server-managed settings`/`telemetryInitialized` string diffs — likely a control-flow change needing targeted decompilation of the telemetry-init region).
- **Dormancy anchor** reused across #19/#20/#47 (remote-control/bridge) and ENV-2: `feature('DAEMON')`/`feature('BRIDGE_MODE')` are ∉ `FEATURE_ALLOWLIST` (`featureFlags.ts:13-64`), so `commands.ts:89-95` registers neither the bridge nor the remote-control-server command. Any future re-enablement of those flags would resurrect these surfaces and re-open #19/#20/#47/ENV-2 for reconsideration.
- **#54 (Windows git.exe)** — if OCC ever adds a git-binary-resolution layer (e.g. for the #30 worktree port's `aot`/git helpers), consider whether the Windows cmd-launcher path is worth optimizing then; today OCC's generic execa path has no such layer.
