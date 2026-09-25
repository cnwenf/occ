# OCC-96 — 2.1.280 → 2.1.281 catch-up ledger (2026-09-24)

> **Provenance note:** this file previously held the 2026-08-17 OCC-96 round
> ledger (2.1.233-era Gap-96 shell-marker escape port). That content is
> preserved in git history at commit `ed9966e`. The OCC-96 issue was re-scoped
> this round to the 2.1.280 → 2.1.281 catch-up; this is the authoritative
> ledger for it.

## 1. Version verification (三方)

| source | value |
|--------|-------|
| npm `@anthropic-ai/claude-code` latest | **2.1.281** |
| GitHub anthropics/claude-code release | **v2.1.281** (2.1.279 never published; 280 → 281 direct) |
| Fresh `@anthropic-ai/claude-code-linux-x64@2.1.281` ELF | 237,375,560 B, md5 `d00df59384be94d0b5cac74849540075` |
| v2.1.280 ELF (baseline OCC tracked) | 233,709,640 B, md5 `31162c871610fc8111e7f08ca1be8218` |

OCC before this round: version `2.1.351`, tracking upstream `2.1.280`
(the OCC-134 round, ledger `docs/upstream-version-gap-occ134.md`).

## 2. Method (upstream-tracking + aligning-with-official-binary skills)

1. `npm pack` both linux-x64 ELFs; `strings -n 8 | sort -u` each;
   `comm -13/-23` → **19,520 new** / **15,537 removed** unique strings.
2. Full 2.1.281 changelog parsed into **176 numbered entries**
   (#001–#176; #151–#176 platform-tagged: VSCode / Web / Claude Tag /
   Code Review).
3. Four parallel triage agents (A: 37, B: 32, C: 24, D: 83 entries), each
   byte-verifying every claim with `win.py` context probes on **BOTH** ELFs
   (a delta is only real when v280 hits ≠ v281 hits) and inspecting OCC's
   current source before declaring a gap.
4. Verdict vocabulary (same as occ134): **PORT** (byte-verified delta +
   located v281 implementation + OCC target; 🔒 = security fix), **NO-OP**
   (OCC structurally immune / already post-fix), **STAGE** (real gap, not
   isolatable from strings / needs subsystem work), **SKIP** (Anthropic
   backend / other-platform / no OCC counterpart).
5. All 39 PORTs implemented byte-faithfully (binary wins over triage prose —
   see §6), each with unit/e2e tests, then combined-tree build + full
   `bun test` + Docker e2e + tmux REPL acceptance.

## 3. Aggregate tallies

| verdict | A | B | C | D | total |
|---------|---|---|---|---|-------|
| PORT    | 13 | 11 | 6 | 9 | **39** |
| NO-OP   | 4 | 6 | 0 | 5 | **15** |
| STAGE   | 13 | 7 | 11 | 43 | **74** |
| SKIP    | 7 | 8 | 7 | 26 | **48** |
| **total** | 37 | 32 | 24 | 83 | **176** |

Security subset: **9 🔒 PORTs** (#033 #034 #040 #049 #064 #068 #109 #110
#137), **2 🔒 NO-OPs** (#035 #038), 🔒-adjacent STAGEs (#007 plugin
`.mcp.json` validation, #036 sandbox `excludedCommands`, #037
`CLAUDE_CODE_TMPDIR`).

## 4. Per-entry verdicts

### Cluster A (#001–#004, #010–#023, #029–#032, #049–#051, #102–#108, #135–#139)

| ID | verdict | entry (abridged) | key evidence |
|----|---------|------------------|--------------|
| #001–#004 | SKIP | gateway policy-blocks / Bedrock `assume_role` / guardrail / telemetry attrs | Claude-apps gateway server-side config; no OCC parser |
| #010 | STAGE | crash "unrecoverable interface error" during API retry | exit-handler bytes identical v280≡v281; logic-only delta |
| #011 | NO-OP | turn retries forever ignoring --max-turns | OCC has no malformed-tool-use retry subsystem (0 hits) |
| #012 | STAGE | resumed sessions re-send earlier turns in changed form | resume-normalization deep work; #015 lands the constant family |
| #013 | STAGE | very large session resume restores only last messages | logic-only JSONL restore; no marker delta |
| #014 | STAGE | resume after restart during pending permission prompt | parked-permission subsystem (Hu) absent in OCC |
| #015 | PORT | resume of mid-tool-call session: visible placeholder, no hidden "Continue" | NEW kH/TH constants 0→3 @194406019; detection list `ee=[Ud,ok,kH,TH]` @194430168; v280 list lacks both |
| #016 | STAGE | advisor result unreadable → every turn fails | repair subsystem logic-only (3→3); OCC has no advisor |
| #017 | STAGE | prompt cache lost on MCP disconnect mid-conversation | wouldInvalidateCache analyzer absent in OCC (0 hits) |
| #018 | PORT | proxy clean-close mid-response shown as complete | StreamTruncatedError 0→2 @202523094; OCC claude.ts:2842 byte-matches v280 |
| #019 | PORT | "Content block not found" when proxy drops event | StreamMalformedEventError 0→2 @195427201; replaces RangeError @202512239+; integrity flag keeps partial |
| #020 | PORT | empty completed response requested twice | v281 catch close-after-complete break @202526457 |
| #021 | PORT | stop reason lost on trailing usage-only frame | conditional retention @202517677 vs unconditional v280 @199674803 |
| #022 | PORT | RETRY_WATCHDOG uncapped silent sleeps | v281 @202417418 cap TRe=21600000 + too_long throw + persistent_retry_wait; constants @202407124 |
| #023 | PORT | fast mode back-to-back retries on `Retry-After: 0` | v281 backoff-floored + capped vRe=20000 + visible request_retry; OCC withRetry.ts:430 raw sleep = v280 bug |
| #029 | STAGE | SDK-MCP first-message stall on dead host handshake | markers identical (4→4); logic-only |
| #030 | NO-OP | startup waits on managed-settings network request | OCC init.ts:263 never blocks (`void …then`); structurally immune |
| #031 | PORT | 2-min delay reading/@-mentioning PDF > 3 MB | v281 tengu_deep_starlight gate (default-on ⇒ whole-doc render skipped) + pdfRenderSignal @201314878; OCC FileReadTool.ts:1098 has v280 bug verbatim |
| #032 | PORT | interrupted PDF page Read leaves render running ≤2 min | pdfAbortParent 0→4 / pdfRenderSignal 0→8 @203617282; OCC pdf.ts:231 no signal |
| #049 | PORT 🔒 | locked keychain → credential write drops MCP OAuth tokens | readAsyncStrict failureIfTransient + read_failed_skip_write 0→2 @195273552; throw @215706384; OCC update() clobbers shared blob |
| #050 | PORT | gcp/aws auth-refresh orphans hold localhost callback port | v281 `ta` watchdog class @196003456 (tree kill + shutdown hook, KN=180000); OCC plain `exec` |
| #051 | STAGE | sibling-process login not adopted ("Not logged in" persists) | needs credential-watch subsystem (SessionController/showsLoginNotice 0 hits in OCC) |
| #102 | SKIP | Desktop sign-in / usage-limit error copy | no OCC Desktop flow |
| #103 | PORT | managed-settings/policy fetch retries never-succeeding 4xx | isNonRetryableClientError 0→2 @193033439; OCC retries all 4xx to 30 s deadlock |
| #104 | STAGE | startup git/telemetry/model-upgrade moved after first frame | perf reorder, not isolatable |
| #105 | STAGE | faster resume; restored file cache matches files as-read | OCC doesn't seed file cache on resume at all (pre-existing gap) |
| #106 | STAGE | faster resume of long compacted sessions | perf-only, markers in both ELFs |
| #107 | STAGE | huge first prompt summarized on its own | compaction internals, not isolatable |
| #108 | STAGE | auto-mode classifier prompt-cache reuse after resume | v281 Tm() hydration store @202217101 (classifierCompactions 0→7); hydration SOURCE not extractable |
| #135 | NO-OP | server-side classifier review gates read-only/sandboxed cmds | server classifier = Anthropic backend; OCC local classifiers already review everything |
| #136 | SKIP | CLAUDE_CODE_AUTO_MODE_SERVER on direct API | env var 0 hits in OCC; backend-dependent |
| #137 | PORT 🔒 | dangerous-rm prompt auto-denies after 2 min with rewrite hint; CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT | autoDenyWindow 0→20, maxDialogTimeouts 0→13; config `gee={enabled,showDialog,timeoutMs:120000,maxDialogTimeouts:3}` @201961862; deny msg $0t @204142297; OCC prompts forever |
| #138 | SKIP | gateway managedMcpServers envHelper UNC startup check | 0 hits; gateway infra |
| #139 | NO-OP | self-hosted runner --system-prompt-file flags | both flags fully implemented in OCC (main.tsx:1065/:1551-1583) |

