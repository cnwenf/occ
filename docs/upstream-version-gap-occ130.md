# Upstream Version Gap — OCC-130 (official 2.1.274 → 2.1.276)

Date: 2026-09-19 · Occasion: catch OCC up from official Claude Code 2.1.274 to 2.1.276.
Prior gap doc: `docs/upstream-version-gap-occ128.md` (2.1.269 → 2.1.274, OCC v2.1.341, main `eba431e`).

## 1. Version facts (verified three ways)

| Fact | Value | Verification |
|---|---|---|
| OCC aligned-to official version | 2.1.274 | `src/entrypoints/cli.tsx:15` VERSION marker; OCC-128 gap doc |
| OCC package version | 2.1.341 | `package.json` (OCC's own release counter) |
| npm dist-tags (2026-09-18) | latest=2.1.276, next=2.1.277, stable=2.1.267 | `npm view @anthropic-ai/claude-code dist-tags` |
| Real gap | **2.1.275** (~95 changelog entries incl. VSCode/web/Tag) + **2.1.276** (1 hotfix) | changelog + binary diff |
| v274 binary | 230,580,536 B, md5 `7137e84f2a7189e6190cf5af3de1dcc4` | `/tmp/cc-diff-276/v274/package/claude` (md5 continuity with OCC-128) |
| v276 binary | 232,059,192 B, md5 `702857fc5a4a946799d0ae66c531da51` | `/tmp/cc-diff-276/v276/package/claude` |
| String-level diff | 14,176 new / 12,595 removed strings | `new_strings.txt` / `removed_strings.txt` |

2.1.276 is a **hotfix release for a 2.1.275 regression**: every request failing with
`400 … Input tag 'advisor_20260301'` when `ANTHROPIC_BASE_URL` points at a proxy/gateway.
Per issue mandate: porting 2.1.275 features MUST carry the 2.1.276 advisor fix — the regression
must not enter OCC.

## 2. Method

- `npm pack` both linux-x64 tarballs; JS extracted from the Bun-compiled ELFs.
- All claims byte-verified with Python `re.finditer` bytes-search + context windows
  (`strings` collapses template newlines — mandated discipline). Minified identifiers drift
  per version, so every claim carries byte offsets.
- 4 parallel triage agents (advisor+beta A–B, hooks/config/settings C–H, tools/IO I–N,
  UI/REPL/input O–T) + nested research agents; full reports preserved at
  `/tmp/cc-diff-276/report_*.md` during implementation (scratch dir removed after merge).
- Verdicts: **PORT** (faithful port this release), **NO-OP** (OCC structurally immune /
  surface absent), **STAGE** (recorded, not portable now).

## 3. Item ledger (A–T)

### ITEM A — 2.1.276 advisor hotfix → **PORT (mandatory)**

Changelog: "Fixed every request failing with `400 … Input tag 'advisor_20260301'` when
`ANTHROPIC_BASE_URL` points at a proxy or gateway (2.1.275 regression)".

v276 machinery (byte-verified; v274 has NONE — `advisor-entry-refused` 0→2 hits,
`advisorHeld` 0→21 hits):

- Classifier `TPe`: `e instanceof Pt && e.status===400 && (e.message.includes("the advisor tool is not available") || e.message.includes("cannot be used as an advisor") || /tools\.\d+\.model: /.test(e.message))`.
- Org detector `vtt(e)`: `TPe(e) && e.message.includes("not available for this organization")`.
- Kill-switch `Vqt`/`Yqt()`: org-wide latch making `yct()` (advisor-enabled) false forever once `vtt` matches.
- Retry handler `zHe` in the query wire loop: strips the advisor tool schema from the request
  tools, re-normalizes messages with `"error_recovery"`, sets
  `advisorHeld={model:undefined,viaToolChange,refused:true}`, logs
  `tengu_advisor_entry_refused_retry`, returns `"retry:advisor-entry-refused"`.
- `Gvt`: strips `defer_loading` from the advisor schema on retry (v276 schema push gained
  `...Oo&&{defer_loading:!0}`).
- `Hvt`: removes the advisor beta header when advisor is not enabled (`!Bb()`).
- Resolution gate `Qqt(e,n)`: `e!==undefined && yct() && lL(n) ? e : undefined` for advisorModel.
- v276 fatal-400 chain ends `zHe(Wl)??GHe(Wl,"sync")??Pd(Wl)??zy(Wl)??sl(Wl)` — advisor retry
  is FIRST. Recognised-400 lists: v274 `TAn`/`R0e` → v276 `bFn`/`B9` (diff = advisor entries).

OCC surface — regression reachable: `src/services/api/claude.ts:1720` pushes
`type:'advisor_20260301'` schema; `:1401-1445` sends advisor beta header + resolves advisor
model, all gated on `isAdvisorEnabled()` (`src/utils/advisor.ts:60` — env kill
`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, first-party-only betas, GrowthBook `tengu_sage_compass`
`enabled ?? false`; GrowthBook is REAL in OCC). If advisor is enabled against a gateway that
rewrites/rejects the unknown content-block tag → same fatal 400 loop. Port: retry classifier +
advisorHeld refused state + schema/beta-header strip + resolution gate + org kill-switch +
telemetry, wired into OCC's 400 chain (`src/services/api/errors.ts:567-730`).

### ITEM B — gateway-rewritten beta-header-rejected 400 → **NO-OP**

Changelog: "Fixed a terminal `API Error: 400` on every turn for users behind a network gateway
that rewrites API error responses when a beta request header is rejected".

Byte-verified: `header_rejected` classifier counts are **7 in both v274 and v276** (OCC's
2.1.274 baseline already includes it). The 275→276 delta for this entry is the **tether /
message-threads** hardening: `tengu_tether_unrecognised_400` 0→5, `retry:tether-stateless`
2→3, "[tether] unrecognised HTTP 400 … resending this turn stateless without the header"
(`dropForUnrecognised400`). OCC has **zero** tether/message-threads surface
(`grep -rn "tether\|message-thread" src/` → 0 hits) — OCC never sends that beta header, so a
gateway cannot rewrite a rejection of it. Structurally immune. Residual note: if OCC ever ships
message-threads, port `dropForUnrecognised400` + telemetry with it.

### ITEM C — SubagentStop hooks with matcher firing on empty agent type → **PORT**

v274 truthiness bug: `matchQuery ?` treats `agent_type: ''` as "no matcher" → every
SubagentStop hook fires regardless of matcher (`hooks.ts:4840` sets `agent_type: agentType ?? ''`).
Fix at `src/utils/hooks.ts:2509`: `matchQuery ?` → `matchQuery !== undefined ?` (single
filtering site confirmed). Tests: `''` + matcher `code-reviewer` → 0 hooks; no matcher / `'*'` → fires.

### ITEM D — crash at launch on malformed `mcpNeedsAuthNoticed` → **PORT**

Official v276 normalizer (`nl`): non-array → `[]`; all-strings → as-is; else filter to strings.
Add `normalizeMcpNeedsAuthNoticed(value: unknown): string[]` to
`src/utils/mcpNeedsAuthNotice.ts`, route all 4 sites (:111 shouldAnnounce, :148/:154 mark,
:166 count, :183/:189 prune) through it, keep cap 128 + slice, update header comment to cite
2.1.276. Crash vector today: malformed `~/.claude.json` → TypeError inside
`useMcpConnectivityStatus.tsx:55/:64` React effect at launch.

### ITEM E — otelHeadersHelper failure startup warning → **PORT**

Two parts (byte-exact texts in report):
- E1 `src/utils/auth.ts:2044-2048` catch: record module state `lastOtelHeadersFailure`
  (getter/clear + `subscribeOtelHeadersFailure` listener set), telemetry
  `tengu_otel_headers_helper_failed` `{failure_kind, exit_code}` — kinds:
  `timeout|exit_code|killed|spawn_failed|empty_output|invalid_json|not_an_object|non_string_value`.
  Startup notification (once-only latch, check-lastFailure-then-subscribe): key
  `otel-headers-helper-failed`, color `warning`, priority `high`, timeoutMs 30000, text
  `otelHeadersHelper failed; telemetry is not being exported. See /status: ${truncate(msg,120)}`.
- E2 `src/utils/doctorDiagnostic.ts` (after strictPluginOnlyCustomization block :345-358):
  issue `otelHeadersHelper is configured but its last invocation failed: ${lastFailure}` +
  official fix text ("Run the configured helper manually and confirm it prints a JSON object
  of string header values. If the value is a file path, confirm the file exists and is
  executable."). Optional prefetch (official `frr`) is interactive-only.
- Notification surface: `src/context/notifications.tsx` has no `kind` field — map to `color`.

### ITEM F — /update-config writes `Write(path)` rules → **PORT**

`src/skills/bundled/updateConfig.ts:46`: insert byte-exact 4th bullet (no trailing period):

```
- File paths: `"Edit(src/**)"` - path rules in `permissions` use `Edit(path)` for every file-writing tool (Write, Edit, NotebookEdit) and `Read(path)` for reads. `Write(path)`, `NotebookEdit(path)` and `Glob(path)` rules are not matched by file permission checks. Bare tool names (`"Write"`), deny/ask `Tool(param:value)` rules and hook `if` conditions still use each tool's own name
```

True of OCC's engine (`filesystem.ts:1237-1250` buildPatternBuckets maps all edit tools to
Edit rules). Pre-existing divergence recorded separately (§5): OCC example block uses
`Write(/etc/*)` + colon-style Bash patterns.

### ITEM G — four dead claude-api doc URLs → **NO-OP**

OCC ships 1-byte stubs for the claude-api skill live sources — URL fixes are invisible.
Recorded pairs (for when live sources ship): pricing→`/about-claude/pricing.md`;
computer-use→`computer-use-tool.md`; skills→`agent-skills/overview.md`;
cli→`cli-sdks-libraries/cli/quickstart.md` (+ CLI extraction-prompt change).

### ITEM H — syncClaudeAiSkills / syncClaudeAiPlugins → **STAGE (+ optional schema slice)**

Keys appear 12× in BOTH binaries — no 274→276 delta; the sync subsystem itself is
claude.ai-backend-dependent, not portable. Optional compat slice (ported this release):
`syncClaudeAiSkills: z.boolean().optional()` + `syncClaudeAiPlugins: z.boolean().optional()`
in `SettingsSchema` (`src/utils/settings/types.ts`) so the Edit tool's strict settings
validation (`validation.ts:202-203`) doesn't block users following official docs.

### ITEM I — ripgrep 20MB cap hang/OOM + stderr-flood misreport → **PORT**

v276 (`Wjt`) replaces string-concat accumulation with `CappedOutputBuffer` (`eqe`): 1MB-chunk
decode into `pieces[]`; SIGKILL child the instant the cap is exceeded; truncation →
`Error("stdout maxBuffer length exceeded")` code `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` — never
silent success. New error classes `RipgrepOutputError` / `RipgrepOutputTooLargeError` (0→2 hits
each). Result callback: overflow + 0 lines + `rejectOnInputError` → reject with
`RipgrepOutputTooLargeError('stderr'|'stdout')` (discriminator `message.startsWith("stderr")`);
EAGAIN `-j1` retry gained `!overflow` guard; whole callback wrapped in try/catch so a throw
always settles the promise. OCC `src/utils/ripgrep.ts` is a near-line-for-line v274 port with
every defect (`:214-237` no kill, `:262-264` truncated close resolves success, `:497-550`
maxBuffer-with-0-lines → "No matches found", `:474` EAGAIN retry unguarded, `:553-555` no
try/catch → hang). Full spec in `report_toolsIO_a0ef.md` ITEM I.

### ITEM J — Read tool hang on undecodable large file → **PORT**

v276: decode moved out of the stream (`StringDecoder` in state; raw Buffer chunks) + handler
wrapper `btn(fn)`: try/catch → `this.stream.destroy(err)` → promise rejects instead of never
settling; end-flush `Oko` runs `decoder.end()` through the chunk processor. Handle-based reader
part (`.then(ok,err)`→`.catch`) has no OCC surface (N/A). OCC mirror site:
`src/utils/readFileInRange.ts` streaming path (`:445-449` `encoding:'utf8'`, `:471-474`
unwrapped handlers, `:257` string chunks). Full spec in `report_toolsIO_a0ef.md` ITEM J.

### ITEM K — sandboxed zsh exit code 0 → **PORT (live bug in OCC)**

Official socat wrapper EXIT trap: v274 `trap "kill %1 %2 2>/dev/null; exit" EXIT` → v276
`trap 'rc=$?; kill %1 %2 2>/dev/null; exit $rc' EXIT` (byte-identical otherwise; v274 `AEr`
@195424218 → v276 `f_r` @196288200). Root cause empirically reproduced: zsh bare `exit` in an
EXIT trap uses current `$?` (reset to 0 by the successful `kill`); bash preserves trap-entry
status. OCC gets the wrapper from `@anthropic-ai/sandbox-runtime@0.0.44`
(`linux-sandbox-utils.js:437` — exact buggy string; newest 0.0.76 still buggy) and **prefers
zsh** (`Shell.ts:100-109` default order `['zsh','bash']`). Fix: `bun patch` the dependency →
`patches/@anthropic-ai__sandbox-runtime@0.0.44.patch` + `patchedDependencies`.

### ITEM L — sandbox can't write project `hooks/`/`config/` → **PORT (+ OCC data-loss bonus fix)**

v276 gates the hooks/config deny on positive bare-repo evidence: `hasHead` (HEAD exists, or
symlink readlink matches `/^refs[\\/]/`) OR entry is a **file** named `config`; otherwise
directory containing `.git` → deny only `<entry>/.git`; absent `.git` (ENOENT/ENOTDIR) →
skip (plain project dirs no longer denied); absent hooks/config → nothing (empty catch — never
scrubbed). Companion scrub fn only rmdirs planted empty `.git` dirs. OCC
`sandbox-adapter.ts:314-337` has the v274 unconditional deny **plus worse**:
`scrubBareGitRepoFiles()` (`:526-537`) does `rmSync(recursive)` on absent-at-config-time paths
→ a project `hooks/` dir created during a command gets recursively deleted afterwards. Full
spec in `report_KL.md`. STAGE (separate, pre-existing): OCC scans only cwd/originalCwd vs
official's broader dir set.

### ITEM M — transcript robustness (3 changelog entries) → **PORT (one subsystem)**

- M1 malformed task-reminder/@-file attachment: v276 extends the attachment validator
  (`Lms`/`xW`) — new cases `task_reminder`/`todo_reminder` → content array-of-plain-objects,
  `file`/`already_read_file` → content plain-object; error log `transcript load: dropped ${n}
  attachment ${entry|entries} with a missing or malformed payload — the session transcript
  appears partially corrupt`. OCC lacks even the v274 validator; confirmed crash surfaces
  `messages.ts:3839-3841` (file), `:3974-3977` (task_reminder `.map`),
  `AttachmentMessage.tsx:132-135`.
- M2+M3 malformed message entry / content block: brand-new v276 load-time admission validator
  `Vlr`/`iFs`/`Glr` (@200791900): gate only user/assistant rows; non-plain-object message →
  drop row; string content → keep; non-array → drop; invalid blocks stripped in place; empty
  remainder → drop; `finish()` re-chains survivors whose parentUuid points at dropped rows
  (cycle-safe walk + path compression) and warns `transcript load: removed ${r} malformed
  content block(s) from ${n} row(s) and dropped ${s} unreadable row(s)`. The fullscreen clause
  of M2 has **no separate renderer change** in v276 (probe: ErrorBoundary 0/0) — it's a
  consequence of load-time admission. OCC today: bare `null` JSONL line throws inside the load
  loop → whole transcript loads empty → resume/start fails (exactly M3's symptom);
  `buildConversationChain` silently truncates on missing parent → official re-chain is a
  required part of the port.
- Wiring: single choke point `loadTranscriptFile` (`sessionStorage.ts:3805-3879`) covers every
  resume/preview/fork/rewind path (verified call sites in main.tsx/print.ts/
  ResumeConversation.tsx/REPL.tsx/rewind/fork). New file `src/utils/transcriptAdmission.ts`.

### ITEM N — thinking dropped when built-in tool flag-switched-off → **NO-OP**

Official fix lives in the ToolSearch declared-tools record/hold subsystem (new hold branch
`xDo` + `gateOff` counter + refusal text + `tengu_thinking_drop`). OCC: `declaredTools`,
`recordedToolDescriptions`, `thinking_drop`, `input_transformations` → **zero** src hits; OCC
resume filters are pairing/merge-based and never consult tool enablement — the interaction is
structurally impossible. Residual risk (recorded): OCC rebuilds `tools` from current
`isEnabled()` per session, so a flag flip changes the request prefix and the API could drop
prefix-bound thinking server-side silently; only BriefTool is flag-driven today. Future STAGE
candidate under tracking of the whole declared-tools subsystem.

### ITEM O — send-now key → **PORT (largest UI item)**

Bindings (official order, hint resolver takes last): `ctrl+x enter`→`chat:queueSubmit`,
`ctrl+x ctrl+s`→`chat:sendNow`, `ctrl+enter`→`chat:sendNow`. Handler mirrors v276 `Zxt`
@216697952: prompt-mode + leader gate; empty input or queueEditIndex!==null → flush directly;
non-empty → queued-submit current input, then flush in continuation ONLY if abortController
instance unchanged (identity check). Flush core mirrors `F$t`/`O$t` @217111268: guard
mode==='prompt' && turn guard active && queue non-empty else silent; interrupt fail →
telemetry `input_send_now_key` reason `no_live_controller`; success → dispatch
`queued_send_now` into existing `executeQueuedInput` (REPL.tsx:4062). Interrupt mirrors
`interruptForSubmit` @217191022: finalize in-flight message id + `abortController.abort('user-cancel')`
only — NOT the full cancel flow. Footer dim hint (paddingLeft:2, `<ShortcutLabel chord
action="send now">`) when queued messages visible + turn active; chord = last sendNow binding,
but under TMUX||STY prefer `findLast` of chords without super/ctrl|shift+enter (→ shows
ctrl+x ctrl+s). ALSO backfill v274 empty-Enter flush baseline at `PromptInput.tsx:1136-1138`.
Reuse: messageQueueManager, useCommandQueue (REPL.tsx:655), useQueueProcessor (REPL.tsx:4096).
Full byte-anchors in `report_UI_O_T.md`.

### ITEM P — vim dot-repeat `!` cursor off-by-one → **PORT**

Official predicate `Twr` (value-shaped): `shouldSwitchModeFromValue({nextValue, value,
cursorOffset, mode})` → `next = getModeFromInput(nextValue)`; false if `cursorOffset !== 0` or
`next === 'prompt'` or `next === mode`; else `nextValue.length === value.length + 1 ||
value.length === 0`. Thread `getInputMode?: () => PromptInputMode` through `VimTextInput.tsx`
props into `useVimInput.ts`. Dot-repeat case (~:229): `setOffset(newCursor.offset -
(modeSwitch ? 1 : 0))`. Live INSERT (~:455): same compensation; remap-suffix detection against
`modeSwitch ? input.slice(1) : input`; keep raw input in insertedText. Base non-vim guard
(useTextInput.ts ~:509-525) already aligned to 2.1.273 — unchanged.

### ITEM Q — stray `</ccmemory>` tag → **NO-OP**

v276 adds a 6-variant stripping regex (`Dt`/`Ll`); OCC has no cc-memory server mechanism
(0 hits) — nothing can emit the tag.

### ITEM R — --forward-subagent-text drops forked-skill subagents → **PORT**

`src/tools/SkillTool/SkillTool.ts` fork loop (:294-334), after `agentMessages.push(message)`:
if `message.type === 'progress'` and data.type is `agent_progress`/`skill_progress` → when
`context.options.forwardSubagentText && onProgress`, forward
`{type:'progress', toolUseID, parentToolUseID, data}` and continue (= official `w7`/`hMt`
@203722538/203722646; fix site v276 @203999664). `queryHelpers.ts:120-141` already unwraps both
progress types; AgentTool path (AgentTool.tsx:1174-1196) already flag-gated. Official fix site
2 (background nested-forward) N/A architecturally in OCC.

### ITEM S — `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` global caching for --system-prompt → **PORT**

Add `splitCustomSystemPromptAtBoundary(prompt)` replicating v276 `sfe` @198043890: split lines;
find `line.trim() === SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; no match → `[prompt]`; else
staticPart = lines before + '\n', dynamicPart = '\n' + lines after; return
`[...(staticPart.trim()?[staticPart]:[]), BOUNDARY, ...(dynamicPart.trim()?[dynamicPart]:[])]`.
In `src/QueryEngine.ts:~341-381` replace `[customPrompt]` with the spread. Boundary constant
`src/constants/prompts.ts:131-132`; `splitSysPromptPrefix` (`src/utils/api.ts:295-420`) matches
the boundary only as a standalone element. Pre-existing divergences recorded (§5): cacheScope
null vs "org"; missing third special block.

### ITEM T — @-mention file suggestions buried below MCP resources → **PORT**

`src/hooks/fileSuggestions.ts`: add `mapWithNormalizedScores(paths)` — cap at MAX_SUGGESTIONS
then `createFileSuggestionItem(p, n / Math.max(capped.length, 1))`; replace both :741 (custom
command) and :748 (bare-@) index-as-score sites. Bug: index scores 1..14 sorted ascending vs
MCP ~0.5 → files buried (`unifiedSuggestions.ts:196`). Index-search path (:627-635, real
nucleo scores) untouched.

## 4. Remaining 2.1.275 terminal entries — screening

Excluded by policy (upstream-tracking: only port what doesn't depend on the Anthropic
backend) or absent surface — **NO-OP**: Claude apps gateway sign-in (+/logout gateway),
resumed cloud sessions, hosted sessions, Artifact tool family (restore/publish/read/tab
icon/scheduled-run republish), routines (+ removed startup notice), plan-usage shared reads
(0 hits), ListPlugins description (tool absent, 0 hits), `--drain-wait-sec` runners (flag
absent, 0 hits), account-skills Write/Edit results (syncClaudeAi absent), memory-file age note
(0 hits), Claude in Chrome auto-mode (extension surface absent). All `[VSCode]`,
`[Claude Code on the web]`, `[Claude Tag]`, `[Code Review]` entries: N/A (not terminal).

Deferred to a residual-triage pass (OCC surface exists; not covered by A–T). **Triage COMPLETE**
(full byte-forensic report: 16 entries → **PORT 9 · NO-OP 3 · STAGE 4**):

- **PORT — SECURITY (landed this round):**
  - *Item 6* npm-source plugins: official v276 replaces plain `npm install` with
    `npm view --json` + `npm pack --ignore-scripts` (env `npm_config_ignore_scripts:"true"`) +
    SRI verification (`sha512→sha384→sha256→sha1`, refusal strings byte-exact) + script-free tar
    unpack with 256 MiB cap + 60s/300s timeouts (subsystem @200294300-200299900). OCC carried the
    v274 RCE bug exactly (`pluginLoader.ts` plain `npm install`).
  - *Item 3* credential leak: official v276 routes every user-facing plugin/marketplace URL
    through scrubber `j6e`@200182994 (strips `://user:token@` userinfo; parse failure →
    `[redacted URL]`). OCC leaked raw URLs at 6+ user-facing sites (PluginError constructors,
    `PluginErrors.tsx`, `mcpPluginIntegration.ts`, `plugins.ts`, `Doctor.tsx`, `fetchPluginZip.ts`).
  - *Item 4* git-address parser: OCC's `extractGitHubRepoFromGitUrl` was narrower than even v274
    → **blocklist bypass** via `ssh://git@ssh.github.com/owner/repo.git`. Replaced with official
    v276 `yAn`@191030323 algorithm (protocol allowlist, scp-like/ssh/git+ssh/git/https forms,
    github.com+ssh.github.com host normalization, `.git` strip, `..` rejection).
- **PORT — data-loss (landed this round):**
  - *Item 11* `/rewind` truncated restore: official v276 adds post-copy size verification
    (`FileHistory: backup copy is incomplete`), `COPYFILE_EXCL` backups, atomic temp+rename
    restore, retry backoff `[100,200,400,800]` ms, `Promise.allSettled` batch restores. OCC's
    `restoreBackup` was an unverified plain `copyFile`.
  - *Item 2* marketplace update: v274 deleted the live local copy on fetch failure
    (`xpt`@198262778 rm-before-verify); v276 `lSt`@200218717 uses owned-temp + swap-based
    re-clone (backup→swap→delete-backup-only-on-success). OCC carried the same 2-step
    rm-then-rename shape.
- **PORT — behavioral/feature (landed this round):**
  - *Item 1* `/plugin install <plugin> --marketplace <source>` offer-to-add (flag + completion
    entry + 2 usage errors, byte-exact).
  - *Item 5* reload-preview isolation: preview extractions go to
    `<cacheDir>.preview-<sha256_32hex>` (`Urr`@200401744) instead of clobbering the live session
    cache. Integration wiring (orchestrator): `pluginLoader.ts` cache-only discovery load threads
    `{preview: true}` and consumes the returned dir — official mapping verified in-binary:
    `preview:!0` rides ONLY the `KBt`=`{cacheOnly,preview}` discovery load (MCP/trust enumeration
    @200435647); the full load stays in-place (`Skt` branch @200406306). Also switched
    `marketplaceManager.ts`'s private `***`-masking redactor to the shared official-`j6e`
    `src/utils/redactUrl.ts` (strips userinfo — the private mask form exists nowhere in the
    official binary) and dropped its unused `_test` export.
  - *Item 13* `/desktop` error detail: v276 `D()` builder — `{opener}` exited `<code>` + last
    ≤200 chars of trimmed stderr (trailing period stripped); failure string
    `` `Couldn't open Claude Desktop (${detail}). Open Claude Desktop and run /desktop again.` ``
    (OCC keeps its own min-version constant in the too-old string).
  - *Item 15* stdout backpressure: behavioral port (official fix is inside the native renderer
    rewrite, not byte-portable) — write-returns-false → hold/coalesce frames, drain → resync
    (probe + reassert terminal modes + full repaint), telemetry `tengu_stdout_backpressure` when
    droppedBytes>0 or hold ≥1000ms. OCC's Ink fork previously blocked the event loop on a paused
    terminal.
- **NO-OP (proof in triage report):** *Item 7* bg-task notice placement (OCC delivers via
  queue→`queued_command` attachments, immune); *Item 14* pasted-image save location (official
  terminal paste path byte-identical v274↔v276; OCC attaches base64 directly, no Read prompt
  surface); *Item 16* Chrome auto-mode per-site check (OCC has no per-call extension permission
  negotiation — static env mode only; staged spec recorded should OCC ever add the relay).
- **STAGE (official fix not byte-locatable / needs repro first):** *Items 8/9/10* fullscreen
  large-diff scroll freeze, fast-typing slash-dropdown crash, resume-picker mouse clipboard —
  all live in the official native-renderer rewrite; OCC's Ink fork has a different failure
  surface; revisit only on user-reported repro. *Item 12* bg-session fd exhaustion — every
  official EMFILE surface is byte-identical v274↔v276; repro under `ulimit -n` before designing
  OCC-native handling (inventing a handler without official bytes violates binary-as-truth).
- **STAGE carry-over from MISC cluster:** official `Re` multi-char NORMAL-mode vim replay loop
  has no OCC counterpart — fast-typed `i!` sequence gap remains (ITEM P fixed the dot-repeat
  offset; the replay-loop divergence is documented, not guessed).

## 5. Pre-existing divergences noted (not introduced by this release)

1. otel headers: official rewrote the helper to a sync path in an earlier version; OCC keeps
   the async helper — E port adds the failure surfacing on OCC's existing shape.
2. updateConfig example block: OCC uses `Write(/etc/*)` + colon-style Bash patterns vs official
   current text — verify against OCC's Bash matcher before flipping (separate change).
3. claude-api skill live sources ship as 1-byte stubs in OCC (ITEM G invisible).
4. System-prompt caching: cacheScope null vs official "org"; missing third special block (ITEM S
   adjacent).
5. Sandbox bare-repo scan scope: OCC scans cwd/originalCwd only vs official project+git+
   additional dirs+ancestor chain+v276 parent-`.git` post-pass (ITEM L adjacent STAGE).
6. OCC lacks the v274 transcript deserialize sanitizers (`Kms/Nhs`, `Eoe/wse`) — the ITEM M
   `Vlr` port subsumes their load-path protection.

## 6. Implementation & test plan

PORT set (13 code changes): A, C, D, E(+schema slice H), F, I, J, K, L, M, O, P, R, S, T.
NO-OP: B, G, N, Q. STAGE: H(full), L-scan-scope, N-residual, residual-triage items 8/9/10/12 (§4).
Residual triage added a second PORT wave (§4): items 6+3+4+11+2+1+5+13+15, plus the ITEM O
follow-up — official gray-render of sent/queued messages until the model receives them
(`promptsAwaitingModel` store keyed by `uuid.slice(0,24)`, `Pb` hook, `rtt` color logic —
brief→`subtle`, non-brief→`inactive`), and the ITEM S second embedding site
(`buildEffectiveSystemPrompt` now shares `src/utils/systemPromptBoundary.ts`).

Parallel implementation clusters (disjoint files): ADV(A) · CFG(C+D+F+H) · E · IO(I+J) ·
KL(K+L) · M · O · MISC(P+R+S+T) · GRAY(O gray-render follow-up) · RES-SEC6(item 6) ·
RES-SEC3(item 3) · RES-MKT(items 4+2+1) · RES-FH(item 11) · RES-UI(items 13+5) ·
RES-BP(item 15). Version markers bumped centrally after merge of clusters:
`src/entrypoints/cli.tsx:15` 2.1.274→2.1.276, `README.md:8/65/146`, `CLAUDE.md:55`,
`CHANGELOG.md` tracking prose.

Acceptance: new UTs (AAA, ≥95% of new code), full suite `CI=true bash scripts/ci-test.sh` with
no new failures vs GREEN baseline (run 35293477630), `bun run build` green, real e2e
(`test/e2e/run.sh` Docker Ubuntu) + tmux REPL smoke + `occ -p` live path, consistency spot
checks vs official `uvx claude-code` where behavior is user-visible.
