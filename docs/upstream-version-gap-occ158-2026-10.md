# Upstream Gap Ledger — OCC-158 Round (2026-10-15)

**Baseline:** official Claude Code latest = **2.1.299** (npm dist-tags: `latest` 2.1.299 published 2026-10-14T00:23Z; `next` 2.1.300 (pre-release channel only, pre-triage archive, NOT aligned per OCC-95 convention); `stable` 2.1.287 unchanged). Official **skipped 2.1.297/2.1.298 on npm** (never published; 2.1.296 → 2.1.299 directly) — the official CHANGELOG has no separate 297/298 sections; ALL changes land in one **2.1.299 section = 190 entries** (17 Added + 22 Changed + 115 Fixed + 36 other-prefix lines: Windows:/Self-hosted runner:/Improved/…). OCC main HEAD = `b9f6a7f` = tag **v2.1.382** = package.json `2.1.382`; main CI green (run `38461009254`). OCC README Tracks (4 sites: L8 badge, L16 lead paragraph, L65 capability-parity row, L160 status list) = **2.1.296 (partial)**.

**Forensic artifacts (this round):** `@anthropic-ai/claude-code-linux-x64@2.1.296` ELF md5 `3c8749470f70a26efadf982b587e1548` (matches occ113 record) and `@2.1.299` ELF md5 `fee7941c357b984808a5e87abab47d5c`. Strings diff (`strings -n 8 | sort -u`, comm): **26631 new / 22734 removed** strings (s296=319894, s299=323791). **Discipline: the official ELF is NEVER executed** — `strings` / `grep -aboF` / bounded `dd` only (occ115 precedent). Behavioral A/B uses the runnable channels only (`uvx claude-code` / npm JS package) per Leader ruling.

**Never invent.** Every PORT/STAGED disposition below carries binary evidence (string/offset/dd excerpt) or a reproducible OCC-side run. Unevidenced items are marked CAND.

---

## 1. STAGED carryover re-adjudication (occ156 §7.3 authoritative entry + occ157 §5)

**Trigger check — NOT fired (both).** occ156-03 and occ157-03 carry STAGED items whose re-adjudication trigger is "official `stable` dist-tag ≥ 2.1.296". Verified this round via `npm view @anthropic-ai/claude-code dist-tags --json`: `latest` = 2.1.299, `next` = 2.1.300, **`stable` = 2.1.287 (unchanged)**. 2.1.287 < 2.1.296 → triggers did NOT fire; the occ156 §7.3 / occ157 §5 STAGED set carries over **as-is**, re-adjudication deferred to the round where stable crosses 2.1.296.

**New-evidence scan in the 2.1.299 strings delta:** all candidate "new" strings matching the carried STAGED items' gate vocabulary (`gate_off`, `auto_default_nudge`, auto-mode opt-in dialog family) were extracted and diffed with ±60-char context windows against their s296 counterparts — every hit is a **minifier rename** (identical semantics, different mangled identifiers), zero substantive new logic for the carried STAGED items. No carryover item gains new porting evidence this round; none is re-adjudicated.

**occ157 §5 STAGED additions from THIS round's triage** (rationale per cluster file, §2 below): B-cluster #106/#108 (symlink sandbox bypass — fix lives in vendored `@anthropic-ai/sandbox-runtime@0.0.44`; bump/patch next round), #107 (glob brace/paren divergence picomatch vs bwrap/seatbelt), #109 (worktree awk acceptance — logic-level, messages 8=8); A-cluster #150 (WorkflowEngine vm nesting-depth guard — official new-in-299 `DR=4096, UUe=1e5, LAr=28000` constants recovered; behavioral probe first next round); E-cluster #002+#003 (idle-compaction feature), #009 (FleetView slash-command input), #019 (gateway-model compaction limit), #066 (oversized-image reattach loop), #073 (2.1.296-introduced resume double-run regression — **OCC inheritance check assigned this round**, verdict in §3), #104 (MCP reconnect lifecycle), #140 (PDF bytes out of transcript), #061/#063/#083/#084 (render family — yoga `getOfferedWidth` + `Dg` re-wrap reconciliation; full port plan recovered in triage-E fragment R1).

## 2. Changelog triage — 190 entries (cluster files A/B/D/E/F)

Cluster assignment (awk keyword rules, `/tmp/cc-diff-299/assign.awk`): **A** = mods/plugins/hooks (38), **B** = security/sandbox/permissions/credentials (20), **D** = Windows (3, folded into the F table), **E** = infra/REPL/UX (66), **F** = cloud/ecosystem + D (66). Total 190. Dispositions: **PORT / STAGED / N-A / ALREADY-ALIGNED**. Full per-cluster tables with binary evidence below (salvaged verbatim from the triage agents' ledgers; forensic artifacts under `/tmp/cc-diff-299/` — cleaned after this round per resource-safety discipline).

**Round tally: PORT 66 · STAGED 17 · N-A 104 · ALREADY-ALIGNED 3** (A: 5/1/32/0 · B: 12/4/3/1 · E: 44/12/9/1 · F+D: 5/0/60/1; E PORT includes 031/033/049/069/103 from deep-dive fragments; family groupings per triage-E tally).


### Cluster A — mods / plugins / hooks (38)


Method: official v299 + v296 Bun binaries inspected via `strings -n 8` / `grep -aboF` / `dd` only (NEVER executed); pre-extracted `/tmp/cc-diff-299/s299.txt`, `s296.txt`, `new_strings.txt` (26,631 strings new in 299), `removed_strings.txt`; helpers `sctx.pl` / `bctx.sh`. OCC surface checked by grep per feature (no assumptions).

**Key structural finding:** official 2.1.299's dominant new surface is the **mods plugin JS-hook middleware API** (`$.` namespace: `prompt.submit`, `tool.check`, `tool.call`, `session.append`, `skill.prompt`, `turn.start`, `agent.spawn`, `$.ui`, `$.http.fetch`, `$.state`, `$.env.set`, `$.session.identity`, `$.prompt.media`, `next()` chaining) — 135 pattern hits in s299 vs 116 in s296; **completely absent in OCC** (0 verified hits after false-positive elimination). Also absent in OCC: `claude plugin eval`, `claude plugin test`, `plugin_loaded` telemetry, JS hooks modules (`modulePath`), built-in plugin registrations, plugin-authoring skill. OCC's classic surfaces (JSON-matcher hooks, plugin loader/marketplace, `/plugin`, `/reload-plugins`, `plugin validate`, `--plugin-dir`, sandbox denyWrite, accept-edits guards) are rich and were checked entry-by-entry.

**Tally: PORT = 5 (027, 082, 122, 167, 168) · STAGED = 1 (150) · N-A = 32**

## Summary table

| # | entry (short) | disposition | OCC surface evidence | notes |
|---|---|---|---|---|
| 004 | `$.prompt.media` for managed mods' `prompt.submit` | N-A | no mods `$.` API in OCC (grep: 0 hits for `prompt.submit`/`$.prompt.media` machinery) | mods-only surface |
| 005 | `$.session.identity()` for managed mods | N-A | no mods API; OCC has no managed `forceLoginOrgUUID` mod bridge | mods-only |
| 006 | mods `Text` size/weight/mono/tabular + `Box` spacing steps | N-A | official prop sets new in 299: `MTr=new Set(["dimColor","bold",…,"mono","tabular"])`, `Dwo={Box:Set([…]),Text:Set([…])}` — mods renderer; OCC has no mods Text/Box | `bold`→`weight` deprecation is mods-internal |
| 008 | `skill.prompt` mod hook receives frontmatter/source/plugin/path | N-A | no `skill.prompt` hook surface in OCC | mods-only |
| 012 | `plugin eval --disallow-tools` + `disallowed_tools` case field | N-A | OCC `src/cli/handlers/plugins.ts` has validate/list/marketplace/install/uninstall/enable/disable/update only — no `eval` | official strings: `Removed from Claude's tools in every case (--disallow-tools): …`, ``error:`disallowed_tools: …` ``, `pluginDirsUnderTest` |
| 015 | `session.append` mod hook `queue` door | N-A | no `session.append` in OCC | mods-only |
| 016 | `/plugin` + `validate` name mod hooks skipped under org management | N-A | OCC has `/plugin` & `plugin validate` but no mod hooks exist to enumerate | mods-only |
| 020 | mod `prompt.submit` keeps headless run past `--max-turns`/budget/interrupt | N-A | no mods `prompt.submit` in OCC | mods-only |
| 022 | Write/Edit creates mod in session mods folder without asking (accept-edits, config dir without `.claude`) | N-A | OCC has no mods folder (official: `Ho="mods"; Do="mods/"`); OCC accept-edits guard = `DANGEROUS_DIRECTORIES` segment check incl. `.claude` (`filesystem.ts:107-115, :496`) | side observation: a custom `CLAUDE_CONFIG_DIR` lacking a `.claude` segment is unguarded in OCC too — pre-existing general concern, not this mods entry; candidate hardening item |
| 023 | installed mods keep running after remote turn-off; unload between turns | N-A | no mods runtime in OCC; classic plugin disable works via settings + `/reload-plugins` | mods-only |
| 027 | sandboxed shell can write into `--plugin-dir` (code reloaded & run outside sandbox) | **PORT** | OCC has `--plugin-dir` (`main.tsx:998-1013` → `setInlinePlugins`; `bootstrap/state.ts:143`; `pluginDirectories.ts getPluginSeedDirs`) and sandbox denyWrite (`sandbox-adapter.ts:505-585`) with **zero** plugin coverage (`grep -c "plugin"` = 0) | detail below; needs one targeted decompile of official sandbox config builder first |
| 036 | mod `prompt.submit` rewrite silently dropped (pasted/unreadable image) | N-A | no mods `prompt.submit` in OCC | mods-only |
| 050 | mod hook re-run endlessly awaiting another mod's noun | N-A | no mods noun/await machinery in OCC | mods-only |
| 054 | `tool.describe`/`prompt.section` answer after `$.ui.invalidate` never reaches Claude | N-A | no `tool.describe`/`prompt.section`/`$.ui` in OCC | mods-only |
| 056 | `plugin test` pauses hook time budget while served `$` method keeps calling | N-A | no `plugin test` in OCC | mods-only |
| 058 | plugin hooks skipped passing very deeply nested input via `next()` | N-A | no `next()` middleware in OCC | sibling of 150 (serializer) |
| 059 | value refused whole when one getter throws `RangeError`; now per-key | N-A | no mods/plugin-hook VM value-copy layer in OCC | sibling of 150 |
| 067 | `plugin_loaded` telemetry `has_hooks` false for hooks-module plugins | N-A | OCC: `grep -rn plugin_loaded src/` = 0 hits; no JS hooks modules (`loadPluginHooks.ts` = classic events only, no `modulePath`) | official 299: `has_hooks = hooksConfig!==void 0 || modulePath!==void 0` (296: only hooksConfig) |
| 071 | mod hot reload ignores fix saved right after failed reload | N-A | no mod hot reload in OCC | mods-only |
| 072 | mods from source files refused when `$` handed to imported function declaration | N-A | no mods source loading in OCC | mods-only |
| 075 | `__proto__` keys silently removed from mod-hook values could skip `tool.check` | N-A | no mods `tool.check` in OCC | mods-only |
| 082 | `/reload-plugins` misses plugin installed from another terminal a moment earlier | **PORT** | OCC `/reload-plugins` → `refreshActivePlugins` (`refresh.ts`) → `clearAllCaches()`, but `clearAllPluginCaches()` (`cacheUtils.ts`, 10 clears) **omits** `clearInstalledPluginsCache()`; `installedPluginsCacheV2` memoized (`installedPluginsManager.ts:62-102`); exporter has **zero callers**; stale TODO at `pluginLoader.ts:3487` | detail below |
| 087 | `$.http.fetch` refuses 304/204/205 declaring Content-Length > 4 MiB | N-A | no `$.http` in OCC | mods-only |
| 095 | `plugin eval` passes API-refused runs; now score 0 + exit 1 | N-A | no `plugin eval` in OCC | — |
| 119 | `agent.spawn` mod hook not running on resumed subagent/killed teammate | N-A | no `agent.spawn` mod hook in OCC | mods-only |
| 120 | `plugin validate` rejects `$.state` refs when no `types` key | N-A | OCC `pluginValidateHandler` has no mods contract/`$.state`/types validation | mods-only |
| 121 | mods `dimColor` looks like plain text (dark ANSI theme, 16-color) | N-A | fix lives in mods renderer prop layer (`MTr`/`Dwo`, new in 299); OCC's ink `dimColor` is a separate pre-existing surface unaffected by this change | — |
| 122 | plan mode runs a write that a `PreToolUse` hook (or mod `tool.check`) allowed | **PORT** | OCC `resolveHookPermissionDecision` (`toolHooks.ts:385`): hook `allow` **stands** when `checkRuleBasedPermissions` (`permissions.ts:1378`) returns null; plan/auto classifier gates (`permissions.ts:608, :746-760, :1136-1160` `plan_mode_floor`, CC 2.1.290 port) don't cover the hook-allow path → hook allow bypasses plan mode | detail below; **highest-value port of this cluster** (official `Mur()` + new telemetry) |
| 132 | user mod `$.env.set` changes env/shell prefix of managed-settings command hooks | N-A | no `$.env` in OCC | mods-only |
| 139 | managed permission rules / managed hooks / org MCP tool names enforced against user mods | N-A | no mods in OCC; classic managed-settings enforcement already present | mods-only |
| 143 | plugin-authoring skill: ask public/private + check files before creating GitHub repo | N-A | OCC bundles **no** built-in plugins (`src/plugins/bundled/index.ts`: "No built-in plugins registered yet"), no plugin-authoring skill (grep 0); official bundles built-in plugin `cc-plugin-plugin-authoring` | — |
| 150 | plugin hooks & workflow scripts refuse values nesting > 28,000 (workflow: 100,000) with named-limit error | **STAGED** | plugin-hook half N-A (no JS hooks); workflow half real: OCC `WorkflowEngine.ts` node:vm (`createContext :248`, `new vm.Script :258`) has **no** copy/clone/depth/stack guard on values crossing the VM boundary | official new-in-299: `LAr=28000`, `UUe=1e5`, `"nesting deeper than 28000 levels is not supported"`, `"nesting deeper than 100000 levels is not supported"`; detail below |
| 151 | actions a plugin hook can block are refused (not let through) when hook can't be handed them / can't hand back; ran tool's result withheld | N-A | new-in-299 official plugin-hook deny module: `J="this tool input could not be given to a hook that checks it, so the tool was not run"`, `Ee="this could not be given to a hook that checks it, so it was not done"`, `Gtn="a hook that checks this result could not hand back its answer"`, guard set `Fe` spans `classic.PreToolUse`/`classic.PermissionRequest`/`tool.call`/`session.append`/`agent.offer`/`ui.input`… — the plugin-hook bridge OCC lacks | OCC **already has** the classic-hook equivalent: 2.1.288 #57 fail-closed port (`hooks.ts:2825-2960`: `GUARDED_HOOK_EVENTS`, `hookInputNotJsonWritableMessage`, size cap, matcher-failure→block); official's 288 message (`FLt`) still alive in s299 alongside the new module |
| 155 | `plugin test` `ui.render` trees: roots carry `part:{plugin}` | N-A | no `plugin test` / `ui.render` in OCC | mods-only |
| 157 | `plugin test` fails served `$` method unanswered within 10 s | N-A | no `plugin test` in OCC | mods-only |
| 167 | `UserPromptSubmit` hooks run **before** skill/custom slash command expands; blocking hook stops embedded shell | **PORT** | OCC `processUserInput.ts`: `processUserInputBase(…)` (expansion) at ~:157 runs **before** `executeUserPromptSubmitHooks(…)` at :184; expansion executes embedded ```` ```! cmd``` ```` shell blocks (`promptShellExecution.ts` `BLOCK_PATTERN`) → shell runs even when a hook would block | detail below |
| 168 | skill's own front-matter `UserPromptSubmit` hook first runs on the prompt **after** the invoking one | **PORT** | OCC `processSlashCommand.tsx:991-1000`: `registerSkillHooks(…)` fires during expansion of the invoking prompt; with OCC's current expansion-before-hooks order (167), the skill's hook fires on its own invoking prompt | falls out of the 167 reorder; detail below |
| 169 | `turn.start` mod hook hears subagent/teammate turns (`e.agentId`) | N-A | no `turn.start` mod hook in OCC | mods-only |

## PORT details

### 122 — plan/auto mode must strip hook `allow` (security, highest priority)

**Official forensic evidence** (v299 binary, `Mur()` @ ~226848501; strings in `new_strings.txt`):
- Reason-string builder: confined → `"a confined session takes grants only from its command line"`; Projects → `` `hooks cannot approve ${tool} in a Projects session` ``; hosted desktop tools → `"hooks cannot approve a hosted session's desktop tools"`; **new in 299** auto/plan arm → `` `while auto mode is on (also behind plan mode) a hook cannot approve ${tool}` `` gated by `_wr(...)`/`Qs(J_(...))` (auto-mode state check), firing telemetry `tengu_auto_mode_permission_request_allow_ignored` (0 hits in s296; new in 299).
- Stripping: `if(e.permissionBehavior==="allow") → debug "${name} permissionDecision=allow ignored: ${reason}", e.permissionBehavior=void 0`; same for `e.permissionRequestResult?.behavior==="allow"` → `permissionRequestResult=void 0`. A companion (`WFn`) strips WebFetch/WebSearch-loosening `updatedPermissions`. Only **allow** is stripped; deny/ask pass through.

**OCC gap**: `src/services/tools/toolHooks.ts:385` `resolveHookPermissionDecision` — "Rule check passed (null) — hook decision stands" → `return { decision: hookPermissionResult, input: hookInput }`. `checkRuleBasedPermissions` (`permissions.ts:1378`) returns null on "no rule-based objection", so a `PreToolUse` hook's `permissionDecision:"allow"` executes writes **in plan mode** (plan rides the auto-mode classifier in 2.1.29x; OCC's `plan_mode_floor` port at `permissions.ts:1136-1160` never sees the hook-allow path).

