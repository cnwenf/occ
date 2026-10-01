# Upstream Gap Ledger — OCC-102 round (official 2.1.284 → 2.1.285)

Date: 2026-10-01 · Issue: OCC-102 · Prior ledger: `upstream-version-gap-occ101-2026-09.md`

## §1 Version facts

| | v2.1.284 (prev) | v2.1.285 (target) |
|---|---|---|
| npm tarball | `@anthropic-ai/claude-code-linux-x64@2.1.284` | `@anthropic-ai/claude-code-linux-x64@2.1.285` |
| ELF size | 243,059,896 B | 240,327,864 B (−2.7 MB) |
| md5 | `16a758ebef6694e279a10ff618ace012` (≡ OCC-101 baseline — chain of custody verified) | `95fadb74aa30d5ac4ea77495d47bc071` |
| sha256 | `5cd90aab…` | `33dad1ec…` |
| `strings -n 8` unique | 303,459 | 301,200 |
| changelog bullets | — | **136** (file lines 3–138) |

Strings delta: **+19,639 new / −21,898 removed**. Net shrink consistent with the −2.7 MB binary-size drop (dead-code / dictionary churn).

## §2 Method

Per `upstream-tracking` skill: `npm pack` both linux-x64 tarballs → `strings -n 8` → `sort -u` → `comm` for the delta sets → targeted exact-token hit counting (`grep -aocF -e`) → byte-offset forensics (`grep -aobF -e "TOKEN"` → offset → `dd bs=1 skip=N count=M | tr -d '\0'`). JS code region lives at offsets > 150 M; string-table/dictionary region < 105 M. **Official binaries were never executed**; all artifacts under `/tmp/cc-diff-285/` removed at round end.

Token hit counts (v284 → v285) confirming the six "Added" changelog entries are real binary deltas:

