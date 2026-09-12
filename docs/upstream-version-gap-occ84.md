# Upstream Version Gap — OCC-84 (2.1.268 → 2.1.269 alignment)

**Round:** OCC-84, 2026-09-13
**OCC entering state:** `2.1.331` (npm `@cnwenf/occ`; fully aligned through official **2.1.268** per the OCC-83 + OCC-122 rounds, `docs/upstream-version-gap-occ122.md`; main HEAD `755ba7d`).
**Official target this round:** `2.1.269` (official latest at trigger time; stable channel at 2.1.236).

> **Concurrent-round dedup note (added at merge time).** While this round was
> running, the OCC-123 round independently triaged the same official `2.1.269`
> release and merged + released **2.1.332** first (PR #361, main `7a7b22d`),
> landing 8 of this round's 17 port IDs: **E05, E06, E07, E15, E29, E39, E40,
> E43**. Per first-merged-wins, OCC-123's released implementations of those 8
> IDs are the shipped code; this round's own implementations of them were
> dropped during dedup (zero file collisions — the two rounds touched disjoint
> files for the 9 remaining IDs). This round therefore ships, as release
> **2.1.333**, the 9 unique IDs: **E14, E23, E25, E27, E35, E42, E44, E51,
> E52**. In the §2 table and §4 details below, rows marked *PORTED (via
> OCC-123)* record this round's independent byte-verification and port of that
> ID — the forensic record stands, but the shipped implementation is the
> 2.1.332 one (`docs/upstream-version-gap-occ123.md`).

## 1. Official latest — three-way verification

| Source | Result |
|---|---|
| npm registry | `@anthropic-ai/claude-code@2.1.269` published; linux-x64 platform package packed fresh |
| GitHub | `v2.1.269` release present (`gh api repos/anthropics/claude-code/releases`); changelog = 98 entries |
| Fresh ELFs | official linux-x64 2.1.268 → `/tmp/occ84/x268/package/claude` (sha256 `9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653`), 2.1.269 → `/tmp/occ84/x269/package/claude` (sha256 `25e44883f54419569a3d739f38cbbdaebe83b09895da0f343e1b003710a4775b`). Strings dumps `s268.txt`/`s269.txt` (`strings -n 8 | sort -u`), main JS blobs `js268.txt`/`js269.txt` (~5.9 MB each), line-level diffs `added.txt` (17,798) / `removed.txt` (16,836) |

Verification method (carried from prior rounds): every LANDED port below was byte-verified via python slicing on the raw ELF / JS blobs (never plain grep of megabyte lines, never guessed, never taken from a subagent summary — the lead re-verified all security-critical snippets: E14 `Ki`/`Zr` compiler, E29 `deniedByPermissionRule`, E43 `tee` machinery, E42 `swo`/`w$` sweep).

## 2. The 2.1.269 changelog — 98 entries, per-item verdicts

| # | Item (abridged) | Verdict | Evidence / rationale |
|---|---|---|---|
| E01 | `claude plugin eval` subsystem | **Staged** | Plugin-eval harness (JSON+HTML reports, scoring) — feature-sized subsystem; plugin surface trimmed in OCC beyond install/run. |
| E02 | `/output-style [name]` command | **Staged** | Command *definition* recovered from lazy chunk (`{type:"local",name:"output-style",supportsNonInteractive:!0,description:"List output styles or switch to one",argumentHint:"[style]"}`) but the body lives in a lazily-loaded chunk not byte-recoverable this round without a dedicated decompile; never-invent → staged. |
| E03 | Bash-edit diff in tool result (`bashEditDiffEnabled`) | **Staged** | Gate fn recovered; feature requires the full diff-rendering path — feature-sized, staged. |
| E04 | `OTEL_METRICS_INCLUDE_REPOSITORY` | **NO-OP** | OCC ships empty analytics/telemetry by design. |
| E05 | `CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS` (default 3000) | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E06 | `/focus` spinner tip | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E07 | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256) | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E08 | Prompt cache partially invalidated after output-limit resume | **Staged** | Cache-key/resume interaction inside the turn-retry machinery; no recoverable marker without a dedicated round. |
| E09 | Resume after mid-thought interrupt re-sends earlier context differently | **Staged** | Same machinery family as E08; staged together. |
| E10 | F1/F2/F4 kitty, Delete in st, Alt+arrows rxvt, Shift+punct WezTerm (regression in 2.1.247) | **NO-OP** | OCC's parse-keypress port never inherited the official 2.1.247 regression — OCC's key table verified against pre-regression official behavior. |
| E11 | `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING=0` (remote/headless "waiting for your input") | **NO-OP** | Remote/headless session surface trimmed. |
| E12 | Terminal capability replies (`^[[?1;2c`) as stray startup text | **NO-OP** | OCC already consumes DA1 via `DA1_RE` in its startup querier (`src/ink/terminal-querier.ts`) — the reply never reaches the prompt. |
| E13 | Fullscreen rows blank at top/bottom after resize | **Staged** | Ink resize/repaint fix; interlocked with the E45–E48 alt-screen rework — staged as a family. |
| E14 | `!`-prefixed deny/ask rule scoped to its own settings source; bare `!` ignored | **PORTED** | §4 (security). |
| E15 | Post-compaction git status is fresh, not session-start memoized | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E16 | Synced plugin MCP servers on remote-session resume | **NO-OP** | Cloud/remote sessions + synced skills trimmed. |
| E17 | Resumed headless sessions losing replies on mid-turn model switch/retry | **Staged** | Headless resume turn-replay machinery; no recoverable marker this round. |
| E18 | Background-task on-disk record escapes/line breaks/oversized text reaching task list & notifications | **Staged** | Fix site inside the task-record sanitizer; needs its own decompile round. |
| E19 | CMYK JPEG attach failure | **NO-OP** | OCC's image pipeline uses sharp/libvips which converts CMYK natively — immune. |
| E20 | Managed-settings dialog not naming gRPC collector without scheme | **NO-OP** | Telemetry surface trimmed. |
| E21 | Plugin `headersHelper` consent URL path misread | **NO-OP** | Plugin headersHelper surface trimmed. |
| E22 | Plugin errors `[redacted URL]` for relative Windows `@`-folder path | **NO-OP** | Windows-only + plugin surface trimmed. |
| E23 | Missing native cursor in dialog text fields | **PORTED** | §4. |
| E24 | `/fork` receipt repeated clicks not backgrounding right away | **NO-OP** | OCC has no `/fork` receipt UI. |
| E25 | LSP `exit` sent even if `shutdown` fails | **PORTED** | §4. |
| E26 | Attribution reminder overriding CLAUDE.md no-attribution rule | **NO-OP** | OCC's attribution reminder path verified already honoring memory/CLAUDE.md rules (official fix aligns precedence that OCC never diverged on). |
| E27 | Prompt suggestions dropped for Japanese/Chinese/Thai (no spaces) | **PORTED** | §4. |
| E28 | Synchronized output assumed from terminal name (GNOME Terminal/Konsole) | **Staged** | Official replaces the static `isSynchronizedOutputSupported` with a capability-probe framework — subsystem-sized; interlocked with the E53 kitty-probe family. |
| E29 | `permission_denials` in stream-json omitting Read/Edit/Write path-deny blocks | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E30 | SDK/Desktop sessions showing unknown status in agent list | **NO-OP** | SDK/Desktop surface trimmed. |
| E31 | `/insights` failing on Bedrock/Vertex/Foundry/gateway without Opus access | **Staged** | Session-model fallback fix not byte-recoverable from the strings diff (no new marker). |
| E32 | Org policy limits not loading when another process refreshed login concurrently | **Staged** | policyLimits read/refresh race; fix inside the auth-refresh locking, needs a dedicated round. |
| E33 | Claude Desktop contextual turn-end notification text | **NO-OP** | Claude Desktop surface trimmed. |
| E34 | MCP reconnect when only URL query-param order changed | **Staged** | Canonicalization-before-hashing fix in the MCP config hasher (OCC site: `src/services/mcp/utils.ts` `hashMcpConfig()`); official fix site not byte-recoverable this round (no marker) → staged rather than guessed. |
| E35 | Prompt-box top border splitting on wide/multiline background-agent names | **PORTED** | §4. |
| E36 | "Prompt is too long" permanent stuck when auto-compaction has nothing complete to summarize | **Staged** | Reactive-compaction machinery still stubbed in OCC (tracked since OCC-93 item 20). |
| E37 | `/goal` stalling after API errors/network drops/token limits | **Staged** | Retry-with-backoff + pause-with-reason machinery inside the goal runner; feature-sized. |
| E38 | Cloud-session prompt-cache misses (wait for server config) | **NO-OP** | Cloud sessions trimmed. |
| E39 | `/btw` answers with made-up tool calls/output | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E40 | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` staleness caps (6h + `*_MAX_AGE_MS`) | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E41 | Org plugins via managed settings not loading in headless/Desktop | **Staged** | Managed-settings plugin load path; plugin surface partially trimmed — needs scoping before porting. |
| E42 | Plugin zip extraction: other-user readable, world-writable bits, stale files surviving | **PORTED** | §4 (security). |
| E43 | `tee` destinations escaping `Edit()` deny rules / write-path check | **PORTED (via OCC-123)** | §4 — shipped in release 2.1.332 (OCC-123 merged first); this round’s independent port dropped at dedup. |
| E44 | Stray `22c` / color-reply characters typed into prompt over slow connections | **PORTED** | §4. |
| E45–E48 | rxvt block cursor after fullscreen re-entry; cursor after external editor; double-draw after Ctrl+G; Konsole double-draw | **Staged** | Four interlocked fixes inside the official ink alt-screen/cursor lifecycle rework (same code family as E13/E23's exit path); porting partially would risk regressing E23's cleanly-ported enter/exit sequence — staged as a family for a dedicated ink round. |
| E49 | Windows: backgrounded PowerShell tool commands stop on exit | **NO-OP** | Windows-only. |
| E50 | `/diff` panel opens fully rendered in one step | **Staged** | Render-pipeline change in the diff panel; no recoverable marker. |
| E51 | Prompt-suggestion filtering for CJK: mixed-script/single-word kept, meta text dropped | **PORTED** | §4 (merged with E27). |
| E52 | Skill "Unknown skill" names plugin skill's full name on unique bare-name match | **PORTED** | §4. |
| E53 | Kitty-keyboard-query probe for SSH/unrecognized terminals (foot, Alacritty 0.16+) | **Staged** | Probe subsystem; OCC has the primitives in `src/ink/terminal-querier.ts` but the full query/timeout/fallback state machine needs a dedicated round (family: E28). |
| E54 | Transcript updates no longer re-process whole conversation for collapsed tool-use summaries | **Staged** | Perf rework of the summary cache; no marker. |
| E55 | `alwaysLoad` MCP server usable next turn without tool-search round trip (telemetry-disabled first-party) | **Staged** | Tool-search wiring change; needs dedicated round. |
| E56 | `/ultrareview --post` posts PR comment directly | **NO-OP** | OCC has no `--post` path. |
| E57 | Artifact DB reads into scratchpad skip working-folder approval | **NO-OP** | OCC's ReviewArtifactTool is a stub; no artifact DB. |
| E58 | Synced claude.ai skills named `anthropic-skills:<name>` | **NO-OP** | Synced skills trimmed. |
| E59–E98 | [VSCode] / [web] / [Claude Tag] entries (40 items) | **NO-OP** | All three surfaces trimmed from OCC by design. |

**Round verdict: 17 fix IDs LANDED (E05, E06, E07, E14, E15, E23, E25, E27, E29, E35, E39, E40, E42, E43, E44, E51, E52); 23 STAGED with per-site rationale; 58 NO-OP (trimmed surfaces / already-correct / immune).**

**Post-dedup ship verdict: 9 IDs shipped in release 2.1.333 by this round (E14, E23, E25, E27, E35, E42, E44, E51, E52); 8 IDs (E05, E06, E07, E15, E29, E39, E40, E43) shipped in release 2.1.332 by the concurrent OCC-123 round — this round's ports of those 8 were dropped at dedup (first-merged-wins), their §4 forensic records retained.**

## 3. Auto NO-OP categories (OCC design trims)

Empty analytics/telemetry (E04, E20), no statsig (gates take official default values — E40's flag branch drops to the 6h default), no cloud/remote sessions (E11, E16, E38), no Claude Desktop (E30, E33), no VSCode extension / web / Claude Tag (E59–E98), trimmed plugin surface (E01, E21, E22, E41-scope), bundled workflows ship empty (n/a this round), Windows-only (E22, E49).

## 4. LANDED — byte-verified ports (17 IDs)

All ports carry `// Official 2.1.269 (E…): …` comments citing offsets. Every official snippet was re-verified by the implementer against `/tmp/occ84/` evidence before porting (python byte slicing), per the never-invent rule.

