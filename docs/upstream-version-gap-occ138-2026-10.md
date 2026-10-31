# Upstream version gap — OCC-138 round (official claude-code 2.1.312 → 2.1.314)

Date: 2026-10-31 · Trigger: OCC Leader first-baton order (comment `b9d1d80e`) · Issue: OCC-138
Method: `upstream-tracking` + `aligning-with-official-binary`. Official ELF全程只做
`strings`/`grep -aboF`/`dd` 字节取证，**never executed as a model backend**（occ136 §11.5 纪律）。

## §1 Version facts (three-way verified, 2026-10-31)

| Source | Value |
|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.314** (published 2026-10-30T00:12:56Z); `stable` = 2.1.308 |
| npm `versions` list | …2.1.311, **2.1.312**, **2.1.314** — **2.1.313 was NEVER published** (`npm view @anthropic-ai/claude-code@2.1.313` → E404) |
| Official GitHub tag `anthropics/claude-code` | `refs/tags/v2.1.314` exists ✓ |
| OCC pre-round | package.json **2.1.407**, tracks **2.1.312** (OCC-137 round, release `ca588dda`) |
| v312 linux-x64 ELF | 293,592,432 B, md5 `be77f401c2b9c1c79c98f828abe8a6e7` (== occ136 README badge ✓) |
| v314 linux-x64 ELF | 298,229,464 B, md5 `5ea08c5120a3a4204a9e2dc9a7c2c886`, sha256 `4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594` |
| v314 tarball sha256 | `c6b690e52ba2d038c4c8d2566b2ec35acef4995c4321f7d57fa464a7088c2b78` |
| strings diff (`strings -n 8 … | sort -u`) | v312 348,317 uniq / v314 350,703 uniq → **21,688 added / 19,302 removed** |

**Verdict: REAL version gap 2.1.312 → 2.1.314** (single published step; 2.1.313 skipped upstream).
Leader's initial read confirmed by direct npm/GitHub/binary measurement. This is a **port round**,
not a pure self-acceptance round. Forensics scratch: runtime workdir `scratch-occ138/`
(v312+v314 unpacked + `s312.txt`/`s314.txt`/`added.txt`/`removed.txt`), **用完即删** at closeout.

## §2 Changelog scope

`## 2.1.314` is a **large** release: ~120 bullet entries spanning terminal-agent fixes, cloud
sessions, VS Code, Remote Control, Claude Tag (Slack), and gateway/Bedrock/Vertex/Foundry backends.
The overwhelming majority are **N-A** to OCC (no Anthropic backend, no cloud/VCCode/Slack/Remote
Control surface, plugins/marketplace removed). The terminal-agent-relevant subset is triaged below.

Triage key: **PORT** (landed this round) / **PARTIAL** / **STAGE** (surface exists but needs
dedicated per-site forensics or is a broad behavioral change — deferred with evidence) /
**NO-OP** (OCC already consistent) / **N-A** (backend/cloud/VSCode/Slack/gateway/Desktop surface
OCC does not ship).

## §3 Full changelog triage (2.1.314, ~120 entries)

### §3.A PORT work packages (this round)

| # | Changelog entry | WP | Class |
|---|---|---|---|
| 93 | `FORCE_HYPERLINK=false` (also `no`/`off`) turns hyperlinks **off** instead of on | A | PORT ✓byte-verified |
| 86 | Bash tool shell clears inherited `which` alias/function; stops passing exported `which`/`unsetenv` functions | A | PORT |
| 94 | macOS: `git grep` in Claude-run commands uses the C locale (regex memory-leak avoidance) | A | PORT |
| 22 | PreCompact hook with very large output no longer fails/repeats compaction; each hook's output cut at **10,000 chars** | B | PORT |
| 89 | hook `if` conditions such as `Monitor(tail *)` match the Monitor tool's shell commands as `Bash(tail *)` matches Bash's | B | PORT |
| 33 | hooks matching Bash run on Monitor-tool shell commands; they can block/ask but **not** approve/rewrite | B | PORT |
| 66 | `~/.claude/skills/.trash` (and `plugins/.trash`) capped at ~**1024** entries regardless of `cleanupPeriodDays` | C | PORT |
| 62 | skill file watcher no longer re-checks every removed skill kept in `.trash` (filesystem load grew per removal) | C | PORT |
| 30 | `sandbox.excludedCommands` setting description now says **every command in a call must match an entry** (not "always run outside the sandbox") | D | PORT ✓ |
| 32 | sandbox protections now apply to a worktree entered by `claude -p --resume`/`--continue` | D | **STAGED — NOT PRESENT AT RUNTIME** (re-annotated from PARTIAL per the 2.1.408 acceptance review P2-1): rebuild block ported byte-exact (adapter, 12 tests) but has NO production call site, and none can be faithfully wired today — print resume never enters worktrees (official `LWe` worktree-binding is a PRE-EXISTING OCC gap, `worktree_resume_refused` in v312 too), interactive startup restores the worktree BEFORE sandbox init (config built fresh vs worktree cwd → nothing stale to rebuild; `isSandboxActiveForResume()` false at that point), and the mid-session `/resume` co-occurrence is outside official `YF` startup scope. Gate `tengu_anchored_lantern` defaults off regardless. Sandbox-resume protection recorded as PENDING in CLAUDE.md security divergences; see §3.B STAGE row + §7 + the adapter's STAGED block comment |
| 6 | `claude -p` no longer exits 0 with no output on startup failure; prints the error and exits **1** | F | PORT |
| 61 | sessions no longer stay untitled when the first prompt failed (e.g. usage limit) and the conversation continued | F | PORT |
| 78 | session auto-title: a session starting with a skill / prompt-based command (e.g. `/security-review`) gets a title from it | F | PORT |
| 70 | Ctrl+R prompt history now matches text inside collapsed `[Pasted text]` pills | F | PORT |
| 47 | blank lines at the top of a code block no longer disappear when the block opens a quote | E | PORT |
| 48 | no blank line above some `⎿` rows in the transcript view (Ctrl+O) | E | PORT |
| 24 | markdown tables no longer jump between grid/stacked layouts on half-typed rows while streaming; long tables no longer fall back to raw pipes | E | **NO-OP (grounded)** — official fix lives entirely in the v314 4096-char chunker `Kgo` @273643200 (openTable state); OCC's StreamingMarkdown has no chunker (block-boundary stablePrefix), so both symptoms are structurally impossible; characterization test pins it (§7) |

