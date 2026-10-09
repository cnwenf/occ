# Triage 293 — Official Claude Code 2.1.292 → 2.1.293 (56 changelog entries)

Round: OCC-111 (2026-10-09). OCC baseline: `main` HEAD `5a3299f` (tracks official 2.1.292, partial).
Method: read-only binary forensics (`strings`/`grep -aboF`/`dd` — binaries **never executed**) on
`/tmp/cc-diff-293/{vprev,vver}/package/claude` (2.1.292 / 2.1.293 linux-x64 ELFs), string-count newness
proofs `s292s.txt` → `s293s.txt` (+ `new_strings.txt` / `removed_strings.txt`), and OCC `src/` surface
greps. Byte offsets (`@N`) are absolute offsets in the named ELF. Cluster sub-reports for entries
{#5,#12,#16–#20,#25,#29,#33,#40,#43} and {#7,#30–#32,#34–#36} were also posted as issue comments
`7b107763` / `8ecf8a0c` on OCC-111 (traceability); this file is the consolidated deliverable.

**Tally: PORT ×14 — #1 #4 #7 #9 #14 #19 #29 #33 #34 #35 #36 #38 #46 #47 · STAGED ×3 — #6 #40 #43 · N-A ×39**

⚠ Highest-priority item: **#38 is a REVERT of 2.1.281 guidance that OCC *did* port**
(`src/utils/permissions/autoModeOutcomeGuidance.ts`) — the revert must be ported or OCC will keep
injecting text the official 2.1.293 removed. #1 (Haiku 5.5) is the largest new-surface port.
#29 (path-scoped rules / nested CLAUDE.md on Bash single-file reads) is the largest behavior fix.

---

## Master table (original changelog order)

| # | Entry (short) | Verdict | Evidence (compact) |
|---|---|---|---|
| 1 | Claude Haiku 5.5 (`claude-haiku-5-5`), default Haiku on 1P, 1M ctx, $0.10/$0.50 ($0.50/$2.50 >100K) | **PORT** | `claude-haiku-5-5` s292:0→s293:9; catalog @204773604, defaults @204789153, pricing `haiku_55` @204772202 (vver); OCC 0 hits, 28 landing sites mapped (detail §1) |
| 2 | `agentType` in `subagentStatusLine` payload | N-A | OCC `grep -rn subagentStatusLine src` → 0 hits; only session-level statusLine (`StatusLine.tsx:38`, `hooks.ts:6698`). Official delta = one field insert (`agentType:yt.agentType,` vprev @233017200 → vver @234185400). Prereq subsystem STAGED (detail §N-A) |
| 3 | `isDeferred` in `$.tool.register` for mods | N-A | No mods/`$` engine in OCC: `src/plugins/` = `builtinPlugins.ts` + `bundled/index.ts` only; `$.tool.register` 0 hits in src (only an unrelated mention in `bareMode286.test.ts`) |
| 4 | Compaction: own last actions before compaction treated as after | **PORT** | `The messages after this summary are the most recent messages` 0→2; `Recent messages are preserved verbatim` 2→0. New note `iJt` + applier `gJt` @214875400 (vver). OCC keeps the dead 292 branch **alive** (`sessionMemoryCompact.ts:464-469` passes `true`) — squarely on the bug surface (detail §4) |
| 5 | HTTP MCP connection kept every request until close | N-A | Fix is in Anthropic's fetch wrapper (vprev `addEventListener("abort",…)` per-request never removed @239683355 → vver `AbortSignal.any([h.signal,S.signal])` @240907307, 0→2); SDK region byte-stable. OCC's `wrapFetchWithTimeout` (`client.ts:832-895`) already calls `removeEventListener` in `cleanup()` (:877) on both paths — no leak; SDK pin `^1.29.0` (`package.json:56`) |
| 6 | Queued message lost when `←` backgrounds session; `←` stays put + says so | **STAGED** | All-new carried-prompts subsystem (0→2 each: `tengu_left_arrow_carries_queued`, `queued-uncarriable`, refusal text `Cannot open agents — … can't move to the background. Press ← again…` @233544466). OCC has no `←` fork/defer foundation at all (Ctrl+B double-press → immediate background, `useSessionBackgrounding.ts:41-74`); missing = whole gesture state machine + carry files (detail §STAGED) |
| 7 | `/model` effort ←/→ wrapped past highest/lowest (could save Low as default) | **PORT** | vprev `zFe` @232902886 modulo wrap `he[(Me+1)%he.length]` → vver `$0e` @234071645 clamps `Math.min(Ie+1,he.length-1)` / `Math.max(Ie-1,0)`; OCC has the 292 modulo bug at `ModelPicker.tsx:518-544` `cycleEffortLevel` (detail §7) |
| 8 | `/tui` disconnecting Claude in Chrome (`--chrome`), ignoring `--no-chrome` | N-A | OCC `/tui` (`src/commands/tui/tui.ts`) only saves the `tui` setting for next boot — no renderer hot-swap, zero chrome imports; chrome wiring is boot-only (`main.tsx:1869-1883` `setChromeFlagOverride`). Official bug requires /tui to touch the live chrome connection; OCC's cannot |
| 9 | Claude told to continue/message subagents with `SendMessage` when tool removed | **PORT** | `canContinueAgent` 0→12, `continueAvailable` 0→3, gate `Dw(o){return o.some((e)=>Dt(e,nr))}` `nr="SendMessage"`; prompt bullets now conditional (vver @215971200/@215967500). OCC SendMessage is runtime-enablable (`SendMessageTool.ts:535` → `agentSwarmsEnabled.ts:24`, env/flag — NOT dead KAIROS code) and its continue-instructions are unconditional (`AgentTool.tsx:1439/:1479`, `prompt.ts:295`) (detail §9; orphan-notification sub-part N-A) |
| 10 | Subagents told a built-in tool was "disabled for the whole session" | N-A | Official hint-builder system absent from OCC (`disabled for this session` / `not among the tools available here` → 0 hits in src); OCC returns bare `<tool_use_error>Error: No such tool available: X` (`toolExecution.ts:313-348`, `StreamingToolExecutor.ts:99-104`) — misstatement impossible. Official vver wording archived @214643300 for any future port |
| 11 | claude.ai-synced skill's edited description not reaching model | N-A | No claude.ai skill-sync in OCC: `src/skills/` has bundled/dir/MCP-skill loaders only; no sync loop, no remote skill descriptions (0 hits `syncedSkill\|skillSync`) |
| 12 | `claude logs/stop/kill/rm`, `daemon status/stop/uninstall` signing out on expiry | N-A | Official fix = suppress the auth GrowthBook kick at these call sites (vver @204146011 `kickGrowthBook:S&&!_`, @219379294 `Gt=new Set(["status","stop","uninstall"])` gate). OCC handlers are purely local (lockfile/pid/tail: `cli/handlers/daemon.ts:75,330-404`; `main.tsx:4639-4707`); `logout\|clearAuth\|refreshToken\|401\|growthbook` → 0 hits there; no kick mechanism in src (0 hits) |
| 13 | Footer agents count vanishing on sessions-folder read failure | N-A | Official fix = keep-last-good on transient readdir errors (`listing sessions failed for a reason that may pass; keeping the counts` 0→4, transient set EBUSY/EMFILE/ENFILE/EAGAIN/EINTR, ≤3 strikes). OCC footer counts are pure in-memory appState (`PromptInputFooterLeftSide.tsx:421`, `BackgroundTaskStatus.tsx:40-45`); no sessions-dir read in components (0 hits) — failure mode impossible |
| 14 | Custom agent named `worker` shown as "Agent"; detail dialog title loses type | **PORT** | vprev `jzn` bug reproduced byte-for-byte in OCC ×3: `subagent_type==='worker' → 'Agent'` collapse (`UI.tsx:769-770`), no-activeAgents consult, dialog title `?? "agent"` fallback (`AsyncAgentDetailDialog.tsx:102`). vver fix `dOr`/`G2n` @220331500 + `?? k.agentType` @234080600 extracted (detail §14) |
| 15 | Artifact tool row reading `Artifact("(unprintable path)")` during publish stream | N-A | No Artifact publish tool in OCC: `unprintable` 0 hits; only `ReviewArtifactTool` (no publish/streaming path). Artifacts publishing is a trimmed surface |
| 16 | `/ultrareview` upload on Linux wrongly refusing repos (settings "could not be parsed") | N-A | OCC `cli/handlers/ultrareview.ts` (113 lines) is eligibility-check only (`checkRemoteAgentEligibility({skipBundle:true})` :52 → `launchRemoteReview` :76); no upload/packing path; `could not be parsed` / `Not uploading this working tree` 0 hits in src. Official refusal text unchanged between versions (fix is in trigger conditions; archived @98783153) |
| 17 | `/ultrareview` split-index refusal advising dangerous git command | N-A | Same absent upload surface (`split-index\|sharedindex` 0 hits in src). Official wording change archived: old advice `git update-index --no-split-index …` (2→0) → new `do not delete any of these files by hand…Use a fresh clone` (0→2, @98479321) |
| 18 | RC/cloud long-session replies appearing block-at-a-time | N-A | Official fix = deleting the viewer-away slowdown (`viewerAwayStands` 2→0, `setOnViewerSign` 3→0, `cli_ccr_viewer_away_ended` 2→0). OCC never implemented viewer-away (0 hits in `ccrClient.ts`/`HybridTransport.ts`); fixed 100ms flush (`ccrClient.ts:42`) = post-fix behavior. (Pre-existing parity gap noted: OCC lacks 293's `streamEventFlushOnFirstDelta`/no-subscriber hold — not this entry) |
| 19 | RC re-uploading starting history after every credential recovery | **PORT** | vver replaces the reset-on-recovery of the initial-history flag with promise-settle tracking + `firstHistoryFlush` handoff (0→2). OCC has the identical 292 bug: `remoteBridgeCore.ts:575` `initialFlushDone = false` inside `recoverFromAuthFailure()` (:530-593) + `flushHistory` (:624-657) with no UUID dedup → full re-send after every 401 recovery (detail §19) |
| 20 | PushNotification "Remote Control inactive" in `claude remote-control` sessions | N-A | Official fix = third disjunct in the active check (`c=r||Gc()||Wne()`, `Wne=y2()&&!flt()`, `CLAUDE_CODE_ENVIRONMENT_KIND==="bridge"` @236997293). OCC PushNotificationTool is flag-dead (`tools.ts:50-53` gates on `KAIROS`/`KAIROS_PUSH_NOTIFICATION`, neither in `FEATURE_ALLOWLIST`); `Remote Control inactive` 0 hits. Revival predicate archived |
| 21 | Mod hooks on `classic.*` skipped during plugin-hooks worker restart | N-A | No mods engine, no `classic.*` hook events in OCC (0 hits) |
| 22 | `claude plugin test` failing for mods calling `$.session.append`; `mock.session` | N-A | No `plugin test` command / `$.session.append` / `mock.session` in OCC (0 hits) |
| 23 | `claude plugin eval` refusing Bash-granting runs on Docker Desktop Macs | N-A | No `plugin eval` in OCC (0 hits; `cli/handlers/plugins.ts` has neither subcommand) |
| 24 | Apps gateway refusing to start when desktop policy sets `builtinBrowserEnabled` | N-A | `builtinBrowserEnabled` 0 hits in src; OCC has `/desktop` handoff UI only (`commands/desktop/`), no apps-gateway policy parsing |
| 25 | `claude agents` offering bypass permissions that background sessions ignored | N-A | OCC agents surfaces never offer bypass: `bypassPermissions\|allowBypass\|dangerously-skip` 0 hits in `cli/handlers/agents.ts` + `commands/agents/agents.ts`; OCC's real consent path writes **user** settings.json (`interactiveHelpers.tsx:218-223` + `migrateBypassPermissionsAcceptedToSettings.ts`) so the official bug cause (consent only in local/`--settings` file) cannot arise. Official 293 flow (user-settings-only consent `Nct()`, reload `fxt()`, warn text 0→2) archived @222552154 for future port |
| 26 | `←` backgrounding after 10s despite unsent text / waiting question | N-A | OCC has no defer-cap timer (Ctrl+B is immediate, `useSessionBackgrounding.ts:41`; the 800ms `useDoublePress` window is press detection, not a move delay). Official guards (`tengu_defer_cap_cancelled_draft` 0→2, `tengu_defer_cap_refused_ask` 0→2, texts `YBo`/`XBo` verbatim @233565900) belong to the absent `←` subsystem — must ship with it (see #6 STAGED) |
| 27 | Esc / No-without-feedback not stopping turn after `←` pressed | N-A | Pure control-flow fix in the turn-end pending-fork block (`!aL(terminal_reason)` guard added, `aL(e)=e==="aborted_streaming"||e==="aborted_tools"` @205716944; anchor @234840721). OCC has no turn-end pending-backgrounding block; Esc/abort path is direct (`useSessionBackgrounding.ts:99-127`). Permission-prompt strings unchanged 8→8/3→3/2→2 |
| 28 | Agents view replacing session list with placeholder rows on read failure | N-A | Official form impossible in OCC: FleetView rows are built from in-process task state (`FleetViewScreen.tsx:99` `buildFleetRows(tasks, now)`), no sessions readdir, no `(earlier)` placeholder concept. Official fix = keep-last-good ≤15 strikes (`[fleet] …keeping the listed sessions` 0→4, `bm=15` @223191600). **OCC-side same-class hazard noted (hardening candidate, not a port):** `workerRegistry.ts:118-131` `readDaemonStatus()` double `catch→[]` blanks daemon rows for a poll cycle on EMFILE |
| 29 | Path-scoped rules + nested CLAUDE.md not loading on single-file cat/head/tail/sed -n/grep in Bash | **PORT** | Official fix = thread `nestedMemoryAttachmentTriggers` into the Bash post-exec readFileState recorder + fire on both paths: vver `_Rn` 6-arg @216615382 (`if(n.get(z)){cRn(h,z);return}` — the already-recorded early-return was the bug), gate `AH` (read-deny → no trigger) @208866471; counts `nestedMemoryAttachmentTriggers` 15→17. Full command condition-set `TBr` @216611223 extracted. OCC has a **looser** recorder with no triggers/exit-gate/slicing: `BashTool.tsx:478/:540-589/:1041` (detail §29 — largest behavior port) |
| 30 | Pasted text beginning+ending with same words sent as if typed | N-A | Fix lives in the official inline-paste span finder (vprev `fnr/UI` @210356944 → vver `Ior/Zw` @211428807 two-pass `anyCopy`/`standingCopy`). OCC has no typed-vs-paste segmentation / inline paste records (`skill_mention`, `pasted_content`, `slashNameOnly`, `userTypedThisTurn` → 0 hits); OCC uses `[Pasted text #N]` placeholders expanded at send (`history.ts:86`) — paste is never reclassified as typed. If the surface is ever ported, adopt the 293 two-pass version |
| 31 | Skill name in paste treated as typed when accent merged into last letter | N-A | Same absent surface. Official fix = KMP matcher with trailing-combining-mark tolerance `EKe` (`/\p{M}/u` 1→2) wired into the inline-record pruner (vprev `zp` @233108900 → vver `JA` @234279495) + queued-prompts schema `inline`/`slashNameOnly` (0 hits in vprev). Nothing to prune in OCC; `EKe` archived with #30 |
| 32 | `/feedback` returning to drafts list after Ctrl+O/Ctrl+Z while sending | N-A | OCC `/feedback` (`commands/feedback/feedback.tsx` + `components/Feedback.tsx`) is a linear userInput→consent→submitting→done flow with **no drafts list** (`SendFeedback\|feedback_draft\|draft_id` → 0 hits but one unrelated comment); during `submitting` keys are ignored. Official drafts subsystem byte-identical 292↔293 (13/13, 5/5, 4/4, 16/16) — fix is UI key handling inside it |
| 33 | `claude purge` stopping silently on undeletable file | **PORT** | Official: continue-on-error + failure list + exit 1 + anti-hang (`purgeStoppedByError` 0→3; list text `${i.length} item(s) failed:…`, `What could not be deleted is still on disk…` @222469000). OCC `projectPurge.ts` already continues (`executeDeletion`:242-261) and lists failures (:253-255) but **exits 0 on failure** — the one-line gap + optional wording alignment (detail §33) |
| 34 | keybindings.json: lone `" "` no longer error; `"ctrl+ k"` warns | **PORT** | Validator vprev `He` @209294143 → vver `Xe` @210180546: space-key exemption, new check `g=/\s\+|\+\s/` with warning `A space next to "+" splits "${P}" into separate presses, and one of them has no key` + suggestion `Remove the spaces next to "+"`, 80-char truncation (all three phrases 0→2). OCC still errors on lone `" "` (`validate.ts:189-202` empty-part loop); `parser.ts:81-83` already accepts it (detail §34) |
| 35 | vim `>>`/`<<` on spaces-only line leaving cursor past EOL | **PORT** | vver replaces `match(/^\s*/)` cursor placement (count 3→0) with grapheme-walk `$t(l)` (0→1) at all three official indent sites; on all-whitespace lines cursor stays on last grapheme. OCC has the 292 pattern at exactly 2 sites: `operators.ts:419/422` (`executeIndent`), `:1241/1242` (`executeVisualIndent`) (detail §35) |
| 36 | vim V+d cursor → first non-blank; `.` acts on cursor's line | **PORT** | vprev plain clamp (1→0) → vver first-nonblank placement block (0→1) + dot-replay guard `if(I===k&&!(O&&x.text.length>0))return` (0→1). OCC has both 292 patterns: `operators.ts:862-884` (clamp) and `:960-969` (`if (range.from === range.to) return`); record shape unchanged (detail §36) |
| 37 | Windows: PID reuse killing unrelated process (status line/hook/shell) | N-A | Windows is out of OCC's supported seam (Linux/macOS-first). OCC's only win32 kill path (`processTreeKill.ts:263-266` `taskkill /pid … /T /F`, auth-refresh watchdog) is already guarded by the `exitCode/signalCode !== null` pre-check (:257-261). Residual surface noted for any future Windows round |
| 38 | **REVERT** of 2.1.281 auto-mode denial "covers the outcome" message | **PORT (execute revert)** | `This denial applies to the outcome` s292:2→s293:0 (removed:2); all four guidance sentences gone from vver; builder diff = delete `${Qat}` (+ trailing space) from the template (vprev `ier` @215722700 → vver `fnr` @216697200). **OCC ported the 281 guidance**: `autoModeOutcomeGuidance.ts` (:32/:39/:43-48 byte-identical to vprev `C0n/x0n/Qat`) injected at `messages.ts:387-394`. Full post-revert template extracted; precise revert plan in detail §38 |
| 39 | **REVERT** of 2.1.290 cloud-session wakeup fix | N-A | Cloud sessions absent from OCC (`ScheduleWakeup` appears only in a system-reminder string `BashTool.tsx:443` and a comment `hooks.ts:610`; no cloud-session sleep/wakeup machinery). Nothing ported from the 290 fix → nothing to revert |
| 40 | Team/Enterprise: policy+managed settings fetched earlier, 3s stalled retry | **STAGED** | The 3s hedge exists since ≤292 (`delayMs:s=3000` in both, @218211334/@218948660); 293 delta = `stillWanted` guard (5→11), resolve fix, and default-on prefetch with remote kill-switch (`tengu_managed_config_prefetch_off` 0→2, `E$t` @221197538). OCC has the two network fetches (`remoteManagedSettings/index.ts:56-57,:213-246`; `policyLimits/index.ts:61,:378-402`) but only sequential retries — missing: pre-292 hedge+prefetch architecture, `Of()/MO()` org-context predicates, kill-switch channel decision, "earlier" ordering proof (detail §STAGED) |
| 41 | Claude in Chrome: fewer page actions refused when browser slow to report tabs | N-A | Fix is extension-side, not in the CLI binary: candidate phrases (`slow to report`, `report its tabs`, tab-timeout identifiers) 0 hits in **both** s292/s293; `tabs_context` 61→61. OCC's chrome bridge (`claudeInChrome/mcpServer.ts`, 293 lines) is an analytics-forwarding proxy with no tab-refusal logic |
| 42 | Chrome-in-cloud multi-org sign-in message | N-A | Cloud sessions absent (see #39); the message is cloud-only. No multi-org chrome message surface in OCC (`claudeInChrome/prompt.ts` carries only the static extension guidelines) |
| 43 | Bash edit diff note rewording ("changed while the command ran… other processes") | **STAGED** | Wording swap verbatim: vprev `(what this command changed; a convenience view…)` @94452618 (2→0) → vver `(files that changed while this command ran, by the command or by another process; …)` @94469505 (0→2). OCC lacks the host feature entirely (`diff` 0 hits in `BashTool/UI.tsx`; `convenience view` 0 hits in src) — no line to reword. Unblocking condition: port the whole Bash edit-diff view, then adopt 293 wording (detail §STAGED) |
| 44 | Artifacts: Claude pins libraries to versions ≥2 weeks old | N-A | No artifacts builder/publishing in OCC (see #15) |
| 45 | claude.ai skill sync interval 10→40 min | N-A | No claude.ai skill sync (see #11) |
| 46 | Agent lists + MCP servers announced to model: non-ASCII sorts after ASCII | **PORT** | New comparator `ZCe` @204175795 (0→7) — ASCII regex `/^[\x00-\x7f]*$/` partition, localeCompare inside ASCII-ASCII, code-unit `<` otherwise; 6 official call sites switched (mcp_instructions_delta, agent merge, conflict report, token estimator, MCP error delta, agent_listing_delta). OCC sorts with `localeCompare` at the 3 corresponding sites + one unsorted list (detail §46) |
| 47 | OTEL `claude_code.at_mention`: ≤100 agent + ≤100 MCP-resource events per prompt read | **PORT** | `tengu_at_mention_unreported` 0→2; vver `q5e=100`, index-gated emitter `Ix` + overflow reporter `Xfn` @~216024405 (verbatim in detail §47). OCC emits unconditionally per mention: `attachments.ts:2022-2031` + 8 emit pairs in `processAgentMentions`/`processMcpResourceAttachments` |
| 48 | Self-hosted runner poll jitter 4–6s | N-A | `src/self-hosted-runner/main.ts` is a 3-line auto-generated stub (`selfHostedRunnerMain = () => Promise.resolve()`) — no orchestrator/poll loop exists |
| 49 | [Claude Tag] Slack Enterprise Grid workspace labeling | N-A | No Slack/Claude Tag backend in OCC (`install-slack-app` is an openBrowser stub; `Claude Tag\|claudeTag` 0 hits) |
| 50 | [Claude Tag] mid-task stop on channel config change | N-A | Same absent subsystem |
| 51 | [Claude Tag] thread routine + extra notes run continuation | N-A | Same |
| 52 | [Claude Tag] Google connector dialog state | N-A | Same |
| 53 | [Claude Tag] Enterprise Grid Connect button | N-A | Same |
| 54 | [Claude Tag] join announcement channels silently | N-A | Same |
| 55 | [Claude Tag] channel rules limit 20→50 | N-A | Same |
| 56 | [Code Review] Add-a-repository dialog lists failures | N-A | No cloud Code Review service UI in OCC (`Add a repository` 0 hits; OCC `/code-review` is a separate local implementation) |

---

## PORT details

### §1 — Claude Haiku 5.5 (entry #1)

**Binary evidence (all vver @ offsets; all absent in vprev — `claude-haiku-5-5` 0→9 unique lines / 0→21 raw; `haiku_55` 0→2; `haiku55` 0→3):**

Catalog entry @204773604 (verbatim, complete):

```js
{id:"claude-haiku-5-5",family:"haiku",display_name:"Haiku 5.5",knowledge_cutoff:"June 2026",
 provider_ids:{first_party:"claude-haiku-5-5",bedrock:"us.anthropic.claude-haiku-5-5",
   vertex:"claude-haiku-5-5",foundry:"claude-haiku-5-5",anthropic_aws:"claude-haiku-5-5",
   anthropic_google_cloud:"claude-haiku-5-5",mantle:"anthropic.claude-haiku-5-5"},
 vertex_region_env_var:"VERTEX_REGION_CLAUDE_HAIKU_5_5",fallback_3p:"claude-haiku-4-5",
 context:{window:1e6,native_1m:!0,supports_1m_beta:!0},
 max_output_tokens:{default:128000,upper:128000},pricing:"haiku_55",
 capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking","mid_conv_tool_change",
   "context_management","rejects_disabled_thinking","per_turn_effort","lean_prompt",
   "org_locked_thinking","haiku_5_5_early_stopping_guidance"],
 default_effort:"medium",advisor_rank:4}
```

Key facts: **no `gateway` provider id; no dated variant anywhere** (only bare / `us.anthropic.` / `anthropic.` forms). **Native 1M** (`native_1m:!0`, no `supports_1m_suffix`) → picker alias list `O2` @204794xxx unchanged (`sonnet[1m]/opus[1m]/fable[1m]` only — **no `haiku[1m]` row**; `"(1M context)"` count 6→6). The context-1m beta header only attaches with a literal `[1m]` suffix (`vu(e)` @207166765) — bare haiku-5-5 gets its 1M window natively from `context.window:1e6`. `claude-code-20250219` beta still excludes anything `includes("haiku")`.

Defaults @204789153 / @204789597 (verbatim):

```js
haiku:{default:"claude-haiku-5-5",per_provider:{bedrock:"claude-haiku-4-5",vertex:"claude-haiku-4-5",
 foundry:"claude-haiku-4-5",mantle:"claude-haiku-4-5",anthropic_aws:"claude-haiku-4-5",
 anthropic_google_cloud:"claude-haiku-4-5",gateway:"claude-haiku-4-5"}}
latest_per_family:{fable:"claude-fable-5-1",opus:"claude-opus-5-5",sonnet:"claude-sonnet-5-5",haiku:"claude-haiku-5-5"}
```

vprev @203888744 was `haiku:{default:"claude-haiku-4-5"}` → **default switched first-party-only; all 7 3P providers pinned to 4-5**.

Pricing @~204772202 (verbatim; `haiku_55` + `above_prompt_tokens` absent in vprev):

```js
haiku_55:{input:0.1,output:0.5,cache_write_5m:0.125,cache_write_1h:0.2,cache_read:0.01,web_search:0.01,
 long_prompt:{above_prompt_tokens:1e5,input:0.5,output:2.5,cache_write_5m:0.625,cache_write_1h:1,cache_read:0.05}}
```

Consumer plumbing @207062365 adds optional `longPrompt:{abovePromptTokens,…}` to the ModelCosts shape. No fast-mode pricing for haiku-5-5 (`VAt` @207064370 ≡ vprev `ITt` modulo renames).

Registration tables (all vver-only): CATALOG_MODEL_IDS `Rce` @204665302 (22 ids, `"claude-haiku-5-5"` after `claude-haiku-4-5`); id→short-key `T` @204794731 (`"claude-haiku-5-5":"haiku55"`); canonicalization @207155145 (`if(e.includes("claude-haiku-5-5"))return"claude-haiku-5-5";` **before** the haiku-4-5 branch); bare-alias map @211455167 (`["haiku-5-5","claude-haiku-5-5"]` before haiku-4-5); descriptor list `F1` @231285771 (`["haiku45","haiku55",…]`); vertex env map @204463706 (`["claude-haiku-5-5","VERTEX_REGION_CLAUDE_HAIKU_5_5"]`); claude-api skill @239699786 (`HAIKU_ID:"claude-haiku-5-5",HAIKU_NAME:"Claude Haiku 5.5"`); env-info prose `TLo` @214367836 — **"and Haiku 4.5" dropped** from the lead-in and the dated-haiku special case removed (vprev `iNo` @213413265 had `r==="claude-haiku-4-5"?"claude-haiku-4-5-20251001":r`).

Capability gates flipping ON for haiku-5-5 (byte-read; deny-lists unchanged, capability lookup decides): effort @208123741, max_effort @208124232, xhigh_effort @208124734; adaptive_thinking `Vlo` @207174660; interleaved_thinking `UDn` @207175733 (3P: only haiku-4-5/claude-3 denied → **true on every provider**); context_management `jN` @207175950; structured_outputs `BDn` (1P && not opus-4-1); rejects_disabled_thinking `ZTe` @207173772 (message `Thinking can't be turned off for ${…}`); vertex web search (`!cr(e,"claude-opus-4-0")`); 1M-beta eligibility `o2` @207167250 (capability true, but header still needs the literal `[1m]` suffix); mid_conv_tool_change `wye`; auto/fast-mode `s2` @217777614-region: `n.includes("haiku")&&n!=="claude-haiku-5-5"` — haiku-5-5 **exempted** from the 3P haiku denial (feeds "not supported in auto mode" messaging). Model-age ladder `Nv` @207171395 **unchanged**. Hardcoded lists NOT extended (no OCC change): bytes-per-token set `wN` @207157219, fileStateGuard @208196174, todo-tools @215926534, effort-launch-pin `Me` @208128783, `RN` display set @207162365.

New haiku-5-5-only prompt section (**STAGED sub-part**): early-stopping guidance `ULo`/`HLo` @214379307/@214376484 — `DN("haiku_5_5_early_stopping_guidance",…)` + `Fr("tengu_idempotent_wolf",!0)` gate, injected as prompt-bundle section `ap("heron_brook",()=>BLo()??ULo(h,s))` @214407043; text begins "The reasoning effort setting changes how much you think before you act…" (~2.6KB captured). OCC has no `heron_brook` bundle family (grep-proven) → STAGED, not a launch blocker. Also STAGED: `org_locked_thinking` consumer @220889318 (no OCC equivalent). N-A sub-part: auto-mode `s2`/`Qlo`/`lst` skill-model gate (no OCC "not supported in auto mode" path).

**OCC landing sites (28-row map; pattern reference = the sonnet-5-5 launch, 23 files):**

| Site | Change |
|---|---|
| `src/utils/model/configs.ts:51-59` (haiku-4-5), `:209-218` (sonnet-5-5 template) | Add `CLAUDE_HAIKU_5_5_CONFIG` (firstParty `claude-haiku-5-5`, bedrock `us.anthropic.claude-haiku-5-5`, mantle `anthropic.claude-haiku-5-5`, vertex/foundry/anthropic_aws bare — **no gateway**) + `haiku55` key in `ALL_MODEL_CONFIGS` immediately after `haiku45` (catalog `T`-map order; modelLadder `catalogKeysChronological()` depends on it) |
| `src/utils/model/model.ts:263-271` | `getDefaultHaikuModel()`: mirror `getDefaultSonnetModel()` (:230-236) — non-firstParty → haiku-4-5; else haiku-5-5 |
| `src/utils/model/model.ts:534-536` | Insert `includes('claude-haiku-5-5')` canonicalization **before** the haiku-4-5 branch |
| `src/utils/model/model.ts:806-807,:1121-1123` | Display switch + marketing name → `haiku55 → 'Haiku 5.5'` |
| `src/utils/model/modelDescriptors.ts:36-63` | `'claude-haiku-5-5'` after `'claude-haiku-4-5'` in `CANONICAL_MODEL_CATALOG` |
| `src/utils/model/unrecognizedModelSignal.ts:83-95` | Add `'claude-haiku-5-5'` |
| `src/utils/modelCost.ts:200-207,:257-262` + `ModelCosts` type | `COST_HAIKU_55` = {0.1, 0.5, cw5m 0.125, cw1h 0.2, read 0.01, webSearch 0.01} + new optional `longPrompt:{abovePromptTokens:100000, input 0.5, output 2.5, cw5m 0.625, cw1h 1, read 0.05}` (binary @207062365); register in `MODEL_COSTS` |
| `src/utils/model/modelOptions.ts:470-475,:488-494` | `getHaiku55Option()` (label `Haiku`, desc `Haiku 5.5 · Fastest for quick answers · $0.10 / $0.50…` via `formatModelPricing(COST_HAIKU_55)`); `getHaikuOption()` ternary → haiku55 first. **No `haiku[1m]` alias** |
| `src/constants/prompts.ts:143-148` | `CLAUDE_LATEST_MODEL_IDS.haiku: 'claude-haiku-5-5'` (undated — binary dropped the dated case) |
| `src/constants/prompts.ts:693` | Prose → "The most recent Claude models are the Claude 5 family. Model IDs — … Haiku 5.5: 'claude-haiku-5-5'." (drop "and Haiku 4.5") |
| `src/constants/prompts.ts:742-758` | Cutoff map: `claude-haiku-5 → 'June 2026'` before the `claude-haiku-4` branch |
| `src/skills/bundled/claudeApiContent.ts:73-74` | `HAIKU_ID: 'claude-haiku-5-5'`, `HAIKU_NAME: 'Claude Haiku 5.5'` |
| `src/utils/effort.ts:42-56,:69-93,:100-125` | Add haiku-5-5 to effort/max/xhigh allowlists **before** the `includes('haiku')` exclusion |
| `src/utils/thinking.ts:113-140` | `modelSupportsAdaptiveThinking`: add haiku-5-5 before the haiku exclusion |
| `src/utils/thinking.ts:~100-111` | Official `Aps` = `!claude-3` for all providers; OCC 3P branch denies haiku-5-5 → align (at minimum add haiku-5-5) |
| `src/utils/betas.ts:92-112` | `modelSupportsISP`: official 3P fallback `return!0` except haiku-4-5/claude-3 → add haiku-5-5 (note pre-existing OCC divergence for sonnet-5/opus-5 3P — flag separately) |
| `src/utils/betas.ts:125-141` | `modelSupportsContextManagement`: add haiku-5-5 to 3P branch; header gate `:372-381` shape already matches |
| `src/utils/betas.ts:114-122` | `vertexModelSupportsWebSearch`: official = `!cr(canonical,"claude-opus-4-0")` → add haiku-5-5 (OCC `haiku-4` substring denies) |
| `src/utils/betas.ts:195-205` | `modelSupportsStructuredOutputs`: add haiku-5-5 (official `BDn` = 1P && !opus-4-1) |
| `src/utils/context.ts:64-79,:82-130` | **Native 1M**: `getContextWindowForModel('claude-haiku-5-5') === 1_000_000` without suffix/beta header; honor `CLAUDE_CODE_DISABLE_1M_CONTEXT`; do NOT add a `haiku[1m]` alias |
| `src/utils/context.ts:258-300` | Max output tokens: haiku-5-5 → default 128000 / upper 128000, before the `haiku-4` 32K/64K branch |
| `src/utils/envUtils.ts:213-215` | `['claude-haiku-5-5','VERTEX_REGION_CLAUDE_HAIKU_5_5']` |
| `src/utils/commitAttribution.ts:182-189` | `includes('haiku-5-5') → 'claude-haiku-5-5'` before the haiku-4-5 line |
| `src/utils/effort/leanPrompt.ts:31-37,:56-75` | Add `'claude-haiku-5-5'` to `LEAN_PROMPT_MODELS` (capability `lean_prompt`) |
| `src/utils/model/midConversationSystem.ts:52-63` | **No change** — haiku-5-5 must NOT join the legacy no-mid-conv list |
| No change (binary lists unchanged): `commands/context/context-noninteractive.ts:43`, `todoToolsAvailability.ts:45-58`, `fileStateGuard.ts:110-118`, `modelLadder.ts` (haiku55 insertion into ALL_MODEL_CONFIGS extends the same-tier fallback automatically) |
| `src/utils/model/model.ts:980-1000` | Stale comment "haiku has no 1M variant" — update (haiku-5-5 is natively 1M) |
| STAGED: `heron_brook`/`HLo` early-stopping bundle; `org_locked_thinking`; `rejects_disabled_thinking` / `per_turn_effort` infra (pre-existing feature gaps). N-A: auto-mode `s2` skill-model gate |

**TDD plan** (pattern: `src/utils/model/__tests__/sonnet55Launch284.test.ts` → new `haiku55Launch293.test.ts`):
1. RED config registration: `ALL_MODEL_CONFIGS.haiku55` exact provider ids; key order right after `haiku45`.
2. RED defaults: `getDefaultHaikuModel()` = 5-5 on firstParty / 4-5 on all 3P; `ANTHROPIC_DEFAULT_HAIKU_MODEL` env still wins.
3. RED canonicalization + display names (`us.anthropic.claude-haiku-5-5-v1` → `claude-haiku-5-5`; `'Haiku 5.5'`).
4. RED costs: `COST_HAIKU_55` exact incl. `longPrompt.abovePromptTokens=100000` tier; `longPrompt` optional (existing cost tests stay green).
5. RED capability gates (effort/max/xhigh/adaptive-thinking/ISP incl. 3P/context-management incl. 3P/vertex web search/structured outputs) true for haiku-5-5, haiku-4-5 unchanged.
6. RED context: 1M window without suffix; `CLAUDE_CODE_DISABLE_1M_CONTEXT` honored; max tokens 128000/128000; no `haiku[1m]` alias.
7. RED prompt surfaces: env-info prose shape, cutoff `June 2026`, claude-api skill HAIKU_ID/NAME, picker row text, lean prompt.
8. RED misc: vertex env map, commitAttribution, CANONICAL_MODEL_CATALOG, unrecognized-model signal; mid-conv NOT legacy.
9. GREEN implement all sites; IMPROVE: full `src/utils/model/__tests__` suite (availableModelsMatch283, modelLadder286, threePFallback284, anthropicDefaultModel236 must stay green) + e2e `occ -p` haiku alias resolution + REPL `/model` row.
10. Separate issues for STAGED sub-parts.

### §4 — Compaction "own last actions" note (entry #4)

Counts: `The messages after this summary are the most recent messages` 0→2 (new); `Recent messages are preserved verbatim` 2→0 (removed); vprev `recentMessagesPreserved:` assignment 0 hits → the 292 branch was **dead code upstream**; 293 deletes it and adds the post-summary note.

vver @214875400 (verbatim):

```js
var iJt="The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.";
function gJt(e){let{content:n}=e.message;return{...e,message:{...e.message,content:typeof n==="string"?`${n}\n\n${iJt}`:[...n,{type:"text",text:iJt}]}}}
```

Application gate (commit path vprev @213931200 → vver @214897600): `vt=Ne.length>0?n.summaryMessages.map(gJt):n.summaryMessages` — **only when preserved tail messages exist, only on the reactive-compact commit path**; full/partial/hook-replacement paths do NOT get the note. vver builder `v3` vs vprev `l3`: sole semantic change is deleting `if(n?.recentMessagesPreserved)g+="\n\nRecent messages are preserved verbatim."`.

OCC landing sites (OCC keeps the dead branch **alive** — the exact bug surface):
- `src/services/compact/prompt.ts:341-378` (:357-359 `if (recentMessagesPreserved) baseSummary += "\n\nRecent messages are preserved verbatim."`) — delete sentence + the 4th parameter.
- `src/services/compact/sessionMemoryCompact.ts:464-469` (live caller passing `true`), `messagesToKeep` :579-581, result assembly :487-502 — add the note applier (mirror `gJt`) gated on `messagesToKeep.length>0`.
- `compact.ts:664-674` (full) / `:1110-1124` (partial): untouched (official doesn't apply the note there); `reactiveCompact.ts` is a no-op stub.
- OCC-original `Some session memory sections were truncated` (0 hits in both binaries): leave as-is.

TDD: ① RED constant byte-equals `iJt`; old sentence never emitted for any arg combination; `appendPreservedMessagesNote` mirrors `gJt` (string → `+ "\n\n" + NOTE`; array → push `{type:'text',text:NOTE}`). ② RED note applied iff `messagesToKeep.length>0`, per summary message; 4th param gone. ③ GREEN. ④ e2e: real REPL compaction with preserved tail → transcript JSONL contains the note, not the old sentence.

### §7 — `/model` effort ←/→ wrap (entry #7)

vprev `zFe` @232902886: `…return he[(Me+1)%he.length]…` (wrap = the bug, could save Low as default). vver `$0e` @234071645: `…Math.min(Ie+1,he.length-1)… Math.max(Ie-1,0)…` (clamp). Newness: modulo form 1→0; clamp form 0→1.
OCC landing: `src/components/ModelPicker.tsx:518-544` `cycleEffortLevel` (two modulo wrap returns; level array `EFFORT_LEVEL_ORDER` :545; caller :237) — currently the 292 behavior.
TDD: ① RED `src/utils/__tests__/effortWrap293.test.ts` (pattern `effortCap267.test.ts`/`effortGap97.test.ts` which already import `cycleEffortLevel`): right-at-highest stays highest; left-at-lowest stays lowest; right-at-lowest advances (regression); repeat across `includeMax`/`includeXhigh`/cap variants; audit the two existing effort tests for wrap assertions encoding 292 behavior. ② GREEN: replace both modulo returns with clamps against the built level array. ③ `bun test src/utils/__tests__` + manual REPL `/model` arrows.

### §9 — SendMessage continue-instructions gating (entry #9)

Counts: `canContinueAgent` 0→12; `continueAvailable` 0→3; `An agent cannot be continued from this context` 0→2; SendMessage-bearing lines 90→71 (removed:47 / new:28).
Gate (new_strings @19032069): `function Dw(o){return o.some((e)=>Dt(e,nr))}` with `nr="SendMessage"`; wired at vver @215955681 `H6o({…,continueAvailable:g,…})`, call sites pass `continueAvailable:Dw(e)` (e = the caller's tool table).
Prompt bullet diff (vver @215971200/@215967500, verbatim):

```js
${g?`To continue a previously spawned agent, use ${nr} with the agent's ID or name as the \`to\` field — that resumes it with full context. A new ${yt} call`
   :`A previously spawned agent cannot be continued from here. Every ${yt} call`} starts a fresh agent with no memory of prior runs…
${g?`Use ${nr} with the agent's ID or name to continue…`
   :`A previously spawned agent cannot be continued from here; every ${yt} call starts fresh`}…
```

async_launched footer (vver): `agentId: ${n.agentId} (internal ID - do not mention to user.${n.canContinueAgent===!1?"":` Use ${nr} with to: '${n.agentId}', summary: '<5-10 word recap>' to continue this agent.`})`; launch side persists `canContinueAgent:Dw(e.options.tools)`; resume reads back `!==!1` (default true). Cross-suffix for #10's context (@214643300): `SendMessage is not among the tools available here. An agent cannot be continued from this context. To message another session, use your host application's own messaging tool if it provides one; otherwise that is not possible from here.`
OCC landing (live bug surface — SendMessage is NOT dead code): `SendMessageTool.ts:535` `isEnabled(){return isAgentSwarmsEnabled()}`; `agentSwarmsEnabled.ts:24` (`USER_TYPE==='ant'` or `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` / `--agent-teams` enables; KAIROS not involved). Unconditional texts: `AgentTool.tsx:1439` (prefix), `:1479` (trailer), `prompt.ts:295` (bullets; signature :67 lacks a tools param) — call site `AgentTool.tsx:224-251` `prompt({agents, tools,…})` already has tools; pattern to copy: `:848,:1141` `canReadOutputFile = tools.some(…)`. Schema description `:106` unchanged upstream (don't touch). N-A sub-part: resume-orphan notification (`No completion record`/`orphaned_on_resume` 0 hits in OCC).
TDD: ① RED `canContinueAgent===false` → prefix/trailer contain no "Use SendMessage…to continue" but keep `(internal ID - do not mention to user.)`. ② RED `continueAvailable:false` → both official fallback sentences. ③ RED launch-side computation (mirror :848) + persistence + resume `!==false` default-true. ④ GREEN implement + thread `continueAvailable` into `getPrompt`. ⑤ e2e: swarms env on + `--tools` excluding SendMessage → spawn named background agent → assert zero continue-instructions, fallback present.

### §14 — `worker` agent naming + detail dialog title (entry #14)

Symptom A: constant `KSe="worker"` (vprev @219349200) / `eje="worker"` (vver @220326400). vprev bug (dd @219354200, verbatim):

```js
function jzn(n,{activeAgents:e}={}){if(fq(n?.subagent_type,e))return kPn;
 if(n?.subagent_type&&n.subagent_type!==xz.agentType){if(n.subagent_type===KSe)return"Agent";
 return n.subagent_type}return"Agent"}
```

vprev call sites don't even pass activeAgents (`jzn(V.data)` @231110150). vver fix @220331500 (verbatim):

```js
function dOr(n,e){if(!n||n===$1.agentType)return;if(n!==eje)return n;
 let g=e?.find((p)=>p.agentType===eje);return g!==void 0&&g.source!=="built-in"?n:void 0}
function G2n(n,{activeAgents:e}={}){if(RV(n?.subagent_type,e))return dOn;
 return dOr(n?.subagent_type,e)??\"Agent\"}
```

Only a **built-in (or unregistered)** `worker` collapses to "Agent"; a custom worker keeps its name. Wiring: renderer props gain `activeAgents` (`Oko`→`WCo` @232264100/@232264960); teammate branch `UC`→`dOr`. Counts: `activeAgents` 134→140; `source!=="built-in"` 7→8 (main-run reverified; the new hit is `dOr` @220331871). Group header text identical in both versions (`"N "+(j?`${j} agents`:"agents")+" finished"`).
Symptom B: vprev @232911840 `const eo=k.selectedAgent?.agentType??"agent"` → vver @234080600 `const to=k.selectedAgent?.agentType??k.agentType` (fallback to the task's persisted field since `selectedAgent` is cleared on finish). (The `Rr(to)` display wrapper def was not locatable — minified name collision; INCONCLUSIVE sub-detail, semantics closed.)
OCC landing (all three sites reproduce the 292 bug byte-for-byte):
- `src/tools/AgentTool/UI.tsx:767-774` (:769-770 `if (input.subagent_type === 'worker') return 'Agent'`) — OCC has **no built-in worker** (built-ins: claudeCodeGuide/explore/generalPurpose/plan/statuslineSetup/verification) so the collapse is 100% wrong here.
- `UI.tsx:869-871` `isCustomSubagentType` (≡ vprev `UC`); consumers :693/696/698; group header :749-752; `AgentTool.tsx:1387`.
- `src/components/tasks/AsyncAgentDetailDialog.tsx:102` `?? "agent"` → title :106-113; `LocalAgentTask.tsx:313/462/486` clears `selectedAgent`, persisted `agentType` :124 (spawn :529/:594) → post-finish degradation guaranteed.
- activeAgents source exists: `AppStateStore.ts:217/536`; agent defs carry `source` (`loadAgentsDir.ts:158/192/198/217`). Wiring gaps: `GroupedToolUseContent.tsx:58-61`, `Message.tsx:335`, type `Tool.ts:784-799`.

TDD: ① RED `userFacingName`: worker+user-source → `'worker'`; worker+built-in → `'Agent'`; worker unregistered → `'Agent'`; `'code-reviewer'` → itself; general-purpose/undefined → `'Agent'`. ② RED teammate branch. ③ RED group header `worker agents`. ④ RED dialog `{selectedAgent:undefined, agentType:'worker', status:'completed'}` → `worker › …`. ⑤ GREEN: `resolveAgentDisplayName` ≡ `dOr`; `userFacingName(input,{activeAgents}={})` ≡ `G2n` (OCC has no `RV` fetch-collapse path — keep current behavior, ledger-note it); thread the optional param through `Tool.ts:630/784`, `Message.tsx:335` → `GroupedToolUseContent`, `extractLastToolInfo(…, activeAgents)`; `AsyncAgentDetailDialog.tsx:102` → `?? agent.agentType`. ⑥ `bun test src` + tmux REPL e2e with `.claude/agents/worker.md`: shows **worker** at start, title still `worker › …` after completion.

### §19 — RC history re-upload after credential recovery (entry #19)

vprev @~231541000: recovery path `Nt=le||Ho` resets the initial-history-sent flag → every 401 recovery re-sends the whole starting history on an active session. vver: line deleted; promise-settle tracking + new handoff field `firstHistoryFlush:()=>Vn` (0→2); `sendSessionHistoryEvents` itself unchanged (fix is call-side).
OCC same-class bug (confirmed): `src/bridge/remoteBridgeCore.ts:575` `initialFlushDone = false` inside `recoverFromAuthFailure()` (:530-593), adjacent to `rebuildTransport(fresh,'auth_401_recovery')`; onConnect gate :391-397; `flushHistory` (:624-657) intentionally has no UUID dedup → full re-send per recovery. The v1 path is already safe (`replBridge.ts:1256`); port is confined to the v2 core.
TDD: ① RED fake transport: after initial flush completes, trigger recovery → history NOT re-sent. ② RED 401 while flush unsettled → exactly one re-send after recovery. ③ GREEN add settle state (`.finally` at :399-417), change :575 to `if(!initialFlushSettled) initialFlushDone=false`; optionally expose `firstHistoryFlush()`. ④ e2e: tmux REPL bridge session, force 401 recovery, viewer sees no duplicate history.

### §29 — Path-scoped rules + nested CLAUDE.md on Bash single-file reads (entry #29)

Official fix = thread triggers into the Bash post-exec readFileState recorder and fire on **both** paths. vprev `IEn` @215641222: 5 params, early-returns on already-recorded paths, no trigger call. vver `_Rn` @216615382: 6 params (verbatim recorded in issue comment `7b107763`): `if(n.get(z)){cRn(h,z);return}` + `cRn(h,z)` after new records; `cRn(e,n){if(e&&!AH(n,e.permissions()))MH(e.triggers,n)}`; gate `AH` @208866471 = read-deny rule hit → no trigger. Call site vver @216678800 passes `s.remoteCall===void 0&&s.nestedMemoryAttachmentTriggers?{triggers,permissions}:void 0`. The single-file command parser predates 293 (`requiresExitZero` 3→3, `batcat` 2→2) — 293 is the wiring + the already-recorded path fix. Counts: `nestedMemoryAttachmentTriggers` 15→17.

Official condition-set `TBr` @216611223 (full extraction): whole command containing `[|<>]` → reject; split on `&&`/`;`/`||` — every segment must match a handler or be benign (`/^\s*(echo|printf|true|:)\b/`); grep family only as the unique subcommand; `sed` requires `-n/--quiet/--silent`, rejects `-i`/`-e`, exactly 2 positional args, script only `/^(\d+),(\d+)p$/` or `/^(\d+)p$/`; `cat/nl/bat/batcat` flag-allowlist + exactly 1 file; `head/tail` `-n N|--lines N(=N)|-nN|-N` (0 rejected, default 10); `grep/egrep/fgrep/rg` exactly PATTERN+FILE, short flags `/^-[niwxEFGPHh]+$/` (rg: `/^-[iSswxFnNHUP]+$/`) + long-flag allowlist + `-A/-B/-C`, file names literal (`/[*?[{]/` rejected), `requiresExitZero:true`, `contentNotInModelContext:true`; recording gates: grep only on exit 0, 10MB cap, abort check, `FBr` slicing (tail → last-N-lines offset/limit).

OCC landing sites: `BashTool.tsx:478` `BASH_READ_FILE_COMMANDS=new Set(['grep','head','tail','cat'])` (**too loose** vs official), `:540-589` `markReadCommandFilesAsRead` (:578-583 — no triggers, no exit gate, no slicing), call site `:1041`. Downstream machinery all present: `Tool.ts:227`, `attachments.ts:989/:2456-2483/:1917-1987/:1838-1851`; reference implementation `FileReadTool.ts:1430-1437`.
TDD: ① RED six assertion groups: sed -n slice+trigger; **already-recorded path via cat still triggers (core bug)**; grep exit-code/unique-subcommand/glob gates; rejection surface (pipes/redirects/multi-file/`sed -i`/no `-n`/`head -0`/non-benign chains/>10MB); newly recognized forms (`sed -n`, `nl`, `bat`, `rg`, …); read-deny recorded path does not trigger. ② GREEN: replace :471-589 wholesale with the `TBr` condition set + `_Rn`-shaped signature; thread at :1041. ③ **Fidelity warning**: do NOT just `.add()` commands to the loose extractor (over-triggering) — parser tightening and trigger wiring must land in the same change. ④ e2e: tmux REPL, model runs `cat` on a file under a nested-CLAUDE.md directory → rules present in the next turn's context.

### §33 — `claude purge` silent stop (entry #33)

Official (`purgeStoppedByError` 0→3; hook @222469000 `await R(r,h,s).catch(D)`): continue deleting + collect failures; on failure print `${i.length} item(s) failed:…` + `What could not be deleted is still on disk: fix the cause and run the command again, or delete those paths by hand.` → exit 1; success → exit 0; anti-hang `Tt`: `Purge stopped before it finished: …Run the command again; \`--dry-run\` lists what is left.` → exit 1.
OCC (verified): `projectPurge.ts` `executeDeletion`:242-261 already continues (:244-249) and lists failures (:253-255) — **but the failure branch falls through to exit 0** (the only `process.exit(1)` at :183 is the mutual-exclusion guard). `deleteItem`:131-153 swallows per-item errors (no hang possible → no `purgeStoppedByError` equivalent needed).
TDD: ① RED mock fs with one throwing rm → assert the rest still deleted, failures listed on stderr, `process.exit` spy receives 1; happy path never calls exit(1). ② GREEN add `process.exit(1)` after :255; optional wording alignment + change :251 `stage:'config_write_failed'` to key off the failure code. ③ e2e: chmod-000 undeletable item → `$?`=1, others deleted, failures listed; happy path 0; `--dry-run` 0. Ledger note (not this entry): OCC lacks `-y/--yes`, the confirmation prompt, and `history-lines/history-siblings/file` entry types.

### §34 — keybindings.json space key + `ctrl+ k` warning (entry #34)

Validator vprev `He` @209294143 → vver `Xe` @210180546. Changes: (1) keystroke exactly `" "` no longer produces the empty-part error; (2) new check `g=/\s\+|\+\s/` — when a space sits next to `+` and a split part has no key: warning `A space next to "+" splits "${P}" into separate presses, and one of them has no key`, suggestion `Remove the spaces next to "+"`; (3) keystroke display truncated to 80 chars (`tc(e,I)`). Newness: all three distinctive phrases 0→2.
OCC landing: `src/keybindings/validate.ts:185-257` — the empty-part loop :189-202 currently errors on lone `" "` (292 behavior). `parser.ts:81-83` already accepts lone `" "` (2.1.251 port) — no change there.
TDD: ① RED `src/keybindings/__tests__/spaceKey293.test.ts` (pattern `misspelledModifier283.test.ts`): lone space validates with no error; `ctrl+ k` → official warning message + suggestion (assert exact text); `ctrl+k` clean; multi-space around plus still warns; >80-char keystroke truncated in the message. ② GREEN in `validateKeystroke`: `const chordParts = keystroke === ' ' ? [] : keystroke.trim().split(/\s+/)`; empty-part error gate `keystroke !== ' ' && keystroke.split('+').some(p => !p.trim())`; new warning branch `/\s\+|\+\s/.test(keystroke.trim()) && chordParts.some(p => parseKeystroke(p).key === '')`; iterate `chordParts`; add truncation helper. ③ `bun test src/keybindings` (keybindings280, sendNowBindings275 etc. stay green).

### §35 — vim `>>`/`<<` on spaces-only lines (entry #35)

vprev indent `yn` cursor placement (the bug): `let W=((M[I]??"").match(/^\s*/)?.[0]??"").length;k.setText(A),k.setOffset(mt(M,I)+W)` — on an all-whitespace line `match(/^\s*/)` returns the whole line → cursor past EOL → following `x` deletes nothing. vver `vn` uses a new grapheme-walk helper (verbatim):

```js
function $t(l){let h=0;for(let{segment:O,index:x}of ba().segment(l))if(h=x,O!==" "&&O!=="\t")break;return h}
```

All-whitespace line → index of the **last** grapheme (cursor stays on the line). Newness: `segment(l))if(h=x` 0→1; `match(/^\s*/)?.[0]??"").length` **3→0** — all three official sites converted (normal indent `yn`→`vn`, visual indent `po`→`go` with `j=$t(W[L]??"")`, multi-line indent `go`→`ho` with `W=$t(k[M]??"")`). Companion placeholder-aware helpers `_o`/`Eo`/`In` don't port (OCC vim has no placeholder support — `placeholderStartingAt|snapOutOfPlaceholder` 0 hits in src/vim).
OCC landing (exact 292 pattern, 2 sites): `src/vim/operators.ts:419` in `executeIndent` (:380-424) `const firstNonBlank = (currentLineText.match(/^\s*/)?.[0] ?? '').length` → :422 `ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank)`; and `:1241` in `executeVisualIndent` (:1193-1246) → :1242. OCC already has `$t`-like semantics in `firstNonBlankOffsetInLine` (operators.ts:489-496: `idx === -1 ? Math.max(start, end - 1)`) — reuse the pattern.
TDD: ① RED `src/vim/__tests__/vimIndent293.test.ts` (pattern `vimOperators281.test.ts`): `>>` on spaces-only line keeps cursor on line (last grapheme) and following `x` deletes one space (arrange `"a\n   \nb"`, assert offset = middle-line-start + 4 after indent to 5 spaces); `<<` same; `>>` with leading spaces → first non-blank (regression); visual-line `>` on spaces-only line; `>>` on empty line → line start. ② GREEN: add `firstNonBlankGraphemeIndex(line)` (Intl.Segmenter walk per `$t`), replace both `match(/^\s*/)` sites. ③ `bun test src/vim`. Pre-existing gap noted (no action): official `executeVisualIndent` records `{type:"visualIndent",dir,count,lines}` in both versions; OCC records nothing.

### §36 — vim V+d cursor + `.` repeat (entry #36)

Dispatcher identical between versions (vprev `bo` ≡ vver `vo`: `getVisualRange` → span → apply → `st(ctx,{type:"visualOp",op,span,linewise})`) — the record shape is unchanged; the fix is two real diffs:
(a) Linewise-delete cursor: vprev `ho` ends `let W=Math.max(0,P.length-(S$(P).length||1));O.setOffset(Math.min(A,W))` (plain clamp; 1→0). vver `bo` (0→1, verbatim):

```js
let U=O<x.text.length,W=x.text.slice(0,L)+x.text.slice(O);x.setText(W);
let K=U?h:Rt(W,W.length),j=W.indexOf(`\n`,K),z=j===-1?W.length:j,
    B=mi.fromText(W.slice(K,z),x.cursor.measuredText.columns+1),
    q=_o(B,U),ye=!U&&B.placeholderStartingAt(q)!==null;
x.setOffset(ye?f7(W,W.length):K+q)
```

Semantics: base = deletion start when text remains after the deleted range, else start of the last line (`Rt` = `lastIndexOf('\n',…)` line-start); slice that logical line; cursor = base + first-nonblank (`_o`, `$t`-based). `f7(l,h)` snaps a newline/EOF offset back to its line start. Placeholder branch N/A for OCC.
(b) Dot-replay guard: vprev `if(M===I)return` → vver `if(I===k&&!(O&&x.text.length>0))return` (0→1) — a linewise replay proceeds even when the span-derived range is empty, as long as text exists → `.` acts on the cursor's line.
OCC landing: `src/vim/operators.ts:862-884` `executeVisualOperator` linewise-delete branch (`const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1)); ctx.setOffset(Math.min(start, maxOff))`); `:960-969` `replayVisualOp` (`if (range.from === range.to) return`); `lastChangeUpgrade.ts` unchanged.
TDD: ① RED `src/vim/__tests__/vimVisualDelete293.test.ts` (patterns `vimOperators281.test.ts`, `vimDotRepeat.test.ts`): V+d lands on first non-blank (`"aa\n  bb\ncc"` delete line 1 → offset 2, old clamp gives 0); V+d to buffer end → first non-blank of last line (`"x\n   ind"` → offset 3); linewise dot-replay with empty span range acts on cursor's line when text exists, no-op when empty; charwise empty-range guard unchanged (regression); end-to-end `V+d`, move, `.` deletes the cursor's line. ② GREEN: replace the clamp with hasTextAfter/base/line-slice/first-nonblank (share the #35 `$t` helper; skip the placeholder branch); guard → `if (range.from === range.to && !(linewise && ctx.text.length > 0)) return`. ③ `bun test src/vim` (incl. lastChangeUpgrade + vimDotRepeat regressions). Port order: #35 before #36 (shared helper); #7/#34 independent/parallel.

### §38 — REVERT of the 2.1.281 auto-mode denial guidance (entry #38) — **OCC ported the reverted text; revert is mandatory**

Newness (main-run reverified): `This denial applies to the outcome` s292:**2** → s293:**0** (removed:2); `Concretely, these all count` 2→0; `If this was a batch or range operation` 1→0; `If this denial names something that would clear it` 1→0. Offsets: vprev @98344044/@211664044, constants @211664576; vver 0 occurrences.
Builder diff (sole delta = `${Qat}` + preceding space deleted):

```js
// vprev ier (dd @215722700): g=`${r}${e}. If you have other tasks that don't depend on this action, continue working on those. ${s} ${Qat}`
// vver  fnr (dd @216697200): g=`${r}${e}. If you have other tasks that don't depend on this action, continue working on those. `+s
```

Stop suffix byte-identical between versions. **Full post-revert (2.1.293) template:**

```
Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.
```

(plus, only when `allowRuleToolName` and the session gate pass: ` To allow this type of action in the future, the user can add a permission rule for ${toolName} to their settings.`) **Not in revert scope:** the 281 #137 dangerous-rm builder (unchanged 2→2) — do not touch.
OCC surface: `src/utils/permissions/autoModeOutcomeGuidance.ts` (:32/:39/:43-48 — byte-identical to vprev `C0n/x0n/Qat`); sole non-test consumer `src/utils/messages.ts:23` (import) + `buildYoloRejectionMessage` :381-405 (injection :387-394; :390 has a trailing space, :394 the guidance). OCC current text == vprev; vver == OCC minus guidance minus the :390 trailing space.
Revert plan (TDD-ready):
1. RED first: assert the vver-exact text (no trailing space after the stop suffix, no guidance); `.not.toContain("This denial applies to the outcome")`; with `{allowRuleToolName:'Bash'}` → base + single space + hint.
2. GREEN: `messages.ts` — delete the :23 import, the :394 guidance, the :391-393 comments, and the :390 trailing space; :398-404 untouched; update the doc comment to "2.1.293 #38: official `fnr` revert (`Qat` deleted, vver byte-verified)". Delete `autoModeOutcomeGuidance.ts` entirely.
3. Tests: in `autoModeOutcomeGuidance281.test.ts` delete describes ①② (6 tests); **migrate** describe ③ (dangerous-rm, 3 tests — still live in 293) to a new file before deleting the original; adjust `yoloRejectionAllowRuleHint288.test.ts` :24/:70/:94/:97 and `denialSuffixSplit268.test.ts` :8/:84-85/:95 (mind the trailing-space shift).
4. Sweep: `grep -rn "OUTCOME_SCOPE\|autoModeOutcomeGuidance\|applies to the outcome" src/ docs/` → zero live references; `bun run check:unused`; `bun test src/utils/permissions src/utils/__tests__` green; REPL e2e triggering an auto-mode denial asserts no guidance and ends with the stop suffix.
5. Do NOT touch: dangerous-rm `$0t` builder, `DENIAL_WORKAROUND_GUIDANCE_BASE`, `AUTO_MODE_STOP_SUFFIX`, the 288 rule-hint gate, `buildClassifierUnavailableMessage` (vver `f2t` unchanged).

### §46 — ASCII-first sort for agent lists + announced MCP servers (entry #46)

New comparator, vver @204175795 (verbatim; absent in vprev — `ZCe(` 0→7 unique lines):

```js
var f=/^[\x00-\x7f]*$/;function ZCe(t,n){let e=f.test(t);if(e!==f.test(n))return e?-1:1;
 if(e)return t.localeCompare(n);if(t===n)return 0;return t<n?-1:1}
```

(vprev `\x00-\x7f` regex hits are unrelated path validators; a second `function ZCe` @235079407 is a name-collision decoy.) Call sites switched vprev→vver (6): mcp_instructions_delta pool builder @214429076 (`ke.sort((xe,Ie)=>ZCe(xe.name,Ie.name))`; vprev used `localeCompare`); agent merge (6-layer Map dedup) @214472660 (`sort((V,Y)=>ZCe(V.agentType,Y.agentType))`); duplicate-agent conflict report @214473391; MCP-instructions token estimator `kFo` @214491391; MCP client error/status delta @214506311 (the adjacent `revoked` list **stays** localeCompare — out of announced-to-model scope); `agent_listing_delta` @216012902 (`H.sort((Y,he)=>ZCe(Y.agentType,he.agentType)),z.sort()`). Verified unchanged (localeCompare): MCP tool-map sort, workflow sort, hostName/serverName sorts, skills sorts, fs listing, themes, revoked servers (`localeCompare` count 133→128).
OCC landing: `src/tools/AgentTool/agentDisplay.ts:97-103` `compareAgentsByName` = `a.agentType.localeCompare(b.agentType, undefined, {sensitivity:'base'})` (callers `cli/handlers/agents.ts:268`, `components/agents/AgentsList.tsx:36`); `src/utils/attachments.ts:1656` agent_listing_delta (`added.sort(…localeCompare…)`, :1657 `removed.sort()` matches official); `src/utils/mcpInstructionsDelta.ts:124` (`added.sort(…localeCompare…)`, :128 matches); `src/tools/AgentTool/loadAgentsDir.ts:214-242` `getActiveAgentsFromList` — same 6-layer dedup but returns **unsorted** values feeding `prompt.ts:220` `effectiveAgents.map(formatAgentLine)` ("Available agent types…"). N-A in OCC: official sites 3/4/5 (no equivalents). Leave `tools.ts:389` + `commands.ts:825` on localeCompare (not in the switched set).
TDD: ① RED `src/utils/__tests__/asciiFirstCompare293.test.ts`: comparator contract from `ZCe` verbatim — `('abc','abd')<0` (locale path), `('abc','日本語')<0`, `('日本語','abc')>0`, `('日本語','アイウ')>0` (code-unit), equal → 0, mixed-case ASCII keeps localeCompare semantics. ② RED: agent_listing_delta `['zeta','日本語-agent','alpha']` → `['alpha','zeta','日本語-agent']`; mcp_instructions_delta `['b-server','Ünicorn','a-server']` → `['a-server','b-server','Ünicorn']`; `getActiveAgentsFromList` returns ASCII-first sorted values. ③ GREEN: export `compareNamesAsciiFirst` (next to `compareAgentsByName`), rewrite `compareAgentsByName` to use it (note: `ZCe` drops the `sensitivity:'base'` option — mirror the binary), apply at attachments.ts:1656, mcpInstructionsDelta.ts:124, loadAgentsDir.ts:241. ④ Suites + e2e with a non-ASCII agent + MCP server, verify system-reminder ordering in an `occ -p` transcript.

### §47 — OTEL at_mention 100-event cap (entry #47)

`tengu_at_mention_unreported` 0→2 (new). The literal `"claude_code.at_mention"` appears in neither binary (name composed by the emitter; vver `xX` ≡ vprev `sH`).
vver @~216024405 (verbatim):

```js
function _Pr(e,n){let r=epn(e);if(r.length===0)return[];return Xfn("agent",r.length),
 r.map((g,h)=>{let S=g.replace("agent-",""),w=n.find((H)=>H.agentType===S);
  if(!w)return Ix(h,"agent",!1),null;return Ix(h,"agent",!0),
  {type:"agent_mention",agentType:w.agentType}}).filter((g)=>g!==null)}
// MCP resolver SPr: Xfn("mcp_resource",g.length) then g.map(async(w,H)=>{...Ix(H,"mcp_resource",bool)...})
var q5e=100;
function Ix(e,n,r){if(e>=q5e)return;
 if(n==="agent")i(r?"tengu_at_mention_agent_success":"tengu_at_mention_agent_not_found",{});
 else i(r?"tengu_at_mention_mcp_resource_success":"tengu_at_mention_mcp_resource_error",{});
 xX({mentionType:n,success:r})}
function Xfn(e,n){if(n>q5e)i("tengu_at_mention_unreported",{mention_type:d(e),count:n-q5e})}
```

vprev @~215050104: `Gxr`/`qxr` emit unconditionally per mention — no cap, no overflow event. Semantics: cap is **index-based** (`h >= 100` → no emit); one shared constant `q5e=100`; `Ix` gates **both** the statsig event and the OTEL emit; overflow reported once per resolver call with `count = length-100` only when `length > 100`; file/directory mention emits untouched.
OCC landing: `src/utils/attachments.ts:2022-2031` `logAtMentionOtel` (uncapped); `processAgentMentions` (~:2220-2250) unconditional pairs at :2232-2238 (no index param); `processMcpResourceAttachments` (~:2253-2325) six unconditional pairs at :2267-2268, :2275-2276, :2285-2286, :2295-2296, :2307-2308, :2313-2314. Unchanged: file/directory sites (:2184, :2213, :3413).
TDD: ① RED `atMentionOtelCap293.test.ts`: 100 agent mentions → 100 success emits; 150 → exactly 100 + one `tengu_at_mention_unreported {mention_type:'agent', count:50}`; same for mcp_resource; mixed success/not_found within first 100 keeps per-mention names; index ≥100 emits neither statsig nor OTEL; ≤100 → no unreported event; file/directory unaffected. ② GREEN: `const AT_MENTION_OTEL_CAP = 100`; add index to both `.map()` callbacks; single helper mirroring `Ix` (gates `logEvent` + `logAtMentionOtel` together); `Xfn`-equivalent overflow reporter once per resolver before mapping. ③ Attachments suite + behavioral e2e (`occ -p` prompt with >100 `@agent:` mentions, OTEL exporter stubbed, assert counts).

---

## STAGED details

### §STAGED-6 — Queued-message carry on `←` backgrounding (entry #6)
Missing in OCC: the entire `←` defer/fork foundation — gesture state machine (`zzn`), controller, via-decision `d(e)` (detach / idle-fork / defer-then-fork with 10s cap / abort-then-fork) — plus the carried-prompts subsystem: gate `iL(){return T("tengu_left_arrow_carries_queued",!0)}` @233542295, refusal text `_Pe` @233544466 (verbatim: `Cannot open agents — ${h} queued ${I(h,"message")} can't move to the background. Press ← again once Claude has read ${h===1?"it":"them"}.`), classifier `CPe` (`{leftEarlier,beingRead,carriable,stranded,fileContents}`), writer `TPe` (carried-prompts file into the job dir), receiver `xPe` (`CLAUDE_BG_CARRIED_PROMPTS_SHA256` + validations `too_old/future_dated/job_has_run/no_row`, re-enqueue as `{value,uuid,…,mode:"prompt",priority:"next",origin:{kind:"human"},skipSlashCommands:!0}`). All 0→2 new strings. vprev fork `oPe` @232385684 has zero carry logic (292 blocker was the hard refusal "would be lost. Run or clear it/them first.", present in both versions). OCC's left arrow = FleetView entry (`FleetViewScreen.tsx:112,131`) + discard-confirm gate (`messageActionsLeftArrowGate.ts:27`); backgrounding = Ctrl+B immediate. **OCC-side observation (not a faithful port — needs product decision):** `REPL.tsx:2717-2766` only forwards `mode==='task-notification'` queued items when backgrounding (:2724) — queued user messages are dropped (same-class loss surface). When the `←` subsystem is ever ported, #6 (and the #26/#27 guards) must ship in the same change.

### §STAGED-40 — Team/Enterprise policy prefetch (entry #40)
293 delta over 292: (a) hedge gains `stillWanted:h=()=>!0` guard (count 5→11); (b) resolve fix `I(M&&!A.ok?{ok:!0,value:M.value}:A)`; (c) main change: env opt-in → **default-on with remote kill-switch** `E$t` @221197538: `if(Pe()!=="firstParty"||!Of()&&MO()===void 0)return!1;return!T(Ue,!1)` (`Ue="tengu_managed_config_prefetch_off"` 0→2). The 3s stalled retry (`delayMs:s=3000`) already exists in 292 (@218211334). No new log strings → gate/guard-level delta; "fetched earlier" = the prefetch path (60s freshness cache, both versions) now reached by default — bootstrap reordering not provable from strings.
OCC applicability (not N-A): two network fetches exist but only sequential retries — `remoteManagedSettings/index.ts:56-57,:213-246`, `policyLimits/index.ts:61,:378-402`; hedge surface 0 hits; `auth.ts:2257` self-documents "inflight/prefetched fields OCC does not have".
Missing before a RED test can be written: ① the pre-292 hedge+prefetch architecture itself (`afr` race semantics, 60s cache, `{hedge,prefetched}` threading through both fetchWithRetry call chains); ② `Of()/MO()` org-context predicates (cross-chunk imports — need one more chunk-import-table pass); ③ kill-switch channel decision (OCC has no remote-flag equivalent: env-only vs flag service); ④ the "earlier" ordering has no string anchor. Startup-latency optimization, not a correctness fix.

### §STAGED-43 — Bash edit diff note wording (entry #43)
Wording swap extracted verbatim (vprev @94452618, 2→0): `(what this command changed; a convenience view, not a review or audit of the command)` → (vver @94469505, 0→2): `(files that changed while this command ran, by the command or by another process; a convenience view, not a review or audit of the command)`. (The changelog phrase "while the command ran" differs from the shipped string — 0/0 hits.) OCC lacks the host feature: `diff` 0 hits in `BashTool/UI.tsx`; `convenience view`/`what this command changed`/`treeMoved` 0 hits in src. STAGED not N-A because the base machinery exists (`fileHistory.ts`, 1596 lines, serving undo/checkpoint; `BashTool.tsx:407-408` sed-edit interception). Unblocking condition: port the official Bash edit-diff view as a feature (snapshot → changed-file list → per-file diff, incl. `treeMoved`/`moreFiles`/`(file diff unavailable …)` edge states) landing in `BashToolResultMessage.tsx` + `BashTool.tsx`, adopting the 293 wording at birth; a wording-only change has no line to land on.

---

## N-A details (grouped, with absence proofs)

**Mods / plugin `$` engine — #3, #21, #22, #23 (4).** OCC `src/plugins/` = `builtinPlugins.ts` + `bundled/index.ts`; no `$.tool.register`, no `$.session.append`, no `mock.session`, no `classic.*` hook events, no `plugin test` / `plugin eval` subcommands (all 0-hit greps). Official deltas archived in the binary for any future plugin-engine round (#3: `isDeferred:false` lists the tool schema in-prompt from the start instead of behind tool search).

**Claude Tag / Slack — #49–#55 (7).** No Slack runtime; `install-slack-app` is an openBrowser stub; `Claude Tag|claudeTag` 0 hits.

**Code Review cloud service — #56 (1).** `Add a repository` 0 hits; OCC `/code-review` is a separate local surface.

**Cloud sessions / remote-review upload / RC backend — #16, #17, #18, #39, #42 (5).** ultrareview handler is eligibility-only (113 lines, no packing/upload; refusal strings 0 hits); viewer-away slowdown never implemented in OCC (fixed 100ms flush = post-#18 behavior); no cloud-session sleep/wakeup (#39 revert has nothing to revert); #42 message is cloud-only.

**Dormant flag-gated tool — #20 (1).** PushNotificationTool registered behind `feature('KAIROS')||feature('KAIROS_PUSH_NOTIFICATION')` (`tools.ts:50-53`), neither in `FEATURE_ALLOWLIST`; message string 0 hits. Revival predicate (`CLAUDE_CODE_ENVIRONMENT_KIND==="bridge"` && !childSession) archived above.

**Agents bypass offering absent — #25 (1).** See table row; official 293 consent flow archived @222552154.

**`←` backgrounding / fleet-sessions-folder subsystem absent — #13, #26, #27, #28 (4).** OCC backgrounding is Ctrl+B-immediate; FleetView/footer counts are in-memory (no sessions readdir anywhere in components). Official keep-last-good mechanics (transient set EBUSY/EMFILE/ENFILE/EAGAIN/EINTR + Win EPERM; fleet cap `bm=15`; nudge cap 3; `Czn` null-wrapper @219006400/@223191600) archived for the eventual `←` port. **Hardening candidate (OCC-original, product decision):** `workerRegistry.ts:118-131` `readDaemonStatus()` double `catch→[]` blanks daemon rows for one poll cycle on transient fs errors — same class as #13/#28; draft: transient-classify → keep-last-good ≤3 strikes, ENOENT/bad-JSON still `[]`.

**Typed-vs-paste segmentation + skill-mention gating absent — #30, #31 (2).** See table rows; official 293 implementations (`Ior/Zw` two-pass span finder @211428807; `EKe` combining-mark-tolerant KMP @234279495; queued-prompts schema `inline`/`slashNameOnly` @233542644) archived for any future port.

**/feedback drafts list absent — #32 (1).** Linear flow, no drafts; official drafts subsystem byte-stable 292↔293.

**Tool hint-builder subsystem absent — #10 (1).** OCC returns bare `No such tool available`; official vver gated wording (`. ${e} is not among the tools available here. Continue with the tools you have.` vs the session-disabled sentence) archived @214643300.

**subagentStatusLine subsystem absent — #2 (1).** Prereq checklist if ever built (STAGED as a whole): settings key `subagentStatusLine {type:"command"}` (policy-aware), 5s tick/300ms debounce loop, full payload envelope incl. `agentType` (OCC task state already carries it — `LocalAgentTask.tsx:124`), `CLAUDE_PROJECT_DIR` env, 5000ms timeout + `preserveOutputOnError`, JSONL `{id,content}` validation + the three error logs (`subagentStatusLine emitted invalid schema: …`), `taskDecorations` store slice, tokenSamples cap 16.

**Auth-kick suppression — #12 (1).** OCC commands are local-only; no GrowthBook kick exists to suppress.

**MCP HTTP wrapper already leak-free — #5 (1).** OCC `cleanup()` removes the abort listener on both paths; optional cosmetic rewrite to the `AbortSignal.any` form is alignment-only, not a bug fix.

**/tui chrome lifecycle — #8 (1).** OCC /tui saves settings for next boot; chrome wiring is boot-only.

**Chrome extension-side fix — #41 (1).** Not in the CLI binary (0-hit phrases in both versions).

**Artifacts publishing absent — #15, #44 (2).** No Artifact tool (`unprintable` 0 hits; ReviewArtifactTool has no publish stream).

**claude.ai skill sync absent — #11, #45 (2).** No sync loop or remote skill descriptions in `src/skills/`.

**Windows service seam out of scope — #37 (1).** Linux/macOS-first; OCC's only win32 kill branch (`processTreeKill.ts:263-266`) is guarded by the exitCode/signalCode pre-check; residual risk ledgered for any future Windows round.

**Self-hosted runner stubbed — #48 (1).** `src/self-hosted-runner/main.ts` = 3-line generated stub; official jitter is a constant-5s → uniform-4–6s sleep change in the orchestrator poll loop (no OCC loop exists).

---

## Cross-entry notes

- Minified identifiers churn between builds (`GG→s2`, `qxr→SPr`, `Gxr→_Pr`, `sH→xX`, `YL→F1`, `Av→Nv`, `Le→Me`, `ier→fnr`, `He→Xe`, `yn→vn`, `ho→bo`, `jzn→G2n`); every load-bearing claim above is anchored to byte offsets + string counts, not identifier names.
- One INCONCLUSIVE sub-detail: #14 symptom-B vver `Rr(to)` display wrapper not located (minified name collision); the semantic fix point (`?? k.agentType`) is closed.
- Suggested implementation order (disjoint file clusters, parallelizable): wave 1 = #38 (revert, smallest & mandatory) + #33 + #7 + #34 + #35→#36 + #47 + #46; wave 2 = #4 + #14 + #9; wave 3 = #1 (Haiku 5.5, largest); wave 4 = #29 (largest behavior fix, needs the fidelity warning heeded) + #19. STAGED #6/#40/#43 await their unblocking conditions; #28-hardening is an OCC-original product decision.
- No src/ files were modified and no git commands were run during this research round.
