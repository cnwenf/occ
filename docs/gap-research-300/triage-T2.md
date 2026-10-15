# Triage T2 — round 2026-10-16 (official Claude Code 2.1.299 → 2.1.300)

Cluster: hooks / daemon / background-commands / worktree / reftable / gateway
Entries: 11, 12, 24, 28, 29, 30, 33, 41, 43, 44, 56, 58, 61, 65, 66

Method: binary-only forensics on `/tmp/cc-diff-300/v{299,300}/package/claude` (`strings`, `grep -aboF`, `grep -cF`, bounded `dd`; binaries never executed). Novelty proofs via presence counts against `s299.txt`/`s300.txt` (`new_strings.txt` unusable — giant minified lines). OCC evidence from repo greps at `b5e0591`+.

| # | Disposition | Title |
|---|---|---|
| 11 | ALREADY-ALIGNED | SessionEnd hooks vs exiting with a background command running |
| 12 | N-A | `--help` naming removed tool (REPL) in `--restricted` description |
| 24 | PORT | Plugin WorktreeCreate/WorktreeRemove hooks not firing on `--worktree` start |
| 28 | PORT | Agent hooks ignoring their `model` (alias / override / unavailable fallback) |
| 29 | PORT | `--worktree` wrong start commit (ambiguous name) + wrong initial branch |
| 30 | STAGED | `.invalid` branch + worktree reopen failure in reftable repos |
| 33 | PORT | Bare-repo worktree fetch-fail fallback bases on main repo HEAD |
| 41 | PORT | Claude polling a background command's output file / sleeping |
| 43 | PORT | `daemon stop --any` prints "stopped" while a stuck service survives |
| 44 | ALREADY-ALIGNED | `daemon stop` silent with telemetry off (OCC output unconditional) |
| 56 | ALREADY-ALIGNED | Exit force-kills background commands (OCC: immediate SIGKILL) |
| 58 | N-A | `claude gateway` stopping on unusable `desktop:` policy key |
| 61 | STAGED | Background sessions resuming carried workflow via Workflow tool approval |
| 65 | PORT | `updatedInput` from PreToolUse/PermissionRequest not re-validated |
| 66 | PORT (dormant) | `remote-control --sandbox/--no-sandbox` removal |

---

## 11 — ALREADY-ALIGNED: SessionEnd hooks not running when exiting with a background command alive

**Official surface (binary):** no v299→v300 string delta on the SessionEnd path — `SessionEnd` 44/44, `session_end` 20/20, `SessionEnd hook` 2/2 (`grep -cF` on s299/s300); `SessionEnd hook` strings @107935296 (message region) and @227998003 (hooks code region) in v300. The fix is ordering/control-flow only, not recoverable from strings — so alignment is judged on the OCC side against the changelog-described outcome (hooks must still run when exiting with bg commands alive).

**OCC evidence:** `src/utils/gracefulShutdown.ts:409-557` — failsafe timer :443-455 (`max(5000, sessionEndBudgetMs+3500)`), `cleanupTerminalModes()` :465, `runCleanupFunctions()` :476 racing all registered cleanups (incl. bg-task kills) against a 2000ms ceiling :482-491, then `executeSessionEndHooks` :503 (`src/utils/hooks.ts:6177-6221`, `AbortSignal.timeout(sessionEndBudgetMs)`; defaults `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT=1500` / `SESSION_END_HOOK_BUDGET_MAX_MS=60000` hooks.ts:251-252), then `forceExit` :555-556. Bg-command kills are registered cleanups (`src/components/LocalShellTask.tsx:393-395` `registerCleanup(killTask)`; `src/utils/killShellTasks.ts:34-45`; `src/utils/ShellCommand.ts:363-368` immediate `treeKill(pid,'SIGKILL')`).

**Why aligned:** every bg kill is bounded (immediate SIGKILL + 2000ms race ceiling + outer failsafe), and hook execution is sequenced *after* teardown unconditionally — there is no path where a live background command prevents reaching `executeSessionEndHooks`. The official failure mode (hooks skipped when a bg command is still running at exit) is structurally absent.

## 12 — N-A: `--help` naming a removed tool in the `--restricted` description

**Official (binary):** help text v299 @101269076 vs v300 @101250712 — single diff: `(Bash, PowerShell, REPL and the other code-running tools)` → `(Bash, PowerShell and the other code-running tools)`. Removed tool name: **REPL**. Full v300 text: "Restricted mode: removes the built-in tools that run commands or code (…) and WebFetch unless --tools names them, and ignores user, project and local settings files (managed settings and --settings still apply; add --strict-mcp-config to skip MCP servers too). Also confines the file tools to the working directories (--add-dir included), refuses bypassPermissions, and lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files."