### §3.B STAGE (surface exists, needs dedicated forensics / broad change — deferred with evidence)

| # | Entry | Why staged |
|---|---|---|
| 1 | `permissions.blockWritesOutsideWorkingDirectories` (Write/Edit/NotebookEdit refuse paths outside working dirs in every mode) | New cross-cutting permission setting touching every file-tool permission path in all modes; needs its own byte-verification pass + a dedicated regression matrix. High-value — top next-round candidate. Forensics started (§5.1). |
| 41 | Model IDs spelled with a **dot** behind an LLM gateway (`claude-opus-4.8`) treated as older model (wrong context window/output/effort/thinking/cost) | Touches `src/utils/model/` capability resolution (context window, output limit, effort, thinking, cost). Relevant to OCC's custom-gateway usage but needs careful per-field forensics to avoid regressing the model ladder. Staged with forensics (§5.2). |
| 23 | Background diff refreshes briefly take the repo index lock (`.git/index.lock`), racing concurrent git commands | Needs forensics of the official's lock-free refresh mechanism; OCC's diff-refresh path differs. |
| (32-pre) | Print-mode worktree binding on resume: official `YF` restores the session's worktree cwd in `-p --resume/--continue` (`LWe` + refuse reasons `worktree_unverified`/`worktree_resume_refused`/`worktree-gone`, `WUn`/`tbo` messages, `S=r.persist&&!fl()` binding-clear logic) | PRE-EXISTING gap (present in v312 strings too — not a 312→314 delta). OCC's print `loadInitialMessages` never calls `restoreWorktreeForResume`; only interactive paths do. Until ported, the 2.1.314 sandbox-rebuild block (item 32, adapter already landed + tested) stays dormant — no call site exists in ANY mode (interactive startup enters the worktree before sandbox init, so its config is never stale; review P2-1). Needs its own round: full `LWe` subsystem byte-verification + refuse-path matrix. |
| 49/53/54 | vim: `dw`/`dW`/`yw`/`yW` past EOL + `w`/`W` stop on empty lines; `p` over charwise selection honoring linewise yank; `aw`/`iw` taking the trailing line break | OCC has a real vim engine (`src/vim/`); each fix needs per-motion byte-verification + OCC-vim behavior A/B. Staged (occ44 §3d precedent — vim fixes need per-site decompilation). |
| 84 | File tools ask before editing the local copy of the org's server-managed settings | Security-positive; needs forensics of the managed-settings path guard + OCC's file-tool permission wiring. |
| 34 | A settings file excluded with `--setting-sources` still supplies some settings (auto-mode rules, saved permission consents) | Needs forensics of which setting classes the official gates behind `--setting-sources`; OCC's setting-source plumbing differs. |
| 21 | Last broken reply + retry prompts staying in the conversation after Claude gave up on an unparseable tool call | Conversation-state cleanup; needs transcript-mutation forensics. |
| 31 | Blocked shell/MCP calls (auto mode / deny rule / PreToolUse) reading as if they ran in a collapsed tool group | Tool-group render state; needs forensics of the collapsed-group "ran" indicator. |
| 25/59/79 | /resume picker showing CLAUDE.md text as a slash-only session's title; deleted session reappearing as near-empty; `--resume` speed/memory on damaged transcripts | Resume-picker subsystem; staged as a cluster for a dedicated round. |
| 27 | Pasting an image over SSH to Linux doing nothing silently → prompt to copy the file and paste its path | Image-paste UX; needs clipboard/SSH-path forensics. |
| 51/52/55/56/57/58/63 | paste-loss in question dialog / footer-selected row; ↓ selecting hidden footer items; Esc on a command panel also interrupting an open subagent; fullscreen welcome model; rewind "Restore conversation" scroll; /rename name disappearing during permission/plan prompt | Interactive-UI micro-fixes; each needs render-layer forensics. Staged as a UI cluster. |
| 60 | Prompts containing tags (`<bash-stdout>`, `<local-command-stdout>`) not acknowledged to a local stream-json host | stream-json host ack; needs protocol forensics. |
| 64 | Background sessions failing to start reported as a deleted daemon binary when the binary is on disk | OCC daemon error-message path; staged. |
| 67 | Bash edit diff listing a whole CRLF file as changed on unchanged re-save under git line-ending conversion | Diff/CRLF handling; staged. |
| 69 | Memory: parent no longer keeps each subagent's tool results until turn end (long headless/SDK turns) | Memory/architecture change in the query loop; staged. |
| 12 | `claude mcp logout` reporting success when the sign-in was not removed (macOS keychain locked over SSH) | MCP OAuth simplified in OCC; staged. |
| 19 | "Continue automatically at usage limit" continuing >3× when a task restarted itself between waits | /goal + auto-continue interplay; staged. |
| 72/73/74/87 | /permissions "Recently blocked" rename + footer; auto-mode blocked-call message wording; permission-prompt long-reason rows; Recently blocked refusing unreadable calls | /permissions + auto-mode UI cluster (LIVE surfaces); staged for a dedicated UI round with render forensics. |
| 39 | `--resume`/rewinding past a model switch after a refusal moving an unrecognized-model session to a different model | resume/rewind + model-resolution; staged (couples to item 41). |
| 45 | WebFetch in Cowork cloud sessions dropping PDF text past 100,000 chars → says how much unread | Cloud-session scoped; OCC WebFetch PDF-limit parity needs forensics. |
| 83 | bundled dataviz skill: y-axis tick full-print thresholds; donut/pie → ranked/segmented bars | OCC `dataviz` is a command stub; skill-content port needs the bundled-skill decision (OCC-31 trim). |
| 10/40/91/92/5/9/11/18/20/46/50/65/68/71/77/80/81/85 | TLS cross-signed root; beta-header retry; flagged-request model retry; idle compaction; effort-cap retry; tool_reference retry; MCP signed-out fallback; forceRemoteSettingsRefresh; Ultracode bg; Esc/Stop command-may-have-run; agent-panel x/Enter; push-notification tip; self-hosted runner idle/branch; /design-sync prompt; /config agent view; /context 10k-MCP speed; /ultrareview trust | Backend/cloud/rollout-gated or niche-perf; each needs dedicated forensics or is N-A-adjacent. Staged. |