### E14 — `!`-prefixed deny/ask permission rules scoped to their own settings source (security)
- **Official:** `Ki` normalizer (bare-`!` → note "a negation of every path"; `!` on deny = negation → drop rule; `!` on allow = literal path; `Zo("permission_rules", …, "dropping it"/"matching the literal path it spells")` debug) + `Zr` compiler restructuring the per-root cache to `{patternMap, matchers:[{source, patternMap, getIg()}]}` — allow rules share the `null`-source matcher, each deny/ask rule gets a matcher keyed by its own settings source, `patternMap.delete(P)` before set (later deny wins within a matcher), per-matcher lazy `ignore()` instance with recompile cap `rh=1e4`. ELF offsets: `Ko` @184003751, `Zo` @184004524, `Wne` @181040444, `Xn` @184123267.
- **OCC:** `src/utils/permissions/filesystem.ts` restructured from single mixed-source `CachedMatcherEntry` to per-source matchers; `normalizeIgnorePattern` gains the `Ki` guard; match walk iterates per-source matchers so `!` can only negate same-source patterns. Companion updates in `src/utils/permissions/permissions.ts`, `src/utils/permissions/symlinkEquivalences.ts`.
- **Tests:** `src/utils/permissions/__tests__/bangNegationScoping269.test.ts` + full permissions dir → **163 pass / 1 skip / 0 fail**. 4 deviations documented in-code (OCC naming/structure adapters).