### Cluster B (#005, #024–#028, #033–#048, #092, #100–#101, #109–#114, #134)

| ID | verdict | entry (abridged) | key evidence |
|----|---------|------------------|--------------|
| #005 | PORT | `"attribution": false` hides all commit/PR attribution | v281 zod flattener @193763767 → schema became union(bool\|object); OCC settings/types.ts:379 object-only |
| #024 | STAGE | oversized image siblings | `oversized` delta = prose churn; fix not isolatable |
| #025 | STAGE | `tool_use.name` >200-char stuck streaming | logic-only, 0 string delta both ELFs |
| #026 | NO-OP | `Failed to get memory usage` spam | string 1→1; no memory-usage subsystem in OCC (0 hits) |
| #027 | STAGE | stream-json input plain-string `content` | parser logic-only; not isolatable |
| #028 | PORT | headless turn survives cwd deleted mid-session | v281 `kh`/`vh`/`bh` CwdDeletedError recovery @215940349 (pin + warn + once-per-session notice); OCC turn throws uncaught |
| #033 | PORT 🔒 | macOS `/.vol` `/.nofollow` `/.resolve` kernel-resolved paths can trigger network mount pre-approval | 0→15/10/10 hits; deny msg @97322030; validators kMt/VPr @194136094; OCC had Windows-UNC guards only, zero macOS defense |
| #034 | PORT 🔒 | `rm -rf "$(…)"` ran unprompted in auto/--dangerously-skip-permissions | CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT + wholeSubstitution/emptyExpansion/literalTarget 0 hits v280 → 5/3/2/2 v281; logic x$() @202903176; OCC VULNERABLE (pre-280 message) |
| #035 | NO-OP 🔒 | NUL-byte permission rule expanded to wildcard | logic-only fix (no new string); OCC's npm `ignore` matcher empirically matches nothing on NUL patterns (direct-tested) = post-fix behavior |
| #036 | STAGE | sandbox `excludedCommands` matching misses (`git rev-parse --git-dir`, builtins, `[WIP]`/`#`) | fix site not isolatable (0 string delta both ELFs); fail-safe direction; non-security-boundary per OCC docs |
| #037 | STAGE | sandbox honors `CLAUDE_CODE_TMPDIR` for writes | env hits are UDS-unrelated; count 42→42; fix site not isolatable |
| #038 | NO-OP 🔒 | `--bg` starts session (runs hooks) in untrusted dir | OCC `--bg` never starts a session (main.tsx:1112 redirect + exit; BG_SESSIONS dead) |
| #039 | PORT | `--setting-sources`/SDK settingSources forwarded to spawned sessions | v281 builder gains `settingSources`/`restricted` (new_strings @789507/@9315824); OCC spawnMultiAgent.ts:233-259 doesn't propagate |
| #040 | PORT 🔒 | NUL byte in file-tool path ends whole turn | `backfillObservableInput met a path` 0→2, `cannot be expanded (null byte` 0→2; validator fy @201072434; OCC query.ts:873 unguarded, path.ts:49 throw bubbles |
| #041 | PORT | Write rejects path/content given twice under alias with identical value | v281 `ett()` dedup loop @201115780 (`repeated_${alias}` shapeClass); marker v280=0; OCC v280-era coercion only |
| #042 | NO-OP | add-dir CLAUDE.md loaded twice | OCC env-gated OFF by default + processedPaths dedupe = post-fix behavior |
| #043–#048 | SKIP | remote-session / /loop remote fixes | Anthropic Remote-Control/cloud backend; no OCC counterpart |
| #092 | NO-OP | bash edit-diff snapshot temp dirs pile up | whole snapshot subsystem absent in OCC (0 hits). (D's bonus row said STAGE-for-future; B's assignment governs.) |
| #100 | SKIP | Windows sandbox fix | no OCC win32 sandbox surface (0 hits) |
| #101 | SKIP | Windows updater fix | no win32/.exe update machinery in OCC |
| #109 | PORT 🔒 | auto-mode denial message must scope to the OUTCOME (no rerouting via other tools/interpreters/sub-agents/later turns) | mnn/gnn/lKe constants @200520375; `This denial applies to the outcome` 0→1; OCC 0 hits → denial rerouting legitimate today. `${lt}`/`${zr}` later resolved to "Read"/"Grep" — see §6.3 |
| #110 | PORT 🔒 | dangerous-rm extended: shell-var + top-level dir name; cwd-derived vars; backslash-only target | `tengu_bright_lake`/`placeholder_root_child`/backslash msg 0→2 each; `on possibly-empty variable path` 2→7; OCC pre-280 |
| #111 | PORT | sandbox EPERM guidance names `sandbox.network.allowLocalBinding` | allowLocalBinding 0→4; guidance new_strings @3990739/@3991271; gate @203529833; OCC setting+getter exist, guidance missing |
| #112 | PORT | `--agents <json-or-file>` (with --print); empty prompt; TOCTOU/size/hard-link guards | help @209614298, parse @209004909, errors @95218712; OCC main.tsx:1093 inline-only |
| #113 | NO-OP | /batch worktree WorktreeCreate hook ancestry check | message byte-identical v280≡v281 (5→5); OCC setup.ts:175-190 already mirrors; no /batch in OCC |
| #114 | STAGE | plugin-hook `$CLAUDE_PLUGIN_ROOT` shell-form naming + unquoted-path warning | shell-replacement regex found @336305 but warning text absent — half-isolatable |
| #134 | STAGE | send-now backgrounding delivers a message (`backgroundedToDeliverMessage`) | marker 17→18 (subsystem pre-exists upstream); OCC BashTool lacks the whole send-now subsystem → deep work |

