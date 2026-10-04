# OCC-107 Upstream Version Gap Ledger — Claude Code 2.1.288 → 2.1.289 (2026-10)

**Round**: OCC-107 (issue `f750121a-a1ec-44ee-a795-c5ca7a92a5d2`), executed 2026-10-05 by OCC 程序员.
**Tracked-upstream pointer**: 2.1.288 → **2.1.289** (this round). OCC release: **2.1.369** (tag/publish after 验收 acceptance).
**Official channel state at round time** (npm `dist-tags`, re-verified this round): `stable=2.1.285`, `latest=next=2.1.289` (published 2026-10-03T20:12:02Z).

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.288` (245,734,584 B, md5 `2e368f7093aa911f9df0d5224de226d9`) and `@2.1.289` (246,107,320 B, md5 `5c920e4c2e6c73c2858cc48e5123582e`), unpacked to `/tmp/cc-diff-289/{v288,v289}/package/claude`. **Never executed** — analysis used only `strings -n 8` dumps (s288s.txt 308,294 / s289s.txt 308,827 sorted-unique lines), `comm` diff (`new_strings.txt` **14,855 new unique strings** / `removed_strings.txt` 14,322 removed), `grep -boF` offsets + `dd` byte-window extraction. Temp artifacts removed after the round.
- Changelog: **27 bullets** for 2.1.289 (numbered **#1–#27** in changelog order — `docs/gap-research-289/changelog-entries-289.txt`). Research reports under `docs/gap-research-289/`: `cluster-a-bash-permissions.md`, `cluster-b-read-symlink-ide.md`, `cluster-c-parser-dos.md`, `cluster-d-auth-status-revert.md`, `cluster-e-plugins-mcp.md`, `cluster-f-mods-ui-runtime.md`.
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure. Security ports additionally verified by A/B harnesses where feasible.
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** · **STAGED** (real surface or real gap, but needs decompilation/decision/subsystem OCC lacks — recovered code recorded, nothing invented) · **NO-OP** (PLATFORM = other-product surface; NO-SURFACE = feature absent from OCC; ALREADY-ALIGNED).

## Carry-over: v2.1.368 npm publish (NPM_TOKEN)

- Reran failed publish run `37166618773` (attempt 3, 2026-10-04T17:09Z): **still E404 on `PUT @cnwenf%2focc`** — repo secret `NPM_TOKEN` remains expired/not rotated. Owner action still required (rotate → rerun). npm `latest` stays `2.1.367`.
- Release/tag consistency re-verified this round: the attempt-3 run DID create the **v2.1.368 GitHub Release** (2026-10-04T17:09:33Z) before failing at npm — `/releases` 168 ≡ `/tags` 168, no backfill needed for v2.1.368.
- This round's v2.1.369 release will hit the same npm blocker until rotated; per issue 发版流程, if the v2.1.369 Release step is skipped due to the npm failure, backfill manually with `gh release create v2.1.369 --generate-notes` (idempotent).

## Summary counts (27 entries)

- **PORTED: 7** — #2 (hljs budgeted emitter), #3 (Read-deny symlink landing), #11 (border-style validation, core-ink half), #14 (env-prefix expanded-value deny/ask variant), #16 (plugin-validate co-located plugin.json), #19 (shared ink text normalization), #22(partial — (a) anthropic-kind gate folded into #16; (b) `--json` output NO-OP{NO-SURFACE}).
- **STAGED: 1 primary** — #6(6a) local-folder-marketplace in-place serving (needs the v288-era in-place-serving prerequisite OCC lacks; 6b symlinked `--plugin-dir` hot reload NO-OP — no watcher surface). Plus partial-STAGED tails on #3 (directory-branch `hpr` parity), #19 (blit-cache/`paintsPastRect` containment machinery), and STAGED notes under #1 (`checkRuleBasedPermissions` recursion hardening), #10 (mod MCP sign-in description rewrite — no `tool.describe` surface yet), #17 (mod `$.agent` API — internal-only today).
- **NO-OP: 19** — #1{NO-SURFACE}, #4{ALREADY-ALIGNED}, #5{NO-SURFACE}, #7{NO-SURFACE}, #8{NO-SURFACE}, #9{NO-SURFACE}, #10{NO-SURFACE}, #12{NO-SURFACE}, #13{NO-SURFACE}, #15{ALREADY-ALIGNED}, #17{NO-SURFACE}, #18{NO-SURFACE}, #20{NO-SURFACE}, #21{NO-SURFACE}, #23{NO-SURFACE}, #24{NO-SURFACE}, #25{NO-SURFACE}, #26{PLATFORM}, #27{NO-SURFACE}. (#6 counted under STAGED above.)
- Dominant NO-OP driver: the entire v289 mods/plugin-UI runtime (`ui.render`, `ui.fault`, vm-sandbox `Client`, panes/bands, `$.agent`, AbovePrompt rows) is a surface OCC does not have — 13 of the 19 NO-OPs (cluster-f).
- Adjacent finding (not a changelog entry): v289 MCP schema key validator `mo(e)` (`/^[A-Za-z0-9_-]+$/` + `__proto__`/`constructor`/`prototype` rejection, 8→9 sites @v289:200175069). OCC already guards the live vector — explicit `__proto__` reserved-name rejection at MCP config load (`src/services/mcp/config.ts:1727-1736`, skip-with-warning). Extended `constructor`/`prototype` name rejection recorded as optional hardening in §4.

## 1. Per-entry ledger (#1–#27)

| # | Entry (abridged) | Verdict | Evidence |
|---|---|---|---|
| 1 | nested-part deny/ask not holding over user-installed mod's approval (managed machines) | **NO-OP{NO-SURFACE}** (+STAGED adjacent note) | Fix site is the mod `tool.check` dispatch (`Krt` single-level → `kTe` recursive rule extraction @207642127→@207945079, `Zrt`→`Ost` hookAskFloor attribution, new `Rst`/`Ast` + resolveToolCheck infra); OCC has no `tool.check` mod surface (all greps empty). Certified-command matcher + managed-hooks markers byte-identical; official PreToolUse hook path byte-identical 288↔289. STAGED adjacent: OCC `checkRuleBasedPermissions` 1f non-recursive vs official `mu()` recursion (identical both versions) — optional hardening pending `cY`/`eY` decompilation. cluster-a §#1 |
| 14 | env-var prefix with expanded value bypasses Bash deny/ask under sandbox auto-allow (`TZ="$HOME" rm -rf build`) | **PORTED** | OCC probe-proven VULNERABLE on the live path: `ENV_VAR_PATTERN`/`stripAllLeadingEnvVars` refuses `$`/backtick values (CodeQL #671 legacy), AST dormant, no argv-variant compensation — `TZ="$HOME" rm -rf build`, `TZ=$HOME …`, `FOO=$(pwd) …` all missed deny `Bash(rm *)` + ask, `checkSandboxAutoAllow` allowed. Official fix byte-recovered: variant-builder `be[0]!==ye[0]` → `(be[0]!==ye[0]\|\|(h?.envVars.length??0)>0)` @210022797. OCC port: quote-aware iterative leading-assignment scanner in the `stripAllEnvVars` fixed-point of `filterRulesByContentsMatchingInput` (bashPermissions.ts), post-assignment remainder pushed as deny/ask-only match variant, fail-closed on unterminated quotes. cluster-a §#14 |
| 15 | bare variable assignment before command skipped deny/ask under sandbox auto-allow | **NO-OP{ALREADY-ALIGNED}** | Official bug needs the AST collapsing `FOO=1; rm -rf build` into a 1-element command list so v288's `if(r.length>1)` recheck gate skips (v289: `r.length>1\|\|r[0]?.text!==s` @210037822). OCC's gate is text-based `splitCommand().length>1`; probe: all bare-assignment compounds split to 2 parts → per-subcommand deny fires; space form `FOO=1 rm -rf build` caught by existing stripper. cluster-a §#15 |
| 2 | terminal freeze: unclosed `<script>` / nested `${` in short code blocks | **PORTED** | Official v289 budgeted hljs emitter (`HighlightBoundError`, depth 32 / fanout 64 / budget `4096+len*(24+3*fanout)`) installed via `loadCore();Se(n)` (s288 @17497153 → s289 @17553789) + renderer failure memo `e.lang=null`. OCC freeze REPRODUCED through production path (marked→cli-highlight→hljs 11.11.1): `<script>`×16 = 1.2s, ×20 = killed @10s. Port: `src/utils/hljsBound.ts` + install in `cliHighlight.ts` + memo in `markdown.ts`. cluster-c §all |
| 3 | `Read` deny rules vs IDE @-mentioned/changed/selected files through symlink | **PORTED** | Official v289 landing subsystem NEW (`denied_at_landing`/`landing_unsettled`/`refused_at_open` 0→2 hits; `aje`@204108371 / `Sge`@210918122 / `bge`,`hpr`@210919225 / `wge`@210920221). OCC structurally VULNERABLE identically: `isFileReadDenied` (attachments.ts:4314) surface-only; Read tool already spelling-aware. Port: harden `isFileReadDenied` to deny-check every `getPathsForPermissionCheck` spelling. Directory-branch (`hpr`) parity STAGED follow-up. cluster-b §1–§5 |
| 4 | [VSCode] revert of 2.1.288 `claude auth status` change | **NO-OP{ALREADY-ALIGNED}** | 288 added two awaited network ops on the exit path (`await logFeatureOkAsync("cli_auth_status")` + `exitAfterAnalyticsFlush`); 289 reverts to sync queue + direct `process.exit` (token-diff: exactly 1 structural change). OCC never ported the 288 teardown — `auth.ts` authStatus exits directly with zero analytics (stubbed sinks); shape ≡ v289-reverted. cluster-d §1–§2 |
| 26 | published-artifact page freeze on unclosed `<script>` | **NO-OP{PLATFORM}** | Artifact-publish pipeline byte-identical 288↔289 (1691-byte lines equal); fix is claude.ai serving-side. OCC has no artifact-publishing surface (grep `hljs-runtime\|artifact_publish\|publishArtifact` → 0 hits). cluster-c §#26 |
| 5 | large files open faster in plugin code pane (highlighted view laid out once at final width) | **NO-OP{NO-SURFACE}** | Fix lives in the mods plugin-code-pane runtime; OCC has no `ui.render`/pane surface (grep table cluster-f: `ui.render`/`$.ui`/pane/band all 0 hits). cluster-f |
| 6 | stale copy of plugin installed from local-folder marketplace (`plugin list/eval/update`); symlinked `--plugin-dir` hot reload | **STAGED(6a) + NO-OP{NO-SURFACE}(6b)** | 6a: official fix switches local-folder-marketplace installs to in-place serving (no copy) — OCC lacks the v288-era in-place-serving prerequisite; recovered bytes recorded, nothing invented. 6b: OCC has no `--plugin-dir` watcher/hot-reload surface. cluster-e §#6 |
| 7 | installed mods not loading in first session after upgrade | **NO-OP{NO-SURFACE}** | Fix site is the mods loader (`hooksModules`/upgrade-migration path); OCC has no mods subsystem. cluster-e §#7 |
| 8 | plugin rows above prompt stale while Background-tasks dialog fullscreen | **NO-OP{NO-SURFACE}** | No AbovePrompt plugin-row surface in OCC; OCC's own fullscreen paths draw no plugin rows so the stale-row bug has no instance. cluster-f |
| 9 | plugin panes drawing nothing for localhost/`@`-path/uppercase-host/`file:` links | **NO-OP{NO-SURFACE}** | Link-normalization lives in the mods pane draw module; absent in OCC. cluster-f |
| 10 | user-installed plugin rewriting org-managed MCP server's sign-in tool descriptions | **NO-OP{NO-SURFACE}** (+STAGED note) | Fix site is mod `tool.describe` override dispatch; OCC has no `tool.describe` surface and `McpAuthTool` descriptions are static. STAGED note: enforce when mods/`tool.describe` lands. cluster-e §#10 |
| 11 | freeze/forced quit at launch: Box with border style the terminal does not know | **PORTED** (core-ink half; mod-input half NO-OP) | OCC crash REPRODUCED live: `TypeError: undefined is not an object (evaluating 'box.topLeft')` (`src/ink/render-border.ts:91-96` unknown style → undefined → :128). Official v289 fix byte-recovered: validating resolver `Dvn` @203025539 (`Object.hasOwn` over merged styles, shape-validate objects, `void 0` on unknown) + caller skip `if(g!==void 0)`. Port: validating resolver in render-border.ts — unknown style → no border, never throw. cluster-f §#11 |
| 12 | supervised/background sessions ending when plugin on-screen handler threw async | **NO-OP{NO-SURFACE}** | Fix is the mods Client-host rejection handler `be(...)` "the session goes on" @218198922; no Client surface in OCC. cluster-f |
| 13 | sessions ending with interface error when zero-height plugin region kept growing | **NO-OP{NO-SURFACE}** | Fix is the Client measure-loop state machine (`measurings`, `frameOutcome`, caps 8/20) @218198922; absent in OCC. cluster-f |
| 16 | `claude plugin validate` skipping the plugin when folder also holds a marketplace manifest | **PORTED** | OCC `validateManifest` directory branch (validatePlugin.ts @891-923) has the IDENTICAL early-return bug: `if (marketplaceResult.errors[0]?.code !== 'ENOENT') return marketplaceResult` skips the co-located plugin.json. Official v289 fix (`kTt`→`JTt`) byte-recovered: validate both, include the co-located plugin result only when it has errors/warnings. Port + #22(a) kind gate. cluster-e §#16 |
| 17 | `agent.spawn` for teammates, one agent id across plugin hook events, idle/waiting in `$.agent.list()` | **NO-OP{NO-SURFACE}** (+STAGED note) | Impl `Yco`→`nfo` @208518832/@208823898 is the mod `$` API; OCC has no plugin-exposed agent API (internal `agent()`/`spawnTeammate` not exposed). STAGED: fold into future mod-`$`-API port. cluster-f §#17 |
| 18 | "unrecoverable interface error" when mod `ui.render` value made a row throw | **NO-OP{NO-SURFACE}** | Row-fallback strings `l1r`/`d1r`/`Pmn` live in the ui.render engine; no `ui.*` hook events in OCC (`HOOK_EVENTS` check). cluster-f |
| 19 | text with tab / stray escape + C1 / short text with tab+CRLF drawing over rows below | **PORTED** (shared text normalization) **+ STAGED** (blit-cache machinery) | v289 adds the shared pipeline (`Oc/Hc/$rr/p9r/Ua/Va/La/Ya` @201062051+@213553684; `pR=/[\x90\x98\x9d-\x9f]/g` count 0→2) used by BOTH measure and render — v288 was asymmetric (root cause). OCC probes: stray ESC eats following chars (`a\x1bb`→`a`), C1 silently dropped, tabs as fragile CUF escapes, `\r`-conversion row inflation. Port: one shared normalizer for measure+render (tabs→8-col spaces across pieces, ESC/CSI→`\x18`, C1/bidi→U+FFFD). STAGED: `paintsPastRect`/`gC`/`unpainted`/clips containment net (renderer audit prerequisite). cluster-f §#19 |
| 20 | right-aligned pane/band content under close mark `[-]`; one column in from edge | **NO-OP{NO-SURFACE}** | Pane/band chrome is mods runtime; absent in OCC. cluster-f |
| 21 | mod Client failing while drawn taking down surrounding draws; now fails alone + `ui.fault` | **NO-OP{NO-SURFACE}** | `ui.fault` dispatcher `ko` + `ui_client_fault` subtype NEW in v289 (0→8/0→12 strings); no fault surface in OCC. cluster-f |
| 22 | `claude plugin validate` failing an Anthropic marketplace's own plugin; clean plugin.json listed in `--json` | **PORTED(partial)** — (a) folded into #16; (b) NO-OP{NO-SURFACE} | (a) anthropic-kind gate byte-recovered: `kind:"anthropic"\|"alone"` param; detection = is-Anthropic-marketplace-name + marketplace plugins[] lists this folder → kebab-case rule (warning-only in OCC @319-327) suppressed. (b) OCC `plugin validate` has no `--json` output → listing fix has no surface. cluster-e §#22 |
| 23 | mod band failing to draw briefly telling cards under it to step aside | **NO-OP{NO-SURFACE}** | Band/cards layout is mods chrome; absent in OCC. cluster-f |
| 24 | failed plugin component showing `Error`/nothing when failure carried no message | **NO-OP{NO-SURFACE}** | Reason fallback `Ae(r,i)` lives in the mod draw region (~@206373709); absent in OCC. cluster-f |
| 25 | mod-author failure line for band/pane draw failure names the mod | **NO-OP{NO-SURFACE}** | `d1r`/`Pmn`/`vUt` telemetry strings are mods runtime; absent in OCC. cluster-f |
| 27 | mod Client region staying failed whole session after terminal threw while drawing | **NO-OP{NO-SURFACE}** | Region-recovery state (`isDestroyed`/`mountGeneration`/`thrownAt`) @218198922 is Client-host; absent in OCC. cluster-f |

## 2. Security disposition summary (kickoff priority list)

| Item | Class | Disposition |
|---|---|---|
| #14 env-prefix expanded value bypasses Bash deny/ask under sandbox auto-allow | **permission bypass** | **PORTED** — OCC probe-proven VULNERABLE pre-fix (`TZ="$HOME" rm -rf build` missed deny `Bash(rm *)` + ask; `checkSandboxAutoAllow` allowed). Quote-aware iterative scanner (non-regex, CodeQL #671 ReDoS constraint), fail-closed, deny/ask-only (no new ALLOW surface). RED 10-fail → GREEN 19/19; rm-gate lineage suites 176/0. |
| #3 Read deny rules vs IDE-attached files through symlink | **permission bypass** | **PORTED** — OCC structurally vulnerable identically (`isFileReadDenied` surface-spelling only). Now deny-checks every `getPathsForPermissionCheck` spelling via `matchingRuleForInput`; short-circuit (`aje` analogue) when no read-deny rules exist. Real-symlink fixtures: RED 2-fail → GREEN 8/8. Directory-branch parity STAGED (§4.2). |
| #2 terminal freeze: unclosed `<script>` / nested `${` in short code blocks | **DoS (renderer)** | **PORTED** — freeze reproduced through the production path (marked→cli-highlight→hljs): `<script>`×16 = 1.2s, ×20 = killed @10s. Budgeted emitter per official v289 (`HighlightBoundError`, depth 32 / fanout 64 / budget `4096+len*(24+3*fanout)`, depth²-charge) + renderer failure memo (`e.lang=null`). |
| #1 nested-part deny/ask over user-installed mod approval (managed machines) | permission bypass | **NO-OP{NO-SURFACE}** — fix site is the mod `tool.check` dispatch; OCC has no mod surface. Certified-command matcher + managed-hooks markers byte-identical; official PreToolUse hook path byte-identical 288↔289. Adjacent recursion-hardening note STAGED (§4.4). |
| #15 bare assignment before command skipped deny/ask | permission bypass | **NO-OP{ALREADY-ALIGNED}** — OCC's text-based `splitCommand().length>1` gate never collapses bare-assignment compounds; probe: all forms hit per-subcommand deny; space form caught by existing stripper. |
| #10 plugin rewriting org-managed MCP sign-in tool descriptions | privilege escalation | **NO-OP{NO-SURFACE}** — no `tool.describe` override surface; `McpAuthTool` static. STAGED note §4.5. |
| #16/#22 plugin validate co-located manifest skip + Anthropic-kind gate | integrity (validation gap) | **PORTED** — OCC `validateManifest` had the identical early-return bug; a folder with marketplace.json + invalid plugin.json validated clean. Now validates both; kind gate per official. |
| #11 unknown border style crash at launch | DoS (crash) | **PORTED** — OCC crash reproduced live (`box.topLeft` TypeError, uncaught through `Ink.onRender` → process death). Validating resolver per official `Dvn`: unknown → no border, never throw. |
| #19 tab/escape/C1/CRLF overdraw | renderer integrity | **PORTED** (normalization; blit machinery STAGED §4.3) — OCC probes showed silent content loss (stray ESC eats following chars, C1 dropped) and the measure/render asymmetry root cause. Shared normalizer now feeds both. |
| #26 published-artifact page freeze | DoS (platform) | **NO-OP{PLATFORM}** — claude.ai serving-side; OCC has no artifact-publish surface. |
| Adjacent: MCP schema `__proto__`/`constructor`/`prototype` key validator (`mo(e)`, 8→9 sites) | prototype pollution | **NO-OP (already guarded) + hardening note** — OCC rejects reserved `__proto__` server names at config load (`src/services/mcp/config.ts:1727-1736`); `constructor`/`prototype` rejection recorded §4.7. |

## 3. Verification

All commands run on the round worktree (`agent/occ/2fafb176` @ c62bdff + this round's changes), Bun 1.3.14, 2026-10-05.

### Unit / integration

- **Full src suite** (`bun test src --isolate`): **7767 pass / 1 skip / 0 fail**, 19526 `expect()` calls, 618 files, 523.87s. Baseline (c62bdff pre-round): 7618 pass / 0 fail — **+149 tests, zero regressions**.
- Per-port suites (RED→GREEN each, then re-run post-restore): hljsBound289 9/9 · envPrefixDenyAsk289 19/19 · attachmentsSymlinkDenyLanding289 8/8 · pluginValidateColocated289 16/16 · borderStyleValidation289 18/18 · textNormalization289 62/62 + textNormalization289Frames 18/18.
- Regression rings: `src/ink` 191/0 · plugins+handlers+commands 595/0 · BashTool rm-gate lineage 176/0 · combined port+ink re-check after stash-restore 243/0.

### Build + smoke

- `bun run build` → `dist/cli.js` **29.84 MB**, `MACRO.VERSION=2.1.369` injected; `bun dist/cli.js --version` → **`OCC 2.1.369`**.
- Headless round-trip: `echo "say PONG only" | bun dist/cli.js -p` → `PONG`, exit 0 (the leading `[claude-code:unrecognized_model] {"model":"glm-5.2"…}` line is the known env-model artifact, not a failure).

### Live tmux REPL e2e (`repl-tmux-e2e-testing`, 200×50 pane, fresh dist)

- **Boot**: welcome box renders `OCC v2.1.369 · Open C Code` with model/proj rows, no crash.
- **Chat round-trip**: prompt `Reply with exactly: TMUX-E2E-OK` → `● TMUX-E2E-OK` rendered in ~3s.
- **`/status`**: dialog opens — `Version: 2.1.369`, Session ID, Status/Config/Usage tabs.
- **`/exit`**: fresh session terminates cleanly in ~1s. (With the `/status` dialog open, typed `/exit` is swallowed by the dialog — same as official; Esc-first is required.)
- Harness e2e (agent-run): `repl-welcome-visual` 8/0 · components+screens 320/0 · `repl-interactive` 2 pass / 1 fail — the failure is the **known pre-existing Shift+Tab auto-mode dialog gap** (documented in CLAUDE.md OCC-44), not a regression.

### Pre-existing failures (A/B-proven, NOT regressions)

- `version-2.1.208-screen-reader.e2e.test.ts:139` (BOX_DRAWING chars in SR pane): fails **identically** against a clean c62bdff baseline build (`OCC_ENTRYPOINT=/tmp/occ-main-ab/dist/cli.js`, detached worktree) — pre-existing.
- `repl-interactive` auto-mode dialog: pre-existing per OCC-44 note in CLAUDE.md.

### Incident note (recovered, no loss)

A research subagent performing baseline A/B comparison ran `git stash -u` on the round worktree at 06:20 and was stopped before restoring. The full round (18 tracked ±, 18 untracked files, +5518 lines) was recovered intact via `git stash pop`; post-restore verification: 243/0 across all 289-port suites + src/ink, version markers and ledger content confirmed. Lesson recorded: subagents doing baseline comparison must use a **detached worktree** (`git worktree add --detach`), never stash the live round tree.

## 4. STAGED backlog carried to future rounds

1. **#6a local-folder-marketplace in-place serving** — official v289 serves plugins installed from a local-folder marketplace in place (no stale copy). OCC lacks the v288-era in-place-serving prerequisite subsystem; recovered bytes in cluster-e §#6. Land after the plugin-serving rework.
2. **#3 directory-branch (`hpr`) landing parity** — this round hardened the file-read deny path (`wge` analogue); the official directory-branch of the landing subsystem (`hpr` @210919225: `landing_unsettled` for directories whose settlement is pending) has no OCC call-site today. cluster-b §5.
3. **#19 blit-cache containment machinery** — `paintsPastRect` up-propagation + `gC`/`unpainted` blit-cache invalidation + clip-growth (`Ql`/`Zl`/`grew`) tracking + `clips` threading. Needs an OCC renderer audit (`src/ink/renderer.ts`, `src/ink/output.ts` cachedLayout equivalents) after the normalization port settles. cluster-f §#19.
4. **#1 `checkRuleBasedPermissions` recursion hardening** — OCC's 1f nested-part extraction is non-recursive vs official `mu()` recursion (byte-identical 288↔289 — not a v289 delta, adjacent observation). Optional hardening pending `cY`/`eY` decompilation. cluster-a §#1.
5. **#10 mod `tool.describe` guard** — when OCC ever exposes a mod `tool.describe` override surface, org-managed MCP sign-in tool descriptions must be non-overridable (official v289 fix). cluster-e §#10.
6. **#17 mod `$.agent` API** — `agent.spawn` + one-agent-id + idle/waiting states (`nfo` @208823898, `i_o` teammate_spawned map) fold into a future mod-`$`-API port. cluster-f §#17.
7. **Adjacent: MCP schema key validator extension** — official v289 `mo(e)` rejects `constructor`/`prototype` server names in addition to `__proto__` (OCC guards `__proto__` at config load already, `src/services/mcp/config.ts:1727`). Optional hardening; no known OCC exploit path (parsed config accesses own properties). cluster-e adjacent finding.
8. ~~**`quote` border style**~~ — **CLOSED this round**: the #11 port recovered the exact `quote` bytes (@203025405: `left:"▎"` U+258E, all other glyphs single space) and added it to `CUSTOM_BORDER_STYLES`, making OCC's known-style set `o` byte-identical to official `{...cliBoxes, dashed, quote}`. Pinned by `borderStyleValidation289.test.tsx`.
9. **#11 layout-side note (closed)** — official measure caller `uE` @213586148 computes border width from *validity* (`Dvn(u.borderStyle)?1:0`), not truthiness; OCC's `src/ink/styles.ts` was updated to match via `resolveBorderStyle`, so an unknown style reserves no 1-cell inset.

## 5. Version bumps (this round)

- `package.json`: `2.1.368` → **`2.1.369`**.
- `src/entrypoints/cli.tsx` dev polyfill `MACRO.VERSION`: `2.1.288` → **`2.1.289`** (tracked-upstream pointer; build overrides with pkg.version).
- `README.md`: badge `Tracks: Claude Code 2.1.289 (partial)`, intro tracking paragraph (OCC-107 summary prepended), capability-parity table row, dev-polyfill note, Tracks bullet.
- `CHANGELOG.md`: new `## 2.1.369 - 2026-10-05 (official 2.1.289 alignment — OCC-107 round)` section (7 user-facing bullets) + intro "Now tracking Claude Code `2.1.289`" chain entry.
- Release: tag **v2.1.369** after merge to main; npm publish expected to fail on the expired `NPM_TOKEN` (carry-over §above) — GitHub Release backfilled manually if the CI Release step is skipped; `/releases` ≡ `/tags` re-verified after.

## 6. Files touched (this round)

**New — implementation:**
- `src/utils/hljsBound.ts` (#2 — budgeted hljs emitter: `HighlightBoundError`, depth/fanout/budget caps, dual v10+v11 sublanguage-merge charging)
- `src/ink/normalize-text.ts` (#19 — shared text-normalization pipeline: `TAB_INTERVAL`, `replaceC1`/`replaceBidi`/`cleanToken`/`hasControlChars`/`piecesAreDirty`/`expandTabsInPieces`/`normalizeDirtyPieces`/`normalizePieces`/`normalizeText`/`normalizeSingleString`/`isWrapTextMode`/`normalizeStyledPieces`)
- `src/ink/output-tokenizer.ts` (#19 — `tokenizeForOutput` port of official `Ua`/`Mme({forOutput:!0})` state machine)

**New — tests (149 net new assertions-bearing tests):**
- `src/utils/__tests__/hljsBound289.test.ts` (9)
- `src/tools/BashTool/__tests__/envPrefixDenyAsk289.test.ts` (19)
- `src/utils/__tests__/attachmentsSymlinkDenyLanding289.test.ts` (8, real-symlink fixtures)
- `src/utils/plugins/__tests__/pluginValidateColocated289.test.ts` (16)
- `src/ink/__tests__/borderStyleValidation289.test.tsx` (18)
- `src/ink/__tests__/textNormalization289.test.ts` (62)
- `src/ink/__tests__/textNormalization289Frames.test.tsx` (18)

**Modified — implementation:**
- `src/tools/BashTool/bashPermissions.ts` (#14 — quote-aware leading-env-assignment scanner → deny/ask-only expanded-value variant)
- `src/utils/attachments.ts` (#3 — `isFileReadDenied` checks every permission spelling; `hasReadDenyRules` short-circuit)
- `src/utils/cliHighlight.ts` + `src/utils/markdown.ts` (#2 — bounds installed on both hljs instances (root v11.11.1 + cli-highlight-pinned v10.7.3); renderer failure memo `e.lang=null`)
- `scripts/build.ts` (#2 — build-time bounds injection into the bundled hljs CJS entry)
- `src/ink/render-border.ts` (#11 — `resolveBorderStyle` validating resolver per official `Dvn`; `quote` style bytes; skip-draw on unknown)
- `src/ink/styles.ts` (#11 layout side — border width from validity per official `uE`: `resolveBorderStyle(style.borderStyle) ? 1 : 0`)
- `src/ink/dom.ts` (#19 — `measureTextNode` rewired to official `mE` via `normalizePieces`)
- `src/ink/output.ts` (#19 — painter bidi-neutralizes via `replaceBidi`; charCache keyed on neutralized string)
- `src/ink/render-node-to-output.ts` (#19 — styled-piece normalization, `widthProbeText` split per official `ce`, no-wrap re-slice, `Rv` CR pre-pass, `cf` CR skip)
- `src/utils/plugins/validatePlugin.ts` + `src/cli/handlers/plugins.ts` + `src/commands/plugin/ValidatePlugin.tsx` (#16/#22a — co-located plugin.json validation, `kind:'anthropic'|'alone'` gate, usage text)

**Deleted:**
- `src/ink/tabstops.ts` (superseded by `normalize-text.ts`; zero remaining importers verified)

**New — research/docs:**
- `docs/gap-research-289/` (`changelog-entries-289.txt` + 6 cluster reports a–f)
- `docs/upstream-version-gap-occ107-2026-10.md` (this ledger)

**Release metadata:**
- `package.json` (2.1.368 → 2.1.369), `CHANGELOG.md` (2.1.369 section), `README.md` (tracks 2.1.289), `src/entrypoints/cli.tsx` (dev polyfill VERSION 2.1.289)