### E29 — stream-json `permission_denials` include path-deny-blocked Read/Edit/Write

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** validateInput deny returns gain `deniedByPermissionRule:!0` (Read `errorCode:1`, Edit/Write `errorCode:13` and Write ask-variant `errorCode:2`); executor clones observable input (`backfillObservableInput?.($n)`) and calls `onPermissionDenial(tool, toolUseId, input)` feeding the same denials collection as canUseTool denials. js269 @3338801 / @1813006 / @5105184 / @3949787; s269 @3428409; `deniedByPermissionRule` 0 hits in s268 → 7 in s269.
- **OCC:** 7 files — `src/Tool.ts` (type + `onPermissionDenial` callback), FileRead/Edit/Write validateInput deny returns (5 sites), `src/services/tools/toolExecution.ts` (clone → backfill → callback), `src/QueryEngine.ts` (`recordPermissionDenial`, dedupe by tool_use_id, two contexts wired), `src/utils/forkedAgent.ts` (subagent inherits / fork clears).
- **Tests:** 4 new files / 12 cases; scoped suites → **47 pass / 0 fail**.

### E43 — Bash `tee` destinations join write-path validation (security)

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official deltas (all byte-verified 268↔269):** op map gains `tee:"write"` (`Z2`); extractor `tee:(e)=>EHo(py(e))` with `vHo=new Set(["/dev/null","/dev/stdout","/dev/stderr","/dev/tty"])` filtered out; basename normalizer `jU` extended (`LHo=new Set(["rm","rmdir","tee"])` + Windows `.exe` case-insensitive branch); `tee` with no path args → `{behavior:"passthrough",message:"Path validation passed for tee command"}`; dispatcher auto-includes tee via `Object.keys(WN)`. Delta #6 (Edit-deny glob-before-`..` gate `oPn`/`ALe`/`sPn`) confirmed byte-identical 268↔269 → not applicable.
- **OCC:** `src/tools/BashTool/pathValidation.ts` (single file; the ~line-1059 tee-gap comment removed).
- **Tests:** `teePathValidation269.test.ts` — 11 new cases incl. production-gate (`bashToolHasPermission`) assertion that `Bash(tee:*)` allow no longer covers outside-working-dir destinations; `bun test src/tools/BashTool` → **401 pass / 0 fail / 752 expect**.