### Cluster C (#006–#008, #052–#060, #115–#118, #120, #141–#142, #146–#150)

| ID | verdict | entry (abridged) | key evidence |
|----|---------|------------------|--------------|
| #006 | STAGE | MCP URL-mode elicitation on 2026-07-28 protocol; no waiting dialog | tengu_mcp_url_elicitation 0→2 @200797155; OCC has elicitation but protocol-version split not isolatable |
| #007 | STAGE 🔒-adj | `plugin validate` MCP checks: silently-dropped `.mcp.json`, undeclared `${user_config.*}`, insecure URLs, literal credentials | strings clean @228893822+; exact predicates need a NEW 6-check subsystem — highest-value STAGE |
| #008 | STAGE | /insights auto-mode recommendation | render strings clean @211460056; data derivation (estimatedPrompts/nonAutoSessions) not isolatable |
| #052 | PORT | mcp_tool hooks on blocking events wait for still-connecting server | KRe wait block @202571986, Pgo/NIt=50/Ago=5000 @202573308, TTt non-blocking set @198876780 (19 members, 0 v280 hits); "to finish connecting" 0→2; OCC execMcpToolHook.ts:129-140 skipped immediately |
| #053 | STAGE | MCP server dedup on URL spelling (host case/default port/trailing slash) | pure-logic, no string delta (the 443 hit is a git-URL canonicalizer) |
| #054 | STAGE | `MCP_CONNECTION_NONBLOCKING=0` honors MCP_CONNECT_TIMEOUT_MS not 1 s | timeout logic, no isolatable delta |
| #055 | STAGE | `--channels` entries must match installed plugin's NAME too | gap located (channelNotification.ts:267-270 marketplace-only) but no isolatable fix bytes |
| #056 | STAGE | `--plugin-dir` folder-of-plugins + marketplace.json loads contained plugins | gap located (pluginLoader.ts:3145 plugin.json-only); no clean delta |
| #057 | STAGE | `plugin uninstall` says "enabled at project scope" for a DISABLED plugin | gap located (pluginOperations.ts:488-493); strings unchanged 2→2 |
| #058 | STAGE | `plugin update` resolves installed scope instead of assuming `user` | gap located (plugins.ts:833 hard default); not isolatable |
| #059 | PORT | `plugin validate` stops flagging privacyPolicyUrl/supportUrl/listing-metadata as unknown | known-keys Set `Me` @228859849 (13 keys); privacyPolicyUrl/supportUrl 0→2; OCC zod .strict() flags them |
| #060 | PORT | `known_marketplaces.json` stamped refreshed even when remote unreachable (KEEP_ON_FAILURE) | `{kind:"kept-stale"}` @203674456, keptStaleClone 0→6; OCC marketplaceManager.ts:1287 bare return → stamps anyway |
| #115 | SKIP | claude.ai-synced skills short names | no claude.ai skill sync in OCC |
| #116 | SKIP | /deep-research reliability | OCC ships zero bundled workflows (by design, CLAUDE.md OCC-31) |
| #117/#118 | SKIP | artifact page prose / compressed uploads | no Artifact tool in OCC |
| #120 | PORT | debug logs name settings `env` vars ignored because launch env sets them | warn fn J() @197082872 ("already sets" 0→2); OCC managedEnv.ts:74-83 drops silently |
| #141/#142 | SKIP | artifact footer pill / unpkg.com CSP | no Artifact tool |
| #146 | STAGE | RC attachment downloads reuse connections + skip downloaded | diffuse delta; RC/oauth-backend-coupled |
| #147 | PORT | MCP resource lists skip MCP Apps UI resources; read-by-URI still works | detector XXe @207138863 (`ui://` or text/html;profile=mcp-app), filter @207460730, "UI resource(s) left out" 0→2, consts @200797306 |
| #148 | SKIP | `plugin uninstall --json` data-kept wording | no --json uninstall surface in OCC |
| #149 | STAGE | /tasks `x` on running /ultrareview asks confirmation | gap located (BackgroundTasksDialog.tsx:307-312 instant kill); "Stop ultrareview" 5→5 unchanged |
| #150 | PORT | hide leftover "(removed)" /agents entry from menu + /help; exact-name still explains | isHidden:!0 @203481607 (count 117→120); OCC commands/agents/index.ts lacks it; HelpV2/commandSuggestions plumbing already honors |

### Cluster D (#009, #061–#091, #093–#099, #119, #121–#133, #140, #143–#145, #151–#176)