**OCC surface absence:** OCC has no `--restricted` flag — no option registration in `src/main.tsx` (grep for `restricted` finds prose only: `src/utils/claudemd.ts:544`, `src/utils/attachments.ts:2280`, `launchToolList.ts:2` "--tools half only"); precedent N-A in `docs/gap-research-291/cluster-h:62`.

**Recorded for the future `--restricted` port:** use the v300 wording (no "REPL" in the tool list).

## 24 — PORT: plugin WorktreeCreate/WorktreeRemove hooks not running on `--worktree` start

**Official (binary):** startup worktree function `a8t` @226762100 (v300):
```
...retry with --worktree.");y4e(n);let h=s.fromCwd??le(),y=ke(),S,
w=BHn()?await jHn({id:q(),project:{originalCwd:ke(),projectRoot:Or()}},n,
  {storageV5:s.storageV5,credentials:s.credentials})
  .catch((K)=>{if(!fr(h))zNs(h),m("git_worktree_create","hook_failed_not_git_repo");throw K}):void 0;
if(w){ ...ancestry/symlink screen... S={...,hookBased:!0} } else { ...built-in U6e(K,n,s) create... }
```
`BHn` = `dispatchesWorktreeCreate` (export map @237578390 `BHn as dispatchesWorktreeCreate`; symbol @101097860 region; present 2/2 in both versions). The hook-dispatch check runs **at startup, before any worktree creation**, so plugin hooks are already registered when `--worktree` boots. Corroborating counts: `WorktreeCreate` 52→54, `WorktreeRemove` 34→35.

**OCC evidence:** `src/entrypoints/sdk/setup.ts` bootstrap :176-285 calls `createWorktreeForSession` at :233 (→ `src/utils/worktree.ts:801` → `getOrCreateWorktree` :288), but `loadPluginHooks()` runs **later** at setup.ts:324-326. At :233 the plugin hook registry is empty, so `hasWorktreeCreateHook` (`src/utils/hooks.ts:7109-7119`, snapshot + `getRegisteredHooks`) is false and the hook-based path (worktree.ts:815/:820-827) never fires on `--worktree` start. Knock-on: `hookBased` stays unset → the WorktreeRemove hook is skipped at teardown (worktree.ts:991-993 gates removal hooks on the hookBased set; fire sites :993/:1138). Schemas exist (`coreSchemas.ts:384-385, :732-745, :1119-1126`); executors exist (`hooks.ts:7127-7157` create, `:7166-7202` remove). Parity scope: official changelog itself says **not yet fixed for `--tmux`** — port the `--worktree` startup path only.

**Sketch:**
- `setup.ts`: move/await `loadPluginHooks()` (currently :324-326) **before** `createWorktreeForSession` (:233); guard against double-load (idempotent flag or relocate the single call).
- Nothing else changes: worktree.ts:815/:820-827 then discovers the hooks; `hookBased` propagates to the remove path (:991-993) automatically.
- Test: project settings/plugin defining WorktreeCreate+WorktreeRemove hooks that touch marker files; run `occ --worktree t24name`; assert both markers, hook-provided path honored, ancestry screen errors for dotted/symlink paths (worktree.ts guard parity); teardown fires remove hook. e2e in `test/e2e/run.sh` incl. REPL start with `--worktree`.

## 28 — PORT: agent hooks ignoring their `model` (aliases, subagent override, unavailable-model fallback)

**Official (binary), fully recovered this round** — agent-hook executor `jZe` @227964000-227968200 (v300):
```
Ut=UIe(e.model??Ov()),                       // denied-models redirect; default = small-fast
qt=e.model===void 0?Ut:AIr(Ut),              // alias-resolve only when hook specified a model
Wt=oc(y),                                    // caller model = y.options.mainLoopModel
tn=e.model===void 0&&Ie()==="gateway"&&a.ANTHROPIC_DEFAULT_HAIKU_MODEL===void 0
     &&a.ANTHROPIC_SMALL_FAST_MODEL===void 0?Wt:qt,
...
permissionLayers:(y.permissionLayers??[]).filter((_n)=>nn||_n.kind!=="effort")
     .concat({kind:"model",mainLoopModel:tn}),
options:{...y.options,tools:vt,mainLoopModel:tn,...}   // set AFTER spread → subagent model can't override
```
- `AIr` @219020138: `function AIr(e){return jme(e.toLowerCase().trim())?Ot(e):e}` — `Ot` = `parseUserSpecifiedModel` (export map @240629183) → **aliases like `haiku` resolve**.
- `Ov` @218987191 = small-fast-model resolution (`ANTHROPIC_SMALL_FAST_MODEL` → `GS(WC(e))`, bedrock/vertex special case, else haiku default).
- `UIe` @218987641 = deniedModels redirect ("[deniedModels] helper request for … sent as …").
- Unavailable-model fallback: refusal detector `ORe` @229228103 = `e.isApiErrorMessage===!0&&[400,403,404].includes(e.apiErrorStatus??0)&&!e.resendCannotCure`, evaluated on the **first** assistant message (`$n===0→Xn=ORe(_n)`); then:
```
if(Xn&&tn!==Wt&&e.model!==Wt&&!h.aborted&&!kG())
  return t(`Hooks: ${tn} was refused, running the agent hook on ${Wt}`),
         {...await jZe({...e,model:Wt},n,r,s,h,y,S,w),hook:e};
```
i.e. the whole hook is **re-run on the caller's model** instead of failing open. `was refused, running the agent hook on` is NEW in v300 (299=0, 300=2) @107695561 / code @227967610. Double-failure falls to `outcome:"cancelled"` (no structured output) — the hook still doesn't "allow" via a skipped evaluation.