| Token | v284 | v285 | Changelog item |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_WEB_FETCH` | 0 | 9 | #1 |
| `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` | 0 | 3 | #6 |
| `allowedProviders` | 0 | 93 | #5 |
| `values-stdin` | 0 | 8 | #3 |
| `plugin configure` | 5 | 29 | #3 |
| `--desktop` | 0 | 37 | #2 |
| `anthropic/alwaysLoad` | 4 | 10 | #84 |
| `GIT_SSH` | 57 | 69 | #8 |
| `core.sshCommand` | 7 | 12 | #8 |
| `ANTHROPIC_AUTH_TOKEN` | 63 | 69 | #28 |
| `"System tasks"` | 0 | 2 | #96 |
| `stopped after reaching its background time limit` | 0 | 1 | #85 |
| `backgroundDeadlineDisabled` | 0 | 3 | #85 |
| `task_local_shell_background_deadline` | 0 | 0 (v284) | #85 — absent in v284, present v285 |
| `%40` | 23 | 41 | #14 |
| `maxTurns` | 70 | 107 | #54 |
| `trace2` | 2 | 0 | #62 (official removed detection) |

## §3 Changelog triage (136 entries, original order)

Buckets: **A** = settings/policy/auth (agent A), **B** = env-gates/API-client (agent B), **C** = sandbox/redaction/hooks/BashTool (agent C), **D** = runAgent/subagent/memory (agent D), **E** = MCP+plugins+git-URL (agent E), **HIGH/MED/LOW** = unassigned candidates ranked, **NO-OP** = no OCC surface (honest, per-item reason).

Final per-item verdicts (PORTED / STAGED / NO-OP with rationale + byte evidence) are recorded in §5 after the implementation agents report.

| # | Entry (abridged) | Bucket |
|---|---|---|
| 1 | Added `CLAUDE_CODE_DISABLE_WEB_FETCH` env var | B |
| 2 | Added `claude --desktop` to open desktop app | NO-OP — no `--desktop` flag, no Claude Desktop surface |
| 3 | Added `claude plugin configure` / `--values-stdin` | E |
| 4 | `plugin install --config <server>.<key>=<value>` | E |
| 5 | Added `allowedProviders` managed setting | A |
| 6 | Added `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` | B |
| 7 | `claude -p` FORK_SUBAGENT child runs in foreground | D |
| 8 | Plugin/marketplace SSH honors GIT_SSH/core.sshCommand | E |
| 9 | OS denies managed-settings read → warn+start | A |
| 10 | Cloud sessions post-compaction artifact update refused | NO-OP — no Cloud sessions surface |
| 11 | `plugin disable/enable` name@marketplace letter-case | E |
| 12 | Remote Control attachment download retried twice | NO-OP — RC file relay is cloud backend |
| 13 | `set_model` leaves old output-limit/auto-compact window | MED |
| 14 | Redacted logs/transcripts leak URL password w/ `@`/`%40` | C |
| 15 | SSH passphrase/new-host prompts from worktree/teleport | E |
| 16 | Mid-session MCP server switch-off leaves tools (SDK/-p) | MED |
| 17 | `-p --permission-prompt-tool` bg subagent auto-denied | D |
| 18 | mcp list/get/remove/login/logout escape-seq sanitization | E |
| 19 | Sandbox auto-allow prompts on inline scripts w/ `=` | LOW |
| 20 | Fork subagents keep plan/dontAsk permission mode | D |
| 21 | `remote-control --help` --[no-]chrome default text | NO-OP — no `remote-control` CLI |
| 22 | Auto-mode bg subagents prompt redundant second reply | D |
| 23 | Cloud session creation only newest 20 envs | NO-OP — no cloud-environments backend |
| 24 | Remote Control read-marking + queued message on quit | NO-OP — cloud data plane |
| 25 | Plugin install id-collision (`. - @` caps) refused | E |
| 26 | Hooks/SDK permission callbacks stale plan on ExitPlanMode | MED |
| 27 | Cloud first reply tens-of-ms late | NO-OP — cloud latency |
| 28 | ANTHROPIC_AUTH_TOKEN sessions never load org policy | A |
| 29 | Workflow `agent()`/`parallel()` unhandled rejection | MED |
| 30 | Sync hooks hang on bg process holding output open | C |
| 31 | WebFetch rate-limited domain reported as policy block | LOW |
| 32 | Fullscreen ctrl+o transcript freeze on 100s of reads | MED |
| 33 | Bedrock mid-stream timeout/svc-unavailable raw JSON | LOW |
| 34 | /autofix-pr //schedule GitHub App "not installed" msg | NO-OP — no GitHub App backend |
| 35 | /artifacts row dismiss (x) unlinks file | NO-OP — no `/artifacts` |
| 36 | Artifact publish after rewind overwrites newer content | NO-OP — no Artifact tool |
| 37 | `Artifact` allow rule publishes outside workdirs | NO-OP — no Artifact tool |
| 38 | /cost + SDK modelUsage wrong model on refusal fallback | MED |
| 39 | Artifact publish overwrites source w/o re-read | NO-OP — no Artifact tool |
| 40 | Auto mode skipped classifier for Artifact uploads | NO-OP — no Artifact tool |
| 41 | /ultrareview misleading "core.worktree is set" error | NO-OP — no upload backend |
| 42 | /ultrareview worktree core.longpaths upload fail | NO-OP — no upload backend |
| 43 | Artifact publish false conflict after retry | NO-OP — no Artifact tool |
| 44 | /ultrareview uploads `server:8443.key` credential files | NO-OP — no upload backend |
| 45 | Auth failure: two sessions recover crashed refresh lock | MED |
| 46 | PowerShell perm check skips deny/ask on parser failure | C |
| 47 | /ultrareview slow uploads + credential-mark check gaps | NO-OP — no upload backend |
| 48 | Cancelled shell/hook still starts during setup | C |
| 49 | Vim x/r breaks pasted-text placeholder after Ctrl+G | MED |
| 50 | Output-content-filter response retried for minutes | B |
| 51 | Plugins silently skip unconfigured `.mcpb` server | E |
| 52 | Compaction marker/loop wakeup malformed fields crash | MED |
| 53 | WSL: /ultrareview colon/dot/space filenames refused | NO-OP — WSL-only + no upload backend |
| 54 | RESUME_INTERRUPTED_TURN re-runs turn ended at max-turns | **HIGH** |
| 55 | Sign-in waits forever after browser success | LOW |
| 56 | Windows: /ultrareview home-rooted linked worktree | NO-OP — Windows-only + no backend |
| 57 | Cloud uploads folder reported missing | NO-OP — no cloud sessions |
| 58 | `claude agents` reply approves pending permission prompt | D |
| 59 | attach/logs/stop/respawn/rm options-before-prompt parse | MED — OCC-specific daemon parser |
| 60 | `mcp list` omits WebSocket (ws) servers | E |
| 61 | `mcp get` no Type/Command/Args when `type` omitted | E |
| 62 | settings.local.json held back outside git w/ trace2 | MED — verify OCC immunity (zero trace2 refs) |
| 63 | /claude-api eval runner symlink/hardlink write-through | NO-OP — eval runner absent (6 KB stub) |
| 64 | /claude-api eval runner max_tokens truncation counting | NO-OP — eval runner absent |
| 65 | `&nbsp;` shows as literal text in terminal | MED |
| 66 | Brief freeze in long sessions after /clear or /compact | MED |
| 67 | Approved Edit to device file (→ /dev/null) never applies | MED |
| 68 | 21-retry: non-streaming fallback shares retry budget | B |
| 69 | Chrome native host reports computer name | NO-OP — no Claude in Chrome |
| 70 | Bedrock/Vertex fall back to older same-tier model | LOW |
| 71 | Plugin marketplace errors name why git addr refused | LOW |
| 72 | Improved git URL validation (plugins/mktplace/remote) | E |
| 73 | Artifact results suggest publish in same step | NO-OP — no Artifact tool |
| 74 | RC /btw sees turn in progress | NO-OP — RC backend absent; documented OCC limit |
| 75 | BMP/HEIC/HEIF/AVIF/TIFF picture previews | LOW |
| 76 | Auto-mode subagent ends as soon as report handed back | D |
| 77 | Bedrock/Vertex model-access check cached up to a day | LOW |
| 78 | Artifact publish results use fewer tokens | NO-OP — no Artifact tool |
| 79 | SDK liveness: ping every 30 s on non-streaming fallback | LOW |
| 80 | /resume on bg session opens it instead of refusing | MED |
| 81 | Per-turn perf w/ many deny rules + MCP tools | MED |
| 82 | Responsiveness leaving ctrl+o view (fullscreen off) | MED |
| 83 | Bedrock/Vertex/Mantle startup checks send same headers | LOW |
| 84 | MCP `_meta['anthropic/alwaysLoad']`=false stays deferred | E |
| 85 | Background Bash/PowerShell stop after time limit | **HIGH** |
| 86 | Code Review PRs //ultrareview under disableWorkflows | LOW — partial surface only |
| 87 | Custom ANTHROPIC_BASE_URL uses 1M context window | MED |
| 88 | Team/Enterprise withhold WebFetch until policy loads | MED |
| 89 | /memory Auto-memory can't be enabled from bg session | D |
| 90 | Auto-mode default offer also on 3P + telemetry off | MED |
| 91 | -p/SDK default to auto mode on 3P/telemetry off | MED |
| 92 | Bedrock/Mantle/CPonAWS port in SigV4-signed Host | LOW |
| 93 | MCP name `widgets` reserved (+ close spellings) | LOW |
| 94 | /ultrareview leaves symbolic refs out of upload | NO-OP — upload backend absent |
| 95 | Windows: project/local env no longer sets ALLUSERSPROFILE | NO-OP — Windows-only env semantics |
| 96 | /tasks folds self-run bg work under "System tasks" row | **HIGH** |
| 97 | /ultrareview requires git 2.31+ | NO-OP — upload-path gate |
| 98 | /ultrareview partial clone → working-tree snapshot | NO-OP — upload mechanics |
| 99 | /ultrareview refuses incomplete partial clone on old git | NO-OP — upload mechanics |
| 100 | Bedrock/Vertex/Mantle checks identify as Claude Code | LOW |
| 101 | `mcp get` hides plugin stdio command/args/env values | E |
| 102 | /claude-api no longer runnable from Remote Control | NO-OP — no RC client surface |
| 103 | /config chrome=true redirects to /config panel | LOW — no `chrome` setting in OCC ConfigTool |
| 104 | Sandbox: project settings can't widen admin sandbox | C |
| 105–130 | [VSCode] × 26 entries | NO-OP — VSCode extension surface absent (each individually, same reason) |
| 131 | [Cloud] Run now on routine internal error text | NO-OP — cloud routines absent |
| 132 | [Cloud] MCP_DISCOVERY_CACHE=1 env semantics | NO-OP — cloud-env handling absent |
| 133 | [Claude Tag] DMs for Enterprise Standard/UB Chat seats | NO-OP — Claude Tag product absent |
| 134 | [Claude Tag] Default model admin setting offers bad models | NO-OP — Claude Tag product absent |
| 135 | [Claude Tag] fallback-model note lost on message edit | NO-OP — Claude Tag product absent |
| 136 | [Code Review] org menu pagination in Add-a-repo dialog | NO-OP — Code Review web product absent |
| — | [Code Review] check run says when REVIEW.md not applied | NO-OP — check-run backend absent |

Count check: ASSIGNED A3+B4+C5+D6+E14 = **32**, NO-OP **41**, CANDIDATE **63** (HIGH 3 / MED 24 / LOW 36). 32+41+63 = **136** ✓

## §4 Byte-level forensics for the three HIGH candidates

### #85 — background Bash/PowerShell deadline reap (real v284→v285 delta)

v284 timeout region (@203395252) recovered in full: contains only `mAe`/`gAe` (BASH_DEFAULT/MAX_TIMEOUT_MS getters) + `iln` auto-background clamp — **no** `d5e`, **no** `Zee()`/`VTo()`, and 0 hits for `background time limit`, `task_local_shell_background_deadline`, `background deadline`, `backgroundDeadlineDisabled`.

v285 adds (@201230700 constants region):

```js
var Me=120000,Ne=600000;                       // default/max bash timeout
var d5e=1800000;                               // bg deadline default: 30 min
function Zee(){return Math.min(Math.max(7200000,nhe()),2147483647)} // cap: max(2h, BASH_MAX_TIMEOUT_MS)
function VTo(e){return Math.max(d5e,the(e))}   // default deadline = max(30m, BASH_DEFAULT_TIMEOUT_MS)
```

Gate + calculator (@202100424):

```js
function Nan(){return!LH().backgroundDeadlineDisabled}
function gHr(){return Nan()&&x("tengu_cosmic_shore",!0)}        // growthbook flag, default TRUE
function c2n(e){if(!gHr())return;return Math.min(e??VTo(),Zee())}
function $an(){return Nan()?`Set to true to run this command in the background. With it, \`timeout\` limits how long the command may run in the background before it is stopped (default ${d5e} ms, max ${Zee()} ms).`:"Set to true to run this command in the background."}
function Fan(){return Nan()?` With \`run_in_background\` the timeout is instead how long the command may run in the background (default ${d5e}ms / ${d5e/60000} minutes, max ${Zee()}ms / ${Zee()/3600000} hours); at that limit it is stopped and you are notified.`:""}
```

`backgroundDeadlineDisabled` is a session capability on the AsyncLocalStorage host-context class (@199796627, `ZKn{#o backgroundTasksDisabled;#s unsandboxedCommandsDisabled;#e backgroundDeadlineDisabled}` + `disableBackgroundDeadline()`).

Kill wiring (@206793000 region, LocalShellTask runner):

```js
// arming: B=c2n(S); K=B===void 0?void 0:setTimeout(Ncr,B,w,B,F); K?.unref()
function Ncr(e,n,r){try{if(!gHr())return;let s=e.taskRegistry.get(e.taskId);
  if(!op(s)||s.status!=="running"||s.notified||s.shellCommand?.status!=="backgrounded")return;
  r.cause="deadline",prn(e,"deadline"),y("task_local_shell_background_deadline"),
  t(`LocalShellTask ${e.taskId}: stopped at its ${n}ms background deadline`)}
 catch(s){m("task_local_shell_background_deadline","threw"),t(`LocalShellTask ${e.taskId}: stop at the background deadline failed`),u(s)}}
```

Message maps (@203048405):

```js
var X9={memory_pressure:"stopped because the system is running low on memory",
        deadline:"stopped after reaching its background time limit"},
    Q9={memory_pressure:"This is not a failure of the command. …CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1…",
        deadline:"If the work in progress still needs it, start it again with `run_in_background` and a longer `timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report that it was stopped."};
```

Notification: summary `Background command "<desc>" was stopped after reaching its background time limit` (killed branch of `e2e`), body wrapped in `<note>…Q9.deadline…</note>` inside `<task-notification>` (`tIt`), snapshot status `cancelled` (`UL`). `prn` also updates registry `terminal:{summary,output_file}` then cleans up via `oL`.

Full arming function `mrn` (@206798147) + call sites recovered later in the round:

```js
// mrn(e,n,r,s,g,h,S): _x(h,`bash:${e}`,r) keepalive registration; F={} cause holder;
//   B=c2n(S); K=B===void 0?void 0:setTimeout(Ncr,B,w,B,F); K?.unref()
//   process.on("memoryPressure") pressure-reap gated on
//     !ke()&&!a.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP   (staged — no OCC producer)
//   returns release: (ye)=>{clearTimeout(K),
//     i("tengu_background_shell_settled",{elapsed_ms,requested_timeout_ms:S??0,
//       deadline_ms:B??0,outcome:F.cause?"killed":ye,stop_cause:F.cause,
//       subagent_owned:h!==void 0}), keepalive release WC}
// spawn call site mke @206800243:
//   be=w!=="monitor"?mrn(he,s,B,h,w,S,M):void 0   // monitor excluded; M = raw requested timeout; armed BEFORE g.background(he)
// foreground→background Utn @206802961:
//   F=mrn(e,r,s,g,void 0,w)                       // timeout AND kind undefined → 30-min default
```

`prn(e,n)` ordering: `t2e({...e,status:"killed",exitCode:void 0,stopCause:n})` claims `notified` (lq), builds the X9 summary, updates the terminal snapshot, enqueues the `tIt` notification, finally `oL` cleanup — **notify BEFORE kill**. `tIt` body: `` `${w?`\n<${xj}>${Wt(Q9[w])}</${xj}>`:""}${M??""}` `` with `xj="note"` (@195567729).

OCC gap: `LocalShellTask/` + `run_in_background` schema exist; only memory_pressure reap exists — **no deadline path**. PORTED this round (see §5).

### #96 — /tasks "System tasks" fold row

v285 @223887119 (0→2 hits `"System tasks"`):

```js
var aLe=16,g1="System tasks";
function hF(h){if(h==="mcp_task")return yF!==null;return h!=="monitor_ws"&&h!=="self_managed_tasks"}
// row render for folded kind: {label:Yg.label,meta:[`${Yg.size} hidden`]}
// + cM(h) local_agent eviction check
```

OCC has `/tasks` + overlapping kind tokens in `src/Task.ts`, but the fold predicate `hF` keys on `monitor_ws` / `self_managed_tasks` / `mcp_task` whose OCC producers differ (OCC's MonitorTool does not register `monitor_ws` tasks; no `self_managed_tasks` surface), and the fold row render + `cM` local_agent eviction check need per-site decompilation of the /tasks panel. **Verdict: STAGED** (an early "near drop-in" reading was disproved on re-check — porting the predicate without matching producers would fold rows that never exist).

### #54 — RESUME_INTERRUPTED_TURN × max-turns

`maxTurns` 70→107 hits (+37, largest clean count jump). OCC already wires the env (`cli/print.ts`, `conversationRecovery.ts`, `envTruthy221.test.ts`) — the official fix stops a resumed session from re-running a turn that ended at max-turns.

## §5 Implementation results (per agent, filled as they report)

### Lead (OCC 程序员) — #54 + #85

**#54 — RESUME_INTERRUPTED_TURN × max-turns exit-commit: PORTED.**
Official subsystem: `exitCommit` state (`eo`/`ane` @221287457 `stampMaxTurnsExitCommitted`, GP stamp site), QueryEngine `case 'attachment'` wiring, and the `conversationRecovery` classifier (`V4o` M-scan for `exitCommitted===!1` + `!n` gate; `oHe` maps `ended_at_max_turns`→`none`). OCC port: `src/utils/exitCommit.ts` (new), `src/utils/gracefulShutdown.ts` + `src/utils/attachments.ts` (`stampMaxTurnsExitCommitted` on the max-turns tail), `src/QueryEngine.ts` (attachment-case stamping), `src/utils/conversationRecovery.ts` (`hasUncommittedMaxTurnsTail` + `ended_at_max_turns`→`none` mapping so a resumed session does not re-run a turn that already ended at max-turns). Tests: `src/utils/__tests__/maxTurnsExitCommitted285.test.ts` — 10/10 pass; regressions green.

**#85 — background shell deadline reap: PORTED** (full §4 evidence).
- `src/tasks/LocalShellTask/backgroundDeadline.ts` (new): `c2n`/`Zee`/`VTo`/`d5e` math (`computeBackgroundDeadlineMs`, `backgroundDeadlineCapMs`, `backgroundDeadlineFloorMs`, `BACKGROUND_DEADLINE_DEFAULT_MS=1_800_000`), `Nan`/`gHr` gates (`setBackgroundDeadlineDisabled` module flag — documented divergence: OCC has no ALS host-context class, so the SDK/Cloud capability becomes a module-level switch; GrowthBook `tengu_cosmic_shore` default-TRUE folds to the capability check), X9/Q9 tables verbatim, `$an` `runInBackgroundDescription()` + `Fan` `backgroundTimeoutUsageNote()`.
- `src/constants/xml.ts`: `NOTE_TAG='note'` (official `xj` @195567729).
- `src/tasks/LocalShellTask/guards.ts`: `stopCause?: ShellStopCause` on the task snapshot (official `t2e({...stopCause:n})`).
- `src/tasks/LocalShellTask/killShellTasks.ts`: `killTask(..., stopCause?)` persists the cause (conditional spread — bare kills stay field-absent).
- `src/tasks/LocalShellTask/LocalShellTask.tsx`: `backgroundCommandSummary` killed branch renders X9 (official `e2e`); `enqueueShellNotification` appends `\n<note>Q9[cause]</note>` after `<summary>` (official `tIt`); NEW `stopBackgroundShellAtDeadline` (`Ncr` port: gate re-check, eligibility re-check inside an atomic `updateTaskState` identity pass — running + !notified + shellCommand.status==='backgrounded' — cause holder, **notify-before-kill** per `prn`, `task_local_shell_background_deadline` analytics, debug log, throw→logError); NEW `armBackgroundDeadline` (`mrn` port: monitor excluded, `computeBackgroundDeadlineMs(timeout)` → `setTimeout(...).unref()`, release closure clears the timer and logs `tengu_background_shell_settled` with `elapsed_ms/requested_timeout_ms/deadline_ms/outcome/stop_cause/subagent_owned`). Armed at all three OCC background transitions, matching official call sites: `spawnShellTask` (≡`mke` — raw requested `timeout`, armed BEFORE `shellCommand.background()`), `backgroundTask` foreground→background (≡`Utn` — timeout undefined → 30-min default), `backgroundExistingForegroundTask` (Ctrl+B path — same `Utn` semantics).
- `src/tools/BashTool/BashTool.tsx`: `run_in_background` schema `.describe(runInBackgroundDescription())`; `spawnBackgroundTask` passes the **raw** `timeout` (not the foreground-clamped `timeoutMs`) — per `$an`, background `timeout` means lifetime.
- `src/tools/BashTool/prompt.ts`: `getBackgroundUsageNote()` ends with `backgroundTimeoutUsageNote()` (official `smt()` shape).
- Documented NO-OP/STAGED sub-pieces: `_x`/`WC` bash-task keepalive registration (no OCC keepalive subsystem); `process.on("memoryPressure")` pressure-reap (no OCC producer; X9/Q9 `memory_pressure` entries ported verbatim but producer-less, staged with the official subsystem); snapshot status `cancelled` (`UL`) — OCC task snapshots have no `cancelled` status; the observable killed-summary + notification contract is byte-equivalent.
- Tests: `src/tasks/LocalShellTask/__tests__/backgroundDeadline285.test.ts` — 17/17 pass (pure `c2n`/`Zee`/`VTo` math incl. env-raise cases, `$an`/`Fan` enabled+disabled branches, X9/Q9 verbatim tables, `backgroundCommandSummary` X9 rendering, `killTask` stopCause persistence, and three REAL-process BashTool wiring tests: 400ms-deadline reap on `sleep 30` with single `<status>killed</status>` + X9 summary + `<note>`Q9 notification, settle-release on a fast `echo`, disabled-capability no-reap). Mutation self-verification: (a) dropping the BashTool raw-timeout pass-through → 1 fail; (b) ignoring `requestedTimeoutMs` in `c2n` → 4 fail; (d) dropping the killTask stopCause spread → 2 fail; all mutants killed, file restored green. Regression: `src/tasks/LocalShellTask/` + `src/tools/BashTool/` = 800 pass / 0 fail; biome lint clean on all 8 touched files.

### Agent C — sandbox trusted-tier grants (security): PORTED

**2.1.285 security fix — "sandbox letting project/local settings re-open denied
filesystem read paths / widen the network allowlist": PORTED** (whole subsystem
NEW in v285 — v284 ELF has ZERO hits for `grants restricted to trusted`,
`droppedRepoFilesystemGrantsLogged`, `droppedRepoAllowedDomainsLogged`).

- Byte evidence (official linux-x64 v285 ELF, sandbox JS region ~200.58M–200.68M):
  jm builder setup @200623566 (`_=Ua()` mandate, `T=zm()` strictAllowlist,
  `A=_||T` network gate, `N=_||FB()` fs read-deny gate, `D=N?MB():nS()` baseline,
  `Be=Hm(X)` untrusted, `et=_&&Be` wholesale drop); jm fs loop @200632000+
  (Ic/Rc/Nc counters + one-shot log); jm network else-branch (`A?Uf(...):merged`,
  `A?OO():n.allow`, droppedRepoAllowedDomainsLogged); dB network allowances
  @200608500+ (`ate()` gate, `_ee`/`zO` field lists, `n?kO:wE` proxy-port getter,
  `Km` false-sticky booleans, three log templates); getters @200583000+
  (`Am`/`Uf`/`OO`/`kO`/`wE`/`Lf`/`_c`); matcher chain (`Gm`/`GB`/`S5e`/`jat`/`VE`/
  `Go`/`$Le`/`jee`/`Mo`/`Tu`/`Wm`/`Vo`/`VB`/`rte`/`bB` @200606029–200676791).
  Verbatim extraction artifacts: /tmp/cc-diff-285/{builder285,sandbox-core285,
  sandbox-getters285,helpers285,dB-region285}.txt.
- `src/utils/sandbox/trustedTierGrants.ts` (NEW): full matcher chain + baselines +
  gates — `isGlobPattern`(Tu), `foldCase`(Mo, zero-width/bidi strip class Hjr
  built from escapes), `pathUnderOrEqual`(Go), `literalUnderOrEqual`($Le),
  `matchGlobCached`(VE, picomatch {dot,nocase}), `globBase`(Wm),
  `globAncestorMatch`(jat), `matchDenyToCandidate`(S5e), `realpathExistingPrefix`
  (rte), `realpathWithFallback`(bB), `realpathVariants`(VB), `resolveDenyPath`(Vo),
  `candidateUnderDeniedRead`(Gm), `isUntrustedSource`(Hm),
  `getTrustedSettingsSources`(Am), `hasTrustedReadDenyList`(FB),
  `hasTrustedNetworkDenyList`(ate deny leg), `getClaudeOwnReadDenyBaseline`(nS),
  `getTrustedReadDenyBaseline`(MB, resolvers injected by the adapter),
  `getTrustedAllowedDomains`(Uf leg), `getTrustedWebFetchAllowRules`(OO leg).
- `src/utils/sandbox/sandbox-adapter.ts`: (1) network allowedDomains else-branch
  gated on `restrictNetworkAllowlist = Ua||zm` — trusted-only domains + WebFetch
  `domain:` allow rules when open, deniedDomains ALWAYS merged, one-shot
  `droppedRepoAllowedDomainsLogged` count-log with the official
  `_?'admin sandbox mandate':'network.strictAllowlist'` label; (2) fs per-source
  loop — mandate drops untrusted Edit-allow+fs.allowWrite wholesale (Ic) and
  skips untrusted allowRead silently; otherwise every untrusted write/read
  candidate is screened against `D=N?MB():nS()` via Gm (Rc/Nc); deny rules from
  ANY tier always honored; `allowManagedReadPathsOnly` post-gate preserved;
  one-shot `droppedRepoFilesystemGrantsLogged` log with parts joined `" and "`;
  (3) NEW `computeTrustedNetworkAllowances` = full dB port — passthrough when no
  gate, `zO` proxy-port-only restriction under ate-without-mandate, `_ee`
  all-field restriction under mandate (Uf-dedup trusted sockets, Km false-sticky
  booleans), `kO` policy-only proxy ports under allowManagedDomainsOnly with its
  own verbatim log; wired into the returned `network` block; (4) three exported
  `_reset*ForTesting` latch resets.
- NOT ported (documented in module headers, no OCC surface — not guessed):
  `sandbox.credentials.files` mask/deny legs (no OCC setting); HKCU-backfilled
  policy untrusted case (OCC policySettings is always composed/trusted);
  `CLAUDE_CODE_EVAL_CONFINED` (`h`/`g(X)`) additionalDirectories+domain branches
  (no OCC confinement mode); `r.sessionAllowedHosts` runtime adds (no adapter
  field); `rte`'s `BR()` boundary guard (walking to root is safe — realpathSync
  only resolves existing prefixes); `allowMachLookup` (sandbox-runtime@0.0.44
  NetworkRestrictionConfig has no such field — dB still observable via the other
  five fields); official Xf/Zf/Z/De trusted/untrusted accumulator split + Va
  late-symlink re-screen subsystem (OCC keeps single accumulators +
  `reconcileClaudeSymlinks` — adaptation, deny-side covered).
- Behavior note: `allowManagedDomainsOnly:true` ⇒ mandate (Ua includes nte), so
  untrusted fs write grants drop wholesale under managed-domains-only —
  security-positive, matches the official gate composition.
- Tests: `src/utils/sandbox/__tests__/trustedTierGrants285.test.ts` (NEW, 32
  tests) — matcher-chain units (Tu/Mo/Go/$Le/Wm/jat/S5e/VB/rte/Vo/Gm),
  gate/baseline units (Hm/Am/FB/ate-leg/nS/MB/Uf/OO legs), adapter integration
  (A-gate trusted-only domains + one-shot label/latch, mandate Ic wholesale
  drop, silent untrusted-allowRead drop, Rc+Nc trusted-read-deny screening with
  trusted grants + deny rules unaffected, default nS() screening of
  `~/.claude`-bound untrusted writes, dB passthrough/ate-proxy-only/Uf sockets/
  Km false-sticky/kO managedOnly legs + all three verbatim log templates +
  latch re-arm). Harness: settingsCache seeding (ripgrep232 pattern) + debug.js
  mock with OCC-97 snapshot/restore hygiene. `bun test src/utils/sandbox` →
  80 pass / 0 fail (5 files). Biome lint clean on all three touched files.
- Full-suite attribution: pristine-HEAD (2.1.361) worktree control run → 71
  pre-existing full-suite failures (incl. the 9-test order-dependent
  `excludedCommandsScoping282` mock-leak — reproduces at HEAD without any of
  this round's changes); current tree 78 = 71 pre-existing + 7 new, all 7 in
  in-flight background-agent areas (frontend-design tip ×4, needs-auth ×2,
  policyLimits env-bearer ×1), none sandbox-related. A/B control (new test file
  removed) → byte-identical failure list, so the new suite adds no interference.

### Agent B — reliability/schema batch: PORTED (7 files + 5 tests)

WebFetchTool `isEnabled`, spawnUtils `TEAMMATE_ENV_VARS`, managedEnv `PROJECT_SCOPE_BLOCKED_ENV_KEYS`, withRetry `NONSTREAMING_TIMEOUT_RETRIES`, claude.ts `MAX_TIMER_MS` clamp, errorUtils `isOutputContentFilteredError`, errors.ts `output_content_filtered`. STAGED/NO-OP: b2r privacy set, `ire()`/`izo` gates, `Zt` CCR proxy, `Xn` budget display.

### Agent D — subagent/permission/memory batch: 3 PORTED (all security), 1 STAGED, 2 NO-OP

- **Item 1 — fork subagent permission-mode inheritance (SECURITY): PORTED** (1a+1b; 1c STAGED). Byte evidence: runAgent builder `else if(xe==="bubble"&&(E.mode==="plan"||E.mode==="dontAsk"))Ze=E.mode`; ExitPlanMode `validateInput` fork-refusal first branch (`agentType==="subagent"&&isBuiltIn===!0&&subagentName===bF&&(Wa()||mode==="plan") → {result:!1,errorCode:2}` + byte-exact message "A fork cannot exit plan mode; that belongs to the session that forked it. Finish your part and report back."). Files: `src/tools/AgentTool/runAgent.ts` (exported pure `resolveAgentEffectivePermissionMode()`; 2.1.223 bypass-policy gate preserved), `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`. 1c STAGED: official fork system-prompt sentence has no OCC insertion point (fork children reuse the parent's rendered prompt bytes) — enforcement lives in the ExitPlanMode refusal; not invented.
- **Item 2 — `-p` + `CLAUDE_CODE_FORK_SUBAGENT=1` foreground Agent call: NO-OP.** `FORK_SUBAGENT` not in the 6-flag allowlist → fork spawn path dead in production builds.
- **Item 3 — `-p --permission-prompt-tool` bg-subagent auto-deny fix (SECURITY): PORTED.** Byte evidence: shouldAvoidPrompts gained `Se=ke()&&QRt(cI())` (`ke()`=non-interactive, `cI()`=prompt-tool name, `QRt(e)=e!==undefined&&e!=="none"`); OCC had the auto-deny default → genuine port. Files: `src/bootstrap/state.ts` (new `permissionPromptToolName` state, mirrors `cI()`), `src/cli/print.ts` (stores the sdkUrl→stdio-mapped name), `src/tools/AgentTool/runAgent.ts` (`isPrintModeWithPermissionPromptTool()` + exported `resolveShouldAvoidPermissionPrompts()`).
- **Item 4 — /memory auto-memory background-session restriction (SECURITY): PORTED.** Byte evidence: `RUe` @197269069, `EAe` @199495213, toggle handlers `ht/wt/Mt` @232657400 gate ON only (silent), `OVt` @230478141. Files: new `src/utils/memory/autoMemorySessionGate.ts` (`isToolStartedSession`/`isAutoMemoryRaiseAllowed`/`AUTO_MEMORY_RAISE_DENIED_DETAIL` byte-exact), `src/components/memory/MemoryFileSelector.tsx` (ON refused when gate closed; OFF still works; row shows `off · <OVt>`). Corrections: prior-round note was wrong — `refused_session_kind` @199500531 belongs to `Qln` (ORG memory writes), not auto-memory. Documented divergence: OCC daemon workers set `CLAUDE_CODE_DAEMON_WORKER` (not `CLAUDE_CODE_SESSION_KIND`/`CLAUDECODE`), so the faithful gate does not block OCC daemon workers — flagged as an OCC-spawn policy decision.
- **Item 5 — auto-mode subagent redundant reply + early end: STAGED.** The report-ack subsystem (second-reply suppression, run-ends-on-handback) has no live OCC counterpart; no v284→v285 byte delta isolates onto an OCC surface.
- **Item 6 — `claude agents` reply approving pending prompt: NO-OP (surface absent).** `occ agents` handler is a read-only dashboard; daemon `promptQueue` has zero consumers; no route exists to approve a pending prompt.
- Tests: 24 new (forkPermissionMode285 + exitPlanModeFork285 + autoMemorySessionGate285) — 122 pass / 0 fail in the touched dirs; `src/cli` 80 pass; bootstrap/permissions/memory/memdir 306 pass; biome clean on all 9 files.

### Agent A — settings/policy batch: 3 PORTED (items #9, #28, #5), staged arms documented

- **Item #9 — OS-denied managed-settings read → warn+start (SECURITY): PORTED** (recorded above with byte evidence `G1t` @196303347 / classifier `WYn` @196726844 / gate `JL` @198654100; tests `managedReadDenial285.test.ts`).
- **Item #28 — `ANTHROPIC_AUTH_TOKEN` org-policy (SECURITY): PORTED** (recorded above; tests `authBearerFallback285.test.ts` window).
- **Item #5 — `allowedProviders` managed setting (0→93 binary hits v284→v285): PORTED.** The full official architecture, byte-extracted from v285 and encoded:
  - *Parse layer*: plain schema `Ni((i)=>Array.isArray(i)?i.filter(Eo):i,C(W(L9e))).optional().catch(void 0)` @196157937 (`C(W(·))` ≡ `z.array(z.enum(·))`) → `src/utils/settings/types.ts` (preprocess-filters unknown names on non-policy sources; official `.describe()` text verbatim). Strict policy parser `An` @196187263 + entry @196199750 (order gatewayInternalNetworks→forceLoginOrgUUID→allowedProviders) → `policyStrictSchema.ts`: `failClosedAllowlistSchema` gained `invalidEntryIsStatusOnly` (invalid entries become statusOnly warning records — never block startup via `Y6` — and are dropped; all-invalid → `[]` which fail-closes at enforcement as "allows no provider").
  - *Enforcement*: new `src/utils/settings/allowedProvidersEnforcement.ts` (~800 lines; header carries the full official offset table @198036300–198055000, `E` host topology @196623664, `Vg` @196628431, and the OCC symbol-mapping table): `Gye` machine∩slot effective list (machine tier = MDM + managed-file; HKCU excluded, matching official `sc()` zeroing user-writable bases), `Wf` descriptor + `qf` customEndpoint promotion, override detectors `$w`/`Gw`/`Ww`/`jw` over the `E` topology with `k` verdicts (unparsable/foreign/own/insecure), env pins `Yw`/`pl`/`Zf`/`zw` with identity-keyed caches, decision `MJ`, refusal messages `lk`/`Xw`(arms 1–7)/`Jw` byte-verbatim, fail-close throttle `Vf`/`bl` (60 s) + `yl`, gates `B$t` (throws `ProviderNotAllowedError`), `nmn` (auth-validity), `HYe`, `Yf` (remote settle — no-op), `Ie`→getAPIProvider (+`anthropic_aws`→`anthropicAws` fix-up), `N_e` mantle promotion (raw truthy `CLAUDE_CODE_USE_MANTLE`, byte-faithful).
  - *Gate wiring*: `nmn` inside `validateForceLoginOrg` at the official `JL` @198653600 position (load-failure gate → **nmn** → PROVIDER_MANAGED_BY_HOST → UNIX_SOCKET → org-pin) → `src/utils/auth.ts`; `B$t` in `getAnthropicClient` (official site @201969594 `Oe=sc(r);if(B$t(Oe),...)`) → `src/services/api/client.ts`; Files API `mje` @205945826 (third-party data-residency throw + `B$t("firstParty",e,"files")`) gating all three entries (downloadFile @205946511, uploadFile @205948400, listFilesCreatedAfter @205948696) → `src/services/api/filesApi.ts`. Official OAuth-token-client `B$t` site @201975863: evaluated — OCC's OAuth is fetch-based (`src/services/oauth/client.ts`, no SDK client construction); the login path is covered by the `nmn` gate → no surface, not ported.
  - *Documented divergences (all fail-closed or unreachable)*: (1) remote env pins are NEVER honored — official `Pb()` requires `sessionCache===verifiedPayload`, a state OCC's remote-settings cache cannot distinguish (served vs stale user-writable `remote-settings.json`), so `Pb`/`servedSnapshot`→false; strictly more restrictive; the remote allowedProviders LIST still narrows via the slot intersection. (2) gateway arm STAGED (`zye`/`Qr`/`Ww` stubs — OCC never resolves provider "gateway"). (3) WIF hook (`zf`) STAGED unset. (4) parent tier STAGED (schema key exists, no transport; `dzt`→null). (5) `settleRemotePolicy` STAGED (`sLo` unset — no-op await). (6) telemetry `rn("auth_force_login_org","provider_not_allowed")` STAGED (OCC analytics empty). (7) `ProviderNotAllowedError` keeps the name+message contract, not official base class `I`. (8) `mje` hipaa arm (`oc("hipaa")` → "File upload is disabled by your organization's policy.") NOT ported — polarity of `oc` unverified and it predates the 285 diff (observation: OCC's nearest surface is `isPolicyAllowed` in `src/services/policyLimits`; deferred, not guessed).
  - *Tests*: `allowedProviders285.test.ts` 34 pass / 0 fail (leaf vocabulary, plain-schema filter, strict statusOnly + all-invalid→`[]`, `Gye`, `MJ` not_listed/endpoint/empty-list/unrecognized-only arms, unix-socket arm 1, `qf` promotion, env-pin honored/unpinned, `N_e` mantle dual-descriptor, `k` verdicts, `nmn` incl. real-ELOOP fail-close surviving the `bl()` `jo()` re-read + OS-denied passthrough, `B$t` incl. files dispatch, `JL` ordering via `validateForceLoginOrg`). Mutation self-verification: killing the pin check → 3 fails; killing the schema filter → 1 fail; reverted → 34/0. Settings+API suites: 633 pass / 0 fail.

### Agent E — git/mcp/plugin batch: 11 PORTED (items 9–13 PORTED-core + STAGED-wiring), 0 NO-OP

- **Item 1 — git-URL validation + named refusals: PORTED.** New `src/utils/plugins/gitUrlValidation.ts`, wired into `marketplaceManager.ts` + `gitUrlNormalization.ts`; malformed/hostile marketplace & plugin URLs refused with the official named reason. Tests in the 378-green plugins run.
- **Item 2 — `GIT_SSH`/`core.sshCommand` honored for plugin+marketplace installs: PORTED.** New `gitSshCommand.ts` (`readEnv`+`resolveSshCommand`); credential helpers NOT stripped (per standing rule #049). Plugins suite 353→378 green.
- **Item 3 — worktree/`/teleport` fetch SSH fail-fast: PORTED (byte-recovered).** `D0` @204089380 (SSH_ASKPASS pins + `withoutControllingTerminal:!0`), `Xen` @204088534 (`/dev/tty` `O_RDWR|O_NOCTTY` probe), `Azo` @196470770 (Windows ssh-env), `Je` @196477428 (spawn wrapper `detached:!0` + group pid), `Oe` @196474487 (`process.kill(-pid,"SIGTERM")` group kill); token deltas v284→v285: `Azo(` 0→2, `withoutControllingTerminal` 0→3, `SSH_ASKPASS_REQUIRE` 4→6. New `gitFetchSshFailFast.ts` (`resolveFetchSshFailFast` + `canOpenControllingTerminal`, `CONFIG_READ_TIMEOUT_MS=5000`, hook-neutralizing args); `execFileNoThrow.ts` gained `withoutControllingTerminal` → `detached:true` + group-kill; both fetch sites in `worktree.ts` + `teleport.tsx` routed through it. Tests 9/0 (incl. live group-kill of a backgrounded `sleep` grandchild).
- **Items 4–8 — MCP batch: PORTED.** (4) tool-level `alwaysLoad:false` beats server-level (`client.ts` precedence formula); (5) `mcp get` hides plugin-scope stdio command/args/env (sanitized copy: command→type label, args→[], env→`[REDACTED]`) — **fully-ported/observable (E2E-001 fix, changelog #101)**: `mcpGetHandler` now resolves the name through `getAllMcpConfigs()` (the same full-scope set `mcp list` renders, incl. dynamic-scope plugin servers) instead of `getMcpConfigByName` (file-backed scopes only), which previously made the sanitize branch unreachable in real execution; verified by the real seeded-plugin test `mcpGetDynamicScope285.test.ts`; (6) type-field default inference widened to typeless stdio (`Die(i)&&Die(h)`); (7) `mcp list` ws rows `…: url (WS) - health` (marker v285-only @231389086); (8) output sanitization `Tn` (new `cliMessages.ts`) neutralizing line-breaks/ANSI in hostile names+values + not-found builders `iQn`/`u2t` (pre-existing `mcpRemoveAuthCache280.test.ts` assertion updated to new official wording). Tests: combined mcp+handlers 333/0.
- **Items 9–13 — plugin CLI batch: PORTED-core + STAGED-wiring.** `pluginConfigure.ts` (28 tests), `pluginInstallConfig.ts` (25), `pluginSettingsKeyResolution.ts` (10), `pluginFolderCollision.ts` (27), `mcpbNeedsConfig.ts` (12; log landed in `mcpPluginIntegration.ts`). Wiring STAGED: CLI-surface registration (`main.tsx` + `plugins.ts` handler + `pluginOperations.ts` + `plugin.ts` union variant) must move as one atomic set — piecemeal landing trips an exhaustive switch; flagged for next round, not half-wired.
- **Self-caught regression:** E's `mcpCliDisplay285.test.ts` initially leaked a `config.js` mock across files (Bun single-worker, OCC-97 class) breaking sibling `mcpRemoveAuthCache280`/`mcpSlice218` 331/2; redundant mock removed → 333/0.
- Suite totals: mcp+handlers 333/0, mcp 306/0, plugins 378/0, commands/plugin 24/0, item-3 consumers 37/0 + 139/0; biome clean.

## §6 Testing

### 6.1 Full suite (`bun test src/`, single worker, 510 files)

| Run | Commit | Pass | Fail | Notes |
|---|---|---|---|---|
| Pristine baseline | `08759e8` (origin/main) | 5819 | 71 | measured in a detached worktree before any round change |
| Final (this round) | `bc78387` + test-suite fixes below | **6276** | **67** | 1 skip, 15935 expect(), 6344 tests, 142.34s |

Normalized fail-name comm diff (baseline vs final, `sed`-stripped timings, `sort -u`): **zero new failures**; **4 pre-existing baseline failures FIXED** as a side effect of the mock-leak repair below:

- `2.1.233 — signalUnrecognizedModel > the signal fires at most once per model per process`
- `2.1.233 — signalUnrecognizedModel > unrecognized model in print mode writes the exact stderr line`
- `2.1.284 P3-4 site 2: query-path 404 assistant message > bedrock 404 message names the deployment + the sonnet5 fallback`
- `2.1.284 P3-4 site 2: query-path 404 assistant message > firstParty 404 falls to the generic message (no fallback row)`

The remaining 67 fails are all baseline-order-dependent single-worker pollution failures unrelated to this round (same normalized names minus the four above).

### 6.2 The one round-introduced full-suite failure — root cause + repair (resolved)

`envBearerFallback285.test.ts` (Agent A, new) passed isolated but saw `x-api-key: undefined` in the full suite. Causal chain, established empirically (runtime probe + systematic two-file bisect of every `mock.module('../../../bootstrap/state.js', …)` suspect — polluter hit-count: `mcpAuthStubTools274`=1, all others=0):

1. Pre-existing `mcpAuthStubTools274.test.ts` mocks `bootstrap/state.js` with `getIsNonInteractiveSession: () => flags.nonInteractive` (default `false`).
2. Its afterAll "restore" `mock.module(..., () => ({ ...actualState }))` is defeated: bun patches `actualState`'s **live bindings** when the mock installs, so the spread re-captures the mocked function and re-installs the leak (same mechanism documented in `otelHeadersFailureNotification275.test.ts`).
3. Leaked `getIsNonInteractiveSession() === false` → `preferThirdPartyAuthentication()` (`bootstrap/state.ts`) false → `getAnthropicApiKeyWithSource` skips the `preferThirdPartyAuthentication() && apiKeyEnv` early-return (`utils/auth.ts`) → victim tests starve.

Fix (two layers):

- **Source repair** — `mcpAuthStubTools274.test.ts` now uses the proven otel275 delegation pattern: capture the real `getIsNonInteractiveSession` **by value** before the mock installs; the mock delegates to the real function once `mockActive` flips false in afterAll (no re-spread of `state.js`). Bisect evidence: 25/1 → 26/0 with the victim; the other four module re-mocks in that file are untouched (out of scope).
- **Victim hardening** — `envBearerFallback285.test.ts` pins `setIsInteractive(false)` + `setClientType('cli')` in beforeEach through the same public setters main.tsx uses. Both values ARE the module defaults (`getInitialState`), so no restore is needed and pinning can only move STATE closer to pristine for later files. (It cannot use `resetStateForTests()`: that throws unless `NODE_ENV==='test'`, and this window deliberately runs `NODE_ENV=development` to bypass the CI env-credential guard.)

Post-fix: envBearer isolated 12/0, its directory 20/0, biome clean on both files, full suite at the 67/6276 numbers above.

### 6.3 Mutation self-verification (A/B pin-pricks)

Every PORTED security item carries a mutation kill-check in §5 (flip/remove the guard → named tests fail → revert → green). Examples: Agent A allowedProviders 34/0 (kill pin-check → 3 fails; kill schema filter → 1 fail; reverted → 34/0); Agent E SSH fail-fast 9/0 incl. live group-kill of a backgrounded `sleep` grandchild; Lead #85/#54 and Agents B/C/D per their §5 entries.

### 6.4 Build + dist verification

- `bun run build` → `BUILD_EXIT=0`; `dist/cli.js` 31,082,439 B, shebang `#!/usr/bin/env bun`, executable.
- `./dist/cli.js --version` → `OCC 2.1.362` (package.json source of truth; cli.tsx `MACRO.VERSION` = `2.1.285` upstream-tracked).
- dist pin-pricks (grep -c on the bundle): `background time limit` ×1 (#85 deadline notify text), `grants restricted to trusted` ×1 (sandbox trusted-tier authorization text).

### 6.5 Real e2e (live API, not mocked)

- **Headless `-p` smoke**: `echo "say PONG" | ./dist/cli.js -p` → `PONG`, exit 0. stderr carried `[claude-code:unrecognized_model] {"model":"glm-5.2",…}` — that is the round-verified 2.1.233 unrecognized-model signal working as intended against the third-party model name; benign.
- **Live hand-driven tmux REPL** (repl-tmux-e2e-testing skill, Architecture A: detached 200×50 session on `./dist/cli.js` in a fresh temp cwd, `capture-pane -S -` poll-until-text, `kill-session` in an EXIT trap):
  - boot → `REPL_READY=yes` (footer `⏵⏵ auto mode on (shift+tab to cycle)`);
  - model round-trip: typed `Reply with exactly the word PONG and nothing else.` + Enter → screen shows `● PONG` (live API through the built dist);
  - `/status` panel rendered: `Version: 2.1.362`, Session ID, cwd, `Auth token: ANTHROPIC_AUTH_TOKEN`, base URL, `Model: glm-5.2`, `MCP servers: 2 connected, 1 failed`, Setting sources, Auto mode server; Esc dismissed it;
  - Shift+Tab mode cycle: `⏵⏵ auto mode on` → `⏸ manual mode on` (`MODE_CYCLE=CHANGED`).
- **Repo e2e harnesses** (`OCC_ENTRYPOINT=$PWD/dist/cli.js CI= bun test …`):
  - `occ-versioning` + `commands-alignment`: **6 pass / 0 fail / 12 expect()**.
  - `repl-interactive`: **2 pass / 1 fail** — the fail is `Shift+Tab shows the auto-mode opt-in dialog`, which is (a) documented pre-existing (OCC-44: "fails identically WITH and WITHOUT this round's changes", git-stash A/B verified), (b) pre-existing by construction — the round diff (`08759e8..bc78387`) touches no REPL auto-mode-dialog code (only regex-adjacent hit is the test file `forkPermissionMode285.test.ts`), and (c) environment-explained: in this environment auto mode is already ON at boot (live tmux run above), so the opt-in-dialog path never triggers and Shift+Tab cycles auto→manual directly (verified working live). Not a round regression; recorded honestly rather than "fixed".

### 6.6 Forensics-constraint compliance + cleanup

Binary work used only `strings` / `grep -aobF` / `dd` on the two downloaded ELFs — the official binaries were never executed. Temp artifacts removed after use: `/tmp/cc-diff-285` (rm -rf), `/tmp/occ102-base` baseline worktree (`git worktree remove --force`), all probe scripts deleted; no temp branches were created this round (work went directly on `agent/occ/5d3c0a39`).

## §7 OCC-103 acceptance-fix round (2026-10-01, review verdict CHANGES_REQUESTED → fixes landed)

The OCC-102 acceptance review (`requesting-code-review`, 17 candidates → 12 confirmed / 5 falsified) blocked v2.1.362 on E2E-001 plus test-wiring gaps. All confirmed items were fixed in the OCC-103 round, each with the reviewer's named mutation self-check (apply → RED → revert → GREEN):

- **E2E-001 (P2-1, blocking) — FIXED, §5 item-5 now fully-observable.** `mcpGetHandler` resolves through `getAllMcpConfigs()` (the same full-scope set `mcp list` renders — file-backed + dynamic plugin/`--mcp-config`/SDK + claude.ai) instead of `getMcpConfigByName` (file-backed only). The v285 changelog-#101 sanitize branch (`isStdioConfig && !MCP_FILE_BACKED_SCOPES.has(scope)` → command/args/env `[REDACTED]`) is now reachable in real execution. Real seeded-plugin test (no mocked lookup): `src/cli/handlers/__tests__/mcpGetDynamicScope285.test.ts`.
- **contract-002 (P3, security) — FIXED by implementation (not divergence bookkeeping).** WebFetch `isEnabled()` now ports the FULL official gate `!CLAUDE_CODE_DISABLE_WEB_FETCH && Yt(wye)`: the second conjunct reads `allow_web_fetch` from the policySettings (managed) source only, default-allow when unset (official `onCacheMiss:"allow"`); the key is a recognized boolean in `SettingsSchema` (strict policy parse drops non-booleans → unset → allow). Tests: `allowWebFetchPolicy285.test.ts` (9, real temp managed file) + registry-level removal pins in `disableWebFetch285.test.ts` (test-08 closed: `getToolsForDefaultPreset()` excludes WebFetch under the env kill-switch AND under managed `allow_web_fetch:false`).
- **df-1 (P3) — FIXED.** The `ended_at_max_turns` S-branch suppression AND the staleness walk-set selector now read the trailing-region-scoped unresolved tool-use id set (official `ze`, new `filterUnresolvedToolUsesDetailed` in `src/utils/messages.ts` — byte-verified `f0e` reverse-scan port) instead of the global dropped-length proxy; a mid-transcript orphan no longer injects a phantom "Continue from where you left off." Test: `src/utils/__tests__/maxTurnsTrailingScope285.test.ts` (20).
- **Test-wiring gaps closed (production verified correct, tests added):** P2-2 output-content-filter streaming-fallback rethrow driven through real `queryModelWithStreaming` + HTTP mock (fetchCount===1 pin); P2-3 `executeNonStreamingRequest`→withRetry production wiring (attempts===1 + `CannotRetryError` + MAX_TIMER_MS clamp pins); P2-4 fork permission-mode inheritance through runAgent's built context (`forkPermissionModeWiring285.test.ts`); P2-5 both foreground→background deadline arms (`backgroundDeadlineTransition285.test.ts`, real production entries, killed/deadline/`<note>`/release pins); test-05 execCommandHook stdio-flag fail-closed threading with REAL children (`hookStdioFlags285RealChild.test.ts`); test-06 `redactGitUrl` dedicated suite (`redactGitUrl285.test.ts`, 68 tests, every smuggling shape pinned); test-07 armed-allowlist client-construction gate (`providerAllowlistClientGate285.test.ts`).
- **contract-001 (doc) — FIXED.** CHANGELOG tracking paragraph now carries the OCC-102 clause (+ OCC-103 fix-round bullet in the 2.1.362 entry).