| ID | verdict | entry (abridged) | key evidence |
|----|---------|------------------|--------------|
| #009 | STAGE | scrollbars on /skills /mcp /plugin Installed lists | occ134 #067 carryover; feature work on OCC menus + ink mouse infra |
| #061 | STAGE | /plugin Errors tab: no confirmation after last error resolved | logic-only confirmation state; churn-only strings |
| #062 | STAGE | /plugin second uninstall/update on repeated Enter | in-flight guard, no string delta |
| #063 | STAGE | held `y` adds marketplace the instant the confirm appears | input-timing guard; frame identical v280≡v281 |
| #064 | PORT 🔒 | `1` answers Yes in /permissions delete/remove-dir confirms while pointer on No | hideIndexes:!0 added at BOTH confirm sites (@229454118/@229490972 regions); hideIndexes 75→80; OCC Select supports the props, both callers pass neither |
| #065 | STAGE | Alt+T & /config offer thinking-off on unsupported models | conditional option-list replacement; no isolatable literal |
| #066 | STAGE | /context total omitted messages since last response | arithmetic/state, no strings |
| #067 | PORT | /model failure shows server message + "model not changed" instead of raw API JSON | mapper A(e,r) @208670862 (vs v280 @204790674); "model not changed" 0→2; OCC validateModel.ts:136 raw passthrough. Binary probe later showed only the authFailed arm is reachable for OCC — see §6.2 |
| #068 | PORT 🔒 | 429 HTML error page: raw markup shown, status lost, 2nd-line break | v281 catch sanitizes via wOr(sanitizeAPIError) + strips `^429(\s+\|$)` @201494858; OCC has sanitizeAPIError (errorUtils.ts:104-127) but the 429 catch never calls it |
| #069/#070 | STAGE | /feedback,/bug,/share send after cancel / after RC Stop | abort-race + state-poisoning logic; no string delta |
| #071 | STAGE | /ide "No available IDEs detected" while listing a running IDE | both message variants in BOTH versions (churn); conditional not isolatable |
| #072 | STAGE | /setup-bedrock,/setup-vertex restart leaves terminal broken | restart/restore logic; no delta |
| #073 | STAGE | /config exits when respectGitignore/copyFullResponse is null | occ134 #037 carryover; sites byte-identical |
| #074 | STAGE | /rename session name disappears during multiple-choice question | render-state logic |
| #075 | STAGE | one-line pastes shown on own line in sent message | placeholder expansion byte-identical modulo churn |
| #076 | STAGE | queued message loses/changes IDE selection | state-capture logic |
| #077 | STAGE | Shift+Tab twice quickly lands on wrong permission mode | key-cycle timing logic |
| #078 | STAGE | Ctrl+C/D twice quits instead of closing remaining dialogs | occ134 #009 carryover (useExitOnCtrlCD per-dialog onExit); v281 widens the dialog list |
| #079 | STAGE | burst-arriving keys act on previous selection | occ134 #012 carryover; opaque input-queueing delta |
| #080 | STAGE | /install-github-app: skip-workflow ignored, double setup, ↑ blocks typed repo | option lists identical; three behavioral guards logic-only |
| #081 | PORT | vim: dj/dk/dG/dgg part-of-line; 1G→last line; d0/c0/y0 no-op | G-op fn @209877832 (`h===0?startOfLastLine():goToLine(h)` + linewise dn) + ht linewise-motion branch @209867921; OCC operators.ts has all v280-gen bugs. `.`-cursor sub-fix STAGE |
| #082 | PORT* | vim: cw at EOL changes next word; Hindi/Bengali classifier; `!`-insert → shell mode | cw fix = zero-width branch of v281 `ht` (landed with #081); classifier defs not isolatable (segmenter `jr` byte-identical) + `!`-guard `ae()` @209890886 not dumped → both STAGE (piece-4) |
| #083 | STAGE | prompt cursor one char too far after accent as own key | dead-key offset logic; no delta |
| #084 | PORT | extra blank line above list item whose text starts on next line | v281 strips leading \n BEFORE the bullet/quoted branch (@~205762774); OCC markdown.ts:197-209 strips only inside the bullet branch (v280 pattern) |
| #085 | PORT | bulleted plain numbers (`- 316.`) rendered as letters/roman/wrong | Jmn normalizer @205766829 (`/^ *(\d{1,9}[.)])/` collapse to text token); generators byte-identical → delta isolated; OCC getListNumber :415-425 has NO domain guards (double bug) |
| #086 | STAGE | agent-panel footer ignores keybindings.json rebinds | delta visible but OCC footer architecture differs (hardcoded hints) → OCC-specific wiring needed |
| #087 | STAGE | footer offers view/stop on the already-viewed agent | guards identified but OCC FleetView has no such footer (0 hits) |
| #088/#089 | STAGE | click leaves keyboard cursor on previous row; Esc interrupts turn instead of deselecting | mouse/key-precedence logic; no delta |
| #090 | NO-OP | PgUp/PgDn do nothing in fullscreen dialog lists | OCC CustomSelect already handles pageUp/pageDown at the state layer (use-multi-select-state.ts:363-368) |
| #091 | NO-OP | /heapdump summary misattributes JS-heap memory as native | v281 delta isolated (@211805276) but OCC /heapdump has no classification line (0 hits) — no counterpart |
| #092 | (B) | bash edit-diff snapshot dirs | counted in cluster B — NO-OP (D's bonus row duplicate) |
| #093 | STAGE | /workflows pointer moves to new run; `x` stops wrong run | list-index pinning logic |
| #094 | PORT | NO_COLOR: selected tab in tabbed dialogs shows no highlight | Ple @209319791/209319823 (`.level===0?"inverse"`), consumed by Settings @228535153; OCC Tabs.tsx:205-206 drops backgroundColor AND suppresses inverse under color level 0 |
| #095 | NO-OP | mouse wheel over /plugin Installed scrolls pane behind | OCC has zero wheel handling; adopt v281 semantics when occ134 #002/#023 plumbing lands |
| #096 | NO-OP | hover highlight lingers after scroll/filter | same basis — no hover subsystem in OCC (0 hits) |
| #097/#098 | STAGE | long list rows wrap to 2nd line (now cut with …); /hooks,/mcp detail overflow | truncate-end 93→114 spread across row renderers; mechanical per-row adoption, no single site |
| #099 | STAGE | skill-state lists not number-answerable in screen-reader mode | digit-dialog infra counts EQUAL v280/v281; call-site swap not isolatable |
| #119 | PORT | large-CLAUDE.md notice also counts instruction files together | t2r @217358179 aggregate line "Instruction files will impact performance: N files, X chars in total > Y" (0 hits v280, 2 v281); OCC doctorContextWarnings.ts:150 per-file only |
| #121/#122 | STAGE | tabbed-dialog ↑/↓ focus routing; ←/→+Tab from inside list | occ134 #062/#063 family; focus-routing rework, no single delta |
| #123 | STAGE | more dialogs get standard frame + Ctrl+C/D cancel on 2nd press | overlaps #078/occ134 #009 per-dialog wiring |
| #124 | STAGE | /workflows,/mcp lists: PgUp/PgDn, Home/End, j/k, mouse, rebinds, `x` stops pointed run | feature-level package; related #009 |
| #125 | STAGE | /plugin details + /remote-control menu: Home/End + row click | needs OCC ink-fork click wiring (occ134 #010 family) |
| #126–#128 | STAGE | background workflow row rendering; /plugin Installed columns; /skills row redesign | rendering reworks; glyphs present in both versions |
| #129/#130 | STAGE | narrow list rows 20-col name; /diff scrollbar + path truncation | truncation/scrollbar families |
| #131–#133 | STAGE | /hooks detail wording; /mcp SR "off" label; RC refocus grace window | logic/wording deltas not isolatable to literals |
| #140 | STAGE | queued messages show above the spinner | REPL restructure (render-site move), not byte-port |
| #143 | NO-OP | hovering list row tints row instead of second ❯ | no hover subsystem in OCC; v281 default `tint` semantics noted for future plumbing |
| #144/#145 | STAGE | /mcp,/workflows row redesigns (icon+name first, narrow-drop rules) | rendering redesigns, no isolatable delta |
| #151–#156 | SKIP | VSCode extension fixes (6) | platform-tagged |
| #157–#162 | SKIP | Claude-Code-on-the-web fixes (6) | platform-tagged |
| #163–#175 | SKIP | Claude Tag / Slack fixes (13) | platform-tagged |
| #176 | SKIP | Code Review force-pushed commit during failed-review retry | platform-tagged |