**OCC evidence:** hook schema keeps raw `model: z.string().optional()` (`src/schemas/hooks.ts:112-117, :188-193`). `src/utils/execAgentHook.ts:129` `const model = hook.model ?? getSmallFastModel()` — **no alias resolution**: `"haiku"` reaches the API literally → 400/404 → `non_blocking_error` (:354-366) → `onFailure` default `'continue'` (schemas/hooks.ts:40) = **fail-open allow with no evaluation**. Same in `src/utils/execPromptHook.ts:138→:180` (:229-249). `parseUserSpecifiedModel` exists (`src/utils/model.ts:917-1011`, aliases haiku/sonnet/opus/fable/best/opusplan/[1m]) but is never applied to `hook.model`. The subagent-override sub-fix is **already aligned**: `execAgentHook.ts:140-143` assigns `mainLoopModel: model` after the context spread.

**Sketch:**
- execAgentHook.ts:129 / execPromptHook.ts:138: resolve `hook.model` through an `AIr`-equivalent — trim+lowercase, if alias (`jme`-equivalent = the alias table in model.ts:917-1011) run `parseUserSpecifiedModel`, else pass the string through; default stays `getSmallFastModel()`.
- Add caller-model fallback: capture `context.options.mainLoopModel` (caller model); if the first assistant/loop message is an API error with status 400/403/404 and the hook-specified resolved model ≠ caller model → re-run the hook once with the caller model, logging `Hooks: ${model} was refused, running the agent hook on ${caller}` (official text).
- Never treat a model refusal as "hook passed": after a failed retry, keep existing `non_blocking_error`/`onFailure` semantics (≈ official `outcome:"cancelled"`).
- Test (unit): mock API 404 for alias-resolved-but-unavailable model → assert second invocation uses caller `mainLoopModel` + log text; `"haiku"` alias → assert resolved id sent, not the literal; double-failure → assert onFailure path unchanged. e2e: settings Stop hook with `model: "haiku"` under a mock gateway.

## 29 — PORT: `--worktree` wrong start commit (ambiguous name) + wrong initial branch

**Official (binary):** v299 vs v300 base-resolution diff (dd dumps @225554059 / @226750400-226752900):
- v299 PR case ends `H="FETCH_HEAD"`; v300: `K=Ut?.sha??null,H=K===null?"FETCH_HEAD":\`${K}^{commit}\`` — start-point **pinned to the peeled SHA** whenever known.
- v300 fetch-fail fallback likewise `H=\`${K}^{commit}\`` (see entry 33).
- `^{commit}` presence count 299=10 → 300=13; new sites @226748115 / @226751532 / @226752270 — all in the worktree-create region.
- Add argv unchanged both versions: `Q=["worktree","add"];if(V?.length)Q.push("--no-checkout");Q.push("--no-track","-B",h,s,H)` run with `env:{...LC_ALL:"C"}` — but `H` is now a pinned `${sha}^{commit}` instead of a re-resolvable name, so a tag/branch named like a commit ID can no longer divert `git worktree add`'s DWIM resolution.
- Initial-branch half: official session state keeps both `S={...worktreeBranch:be,originalBranch:V,...}` (@226764659) — display/status uses the worktree's own branch, `originalBranch` (captured pre-create via `V=await Kc()`) is only for exit-restore.

**OCC evidence:** `src/utils/worktree.ts:390-393` resolves `baseSha` via `rev-parse --verify --quiet <baseBranch>` (LC_ALL:C, cwd=repoRoot) but :416/:422 then passes the **name**: `addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)` → git re-resolves at add time; `baseBranch` ∈ {'FETCH_HEAD','HEAD','origin/<x>'} races/ambiguity. Branch bug: `worktree.ts:838` `originalBranch=getBranch()` warmed **before** chdir; `setup.ts:214-218` chdirs to mainRepoRoot, :233 creates, :271-277 chdirs into the worktree — but the GitFileWatcher pins its gitDir on first read (`src/utils/gitFilesystem.ts:353-354`, early-return :342-345) and nothing resets it after the chdir (`resetGitFileWatcher` is only wired to /clear, `src/state/caches.ts:126`) → the session's first git status names the old branch.