**Fix**: in `resolveHookPermissionDecision`, before honoring a hook `allow` (both `permissionDecision` and PermissionRequest-style `behavior:"allow"` results), check plan-mode/auto-mode state; if active, drop the allow (fall through to the normal ask/dialog flow), log the official debug line shape, and emit a `tengu_auto_mode_permission_request_allow_ignored`-equivalent event. Skip confined/Projects/hosted arms (OCC has no such session types). Keep deny/ask untouched.
**e2e**: plan mode + PreToolUse hook emitting `{"hookSpecificOutput":{"permissionDecision":"allow"}}` for Write → the write must NOT silently execute (dialog/ask per official); same probe in default mode → allow still honored.

### 082 — `/reload-plugins` must see freshly-installed plugins

**Gap**: `installedPluginsCacheV2` (`installedPluginsManager.ts:62-102`) memoizes the installed-plugins config for the process lifetime; `clearInstalledPluginsCache()` is exported but has **zero callers**; `clearAllPluginCaches()` (`cacheUtils.ts` — clearPluginCache, clearPluginCommandCache, clearPluginAgentCache, clearPluginHookCache, clearPluginOptionsCache, clearPluginOutputStyleCache, clearAllOutputStylesCache, clearCommandsCache, clearAgentDefinitionsCache, clearPromptCache) omits it; `pluginLoader.ts:3487` still carries `// TODO: Clear installed plugins cache when installedPluginsManager is implemented`. So a plugin installed from another terminal is invisible to `/reload-plugins` → `refreshActivePlugins` → `loadAllPlugins` until restart.
**Fix**: add `clearInstalledPluginsCache()` to `clearAllPluginCaches()` (covers all 3 `refreshActivePlugins` call sites incl. `/reload-plugins`); remove the stale TODO.
**e2e**: start REPL; from another shell add a plugin to the installed config; `/reload-plugins` → plugin appears in `Reloaded: N plugins · …` without restart.

### 167 — UserPromptSubmit hooks before skill/slash expansion (blocks embedded shell)

**Gap**: `processUserInput.ts` — `processUserInputBase(...)` at ~:157 performs skill/custom-command expansion, which runs embedded ```` ```! cmd``` ```` blocks via `executeShellCommandsInPrompt` (`promptShellExecution.ts`, `BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g`; also used by `/commit`, `/security-review`, skills loader) **before** `executeUserPromptSubmitHooks(inputMessage, ...)` at :184. A blocking UserPromptSubmit hook therefore cannot stop embedded shell execution.
**Fix**: move `executeUserPromptSubmitHooks` (+ blocking/preventContinuation, `additionalContexts`, `sessionTitle` handling) ahead of `processUserInputBase`; feed the hook-mutated prompt into expansion. Verify the headless `-p` path (`executeHooksOutsideREPL`) keeps the same order.
**e2e**: prompt containing ```` ```! touch /tmp/pwned``` ```` with a UserPromptSubmit hook returning `decision:"block"` → `/tmp/pwned` must not exist; without the hook → embedded shell still runs.

### 168 — skill front-matter hook first fires on the NEXT prompt

**Gap**: `processSlashCommand.tsx:991-1000` — `registerSkillHooks(context.setAppState, sessionId, command.hooks, ...)` (gated by `!isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source)`) runs during expansion of the invoking prompt; under OCC's current order (expansion → hooks) the just-registered hook fires on the invoking prompt itself.
**Fix**: no separate code change — landing the 167 reorder (hooks before expansion) makes registration happen after the invoking prompt's hook pass, so the skill's hook first fires on the next prompt, matching official. Add a regression test pinning this ordering.
**e2e**: skill with front-matter `UserPromptSubmit` hook that logs/blocks; invoke the skill → hook must NOT fire on the invoking prompt; send a second prompt → hook fires.

### 027 — sandbox denyWrite must cover `--plugin-dir` folders

**Gap**: `--plugin-dir` paths (`main.tsx:998-1013` → `setInlinePlugins`; `bootstrap/state.ts:143` "Session-only plugins from --plugin-dir flag"; `pluginDirectories.ts getPluginSeedDirs`) are loaded and executed **outside** the sandbox, but `sandbox-adapter.ts:505-585` denyWrite construction (settings paths via SETTING_SOURCES, `getManagedSettingsDropInDir()`, `.claude/skills` under originalCwd+cwd, `reconcileClaudeSymlinks()`, bare-git `computeBareGitRepoDenyPaths()`) has zero plugin entries → a sandboxed shell command can write plugin code that CC later reloads and runs unsandboxed.
**Forensic note**: official main-sandbox denyWrite builders (8 hit sites) expose no plugin-dir string; the only denyWrite+plugin co-occurrence is the plugin-eval sandbox (`pluginDirsUnderTest`) — so before implementing, do one targeted decompile of the official sandbox config builder (`qe.getFsWriteConfig` / `MJe` merge path) to confirm the exact shape (resolved absolute dirs, recursive deny, symlink handling).
**Fix**: append resolved inline-plugin dirs (realpath, both original and symlink-resolved like neighboring entries) from bootstrap state/`getPluginSeedDirs` to the denyWrite set in `sandbox-adapter.ts`.
**e2e**: run with sandbox + `--plugin-dir /tmp/pd`; sandboxed Bash `touch /tmp/pd/evil.js` → must fail; plugin still loads/reads normally.

## STAGED details

### 150 — VM-boundary value depth limits (28,000 plugin hooks / 100,000 workflow scripts)

**Official evidence** (new in 299): `var DR=4096, UUe=1e5, LAr=28000, BUe="nesting deeper than 100000 levels is not supported", Rnn="nesting deeper than 28000 levels is not supported", NAr="the stack ran out while copying a value across the VM boundary"` (the stack message existed ×3 in 296; both named-limit messages are new). Serializer arms: `` `nests deeper than ${limit}` ``, `"holds a Proxy"`, `"holds a cycle"`, `"holds an object that is not plain"`.
**OCC state**: plugin-hook half is N-A (no JS hooks modules). Workflow half is a real gap: `src/tools/WorkflowTool/WorkflowEngine.ts` uses node:vm (`vm.createContext(sandbox,...)` :248, `new vm.Script` :258) with **no** structured-copy/depth/stack guard on values crossing the boundary — a deeply nested result today risks a raw `RangeError` stack overflow or silent by-reference sharing.
**Why STAGED**: matching official requires building the boundary-copy subsystem (or an equivalent depth-counting guard) that OCC's workflow engine doesn't have at all — too large for this round's CLI-local port budget. Next round: behavioral probe first (workflow script returning a >28k-deep object; record OCC's current failure mode), then implement the 100,000-limit arm with the official error string.

## Cross-cutting note

