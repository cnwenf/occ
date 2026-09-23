# Upstream Version Gap — OCC-94 round (occ134)

Multica issue: **OCC-94**「OCC版本追齐官方Claude Code(2.1.278 → 2.1.280)」(autopilot trigger 2026-09-23 01:00 Asia/Shanghai)
Date: 2026-09-23
Round type: **upstream movement 2.1.278 → 2.1.280 (2.1.279 never published) → gap triage / alignment round**
Predecessor: `docs/upstream-version-gap-occ133.md` (v2.1.346/v2.1.347, no-movement self-acceptance round)

## §1 Version facts (three-way verified, 2026-09-23)

| Source | Official Claude Code | OCC |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.280**, `stable` = 2.1.267 | `@cnwenf/occ` latest = 2.1.347 (pre-round) |
| GitHub releases `anthropics/claude-code` | newest **v2.1.280** (2026-09-22T16:38:14Z) | `cnwenf/occ` newest v2.1.347 |
| CHANGELOG head | 2.1.280 (**114 entries**; 2.1.279 skipped — never published to npm) | OCC tracks **2.1.278** (`src/entrypoints/cli.tsx` VERSION marker; byte-verified through occ132) |

| Binary | Size | md5 |
|---|---|---|
| official linux-x64 v2.1.278 | 234,119,480 B | `1b3d65c11af023f190e95737c1d0c378` (md5 continuity with occ133 ✓) |
| official linux-x64 v2.1.280 | 233,709,640 B | `31162c871610fc8111e7f08ca1be8218` |

String-level diff v278→v280: **22,259 new / 18,768 removed** unique strings (identifier churn included).
Module headers: v278 = 1901 × `// Version: 2.1.278`, v280 = 1975 × `// Version: 2.1.280`.

Early-exit clause check: NO other active version-chasing issue in the occ project (in_progress = only this issue; todo/blocked/in_review = 0) → clause does not apply, full round proceeds.