### E42 — plugin zip extraction hardening (security)
- **Official:** extracted-file mode mask `P & w$` with `w$=493` (0o755) @849721; per-file integrity sweep `swo` @1430917 (O_RDONLY|O_NOFOLLOW|O_NONBLOCK, `isFile() && nlink===1`, `(mode&0o22)!==0 → chmod(mode&0o755)`); batched-sweep caps 512MB/256 files/16 dirs/32 concurrency with "oversize"/"tampered" verdicts (`rfe` @1429098); atomic staging swap `${dir}.staging-<hex>` → rename, `.previous-<hex>` retained, in-place fallback "held open; extracting the archive in place" (`nDt` @5043426, `oDt` @5044761); refuse `..`/absolute entries ("Refusing to extract a plugin archive outside the session plugin cache").
- **OCC:** `src/utils/plugins/zipCache.ts` (+204) — 0o777 → 0o755 mask (drops world-writable + setuid/setgid), `swo`-equivalent integrity sweep, staging + rename-swap with in-place fallback; existing traversal guard kept (not duplicated).
- **Tests:** `zipCacheExtraction269.test.ts` (6 new: 0o666→0o644, setuid 0o4755→0o755, stale-file removal on re-extract, etc.); `bun test src/utils/plugins` → **45 pass / 0 fail**. 4 deviations documented in-code.