### §3.C N-A (OCC does not ship the surface — no action)

- **Cloud sessions** (10 entries: scheduled-tasks Include-completed, self-hosted recent envs, uncommitted-changes-every-turn, env-details dialog scroll, permission-mode picker, plugins in cloud, GitHub Enterprise test-connection, transcript rename/table rows, setup-script-error start, cloud-session model call) — OCC has no claude.ai cloud-session surface.
- **VS Code extension** (7 entries: Clear-authentication, spinner/Stop while hooks run, session-group save error, Cmd+F plan preview, Ctrl+D dictation non-Latin, missed scheduled-task deletion, `CLAUDE_CODE_DISABLE_CFC_PROMPT`) — OCC is terminal-only.
- **Claude Tag / Slack** (7 entries) — N-A.
- **Remote Control** (idle notice, stray "Compacted" row, permission-mode button, model-switch >8s, worker-registration retry) — N-A.
- **Claude apps gateway / Bedrock / Vertex / Foundry** (groups list, `guardrail_trace`, Vertex upstream hang, deprecated Desktop key warning, Bedrock many-images, Foundry model fallback, Bedrock/Vertex upgrade offer, model-upgrade-offer managed pin) — backend gateway surfaces N-A.
- **claude.ai / Team / Enterprise login** (shared-profile sign-in renewals, MDM vs remote base-URL/apiKeyHelper, /upgrade App Store/Google Play, /config agent-view, cloud-session error auth-login suggestion) — N-A.
- **Plugins / managed plugin settings** (model switching refused on broken plugin manifest) — plugins/marketplace removed (CLAUDE.md OCC-31).
- **Skills content .md** (/claude-api Datadog `dd-llmobs-enabled` + ant install xattr; claude-api Managed-Agents read-first) — OCC skill `.md` files are intentional stubs (OCC-31).
- **VS Code / Claude Desktop idle compaction (item 4), Claude Desktop admin TLS trust (item 15)** — Desktop/VSCode surfaces N-A.
- **Cowork cloud auto-mode MCP-hook allow (item 88)** — cloud N-A.

## §4 PORT work-package plan (parallel subagents, disjoint file clusters)

- **WP-A** env + Bash shell: items 93 (`src/ink/supports-hyperlinks.ts`, `src/utils/envUtils.ts`), 86 + 94 (`src/tools/BashTool/` shell env / git grep).
- **WP-B** hooks: items 22, 89, 33 (`src/utils/hooks/`, Monitor-tool hook integration).
- **WP-C** skills trash + watcher: items 66, 62 (`src/skills/`, trash util).
- **WP-D** sandbox: items 30 (`src/entrypoints/sandboxTypes.ts` desc), 32 (`src/tools/BashTool/shouldUseSandbox.ts` / sandbox setup worktree -p resume).
- **WP-E** markdown/transcript render: items 47, 48, 24 (`src/utils/markdown.ts`, message rendering).
- **WP-F** session lifecycle: items 6, 61, 78, 70 (print mode, session title, PromptInput history).

Each WP byte-verifies the official 2.1.314 logic from `scratch-occ138/v314/package/claude`
(`grep -aboF` + `dd`), implements faithfully (never invent), adds unit tests (≥95% of the changed
logic) + behavioral e2e on the built artifact where feasible, and runs its own targeted tests.

## §5 Forensics notes (byte-verified this round)

### §5.1 FORCE_HYPERLINK (item 93) — ✓ byte-verified, PORT confirmed

Official v314 outer wrapper `ZWe` (@259538525 region) vs v312 `tje` (@254921754):

```js
// v312 tje — BUG: any set FORCE_HYPERLINK returns stdoutSupported (ignores value)
function tje(r){let n=$u()?.hyperlinks;if(n!==void 0)return n;
  if("FORCE_HYPERLINK"in(r?.env??process.env))
    return r?.stdoutSupported??O.default.supportsHyperlink(process.stdout);
  return}
// v314 ZWe — value-aware: falsy string OR numeric-zero → OFF
function ZWe(r){let n=_u()?.hyperlinks;if(n!==void 0)return n;
  let i=(r?.env??process.env).FORCE_HYPERLINK;
  if(!i)return;                              // unset/empty → no override, fall through to detection
  return !(os(i)||parseInt(i,10)===0)}       // os = /^(0|false|no|off)$/i-style falsy parser
```