## 5. The 39 PORTs — landed implementation summary

All byte-verified against the v2.1.281 linux-x64 ELF (offsets in §4).
🔒 = security fix. Test names follow the repo `*281.test.ts` convention.

**Cluster A (13):**
- **#015** `src/utils/messages.ts` — SESSION_ENDED (kH) + COPIED_SESSION (TH)
  placeholder constants (binary-exact text) wired into ensureToolResultPairing
  + synthetic tool_result pairing + resume tolerance list. TH **emitter
  dormant**: OCC has no session-copy feature, so only kH fires (constant
  landed for parity; see §7 flag 10).
- **#018–#021** `src/services/api/claude.ts` + `src/utils/errors.ts` —
  StreamTruncatedError (code "StreamTruncated") / StreamMalformedEventError
  classes + failure-kind classifier; end-of-stream truncation detection
  (clean close inside an open envelope); malformed content-block events
  replace RangeError with integrity-flag partial retention (arrived
  web-search results survive); close-after-complete break (completed-but-
  dropped responses no longer retried into a duplicate empty response);
  conditional stop_reason retention (trailing usage-only frame no longer
  wipes the recorded stop reason).
- **#022/#023** `src/services/api/withRetry.ts` — watchdog cap 6 h
  (TRe parity) + persistent_retry_wait log above 60 s +
  `tengu_api_retry_after_too_long` throw at **Opo=60000** (binary @202407030
  — see §6.1); retry-after floored by exponential backoff (uU parity:
  `Math.max(retryAfterMs, backoff)`); fast-mode short-retry path
  backoff-floored, capped at 20 s (vRe parity), budget-gated, with a visible
  `request_retry` progress event.
- **#031/#032** `src/utils/pdf.ts`, `src/utils/execFileNoThrow.ts`,
  `src/tools/FileReadTool/FileReadTool.ts` — pdftoppm child killed via abort
  signal (120 s timeout kept as ceiling), per-Read abort parent threaded into
  page-range + whole-doc renders, whole-doc render gated off by default
  (tengu_deep_starlight parity kill-switch), abort-family errors fall back,
  render-outcome telemetry {request, render, outcome}.
- **#049 🔒** `src/utils/secureStorage/transientRead.ts` (NEW) +
  `macOsKeychainStorage.ts` + `fallbackStorage.ts` + `src/utils/auth.ts` +
  `src/cli/handlers/auth.ts` — locked keychain (security exit 36) classified
  as TRANSIENT read failure → credential write SKIPPED entirely
  (read_failed_skip_write parity; never clobbers the shared blob / drops
  mcpOAuth), platform-specific "Couldn't save your login…" throw
  (binary-exact macOS vs other wording).
- **#050** `src/utils/processTreeKill.ts` (NEW) + `src/utils/auth.ts` —
  aws/gcp auth-refresh children wrapped in a `ta`-parity watchdog:
  descendants-first process-TREE kill on timeout (3 min) / abort /
  process-exit shutdown hook; silent on abort/shutdown, red message on
  timeout; no more orphaned helpers holding the localhost callback port.
- **#103** `src/utils/errors.ts` — `isNonRetryableClientError(status)`
  (4xx minus 408/409/429, byte-identical predicate) wired as
  `skipRetry` into `src/services/remoteManagedSettings/index.ts` +
  `src/services/policyLimits/index.ts` classify-error default branches;
  never-succeeding 400/422 no longer retry-loop to the 30 s deadlock.
- **#137 🔒** `src/tools/BashTool/bashPermissions.ts` +
  `src/utils/permissions/denialTracking.ts` — dangerous-rm prompt gets the
  2-min auto-deny window (enabled/showDialog/timeoutMs=120000/
  maxDialogTimeouts=3 + bounds 5000/3600000/100 parity), session counters
  (unanswered-this-session, capped state), byte-exact deny message with the
  do-not-work-around rewrite hint, `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`
  kill-switch, auto-mode denial variant.

**Cluster B (11):**
- **#005** `src/utils/settings/types.ts` + `src/utils/attribution.ts` —
  attribution input widened to union(bool|object) with the official PARSE-TIME
  normalization `union.transform(c=>typeof c!=="boolean"?c:(c?{}:{commit:"",
  pr:"",sessionUrl:!1})).pipe(objectSchema).optional()` (byte-verified v281
  chain — `false`→hide-all object, `true`→`{}`); hoisted
  `AttributionObjectSchema` shared by the union branch and the pipe target;
  union error callback + invalid_union flattening for path `attribution`
  (readable single-issue settings errors). Consumers keep the pre-281 object
  guards because they only ever see parsed settings: the session-URL guard
  stays `attribution?.sessionUrl === false` (v281-exact) and the PR getter was
  aligned to the v281 `fLn` shape `attribution?.pr !== undefined` (NOT
  truthiness — the normalized `pr:""` must hide the attribution; the truthy
  check would leak the enhanced default when `includeCoAuthoredBy:true`).
  15 UT (parse-normalization, error messages, flattener, consumer hide-all
  driven through real schema output) + pre-existing fconfig e2e guard
  assertion stays green.
- **#028** `src/utils/cwdTurnRecovery.ts` (NEW) + headless turn wrappers —
  CwdDeletedError caught at turn entry: cwd re-pinned, `[headless] working
  directory … no longer exists; the turn starts pinned to it` warn,
  once-per-session user-visible warning (binary-exact), tengu_shell_set_cwd
  {success:false, missing_at_turn:true} telemetry.
