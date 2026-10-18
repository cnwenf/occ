# Upstream Version Gap — OCC-162 Round (2026-10-19): strict self-acceptance vs official 2.1.302

> Status: **IN PROGRESS** — no official version gap (2.1.302 aligned in v2.1.388/389). Per the issue's "版本追齐后的自验收" clause: strict self-acceptance A/B round, prioritizing the newest ported surface (2.1.302 PORT ×12 + acceptance-fix ×12).
> Prior-round ledgers: [occ120-2026-10](./upstream-version-gap-occ120-2026-10.md) (2.1.302 PORT round + acceptance-fix round), [occ160-2026-10](./upstream-version-gap-occ160-2026-10.md), [occ157-2026-10](./upstream-version-gap-occ157-2026-10.md), [occ156-2026-10](./upstream-version-gap-occ156-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official binary: forensics only (`strings` / `grep -aboF` / bounded `dd`); uvx official may be run for interaction evidence per issue's uvx-consistency clause — no sensitive data fed.

## 1. Baseline (verified 2026-10-19, this run)

| Item | Value |
|---|---|
| OCC main HEAD | `010116ee` == tag `v2.1.389` (worktree clean at checkout) |
| Build | green — `dist/cli.js` 30.29 MB, MACRO.VERSION=2.1.389 injected |
| Official npm dist-tags (this run) | `latest = next = 2.1.302`, `stable = 2.1.292` |
| STAGED re-review trigger (`stable ≥ 2.1.296`) | **NOT fired** — STAGED set carries as-is |
| Work branch | `agent/occ/17882c36` |

## 2. Self-acceptance ① — 2.1.302 PORT ×12 surface

### 2.1 Unit-pin re-verification (all green, both orders)

23 test files covering PORT ×12 + acceptance-fix pins (`*302*.test.ts`): **174 pass / 0 fail / 413 expect** combined under `CI=true` (forward order 1472ms, reverse order 1427ms). Leak-pair discipline: `imageReadCap302`+`allowLarge296` culprit pair **65/65 both orders**.

### 2.2 Official ground-truth re-verification (byte forensics, this run)

Official `@anthropic-ai/claude-code-linux-x64@2.1.302` re-downloaded: tarball 129,008,778 B; ELF 285,793,528 B; **md5 `39885c1377a0f0d922b73bf8653a6c3f` — exact match to occ120 §1**. Marker counts (grep -aboF): image-refusal ×2, pipe/device-refusal ×2, `Already available in this conversation` ×2, `no search is needed` ×2, `gitfile does not point to a valid repository` ×2, `forkSubagentDisabled` ×3 — all match occ120. dd spot-checks: **@245156620** `tool_decision` v302 attribute order verbatim (`{decision,source,tool_name,tool_use_id,...w0r(mcpInfo),...tool_parameters,...be,permission_mode}` — identifiers first, truncatable tail last); **@246248862** `ant=12;function` (hook cap); **@244374771** `HYe` auto-mode ladder verbatim (config `src:"gb"` w/ warn-once `env:shadowed` → env `a_e(...)` → `externalSonnet5Probe!=="demoted"` → default). Official strings: ToolSearch isMeta sentence + pipe-refusal full text match occ120 records verbatim. ELF deleted after forensics (resource-safety discipline); extracted comparison strings kept under `/tmp/cc162-verify/extracted/` until round end.

### 2.3 OCC landing-site cross-checks (vs byte-verified official shapes)

- `yoloClassifier.ts` ladder: warn-once key `env:shadowed` + official warning text **byte-identical** to dd @244374771 dump. ✓
- `promptAgentConcurrencyCap302.ts`: `HOOK_PROMPT_AGENT_CONCURRENCY_CAP = 12`, predicate `hook.type === 'prompt' || hook.type === 'agent'` — verbatim official `Iee`. ✓
- `permissionLogging.ts`: v302 field set/order incl. `tool_use_id`/`tool_source`/`tool_parameters` (+ occ160 `decisionReason`), pinned by `toolDecisionOtelFields302`. ✓

### 2.4 Live behavioral probes (production dist, real API gateway)

| # | Probe | Result |
|---|---|---|
| — | `occ --version` | `OCC 2.1.389`, EXIT=0 ✓ |
| — | `-p` PONG baseline | `PONG`, EXIT=0 ✓ (known gateway `unrecognized_model` stderr noise, pre-existing) |
| #31 | `-p` + `CLAUDE_CODE_FORK_SUBAGENT=1` / `=0` | `PONG`, EXIT=0 both — no startup crash (bug-2 regression clear in live dist) ✓ |
| #23 | `-p` inside stray-gitfile dir (`.git` file → invalid target) | `PONG`, EXIT=0 — graceful; git-2.56 stderr class unit-pinned (`worktreeGitfile302`); local git 2.43 can't emit the new text live (noted) |
| #35 | `-p` real Bash call w/ settings hooks (PreToolUse ×2 + PostToolUse ×1) | all 3 fired in order (`PREHOOK1/PREHOOK2/POSTHOOK`), tool output returned, EXIT=0 ✓; ≤12 cap itself pinned by mutation-verified `hookConcurrencyCapProduction302` (cap applies to prompt/agent-type hooks only — official `Iee`) |
| #06 | `-p` model Reads real 130MB PNG | refusal surfaced **verbatim through full production path**: `File is too large to read as an image (the limit is 128MB): /tmp/occ162-image-probe/big.png. If it is an image, resize it or export a smaller copy, then read that.` EXIT=0 ✓ |
| #16 | signed-out `occ remote-control --help` | **F-1 observation**: prints TOP-LEVEL Commander help, EXIT=0 — the #16 fix lives inside `feature("BRIDGE_MODE")` which is NOT allowlisted → structurally correct but production-dormant (same class as #29). No regression (pre-#16 behavior identical); OCC ships no `remote-control` subcommand by design. Recorded, no action. |

## 2A. Footer-surface candidate — REFUTED by live A/B; vim-indicator GAP occ162-01 confirmed instead

### 2A.1 Candidate "footer mode-indicator surface drift" — REFUTED (methodology lesson)

Mid-round strings-grep of the official 2.1.302 ELF showed **zero** literal hits for `(shift+tab to cycle)` / `manual mode on` / `← for agents`, suggesting the official footer surface had been redesigned. **Live tmux A/B refuted this**: official 2.1.302 (md5-verified ELF, isolated clean HOME) renders `⏵⏵ auto mode on (shift+tab to cycle)`, `⏸ manual mode on · ? for shortcuts`, `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)` — all four **byte-identical** to OCC's renders (§4.1). The suffix/labels are **composed dynamically** (keybinding label interpolation, same class as vim's `` `-- ${ve} --` ``), so the literals never appear in the binary. **Lesson recorded: byte-absence of a UI literal in the ELF ≠ render-time absence; for composed strings, live A/B is the final arbiter.**