**Sketch:**
- worktree.ts:422: when `baseSha` resolved successfully, pass `${baseSha}^{commit}` (peeled pin, mirrors official `H`) as start-point instead of `baseBranch`; keep the name only when unresolvable.
- setup.ts: after the chdir at :271-277, call `resetGitFileWatcher()` + clear the branch cache so first status re-resolves inside the worktree; carry `worktreeBranch` in session state for display (official `S.worktreeBranch` vs `originalBranch` split).
- Test: repo with a tag or branch literally named like a 40-hex/short SHA diverging from the intended base; `occ --worktree` → assert worktree HEAD == intended base SHA (not the name-DWIM pick); assert first status/context branch == new worktree branch. Unit for argv shape (`-B <branch> <path> <sha>^{commit}`).

## 30 — STAGED: `.invalid` branch display + `--worktree` reopen failure in reftable repos

**Official (binary):** git watcher class @217070281 (v300): fields `reftable=!1;generation=0;cache=new Map;computing=new Map;inconclusiveRefReads=0;retriesLeft=new Map;...repoBranches/repoWatchers/repoBranchListeners`; init `reftable=r,this.initialized=!0`; reftable branch:
```
if(this.reftable){this.watchPath(T(this.gitDir,"reftable","tables.list"),this.gitDir,()=>{this.onHeadChanged()}),
 this.commonDir&&...watchPath(...,"reftable","tables.list"),...,()=>{this.invalidate()})}
await this.watchCurrentBranchRef()
```
classic HEAD read gated `reftable?null:await Tte(this.gitDir)`; `.invalid` placeholder near HEAD/branch handling. Novelty: `tables.list` 299=0 → 300=2 (@110877168, @217071395); `inconclusiveRefReads` 299=0 → 300=2; `reftable` 12→14; `.invalid` 128→131. (Separate surface: upload-path reftable note @106950890 "keeps its refs in the reftable format…the new upload path does not support that yet".)