Entries 058/059/150/151 all live in the official plugin-hook value-serialization layer (VM boundary copy). When OCC eventually adopts plugin JS hooks modules (`modulePath`), port that layer as a unit: depth limits (28000/100000), per-key getter-RangeError refusal, Proxy/cycle/non-plain rejection, and the deny-not-passthrough guard set (`Fe`) with messages `J`/`Ee`/`Gtn` — on top of the already-ported classic-hook fail-closed (288 #57).

### Cluster B — security / sandbox / permissions / credentials (20)


Forensics: `/tmp/cc-diff-299/v299/package/claude` (+v296) via strings/grep -aboF/dd only; never executed.
OCC survey: repo at workdir/occ (3 parallel read-only Explore surveys).

## Summary table

| # | Entry (short) | Disposition | Severity | Evidence |
|---|---|---|---|---|
| 052 | Server-managed settings req carries gateway API key | **PORT** | CRITICAL (cred leak) | v299 has first-party discriminator family (`isFirstPartyAnthropicBaseUrl`, `hasCustomBaseUrlForAnalytics`, `getAPIProviderForAnalytics` @239295153 export table); OCC `utils/http.ts:69` TODO admits gateway-key breakage; `remoteManagedSettings/index.ts:110` GETs `${BASE_API_URL}/api/claude_code/settings` |
| 070 | flags/startup/fast-mode/profile/feedback carry gateway key | **PORT** | CRITICAL (cred leak) | growthbook str count 59→61, getAuthHeaders 39→40 (v296→v299); OCC hardcodes `api.anthropic.com` in `growthbook.ts:503-506`, `fastMode.ts:433,442`, `Feedback.tsx:514`, `bootstrap.ts:64,79`, `firstPartyEventLoggingExporter.ts:114-120` — all send the ONE resolved key (`auth.ts:234`) |
| 025 | Teammate w/o description keeps credential in taskDescription | **PORT** | HIGH (cred leak) | OCC `spawnMultiAgent.ts:843` slices raw `prompt.substring(0,50)` into description; redaction engine exists (`utils/secretRedaction/engine.ts`) but NOT wired; exposed via `AgentProgressLine.tsx:51`, `TaskOutputTool.tsx:267,350`, hooks `task_description` (`hooks.ts:5828,5872`) |
| 106 | macOS sandbox: denied path via symlink readable/writable at real location | **STAGED** | HIGH (sandbox escape) | Seatbelt profiles generated by vendored `@anthropic-ai/sandbox-runtime@0.0.44` (`macos-sandbox-utils.js:117-140`); OCC `reconcileClaudeSymlinks()` (`sandbox-adapter.ts:834-875`) only covers `.claude/*`, fails closed there; general denied-path realpath coverage lives in runtime; `real location` string counts identical v296/v299 (8=8) → fix is code/runtime-level, not extractable from strings |
| 108 | glob allowRead/allowWrite not re-checked when base dir → symlink | **STAGED** | HIGH (sandbox escape) | Same runtime delegation; OCC has 292-era re-point cadence (`sandbox-adapter.ts:1529-1533` refreshConfig before every command) but no glob-root symlink-swap re-check; official logic not string-visible |
| 097 | forceLoginOrgUUID/Method hidden/replaced by server-managed settings | **PORT** | MED-HIGH (policy override) | v299 spec string @110685262: "a forceLoginOrgUUID, or a forceLoginMethod of claudeai or console, that this machine's own MDM policy or managed settings file sets **applies ahead of server-managed settings**"; OCC precedence is REVERSED: remote > HKLM/plist > managed-settings.json > HKCU (`settings.ts:587-589,673,977-983`) |
| 042 | MCP server named constructor/prototype never connects | **PORT** | MEDIUM | Official guard: `mG(e){return e in Object.prototype&&fa(e)}` @215351978 + msg @110526560 "may not be constructor, prototype, __proto__, __defineGetter__…" + frozen set `["__proto__","constructor","prototype"]` @218410266; OCC MCP only refuses `__proto__` (`services/mcp/config.ts:1727-1738`); unguarded reads `servers[name]` (`config.ts:726,733,740`; `cli/handlers/mcp.tsx:313`) hit Object.prototype → false "exists"/never-connect |
| 098 | --bare leaves out constructor/prototype server --channels asked for | **PORT** | MEDIUM | Same reserved-name family applied to channel selection; OCC has `--bare` (`main.tsx:1069,2149-2155`) and `--channels` (`main.tsx:4345,1978-2040`, `channelAllowlist.ts:59`) but no reserved-name guard on either path; marketplace already has `UNRECORDABLE_NAMES=Set(['constructor','prototype'])` (`utils/plugins/optionKeySafety.ts:37`) — reuse for MCP |
| 034 | WSL2 bwrap `Can't mkdir /mnt/c/Program Files/ClaudeCode` | **PORT** | MEDIUM (sandbox availability) | New v299 WSL Windows-mount detection: fstype sets `drvfs 9p virtiofs cifs smb3 smbfs nfs ntfs fuseblk vfat exfat…` @220000886 (`Rws`/`xws`), mount-table scan `Cf`/`Of` @254393924 reading `/proc/mounts`, `aname=drvfs` option regexes, refuse-on-undetermined ("the WSL mount table (/proc/mounts) cannot be read"); OCC: zero hits for drvfs//proc/mounts in src or runtime dist; OCC supports WSL2 (`sandbox-adapter.ts:1206,1289`) |
| 039 | Sandboxed cmd left empty `.config.json` → sign-in/MCP/trust lost | **PORT** | MEDIUM (auth/state loss) | v299 expanded 0-byte placeholder handling (count 3→9 v296→v299), incl. prompt text @107002052 ("The sandbox creates 0-byte placeholder files… do not stage…") and stale-mask diagnostic @228225896 ("0-byte read-only file where a settings file belongs makes 'Yes, and don't ask again' fail to save"); OCC partial: `wouldLoseAuthState()` (`config.ts:~871-885,1301`), `cleanupAfterCommand` ghost-dotfile cleanup (`Shell.ts:390-392`) — verify/extend coverage to config-dir `.config.json` |
| 091 | Enter answered held-back prompt while unsent message typed | **PORT** | MEDIUM (accidental permission grant) | v299 withdrawal mechanism: `ask_withdrawn`, "standing request taken back unsent", `unreachable_unaccepted` @112233225; OCC: 1500ms `PROMPT_SUPPRESSION_MS` debounce (`REPL.tsx:1067,1455`) releases dialogs even with unsent text, then Enter hits dialog Select (`CustomSelect/select.tsx:47`) — no grace/ignore-first-Enter guard |
| 043 | MCP constructor/toString tools ask permission in auto+bypass | **PORT** | LOW-MED | Same reserved-name root cause; OCC `mcp__` parsing is string-based (`mcpStringUtils.ts:23`; `permissions.ts:276-298`) so partly mitigated — must verify auto/bypass allowlist matching doesn't do record lookups keyed by server name |
| 040 | /sandbox reported success when project folder not writable | **PORT** | LOW (UX honesty) | Official adds "nothing changed + why" messaging (`nothing changed` family in new_strings); OCC gap confirmed: `updateSettingsForSource` returns `{error}` (`settings.ts:716-719`) but BOTH sandbox call sites ignore it (`sandbox-adapter.ts:1396,1732`) and `sandbox-toggle.tsx:76-78` prints success unconditionally |
| 011 | One-time plan-mode note when bypassPermissions available | **PORT** | LOW (UX) | v299 notice id `plan-mode-bypass-notice` @101543286: "Session was started with bypass permissions, so plan mode won't ask before most edits or commands. Start a new session without bypass permissions for prompts in plan mode."; OCC EnterPlanModePermissionRequest has no bypass mention (only "No code changes will be made until you approve the plan", :66) |
| 107 | denyRead/allowRead globs w/ braces/parens/backslashes read differently | **STAGED** | MEDIUM | Divergence structural in OCC: picomatch screening (`trustedTierGrants.ts:62,154,308-333`) vs bwrap/seatbelt prefix enforcement via `globBase`; official normalization logic not string-isolable (brace tokenizer found @218908132 is JSON-schema, 5=5 across versions); needs deeper code-level extraction next round |
| 109 | Worktree isolation accepted some awk programs it should refuse | **STAGED** | MEDIUM (hardening) | Official awk refusal messages identical v296/v299 (8=8, @109058856: system(), command pipe, @load/@include, extension(), /inet/) → fix is logic-level under `worktreeSession` flag (@101881040), not string-visible; OCC has `inspectAwkProgram` (`ast.ts:3895-3920`, v288 port) + gates (`ast.ts:4500-4537`) but `worktreeGitRedirectGuard.ts` has no awk coupling — audit worktree-mode awk acceptance vs official |
| 078 | Managed settings/org policy not fetched when stored plan changed locally (forceLoginOrgUUID machines) | **N-A** | — | Fetch-trigger tied to Anthropic account/login-plan state; OCC remote fetch gated to first-party base URL + enterprise auth (`syncCache.ts isRemoteManagedSettingsEligible`); no local plan-change lifecycle in OCC (no real Anthropic login plan) |
| 096 | Permission prompts cut off/wrap early w/ keycap or joined emoji | **ALREADY-ALIGNED** | — | OCC `ink/stringWidth.ts` handles keycaps+ZWJ: `needsSegmentation` on VS16/ZWJ (:88-104), `getEmojiWidth`=2 for full keycap/3-cp and ZWJ sequences, 1 for incomplete keycap (:107-127); official keycap regex `^[#*0-9]️?⃣$` present in BOTH versions (2=2) — no new string; residual Bun-vs-JS fallback divergence documented in-file (monitor, don't port) |
| 141 | Linux sandboxed Bash: Esc/Ctrl-C during wildcard read-rule expansion | **N-A** | — | Surface absent: OCC has NO async wildcard-expansion step — 292 port uses synchronous `refreshConfig()` re-point cadence before every command (`sandbox-adapter.ts:1529-1541`, eslint-enforced sync :919-1029); nothing to cancel; `Esc to cancel` strings unchanged (10=10, feedback-form context @102602386) |
| 171 | Cyber safeguard notice no longer asks to apply to Cyber Verification Program | **N-A** | — | Server-side real-time cyber-safeguards UI (tengu_jazzy_goblet). Forensics: "Cyber Verification Program" v296 @101155981/@211539675 ("Apply to the Cyber Verification Program to reduce these interruptions."), 0 hits in v299; OCC has no such notice (grep "Cyber Verification" src/ = 0 hits); OCC's `CYBER_RISK_INSTRUCTION` (`constants/cyberRiskInstruction.ts:24`) matches official prompt text byte-identical in both versions (@106611587) — nothing to change |

Counts: **PORT 12 · STAGED 4 · N-A 3 · ALREADY-ALIGNED 1** (= 20)

---

## PORT details (ranked by severity)

### P1/P2 — #052 + #070: gateway API key leaked to Anthropic-owned endpoints (CRITICAL)
Official behavior: auxiliary Anthropic requests (server-managed settings, feature flags, startup, fast mode, profile, feedback) must NOT carry the API key configured for a third-party gateway (`ANTHROPIC_BASE_URL`); genuine Anthropic API keys are still sent. Discriminator family confirmed in v299 export table @239295153 (`isFirstPartyAnthropicBaseUrl`, `isActualFirstPartyAnthropicBaseUrl`, `hasCustomBaseUrlForAnalytics`, `getAPIProviderForAnalytics`, `hasFirstPartyCapabilities`).
OCC gap: one resolved key (`getAnthropicApiKeyWithSource`, `auth.ts:234`) attached via `getAuthHeaders()` (`utils/http.ts:69` — explicit TODO "this will fail if the API key is being set to an LLM Gateway key") to hardcoded `api.anthropic.com` calls: `growthbook.ts:503-506,518,554`, `firstPartyEventLoggingExporter.ts:114-120`, `fastMode.ts:433,442`, `bootstrap.ts:64,79`, `Feedback.tsx:514`, `usage.ts:175`, `referral.ts:36`. `bootstrap.ts:49`/`fastMode.ts:114` gate only on `getAPIProvider()!=='firstParty'`, which does NOT catch an `ANTHROPIC_BASE_URL` gateway.
Implementation notes: add `isFirstPartyAnthropicBaseUrl()` (hostname ∈ {api.anthropic.com, first-party variants} AND no custom `ANTHROPIC_BASE_URL`/gateway env) next to `auth.ts`; in `getAuthHeaders()` (or a new `getAnthropicOwnedRequestHeaders()`), omit `x-api-key`/`Authorization` when the resolved key source is a gateway config (`ANTHROPIC_BASE_URL` set / `usesCustomBaseUrl`) — or skip the request entirely where unauthenticated calls are rejected (growthbook init, event logging, fast-mode, feedback, bootstrap, managed-settings fetch). Mirror official `hasCustomBaseUrlForAnalytics` semantics: analytics/aux traffic either keyless or dropped under gateway. Tests: set `ANTHROPIC_BASE_URL=https://gw.example` + `ANTHROPIC_AUTH_TOKEN=gw-secret`; assert no outbound header contains `gw-secret` to api.anthropic.com (nock/msw), while a real `ANTHROPIC_API_KEY` (sk-ant-) IS still sent.

### P3 — #025: teammate taskDescription credential retention (HIGH)
Official: teammate started without `description` must not keep prompt fragments (potential credentials) in the displayed task description.
OCC gap: `spawnMultiAgent.ts:843` — ``description = `${sanitizedName}: ${prompt.substring(0,50)}…` `` stored via `createTaskStateBase` (:848-853); rendered in `AgentProgressLine.tsx:51`, `TaskOutputTool.tsx:267,350`, `ListPeersTool.ts:189`, and emitted to hooks as `task_description` (`hooks.ts:5828,5872`). No `redact` anywhere in tasks/swarm paths.
Implementation: run the derived slice through the existing `utils/secretRedaction/engine.ts` scanner before storing; if the slice contains a hit (or as official does, unconditionally), fall back to a generic description (e.g. `${sanitizedName}: (prompt-derived description withheld)` or just the agent name). Cheapest faithful port: redact-then-truncate. Test: spawn teammate w/o description with `sk-ant-…`/AWS key in first 50 chars of prompt; assert task state, progress line, and hook payload contain no secret.

### P4 — #097: MDM forceLoginOrgUUID/forceLoginMethod precedence (MED-HIGH)
Official spec string (v299 @110685262): local MDM policy / managed-settings-file `forceLoginOrgUUID` and `forceLoginMethod` (claudeai|console) apply **ahead of server-managed settings**; auth pins "taken from the highest source only"; HKCU and `--managed-settings` never take part in the merge.
OCC gap: `policySettings` merge order remote-first (`settings.ts:587-589,673,977-983`) — a server-managed payload can hide/replace the local MDM pin. Fix: reorder precedence for the auth-pin keys (`forceLoginOrgUUID`, `forceLoginMethod`, `forceLoginGatewayUrl`, `gatewayInternalNetworks`) so HKLM/plist + managed-settings.json outrank the remote source; keep remote eligible only when no local pin present. Test in `managedReadDenial285`-style suite: local file sets org UUID A, remote cache sets B → effective = A.

### P5 — #042 + #098 (+ #043): MCP reserved server names (MEDIUM)
Official: name predicate `mG(e) = e in Object.prototype && fa(e)` (@215351978) + validation message (@110526560) listing `constructor, prototype, __proto__, __defineGetter__, __defineSetter__, __lookupGetter__, __lookupSetter__`; frozen pollution set `["__proto__","constructor","prototype"]` (@218410266); `EBe` reserved-name check applied at agent-frontmatter MCP registration (@225905900) and connection/selection paths.
OCC gap: only `__proto__` refused (`services/mcp/config.ts:1727-1738`, skipReason `reserved_name`); truthy `servers[name]` reads at `config.ts:726,733,740`, `mcp.tsx:313` break for `constructor` (hits `Object.prototype.constructor`); `--channels`/`--bare` selection (`main.tsx:1978-2040`, `channelAllowlist.ts:59`) unguarded.
Implementation: extend the existing `reserved_name` guard set to `{__proto__, constructor, prototype, toString, valueOf, hasOwnProperty, isPrototypeOf, propertyIsEnumerable, __defineGetter__, __defineSetter__, __lookupGetter__, __lookupSetter__}` (or `name in Object.prototype` per official `mG`) in: config load/iteration, `servers[name]` lookups (switch to `Object.hasOwn`/Map), channel allowlist gating, and permission-rule matching for `mcp__<server>__*` in auto/bypass modes (#043 — verify `permissions.ts:276-298` string path plus any record-keyed auto-approve caches). Reuse `optionKeySafety.ts` vocabulary for consistency.

### P6 — #034: WSL2 Windows-drive sandbox binds (MEDIUM)
Official (new in v299): Windows/remote-fs detection set `Aa = drvfs 9p virtiofs cifs smb3 smbfs nfs nfs4 ntfs ntfs3 fuseblk vfat exfat msdos` + native set `hm` (@220000886, fn `Rws`/`xws`), `/proc/mounts` scan `Cf` with octal-unescape `B5e`, drive-letter/UNC/`aname=drvfs` source regexes, and fail-closed refusal `Of` ("A shell tool was granted, but … the Windows side could not be put out of the sandboxed shell's reach — the run was refused.", reasons: "the WSL mount table (/proc/mounts) cannot be read", "no Windows filesystem mou[nts]") @254393924.
OCC gap: none of this exists (0 hits drvfs//proc/mounts in src + runtime dist); bwrap invocation delegated to `@anthropic-ai/sandbox-runtime@0.0.44` which will try to create bind mount-points under `/mnt/c/...` → `bwrap: Can't mkdir`.
Implementation: in `sandbox-adapter.ts` (CLI layer, before delegating), when WSL2 detected: read `/proc/mounts`, classify Windows-side mounts per official sets/regexes; exclude Windows-drive paths from bind/deny mount-point creation and fail closed with the official refusal when a granted path's Windows-side mount can't be determined. Add unit tests with fixture mount tables (drvfs, 9p aname=drvfs, UNC source).

### P7 — #039: empty config-dir `.config.json` after sandboxed command (MEDIUM)
Official: expanded 0-byte placeholder discipline (3→9 occurrences): model-facing prompt text @107002052 ("The sandbox creates 0-byte placeholder files… A 0-byte one belongs to the sandbox: do not stage, commit, move or delete it…") and doctor-style diagnostic @228225896 detecting stale 0-byte mode-&(146)===0 mask files ("makes 'Yes, and don't ask again' fail to save, and the sandbox binds it read-only again on every start" → fix `rm <path>`).
OCC: has `wouldLoseAuthState()` write guard (`config.ts:~871-885,1301` + `tengu_config_auth_loss_prevented`) and workdir ghost-dotfile cleanup (`Shell.ts:390-392`), but config-dir `.config.json` 0-byte residue (bwrap mount-point artifact) is not covered on the READ/cleanup path.
Implementation: (a) on config load, treat a 0-byte `.config.json`/`.claude.json` as absent (fall through to legacy/defaults) instead of empty-state; (b) extend `cleanupAfterCommand` to remove 0-byte artifacts at config-dir bind points; (c) optionally port the stale-mask diagnostic into `/doctor`-style checks.

### P8 — #091: Enter answering a just-released held prompt (MEDIUM)
Official: prompt lifecycle states `ask_withdrawn` / "standing request taken back unsent" / `unreachable_unaccepted` (@112233225) — a held ask that can't be safely surfaced is withdrawn, not dropped into the keystroke stream.
OCC: `REPL.tsx` suppresses dialogs while `isPromptInputActive` (:1448, :2196) but releases after 1500ms debounce (:1067,:1455) with unsent text still present; the released dialog's Select consumes the next Enter (`CustomSelect/select.tsx:47`).
Implementation: on suppression release while input has unsent text, either keep holding until the message is sent/cleared, or mount the dialog with an ignore-first-Enter grace window (~250-500ms) and/or require re-focus confirmation; emit an `ask_withdrawn`-equivalent when the user's Enter would race a release. E2E via repl-tmux: type text, trigger permission ask, wait >1.5s, press Enter → message must send, dialog must not be answered.

### P9 — #040: /sandbox false success on unwritable project (LOW)
OCC: `updateSettingsForSource` already returns `{error}` (`settings.ts:716-719`); call sites `sandbox-adapter.ts:1396,1732` discard it and `sandbox-toggle.tsx:76-78` prints success. Fix: check the returned error; on failure print official-style "nothing changed" + reason (project folder/file not writable, EACCES/EROFS), and don't flip the displayed toggle state. Also verify `SandboxSettings.tsx` save path. Trivial, testable with chmod -w fixture.

### P10 — #011: plan-mode bypass one-time notice (LOW)
Port exact official copy under notice id `plan-mode-bypass-notice` (v299 @101543286): "Session was started with bypass permissions, so plan mode won't ask before most edits or commands. Start a new session without bypass permissions for prompts in plan mode." Show once per session when entering plan mode while `bypassPermissions` is active (OCC: `EnterPlanModeTool` + `getNextPermissionMode.ts:43-64` mode state; one-time flag like existing notice machinery, cf. `Notifications.tsx`).

### #043 note (LOW-MED, bundled with P5)
Official symptom was over-prompting (fail-safe direction) for `constructor`/`toString`-named servers' tools in auto/bypass modes. OCC's `mcp__` matching is string-based (likely mitigated), but audit any record-keyed allowlist/auto-approve caches (`permissions.ts`, bashClassifier, tool-approval stores) for `serverName`-keyed object access before closing.

## STAGED details

### S1 — #106 + #108: symlink-mediated sandbox deny bypass (HIGH; runtime-dependent)
Both fixes live in seatbelt/bwrap profile generation and glob-root resolution inside `@anthropic-ai/sandbox-runtime` (OCC pins 0.0.44, `bun.lock:17`). String forensics shows no new CLI-layer strings (`real location` 8=8, `resolves through a symlink` 4=4) → logic/runtime change. OCC's `reconcileClaudeSymlinks()` already fails closed for `.claude/*` deny entries (realpath targets pushed into deny list, `sandbox-adapter.ts:834-875`) — a partial, narrower version of 106.
Next round: diff `@anthropic-ai/sandbox-runtime` 0.0.44 → current npm release for realpath-on-deny and glob-root symlink revalidation; bump the dep (or extend the existing OCC patch file) instead of hand-porting; then e2e: denied dir replaced by symlink → read/write must stay denied; glob allow rooted at dir swapped to symlink → re-checked.

### S2 — #107: settings-check vs sandbox glob interpretation divergence (MEDIUM)
OCC structural divergence confirmed: picomatch screening (`trustedTierGrants.ts:62,154,308-333`) vs enforcement via prefix semantics/`globBase` handed to bwrap/seatbelt. Folder names containing `{}`, `()`, `\` can match differently in the two layers → a deny can screen as non-matching while the sandbox binds a broader/narrower path. Official normalization not yet isolated (the brace tokenizer @218908132 is JSON-schema output parsing, present 5=5 in both versions — not the fix).
Next round: locate official glob-translate function feeding seatbelt `(regex …)`/bwrap args in v299 (search `(subpath`/`regex` builders near `macos-sandbox-utils` equivalents), then align OCC's `resolvePathPatternForSandbox`/`expandPath` (`sandbox-adapter.ts:173,526-795`) to escape braces/parens/backslashes identically in both layers; test with literal-brace directory names.

### S3 — #109: worktree-isolation awk acceptance (MEDIUM hardening)
Official awk refusal message set unchanged v296→v299 (8=8 @109058856: system(), `| "cmd"`/`| getline`, @load/@include/@indirect, extension(), /inet[46]/) → fix is control-flow (which programs reach `inspectAwkProgram` under the `worktreeSession` flag @101881040), not new rules. OCC has the v288 rule set (`ast.ts:3741,3895-3920,4500-4537`, xargs path :4397-4423) but `worktreeGitRedirectGuard.ts` (216) has no awk coupling.
Next round: extract v299 worktree bash-guard call graph around `worktreeSession` (dd around @223639808/@223706344 export regions → locate referencing functions) and diff acceptance conditions vs OCC's; likely tightening = refuse awk entirely (or refuse unchecked-program forms) when `agentWorktree` isolation is active. Add fixtures to `bashReadCommands293`-style suite.

## N-A details

- **#078** — trigger for refetching managed settings/org policy on locally-changed stored login plan; requires Anthropic account plan lifecycle + first-party remote settings service. OCC's remote fetch is eligibility-gated (`syncCache.ts`) and OCC has no real login-plan state machine. Revisit only if OCC ever runs first-party enterprise auth.
- **#141** — OCC has no async wildcard read-rule expansion step to cancel; the 292-era port uses synchronous `refreshConfig()` re-point cadence (`sandbox-adapter.ts:1529-1541`). If S1/S2 runtime bump introduces async expansion, re-open.
- **#171** — real-time cyber-safeguards notice is server-flag driven (`tengu_jazzy_goblet` UI family). v296 carried "Apply to the Cyber Verification Program to reduce these interruptions." (@101155981); v299 removed it (0 hits). OCC never had the notice (grep 0 hits) and OCC's static `CYBER_RISK_INSTRUCTION` is byte-identical to official prompt text in both versions (@106611587) — no action.

## ALREADY-ALIGNED

- **#096** — OCC `ink/stringWidth.ts` is grapheme-aware (Intl.Segmenter + emoji-regex + east-asian-width), explicitly scores full keycaps (`digit+VS16+U+20E3`) as width 2 and handles ZWJ joins; official keycap regex `^[#*0-9]️?⃣$` exists identically in v296 and v299 (2=2) — fix was not a new width table. Residual risk only: Bun-native `Bun.stringWidth`/`Bun.wrapAnsi` delegation divergence for complex scripts (documented in-file); monitor, no port.

### Cluster E — infra / REPL / UX (66)


**Provenance note:** the originally assigned cluster-E agent hung mid-run (42+ min silent on a slow grep; recovered/stopped). This ledger was reconstructed by the lead: 11 render/REPL entries come from three completed deep-dive subagents (fragments salvaged from their transcripts); the remaining 55 were triaged by the lead via OCC surface greps + official `new_strings.txt`/`s299.txt` anchor checks (forensic discipline: binaries never executed; `sctx.pl`/`grep -cF` only). PORT entries below carry verified surface + anchor evidence; exact official dd-citations for implementation are flagged where they must be re-extracted in the implementation round.

OCC surfaces confirmed present (used below): FleetView (agents-view equivalent, `src/components/FleetView/`), `src/commands/btw/`, `/usage` (`src/commands/usage/`), `/effort` + `/fast` commands, ScheduleCronTool (`src/tools/ScheduleCronTool/`), safe-mode (`isSafeMode`), bare mode, PushNotificationTool, ultracode (`context.ts`/`query.ts`), `--debug`/`--debug-file`, stream-json input (`cli/print.ts`), MCP client + `headersHelper` + OAuth, `mcp add/list/get` handlers, worktree support, SkillTool + skill/command loaders, FileRead/FileWrite encoding paths, `inlineShellRm.ts` + `dangerousRmAutoDeny.ts`, promptShellExecution, background sessions/subagents + SendMessage.

## Summary table

| # | short | disposition | evidence |
|---|---|---|---|
| 001 | `CLAUDE_CODE_DISABLE_FILE_MENTIONS`: @-mentions pass paths, not contents | **PORT** | env var NEW in 299 (0→7 hits); official gate: `Ydn()||a.CLAUDE_CODE_DISABLE_FILE_MENTIONS ? TGr(e,n) : RGr(e,be,…)` (paths-only vs content fetch, sctx-extracted). OCC @-mention surface: `useTypeahead.tsx`, `AttachmentMessage.tsx`, `fileSuggestions.ts`; 0 OCC hits for the env var |
| 002 | idle compaction: 200K+ idle ~54 min → compact before 1 h cache expiry | **STAGED** | OCC: 0 hits `idleCompaction`/idle-compaction. Official strings dormant in s296 (3–5 hits) + new-299 messages (2–4) → feature enablement. Real feature: idle timer + token threshold + compaction trigger + settings; needs full timer-constant forensics; bundle with 003 |
| 003 | `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` + `"idleCompaction": false` | **STAGED** | same feature as 002; knobs ride that port |
| 009 | `/effort` `/fast` in agent view; bare `/model`/`/effort`/`/fast` opens picker | **STAGED** | OCC FleetView exists (`FleetViewScreen.tsx` peek/attach) but grep shows NO slash-command input handling (`/effort|/fast|/model` = 0 hits in FleetView/*) — needs FleetView command-input support first (UI work, not CLI-local) |
| 010 | "safe mode" line in agents-view peek panel | **PORT** (adaptation) | OCC: `isSafeMode` + FleetView `SessionPreview.tsx` exist; add safe-mode row to peek panel (small; verify session metadata carries safe-mode flag) |
| 017 | `/usage` warnings: max effort, workflows, always-on context, large tool results | **PORT** | NEW-299 catalog strings extracted: `always_on_context:{headline:"…% of your usage went to always-on context over 40k tokens", body:"CLAUDE.md files, MCP tools, skills and memory…"}`, `large_tool_results:"…over 10k tokens"`, ultracode/workflows items ("always-on context" 0→3). OCC `/usage` exists (`src/commands/usage/usage.tsx`), no warnings section (grep `headline|warnings` = 0) |
| 019 | gateway model behind custom base URL: "Prompt is too long · automatic compaction failed" near 200K | **STAGED** | both-version strings (2/2) → logic delta in model-context-limit resolution for gateway-specific model names; OCC has custom base URL + compaction; needs model-limit forensics before porting |
| 028 | debug logging memory growth; hang on exit when debug log mount stops accepting writes | **PORT** | OCC `--debug`/`--debug-file` (`main.tsx`, `bridge/sessionRunner.ts`); official delta = bounded buffering + non-blocking flush on exit; implementation-round dd forensics for exact buffer strategy |
| 029 | debug→stderr memory unbounded when parent stops reading | **PORT** | same surface as 028; fix = cap/drop when stderr write backpressures |
| 030 | rm prompts on `sh -c` scripts that don't run rm; runtime-built rm in unreadable script prompts only with `CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT=1` | **PORT** | env var NEW in 299 (0→4, in env registry extract). OCC surface exact: `src/tools/BashTool/inlineShellRm.ts`, `dangerousRmAutoDeny.ts`, `bashSecurity.ts`; 0 OCC hits for the env var → relax default + add strict opt-in |
| 032 | empty `.mcp.json` reported invalid by `mcp list`/`doctor`/`/status` | **PORT** | OCC surfaces all exist (`cli/handlers/mcp.tsx`, doctor, status commands); fix = treat `{}`/empty object as valid; small parse/validation delta |
| 047 | document blocks dropped from own message sent while Claude working | **PORT** | OCC queued-message merge path exists (stream-json/queue); fix = preserve `document` blocks through the queue-merge; verify OCC merge drops non-text blocks |
| 053 | custom-base-URL streams aborted at 180 s → 300 s regardless of flag load | **ALREADY-ALIGNED** | OCC `services/api/claude.ts:2868`: `STREAM_IDLE_TIMEOUT_MS = parseEnvInt(CLAUDE_STREAM_IDLE_TIMEOUT_MS) ?? 300_000` (5 min default since 2.1.196 port, watchdog default-on) — no 180 s path, no flag gating |
| 055 | settings file ignored when `enabledMcpjsonServers`/`disabled…` is a single plain string | **PORT** | OCC has the keys (`migrations/migrateEnableAllProjectMcpServersToSettings.ts`, `cli/handlers/mcp.tsx`); fix = schema accepts string (letters/digits/-/_) as one-element list instead of invalidating the whole file |
| 065 | deny/ask rules for `mcp__<server>` not applying when normalized name contains `__` | **PORT** (family w/ 158, 159) | OCC `mcp__` prefix matching in `src/tools.ts`/permissions; family fix = whole-normalized-name matching |
| 066 | after one oversized image refused, newly attached images lost every turn | **STAGED** | history-repair logic on API refusal; deep diff needed (no distinctive new string anchor found); OCC image pipeline exists (`oversiz` hits in Tool.ts/query.ts) |
| 073 | 2.1.296 regression: approved tool call run twice when new message arrives on resume after restart (cloud+headless) | **STAGED — verify OCC didn't inherit** | regression was INTRODUCED in 2.1.296, the version OCC is aligned to → OCC may carry it. Priority check next round: OCC resume-after-restart + queued message path (headless half); cloud half N-A |
| 074 | scheduled tasks announced for wrong minute; tools report actual next run time | **PORT** | OCC ScheduleCronTool (`CronListTool.ts`, `CronDeleteTool.ts`, prompt.ts); OCC has NO nextRun/next-run-time reporting (grep 0) — add computed next-run to tool output/announcement |
| 076 | `claude -p` silent when settings file fails validation → list file + invalid entry on stderr | **PORT** | OCC `-p` path (`cli/print.ts`) + settings validation exists; anchor "fails validation"/"invalid entry" in both versions → delta = stderr reporting in text-output runs |
| 079 | MCP HTTP: 30 s hang when server never ends notification-reply body (#99014) | **PORT** | OCC MCP HTTP transport (`services/mcp/client.ts`); fix = don't await body completion for notification responses (or bound it); small transport delta |
| 081 | `mcp list`/`get`/subagent servers START a policy-blocked server; now report blocked without starting | **PORT** | OCC `cli/handlers/mcp.tsx` + policy/approval checks exist; fix = check policy before connect in list/get/subagent paths |
| 085 | bare-mode notices in background sessions say restart without `--bare`; now name `/stop` and `claude --resume` | **PORT** | OCC has bare mode + background sessions; message-level fix ("bare mode" strings: 7 new/15 in 296 → wording delta; extract exact strings in impl round) |
| 088 | `/config` push-notification toggles send previous setting | **N-A** | OCC has PushNotificationTool but NO account push toggles in config UI (grep push in Config components = 0; no ConfigDialog surface) — account-level toggle surface absent |
| 090 | Read PDF page ranges failing in remote sessions on unprivileged Linux | **N-A** | remote (cloud) sessions absent in OCC |
| 092 | remote-session attachment left out when download stalls; now retried | **N-A** | remote sessions absent in OCC |
| 093 | queued prompts over `--input-format stream-json` run together without line break when merged | **PORT** | OCC stream-json input exists (`cli/print.ts`, `main.tsx`); fix = newline join when merging queued content blocks into one turn |
| 101 | `--safe-mode` background sessions silently leave safe mode on wake/restart | **PORT** | OCC `isSafeMode` + background session persistence exist; fix = persist safe-mode flag through wake/restart |
| 102 | scheduled tasks/loops fire again or early during DST repeated hour | **PORT** | OCC ScheduleCronTool + loop scheduling; fix = repeated-hour dedup/skip logic; no distinctive new string ("repeated hour" 0/0) → impl-round diff of scheduler time math |
| 104 | headless/SDK MCP tool calls fail or run twice when background reconnect closes their connection | **STAGED** | reconnect lifecycle surgery; OCC MCP client has reconnect; needs careful conn-generation guard design + forensics |
| 105 | `/btw` non-interactive: not cancelled at session end; runs twice on repeated request | **PORT** (family w/ 166) | OCC `src/commands/btw/`; fix = cancel-on-end + in-flight dedup |
| 110 | `claude mcp add <name> -- <command> --background` started as background session | **PORT** | OCC `mcp add` (`cli/handlers/mcp.tsx`) + `--background` session flag both exist; fix = everything after `--` belongs to the server command, not session flags |
| 111 | prompt/reply of `--bg`/`--background` to a background session taken as the flag → session restart loop | **PORT** | OCC background-session message delivery; fix = only parse flags in command position, never as message content |
| 112 | custom slash command's embedded shell line runs twice when a newer message interrupts during prompt check | **PORT** | OCC `promptShellExecution.ts` (`executeShellCommandsInPrompt`) — same surface as cluster-A 167/168; fix = don't re-execute expansion/shell when re-checking an interrupted command (guard/memoize per command invocation) |
| 113 | `--worktree` sessions leave folder in `.git/worktrees` under reftable ref storage | **PORT** | OCC worktree support exists; OCC has ZERO reftable handling (grep 0; official reftable strings 8 new/13 in 296); fix = reftable-aware worktree cleanup path |
| 115 | Ultracode not announced to scheduled tasks / delivered headless turns when on in settings | **PORT** | OCC ultracode exists (`context.ts`, `query.ts`, `main.tsx`) + ScheduleCronTool; fix = inject ultracode announcement into delivered headless turns |
| 116 | MCP OAuth sign-in/refresh/sign-out not sending configured `headers`/`headersHelper` | **PORT** | OCC has `headersHelper.ts` + MCP OAuth (`commands/oauth-refresh`, `services/mcp/client.ts`); fix = thread configured headers through the OAuth fetch calls |
| 123 | background subagents in auto mode send final report twice (result + message) | **PORT** | OCC background subagents (LocalAgentTask) + auto mode exist; fix = dedup final-report delivery path |
| 124 | `SendMessage` can't find subagent by name after CLI restart + resume | **PORT** | OCC SendMessage (`tools.ts`, ListPeersTool) + resume; fix = persist/restore name registry across restart (names given before last compaction still need agent ID — keep that limit) |
| 125 | reply cut at output token limit ends turn silently after non-streaming fallback | **PORT** | OCC non-streaming fallback exists (`services/api/withRetry.ts`, `query/config.ts`); fix = surface retry/error instead of silent end when stop_reason=max_tokens on fallback path |
| 126 | Read garbles UTF-16LE+BOM; Write drops BOMs / silently converts Windows-1252, Shift-JIS, GBK, UTF-16BE → now refused | **PORT** | OCC FileRead/FileWrite/FileEdit have BOM/encoding handling (grep hits); encoding names in both versions (Windows-1252 4 new/5) → logic delta: detect + refuse conversion with message; impl-round extraction of exact refusal strings |
| 140 | PDF @-mention bytes no longer kept in session transcript | **STAGED** | transcript-storage format change (bytes → reference); OCC FileReadTool document blocks + transcript writer exist; medium-large, touches saved-transcript compatibility |
| 144 | Skill tool "Unknown skill" suggests listed name when `anthropic-skills:` prefix wrongly added | **PORT** | OCC SkillTool has "Unknown skill" error (`SkillTool.ts`); anchor "anthropic-skills:" 3 new/5 → suggestion delta; small |
| 145 | `/reload-skills` says it re-sends full skill list (recover skills after compaction) | **PORT** | OCC `src/commands/reload-skills/`; message-level change; extract exact official wording in impl round |
| 146 | worktree creation error when base commit doesn't resolve: says how lookup ended + likely reasons | **PORT** | OCC worktree creation exists; message-level improvement |
| 147 | worktree at bare-repo root: error explains the layout | **PORT** | same family as 146; OCC has bare-repo awareness (`computeBareGitRepoDenyPaths` in sandbox-adapter) — message-level |
| 149 | background agent notifications: waiting on own background work / message too late for result / stopped by usage limit | **PORT** | OCC background-agent notifications exist; anchor "waiting on its own background work" in both (5 new/4) → reason-set delta; add the three official reason cases |
| 154 | skill/command names with hidden, direction-changing, blank-like chars, `<`/`>` no longer offered; such `name:` ignored | **PORT** | exact official constants extracted: `LJr="a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters"`, blank-like regex `Kao=/[^\P{Z} ]/gu`, warn-dedup cap `hir=100`, "No more are told" suffix; 0 OCC hits ("direction-changing" 0→2 new). Target: OCC skill + command loaders (`loadSkillsDir.ts`, commands registry) |
| 156 | WebFetch page reads pick effort like web searches (caller level on caller model, else small-model setting) | **PORT** | OCC WebFetchTool exists; small effort-selection delta mirroring WebSearch logic OCC already has |
| 158 | MCP allow rules reach only the named server: `mcp__a` no longer allows `a__b`/`a_`; require `mcp__<whole>__*` | **PORT** (family w/ 065, 159) | OCC permission-rule `mcp__` prefix matching (`src/tools.ts`, permissions); one normalization/matching change covers the family |
| 159 | agent `tools:` lists take only the named MCP server's tools; `__`-containing names as `mcp__<whole>__*` | **PORT** (family w/ 065, 158) | OCC AgentTool tools-list resolution exists; same family change |
| 162 | first-party MCP servers at api.anthropic.com: tool descriptions/instructions no longer cut at 4,096 chars | **N-A** | Anthropic-first-party-hosted MCP surface; OCC has no api.anthropic.com first-party server integration (backend-dependent) |
| 164 | resume command printed at exit names session by ID, not name (paste safety) | **N-A** | OCC prints no resume command at exit (grep `claude --resume` in exit/REPL paths = 0; only resumeFailureGate/RemoteAgentTask contexts) — surface absent |
| 165 | worktree-session exit resume line uses `-w`/`-r` when long flags don't fit | **N-A** | same absent surface as 164 |
| 166 | `/btw` non-interactive returns timeout error after 11 min unanswered | **PORT** (family w/ 105) | OCC btw exists; add 11-min timeout error (exact official message not string-visible — impl-round dd forensics around btw non-interactive path) |
| 170 | `/ultrareview` upload errors stop suggesting `git add .` | **N-A** | OCC `remoteReviewFailure.ts` contains neither "git add" nor "upload" strings (grep 0) — the offending suggestion doesn't exist in OCC; repo-upload is cloud-side |

### Deep-dive entries (11, from completed subagent forensics — full detail in their fragments below)

| # | short | disposition | evidence |
|---|---|---|---|
| 031 | dblclick in expanded fullscreen row collapses instead of selecting word | **PORT** | OCC `App.tsx:672-676` dispatches DOM onClick on first release, no deferral; official 299 adds deferred-collapse Map + 250 ms timer (`Jb=250` @s299 12061914) + selection-change cancel; absent in 296 (@40016170) — full recovered code in fragment |
| 033 | `/btw` jumps transcript to bottom while scrolled up (fullscreen) | **PORT** | OCC `commands/btw/index.ts` lacks `keepsScrollPosition`; `REPL.tsx:3392` repins unconditionally; official adds `keepsScrollPosition:!0` (@43745961) + `if(!Qo)Mt.repin(!1,"onSubmit")` guard (@35967253), both new in 299 |
| 049 | fullscreen "Update installed" notice hidden behind idle `/clear` hint | **PORT** (adaptation) | OCC fullscreen clips Notifications column to height=1 (`PromptInput.tsx:2601-2620`); official threads `withSeparator` (@6734392) + appended `flexShrink:0,maxWidth:60%` row (@6735391) — OCC chrome differs, adapt with recovered constants |
| 061 | CJK/emoji+Latin wrap loses last line / blank row | **STAGED** | v299 adds `Dg()` re-wrap reconciliation + NEW yoga `getOfferedWidth` (0 hits v296, 3 in v299 @229813921); OCC wraps once (`render-node-to-output.ts:687/707`), no measure cache in `native-ts/yoga-layout` — full port plan in fragment |
| 063 | nested styles over table borders / lost on wrapped rows | **STAGED** | styled-builder byte-identical 296↔299; "lost on wrapped rows" = same `Dg` gap as 061; border half is MarkdownTable-specific, no portable v299 delta |
| 069 | image coordinate hint off for large near-square images | **PORT** | 299 adds token-aware display dims: catalog `image_limits:{maxWidth:2576,maxHeight:2576,maxImageTokens:4784}` (older `1568/1568/1568`), scaler `q()` binary search + `fgt(w,h)=Math.ceil(w/28)*Math.ceil(h/28)` (`St=28`), wrapper `Y()` (@222905316), telemetry `resized_for_tokens` (@109134784 etc.); `maxImageTokens`/`resized_for_tokens` = 0 occurrences in entire 296 binary; OCC `imageResizer.ts` is the 296 shape (2000×2000 clamp only, display=original) — detail in fragment R3 |
| 077 | long pastes without bracketed paste lose text after invisible control char | **N-A** | only 296→299 delta = long-key fallback wraps raw key in paste-event constructor (`new Kae(E.key)` runs C1 strip `/[-]/`); OCC has no DOM paste-event layer (`src/ink/events/paste-event.ts` = stub `type PasteEvent = any`; `rawEmpty`/`rawEndedWithFocusTail` 0 hits) — OCC's termio→`onTextPaste` path passes C1 chars through as literal text, never truncating |
| 083 | blank rows under CJK/emoji squeezed into 1-cell column | **STAGED** | same `Dg`/`getOfferedWidth` root cause at width 1; OCC measure (`dom.ts:417`) vs paint (`getMaxWidth` clamp) diverge exactly as official reconciles |
| 084 | wide-char cut twice / cell unused; emoji vanishes at color change | **STAGED** | truncate `DC≡_C` and wrap `_g≡wv` byte-identical 296↔299; fix is native `Bun.ant.CellSegmenter` cell-slicing with no OCC JS counterpart; OCC `sliceFit` already mitigates cut-twice |
| 103 | diff view lists new file whose name begins/ends with space under wrong name | **PORT** | official swaps whole-stdout `i.trim().split("\n").filter(Boolean)` → per-line `i.split("\n").filter(bxo)`, `bxo(rr){return rr.trim()!==""}` (296 `Zt` @bin 213661053 vs 299 `hn` @bin 221653674); OCC `fetchUntrackedFiles` (`src/utils/gitDiff.ts` ~:334-363) carries the exact 296-era whole-stdout `.trim()` bug; sibling `src/utils/git.ts:668 captureUntrackedFiles` same pattern — detail in fragment R3 |
| 142 | startup warning for unrecognized model ID → one short line + docs link | **N-A** | 299 restructures into banner `{id:"model-unrecognized",tier:"warning"}` + `unknownModelWindowWarning` store slice + docs link `…model-config#correct-the-window-for-a-gateway-or-custom-model-id`; OCC = 0 hits for all three; underlying unknown-model window source explicitly STAGED/backend-bound per `src/utils/autoCompactWindow.ts:38,235` — the restyled notice surface doesn't exist in OCC |

## Cluster E tally (FINAL, all 66 rows closed)

**PORT = 44** — lead 55-set: 001, 010, 017, 028, 029, 030, 032, 047, 055, 065, 074, 076, 079, 081, 085, 093, 101, 102, 105, 110, 111, 112, 113, 115, 116, 123, 124, 125, 126, 144, 145, 146, 147, 149, 154, 156, 158, 159, 166 (39); deep-dive set: 031, 033, 049, 069, 103 (5). Family groupings for implementation: {065,158,159} MCP-name normalization = 1 change; {105,166} btw non-interactive = 1 change; {146,147} worktree error messages = 1 change; {028,029} debug-log memory = 1 change; {112} rides cluster-A 167/168 promptShellExecution work.
**STAGED = 12** — 002+003 (idle-compaction feature, bundle as 1), 009 (FleetView slash-command input), 019 (gateway-model compaction limit), 066 (oversized-image reattach loop), 073 (296-introduced resume double-run regression — **verify OCC didn't inherit; do first**), 104 (MCP reconnect lifecycle), 140 (PDF bytes out of transcript), + render family 061/063/083/084 (yoga `getOfferedWidth` + `Dg` reconciliation — 1 staged port).
**ALREADY-ALIGNED = 1** — 053 (OCC stream idle timeout already defaults 300 s, `claude.ts:2868`).
**N-A = 9** — 088, 090, 092, 162, 164, 165, 170 (lead set: cloud/remote/absent surfaces); 077, 142 (deep-dive: paste-event layer / banner-notice surface absent).

## Key PORT implementation notes (highest value first)

1. **154 bidi/hidden-char name refusal** — exact official constants recovered: message `LJr`, blank-like regex `/[^\P{Z} ]/gu`, `<`/`>` ban, 256-char cap, 100-warning dedup cap (`namesNotShown` Set, "No more are told" suffix), `\u{XXXX}` escaping in warnings. Apply to skill dirs (`loadSkillsDir.ts`) + command/skill frontmatter `name:` (ignore invalid `name:`, fall back to file name only when clean).
2. **030 inline-shell rm** — flip OCC default: runtime-built rm in unreadable `-c` script → NO prompt; add `CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT=1` opt-in restoring strict prompts. Target `src/tools/BashTool/inlineShellRm.ts`.
3. **001 file mentions** — env-gated paths-only mode in the @-mention resolver (official ternary recovered); paths handed to Claude as text, no content read.
4. **017 /usage warnings** — new-in-299 warning catalog (4+ items with exact headline/body templates recovered for always_on_context 40k and large_tool_results 10k; extract max_effort/workflows items in impl round).
5. **065/158/159 MCP name family** — single normalization fix: allow/deny rules and agent `tools:` entries match the WHOLE normalized server name; `mcp__a` must not match server `a__b`; document `mcp__<whole>__*` form.
6. **073 regression check (do first among STAGED)** — official fixed in 299 a regression INTRODUCED in 2.1.296 (OCC's aligned version): verify OCC headless resume-after-restart doesn't double-run approved tool calls when a message arrives during resume.
7. **112 embedded-shell double-run** — coordinate with cluster-A 167/168 (same `promptShellExecution` surface): the 167 reorder (hooks before expansion) plus an invocation guard prevents the interrupted-command re-execution.
8. **031/033/049 fullscreen trio** — full recovered official code in the deep-dive fragment below (deferred-collapse Map + `Jb=250`; `keepsScrollPosition:!0` + guarded repin; `withSeparator` notice row).

## Deep-dive fragments (salvaged from completed subagents)

### Fragment R1 — render/wrap entries 061/063/083/084 (agent ab61438, completed)

All four trace to ONE v299 change: reconciliation wrapper `Dg` + new yoga `getOfferedWidth`. Inner wrap (`_g`≡`wv`), truncate (`DC`≡`_C`), styled-builder (`af`≡`cf`) byte-identical 296↔299. `getOfferedWidth`: v299 binary count 3, v296 count 0.

New yoga method (v299 @229813921):
```
getOfferedWidth(n,u){let f=this._mfC,m=n;for(let y=this._mfN*6-6;y>=0;y-=6){if(!Gc(1,n,f[y+1],f[y],f[y+4]))continue;if(f[y+5]!==u)return n;m=f[y+1]===2?f[y]:n}return m}
```
New wrapper `Dg` (v299 @229944979; v296 goes `wv`→`gC` directly):
```
function Dg(n,u,f,m){let y=_g(n,u,f);if(y.softWrap===void 0||y.softWrap.length===m.getComputedHeight())return y;let v=m.getOfferedWidth(u,m.getComputedHeight());return v===u?y:_g(n,v,f)}
```
Paint dispatch (v299 strings @10909762 vs v296 @10533648): `let Ee=Dg(ne,ae,te,H);ve=Ee.softWrap;…ue=af(Ee.wrapped,Q,fe,ne,te==="wrap-trim",Ee.softWrap)`.

Semantics: wrap once; if soft-wrap row count ≠ yoga computed height (CJK/emoji width disagreement between measure and paint passes), ask yoga for the width actually offered at that height and re-wrap at it.

STAGED port plan: (1) `native-ts/yoga-layout/index.ts`: add measure-func cache `_mfC` (stride-6: offeredWidth, widthMode, …, computedHeight) populated at the `measureFunc(innerW,wMode,innerH,hMode)` call site (index.ts:1249) + `getOfferedWidth(width,height)` per bytes above (return cached offered width when widthMode===AtMost(2) and cached height matches). (2) `render-node-to-output.ts` (~683-712): wrap `wrapWithSoftWrap(plainText, maxWidth, textWrap)` in a `Dg`-equivalent — if `softWrap.length !== Math.round(yogaNode.getComputedHeight())`, recompute `offered = yogaNode.getOfferedWidth(maxWidth, computedHeight)` and re-wrap when `offered !== maxWidth`. (3) tmux e2e: CJK+Latin / emoji+Latin at box-boundary widths and 1-cell columns. 084/063 remainders: no JS delta to port (native `Bun.ant.CellSegmenter` + MarkdownTable border padding); need independent OCC repro against `sliceAnsi.ts` and `MarkdownTable.tsx`; OCC `wrap-text.ts:sliceFit` already covers wide-char cut-twice.

### Fragment R2 — fullscreen/transcript entries 031/033/049 (agent a059038, completed)

**031 PORT** — OCC targets: `VirtualMessageList.tsx` (`VirtualItem` :197-288, onClick closure :225; list-level `onClickK` :847-850, `handlersRef` :839-846), `Messages.tsx` :572-603 (pass `isItemExpanded`, prop already exists :83/:864 backed by `expandedKeys`). Ink layer ready: `src/ink/ink.tsx` `selection` (:180), `hasTextSelection()` (:1661), `subscribeToSelectionChange()` (:1669); `instances.get(process.stdout)`.
Official delta (dd-verified): onClick 2-arg→4-arg adds `itemKey` + `wasExpanded` (s296 @40008183 vs s299 @12062962 `C(l,u,A.cellIsBlank,f===!0)`); constants s299 @12061914 `var nl=3,Jb=250,cE=2000,uE=3000` (250 ms defer); handler rewritten (s296 @40016170 immediate toggle → s299 @12071076 deferred):
```js
let[$t]=y(()=>new Map);                       // pending-toggle Map by itemKey
P(()=>()=>{for(let Y of Array.from($t.values()))Y(!1)},[$t]); // unmount cancel-all
let bo=ae((Y,q,se,we)=>{                       // (itemKey,msg,cellIsBlank,wasExpanded)
  let We=Tt.current;
  if(se||!We.onItemClick)return;               // blank cell → ignore
  let je=$t.get(Y); if(je){je(!0);return}      // same row pending → commit now
  if(!we){We.onItemClick(q);return}            // collapsed → expand immediately
  let He=oi().get(process.stdout),
    Fe=He?.subscribeToSelectionChange(()=>{if(He.hasTextSelection())$t.get(Y)?.(!1)}), // selection → CANCEL collapse
    qe=()=>{if(He?.selection.isDragging){St=tt.setTimeout(qe,Jb);return} $t.get(Y)?.(!0)}, // drag extends defer
    St=tt.setTimeout(qe,Jb);
  $t.set(Y,(pt)=>{$t.delete(Y),Fe?.(),St();
    let bt=Tt.current;
    if(pt&&bt.isItemExpanded?.(q))bt.onItemClick?.(q)})  // commit only if still expanded
},[tt,$t])
```
**033 PORT** — add `keepsScrollPosition:true` to OCC btw command def (+ optional field on local-jsx Command type); `REPL.tsx` onSubmit (:3383+, `repinScroll()` :3392): resolve slash command, skip repin when `cmd?.type==='local-jsx' && cmd.keepsScrollPosition===true`. Official: `keepsScrollPosition:!0` on btw (@43745961), guard `if(!Qo)Mt.repin(!1,"onSubmit")` (@35967253), both absent from s296. Incidental: official btw `argumentHint:"[question]"` vs OCC `'<question>'`.
**049 PORT(adaptation)** — OCC fullscreen clips Notifications column to height=1 (`PromptInput.tsx:2601-2620`) → hint and updater mutually exclusive; official threads `withSeparator` (@6734392) and moves updater into appended `flexShrink:0,maxWidth:Xo?"60%"` row box (@6735391). OCC chrome is a clipped column, not the official bottom row → adapt layout with recovered constants.

### Fragment R3 — paste/diff/model/image entries 069/077/103/142 (agent a039d8b, forensically closed)

**103 PORT — `src/utils/gitDiff.ts` → `fetchUntrackedFiles` (~:334-363).** Current OCC (296-era bug): `if (code !== 0 || !stdout.trim()) return null` then `stdout.trim().split('\n').filter(Boolean)` — the whole-stdout `.trim()` strips the leading space of the first filename and trailing space of the last, so a file whose name begins/ends with whitespace is listed under the wrong name. Official 299 fix (anchor `ls-files","--others","--exclude-standard","--full-name` → 299 binary @**221653674**): `async function hn(e,n,r,o=!1,s){…if(u!==0)return null;let p=i.split("\n").filter((T)=>T!==""&&(s===void 0||umr(T)))` — no whole-output trim, per-line emptiness check; 296 counterpart @**213661053**: `…if(u!==0||!i.trim())return null;let p=i.trim().split("\n")…`. Helper (s299 @17042895): `function bxo(rr){return rr.trim()!==""}`. Port: drop the `!stdout.trim()` guard and the `.trim()` before `.split('\n')`; filter per-line with the trim-based predicate. Sibling hardening: `src/utils/git.ts:668 captureUntrackedFiles` has the same pattern. Pre-existing side-gap: OCC omits `--full-name` on this call (official has it in both versions). Header/hunk/numstat parsers normalized-identical 296↔299 — no other edits needed.

**069 PORT — `src/utils/imageResizer.ts` (+ `src/constants/apiLimits.ts`, `src/utils/model/configs.ts`).** OCC today mirrors 296 behavior: clamp only to `IMAGE_MAX_WIDTH/HEIGHT = 2000` (`apiLimits.ts:42-43`); large near-square images under 2000 px but over the model's image-token budget get downscaled further by the API than the coordinate hint claims; metadata-less fallback returns no `dimensions`. `maxImageTokens`/`image_limits`/`fgt`/28-patch math/`resized_for_tokens`: 0 hits in OCC. Official 299 pieces (binary-cited):
- Catalog capability (299 @**215970820**): `image_limits:{maxWidth:2576,maxHeight:2576,maxImageTokens:4784},advisor_rank:4` for newer models; older `{1568,1568,1568}`. 296 had snake_case data (`max_image_tokens:4784` @25051851) but zod parsed only `max_width/max_height` (s296 @12685465) and had NO resize consumer — `maxImageTokens` has **zero occurrences in the 296 binary**.
- Scaler + estimator (s299 @23709055 / @7008763): `function q(e,n,r=Ae,o=ze){…while(a+1<s){let m=a+s>>1,h=Math.max(Math.round(m/u),1);if(m<=r&&fgt(m,h)<=o)a=m;else s=m}return[a,Math.max(Math.round(a/u),1)]}`; `var St=28;function fgt(e,n){if(e<=0||n<=0)return 0;return Math.ceil(e/St)*Math.ceil(n/St)}`.
- Wrapper `Y` (299 @**222905316**): `…return r.maxImageTokens===void 0?[e,n]:q(e,n,1/0,r.maxImageTokens)}` — dimension clamp first, token-budget scale only when the model declares `maxImageTokens`.
- Resizer/telemetry (`resized_for_tokens` @**109134784**, **222908065**, **222908520**; s299 @23711802): `let[y,P]=Y(_,S,o),A=y!==_||P!==S;` → returns `dimensions:{originalWidth:_,originalHeight:S,displayWidth:y,displayHeight:P}` + `tengu_image_resize{…,resized_for_tokens:A&&y<o.maxWidth&&P<o.maxHeight,target_width:y,target_height:P,max_image_tokens:o.maxImageTokens}`.
- Pipeline fallback (s299 @4355728 `jro`): when `dimensions` is absent, probe buffer metadata (`Rz(w)`) else assume `fgt(maxWidth,maxHeight)` — the "missing hint" half of the fix.
- Port shape: add `image_limits` to the model catalog (`configs.ts`); per-model resize options (official `td()` pattern; defaults stay 2000×2000 without override); add `fgt`/`q`/`Y` to `imageResizer.ts`, compute display dims through `Y` on every return path; extend telemetry fields. Self-contained (~150 lines); budgets are static catalog constants, no backend dependency.

**077 N-A.** Only 296→299 delta: the long-key fallback now wraps the raw key in the paste-event constructor (`new Kae(E.key)`) which runs the C1 control-char strip (regex class U+0080–U+009F); threshold constant identical (800); constructor normalized-identical. OCC has no DOM paste-event layer (`src/ink/events/paste-event.ts` = stub `type PasteEvent = any`; `rawEmpty`/`rawEndedWithFocusTail` 0 hits in src) — OCC's path (termio tokenizer → `wrappedOnInput` chunks → `onTextPaste`) passes such chars through as literal text and never truncates, so the official bug cannot occur.

**142 N-A.** 299 restructures the unknown-model notice into banner `{id:"model-unrecognized",tier:"warning"}` + `unknownModelWindowWarning` store slice + docs link `…model-config#correct-the-window-for-a-gateway-or-custom-model-id`; OCC greps 0 for all three (`setupIssues`/`unknownModelWindowWarning`/`model-unrecognized`). The underlying unknown-model auto-compact window source is explicitly STAGED/backend-bound in OCC (`src/utils/autoCompactWindow.ts:38,235`) — the restyled warning surface does not exist to improve. (Distinct from OCC's already-ported `validateModel281` startup probe, which this entry does not touch.)

### Cluster F + D — cloud / ecosystem / Windows (66)


OCC surfaces verified against source, not assumptions. Key findings: OCC **has** headless/SDK control protocol (set_model, set_permission_mode 'auto', mcp_set_servers), CLAUDE_CODE_RESUME_INTERRUPTED_TURN resume detector, cron scheduler, claudeai-proxy MCP connectors, attribution header, PowerShellTool, Git-Bash hook execution — but self-hosted-runner is a 3-line stub (`src/self-hosted-runner/main.ts`), no ScheduleWakeup tool, no verbatimPrompts, no mods/$.ui, no Cowork/cloud-session worker, no VSCode extension, no Slack/Code-Review app.

| # | short | disposition | evidence |
|---|-------|-------------|----------|
| 007 | runner --shutdown-drain-sec | N-A | `src/self-hosted-runner/main.ts` = 3-line stub, feature-gated |
| 013 | Desktop Code tab attribution off | N-A | no Claude Desktop/apps-gateway surface in OCC |
| 014 | attribution field behind apps gateway | N-A | OCC has attribution header (`src/constants/system.ts:83`) but no apps-gateway sessions; field is gateway-scoped |
| 018 | denied cloud session org w/ apiKeyHelper | N-A | no cloud sessions; apiKeyHelper exists but entry is cloud-denial-error scoped |
| 021 | cloud follow-up text after tool label | N-A | cloud-session rendering only |
| 024 | Cowork/claude.ai Edit+Retry vs hooks | N-A | no Cowork/Edit-Retry surface |
| 026 | claude.ai RC view freeze on upload | N-A | claude.ai web view; OCC RC is local unix-socket bridge (`src/daemon/remoteControlServer.ts` header) |
| 035 | ScheduleWakeup vs background task | N-A | no ScheduleWakeup tool (grep: only prompt-text mentions); OCC cronScheduler defers while loading, never drops (`src/utils/cronScheduler.ts:232`) |
| 037 | RC prompt lost in failed batch | N-A | official RC relay batching; OCC RC = simple POST /prompt queue + drain |
| 038 | RC prompt dropped from history | N-A | same — official RC relay internals |
| 041 | SDK/headless stay in auto mode after set_model | **PORT** | see notes |
| 044 | "synced[0] commands path not found" | N-A | no claude.ai-synced plugins; OCC plugin sync = marketplace version sync (`initializeVersionedPlugins`); error string absent from src |
| 045 | Artifact publish 403 retry advice | N-A | ReviewArtifactTool has no publish path (grep publish\|watch = 0) |
| 046 | Cowork old account plugin | N-A | no Cowork account-plugin surface |
| 048 | Claude in Chrome permission w/o browser | N-A | OCC WebBrowser = local puppeteer-core headless Chrome, no extension-pairing transport (`src/tools/WebBrowserTool/prompt.ts:5`) |
| 051 | apps gateway availableModelsMatch | N-A | no Claude apps gateway |
| 057 | memory after resume w/ many subagents (cloud/RC) | N-A | cloud/RC-session scoped |
| 060 | /usage + warning + statusline >100% | **PORT** | see notes |
| 062 | cloud permission answer vs worker replace | N-A | no cloud worker replacement |
| 064 | Cowork account plugin cross-device | N-A | no Cowork |
| 068 | images attached while working sent full size | **PORT** | see notes |
| 080 | MCP added to running headless session: policy before connect | **ALREADY-ALIGNED** | see notes |
| 086 | `←` hint over queued msg w/ RC on | N-A | official RC-mode REPL hint; OCC RC bridge has no such surface |
| 089 | cloud reply unfinished at token limit | N-A | cloud worker scoped |
| 094 | runner --exec-path wrapper MCP shutdown | N-A | runner stub |
| 099 | resume pre-/clear reattaches wrong RC session | N-A | official RC session attachment |
| 100 | verbatimPrompts / re-run as slash cmd | N-A | no verbatimPrompts (grep=0); print.ts re-enqueues raw content (`src/cli/print.ts:1345`) and has zero slash-command detection on input (grep startsWith('/')=0) |
| 114 | runner managed-git staged deletions | N-A | runner stub |
| 117 | Artifact spurious diff on republish | N-A | no artifact publish |
| 118 | $.ui.open pane in -p/VSCode | N-A | no mods/$.ui in OCC (grep=0) |
| 127 | cloud unanswered after compaction+replace | N-A | cloud worker scoped |
| 128 | RESUME_INTERRUPTED_TURN re-answers finished turn (tool ended + skill same step) | **PORT** | see notes |
| 129 | RC photos dropped on save failure | N-A | OCC RC has no photo delivery |
| 130 | RC files not arriving long sessions | N-A | OCC RC has no file delivery |
| 131 | 30–35 MiB RC/cloud files | N-A | same; OCC RC MAX_BODY_BYTES=256KiB local-socket design |
| 133 | Win: orphaned PowerShell from liveness check | N-A | OCC spawns pwsh per command (`powershellProvider.ts` -NoProfile -Command), no persistent shell/liveness prober; daemon liveness = `process.kill(pid,0)` (`src/daemon/process.ts:20`), no PowerShell probe |
| 134 | Win: hooks fail open w/o Git for Windows | N-A | OCC `findGitBashPath()` is FATAL `process.exit(1)` (`src/utils/windowsPaths.ts:98-125`) — missing-Git-Bash-and-alive precondition unreachable; already fail-closed at startup; divergence documented STAGED in `permissionSetup.ts:1109` (revisit if non-fatal model adopted) |
| 135 | Win: Git Bash didn't report PATH | N-A | OCC has no startup PATH capture from bash; every Bash call spawns fresh `shell:'bash'` (`BashTool.tsx:1160`) with parent env — session-poisoning mechanism absent |
| 136 | runner setup/doctor git creds | N-A | runner stub (no setup/doctor) |
| 137 | runner release timer / --retire-at | N-A | runner stub; no retire-at (grep=0) |
| 138 | cloud login-expired error text | N-A | cloud-session refusal surface |
| 148 | artifact watch 10→25 | N-A | no artifact watching in OCC |
| 152 | no redirects: claude.ai connector proxy / Anthropic-hosted MCP | **PORT** | see notes |
| 153 | no redirects: cloud/runner MCP proxy | N-A | cloud + runner stub |
| 160 | Cowork Chrome auto-mode classifier ask | N-A | no Cowork cloud auto mode |
| 161 | RC/cloud connectors MCP 2026-07-28 negotiation | N-A | no MCP_PROTOCOL_NEGOTIATION / 2026-07-28 in OCC (grep=0); cloud/RC-connector scoped |
| 163 | Cowork PermissionRequest hook can't approve shell | N-A | Cowork-cloud scoped; local auto-mode hook semantics unchanged |
| 172 | VSCode unsent prompt lost on switch | N-A | no VSCode extension (extension-side bug) |
| 173 | VSCode blank chats keep process alive | N-A | extension-side |
| 174 | VSCode mic button sign-out error | N-A | extension-side |
| 175 | VSCode startup vs Python ext | N-A | extension-side |
| 176 | VSCode model picker/slash menu cache | N-A | extension-side |
| 177 | Cloud memory spike on output-file resend | N-A | cloud-session scoped |
| 178 | Cloud routine env on save | N-A | cloud routines |
| 179 | Cloud admin session-ID search | N-A | claude.ai admin UI |
| 180 | Cloud admin empty-list copy | N-A | claude.ai admin UI |
| 181 | Cloud deploy command display | N-A | claude.ai UI |
| 182 | Cloud env delete disables routines | N-A | claude.ai/runner service |
| 183 | RC send-box offline behavior | N-A | RC client UI |
| 184 | Slack canvas delete | N-A | no Slack integration |
| 185 | Slack untagged-posts w/ guests | N-A | no Slack |
| 186 | Slack cross-channel reply report | N-A | no Slack |
| 187 | Slack runner image no python3 | N-A | no Slack/runner |
| 188 | Slack edit-in-place corrections | N-A | no Slack |
| 189 | Slack quiet join >100 members | N-A | no Slack |
| 190 | Code Review spend-limit links | N-A | no Code Review GitHub app |

## Counts
**66 total → PORT 5 (041, 060, 068, 128, 152) · ALREADY-ALIGNED 1 (080) · N-A 60**

## Notes for non-N-A entries

### 041 — PORT: headless/SDK stays in auto mode after set_model to non-auto model
`src/cli/print.ts:3105` set_model handler sets model + breadcrumbs, never re-validates auto mode. Entry into auto is gated (`handleSetPermissionMode`, print.ts:~4800, checks `isAutoModeGateEnabled()` which consults `modelSupportsAutoMode(getMainLoopModel())` via `getAutoModeUnavailableReason`, `permissionSetup.ts:1536-1549`), but after a mid-session switch to a model where `modelSupportsAutoMode()` is false, `toolPermissionContext.mode` stays `'auto'`. Fix: in set_model handler, if current mode is `'auto'` and `!modelSupportsAutoMode(resolvedModel)`, downgrade mode (mirror the interactive kick-out + `autoModeState` circuit semantics) and notify via session metadata; add headless e2e test (stream-json: set_permission_mode auto → set_model non-auto → assert mode downgraded/rejected).

### 060 — PORT: clamp usage displays at 100% (anthropics/claude-code#92238)
No clamp at any OCC display site: `src/commands/usage/usage-noninteractive.ts:28` (`Math.round(utilization*100)%`), `src/commands/usage/usage.tsx:223` (`Math.floor`), `src/services/rateLimitMessages.ts:222` (approaching-limit warning), `src/components/StatusLine.tsx:58,64` (`used_percentage: utilization*100` raw), `src/components/Settings/Usage.tsx:42`. Fix: `Math.min(100, …)` at each display site (VS Code surface N/A). Trivial, low-risk.

### 068 — PORT: resize images injected mid-session via SDK stream-json input
SDK user messages pass through `APIUserMessagePlaceholder()` (coreSchemas.ts:1449) — arbitrary content blocks including base64 images, with no resize before API send. `maybeResizeAndDownsampleImageBuffer` callers are only FileReadTool, BashTool utils, mcp/client, imagePaste (interactive paste). So OCC reproduces the official SDK-side bug: images attached while the session runs go full-size → repeated image errors in long conversations. Fix: apply `maybeResizeAndDownsampleImageBuffer` to image blocks in enqueued stream-json user messages in print.ts input path (skip already-small images), matching interactive paste behavior.

### 080 — ALREADY-ALIGNED: policy checked before connect for runtime MCP adds
`handleMcpSetServers` (print.ts:5581) runs `filterMcpServersByPolicy(servers)` FIRST; blocked servers get `'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'` in the response errors and are never connected (only `allowedServers` reach setup). Matches the official fixed behavior. Audit note: confirm no other mid-session add path (background plugin install → `applyMcpServerChanges`) bypasses the filter — both callers funnel through the same serialized `doWork`.

### 128 — PORT: resume detector re-answers finished turn when skill loaded in same step as terminal tool
OCC `detectTurnInterruption` (`src/utils/conversationRecovery.ts:419-511`): tail `attachment` rows return `{kind:'interrupted_turn'}` unless the backward scan finds an uncommitted max_turns_reached tail. A transcript ending `assistant[Brief/SendUserFile tool_use + Skill tool_use] → user tool_result(terminal) → attachment(invoked_skills)` classifies as interrupted → phantom "Continue from where you left off." on resume / auto re-answer under `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` (print.ts:1331-1350 re-enqueues). Also `isTerminalToolResult` inspects only `content[0]` of the tool_result message — a same-step skill result ordered first masks the terminal result. Fix (TDD): repro fixture first; then (a) scan ALL tool_result blocks in `isTerminalToolResult`, (b) let the attachment tail-branch (and `hasUncommittedMaxTurnsTail` user-row stop rule) look through skill-load attachments/`invoked_skills` rows to an underlying terminal tool_result → `{kind:'none'}`. Cross-check official v299 binary strings for the exact new tail predicate before finalizing.

### 152 — PORT: don't follow HTTP redirects to claude.ai connector proxy / Anthropic-hosted MCP
OCC connects `claudeai-proxy` servers via `StreamableHTTPClientTransport` (`src/services/mcp/client.ts:1471`) with `requestInit` lacking `redirect: 'manual'` (fetch default = follow), and fetches connector configs via `axios.get` (`src/services/mcp/claudeai.ts:83`, axios follows redirects by default). OCC already uses `redirect:'error'` elsewhere (`fetchPluginZip.ts:99`, `gatewayModelDiscovery.ts:153`) — same hardening pattern applies. Fix: add `redirect:'manual'` (or fetch wrapper rejecting 3xx) scoped ONLY to claudeai-proxy/Anthropic-hosted endpoints — plain user-configured http/sse servers must keep following redirects ("redirects by a connector's own server are unaffected"); set `maxRedirects:0` on the claudeai.ts axios call. Security-relevant (redirect-based SSRF/credential leak); suggest security-reviewer pass.

## 3. PORT implementation record

13 parallel work packages (WP agents), all completed 2026-10-15. None committed by the agents (coordinator-only commits). 89 modified + 95 new files on `agent/occ/6317e9be`.

### WP summaries

- **WP1 — #052+#070 gateway API-key leak (CRITICAL security).** NEW `src/utils/firstPartyEndpoint.ts` (official `Pm`/`vf`/`din`/`ba`/`fG`/`cA`/`f5` ports; `API_KEY_NOT_SENT_REASON` = "API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host"; sanitizer regex `/^(sk-ant-|sk-[\w-]{86}$)/`). Gates at the `src/utils/http.ts` `getAuthHeaders` chokepoint (12 consumers), `fastMode.ts`, `services/api/bootstrap.ts`, `services/remoteManagedSettings/index.ts` (skipRetry), `services/oauth/getOauthProfile.ts` (newly discovered leak site). `client.ts:483` main inference intentionally UNTOUCHED (official sends the key there). policyLimits/gatewayModelDiscovery/billing/install-github-app not gated — rationales documented in WP report. 44 new tests + 67 adjacent pass.
- **WP2 — #042/#098/#043 + #032/#055/#081/#110 MCP names & config.** Reserved MCP server names (`isReservedPrototypeMcpServerName` = exactly `__proto__,__defineGetter__,__defineSetter__,__lookupGetter__,__lookupSetter__`); #032 empty `.mcp.json` project-scope short-circuit (`{mcpServers:{}}`, debug log byte-exact); #055 `coerceMcpJsonServerStrings` (official `pOr`, non-policy sources only) in `settings/types.ts`+`settings.ts`; #081 policy-blocked servers gated before connect in `mcp.tsx` (label `✗ Blocked by enterprise managed policy`) + `runAgent.ts`; #110 regression-pinned only (live Commander path already correct). 31 new tests; adjacent suites 450/56/208/345/455 pass. Detailed report: issue comment `8d925ee6`.
- **WP3 — #025 teammate description redaction.** NEW `src/utils/swarm/describeTeammate.ts` (official `GQn` redact-then-truncate-50), wired at `spawnMultiAgent.ts:843` + `spawnInProcess.ts:155`; explicit-description path unchanged. 16 new + 121 regression pass.
- **WP4 — #097/#039/#040/#011 settings/config/plan-mode.** #097 MDM auth-pin precedence (`AUTH_PIN_KEYS`, `applyLocalAuthPinPrecedence` at both remote-won sites); #039 0-byte config residue (env.ts size>0 gate, config.ts empty→createDefault, Shell.ts `cleanupZeroByteConfigResidue()`); #040 NEW `sandbox-toggle/sandboxSaveFailure.ts` (official `qeo` "✗ Sandbox settings not changed: ", EACCES/EPERM/EROFS, hint text); #011 NEW `planModeBypassNotice.ts`+`PlanModeBypassNotice.tsx` (800ms delay, session-local fire-once, byte-exact @101543100). 62 new tests. Side repair: restored 5 accidentally-deleted lines in `src/utils/settings/types.ts` byte-exact from HEAD.
- **WP5 — #034+#027 sandbox WSL mounts & plugin denies.** NEW `src/utils/sandbox/wslMounts.ts` (official fstype sets `sl`/`Aa`/`hm`, /proc/mounts scanner, octal-unescape, fail-closed `WslWindowsSideMountsUndeterminedError` with byte-exact refusal); `sandbox-adapter.ts` +178/−5 (`computePluginDirDenyPaths()` #027 into denyWrite; WSL deny-filter dropping non-existent Windows-side-mount entries that crash bwrap mkdir; refusal surfaced in wrapWithSandbox pre-guard). #027 = OCC hardening (official main sandbox has no plugin denies; only eval sandbox). 40 new + 132 regression pass.
- **WP6 — #091/#031/#033/#049/#105/#166 REPL/UX.** #091 NEW `src/screens/promptSuppression.ts` (1500ms hold-until-clear, `tengu_ask_withdrawn`); #031 NEW `src/components/deferredRowCollapse.ts` (250ms=official `Jb`, selection-cancel, drag re-arm); #033 `keepsScrollPosition:true` on /btw + REPL repinScroll guard; #049 NEW UpdaterSeparator.tsx/autoUpdaterVisibility.ts; #105 NEW `src/commands/btw/sideQuestionLifecycle.ts` (in-flight dedupe, cancel-on-end) + print.ts; #166 660000ms side_question timeout + official message. 43 tests. tmux e2e scenarios specified (§4).
- **WP7 — #122/#167/#168/#082/#112 hooks & prompt expansion.** #122 SECURITY toolHooks.ts strip block (plan/auto mode voids hook `permissionDecision=allow`; telemetry `tengu_auto_mode_permission_request_allow_ignored` new-in-299); #167 processUserInput.ts pre-expansion UserPromptSubmit hook pass for prompt-type slash commands (blocking message shape `${blockingMessage}\n\nOriginal prompt: ${input}`; no updatedPrompt officially); #168 falls out of #167 + regression test; #082 `clearInstalledPluginsCache()`; #112 structurally immune + 3 pinning tests. 85 regression pass.
- **WP8 — #041/#060/#068/#128/#152/#116/#079/#042-class/#073-verify F-cluster.** #041 set_model auto-mode downgrade gate in print.ts; #060 clamp 100% at StatusLine.tsx/Settings-Usage.tsx/rateLimitMessages.ts/usage-noninteractive.ts; #068 NEW `src/cli/sdkInputImages.ts` resize stream-json input images; #128 conversationRecovery.ts (+79/−8, scan ALL tool_result blocks, look through skill attachments; KAIROS-gated reachability caveat); #152 SECURITY `redirect:'manual'` proxy-branch-only in mcp/client.ts + `maxRedirects:0` in claudeai.ts (deliberate divergences: plain-user-http ≤5-hop rule NOT ported; OAuth-revocation beforeRedirect NOT ported — flagged for security review); #116 auth.ts (+111/−10) configured headers through OAuth (`Uie`/`_`/`qbn`/`fle` ports); #079 `postBodyHasNoRequests` + body.cancel() short-circuit (OCC-layer fix; SDK send() byte-identical 296↔299); #042-class client.ts ~:1111 readOwnOption; #073 verified NOT-INHERITED (5-point reasoning).
- **WP9 — #103+#069 git untracked list & image token limits.** #103 `parseUntrackedFileList` shared helper (official `bxo` per-line filter; leading/trailing-space filenames survive); #069 token-aware image limits (apiLimits.ts IMAGE_TOKEN_PATCH_SIZE=28/DEFAULT_IMAGE_LIMITS 2000×2000; configs.ts MODEL_IMAGE_LIMITS 9 models ×{2576,2576,4784} — exactly 11 official entries verified, mythos omitted (not in OCC catalog); imageResizer.ts estimateImageTokens/scaleForTokenBudget (`q`, 1568 internal defaults)/applyImageLimits (`Y`)/lazy getCurrentImageLimits; tengu_image_resize full field set). 14+29 new tests, 511 combined pass. Behavior change intended: large images now physically resized for token-budget models.
- **WP10 — #154/#126/#101/#113/#065+#158+#159/runAgent-guard E-security.** #154 NEW `src/utils/nameSafety.ts` (predicate chain + warn text byte-exact); #126 encoding fidelity (fileRead.ts detectEncodingFromBytes/classifyFileBytes/preserveBomOnRewrite; fileStateGuard.ts `Zpt`/`nHs`/`H9`; FileWriteTool unconditional notText refusal; FileEditTool errorCode 15; readFileInRange BOM totalBytes; FileReadTool notice WeakMap) — 244 pass; #101 safe-mode in daemon WorkerRecord; #113 worktree reftable + prune; #065/#158/#159 NEW `src/utils/permissions/mcpRuleMatching.ts` (official `oX`/`TE` port; ALLOW tightened, deny/ask deliberately over-match per binary — deviation from spec wording documented) + permissions.ts + agentToolUtils.ts; runAgent.ts frontmatter reserved-name guard byte-exact @225906218. 1029 pass across 92 files.
- **WP11 — #010/#017/#074/#085/#115/#144-#147/#149/#156 E-messages.** #017 NEW usageWarnings.ts (9-key catalog, 4 new keys: max_effort/workflow/always_on_context/large_tool_results) + usageScan.ts (`Z`/`K`/`G`/`ee`/`te` state machine) wired into usage-noninteractive.ts (real e2e output verified); interactive Settings/Usage.tsx wiring BLOCKED (concurrent file ownership) — follow-up; #156 WebFetch effort follows web search (family-match gate); #010 FleetView safe-mode row; #074 nextRunDisplay.ts; #085 modeExitHints; #115 ultracode schema+delivery; #144 Unknown-skill suggestions; #145 reload-skills message; #146/#147 worktreeBaseResolve.ts; #149 notificationReasons.ts. 198+ tests. Detailed report: issue comment `0181bf43`.
- **WP12 — #093/#111/#123/#124/#125/#073-verify background/session.** #093 joinPromptValues content-block `\n` merge in print.ts (~:444); #111 NEW `src/utils/argvBackgroundFlag.ts` (verbatim official argv position scanner, ~85 single-value flags) + cli.tsx lazy-import gate (BG_SESSIONS dead code — parity only); #123 N-A-with-guard (atomic `notified` check-and-set in LocalAgentTask; 4 dedup tests); #124 NEW `agentNameRehydration.ts` (official `t_n` @244543193) wired at both sessionRestore.ts resume families; #125 claude.ts `buildNonStreamingCutShortMessage` at both non-streaming fallback sites (64000 cap variant); #073 verified NOT-INHERITED. 39 new tests.
- **WP13 — #001/#028+#029/#030/#047/#076/#102 debug/env/scheduler.** #001 `CLAUDE_CODE_DISABLE_FILE_MENTIONS` (envUtils.ts + attachments.ts, gate @227272610 true-new); #028/#029 debug backlog bounds (1 MiB/10s; verbatim dropped-note) + non-blocking stderr flush; #030 relaxed inline-shell rm prompting + `CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT=1`; #047 already-aligned (verification tests only, disjoint from #093); #076 NEW `invalidSettingsReport.ts` + main.tsx else-branch (official `jR` @250480040; headers byte-exact; json/stream-json suppress; telemetry `tengu_own_settings_validation_errors`); #102 cron DST (official `yPt` walker @223024523 + `k` ambiguity detector; fall-back second-occurrence skip for recurring, one-shots may match; scheduler first-sight anchor). ~140 tests.

### Cross-cutting repairs during reconciliation

- `src/utils/settings/types.ts`: 5 lines accidentally deleted by a concurrent agent (orphaned `isMcpServerCommandEntry` body) — restored byte-exact from HEAD by WP4; `git diff HEAD` on that hunk empty.
- **bun mock.module worker poisoning (test infra):** `usageNoninteractive299.test.ts` + `rateLimitMessages299.test.ts` registered NARROW top-level `mock.module` factories (auth/billing/format/cost-tracker/claudeAiLimits). Bun's mock registry is process-global, so any dev-mode `bun test <dir>` sharing a process hit `SyntaxError: Export named 'isClaudeAISubscriber'/'getClaudeAIOAuthTokens'/'formatFileSize' not found` in unrelated files. Both files hardened per the OCC-97 pattern (applyEffort299.test.ts): import real modules first → superset spread mocks → cache-busting SUT import → re-register real modules in afterAll. Verified: standalone 3/3 + 4/4, 5-file combined worker run with auth/format probe 52 pass / 0 fail ×2 repeats (previously 2 fail / 2 errors). `scripts/ci-test.sh` per-file process isolation means the CI gate was never exposed, but dev-mode runs were.
- Nested `src/**/src` directories (86 dirs / 653 files) confirmed TRACKED since initial commit `4cb2367` and present in baseline `b9f6a7f` — pre-existing repo content, not agent debris; kept.

### Follow-ups (not blocking this round)

1. WP2: `wnr` @226127734 SDK-registration reserved-name throw — OCC surface unverified; settings.ts inline SDK flagSettings coercion sites (~:710/~:1224) for #055.
2. WP4: doctor diagnostic for 0-byte config residue; SandboxOverridesTab.tsx save-failure surfacing.
3. WP8/#152: two unported official sub-behaviors (plain-user-http ≤5-hop redirect rule; OAuth-revocation beforeRedirect) — **security review recommended** (also #116 configured-headers-through-OAuth, WP1 #052/#070 gates, WP7 #122 hook-allow strip, WP10 #154 nameSafety).
4. WP9: `--full-name` omission pre-existing gap; `jro` pipeline fallback not ported (no OCC consumer).
5. WP10: NotebookEditTool still on v296-era fileStateGuard constants; `x` glob helper substituted; deny/ask over-match deviation from spec wording (binary-faithful).
6. WP11: interactive Settings/Usage.tsx #017 wiring BLOCKED this round.
7. WP13: jitter-default divergence pre-existing (0.1/15min vs official 0.5/30min+cacheLeadMs — not a 296→299 delta); v299 scheduler extras (lease/checkNow/liveness) beyond scope.

### Gate results

- Build: green (`dist/cli.js` 30.20 MB, MACRO.VERSION=2.1.382).
- Full suite `CI=1 bash scripts/ci-test.sh` (per-file process isolation): **11857 pass / 0 fail / 119 skip across 1059 files** vs main baseline `b9f6a7f` (11087 pass / 0 fail / 119 skip / 986 files). Δ = +770 pass, +73 test files, **zero net-new regressions**.
- First full run had 2 failures, both triaged and cleared:
  1. `projectScopeEnvBlocklist251.test.ts` — documented-count assertion 117→118: WP13 #030 intentionally added `CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT` to the project-scope blocklist (security kill-switch; same precedent as 2.1.281 `DISABLE_SUBSTITUTION_RM_PROMPT`). Test expectation updated with rationale comment.
  2. `backgroundTasksDialogMcp295.test.tsx` — `waitFor timed out` under full-suite parallel load only; test file and its SUT (`McpBackgroundTask`) both UNCHANGED this round; passes 3/3 isolated and passed in the clean re-run. Load-induced flake of a pre-existing timing-sensitive test, not a regression.



## 4. e2e / A/B acceptance

All runs 2026-10-15 against commit `1bee626` build (`dist/cli.js` 30.20 MB, MACRO.VERSION=2.1.382). Official channel: `/tmp/cc-official299/bin/claude` (runnable npm channel — the no-execute discipline binds only the forensic ELF copies in /tmp/cc-diff-299; both removed after this section per upstream-tracking skill).

### Headless `-p`

- OCC: `echo "Reply with exactly one word: PONG" | bun dist/cli.js -p` → `PONG`, exit 0 (with the known `[claude-code:unrecognized_model] {"model":"glm-5.2"}` gateway-model notice).
- Official 2.1.299 A/B: same prompt → same `unrecognized_model` notice + `PONG`, exit 0. **Core path parity confirmed.**
- Official-only extra output: the v299 auto-mode-classifier **billing-migration notice** ("We're changing auto mode to no longer charge for classifier requests… this session isn't eligible because your requests go through <gateway>"). Tied to Anthropic first-party classifier-billing backend; explicitly not applicable to gateway sessions. **N-A for OCC** (billing/analytics stubbed) — recorded, not ported.

### #041 stream-json control-protocol e2e (WP8 scenario, live)

`-p --input-format stream-json --output-format stream-json --verbose` with `CLAUDE_CODE_ENABLE_AUTO_MODE=1` (gateway provider requires the opt-in per the official `Olt` rule):

- Positive: `set_model claude-sonnet-4-6` → success; `set_permission_mode auto` → success `{mode:"auto"}`; auto held for 6s with NO status event; `set_model claude-haiku-4-5` (explicit denylist) → **immediate `system/status permissionMode=default` downgrade event + success response**. Exactly the 2.1.299 fix behavior.
- Negative control: same sequence but `set_model claude-opus-5` (auto-capable) → success with **no** downgrade event; session stays auto. Gate is model-conditional, not unconditional.

### tmux real REPL

200×50 tmux session, `bun dist/cli.js`:

- Boot: banner `OCC v2.1.382 · Open C Code`, model line `glm-5.2 with xhigh effort · API Usage Billing`, PROJ git branch, both-auth-vars warning rendered.
- Live model round-trip: `❯ Reply with exactly one word: PONG` → `● PONG` (58201 tokens).
- `/status`: dialog renders Version 2.1.382, session ID, auth token + API key rows, base URL, model, `MCP servers: 2 connected, 1 failed`, `Auto mode server: Disabled`; Esc dismisses ("Status dialog dismissed").
- `/btw what is 2+2?…` (#105/#033 surface): side-question overlay answered `4` with the scroll-preserving dialog chrome (`↑/↓ to scroll · ←/→ to switch · c to copy · Space, Enter, or Escape to dismiss`) — keepsScrollPosition path exercised live.
- `/exit` clean exit.
- WP6's deeper interaction scenarios (#091 dialog-hold timing, #031 mouse double-click collapse deferral, #049 updater separator visuals) are pinned by 43 unit/component tests + specified in the WP6 report; not automated in tmux this round (mouse-sequence injection unreliable in headless tmux).
- Repo e2e suites ran inside the CI gate: 158 `test/e2e` files incl. `occ-versioning`, `commands-alignment`, `version-2.1.219-*` (all pass); `repl-interactive` 3 skip (pre-existing sandbox-stall constraint, OCC-41/42) — covered by the live tmux session above instead.


## 5. npm publish debt re-check (owner-side, report-only)

Re-verified this round (report-only per Leader ruling — **does NOT block** the release flow):

- `npm view @cnwenf/occ dist-tags` → `latest` = **2.1.367**. Registry is **14 versions behind** the git tags: v2.1.368, v2.1.369, v2.1.370, v2.1.372 … v2.1.382 all missing from npm (tag **v2.1.371 does not exist** in the repo either — that release was skipped, so 368–382 minus 371 = 14 unpublished).
- Failure signature (v2.1.382 publish attempt, GitHub Actions run **38463472734**): `npm error 404 Not Found - PUT https://registry.npmjs.org/@cnwenf%2focc` — npm returns E404-on-PUT when the authenticated token lacks **write** authorization for the `@cnwenf` scope (not a missing-package condition). Build + `gh release create` steps in publish.yml succeed; only the `npm publish` step fails, consistently, for all 14 versions.
- Root cause is **owner-side credential scope** (`NPM_TOKEN` read-only or wrong scope) — not fixable from the agent runtime. GitHub Releases parity is unaffected (tags = releases, verified each round). Action for the workspace owner: rotate `NPM_TOKEN` to an automation token with read-write scope on `@cnwenf/occ`, then re-run publish for the missing tags (or `npm publish` from a checkout of each tag).
- This round's v2.1.383 publish attempt will likely fail identically; per the standing ruling that is reported, not blocked on.

## 6. Delivery

**Release 2.1.383 — delivered 2026-10-15.**

- **Docs/version bump** (commit `e798433`): README badges/prose L8/L16/L65/L160 → "Tracks: Claude Code 2.1.299 (partial)" with the OCC-158 round summary (OCC-113 demoted to prior-round history); CHANGELOG.md header tracking paragraph → 2.1.299 with the OCC-113 round chained as "then the OCC-113 round", plus a new `## 2.1.383 - 2026-10-15` section in parseChangelog format (`- ` bullets for the REPL What's-new feed); `package.json` 2.1.382 → 2.1.383. Build verified: `dist/cli.js` 30.20 MB, `MACRO.VERSION=2.1.383`, `bun dist/cli.js --version` → `OCC 2.1.383`.
- **Parallel-run collision on main**: while this round was in flight, another agent pushed OCC-158 work to main (`adcc0d3` 38-PORT triage ledger at this same path + `0da14ee` #42 + `808a5f2` #55 + `f3803e1` #65/#158, then `7648383` #32 + `e1b200b`/`9dc24d2` ledger notes). Both rounds implemented #32/#42/#55/#65/#158 independently. Merges `5ff2165` + `cde3c91` (+ fixup `5a99bc9`) resolved every overlap in favor of the binary-verbatim implementation, keeping BOTH sides' tests green:
  - `config.ts` #42: kept `readOwnOption` call sites (optionKeySafety); main's `hasMcpServerEntry` retained as an export (its test imports it) — same own-property semantics.
  - `permissions.ts` #65/#158: kept `mcpRuleMatchesTool` (official `S` @219828700 — allow/deny asymmetry, per-tool wildcards, `zFn` warning); main's inline approximation dropped. Its test `mcpWholeNameRuleMatch299` had 2 expectations encoding the symmetric approximation — corrected to official semantics (deny `mcp__a` DOES reach server `a__b` fail-safe; allow `mcp__a_` does NOT reach server `a_`, whole-name wildcard `mcp__a___*` does).
  - `types.ts` #55: dropped main's schema-level `z.preprocess` (it would coerce POLICY sources too — official `Tt` gates `if(!r?.policySource)pOr(e)`); kept the verbatim `pOr` at the parse layer. Main's test adapted to the official two-layer behavior. 14/14 across both #55 suites.
  - `config.ts` #32: kept the project-scope-only blank-file gate (official `ast` @226018857) with the byte-exact debug log; both sides' tests pass 19/19.
  - Ledger: this 66-PORT ledger kept as canonical (main-side 38-PORT triage superseded; its landed items are a subset of this round's PORT set).
  - Post-merge gate: full `ci-test.sh` 11985 pass / 2 fail — both failures triaged and fixed in `5a99bc9` (the #55 layering above; `commands-behavior.e2e` `/feedback` asserting the literal "Issue created:" against live-model wording drift — hardened to stable-fact assertions with a hard URL check so auto-close can never be silently skipped; orphaned issues #503/#509 closed). Re-runs: 16/16 e2e, 42/42 permissions, all overlap suites green.
- **Merge + tag**: `origin/main` fast-forwarded to `cde3c91` (merge of `agent/occ/6317e9be`); tag `v2.1.383` → `cde3c91` (re-pointed after the final merge; force-push re-triggered publish).
- **publish.yml**: runs 38665634031 + 38665831260 both failed at the `npm publish` step with the standing E404 credential-scope debt (§5) — reported, not blocked. `Create GitHub Release` is `if: success()`-gated behind npm, so the Release was created manually with the workflow's exact idempotent command: <https://github.com/cnwenf/occ/releases/tag/v2.1.383>.
- **Parity**: 182 tags = 182 releases — exact parity holds (the round-opening "183" estimate miscounted; v2.1.371 was never tagged).
- **npm debt re-check (report-only)**: registry `latest` still 2.1.367; missing v2.1.368–v2.1.383 (15 versions; 371 never tagged). Owner-side `NPM_TOKEN` rotation required — see §5.