`os` falsy set byte-confirmed: the binary carries `^(0|false|no|off)$` / `^(?:0|false|no|off)$`
(s314.txt lines 8762-8763) — matches OCC's existing `isEnvDefinedFalsy` (`['0','false','no','off']`,
`src/utils/envUtils.ts:39`). OCC's current `supports-hyperlinks.ts:35-38` mirrors the **v312**
parseInt-only logic → `FORCE_HYPERLINK=false` returns TRUE (bug). PORT: reuse `isEnvDefinedFalsy`.
The inner `supports-hyperlinks` npm module (`T`/`m`, parseInt-to-0) is **unchanged** v312↔v314 —
only the outer override wrapper changed. (Implementation + tests in §7.)

### §5.2 Model dot-gateway (item 41) — forensics started, STAGED

(Deferred pending per-field byte-verification of the context-window/output/effort/thinking/cost
resolution for dot-spelled model IDs behind a gateway; see §3.B.)

### §5.3 sandbox.excludedCommands description (item 30) — v312 baseline captured

v312 `excludedCommands.describe(...)`:
`"Command patterns (Bash permission-rule syntax) that always run outside the sandbox. A convenience, not a security boundary: excluded commands still go through the permission flow. Merged across settings sources. "+gt`
v314 wording to be byte-extracted at the WP-D site before edit. (OCC already enforces the
"every part must match" **behavior** — `sandboxExcludedCommandsEveryPart277.test.ts` — this round
aligns the **description text**.)

## §6 Discipline reminders

- Official ELF is read-only forensics material — never executed as a model backend.
- No invented caps/fallbacks/heuristics (aligning-with-official-binary). Every PORT byte-verified.
- e2e = behavioral (built `dist/cli.js`, tmux REPL, `occ -p`), not source-grep (behavior-driven-done).
- No sub-issues (Leader 执行纪律); all work in this issue via comments + subagents.

## §7 Implementation results

All PORT items landed via 6 work packages (WP-A by the lead agent; WP-B/C/D/E/F by 5 parallel
subagents under the aligning-with-official-binary discipline — every behavior byte-verified from
the v314 ELF with `grep -aboF`+`dd`, offsets recorded; official binary never executed).
TDD RED→GREEN per item. Full per-item official snippets with offsets are in the issue comments
(WP-D `ac67ee5f`, WP-E `37fcf562`, WP-F `8260e72a`) and in code docstrings.

### WP-A (lead) — item 93 FORCE_HYPERLINK ✓ IMPLEMENTED
- `src/ink/supports-hyperlinks.ts`: v312 `in env` check (any set value → ON) replaced with the
  value-aware v314 `ZWe` semantics: empty/unset → fall through to detection; set →
  `!(isEnvDefinedFalsy(v) || parseInt(v,10)===0)`. `isEnvDefinedFalsy` ≡ official `os` @243469354.
- Tests: `src/ink/__tests__/supportsHyperlinksForce314.test.ts` 9/9 (RED 5-fail first);
  no regression in rawHyperlinkSanitize295 + stripRawHyperlinks295 (16/16).

### WP-B — items 22/89/33 ✓ IMPLEMENTED (all three)
- **22**: `PRECOMPACT_HOOK_OUTPUT_CHAR_LIMIT = 10_000` (official `WPt=1e4` @245625586, cut logic
  `v0e` @256502723; absent in v312) in `src/utils/hooks.ts` + exported `cutPreCompactHookOutput`.
  Tests: preCompactOutputCap314 8/8 + real-child-process 2/2.
- **89**: `preparePermissionMatcher` added to MonitorTool (official def @260931165 shares Bash's
  `Gjr` matcher @257927607; `$Fr` command extractor @253917406; all NEW vs v312). Tests:
  monitorIfCondition314 10/10 (incl. `if:'Monitor(tail *)'` getMatchingHooks e2e).
- **33**: NEW `src/utils/hooks/monitorFamily314.ts` — byte-exact ports of `$Fr`/`hz`/`vU`/`cnt`/
  `wxe`/`e0t`/`Pxn`/`jN` (offsets @253917406–256637701, all 0-hit in v312); `hooks.ts` wires
  family matching (both-flags gate), the Monitor if-condition guard (verbatim skip log), the
  "asBash" stdin variant, and the allow-strip at the official position (deny/ask survive,
  updatedInput stripped). Tests: monitorFamilyHooks314 32/32. Regression batch 473/473 (37 files).