Key marker counts (v278→v280, Python `re.finditer` bytes-search):
`claude-opus-5-5` 0→41, `Opus 5.5` 0→17, `opus-5-5` 0→44, `claude-opus-5` 87→120,
`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 0→4, `confirm:yes` 36→35, `confirm:no` 173→176,
`Auto mode server` 2→3, `file_text` 4→5, `file_content` 4→6, `.trash` 25→27,
`installed_plugins.json` 35→37, `GIT_ALLOW_PROTOCOL` 31→38, `strictKnownMarketplaces` 52→53,
`blockedMarketplaces` 34→35. Unchanged (continuity): `hook_execution_complete` 2→2,
`tengu_melodic_wolf` 2→2, `CLAUDE_CODE_HANDBACK_PROVENANCE` 2→2, `Subagent hand-back` 4→4, ZWNJ (U+200C) 3→3.

## §2 Method

- `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.278,2.1.280}` → full-binary evidence; every claim
  byte-verified with Python `re.finditer` + ±300–400-byte context windows (`/tmp/cc-diff-280/win.py`)
  on BOTH ELFs; strings-level `comm` diff (`new_280.txt` / `removed_280.txt`) for discovery only.
- 4 parallel triage agents (A: model/API/auto-mode/hooks/telemetry — 15 entries; B: tools/sandbox/
  subagents/background — 19; C: config/plugins/marketplaces/MCP/skills/artifacts — 34;
  D: UI/REPL/dialogs + platform-tagged — 46). Verdicts: **PORT** / **NO-OP** / **STAGE** / **SKIP**.
- Implementation on disjoint file clusters; each PORT item byte-re-verified against the v280 ELF before writing.

## §3 Item ledger — verdicts

Tally (of 114 entries, row-level): **A** 15 → 7 PORT / 5 NO-OP / 3 STAGE · **B** 19 → 4 PORT / 5 NO-OP / 9 STAGE / 1 SKIP (appendix #005 symlink-write folded into A's full PORT) · **C** 34 → 9 PORT (2 🔒) / 12 NO-OP / 4 SKIP / 8 STAGE · **D** 46 → 6 PORT / 2 STAGE / 7 NO-OP / 31 SKIP. **Total: 26 PORT (5 🔒 + Opus 5.5 headline) / 29 NO-OP / 22 STAGE / 42 SKIP.**

### §3b Group B — tools / sandbox / subagents / background (19 entries)

| ID | entry (abridged) | verdict |
|----|------------------|---------|
| #008 | Write accepts `file_text`/`file_content` misnamed params (coercion + user note) | **PORT** — `fxn=["file_text","file_content"]` @198306063, `coerceInputBeforePluginHooks:!0`, gate tengu_noble_mountain default-true, note template @199218504; OCC `src/Tool.ts:528-551`, `toolExecution.ts:545-563,:1401-1470`, `FileWriteTool.ts` |
| #013 | Windows prompt line stays scrambled after invisible-char strip | SKIP — Windows-terminal repaint, no v280 delta |
| #014 🔒 | ZWNJ between Latin word and Persian/Arabic suffix no longer stripped | **PORT** — `Xc=Ur("Arabic Syriac Mongolian Nko")` @196841593 (v278: 0 hits), `Gc=/^\p{White_Space}$/u` @196840682, helper `Sn()`, new 8204/8205 clause; OCC `src/utils/invisibleUnicode.ts:108-123,:546-572` |
| #015 | Dictation: Ctrl+C stop, Esc cancel, held-Space gating | STAGE — logic-only, zero string delta; OCC voice surface live (`useVoiceEnabled.ts`, `voiceStreamSTT.ts`, PromptInput) |
| #017 | Resumed fork subagents rebuilt tool list → prompt-cache miss | STAGE — `ownPrefix` 0→4, warning string 0→2 @199453998; OCC fork path (`resumeAgent.ts:235`, `query.ts:1255,1901`) has no prefix concept |
| #018 | Hand-back showed internal provenance preamble outside verbose | NO-OP — fix in peer/cross-session renderer; OCC path gated |
| #036 | Settings file replaced by named pipe mid-read hangs CC | STAGE — OCC gap real (`fileRead.ts:88` bare readFileSync, settings.ts callers); official fix site not isolable from strings |
| #038 | Resume with unfinished bg agents/shells auto-started a model turn | STAGE — `unfinished` 9→12 churn only; OCC restore path `LocalAgentTask.tsx:531,597`, `print.ts:741`, `REPL.tsx:3769` |
| #039 | Messages to bg subagent lost in headless/SDK mid-turn | NO-OP — OCC gates SendMessage/resumeAgentBackground path |
| #040 | Finished subagent's report lost when launcher compacted first | STAGE — no string delta; OCC drain path `LocalAgentTask.tsx:131,:139,:186-192` + compact interaction |
| #041 | Bg subagents couldn't use LSP tool when LSP plugin active | STAGE — overlaps occ131 D10 (already staged) |
| #042 | Bg shell tasks reported benign non-zero exits (grep no-match) as failures | **PORT** — `Oie()` @201157901 classifier + `Rzr={bash:o4t,powershell:u4t}`, `r4e` compound guard @197919047, exitNote in `h$e` @201151000; OCC `LocalShellTask.tsx:285,400,512` raw `code===0`, new `shellTaskResult.ts` |
| #043 | `--bg` session couldn't run git/hooks when env var held NUL | NO-OP — OCC `--bg` never starts a background session (`main.tsx:1112`) |
| #044 | Ctrl+C needed 3-4 presses with bg subagents; now 2 | STAGE — logic-only (`useExitOnCtrlCD.ts:8`, `useCancelRequest.ts:133-197`) |
| #045 | IDE selection dropped on Esc-to-edit / rewind / startup-hook Esc | STAGE — `ideSelection` +1 is a name-table entry, no code site; OCC `IdeStatusIndicator.tsx:9-29` |
| #046 | `!` shell-mode prompt stashed with Ctrl+S returned as plain; `/` listed paths | STAGE — OCC has the surface (`chat:stash` @ PromptInput.tsx:1538,:1928); needs per-site decompile |
| #047 | `claude agents` blank screen when temp dir unwritable | NO-OP — delta is Bun-runtime churn |
| #049 🔒 | Bg marketplace auto-update ignored git credential helpers | **PORT** — `$se()` @200749864 drops `disableCredentialHelper` (8→0) + gate (2→0), adds `stdin:"ignore"`; autoupdate backgrounded @206898216; OCC `marketplaceManager.ts:513-516,534,538-540,571` + callers |
| #059 | Windows cleanup deleted directory symlink relocating session-env | NO-OP — Windows-only + OCC structurally immune |
| #005 🔒 (appendix) | Symlink-write landing subsystem | folded into **A's full PORT** — narrow every-spelling allow match (official `Fkt` @194277899 ≡ v278 `Ibt` @195625759, i.e. OCC lagged BOTH) landed via IMPL-S1; full landing subsystem (`da()` walker, `XZe`/`$r` denies, carriedOut) via dedicated follow-up agent — see §4 |

### §3c Group C — config / plugins / marketplaces / MCP / skills (34 entries)

PORT (9, 2 🔒):

| ID | entry (abridged) | key evidence / OCC target |
|----|------------------|---------------------------|
| #003 | `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` env for 2,048-char MCP description cap | v280 `lV()` @199142387 (v278: 0 hits); OCC `src/services/mcp/client.ts:260,1332-1338,2017-2018` — replace constant with env-backed getter, keep `… [truncated]` suffix, allowlist env |
| #028 | Home/End dead in `/config` + selection lists | v280 `select:first/last` 7 vs 4 hits; Settings block @197322645 + handler @225582280; OCC `schema.ts:175-176` actions exist but zero consumers; `defaultBindings.ts:134-157` (Settings), `Config.tsx:1436-1463`, `use-select-navigation.ts` wiring |
| #030 | Tab silently changes setting value in `/config` | v278 @225642857 (tab cycles) vs v280 @225583608 (`tab→preventDefault` only); OCC `Config.tsx:1494` matches v278 |
| #033 | Malformed saved MCP-tools-unavailable notice crashes every turn + `/compact` | v280 @200711900 try/catch + `ai(...)` coercion @199134256; OCC `src/utils/toolSearch.ts:661-662` raw iteration — add `Array.isArray` guards |
| #034 | Crash resuming malformed system message / memory-saved notice | v280 @216205042 `uUe()` zod coercion (commands/writtenPaths/verb); helpers @200412513; OCC `SystemTextMessage.tsx:174-175,625,648,659` — `safeArray` + verb type guard |
| #048 🔒 | MCP re-added under same name still shows needs-auth | v280 @219311718 unconditional `removeMcpAuthCacheEntry(o,p)` before type gate (v278 lacks it); marker `mcp-needs-auth-cache` 5→6; OCC `cli/handlers/mcp.tsx:89-158`, `client.ts:299-360` — add per-server cache-entry removal |
| #053 | `/ultrareview` stopped review reported completed/retryable; deleted-session/account-change waits full timeout | `stopped_remotely` 0→5 hits; reason map @200386428 + parser `vnr` + classifier @200401836 + anti-retry guidance @200389422; OCC `RemoteAgentTask.tsx:719,756,781,792` — stopped classification, 404/403 immediate terminal, official reason enum |
| #074 | `@` suggestions: name-match ranks above folder-path-only match | v280 scorer @191073700 (`nameStarts`/`nameCharBits`/`Zc()`/`scanFrom`, `Math.max(fullPathScore,nameScore)`); v278 single full-path @192454000; OCC `src/native-ts/file-index/index.ts:24-30,45-47,146-166,206-296` |
| #084 🔒 | Marketplaces imitating reserved names refused on add; stop loading if already added | v280 @193906485 imitation layer: `_fr` NFKC/case-fold normalizer, reserved sets `dOe`(14)/`CIt`(3)/`xtn`(2), slug `o()`, refusal templates; v278 exact-match-only @201862308; OCC `schemas.ts:119-156` (occ132 family) lacks imitation defense; extend lists to v280 membership (`first-party-plugins` etc.), wire into add + reconcile |

NO-OP (12): #019, #020, #024, #027, #029, #050, #051, #052, #056(cloud), #065, #075, #076, #077 — OCC structurally immune or already matches post-fix behavior (per-entry evidence in triage transcript).
SKIP (4): #057 (Cowork), #058/#060/#083 (runner stub).
STAGE (8): #002+#023 (wheel plumbing into `/skills`, `/model`, `/permissions` — infra exists, needs fullscreen mouse-plumbing spec), #026 (search-box fullscreen border), #037 (`/config` null/"false" coercion — probes byte-identical, fix site elsewhere), #062 (permissions focus restore + default-No confirmations), #063 (permissions tab nav), #067 (`/workflows` scrollbar), #069 (Add Marketplace form fullscreen).

### §3d Group D — UI / REPL / dialogs / platform-tagged (46 entries)

PORT (6, no 🔒):

| ID | entry (abridged) | key evidence / OCC target |
|----|------------------|---------------------------|
| #011 | Stray `n` closes dialogs, stray `y` confirms them | v278 Confirmation ctx has `y:"confirm:yes",n:"confirm:no"` @197715639; v280 @197322904 pair removed (count 1→0); OCC `defaultBindings.ts:162-163` — delete both lines (user-restorable via keybindings.json, matches changelog) |
| #025 | Multi-select descriptions indented under number instead of label | v280 @205601363 restructured row (number+checkbox `flexShrink:0`, label+description column box); OCC `SelectMulti.tsx:159` still v278-style |
| #066 | `/install-github-app`: CLI check + repo select show "Esc to cancel" | v280 @226720089 `Xe` esc-hint wrap + third footer hint; OCC `CheckGitHubStep.tsx` (bare Text), `ChooseRepoStep.tsx:190-201` — use `ConfigurableShortcutHint` (`action="confirm:no" context="Settings" fallback="Esc"`) |
| #071 | Language-less fenced code blocks colored like inline code | v280 @202965215 `case"code"` prepends `if(!s&&e.codeBlockStyle!=="indented")return e.text.replace(/\S(?:.*\S)?/g,Et("permission",t))+T`; markers v278=0/v280=1; OCC `src/utils/markdown.ts:74-93` (codespan already uses permission color :92) |
| #072 | `/btw` while tool running: side question knows the call is in progress | v280 @212513086 placeholder `"[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]"` + `x()` dangling-tool_use synthesizer + `turnInProgress`; runner `p2n(s,o=!0)` @212603046; OCC `btw.tsx:204-212`, `sideQuestion.ts` — fork-local synthesized tool_result message; do NOT touch `ensureToolResultPairing` |
| #082 | `/fast` footer names Space as toggle key | v278 @217625581 `chord:"tab"` → v280 @217049014 `chord:"space"`; OCC `fast.tsx:176` label stale (binding already `space:'confirm:toggle'` at `defaultBindings.ts:170`) |

NO-OP (7): #021, #022, #035, #061, #068, #070, #081.
STAGE (2): #010 (window-activation click swallowing — official fix not isolatable from strings; OCC gap enumerable in `src/ink/events/click-event.ts`), #012 (text-field keybinding precedence — v280 `textEntry` attribute plumbing 0→5 hits @205317050 + Settings `defaultPrevented`/`target` @225976053; needs Ink-fork attribute work across dialogs).
SKIP (31): #054/#055 (Claude app), #086–#099 (VSCode ext), #100–#106 (Web/cloud), #107–#113 (Claude Tag/Slack), #114 (Code-Review service).

### §3a Group A — model / API / auto-mode / hooks / telemetry (15 entries: 7 PORT / 5 NO-OP / 3 STAGE)

| ID | entry (abridged) | verdict | key evidence / OCC target |
|----|------------------|---------|---------------------------|
| #001 🔴 | Opus 5.5 (`claude-opus-5-5`) added, default Opus, 1M ctx, $4/$20, $0.20 cache read, fast tier | **PORT** | catalog @191976531, tier @191977421, fast `Uh` @193258256 + dispatch @193260895, display strings @98920124/@98926788/@98943316/@98890312 (all v278=0); OCC `configs.ts:162-170,:209-227`, `modelCost.ts:140-147,:192,:202-247,:265-295`, `model.ts:168`, `modelOptions.ts:55,:322,:357`, `effort.ts` |
| #004 | hook_execution_complete OTel gains stdout_chars/additional_context_chars/system_message_chars/initial_user_message_chars/num_outputs_persisted | **PORT** | 5 attrs @199828703 (v278: 0); OCC `hooks.ts:4086` |
| #005 🔒 | Symlinked writes judged by LANDING not in-tree spelling; leaf-symlink + unresolved denies; carriedOut → classifierApprovable:false; acceptEdits/allow-rules on every spelling | **PORT** (full landing subsystem; new markers leafIsSymlink 0→5, carriedOut 0→9, landingOutside 0→3) | resolver @190660855, `XZe` leaf-deny @194287602, `r2e/JZe` carried-out @194287970, `lPn/F9t/Or` ask-sentence @194288316, `Dr` final ask @194288763, `$r` unresolved deny, flow @194286200, `Fkt` every-spelling @194277899 (byte-identical v278 `Ibt` @195625759 — OCC lagged both), integration @195391189/@195392838, auto-mode worktree deny @194267123, tool wiring Write @198310186 / Edit @201063176 / NotebookEdit @201076162; OCC `fsOperations.ts:288-382`, `permissions/filesystem.ts:1651-1860,:1826-1841,:698-722`, `permissions.ts:718-749`, `FileWriteTool.ts:167`, `FileEditTool.ts:158`, `symlinkResolutionStash.ts:173` |
| #006 | auto mode: safety-check decline → denied once, no retry loop | NO-OP | fix in server-classifier path @198955298 — OCC has no server classifier (occ131 §A1 STAGE); client path fail-closed (`denialTracking.ts` limits) |
| #007 | auto mode: no-answer backoff; stop after ten consecutive | NO-OP | `eS=10` @198953904 etc. — same server-classifier grounding; 0 hits in OCC |
| #009 | Ctrl+C/D twice in most dialogs closes dialog instead of quitting app | STAGE | zero string delta (keybinding wiring); OCC exposure `useExitOnCtrlCD.ts` no-args consumers (~20 dialogs incl. `ModelPicker.tsx:61`) — spec in §7 |
| #016 | host-app model switch while working no longer misses prompt cache | STAGE | deferral machinery byte-identical v278≡v280; only delta = removed `Wo=!0` flag write, read site unrecoverable from strings |
| #031 | every-turn API error "role 'system' must precede 'assistant'" fixed | NO-OP | OCC emits zero `role:'system'` messages; official v280 moves to catalog `mid_conv_system` gate (noted for future) |
| #032 | advisor-on convos behind proxy/gateway: 400/422 `Input tag 'advisor_…'` now retries without it, with process/host/conversation scope split | **PORT** | `ake/ske/mNn/kat` @198649508, handler `Ece` @199639819, vendor table `Lit` @198625095; v278 `Eue` @199586933 400-only; OCC `errorUtils.ts:368-410`, `advisorRetry.ts:96-151`, `withRetry.ts:616` (extends occ129) |
| #064 | /cost cache-miss causes name thinking mode / display changes | **PORT** | `UQe` map @198231081 + detection @199396741 + diagnostics @98072572 (v278 `gAt` lacks); OCC `promptCacheBreakDetection.ts:74-85,:334-348,:351-362,:549,:559` |
| #073 | UserPromptSubmit timeout notice names hook command | NO-OP | OCC renders hook_cancelled as NULL (notice UI absent); attachment already carries command; renderer delta @216332418 documented for future UI port |
| #078 | Pro & Team Standard default model: Sonnet → Opus | **PORT** | `K7t` @193447702 adds isTeamSubscriber+isProSubscriber rows vs v278 `I6t` @194783166; 1M gate `jk()` excludes Pro; OCC `model.ts:374-400` |
| #079 | pre-per-model saved effort no longer applies to newly released models | STAGE | new `legacyUserEffort` subsystem @193860055-193861750 (7 hits, v278: 0); OCC `effort.ts:168` applies global legacy effort to ALL models — needs per-model store + legacy set; interacts with #001 |
| #080 | Opus 4.7/4.8, Fable 5 stop holding launch-default effort over settings | NO-OP | OCC never had launch pin (`effort.ts:223-225` comment); official removed `honorLaunchPin` |
| #085 | PermissionRequest: agent-type hook no longer runs; error points to command/http hooks | **PORT** | error strings @98607664/@98607888 (v278 absent); OCC `hooks.ts:3153-3161` |

Grand tally across 114 entries: **26 PORT** (B 4 + appendix narrow, C 9, D 6, A 7) · **29 NO-OP** · **19 STAGE** · **45 SKIP** (numbers per group tables above; #056 counted in C NO-OP+SKIP).

## §4 Implementation report

14 parallel IMPL agents on disjoint file allowlists; every PORT item byte-re-verified against the v2.1.280 ELF before writing; no invented behavior. Aggregate footprint at roll-up: 42 modified + 28 new files (+2,735/−353 tracked lines), none committed until §5/§6 gates pass.

| Agent | Items | Files (source) | Tests | Verdict |
|---|---|---|---|---|
| IMPL-S1 | #005 narrow (every-spelling `Fkt` write allow) + #014 🔒 ZWNJ clause | invisibleUnicode.ts (+55), permissions/filesystem.ts (+70/−5) | +273 lines; 70 pass | ✅ |
| IMPL-S2 | #049 🔒 credential-helper removal + #084 🔒 reserved-name imitation | marketplaceManager.ts (+123/−25), schemas.ts (+211/−7), reconciler.ts (+23/−1) | 34 new + 165 plugin-suite pass | ✅ (follow-up: pluginAutoupdate.ts stale 3rd arg — fixed by orchestrator, 34 pass re-verify) |
| IMPL-S3 | #005 🔒 full landing subsystem | fsOperations.ts (+333), permissions/filesystem.ts (+453/−17), pathValidation.ts (+33), symlinkResolutionStash.ts (+14/−1), FileWriteTool.ts (+120/−4, shared w/ T2), FileEditTool.ts (+32/−4), NotebookEditTool.ts (+35/−5) | 60 new pass (21 descriptor + 39 landing); permissions suite 207 pass / 0 fail; wired tools 40 pass; utils suite +21, zero new failures (30 pre-existing) | ✅ (spec corrections: permissions.ts is a dir → pathValidation.ts; stash lives under permissions/; sanitizer class re-extracted — `Tn.Pn` per-char, NOT the `Qoe` UI family; binary wins each time) |
| IMPL-T1 | #042 bg-shell benign-exit classification | new shellTaskResult.ts (~560), LocalShellTask.tsx (+100/−24), Task.ts (+9) | 46 new; 57 pass / 86 expect | ✅ |
| IMPL-T2 | #008 Write input coercion + user note | Tool.ts (+32/−2), FileWriteTool.ts (+88), toolExecution.ts (+32/−3) | 24 new pass / 74 expect | ✅ (binary contradicted brief: note separator is `\n\n`, binary won) |
| IMPL-R1 | #053 remote-review stopped/404-streak | new remoteReviewFailure.ts (~240), RemoteAgentTask.tsx (7 edits) | 37 new pass / 128 expect | ✅ (binary contradicted brief: streak counts 404 only, not 403 — ported 404-only) |
| IMPL-M1 | #003 MCP description-length env + #048 🔒 auth-cache removal | mcp/client.ts, cli/handlers/mcp.tsx, managedEnvConstants.ts | 37 new pass / 97 expect | ✅ (4 pre-existing sandbox-network failures baseline-verified) |
| IMPL-A1 | #001 Opus 5.5 launch + #078 Pro/Team default → Opus | configs.ts, modelCost.ts, model.ts, modelOptions.ts, effort.ts | 41 new + 104 key-suite pass / 247 expect; 2 stale e2e pins superseded | ✅ |
| IMPL-A2 | #004 hook OTel attrs + #085 agent-type PermissionRequest error | hooks.ts (+148/−3) | 13 new pass / 44 expect; 119 regression pass | ✅ |
| IMPL-A3 | #032 advisor Input-tag/422 retry + #064 cache-break thinking causes | errorUtils.ts, advisorRetry.ts, withRetry.ts (comments), promptCacheBreakDetection.ts | 30 new pass; 58 gate pass / 209 expect; 3 stale pins updated | ✅ |
| IMPL-U1 | #011 stray y/n removal + #028 Home/End + #030 Tab guard | defaultBindings.ts, Settings/Config.tsx, use-select-navigation.ts | 31 pass / 88 expect (3 new files) | ✅ (official wiring site use-select-input.ts staged — outside allowlist) |
| IMPL-U2 | #025 SelectMulti row + #066 Esc hints + #082 fast footer | SelectMulti.tsx, CheckGitHubStep.tsx, ChooseRepoStep.tsx, fast.tsx | 8 pass / 27 expect | ✅ |
| IMPL-U3 | #071 lang-less code paint + #072 /btw in-progress placeholder | markdown.ts, btw.tsx, sideQuestion.ts | 26 new pass | ✅ |
| IMPL-F1 | #074 @-suggestion name-anchor scoring | native-ts/file-index/index.ts | 10 new + 10 existing pass | ✅ |

All agents: `bunx biome lint` clean on every changed file; no commits; no invented behavior — every branch cites a v280 ELF offset in code comments. Staged (byte-verified but outside allowlists) items are consolidated in §7.

Process notes: three wave-1 agents deadlocked polling each other — broken by explicit stand-down messages; two agents (U1/F1) attempted Multica writes — comments deleted, status restored, wave-2 briefs carried a strict no-Multica rule (honored by all).

## §5 Test + self-acceptance report

**Gate = `scripts/ci-test.sh`** (per-file process isolation; batch `bun test` has documented mock.module contamination per occ133 P3-2 — a batch run this round showed 5569 pass / 209 fail, ignored as gate per that precedent).

- **ci-test.sh (isolated): 5751 pass / 7 fail / 12 skip — 586 files, 6 failed files.**
  - 5 failed files = the exact occ133 known env-drift baseline (live-e2e): `commands-behavior` (/feedback gh issue, 1), `feedback-ai` (1), `repl-interactive` (auto-mode opt-in dialog, pre-existing since OCC-44, 1), `version-2.1.208-screen-reader` (1), `version-2.1.210-plan-approval` (2). Zero regressions in this round's changed files.
  - 1 new failure caught + fixed this round: `test/utils/sideQuestion-prepend.test.ts` — the #072 test's `mock.module('forkedAgent.js')` provided only `runForkedAgent`, but `sideQuestion.ts` transitively loads `messages.ts` → … → `SkillTool.ts` which named-imports `shouldForkedSkillRunAsync`; Bun fails linking on missing named exports of a mocked module. Fix: mock now stubs **all 9 runtime exports** of `forkedAgent.ts`. Isolated re-run: 4 pass / 0 fail; biome clean. **Adjusted effective result: 5755 pass / 6 fail** — failure set identical to baseline.
  - Delta vs occ133 baseline (5327 pass / 556 files): **+428 pass, +30 test files** — all from this round's 14 implementation agents.
- **Build**: green — `bun run build` → `dist/cli.js` 29.31 MB (MACRO.VERSION injected from package.json).
- **Version print**: `bun dist/cli.js --version` → `OCC 2.1.347` (release bump to 2.1.348 happens at tag time, §8). Dev polyfill marker in `cli.tsx` bumped to `2.1.280`.
- **Live headless**: `echo "say PONG…" | bun dist/cli.js -p` → `PONG`, exit 0 (+ expected `[claude-code:unrecognized_model]` line — glm-5.2 proxy env, pre-existing).
- **tmux REPL smoke** (120×32, throwaway cwd): welcome box `OCC v2.1.347` renders; **"↑ Opus now defaults to 1M context · 5x more room, same pricing" announcement visible → A1's #001 port live in the TUI**; message round-trip "say PONG and nothing else" → `● PONG`, prompt returned, auto-mode footer present; `/model` picker opens and renders rows + effort selector (all slots show the proxy model glm-5.2 — env model override, expected), Esc closes cleanly; `/exit` clean shutdown.
- Env-noise (not round defects): both `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_API_KEY` set warning (environmental).

## §6 Security review

Independent read-only security audit of the full uncommitted working tree (48 modified + 31 new files, ~+2,800 lines) on `agent/occ-leader/9e135fe8`.

**VERDICT: APPROVE** — no backdoors, no malicious code, no security regressions; the diff is a net hardening of the write-permission subsystem, faithful to official 2.1.280.

- **Findings: 0 CRITICAL / 0 HIGH / 0 MEDIUM.** 4 LOW/informational, all byte-faithful-to-official or documented staged debt:
  1. `fsOperations.ts` degraded-accept branch (`EACCES/EPERM/ENAMETOOLONG` treated as resolved with lexical landing) fires ONLY when zero readlinks were observed — any symlink in the chain forces unresolved→deny. Mirrors official `g=!c&&(p==="ENAMETOOLONG"‖…)`.
  2. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` has digits-only + min-1 validation but no upper clamp — matches official v280 exactly; local-env-only surface.
  3. `invisibleUnicode.ts` ZWNJ/ZWJ keep-clause (the official #072-era Persian/Arabic fix) is quadruple-guarded; Latin-Latin ZWNJ still stripped (regression-tested).
  4. `LocalShellTask.tsx` `shell` field persisted via conditional spread (guards.ts was outside the allowlist) — type-safety gap only, staged debt per §7.
- **Mechanical sweeps (added lines)**: `http(s)://`, `fetch(`, `Bun.spawn`, `child_process`, `eval`, `new Function`, dynamic `import()`, secret patterns — zero unexpected hits. Only external URL added is the literal `https://api.anthropic.com` used as an in-memory Set key (never fetched). New env reads are compared/parsed locally, never exfiltrated; new telemetry attrs are char-counts/booleans only.
- **#005 symlink-landing subsystem verified fail-closed end-to-end**: descriptor computed first; deny rules checked over `descriptor.spellings` (documented SUPERSET of old `getPathsForPermissionCheck` — can only turn allows into asks/denies); unresolved-target deny positioned after deny/internal checks and BEFORE all allow branches; allow rules require EVERY spelling to match (`matchingAllowRuleForAllSpellings`); acceptEdits/auto-mode judge `isInWorkingDir` over all spellings incl. physical landing; all three write tools wire the identical `stash → D_ → deny-passthrough → XZe ?? result` pattern so a leaf-symlink deny overrides even an allow; sanitizer stack layered with no char-class narrowing.
- **Plugin subsystem**: reserved-name imitation defense additive + fail-closed (filtered at config load, refused at add/get/refresh/reconcile); credential-helper removal matches official #049 with `GIT_TERMINAL_PROMPT=0`/`GIT_ASKPASS=''`/`stdin:'ignore'` retained; `fetchPluginZip.ts` HTTPS-only + redirect-forbidden hardening UNCHANGED.
- **Targeted suites run by reviewer**: permissions/symlink-landing/write-descriptor 73 pass / 0 fail; coerce/plugin-credentials/reserved-name/mcp-auth-cache/invisible-unicode 118 pass / 0 fail (191 total).

## §7 Carryover debt / staged items

22 STAGE items (byte-evidence located but full port needs deeper decompilation or cross-file plumbing beyond this round's blast radius):

**From A (3):**
- **#009 dialog double-Ctrl+C** — zero string delta (keybinding wiring only). OCC exposure: `useExitOnCtrlCD.ts` `exitFn = onExit ?? exit`; ~20 no-args consumers (ModelPicker.tsx:61, MessageSelector, ThemePicker, Onboarding, ThinkingToggle, MonitorMcpDetailDialog, WizardProvider, HelpV2, ExportDialog, WorkflowDetailDialog, BackgroundTasksDialog, LogSelector, AgentNavigationFooter, AgentsMenu, MCPRemoteServerMenu, WizardNavigationFooter, TrustDialog, Settings, ManagedSettingsSecurityDialog, Config). Fix path: pass `onExit=closeDialog` per consumer; changelog #009 dialog list = acceptance set.
- **#016 host-app model switch cache miss** — deferral machinery byte-identical v278≡v280 (`Ih`≡`lh`, `PHr`≡`JSr`, `model_switch_rejected` 6 both); only delta = removed `Wo=!0` flag write in setSystemPrompt wrapper, read site unrecoverable. Revisit with source/repro. OCC surface: controlSchemas.ts set_model, bridgeMessaging.ts, useMainLoopModel.ts.
- **#079 legacyUserEffort** — new v280 subsystem @193860055-193861750 (7 hits, v278: 0): pre-per-model saved effort stored separately, applies ONLY to models existing at save time; new models (Opus 5.5) start at catalog `default_effort`. Precedence legacyUserEffort(legacy models)→default→byModel. OCC gap: `effort.ts:168` applies global saved effort to ALL models — **follow-up priority now that opus-5-5 landed** (a pre-existing global effort setting would wrongly pin Opus 5.5).

**From B (9):** #015 dictation controls (logic-only), #017 fork ownPrefix cache-miss (`ownPrefix` 0→4 @199453998; OCC fork path lacks prefix concept), #036 named-pipe settings read hang (`fileRead.ts:88`; official fix not isolable), #038 resume auto-start turn (churn only), #040 subagent report lost on compaction (no delta), #041 LSP-in-bg-subagent (≡ occ131 D10), #044 Ctrl+C press count with bg subagents (logic-only), #045 IDE selection dropped (no code site), #046 `!`-mode Ctrl+S stash returns plain (OCC has `chat:stash`; needs decompile).

**From C (8):**
- **#002+#023 wheel plumbing** — v280 routes wheel into `/skills`, `/plugin` skill-state options, selection lists with hidden options (`/model`, `/permissions`) in fullscreen. OCC has zero wheel handling in SkillsMenu.tsx, CustomSelect/*, commands/model, commands/permissions; infra exists (ScrollKeybindingHandler, FullscreenLayout, VirtualMessageList, `scroll:lineUp/lineDown`). Spec: map wheel → existing scroll/select actions per context + click targets.
- **#026** search-box right border in fullscreen (`/plugin`/`/skills`/`/mcp`) — cosmetic, not byte-localized.
- **#037** `/config` null/"false" coercion — all probe sites byte-identical v278↔v280 (`BA`/`PB` @197551369≡@197942145, registry @209521843, auto-update resolver, migrations); actual fix site elsewhere in pref read path. OCC surfaces to harden regardless: Config.tsx pref readers, config.ts:996-1020, migrateAutoUpdatesToSettings.ts.
- **#062** permissions focus restore + delete/remove confirmations default **No** (fail-closed UX) — `src/commands/permissions/*`.
- **#063** permissions tab nav (←/→/Tab in rule list switches tabs) — same files; needs keybinding-context decompile.
- **#067** `/workflows` right-edge scrollbar — reusable scrollbar component exists.
- **#069** Add Marketplace form fullscreen (no inner box, aligned hints) — ManageMarketplaces.tsx.

**From D (2):**
- **#010 window-activation click swallowing** — official mouse infra byte-identical; fix in per-surface handlers not reconstructable from strings. OCC gap enumerable: `src/ink/events/click-event.ts` lacks `isWindowActivation`/`dropAsStray`/`hyperlinkUrl`/`mods`; focus tracking exists (App.tsx:484-500, ink.tsx:569 `\x1b[?1004h`). Spec: mark first SGR click after terminalfocus as activation-only; drop in pickers/tab bars/agent rows/links/dropdowns.
- **#012 text-field keybinding precedence** — v280 dispatcher guard `G?.attributes.textEntry===!0` @205317050 (`textEntry` 0→5) + Settings `defaultPrevented`/`target` @225976053. Needs Ink-fork attribute plumbing across every dialog — bigger blast radius.

**Observation (IMPL-S1):** OCC's read-path step 8 (`filesystem.ts` :1607 region) still uses single-spelling `matchingRuleForInput(...,'read','allow')` while official uses `Fkt(g,r,"read")` in BOTH v278/v280 — follow-up candidate (same every-spelling treatment as the write path).

**Round-134 agent-report staged additions (byte-verified, outside allowlists):**
- **#005 tail (S3):** `src/types/permissions.ts:248-253` `PermissionDenyDecision` lacks `blockedPath` (worked around via local widening `WriteDenyDecision`); read-lane descriptor threading (`yee` @195391189); restricted-mode landing checks (`Mr` @194267123); fd-level open()-time re-verify (`@194301857`, OCC keeps the 2.1.251 stash gate — spellings-superset preserved); Windows/WSL device-path tables in `da` (UNC early-return ported only).
- **#042 tail (T1):** `interpretCommandResult` lacks egrep/fgrep + `rzr` git-grep/git-diff bash entries (commandSemantics.ts read-only for T1); `noExitStatus` has no OCC producer (ShellCommand.ts); `RV` stopCause table; PowerShell arm structural-only; production callers (BashTool) don't yet pass `shell:'bash'` → live classification stays strict `code===0` until threaded (one line per call site).
- **#032/#064 tail (A3):** `claude.ts:1842` `recordPromptState` call site doesn't pass `thinkingConfig` (inert until wired; `PROMPT_CACHE_BREAK_DETECTION` also not in FEATURE_ALLOWLIST); `advisor.ts isAdvisorEnabled()` + `claude.ts:1443-1448` re-add gate not host-aware (exports ready in advisorRetry.ts); OCC `ThinkingConfig` lacks official `display` property.
- **#004 tail (A2):** spill producer `ene` (threshold 1e4, `tengu_hook_output_persisted`) absent since v278 → `num_outputs_persisted` honestly 0 until ported; `total_duration_ms`/`safe_mode` emit attrs missing (pre-280 gap).
- **#008 tail (T2):** `tengu_tool_input_coerced` lacks v280's `toolInputSizeBytes`; `__unparsedToolInput` guard n/a (0 hits in OCC).
- **#053 tail (R1):** configurable wait `sje` (30–55 clamp, default 45) not ported — OCC keeps fixed 30-min; `session_start_failed` needs `teleport.tsx` `startupFailure` field; success summary wording 'Remote review completed' vs official 'Cloud review completed' (cosmetic).
- **#001/#078 tail (A1):** K7t Enterprise rows (no OCC `isEnterpriseSubscriber`); `tv` omits `Po()` cascade term; ModelPicker highlight-newest target `"Opus 5"` → needs `"Opus 5.5"` (prefix still matches); `isNonCustomOpusModel` lacks opus5/opus55 (pre-existing).
- **#028/#030 tail (U1):** official wiring site `use-select-input.ts` outside allowlist — Home/End + first/last focus helpers landed, full official wiring staged.
- **#003 (M1):** corrections — `removeMcpAuthCacheEntry` existed in v278 (mcp login path); real allowlist @191031530.

## §8 Release

- **Version 2.1.348** (`package.json` 2.1.347→2.1.348); CHANGELOG "Now tracking" header → **`2.1.280`** + `## 2.1.348 - 2026-09-23 (OCC-134)` section; README/README.zh-CN/CLAUDE.md tracking statements + Tracks badge bumped with honest partial marking (2.1.280 portable subset landed; 22 items staged with forensic specs).
- Flow (fixed since 2.1.322 — no regression): commit on `agent/occ-leader/9e135fe8` → PR → merge to `main` → tag `v2.1.348` at the merge commit → push tag → `.github/workflows/publish.yml` (build → `npm publish @cnwenf/occ@2.1.348` → `gh release create --generate-notes`).
- Gate order honored: §5 test/self-acceptance (ci-test effective 5755 pass / baseline-only failures; build 29.31 MB; live `-p` PONG; tmux REPL round-trip + Opus-1M announcement + `/model` picker) → §6 security review (**APPROVE**, 0 CRITICAL/HIGH/MEDIUM) → commit/merge/tag.
- Post-release verification (authoritative record in the Multica issue comment; appended here in a follow-up docs commit): npm `latest` dist-tag == 2.1.348; `gh api repos/cnwenf/occ/releases` count == unpeeled tag count (`git ls-remote --tags` filtered `^{}`); `comm -23` tag↔release-name diff empty; residual remote agent branches cleaned (`agent/occ/134-gap-280` — stale pointer at main, 0 commits ahead — plus this round's branch post-merge).