- **#033 🔒** `src/utils/macosKernelPaths.ts` (NEW) + file tools /
  attachment path checks — darwin-gated rejection of `/net`, `/Network`,
  `/.vol`, `/.file`, `/.nofollow`, `/.resolve` kernel-resolved prefixes
  BEFORE approval (network-mount trigger defense), official deny sentence.
- **#034 + #110 🔒** `src/tools/BashTool/destructiveCommandWarning.ts` —
  full v281 `x$()` analyzer (OCC lagged both v280 and v281): 5 arms —
  wholeSubstitution (`rm -rf "$(…)"` now prompts; kill-switch
  `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` added to the managed-env
  allowlist), emptyExpansion (`${VAR:-}`-style), literalTarget,
  backslash-only (`/^\\+$/` Git-Bash drive root), var+top-level-dir
  (pvo-regex parity, bright_lake gate parity), cwd-derived env set
  (HOME/USERPROFILE/PWD/OLDPWD/TMPDIR/TMP/TEMP). NOTE: ~line 362 carries a
  LOAD-BEARING `biome-ignore` (§7 flag 7).
- **#039** `src/tools/shared/spawnMultiAgent.ts` — `--setting-sources`
  (+ `--restricted`) propagated to spawned teammates via
  buildPropagatedFlags.
- **#040 🔒** `src/utils/nullByteValidation.ts` (NEW) +
  `src/utils/backfillObservableInput.ts` (NEW) + `src/query.ts` + the four
  file tools — NUL byte in a file-tool path fails THAT tool call with the
  binary-exact `… cannot contain null bytes (\0). Remove the null byte and
  try again.` (errorCode 2 parity) instead of ending the whole turn; the
  query-loop backfill call is guarded (logs `backfillObservableInput met a
  path …` and skips). Glob/Grep's existing validator untouched.
- **#041** `src/tools/FileWriteTool.ts` — v281 alias table
  (file_path←path/file; content←file_text/file_content/new_text/body/text/
  contents) + repeated-identical-value dedup loop (`repeated_${alias}`
  shapeClass, "`X` repeated `Y` and was ignored." note) — duplicate-identical
  calls now succeed.
- **#109 🔒** auto-mode denial guidance
  (`src/utils/permissions/denialTracking.ts` + autoMode denial assembly) —
  the full mnn+gnn+lKe outcome-scope message (binary-exact @200520375)
  appended to auto-mode denials: same outcome via another tool /
  interpreter / host / encoding / sub-agent / later turn is denied too;
  batch re-run-without-flagged-items clause; first-hand-read clearance
  clause. `${lt}`/`${zr}` = **"Read"/"Grep"** (§6.3); injection is
  unconditional per denial (§6.3).