### E23 — native-cursor re-assertion on alt-screen enter/exit
- **Official:** `get nativeCursorSeq(){if(this.accessibilityMode||this.isScreenReaderEnabled)return"";return this.nativeCursorVisible?SHOW:HIDE}` (s269 @3023727); enter write appends `nativeCursorSeq ?? ""`; exit cleanup appends it guarded by "exit wrote && !hasUnmounted" (@19106858); SHOW/HIDE = `\x1b[?25h`/`\x1b[?25l` (@26073764).
- **OCC:** `src/ink/ink.tsx` (`nativeCursorSeq` + `hasUnmounted` getters), `src/ink/components/AlternateScreen.tsx` (enter/exit writes).
- **Tests:** `nativeCursorSeq.test.ts` (7) — incl. screen-reader/accessibility → `''`, `CLAUDE_CODE_NATIVE_CURSOR=1` → show seq.
- **Deviations:** official exit guard reduces to `!hasUnmounted` (OCC's EXIT_ALT_SCREEN is a non-empty constant); `G` (extendedKeys re-assert) already lives in OCC's `reassertTerminalModes` since 2.1.268.

### E44 — discard partial terminal-response buffers on flush
- **Official:** `Ha` 3-branch predicate (x269 @193162377): mouse-prefix `Gf` ≤32; OSC/DCS/APC `g1` ≤256; CSI partial `b1` ≤64 — all three regexes byte-identical to the binary; flush path `if(Ha(F))E=[]` (@193165062). 268 had only the mouse-prefix variant.
- **OCC:** `src/ink/parse-keypress.ts` (+71/−3) — exported `isPartialTerminalResponse` + 3-branch flush drop.
- **Tests:** `parseKeyPressPartialFlush.test.ts` (18): `'\x1b[?1;2'` dropped then completed by later `'c'`; `'\x1b]52;abc'` dropped; >64-char CSI garbage NOT dropped; `'\x1b[22c'` complete response unaffected; paste-mode flush preserved as literal.
- **Deviation:** official's dropped-mouse-prefix side-channel `p` and 2s-deadline re-feed machinery not ported (no OCC `KeyParseState` counterpart; affects re-feed timing only, not the drop decision) — documented in-code.

### E35 — prompt-box banner sanitize + width clamp
- **Official:** `dx(e)=wn(uWn(cV(e))).replace(/ {2,}/g," ").trim()` (x269 @181158419) — 4-pass ANSI fixed point (`uWn`), invisibles `\p{Cc}\p{Cf}  ` → space (`wn` @181016275), lone-surrogate strip (`cV` @180829930); render clamp `Ke(dx(P.text),Math.max(1,Math.min(24,ee-1)))` (@206568999, `rSo=24`); `Ke` byte-identical to OCC's existing `truncateToWidth` (@181621891 — reused, not reimplemented); width <8 → plain-border fallback. 268 rendered banner text raw (@205750433).
- **OCC:** new `src/components/PromptInput/sanitizeBannerText.ts` (`sanitizeBannerText` / `clampBannerTextWidth` / `sanitizeAndClampBannerText` / `BANNER_TEXT_MAX_WIDTH=24`); `PromptInput.tsx` render site sanitized+clamped; `useSwarmBanner` returns untouched (sanitize at render, per official's call-site placement).
- **Tests:** `sanitizeBannerText.test.ts` (16): multi-pass ANSI splice, Cf invisibles, lone surrogates vs `'ok😀'`, clamp 100→24 / 2→1 / 0→1, evil-input composition (no `\x1b`, no `\n`, ≤24 cols).

### E25 — LSP `exit` sent even if `shutdown` fails
- **Official:** `try{await E.sendRequest("shutdown")}catch(se){ee=se} try{await E.sendNotification("exit")}catch(se){throw ee??se} if(ee!==void 0)throw ee` (s269 @27390521).
- **OCC:** `src/services/lsp/LSPClient.ts` `stop()` restructured (+30/−2) preserving the outer `shutdownError`/`logError`/finally-cleanup path.
- **Tests:** `lspClientStop.test.ts` (4, mocked `vscode-jsonrpc` + real `sleep` server): shutdown rejects → exit still sent, shutdown error surfaces, dispose ran; both reject → shutdown error preferred.
- **Deviation:** `{}` params kept (OCC's `MessageConnection` type requires the argument; official passes none).

### E05 — `CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS` (default 3000)

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** `Lie=3000` (added.txt @29025021); zod `P.int({min:1,max:2147483647,digitsOnly:!0})` (@17156930); `let n=a.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS??Lie` (@29026952).
- **OCC:** `src/utils/model/gatewayModelDiscovery.ts` — `resolveGatewayModelDiscoveryTimeoutMs()` replaces hardcoded `AbortSignal.timeout(5000)` (OCC default moves 5000 → official 3000); shared `parseBoundedDigitsOnlyInt` in `src/utils/envValidation.ts`; var registered in managed-env constants.
- **Tests:** `gatewayModelDiscoveryTimeout269.test.ts` → **14 pass / 0 fail** (reject-to-default, never clamp — matches official `digitsOnly` parser).

### E07 — `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256)

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** zod `P.int({min:1,max:256,digitsOnly:!0})` (@180984294); default `ur=lr(ir())` where `lr(e)=Math.min(16,Math.max(2,e-2))` core-count gate (@197210624); `Kt=a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS??ur` + debug log `workflow: concurrent agent gate = ${Kt} (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)` (@197215548).
- **OCC:** new `src/tools/WorkflowTool/concurrency.ts`; `primitives.ts` drops `WORKFLOW_DEFAULT_CONCURRENCY=10` for env→budget→official core-count gate; `docs/architecture/workflows.md` + occ93 ledger item-17 annotated "Superseded".
- **Tests:** `concurrency269.test.ts` (19); `bun test src/tools/WorkflowTool` → **68 pass / 0 fail**.
- **Deviations:** official parser REJECTS out-of-range to undefined (binary-verified, not clamp); OCC's `tokenBudget/100000` branch preserved as env-unset fallback (OCC-only); official's separate `cr=50`/`qt` second gate not ported (out of E07 scope, no OCC counterpart).

### E06 — `/focus` spinner tip

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** `{id:"focus-view",providerAgnostic:!0,content:async()=>"Use /focus to see just your prompt, a one-line summary of the work, and the response",cooldownSessions:15,advertisedCommand:"focus",isRelevant:async()=>Xa()&&Ge().viewMode===void 0&&!Qee()}` (@195225099; `Qee` @183829452).
- **OCC:** `src/services/tips/tipRegistry.ts` — content string byte-exact; `Xa()` → OCC's canonical `isFullscreenActive()`.
- **Tests:** `focusViewTip269.test.ts` (8); `bun test src/services/tips` → **13 pass / 0 fail**.
- **Deviations:** `!Qee()` reduces out (its else-branch is `briefTranscript ?? false`; OCC has no such config → documented no-op); `providerAgnostic`/`advertisedCommand` omitted (unconsumed by OCC's scheduler).

### E40 — `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` staleness caps

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** `sHn()` env resolver (x269 @188108925: `!e→undefined; Number(e); n===0→0; finite&&>0→n; else 3600000`), `W6o()` → `{maxAgeMs, source}` with constants `B6o=21600000, U6o="tengu_shimmering_cherny", H6o=60000, j6o=2592000000` (@188109300/340), `G6o` two-sided age predicate (@188109584), gating cluster + `tengu_resume_stale_turn_suppressed` telemetry (@188112609–188113400).
- **OCC:** new `src/cli/resumeStaleness.ts`; `src/cli/print.ts` gates the auto-resume + suppression debug log. All official quirks preserved: env `"0"` falsy → falls through to 6h default; garbage/negative → 1h (`source:"env"`); raw `Number()` coercion; `Math.abs(Date.now()-ts) >= bound`.
- **Tests:** `resumeStaleness269.test.ts` (30); `bun test src/cli` → **74 pass / 0 fail**.
- **Deviations:** statsig flag branch dropped (no statsig → default 6h; flag constants exported for documentation); timestamp source = OCC's `turnInterruptionState.message` (official's whole-tail `qUn` scan has no OCC counterpart — no skipped-api-error-row machinery); telemetry → `logForDebugging` line.

### E27 + E51 — CJK/Thai-aware prompt-suggestion counters and filters
- **Official:** script regexes `nms`(Han)/`rms`(Hiragana+Katakana+Thai+Lao+Khmer+Myanmar)/`oms`(Hangul)/`sms`(`[\p{L}\p{N}]`); `YQn` classifier; `VQn` = han+phonetic+hangul count; `KQn` word estimator (CJK: han/2 + phonetic/4 per token, latin tokens 1, ceil); `done` filter gains `/^\P{L}*(完了(しました)?|完成了?|완료됨?)\P{L}*$/u`; `too_few_words`: `KQn(e)>=2 → keep`, `/`-prefixed → keep, `VQn(e)>0 → <2 drops`, else English whitelist. E51: meta-label strip gains CJK words 提案/回答/応答/出力/結果 + fullwidth colon `：`.
- **OCC:** `src/services/PromptSuggestion/promptSuggestion.ts` — counters + all three filters rewired; English behavior unchanged.
- **Tests:** `src/services/PromptSuggestion/__tests__/` → **44 pass / 0 fail** (Chinese multi-char kept, single han dropped, 完了/完成 done-filtered, mixed-script single word kept per E51, English regressions).

### E39 — `/btw` fabricated-tool-call guard

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** `/^\/btw\b/gi` detector + disclaimer `w` ("_/btw can't run tools: any tool calls or tool output shown above were not executed…_") + omission text `T` ("(That answer wrote tool calls as text. Nothing was executed, so it is omitted here.)") + prompt bullet "Do NOT write tool calls or tool output as text…" (recovered verbatim from added.txt).
- **OCC:** `src/utils/sideQuestion.ts` (+70) + `src/commands.ts` (bullet position mirrored); `src/commands/btw/` untouched (shared side-question pipeline).
- **Tests:** `sideQuestionE39.test.ts` → **15 pass / 0 fail** (fake invoke/function_calls XML flagged; normal answer not; prompt contains bullet).

### E52 — Skill "Unknown skill" full-name suggestion
- **Official:** `Oun(e,n)` (js269, verified): bare name without `:` → filter commands `type==="prompt" && loadedFrom!=="syncedSkills" && name.endsWith(":"+e)`; >1 → ambiguous list; exactly 1 && `source==="plugin"` → `Unknown skill: ${m}. Did you mean ${name}? Invoke it by that full name.`; ambiguous tail recovered verbatim ("Several skills match that name: … — invoke one by its full name…").
- **OCC:** `src/tools/SkillTool/SkillTool.ts` (~line 435 bare message replaced).
- **Tests:** `src/tools/SkillTool/__tests__/` → **17 pass / 0 fail** (unique plugin match, ambiguous, non-plugin → bare message unchanged, `:`-containing query unchanged).
- **Deviation:** `loadedFrom!=="syncedSkills"` guard omitted (OCC has no synced skills — documented).

### E15 — post-compaction git status freshness

_**Dedup:** shipped in release 2.1.332 via the concurrent OCC-123 round; this round’s independent implementation was dropped at merge (first-merged-wins). The forensic verification below stands as this round’s record._
- **Official:** `iat()` (local && git repo) / `jCe` kick-once prefetch into the session state bag / `Tyn` consume-once / `GXn` re-announcement: fresh value wins, fetch failure → stale status DROPPED (official bytes — not "kept"; the catch returns the stripped bag).
- **OCC:** `src/services/compact/postCompactCleanup.ts` — compaction re-announcement re-fetches git status fresh (initial announcement keeps the memoized value); failure semantics follow official `GXn` (drop, not keep — contradicts the task-spec wording; official bytes won per never-invent).
- **Tests:** `postCompactFreshGitStatus.test.ts` → **25 pass / 0 fail**.

## 5. Test + build baseline this round

- Scoped suites during implementation (all 17 IDs, pre-dedup): permissions 163/1, plugins 45/0, BashTool 401/0, ink+PromptInput+lsp 65/0, tips 13/0, workflow 68/0, cli 74/0, model 14/0, PromptSuggestion 44/0, sideQuestion 15/0, SkillTool 17/0, compact 25/0, tool-execution 47/0 — all 0 fail.
- Scoped suites on the final deduped tree (9 shipped IDs): permissions+plugins **208 pass / 1 skip / 0 fail**, PromptSuggestion+SkillTool+lsp **65/0**, ink+PromptInput **61/0**.
- Biome lint on all 21 staged src files: **0 errors** (12 legacy `eslint-disable no-control-regex` comments in `parse-keypress.ts` replaced with the repo-convention `biome-ignore lint/suspicious/noControlCharactersInRegex`; pre-commit hook passes legitimately, no `--no-verify`).

## 6. Acceptance (this round)

- **Full suite** (`bash scripts/ci-test.sh`, per-file process isolation — same as CI): **4008 pass / 12 fail / 12 skip** across 459 files.
- **A/B vs clean `origin/main` (`a6593f7`, release 2.1.332)**: stash → rebuild → the 9 failing e2e files re-run individually → **11 of the 12 failures reproduce identically on clean main** (env/live-model family: `gh` issue-creation assertions, tmux dialog waits, live-model text). The one delta — `/feedback (no args) — model solicits feedback (AI-powered)` — passed on re-run of the same file on the changed tree (15 pass / 1 fail, identical to clean main): live-model flake. **Zero regressions attributable to this round.**
- **Build**: `bun run build` green — `dist/cli.js` 29.16 MB, `MACRO.VERSION=2.1.333`.
- **Backend smoke**: `timeout 15 bun dist/cli.js -p "say hi"` → responds, no hang.
- **tmux REPL acceptance** (interactive, 160×40): clean boot (v2.1.333 banner, **no stray terminal-response characters at startup** — E44 behavioral check); `/add-dir` dialog text field accepts input + tab-completes + Esc-cancels with the official "Did not add a working directory." message and returns to an intact prompt (E23 family); prompt-box borders render intact (E35 render site); real model round-trip `reply with exactly: REPL-OK` → `● REPL-OK` with token counter updating.
- **Security review** (安全审查员 role): full diff read of every shipped file (E14 permission compiler, E42 zip hardening, E23/E44 ink+keypress, E35 banner sanitize, E25 LSP, E27/E51 suggestions, E52 skill naming) + suspicious-pattern sweep (eval/Function/child_process/fetch/http/secret literals) → **no backdoors; permission changes strictly tighten**.
- **Leftover hygiene**: `git ls-remote --heads origin` → only `main` (no leftover branches); two e2e debris issues filed by the acceptance runs (#364, #365) closed.
- **Release**: tag `v2.1.333` → merge commit `158f377` (PR #366; convention: tags point at the main merge commit, cf. v2.1.332 → `7a7b22d`). Publish workflow run `34722187239` green (npm publish + GitHub Release). Verification: **releases 133 == tags 133**, `comm -23 tags releases` **empty**, npm `@cnwenf/occ` = **2.1.333**, release page https://github.com/cnwenf/occ/releases/tag/v2.1.333 (133 total at /releases).