**OCC evidence:** `src/utils/gitFilesystem.ts` has **zero** reftable support — `readGitHead` :149-183 (file read), `resolveRef` :203-266 (loose refs + packed-refs only), `readWorktreeHeadSha` :619-640 → null in reftable repos → the `--worktree` reopen fast-path (`worktree.ts:296-308`) fails and falls through to create-on-existing-path; `computeBranch` :500-510 degrades to a 'HEAD'-ish fallback (the `.invalid`-class symptom). Cleanup-side reftable awareness exists (worktree.ts:913-977 `isReftableGitDir` :927-936, `pruneWorktreesIfReftable` :957-977, fired :1023/:1173 — landed #113) but the **read side** is missing.

**Why STAGED:** the official read path under reftable (how branch/SHA are resolved once `tables.list` fires — binary reftable parsing vs `git` subprocess) is not recoverable from the strings dumped this round; a faithful port means a new reftable read layer in gitFilesystem.ts plus watcher rework — deeper subsystem work than this round's budget.

**Next-round probe:** dump the full watcher class region (@217070000-217075000) hunting for subprocess calls (`symbolic-ref`/`rev-parse`/`for-each-ref` import sites) inside the reftable branch; find the `reftable=r` detection source (grep `extensions.refStorage`, `refStorage` in v300); trace `.invalid` emission sites in the watcher region for the display contract; then port a read layer (likely simplest: shell out to `git` when `isReftableGitDir`) and e2e with `git init --ref-format=reftable`: branch display, `--worktree` create + reopen, HEAD-sha fast-path.

## 33 — PORT: bare-repo `--worktree` fetch-fail fallback bases on the main repo's HEAD

**Official (binary), exact v299→v300 diff (dd @225554059 / @226752xxx):**
- v299: fetch-fail → `H=Xe===0?He:"HEAD"`, then `if(!G)G=await DQt({base:H,kind:H==="HEAD"?"head_fallback":H==="FETCH_HEAD"?"fetch_head":"origin_default",failure:...,cwd:e,root:e})` — fallback HEAD resolved against **repoRoot `e`** (the bare/main repo in bare layouts).
- v300: `if(Ye===0)H=We;else t(\`[worktree] fetch of origin/${He} failed — basing worktree on local HEAD\`,{level:"warn"}),K=await Hen({repoRoot:e,fromCwd:r?.fromCwd,kind:"head_fallback"}),H=\`${K}^{commit}\`` — fallback resolved from **`fromCwd` (the current checkout)** and pinned; `htn` kind list drops `head_fallback` (now `fetch_head`/`origin_default` only). Presence: `basing worktree on local HEAD` 1/1 (existed, behavior around it changed), `origin_default` 2→3, `fetch_head` 2→3.
- v299 already had the fromCwd pattern for the explicit-HEAD case (`let Ae=r?.fromCwd??e;G=await DQt({base:"HEAD",kind:"head_requested",cwd:Ae,...})`) — v300 extends it to the fetch-fail fallback.

**OCC evidence:** `src/utils/worktree.ts:361-378` origin-default flow; fetch failure → :378 `baseBranch='HEAD'`; :390-393 `rev-parse --verify --quiet HEAD` with **cwd=repoRoot** — and repoRoot canonicalizes to the bare/main repo (`src/utils/git.ts:218-222` `if (basename(commonDir) !== '.git') return commonDir...`; setup.ts:214-218 chdirs to mainRepoRoot). In a worktree-of-a-bare-repo layout, OCC's fallback base = the **bare repo's** HEAD, exactly the v299 bug.

**Sketch:**
- Thread the original cwd (captured in setup.ts before any chdir) into `getOrCreateWorktree` options as `fromCwd`.
- In the fetch-fail branch (worktree.ts:378): resolve `git -C <fromCwd> rev-parse --verify HEAD` (mirror `Hen({repoRoot,fromCwd,kind:"head_fallback"})`), warn `[worktree] fetch of origin/<b> failed — basing worktree on local HEAD`, set start-point to `${sha}^{commit}` (shares entry-29 change).
- Test: bare repo + linked checkout on a branch with a known SHA distinct from the bare HEAD; unreachable origin (bad remote URL / offline); `occ --worktree x` from the linked checkout → assert new worktree HEAD == the checkout's HEAD, warn logged.

## 41 — PORT: Claude polling a background command's output file or sleeping while it runs

**Official (binary):** `'do not poll'` 7→9. Result-message ternary @228323540 (v300):
```
...terminated when you give your final response and no notification can follow that — so do not end
your turn to wait for it; if you need its result, wait for it before giving your final response."
:r?void 0:K?"You will be notified when it completes — do not poll that file or sleep while waiting."
:"You will be notified when it completes."
```
Tool-description builder @225820817:
```
`- `run_in_background` runs the command detached. ${BQt} No `&` needed.`;
if(Vbr())be+=" You will be notified when it exits — do not poll its output file while waiting.";
if(l6()&&Se)be+=" Foreground `sleep` is blocked; use Monitor with an until-loop to wait on a condition.";
```
→ when completion notifications exist (`K`/`Vbr()` gates), both the runtime result and the tool description explicitly forbid polling/sleeping.

**OCC evidence:** `src/tools/BashTool/BashTool.tsx:744-766` background result variants — generic :765 `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}` (no notification/anti-poll clause), backgroundedByUser :752 (none), timeout-auto-bg :763 only "You will be notified when it completes. To check interim output, use Read on that file path.", assistant variant :750. Description bullets lack the `Vbr()` sentence (schema region :255). OCC does have the notification mechanism (bg tasks re-invoke on exit), Monitor (MONITOR_TOOL allowlisted) and the foreground-sleep block (:663-668) — so the gates are satisfiable. Some anti-poll text exists only in the system prompt (`src/utils/prompt.ts:60, :423-441`, :432 "do not poll").

**Sketch:**
- BashTool.tsx result variants (:750/:752/:765): when completion notification is supported, append ` You will be notified when it completes — do not poll that file or sleep while waiting.` (official wording; keep the interim-output Read hint where present).
- Tool description builder: add ` You will be notified when it exits — do not poll its output file while waiting.` to the `run_in_background` bullet under the same gate (mirror `if(Vbr())`).
- Test: unit snapshots of all four result variants (gate on/off); description snapshot; REPL e2e — `run_in_background` a `sleep 5`, assert tool result text contains the anti-poll clause and the model-facing description contains the new sentence.

## 43 — PORT: `daemon stop --any` printing "stopped" while a stuck service keeps running

**Official (binary):** NEW-in-v300 strings (299=0): `force-killing it (SIGKILL)` (300=2), `did not answer; asking it to exit (SIGTERM) and waiting up to` (2), `daemon_stop_still_running` (2), `outlives SIGKILL` (2), `No sessions were ended` (3); `was not stopped: pid=` 2→3. Message flow @111238330/@111240268:
1. "note: the [supervisor] (pid=N) did not answer; asking it to exit (SIGTERM) and waiting up to [N]"
2. "…) is still running; force-killing it (SIGKILL)"
3. survival after kill: "…after SIGKILL. A process that outlives SIGKILL is usually waiting inside the operating system…restart the computer." (+ analytics `daemon_stop_still_running`, exit 1)
4. unverifiable: "…s after SIGTERM, and could no longer be verified…so it was not sent SIGKILL…Re-run `claude daemon stop --any --keep-workers`…run `ps -ww -o args= -p [pid]`" (+ `daemon_stop_holder_unverified`)
5. foreign holder: "could not stop the…belongs to another user…No sessions were ended." (+ `daemon_stop_holder_is_init`)
Help text @111230000: `stop  Shut down the supervisor and terminate background sessions`, `--any  also stop a transient (non-service) daemon`, `--keep-workers  leave detached sessions running`. Cross-ref @104541589: "Stop it with `claude daemon stop --any` (a graceful, socket-based stop)"; ") was asked to stop but has not exited yet".

**OCC evidence:** `src/daemon/lockfile.ts:209-261` `displaceHolder` — SIGTERM :232-236, 5s wait :239-243, SIGKILL :248, 300ms settle :252, then returns `displaced:true` **unconditionally** (:260) — no post-SIGKILL liveness re-check. `src/cli/handlers/daemon.ts:83-106`: `--any` branch prints `Stopped background sessions held by pid=${res.holder.supervisorPid}.` (:88-90) and exits 0 regardless. `src/main.tsx:4703-4707` stop command help (`--any, -a  Displace any holder (force)`); supervisor-side `stopExistingSupervisor` (supervisor.ts:126-174) re-checks after SIGTERM (:163) but the displace path doesn't after SIGKILL.

**Sketch:**
- lockfile.ts `displaceHolder`: after SIGKILL+settle, re-check liveness (`isPidAlive`, pattern from process.ts:110-129); return an immutable result `{displaced, survived, unverified}` (post-SIGTERM disappearance + still-held lock → `unverified`; ESRCH-vs-EPERM distinguish foreign holder).
- daemon.ts:83-106: `survived` → print official-style "…(pid=N) is still running after SIGKILL. A process that outlives SIGKILL is usually waiting inside the operating system — …restart the computer." and `process.exitCode=1`; `unverified` → print the not-verified variant with the `ps -ww -o args= -p <pid>` hint (do **not** claim SIGKILL was sent); foreign user → "No sessions were ended." + exit 1. Log `daemon_stop_still_running`/`_holder_unverified`/`_holder_is_init` through OCC's analytics stub.
- Related (folds in entry-44 second symptom): after a successful SIGKILL displace, refresh `~/.claude/daemon-status.json` (workerRegistry.ts:144-170) so killed workers don't stay listed as running.
- Test (unit): fake holder that traps SIGTERM; mock liveness true-after-kill → assert exit 1 + message; liveness false → exit 0 + "Stopped…". e2e: `occ daemon start` then `occ daemon stop --any` happy path stays exit 0.

## 44 — ALREADY-ALIGNED: `daemon stop` exiting with no output when telemetry is off

**Official (binary):** the v299 bug required stop-path console output coupled to telemetry initialization; v300 ships unconditional stop outputs — corroborated by NEW output strings (299=0→300): `No sessions were ended` (3), the still-running/unverified/foreign-holder messages (entry 43 dumps @111238330/@111240268). Exact v299 gating code not recovered (no string delta exposes the gate) — noted, not invented.

**OCC evidence:** `src/cli/handlers/daemon.ts:88-102` — every stop-path message is a bare `console.*` call, unconditional (:88, :92, :97, :100, :102); the stop branch never calls `logEvent`; `grep -rn 'feature(\|logEvent' src/daemon/` → zero telemetry gating in the daemon subsystem (analytics stubbed workspace-wide). OCC cannot exhibit "no output when telemetry is off".

**Caveat (different mechanism, tracked under entry 43 sketch):** SIGKILL-based displacement bypasses `supervisor.shutdown()` (supervisor.ts:283-301 → `stopAllWorkers` :292 → `writeDaemonStatus` workerRegistry.ts:144-170), so `daemon-status.json` can keep listing sessions as running — OCC's version of the entry's second symptom; fix folded into the entry-43 port.

## 56 — ALREADY-ALIGNED: exit force-killing background commands (official: 1.5s after stop request; fullscreen leak)

**Official (binary):** print wind-down strings @112214448-112214668 (v300): `print wind-down: killing background shell `, `print wind-down: killing mid-delivery observer `, `print wind-down: killing background  task `, `") at the wait ceiling`, `print wind-down: no longer waiting on background ` — present 2/2 in **both** versions → the v300 change is timing/code-level. Exit-control struct fields @103237428: `idleExitAfterMs`, `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`, `forceKill`. The exact 1.5s constant is runtime-interpolated, not cleanly recoverable from strings (low-offset `1.5` hits are compressed/native blobs) — noted, not invented; irrelevant to the disposition since OCC meets the *outcome* (bg commands never survive exit, fullscreen included).

**OCC evidence:** no grace window at all — `src/utils/ShellCommand.ts:363-368` `#doKill` → immediate `treeKill(pid,'SIGKILL')`; registered as cleanup (`LocalShellTask.tsx:393-395`), executed unconditionally in `gracefulShutdown.ts:476` **after** alt-screen/terminal-mode restore (:465) — the fullscreen "left running" path doesn't exist; outer bounds: 2000ms race :482-491, failsafe :443-455, `forceExit` :555-556; `main.tsx:629-631` `process.on('exit')` only resets the cursor (no kill dependency).

**Why aligned (outcome parity, mechanism differs):** official = SIGTERM-ish wind-down → 1.5s → SIGKILL; OCC = immediate SIGKILL on exit. Both guarantee no background command outlives the session; OCC is strictly stronger. Optional future polish (not parity): a short SIGTERM grace before SIGKILL to let trapped commands clean up — defer.

## 58 — N-A: `claude gateway` stopping at start on an unusable `desktop:` policy key

**Official (binary):** managed-settings strings @111534900: `serve_to_desktop: false is ignored in a file that has a code: block…Remove it, or write every block under cli: (terminal Claude Code only)`; `desktop:` policy-block sites @105122103, @108471862, @111535225, @111540296.

**OCC surface absence:** no `gateway` command — `grep -n "'gateway'" src/main.tsx` → comment-only (:1524); `src/screens/ConsoleOAuthFlow.tsx:194` "OCC has no gateway surface"; no `serve_to_desktop`/`desktop:`/`code:` policy-block parsing anywhere in `src/` (grep 0 hits). Prior-round precedent: gateway entries consistently N-A.

## 61 — STAGED: background sessions resuming a carried workflow through Workflow tool approval

**Official (binary):** @101813906: "it hides its script, so what launched it starts it again"; "**a carried workflow runs again only through the Workflow tool**"; analytics `task_local_workflow`. The change: a background session that inherits ("carries") a workflow no longer runs it directly from the handoff file — resumption goes through the Workflow tool's approval flow.

**OCC evidence:** WorkflowTool is LIVE (WORKFLOW_SCRIPTS allowlisted): approval via `src/tools/WorkflowTool/WorkflowTool.ts:425` (`checkPermissions`→'ask') + `WorkflowPermissionRequest.tsx` (:97-104 onAcceptAlways TODO); `resumeFromRunId` schema :88-93, validation :623-679 (`/^wf_[a-z0-9-]{6,}$/`), journal `journal.ts:127/:146`; background execution = in-process promise + `~/.claude/wf-progress/<runId>.json` (:105, :720-739, :811, :869). The daemon worker path exists but is DEAD: `src/daemon/workflowWorker.ts` `CLAUDE_WORKFLOW_RESUME_FROM` :39/:264, journal :344, `invocation_mode` :289 (DAEMON flow not allowlisted). **No handoff-file mechanism exists in OCC** — the thing official stopped doing, OCC never did; the thing official now does (carried-workflow resume through approval) maps onto OCC's dead daemon-resume env path.

**Why STAGED:** deciding the OCC shape requires the official carried-workflow detection flow (how a background session learns it carries a workflow; the handoff file's name/format; the approval prompt copy) — not recoverable from the strings dumped this round.

**Next-round probe:** grep v300 for `handoff` / `carried` near @101813906 and dump the surrounding module; recover the resume-detection + approval copy; then decide between (a) wiring `CLAUDE_WORKFLOW_RESUME_FROM` into WorkflowTool's `resumeFromRunId` behind the standard approval (matching official intent), or (b) leaving the daemon worker dead and recording the divergence until DAEMON is enabled.

## 65 — PORT: `updatedInput` from PreToolUse/PermissionRequest not validated like Claude's own input

**Official (binary):** @107966073: "…input schema. The tool input from the model was valid."; `The tool input from the model was valid` 1→5 (+4 sites = v300 extends validation from PermissionRequest to PreToolUse); `updatedInput` 134→145; deny message "InputValidationError: permission handler updatedInput failed schema for [tool]"; analytics `permission_updated_input_invalid`, `tool_permission_updated_input_invalid`, `PERMISSION_UPDATED_INPUT`; "Permission handler updatedInput for %". Target semantics (changelog + strings): hook-returned `updatedInput` is re-parsed against the tool's input schema — **unknown keys dropped** (parse `.data`), **schema-invalid input denies the call** with an InputValidationError explaining the model's own input was valid.

**OCC evidence:** `updatedInput` typed as raw record (`src/types/hooks.ts:82/:158` `z.record(z.string(), z.unknown()).optional()`); extracted at `src/utils/hooks.ts:1596-1598/:1663-1668`, yielded :4784-4812; consumed **raw** at `src/utils/toolHooks.ts:435`, `src/utils/permissions.ts:492`, `src/utils/toolExecution.ts:949/:1054/:1273-1275` → `tool.call` :1361-1362. The model's own input IS validated (toolExecution.ts:694 `tool.inputSchema.safeParse(parseInput)`, :707 deny, :871 `processedInput=parsedInput.data`) — but hook rewrites bypass that entirely: unknown keys reach the tool, invalid input reaches `tool.call`.

**Sketch:**
- Add one helper (DRY) near toolExecution.ts:1273: `revalidateUpdatedInput(tool, updatedInput)` → `const r = tool.inputSchema.safeParse(updatedInput)`; success → return `r.data` (drops unknown keys); failure → deny the call with `InputValidationError: permission handler updatedInput failed schema for ${tool.name}: <zod issues>. The tool input from the model was valid.` + log `tool_permission_updated_input_invalid` / `permission_updated_input_invalid` (PreToolUse vs PermissionRequest origin) via the analytics stub.
- Route all consume sites through it: toolHooks.ts:435, permissions.ts:492, toolExecution.ts:949/:1054/:1273-1275 (single choke point before `tool.call` :1361-1362 preferred).
- Test (unit, AAA): PreToolUse hook returning `{...valid, extraKey:1}` → tool.call receives input without `extraKey`; hook returning type-invalid value → call denied, message matches, analytics key logged; PermissionRequest variant same; valid passthrough unchanged. e2e: settings PreToolUse hook on Bash injecting an unknown key; assert executed command input is clean.

## 66 — PORT (dormant parity): `remote-control --sandbox/--no-sandbox` removal

**Official (binary):** NEW string (299=0, 300=2) @109346400: `To sandbox sessions, set sandbox.enabled to true in settings.` — sits in the Remote Control error region; passing either flag now exits with an unknown-argument-style error carrying this hint. (`--sandbox` byte-offsets shift between versions but both retain 4 occurrences — main-CLI sandbox surfaces elsewhere; the RC parseArgs change is evidenced by the new hint string.)

**OCC surface check (per brief):** remote-control is `feature('BRIDGE_MODE')`-gated — `src/main.tsx:5030-5042` (hidden, no options), `src/cli.tsx:164-213` fast-path → `bridgeMain`; daemon variant main.tsx:4744-4747 behind `feature('DAEMON')`; BRIDGE_MODE is **not** on the allowlist → dormant. But the code is real: `src/daemon/remoteControlClient.ts:74-206` (HTTP-over-unix-socket RC client, no sandbox flags there) and `src/bridge/bridgeMain.ts:1866-1889` parseArgs **still accepts `--sandbox`/`--no-sandbox`**, threading `CLAUDE_CODE_FORCE_SANDBOX:'1'` into `sessionRunner.ts:312`; unknown-arg error exists :1951-1953; printHelp :2018-2085 already omits the flags.

**Sketch:**
- bridgeMain.ts:1866-1889: delete the `--sandbox`/`--no-sandbox` branches → both fall through to the `Unknown argument:` error (:1951-1953); when the rejected arg is one of these two, append the official hint `To sandbox sessions, set sandbox.enabled to true in settings.`
- Remove the `CLAUDE_CODE_FORCE_SANDBOX` threading at sessionRunner.ts:312 if no other consumer (grep first); keep `/sandbox` command surfaces untouched (different feature).
- Priority: low (BRIDGE_MODE dormant) — bundle with the next bridge touch; keeps future re-enablement aligned.
- Test (unit): `parseArgs(['--sandbox'])` / `(['--no-sandbox'])` → error message contains hint; known flags still parse; e2e skipped (feature-flagged off) but flag the test for when BRIDGE_MODE lands.

---

### Cross-entry notes for the implementation phase

- Entries 29 + 33 share one code path (`worktree.ts` base resolution → `git worktree add` start-point): implement together — thread `fromCwd`, resolve SHAs, pass `${sha}^{commit}`.
- Entry 24's fix (plugin hooks loaded before worktree setup) is a prerequisite for hook-based worktree e2e tests.
- Entry 43's displaceHolder result object should carry enough state to also fix the entry-44 caveat (daemon-status.json refresh after forced displacement).
- Entries 41 + 65 touch tool-facing text/validation with analytics-stub logging; follow existing OCC analytics no-op conventions.
- Entry 28's retry must not double-run non-idempotent hook side effects beyond official behavior (official re-runs the *whole* agent hook once; match exactly).