- **#111** `src/tools/BashTool/prompt.ts` — macOS EPERM local-port-binding
  sandbox guidance naming `sandbox.network.allowLocalBinding: true`
  (both official variants: sandbox-block arm + EPERM arm; "applies without a
  restart"; settings-change-is-the-user's-decision framing).
- **#112** `src/main.tsx` — `--agents <json-or-file>` (byte-copied help):
  shape-sniff inline JSON vs file path; file path gated to --print/SDK with
  the exact error text; read guards — dev/ino TOCTOU re-check
  ("file changed while it was read"), not-found ("a value that is not a JSON
  object is read as a file path"), size cap, hard-link (nlink>1) rejection;
  empty `prompt` allowed; `Invalid --agents configuration` + `(read from …)`
  suffix rendering.

**Cluster C (6):**
- **#052** `src/utils/hooks/execMcpToolHook.ts` + `src/QueryEngine.ts` —
  mcp_tool hooks on BLOCKING events wait for a still-connecting server:
  poll 50 ms (NIt), budget = min(hook timeout, MCP_TIMEOUT clamped to
  2147483647 else 30 s — Rl parity), reconnectAttempt pulls the deadline to
  ≤5 s more (Ago), 19-member NON_BLOCKING_HOOK_EVENTS set (TTt byte-verified,
  0 v280 hits), binary-exact wait/skip/never-tracked warnings, abort breaks
  the wait. **Wired this round** (was the round's last dormant PORT):
  QueryEngine's constructor registers a closed-guarded LIVE accessor reading
  `config.getAppState().mcp.clients` (covers REPL + headless), and close()
  restores the previous registration only if it still owns the current one
  (stack semantics — subagent engine takeover/restore; a restored-but-closed
  engine's getter yields no context, so a dead engine never serves live
  state). Official counterpart: liveClients registry @96655146.
- **#059** `src/utils/plugins/validatePlugin.ts` — 13-key
  LISTING_METADATA_MANIFEST_FIELDS allowlist suppression (icon, screenshots,
  classification, privacyPolicyUrl, privacy_policy, privacyPolicy,
  supportUrl, support, bugs, termsOfServiceUrl, terms_of_service,
  documentationUrl, docs) filtered out of the zod .strict()
  unrecognized_keys reporting — allowlist suppression, not schema fields
  (faithful minimal port).
- **#060** `src/utils/plugins/marketplaceManager.ts` — the KEEP-on-failure
  git branch returns a kept-stale marker; refreshMarketplace /
  refreshAllMarketplaces skip the `lastUpdated` stamp + success log when the
  remote was unreachable.
- **#120** `src/utils/managedEnv.ts` — one-time-per-key warn naming the
  ignored settings `env` vars + their source (binary-exact message with the
  it/them plural switch), fired only in CCD/runner mode (ccdSpawnEnvKeys
  non-null), otelDominanceDropWarned-style dedupe.
- **#147** `src/services/mcp/mcpAppUiResources.ts` (NEW detector: `ui://`
  case-insensitive prefix OR text/html with a `profile=mcp-app` mime param —
  parsed, not string-matched) applied at the three list surfaces
  (`ListMcpResourcesTool.ts`, `services/mcp/client.ts`
  fetchResourcesForClient, `unifiedSuggestions.ts`) with the official
  "MCP Apps UI resource(s) left out … can still read them by URI" log;
  read-by-URI path untouched (SEP-1865 guarantee).
- **#150** `src/commands/agents/index.ts` — `isHidden: true`; /help + the
  command menu drop it, exact-name `/agents` still resolves and explains
  (HelpV2/commandSuggestions plumbing verified).

**Cluster D (9):**
- **#064 🔒** `src/components/permissions/rules/RemoveWorkspaceDirectory.tsx`
  + `PermissionRuleList.tsx` — both destructive confirms get `hideIndexes` +
  `initialValue="no"`: a held `1` can no longer confirm a destructive action,
  and the dialog opens on No.
- **#067** `src/utils/model/validateModel.ts` — /model failure shows the
  humanized server message (trailing `[.!?…]+` stripped) + ` · model not
  changed` instead of raw API JSON; **authFailed-only** reachable branch per
  binary (§6.2); permissionDenied arm STAGE (§7 flag 9).
- **#068 🔒** `src/services/api/errors.ts` — the 429 catch runs
  sanitizeAPIError; when sanitized ≠ raw, the redundant `^429(\s+|$)` prefix
  is stripped and the sanitized text used as detail; overage line keeps the
  `API Error: Request rejected (429)` + ` · detail` format; trailing-newline
  server text no longer breaks to a second line (trimEnd).
- **#081/#082** `src/vim/operators.ts` + `src/vim/motions.ts` +
  `src/hooks/useVimInput.ts` — G/gg count convention fixed (`1G` → line 1;
  no-count/`0` → last line via startOfLastLine), linewise operator spans
  (dj/dk/dG/dgg take whole lines), zero-width branch (d0/c0/y0 act: yank
  sets empty register, change enters insert; cw at EOL changes only to EOL),
  count-linewise `3dd` rewritten to line-index spans. STAGE remainder:
  `.`-replay cursor off-by-one, Hindi/Bengali word classifier, visualChange
  `!`-prefix guard (piece-4, TODO at the replay site).
- **#084/#085** `src/utils/markdown.ts` — Jmn-parity numeric list-item
  normalizer (bare-number items collapse to a text token, never hitting
  letter/roman conversion; immutable every-check guard), numberToLetter/
  numberToRoman domain guards (first ≥ 1; roman ≤ 3999), leading-`\n` strip
  moved BEFORE the bullet/quoted branch so the plain return path (long/
  quoted lists) also loses the extra blank line. Adapted to OCC's older-gen
  serializer (not byte-copied, per triage note).
- **#094** `src/components/design-system/Tabs.tsx` + `src/ink/colorize.ts` —
  color-level-0 fallback to `inverse` for the selected-tab highlight
  (Ple parity), so NO_COLOR terminals still show the cursor.
- **#119** `src/utils/doctorContextWarnings.ts` — aggregate instruction-file
  notice: when the combined size of all instruction files (CLAUDE.md +
  @-imports) crosses the aggregate limit, emit
  "Instruction files will impact performance: N files, X chars in total > Y"
  (upstream wording adopted) before the existing per-file warnings; per-file
  lines unchanged.

## 6. Binary-vs-triage contradictions (binary wins — skill mandate)

The aligning-with-official-binary skill's core lesson re-proven three times
this round: the ELF is the source of truth, triage prose is a draft.

1. **Opo = 60000, not 600000.** Triage A §P4 transcribed the v281 retry
   constant block (@202407124) as `Opo=600000` (10 min). A direct byte probe
   at @202407030 shows **`Opo=60000`** (60 s): the
   `tengu_api_retry_after_too_long` throw fires when a non-watchdog retry
   delay exceeds 60 s. Implementation follows the binary.
2. **#067 is authFailed-only.** The triage row described a full mapper
   rewrite (retryable classification on every failure arm). Byte probes
   showed the only arm reachable from OCC's validateModel call site in v281
   is **authFailed** (`authFailed:!0,retryable:!0`); the generic-status arms
   sit behind surfaces OCC doesn't have. Landed authFailed-only; the
   permissionDenied branch is STAGE (flag 9).
3. **#109 `${lt}`/`${zr}` resolved; cadence claim disproved.** Triage B left
   the two example-tool constants unresolved (`lt=Lg` @200252743, cross-module
   chain) and described a 2-min (cKe=120000) repeat-injection window. Runtime
   extraction + proof chains resolved **`${lt}`="Read", `${zr}`="Grep"**, and
   the v281 injection is **unconditional on every denial** (the 120000
   constant gates a different telemetry path). Implementation follows the
   binary: message injected on each auto-mode denial, naming Read/Grep
   verbatim.

## 7. Ledger flags (hazards + deferred bits, for future rounds)

1. **Opo=60000** — see §6.1; the withRetry.ts constants block matches the
   ELF, not the triage draft.
2. **#067 authFailed-only** — see §6.2.
3. **#052 wiring DONE this round** — QueryEngine ctor/close registration with
   closed-guard + ownership-checked stack restore; the hook layer's live
   accessor is no longer dormant. Any future engine-like owner of MCP client
   state must follow the same register/restore protocol
   (`getMcpHookClientContextGetter` identity check before restore).
4. **#109 Read/Grep resolved + unconditional injection** — see §6.3.
5. **#082 piece-4 STAGE** — visualChange dot-replay `!`-prefix/shell-mode
   guard (`ae()` @209890886) not dumped within budget; TODO marks the site in
   `src/vim/operators.ts`. Re-extract from the v281 vim chunk next round.
6. **mock.module global pollution** — `test/utils/plugins/
   pluginUrlRedaction275.test.ts` and C1's connect-wait test use
   process-global `mock.module`, which leaks across bun test files. The #052
   wiring test therefore lives in its own mock-free file
   (`test/engine/mcpHookClientContextWiring281.test.ts`). Keep new
   QueryEngine-level tests mock-free or isolate them per-file.
7. **biome useRegexLiterals autofix hazard** —
   `src/tools/BashTool/destructiveCommandWarning.ts` (~:362) contains a
   `new RegExp` built from a string with a bare `/` that biome's autofix
   mangles into an invalid regex literal; the `biome-ignore` there is
   LOAD-BEARING — do not remove, do not run lint:fix blind on this file.
8. **`bun test` prerequisite** — `dist/cli.js` must exist before running the
   suite (test/launcher.test.ts process.exit(1)s otherwise). `bun run build`
   first on a fresh checkout.
9. **#067 permissionDenied branch STAGE** — v281 mapper arm behind surfaces
   OCC lacks; revisit if /model grows the permission-denied path.
10. **TH emitter deferred** — the COPIED_SESSION (TH) placeholder constant is
    landed but never emitted: OCC has no session-copy/fork feature. Wire the
    emitter if/when session copy lands (#015 family).
11. **Thread noise** — during this round ~10 implementation subagents posted
    their own per-cluster reports to the OCC-96 issue thread. Those are
    implementation reports; the coordinator's handoff comment is the
    authoritative summary.

## 8. Test + verification summary

- **New/updated tests this round** (cluster verification runs; `*281.test.ts`
  naming + surrounding suites): C1 mcp-hook connect-wait 49 · C2 plugin 25
  (+dir 214) · D1 api stream/retry 63 · D2 filetools+pdf 70 · D3 vim 10 ·
  D4 markdown/tabs/doctor 17 · #015 messages 13 · #031/#032 pdf 11 ·
  #049/#050 secureStorage+processTreeKill 38 · #034/#110
  destructiveCommandWarning 100 · #103 errors 18 · #137/#109 denials 101 ·
  #040/#033/#041/#028 filetools 64 · #005/#039/#111/#112 misc 50 ·
  A1/A2 stream+claude.ts 7+16 · #052 wiring 5 — ≈ **650+** tests
  added/touched across the 39 PORTs.
- Combined-tree `bun run build` green: `dist/cli.js` 29.39 MB
  (30,816,728 B), MACRO VERSION 2.1.351, BINARY_NAME occ.
- Full `bun test` + Docker e2e + tmux REPL acceptance vs the official
  2.1.281 linux-x64 ELF (`uvx claude-code@2.1.281` proved unresolvable on
  PyPI, so the extracted official ELF — which prints
  `2.1.281 (Claude Code)` — served as ground truth per the
  aligning-with-official-binary skill). **Final acceptance results:**

### 8a. Host full suite — 0 regressions vs baseline

- Current tree (all 131 changed files): **6168 pass / 12 skip / 169 fail**
  (6349 tests, 641 files, 1161.75s).
- Baseline worktree (HEAD `62252aa`, merge of release/2.1.351):
  **225 fail** (598 files) under the same runner/env.
- Per-file census (python header parse over both logs): **0 files worse
  than baseline, 17 files improved** — gate "current failures ⊆ baseline"
  satisfied. Host e2e subset: base 7 fails/6 files → current 6/5
  (`commands-behavior` improved; `repl-interactive`,
  `ultracode-origin-210`, `screen-reader`, `plan-approval`×2 unchanged —
  all pre-existing environmental).

### 8b. Docker e2e (`bash test/e2e/run.sh`, ubuntu 24.04 + bun 1.3.14)

- Current image: **650 pass / 1 skip / 66 fail / 11 errors** (717 tests,
  150 files, 956.98s). Baseline image (built from the baseline worktree):
  **identical summary** (650/1/66/11, 990.48s).
- Failure-name sets (`✗` lines, ANSI-stripped, sort -u): **60 unique names
  on each side; `comm -13` and `comm -23` both empty — sets IDENTICAL**.
  All container failures are pre-existing environmental: 11 module-
  resolution errors (`test/e2e` is mounted at `/test/e2e` OUTSIDE `/occ`,
  so tests importing `../../src/…`/`react` cannot resolve — structural,
  present on both trees), tmux "no server running" clusters, real-coding
  live-model fails, keybinding/plan-approval/trust-gate/image-paste tmux
  fails.
- **Container sync-hang flake (pre-existing):** the first non-TTY run on
  the CURRENT tree hung after
  `version-2.1.261-keybinding-flavor-deprecated` + "killed 1 dangling
  process" — bun busy-spins at 55–90% CPU with no child processes (event
  loop blocked ⇒ bun test timeouts can't fire). The BASELINE first attempt
  hung at the IDENTICAL log point ⇒ environmental flake, not a regression.
  Both trees completed on `docker run -t` (TTY) retry.

### 8c. CLI parity vs official 2.1.281 ELF

- Unknown flag: `error: unknown option '--definitely-not-a-flag'` —
  byte-identical, exit 1 both.
- Missing arg: `error: option '--model <model>' argument missing` —
  byte-identical, exit 1 both.
- `--version` differs by design: OCC prints `2.1.351`, official prints
  `2.1.281 (Claude Code)` (documented branding divergence).
- Live `-p` round-trip (dashscope base URL): identical output including
  the `[claude-code:unrecognized_model]
  {"model":"glm-5.2","query_source":"sdk"}` stderr warning and PONG/exit 0.

### 8d. tmux REPL acceptance (live model, qwen3.8-max)

- **OCC (`bun dist/cli.js`)**: full welcome box (OCC v2.1.351, model ·
  API Usage Billing, tips panel, dual-auth warning, bypass indicator),
  PONG round-trip through the real agent loop, Shift+Tab cycles
  bypass → auto → manual → accept-edits → plan, `/status` renders
  Status/Config/Usage tabs with Version 2.1.351 / Session ID / cwd / auth
  sources / base URL / Model / Auto-mode server.
- **Official 2.1.281**: boots with the v2.1.281 banner + changelog notice
  ("Got 63 features, 354 bugfixes…"), same dual-auth warning, same bypass
  indicator (`⏵⏵ bypass permissions on (shift+tab to cycle)`), PONG
  round-trip with Thought/Brewed flourishes, Shift+Tab cycles the same
  mode order (auto → manual → accept-edits → plan after bypass),
  `/status` shows the same core fields.
- **Divergences noted (all by design / already-staged):** version
  branding; official-only `/status` rows — `Session kind` (staged since
  OCC-44, needs attacher-state resolution), `Peer address` (official uds
  peer), `Managed settings (remote)` / `Organization policy` (not fetched
  with a custom ANTHROPIC_BASE_URL on both sides), `System diagnostics`
  (official native-install PATH checks — N/A to OCC's npm distribution);
  official-only `← for agents` hint and changelog notice; official turn
  flourishes ("Thought for 3s" / "✻ Brewed for 3s") vs OCC's status verbs.
- REPL acceptance scratch HOMEs + tmux socket cleaned up after the run;
  official ELF removed from /tmp after all binary verification completed
  (skill mandate).

## 9. STAGE backlog — next-round candidates (highest value first)

1. **#007** plugin `.mcp.json` validation subsystem (🔒-adjacent: insecure
   URL + literal-credential header detection) — needs dedicated per-predicate
   decompilation.
2. **#036/#037** sandbox `excludedCommands` matching fixes +
   `CLAUDE_CODE_TMPDIR` writable-path honoring.
3. **#006** MCP URL-mode elicitation protocol split (2026-07-28 protocol).
4. **#012/#013/#105/#106** resume-pipeline family (history normalization,
   large-session restore, file-cache seeding, compacted-session perf).
5. **#017** prompt-cache invalidation analyzer (wouldInvalidateCache) +
   #108 classifier hydration store.
6. **#053–#058** plugin/MCP config-logic family (URL dedup, channels name
   match, folder-of-plugins, uninstall/update scope resolution).
7. **#078/#123** dialog Ctrl+C/D onExit wiring (occ134 #009 carryover; v281
   dialog list is the completion checklist).
8. **#097/#129/#144/#145** row-truncation/rendering family (mechanical,
   distributed across row renderers).
9. **#082 remainder** vim Hindi/Bengali classifier + `!`-guard + `.`-cursor
   off-by-one (piece-4).
10. **#134** BashTool send-now backgrounding subsystem (deep, multi-round).