- Live-behavior note: tree-sitter sits behind the dead TREE_SITTER_BASH flag → rule-content
  matchers fail safe `()=>true` at runtime (identical to BashTool's existing live behavior).

### WP-C — items 66/62 ✓ IMPLEMENTED
- **66**: NEW `src/utils/skills/syncTrashTrim.ts` — full port of official `Ymo` algorithm
  (constants `FDt=3, jmo=1024, RBe=604800000` @253720840; trim entry `L$r` @253721134;
  `sync_trash_trim` analytics; oldest-first eviction down to 1024; 3 generations per tag;
  7-day window protection). Wired into `src/utils/cleanup.ts` OUTSIDE the cutoff guard
  (official placement — cap applies regardless of `cleanupPeriodDays`). All markers 0-hit in
  v312. plugins/.trash leg = N-A (OCC-31). Tests: skillsTrashCap314 7/7 + behavioral smoke
  (1100 seeded → 1024 remain, `{"messages":76,"errors":0}`).
- **62**: `skillChangeDetector.ts` — official watcher `ignored:` delta @263295061 vs v312
  @258787631 is exactly one added line: first-path-segment-relative-to-user-skills-root
  `=== ".trash"` → ignore. Ported as exported `shouldIgnoreWatchPath`. Tests:
  skillWatcherTrashSkip314 8/8. Regression 72/72.

### WP-D — items 86/94/30 ✓ IMPLEMENTED, item 32 PARTIAL (see §3.A/§3.B)
- **86**: `bashProvider.ts` — official `ZSn`/`Jwr`/`eTr` @256154751: gated `which` unalias+unset-f
  (`tengu_swirling_koala`) + unconditional `unsetenv` cleanup, inserted at the official preamble
  position (@256158096: extglob → which → unsetenv → git-grep prefix → eval); bonus extglob
  `NO_BARE_GLOB_QUAL` alignment (present in BOTH v312+v314 official, missing in OCC). Windows-SRT
  third leg N/A (no OCC subsystem).
- **94**: NEW `src/utils/shell/gitGrepLocale.ts` — full port of `TSn`/`kwr`/`ESn`/`w2o`
  (@256139001–256139513, @251810800–251813000; v312 zero hits): `git` shell-function wrapper
  rewriting `git grep` to `'/usr/bin/env' LC_ALL=C 'git' …`, all decision gates (non-macos,
  >1000 chars, non-ASCII, parse failures, bare assignments, envVars, `-P/-f/-O` regex
  `/^(?:--p|--op|--textc|-[A-Za-z0-9]*[OPf])/`) byte-verified.
- **30**: `sandboxTypes.ts` excludedCommands describe → v314 wording @244324279 (every-part
  matching + forced-sandbox call shapes); 282 suffix unchanged (v312≡v314 byte-identical).
- **32**: adapter side complete — `sandbox-adapter.ts` exports gate/2000ms-bound/error-message
  (official @122721011 verbatim)/`shouldRebuildSandboxOnWorktreeResume`/
  `refreshSandboxConfigForResumedWorktree` (official `YF` block @282198200 byte-verified by lead:
  `if(!y&&ve()!==h&&kVt()){await Re(ui().catch(()=>null),sG); if(bn(oG,{safe:!0})){…refreshConfig()
  → m(…,"rebuild_failed") → as(msg) → mi(1) … g("sandbox_resume_rebuild")}}`; `sandbox_resume_rebuild`
  0 hits in v312). Caller wiring NOT applied: official site is print-mode-only and OCC's print
  resume never restores worktrees (pre-existing `LWe` gap, §3.B "32-pre"); interactive wiring
  would deviate. Tests: sandboxResumeRebuild314 12/12; batch 438/438 + downstream 202/202;
  also repaired 3 pre-existing mock-leak test files (shellSandboxOuterSpawn309 etc.).

### WP-E — items 47/48 ✓ IMPLEMENTED, item 24 grounded NO-OP
- **47**: official v314 hoist detector `Ve`/`ELt` @259564600 (recursive visual-emptiness) vs
  v312 `Ye` @254948700; consumer `(E?L:L.replace(/^\n+/,""))` @273639700 vs v312 unconditional
  strip @268881500. Ported to `markdownBlockquote.ts` (`hoistQuoteOpeningBlock`) + gated strips
  in `markdown.ts` / `Markdown.tsx`. Tests: quoteCodeHoist314 + markdownQuoteLead314 19/19.
- **48**: official delta = relevantMemories rows `marginTop:zW>0?1:0` @277872944 vs v312
  unconditional `marginTop:1` @274973531 → `CollapsedReadSearchContent.tsx`
  `marginTop={memoryIdx > 0 ? 1 : 0}`. Second delta (`ended-` wrapper) N/A — no OCC counterpart.
  Tests: collapsedRelevantMemories314 3/3 + gap114 regression 30/30.
- **24**: ALREADY-ALIGNED — fix lives in the v314 chunker `Kgo` @273643200 (absent from v312
  `Plo` @268885400); OCC has no 4096-char chunking (stablePrefix advances at block boundaries),
  so layout flips/raw-pipe fallback are structurally impossible. Pinned via characterization
  test markdownTableLayout314 4/4 (porting `openTable` would require inventing the chunker).

### WP-F — items 6/61/78/70 ✓ IMPLEMENTED (all four)
- **6**: OCC gap = missing the official print-dispatch catch `Po(J,re,…).catch((O)=>Eo(J,O,x))`
  (@~263635900, present in BOTH versions); `main.tsx` had bare `void runHeadless(…)`. Added
  `.catch` → `endHeadlessSessionOnEscapedError` (print.ts: `buildErrorDuringExecutionResult` +
  `reportHeadlessFailure`, official `GXe` @282197560 / `as` / `$N` @248624922 / `jFe` @248626066).
  Behavioral evidence: `-p "hi" --resume-session-at …` (no --resume) → stderr
  `Error: --resume-session-at requires --resume`, EXIT=1; happy path EXIT=0. Tests:
  printStartupExit314 5/5.
- **61**: three-way `requestSessionTitle` + `TitleFallback` (2 unusable replies) + failed→
  preserve+retry; official `nin` @261924458 / `Uht` @261925003 / `B3` @246467524.
- **78**: `isMeaningfulTitleText` + shared surrogate-safe `truncateText` (official `ne`/`hQt`
  @243462231) — skill/prompt-command first message now yields a title.
- **70**: `Ix=32768` pill-content search bound, `uKo` pill expansion, official match predicate,
  `M1e` cursor placement → Ctrl+R matches inside `[Pasted text]` pills.
  Tests (61/78/70): sessionTitleRequest314 + sessionTitleInput314 + historySearchPills314 →
  95/95 across WP-F's 4 files; existing print suites 47/47; REPL suites 84/84.

### Central verification (lead)
- Biome: 45 changed/new src files → 0 errors; 11 warnings all pre-existing in main.tsx at HEAD
  (verified by linting `git show HEAD:src/main.tsx`).
- Full `bun test` suite + `bun run build` (dist/cli.js 30.62MB): results in §8.


## §8 e2e / acceptance evidence

### §8.1 Canonical test gate — `scripts/ci-test.sh` (per-file bun processes)

Result: **15,221 pass / 6 fail / 12 skip**. All 6 first-pass failures triaged to zero net regressions:

| # | Failure | Verdict | Resolution |
|---|---|---|---|
| 1 | `monitorDeadline272.test.ts` — `ReferenceError: Cannot access 'MONITOR_TOOL_NAME' before initialization` (safetyEvent.ts:297) | REGRESSION (this round) | WP-B's new `MonitorTool → bashPermissions` import created a cycle back through `safetyEvent`. Fixed by extracting the const to a dependency-free leaf `MonitorTool/toolName.ts` (repo convention: `BashTool/toolName.ts`, `PowerShellTool/toolName.ts`). 28/28 + toolPermission 6 files green. |
| 2 | `monitorDeadlineGate.test.ts` — same TDZ | REGRESSION (same root) | Same `toolName.ts` fix. |
| 3 | `version-2.1.111-env.e2e.test.ts` F17 — `FORCE_HYPERLINK` empty string expected `true` | STALE (v312 contract) | v314 official (`ZWe` @259538525) is value-aware: falsy → fall-through to detection. Updated the e2e to the v314 contract (empty→false). 18/18 green. |
| 4 | `version-2.1.200-tools-stream.e2e.test.ts` H1 — source-grep pinned `MONITOR_TOOL_NAME` in `MonitorTool.ts` | STALE (const relocated) | Updated to assert the leaf module `toolName.ts` + the `MonitorTool.ts` re-export. Green. |
| 5 | `commands-behavior.e2e.test.ts` `/feedback` (54 s) | FLAKE | Isolated re-run 16/16 green; the test's real GitHub issue auto-closed; no dangling issues left today. |
| 6 | `argumentSubstitutionCaps301.test.ts` — "budget covers named-arg values too" didn't throw | PRE-EXISTING | Clean-HEAD `git worktree` A/B → identical 11 pass/1 fail. Test + source + direct deps untouched this round. Known bun-1.3.14 local artifact (CI pins 1.4.2). |

Net: 2 fixed (Monitor TDZ) + 2 stale-tests-updated (v314 contract) + 1 flake-green + 1 pre-existing-proven = **0 regressions**.

### §8.2 Real-model tmux REPL — human-like task matrix (glm-5.2 via dashscope gateway)

All green against `dist/cli.js`:
- Trust dialog → `fib.py` Write + Bash round-trip → prints **55** (real model, auto-mode auto-approve).
- Ctrl+O transcript view — `⎿` rows with PostToolUse hooks + rules rendered (item 48 spacing).
- Ctrl+R history search "fib" — matched a real prompt (item 70 pill-content path exercised).
- `/status` dialog — Version, Session ID, gateway URL, MCP row.
- Shift+Tab — cycles auto → manual → accept-edits → plan → auto.
- Manual-mode Edit permission dialog with diff view → approve → disk verified (`# e2e manual mode`).
- Blockquote `▎ Example:` with hoisted code lines (item 47) + boxed table (item 24 NO-OP characterization).

### §8.3 Headless `-p` (real model)

`echo "say PONG…" | dist/cli.js -p` → **PONG**, exit 0. Noted a pre-existing `unrecognized_model glm-5.2 query_source:sdk` title-model notice (non-blocking — the title model resolution is a separate gateway-eligibility path; recorded here for honesty, not a 2.1.314 regression).

### §8.4 Official v314 surface comparison (never executed as backend)

- `--version`: OCC + official both exit 0.
- `--help` flag sets: official-only flags (`--cloud --desktop --environment --permission-prompts --permission-prompt-tool --restricted --system-prompt-snapshot --teleport`) are identical in the v312 help → pre-existing documented trims, **not** 2.1.314 regressions.
- Official v312↔v314 `--help` diff = **1 line** (the `auto-mode` description) → ported to `main.tsx` (byte-verified `Inspect or reset auto mode configuration` ×2 in the v314 ELF; v312 had `…classifier configuration` ×2).
- item-6 arg-error path: official v314 `--resume-session-at` without `--resume` → EXIT=1, stderr `Error: --resume-session-at requires --resume` — **byte-identical** to OCC dist.

## §9 Release

- CHANGELOG `## 2.1.408 - 2026-10-31 (OCC-138 — …)` + `package.json` 2.1.407→**2.1.408** + README badge/anchors → 2.1.314 (partial).
- Round commit `d0092e82` (`feat(2.1.314): OCC-138 alignment round — official 2.1.312→2.1.314`), pre-commit biome hook passed (0 errors on the changed set).
- `main` fast-forwarded `284c6bfa → d0092e82` (push `d0092e82:refs/heads/main` — the local `main` branch is pinned by another task's worktree, so an ff push was used instead of checkout+merge; history identical).
- Tag `v2.1.408` → pushed. `publish.yml` npm step **failed as expected** (run 41145527883, 21 s — NPM_TOKEN E404 debt, OCC-127/129; same pattern as v2.1.405–407).
- Manual release created per precedent: **https://github.com/cnwenf/occ/releases/tag/v2.1.408** (`gh release create v2.1.408 --generate-notes`, marked Latest).
- Releases == tags parity verified (v2.1.403…v2.1.408 all present in both lists).
- Residual branches cleaned: `agent/occ/10476a32` (local+remote) and remote `agent/occ/1f430df2` deleted after merge.
- Post-release smoke on the shipped build: `--version` → `OCC 2.1.408` exit 0; `--resume-session-at` without `--resume` → official-byte-identical stderr + exit 1; headless `-p` → PONG exit 0; `--help` auto-mode row = `Inspect or reset auto mode configuration`.


## §10 2.1.408 acceptance-review fix round (OCC-138 review P2/P3 — post-release, pre-re-verify)

Code review of the v2.1.408 release (head `50118c1d`, base `284c6bfa`) returned verdict **COMMENT**:
3 P2 + 4 P3 findings + 2 human-verify items. All dispositions below; fixes land on `main` as an
amend-in-place of the 2.1.408 section (NO version bump/tag until re-verify passes — issue release
flow = release AFTER acceptance).

### §10.1 P2 dispositions

- **P2-1 (item 32 sandbox resume-rebuild = dead code)** → **re-annotated, option (b): NOT PRESENT
  AT RUNTIME**. `refreshSandboxConfigForResumedWorktree` + `SANDBOX_RESUME_REBUILD_GATE` +
  `SANDBOX_RESUME_REBUILD_ERROR_MESSAGE` have ZERO production call sites (grep-verified) and none
  can be faithfully wired today: (1) print-mode resume never enters worktrees — the official `LWe`
  worktree-binding subsystem is a pre-existing gap; (2) interactive startup restores the worktree
  BEFORE sandbox init, so the sandbox config is built against the worktree cwd and the wired call
  is a provable no-op (`isSandboxActiveForResume()` false); (3) mid-session `/resume` co-occurrence
  sits outside the official `YF` startup-check scope. Wiring anyway would invent behavior
  (forbidden by `aligning-with-official-binary`). Item 32 re-annotated PARTIAL→**STAGED** in §3.A
  row 32, §3.B "32-pre", the CHANGELOG 2.1.408 bullet, the adapter's STAGED/DORMANT block comment,
  and CLAUDE.md security divergences ("Sandbox-resume worktree protection is PENDING" — acceptance
  consequence recorded: a resumed session that changes cwd does NOT get rebuilt sandbox
  protections in any mode until the `LWe` round lands). Exports kept warm (12 tests) for the
  `LWe` round. Gate `tengu_anchored_lantern` defaults false upstream regardless.
- **P2-2 (hook `if:` command-content narrowing non-functional in production)** → **honest
  annotation + production-truth test; argv-splitter replacement REJECTED**. Root cause confirmed:
  `TREE_SITTER_BASH`/`TREE_SITTER_BASH_SHADOW` are not in the 6-flag `FEATURE_ALLOWLIST` →
  `parseCommandRaw` null → `parseForSecurity` = `'parse-unavailable'` for every real command →
  tool `preparePermissionMatcher` fail-safes to `() => true`. A hand-rolled argv-splitter was
  considered and rejected: it cannot guarantee no false-negatives on real shell syntax
  (quotes/globs/`;`-chains), and a false-negative UNDER-fires block/ask hooks — violating the
  fail-closed ethos; the official itself only narrows through the tree-sitter parse. Fixes:
  (a) CHANGELOG items 33/89 reworded — family **NAME** matching (Monitor↔Bash) is live and
  structural; parenthesized **command-CONTENT** narrowing is wired-dormant pending tree-sitter;
  fail-safe direction stated (hook KEPT, over-fires, never under-fires). (b) PRODUCTION DORMANCY
  comments at the two seams: `MonitorTool.preparePermissionMatcher` + `prepareIfConditionMatcher`
  (hooks.ts). (c) `monitorIfCondition314.test.ts` header/describe re-labelled "MOCKED parse seam —
  exercises the official Gjr narrowing LOGIC"; its "drops the hook" assertion holds only with a
  working parser. (d) NEW unmocked `monitorIfConditionProduction314.test.ts` pins production truth:
  `parseForSecurity` → `'parse-unavailable'`; Monitor matcher → `true` for every command pattern;
  ws-only input still `false` ($Fr gate live without parser); `getMatchingHooks` KEEPS
  `if 'Monitor(git *)'`/`'Monitor(tail *)'`/`'Bash(git *)'` hooks on a Monitor command call,
  DROPS `WebFetch(git *)` (tool-NAME half live). Header notes assertions MUST flip if tree-sitter
  is ever allowlisted. Recorded in CLAUDE.md security divergences; tree-sitter WASM in release
  builds = pending platform decision (review Human-verify #2).
- **P2-3 (CHANGELOG item-70 bullet contained literal `[Pasted text` → warm-cache What's-new top-3
  would render it verbatim and break `test/e2e/version-2.1.239-keybinding-flavor.e2e.test.ts:167`
  `not.toContain("[Pasted text")`)** → **reworded**: bullet now reads "…折叠在粘贴 pill（Pasted text
  占位符）内的原始文本" — static-verified `grep -c '\[Pasted text'` over the 2.1.408 section = **0**
  (the two hits at lines ~1697/1700 live in the OLD 2.1.239 section, outside the top-3 window).

### §10.2 P3 dispositions

- **P3-1 (cleanup.ts:747 discarded `cleanupSkillsTrashCap()` tally)** → FIXED: `{messages, errors}`
  captured; `logForDebugging` summary emitted when `errors > 0` (official folds the tally into its
  sweep collection `w` via `x(r,…)`; OCC's sweep returns void, so the call site consumes it).
- **P3-2 (REPL.tsx title site always passed `queueSkipSlashCommands: undefined`, wiring untested)**
  → FIXED via extraction + tests + **recorded divergence (this note)**. Investigation settled: the
  OCC message surface genuinely does not carry the flag — `QueuedCommand.skipSlashCommands`
  (textInputTypes.ts:393) is consumed at DISPATCH gating (`isSlashCommand()` in
  messageQueueManager.ts:568, handlePromptSubmit exit-word/immediate gates, processUserInput
  `effectiveSkipSlash` bridge-safe override) and is never stamped onto the persisted `UserMessage`.
  Threading it through would be a cross-cutting change (processUserInput chain + new JSONL field)
  disproportionate for a P3 edge. So: `titleInputFromDispatchedMessage(message, commands)`
  extracted into `src/utils/sessionTitleInput.ts` (the dispatched-message → official-`uzn` mapping,
  unit-testable without mounting the REPL), REPL.tsx call site swapped to it, 6 wiring tests added
  to sessionTitleInput314.test.ts. **Recorded divergence (official derives from the QUEUE ITEM
  where the skip flag is visible; OCC derives from the rendered post-dispatch message where it is
  not → `undefined` → `dispatchesSlashCommands=true`):** the first title-eligible message from a
  skip-flagged bridge/CCR dispatch whose text leads with `/` can be titled by OCC where the
  official skips it. Prose behavior identical; non-human origins still filtered by `zMr`'s
  isHumanOrigin gate. One test pins the divergence explicitly (DOCUMENTED DIVERGENCE case).
- **P3-3a (official `Ac`/`WIe` secret-pattern scan missing from `isSensitiveTitleInput`)** →
  RECORDED as accepted divergence in CLAUDE.md (SEC-1 Low): the Anthropic-internal pattern DB is
  not extractable byte-faithfully; direction — OCC may title from `!command`/`/cmd args` text
  containing a secret where official suppresses; title text stays local to session metadata.
- **P3-3b (item 94 macOS git-grep LC_ALL wrapper unreachable in production)** → CHANGELOG line
  reworded to "wired, dormant" + `gitGrepLocale.ts` PRODUCTION DORMANCY docstring paragraph:
  `parsed?.kind !== 'simple'` gate fed by parse-unavailable → always null → wrapper never
  installed — fail-closed (`git grep` runs exactly as today). Same tree-sitter root cause as P2-2.
- **P3-3c (item-6 test asserted main.tsx SOURCE STRING only)** → FIXED: real subprocess test added
  to printStartupExit314.test.ts — spawns the REAL CLI (`bun src/entrypoints/cli.tsx -p …
  --resume 00000000-0000-4000-8000-000000000000`, isolated HOME/CLAUDE_CONFIG_DIR/cwd, dummy key;
  the resume load failure fires before any network/auth — deterministic, offline, ~1.5 s): text
  format → exit **1** + stderr `No conversation found with session ID: …` + empty stdout;
  stream-json → exit **1** + `error_during_execution` result line with `is_error:true` + errors
  array. The source-string test is KEPT as the wiring pin (it proves the escaped-rejection
  `.catch(endHeadlessSessionOnEscapedError)` attachment specifically). Suite 7/7.
- **P3-4 (hooks.ts dedup keep-LAST + family-flag edge)** → FIXED: `dedupeMatchedHooks()` collision
  rule replaces all five `Array.from(new Map(…))` keep-LAST constructions (command/prompt/agent/
  http/mcp_tool): last-wins is preserved (settings scope-merge semantics) EXCEPT a
  `throughFamilyOnly` entry never displaces a non-family entry under the same `hookDedupKey` —
  replicating the official `!Se(dn,L,h)` outcome (hooks that already matched directly are excluded
  from the family-only downgrade) regardless of matcher order. Insertion-position semantics
  identical to `new Map(entries)`. Tests: 5 added to monitorFamilyHooks314.test.ts (dual
  `Monitor`+`Bash` matchers both orders → single survivor, NO family flags; Bash-only → still
  flagged; direct Bash call → unflagged; ws-only Monitor call → direct matcher only). A/B
  verified: removing the guard fails exactly the direct-first ordering test (35/1), restoring it
  passes 36/36.

### §10.3 Human-verify items (recorded, pending)

1. **SEC-2**: `tengu_anchored_lantern` gate defaults false upstream — sandbox-resume protection
   recorded as PENDING in the acceptance decision (CLAUDE.md bullet + §3.A row 32 STAGED).
2. **TREE_SITTER_BASH absence** is a pre-existing platform limit (WASM not carried in release
   builds) — recorded in CLAUDE.md as a pending platform decision; P2-2/P3-3b dormancy
   annotations all point at it.

### §10.4 Release handling

Fixes committed on top of `50118c1d` and fast-forwarded to `main`; the v2.1.408 tag is NOT moved
and NO 2.1.409 is cut until 验收员 re-verify passes (issue release flow: release AFTER acceptance).
The CHANGELOG 2.1.408 section is amended in place so the raw-feed → warm-cache What's-new surface
serves the corrected text immediately (P2-3 e2e assertion safe).

**Release outcome (2026-10-31, post re-verify).** 验收员 independently re-ran the probes and passed
the round (RE-VERIFICATION PASS on head `83511430`; one immaterial correction recorded: the 2
remaining paste-pill literals outside the feed window sit in the **2.1.309** section — lines
1697/1700 — not the 2.1.239 section as the fix-round comment said; neither is inside the
`getRecentReleaseNotesSync(3)` top-3 window, so P2-3 is unaffected). 2.1.409 was then cut per the
issue release flow: release commit `f004aba4` (CHANGELOG `## 2.1.409` section — zero bracket
literals, feed-safe — + package.json bump) ff-pushed `83511430..f004aba4` on `main`; tag
`v2.1.409` → `f004aba4` pushed; publish.yml run 41164690193 built green and failed at the npm
Publish step with the known `E404 PUT @cnwenf%2focc` NPM_TOKEN debt (OCC-127/129 — not a
regression; v2.1.407/v2.1.408 runs identical), so the `if: success()` Create GitHub Release step
was skipped and the release was created manually (`gh release create v2.1.409 --generate-notes`):
https://github.com/cnwenf/occ/releases/tag/v2.1.409. Parity verified: 208 remote v2.1.* tags ==
208 GitHub Releases, zero missing. v2.1.408 tag untouched at `d0092e82`. Post-release docs commit
folds in the reviewer's LOW note: README.md 3× count wording `PARTIAL 1` → `STAGED 1` (item-32
re-annotation linkage; zh-CN/en READMEs unaffected).