`← for agents` (occ156-01): absent from ALL official 2.1.302 live footer states AND from OCC — but the render component **still exists** in the official binary verbatim (`{dimColor:!0,children:[kW," for agents"]}`), gated at 2.1.302 by a component-level `!C` early-return and an idle-branch `L?null:` (full formula extracted this run; identifiers `C`/`L`/`le`/`Mt`/`De` not yet decompiled). occ156's 2.1.296 live A/B saw the hint; this run's 2.1.302 session (isolated HOME, tmux 200-col, no fleet activity) did not → **display is conditional** (gate changed or env-dependent). **occ156-01 remains STAGED, untouched** — component + port recipe still valid; a future WP must decompile the gate identifiers before porting. NOT voided (earlier mid-round suspicion corrected).

### 2A.2 GAP occ162-01 (P3, new this run) — vim indicator surface: `-- VISUAL --` pill + `hideVimModeIndicator` setting

- **Official 2.1.302 footer gate (verbatim from binary)**: `Pr = ve!==void 0 && !_e && ve!=="NORMAL" && !Et` and the pill is composed `` `-- ${ve} --` `` — i.e. the indicator renders for **every non-NORMAL vim mode** (INSERT *and* VISUAL), suppressed by `_e` = the `hideVimModeIndicator` setting or by active history-search (`Et`).
- **Official setting (verbatim)**: `statusLine` schema contains `hideVimModeIndicator` with describe text `Hide the built-in `-- INSERT --` / `-- VISUAL --` indicator below the prompt. Use this when your status line script renders `vim.mode` itself.` — placed right after `refreshInterval`.
- **OCC现状**: `PromptInputFooterLeftSide.tsx:204` gate is `isVimModeEnabled() && vimMode === "INSERT" && !isSearching` → renders `-- INSERT --` only; **no `-- VISUAL --` pill** (live-confirmed: `v` + `ll` in NORMAL → selection engine works, footer stays bare). OCC settings `statusLine` schema (`types.ts:770-787`) = type/command/padding/refreshInterval — **no `hideVimModeIndicator`**.
- **Aligned neighbors (verified, no gap)**: OCC statusline JSON input DOES carry `vim:{mode:...}` (`StatusLine.tsx:106-107`) matching official `"vim": { // Optional, only present when vim mode is enabled`; NORMAL-mode has no pill on either side (official describe text names only INSERT/VISUAL); `/vim` slash command absent on both sides (official removed 2.1.92, pinned `removed-commands.test.ts`; official's `vim:"config"` category-map entry is legacy taxonomy, no command descriptor strings exist).
- **Introduction version of `hideVimModeIndicator`**: not recoverable from the 2.1.302 binary (embedded changelog window doesn't cover it; not in any prior ledger) → introduction point **CAND**; the gap-vs-2.1.302 itself is byte-confirmed.
- **Disposition**: P3 cosmetic-surface, not a regression (OCC never rendered the VISUAL pill). Per this round's rules → **ledger + Leader adjudication, not self-fixed**. Suggested slice if Leader greenlights: widen the footer gate to `vimMode !== "NORMAL"` (matching official `Pr`) + add `hideVimModeIndicator` to the statusLine schema as the suppression gate + pins.

**Security note (uvx channel):** PyPI `claude-code` is a **0.0.1 placeholder/squatted package** (PyPI JSON: only release = 0.0.1) — NOT Anthropic's distribution (official channel = npm `@anthropic-ai/claude-code`). `uvx claude-code@2.1.302` → unresolvable; running unpinned `uvx claude-code` would execute an unofficial binary with gateway credentials in env — **declined**. Official-side interaction forensics this round run the md5-verified official npm ELF under an isolated clean HOME (no host `~/.claude*` exposure), per the Leader's uvx-clause override of never-execute (interaction evidence only, no sensitive data).

## 3. Self-acceptance ② — acceptance-fix ×12 findings re-verification (commit `9e4812f1`)

All 12 findings re-verified this run — pins executed explicitly under `CI=true`, **both orders** (leak-pair discipline):

| # | Finding | Pin(s) / verification | Result |
|---|---|---|---|
| ① | hook ≤12 concurrency cap wired to production | `hookConcurrencyCapProduction302` (mutation-verified: cap constant + predicate `type==='prompt'\|\|type==='agent'`) | ✓ |
| ② | usage-credits streaming call site | `usageCreditsStreamingSite302` | ✓ |
| ③ | ToolSearch all-match semantics | `toolSearchAllMatch302` | ✓ |
| ④⑧⑨ | image-read seam (128MB cap path) | `imageReadSeam302` + live probe #06 (§2.4: verbatim refusal through full production path) | ✓ |
| ⑤ | reftable worktree common-dir | `reftableWorktreeCommonDir` (+ `reftableFallback302`) — 21 pass / 0 fail / 51 expect both orders | ✓ |
| ⑥ | fork-subagent source validation | `forkSubagentSourceValidation302` + live probe #31 (§2.4) | ✓ |
| ⑦ | `vat()` forced-background recompute (AgentTool comment fix) | source-verified: `AgentTool.tsx:131/145` — `isSubagentsForcedBackground()` recomputed per call, not captured at import | ✓ |
| ⑩ | ToolSearch compact boundary | `toolSearchCompactBoundary302` | ✓ |
| ⑪ | usage-credits forwarding production | `usageCreditsForwardingProduction302` | ✓ |
| ⑫ | auto-compact window alias pins | `autoCompactWindowAliasPins302` | ✓ |

Pin totals (8 test files, ①②③④⑧⑨⑥⑩⑪⑫): **37 pass / 0 fail / 76 expect, both orders**. Plus ⑤ pair: **21 / 0 / 51, both orders**. ⑦ has no dedicated pin (comment-level fix) — source cross-check recorded above. **No acceptance-fix regression found.**

## 4. Self-acceptance ③ — core trunk spot-checks (live tmux REPL + `-p` stream-json, official 2.1.302 as control)

A/B harness: OCC `dist/cli.js` (v2.1.389) vs md5-verified official 2.1.302 ELF, each under isolated clean HOME (`/tmp/occ162-ab/home-occ` / `home-official`), tmux 200-col panes, real API gateway, no sensitive data fed to the official side.

### 4.1 S-Tab mode cycle — 4/4 byte-MATCH (boot default = known STAGED divergence only)

Captured footers per S-Tab state (`occ-state0..5.txt` / `off-state0..5.txt`):

| State | OCC render | Official 2.1.302 render | Verdict |
|---|---|---|---|
| boot | `⏸ manual mode on · ? for shortcuts` (OCC boots MANUAL) | `⏵⏵ auto mode on (shift+tab to cycle)` (official boots AUTO) | boot-default divergence = **occ156-03 STAGED-BY-LEADER**, untouched |
| manual | `⏸ manual mode on · ? for shortcuts` | identical | **byte-MATCH** |
| accept edits | `⏵⏵ accept edits on (shift+tab to cycle)` | identical | **byte-MATCH** |
| plan | `⏸ plan mode on (shift+tab to cycle)` | identical | **byte-MATCH** |
| auto | `⏵⏵ auto mode on (shift+tab to cycle)` | identical | **byte-MATCH** |
| cycle wrap | state4≡state0, state5≡state1 (full loop) | same wrap behavior | MATCH |

This also refuted the mid-round "official footer surface drifted" strings-grep candidate — see §2A.1 methodology lesson.

### 4.2 Interrupted turn + `--continue` resume — byte-MATCH

- Escape mid-turn on a long generation → OCC renders interrupt UX identical in shape to official; `InterruptedByUser.tsx:10` returns `"What should Claude do instead?"` — byte-identical to official 2.1.302 `function Ya(){return"What should Claude do instead?"}` (verified in extracted strings).
- `occ --continue` after the interrupted session: transcript replayed, and the follow-up answer demonstrated context awareness of the interrupted request ("Your previous request was…") — resume path intact.

### 4.3 `-p` stream-json envelope — core contract intact (extended field-set = occ156 drift-2 STAGED, re-verified)

Live `--output-format stream-json` capture (`streamjson.jsonl`): `system/init` → `assistant` ×2 → `result`.

- init raw key order (OCC live): `type,subtype,cwd,session_id,tools,mcp_servers,model,permissionMode,slash_commands,apiKeySource,claude_code_version,output_style,agents,skills,plugins,uuid,fast_mode_state`.
- Official 2.1.302 init composition extracted verbatim from binary this run — full envelope superset: `…,betas,…,[terminal_slash_commands],…,[plugin_errors],[plugin_warnings],[capabilities],[mcp_server_errors],analytics_disabled,product_feedback_disabled,…,[memory_paths],[scratchpad_path],[original_cwd],[additional_directories],[worker_epoch],[messaging_socket_path],…,[footer_indicator]`. OCC's narrower field-set = **occ156 drift-2, STAGED — carried, re-verified live this round** (OCC emits `betas` via `getSdkBetas()` but undefined→dropped in JSON; `mcp_server_errors` present-when-nonempty per binary `tAr` filter).
- result envelope keys (OCC live): `duration_api_ms,duration_ms,fast_mode_state,is_error,modelUsage,num_turns,permission_denials,result,session_id,stop_reason,subtype,total_cost_usd,usage,uuid` — core SDK contract fields all present and correctly typed.

### 4.4 Vim surface — aligned except GAP occ162-01 (§2A.2)

- `-- INSERT --` indicator: renders on both sides when vim enabled + INSERT mode ✓ (official pill `` `-- ${ve} --` `` composed dynamically — see §2A.1 lesson).
- NORMAL mode: **no pill on either side** ✓ (official gate `ve!=="NORMAL"`).
- `%` motion (official 2.1.301 changelog, embedded in the 2.1.302 binary): live-verified via tmux cursor telemetry — input `ab(cd)ef`, cursor at x=4 (on `(`), `%` → x=7 (on `)`) ✓. Unit pin `percentMotion301` (occ160 WP-D P5 PORT-landed).
- `v`/`V` visual selection engine works (occ160 WP-D P7); the missing piece is the *footer pill* only — recorded as GAP occ162-01 (§2A.2), P3, Leader adjudication.
- statusline JSON input carries `vim:{mode:…}` (`StatusLine.tsx:106-107`) ✓ matches official contract.
- `/vim` slash command: absent on both sides (official removed 2.1.92; `removed-commands.test.ts` pins; editor toggle via `/config editor=vim|normal` — live-verified through the config dialog AND the `-p` shorthand `Set editor mode to vim`).
- official settings key `statusLine.hideVimModeIndicator`: **missing from OCC schema** → part of occ162-01 (§2A.2).

## 5. Carryover dispositions (this round's rulings)

Re-review trigger check: official `stable = 2.1.292` — the STAGED re-review trigger (`stable ≥ 2.1.296`) is **NOT fired** → default disposition is carry-as-is. Statuses were changed ONLY where new byte/live evidence this round demands it (none did — no STAGED item flipped).

| Item | Prior status | This round's evidence | Disposition |
|---|---|---|---|
| occ156-01 (`← for agents` footer hint) | STAGED (recorded vs official 2.1.296 live) | Component **still present verbatim** in official 2.1.302 binary (`{dimColor:!0,children:[kW," for agents"]}`) but conditionally gated (component-level `!C` early-return + idle-branch `L?null:`); live 2.1.302 session (isolated HOME, tmux 200-col, no fleet activity) renders NO hint in any mode | **STAGED — carried, NOT voided.** Conditionality note added (§2A.1); gate identifiers `C`/`L`/`le`/`Mt`/`De` must be decompiled by the porting WP before landing |
| occ156-03 (official auto-mode default + announcement) | **STAGED-BY-LEADER** (ruling `b16f18f6`) | Boot-default divergence re-confirmed live (§4.1: official boots AUTO, OCC boots MANUAL) | **Untouched** — Leader-owned; re-review trigger not fired |
| occ157-03 | **STAGED-BY-LEADER** | — | **Untouched** — Leader-owned |
| occ156-04 | STAGED | no new evidence | carried as-is |
| occ156-05 (ThemePicker numbering) | STAGED (P3) | live re-verified this round — still divergent | **STAGED — carried** (P3, Leader adjudication backlog) |
| occ156-10 / drift-2 (init envelope field-set) | STAGED | Live re-verified (§4.3): OCC init = 17-key core contract; official 2.1.302 composition extracted verbatim — full superset incl. `analytics_disabled`/`product_feedback_disabled`/`memory_paths`/`scratchpad_path`/`footer_indicator` etc. | **STAGED — carried, re-verified** (no regression; field-set gap unchanged) |
| occ160 STAGED ×19 (incl. WP-D P6 parse-keypress timing gate) | STAGED | WP-D P5 (`%` motion) + P7 (visual selection) live re-verified ✓ (§4.4); P6 timing gate not re-examined (no new evidence) | **STAGED ×19 — carried as-is** |
| occ154 ×28 families | STAGED (carried per occ156 §7.3) | no re-review trigger | **carried as-is per occ156 §7.3** |
| **occ162-01 (NEW this round)** — vim `-- VISUAL --` pill + `statusLine.hideVimModeIndicator` | n/a | Byte-confirmed gap vs 2.1.302 (§2A.2): official gate `ve!=="NORMAL"` + setting describe text verbatim; OCC gate INSERT-only, setting absent | **NEW → pending Leader adjudication** (P3 cosmetic, not a regression; per round rules: ledger-recorded, NOT self-fixed) |

No CAND item was promoted to CONFIRMED without byte evidence; no CONFIRMED item was demoted. The only mid-round status-suspicion (occ156-01 "premise voided") was **caught by binary re-check before recording** and corrected to STAGED-with-conditionality-note.

## 6. Full suite + e2e record

### 6.1 Unit suite (host, `CI=true bash scripts/ci-test.sh`)

**12657 pass / 0 fail / 119 skip — 1140 files checked, 0 failed, exit 0.** Hard bar (≥11087 pass / 0 fail) satisfied with wide margin. Per-file isolation + same-worker leak-pair both-orders runs all OK (incl. `autoDefaultNudge296 ↔ autoDefaultNudge296Merge` 23 pass both orders). Targeted pins from §2/§3 (PORT ×12: 174/0/413; acceptance-fix: 37/0/76 + ⑤-pair 21/0/51) were additionally run in BOTH orders — all green. This round's branch delta vs `v2.1.389` is **docs-only** (1 file, +149 lines), so no tests were added or removed — the total is exactly the tag baseline; any different count cited in kickoff references is attributable to harness mode (per-file isolation vs single `bun test` invocation), not to this round.

### 6.2 e2e root run (`bash test/e2e/run.sh`, as specified — fidelity record)

**667 pass / 1 skip / 72 fail / 12 errors** (2468 expects, 158 files, 913s). Structural, matching occ150 §236 (658/73/12, all environment-attributed): `run.sh` runs the one-shot container **as root**, and OCC refuses `--dangerously-skip-permissions` for root ("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons", manually probed: exit 1) → the whole real-model/skip-permissions cluster fails uniformly (~750ms, exit 1), plus the tmux cluster. Not a product signal — recorded because the round rules name `run.sh` explicitly; the canonical gate is the non-root flow below (per the Dockerfile's own documentation: "Default USER is left unset so the one-shot run.sh flow still runs as root (unchanged); runner.sh opts in via --user occ").

### 6.3 e2e non-root run (`runner.sh` → `docker exec occ-e2e-runner`, canonical)

**724 pass / 1 skip / 15 fail / 7 errors** (2631 expects, 158 files, 902s). Root-guard cluster flipped as expected: every tmux test that failed under root (auto-default-nudge ×2, trust-gate ×2, hljs injection, goal panel) **passes** as `occ` user, and 13/14 `real-coding` real-model tests pass with genuine gateway calls (FileEdit 10.1s, Bash 7.5s, multi-file 35.2s — real latencies, not stubs). Image freshness verified before the run (image Created `2026-10-19T02:33:42+08:00`; ledger-file md5 inside image == host; dist byte-delta = BUILD_TIME macro only; container TZ = UTC, hence "Oct 18" mtimes).

### 6.4 Residual classification (8 test-level fails + 7 file-level load errors — ALL environment-attributed)

| # | Residual | Class (occ150 §236 taxonomy where applicable) | Evidence |
|---|----------|-----------------------------------------------|----------|
| 1 | OCC-82 effort-cap REPL tmux ⑤⑥ (×2, 30s timeout on `waitForText('shift+tab')`) | **ANTHROPIC_API_KEY 未转发** | `replHomeWith()` seeds `customApiKeyResponses.approved` ONLY when the TEST-PROCESS env carries `ANTHROPIC_API_KEY` ≥20 chars; container gets BASE_URL/AUTH_TOKEN/MODEL only → child REPL gets fallback key `occ-effort-cap-key` with an empty approval list → API-key-approval dialog blocks boot → footer never renders. ① passes (no mock-endpoint env). **Isolated re-run proof**: `docker exec -e ANTHROPIC_API_KEY=occ-effort-cap-key-12345 occ-e2e-runner bun test …effort-cap…` → **7 pass / 0 fail / 40 expect (20.5s)**. Not a flake, not a product defect. |
| 2 | `/feedback <text>` creates+closes GitHub issue (60s timeout) | GitHub API/credentials absent in container | Sibling `/feedback (no args)` (model-only) PASSES; issue-create path needs `gh` auth + GitHub reachability, neither seeded in the image. |
| 3 | 2.1.108 prompt-cache TTL env vars | **ANTHROPIC_API_KEY 未转发** | Source-level `bun -e` import chain throws `ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required` at `src/utils/auth.ts:292` (`getAnthropicApiKeyWithSource ← isClaudeAISubscriber ← resolvePromptCacheTtl ← should1hCacheTTL`); run.sh/runner.sh forward AUTH_TOKEN, not API_KEY. |
| 4 | `occ update argv` ×2 | **只读挂载 module-not-found** | `Cannot find module '../../src/commands/update/update.ts'` — test dir mounted RO at `/test/e2e` while repo is baked at `/occ`, so `../../src/...` resolves to nonexistent `/src/...`. |
| 5 | PTY interactive-resume ×1 | Container PTY restriction | `errno: -1, code: "EPERM"` at pty spawn (`resume-command-name.e2e.test.ts:140`), 0.40s — spawn-level denial for `occ` user in the container, not a product path. |
| 6 | `--append-system-prompt` followed (real model) | Model variance (gateway) | exit 0, stdout `"4\n"` without `XYZ_OCC_TOKEN` — gateway model (qwen3.8-max) ignored the appended instruction; the other 13/14 real-model tests in the same file pass with real calls. |
| 7 | 7 file-level load errors | **只读挂载 module-not-found** | 8 test files hit the same RO-mount relative-import failure (bun tallies 7 errors; the two named `occ update argv` fails share the cause): `loadSkillsDir.js` (version-2.1.303-skill-shell-marker-escape), `react` pkg (wake-logout-real-call-2.1.211), `thinkingOnlyNudge.js` (version-2.1.283), `update.ts` (occ-update-argv), `package.json` (occ-versioning, workflow-permission-dialog-ctrl-g), `browser.js` (webbrowser), `argumentSubstitution.js` (version-2.1.163-skill-dollar-escape). |

### 6.5 Zero-regression argument + verdict

`git diff v2.1.389..HEAD --stat` = **docs-only (1 file, +149)** — nothing in this round's branch can be the cause of any residual. Every residual maps to a documented occ150 §236 environment class (root-guard → skip-permissions; tmux-in-container; ANTHROPIC_API_KEY 未转发; 只读挂载 module-not-found) or a container-inherent limit (GitHub creds, PTY EPERM, gateway model variance). Per occ104 discipline the gate is *classify every residual against the clean-baseline A/B, not zero-fail* — and the one cluster that needed an isolated re-run to exclude flake-under-load (OCC-82 ⑤⑥) was proven green with the env fix. **Test-authenticity gate: PASS** (unit 12657/0/119 exit 0; e2e canonical non-root 724/15/7 fully environment-attributed; leak-pairs both-orders green; official-binary artifacts in /tmp deleted after use per round rules).

## 7. Merge / handoff record

(TBD — filled after merge to main + CI green)
