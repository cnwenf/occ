# Upstream Gap Ledger — OCC-143 (official 2.1.286 vs OCC 2.1.363@2.1.285)

Round: 2026-10-01 → 2026-10-02 (daily catch-up; **recovered mid-round by OCC Leader after the assigned programmer runtime died twice** — no parallel round landed this time). Official npm `latest` at round start = **2.1.286** (published 2026-09-30T17:14:38.859Z; `stable` tag = 2.1.285). Official changelog section 2.1.286 = exactly **88 bullets** (verified count from the GitHub changelog).
OCC tracked-upstream = **2.1.285** (OCC release baseline v2.1.363, main @ `793b605`) → this is a real porting round (285 → 286).

**Mid-round upstream movement:** npm `latest` advanced to **2.1.287** (published 2026-10-01T16:59:25.986Z) while this round was in flight. Per the round-scope discipline (occ142 precedent: "official latest at round start"), this round closes at **2.1.286 parity**; the 2.1.285→2.1.287 delta belongs to the next daily round (§5).

Evidence base:
- Official `@anthropic-ai/claude-code-linux-x64` **2.1.286** npm tarball (`npm pack`), extracted `claude` ELF md5 **`7a1a1bf1223b8dc705fec6124dd82df1`** — **NEVER executed**; strings/dd/grep/od byte forensics only (occ136 §11.5 discipline).
- Official **2.1.285** npm tarball for the before/after diff, extracted `claude` ELF md5 **`95fadb74aa30d5ac4ea77495d47bc071`**.
- Forensic corpus `/tmp/cc-diff-286/` (runtime-local, **deleted at round end** per hygiene rule — the byte evidence that matters is either quoted in this ledger or embedded verbatim in the ported source files, whose headers cite the source md5). Key artifacts while alive: `ver_code.txt`/`ver_engine_mod.txt`/`ver_secret_engine.txt`/`ver_red_region.txt` (v286 redactor region extracts), `ctx_v286_Nt.txt` + `ctx_v286_qt_wkn.txt` (behavioral context dumps used to verify the port verbatim), `wnl285.txt`/`wnl286.txt` (strings diffs), `/tmp/gen286/*.js` (the exact fragments each ported module was generated from), `/tmp/bullets286.txt` (88 bullet texts; **bullet N = line N**).
- Reproducibility: every regex-bearing ported file was **machine-generated** from the `/tmp/gen286` fragments (never retyped through tool calls — the `\uXXXX`-decoding hazard, occ prior-round lesson). The fragments are byte-identical to the code blocks inside `src/utils/secretRedaction/*.ts` below the doc headers, so the port is self-documenting: re-extraction only needs the v286 tarball + the module headers' md5.

Verdict key: **PORT** = landed this round byte-faithfully + tested; **NO-OP** = surface absent in OCC by design (trimmed feature) or server-side/cloud/VSCode/Tag/RC/gateway/macOS/Windows-only; **DEFER** = genuinely portable but not reached this round (needs per-site decompilation — never invented); **STAGE** = surface exists but mechanism not byte-recoverable without dedicated per-site decompilation.

## §1 88-bullet triage table

| # | Bullet (abridged; full text in `/tmp/bullets286.txt` line N, corpus GC'd — re-derive from the GitHub changelog 2.1.286 section) | Verdict | Notes |
|---|---|---|---|
| 1 | Permission-prompt stack count "2 of 5" | DEFER | prompt-chrome UI; per-site decompilation needed |
| 2 | Mouse support for "N more" rows in fullscreen lists | DEFER | fullscreen list UI |
| 3 | Multiple processes/IDE extensions each opening a login browser on gcp/awsAuthRefresh expiry | DEFER | OCC OAuth/auth-refresh surface is simplified; verify-before-port |
| 4 | `--resume`/`--continue` losing every turn after a parallel-tool batch when the earlier session crashed | DEFER | transcript-repair on resume; portable P2 candidate |
| 5 | API 400 after a tool/hook returned object/number/boolean instead of text (incl. resumed sessions) | DEFER | content-coercion at message build; portable P2 candidate |
| 6 | Cloud sessions with very large histories never waking up | NO-OP | cloud surface |
| 7 | Claude apps gateway spend-meter 1h cache-write pricing / streamed-turn token counting | NO-OP | gateway server-side |
| 8 | macOS "Not logged in" after `/login` succeeds elsewhere with leftover `~/.claude/.credentials.json` | NO-OP | macOS keychain-specific |
| 9 | Every turn failing when the API refuses the resolved model → retry once on previous same-tier model | DEFER | OCC has fallback infra; the same-tier retry needs binary recovery |
| 10 | Remote Control staying connected after org policy turns RC off | NO-OP | Remote Control surface |
| 11 | Refusal/`--fallback-model` retries failing when fallback can't run fast → standard speed + one-time notice | DEFER | fast-mode/fallback interaction |
| 12 | Headless repeating "MCP servers require authentication" after successful re-auth (discovery cache) | DEFER | MCP auth-reminder state |
| 13 | `claude auth status` reporting Console API key as `claude.ai` → `api_key` | DEFER | OCC auth surface trimmed; verify counterpart exists first |
| 14 | `/status` listing an Anthropic profile beside an API key as if both in effect | DEFER | profiles surface |
| 15 | RC attachment non-arrival not surfaced to Claude; 10s last download try | NO-OP | Remote Control surface |
| 16 | RC message arriving during exit marked delivered, never answered → stays queued | NO-OP | Remote Control surface |
| 17 | **MCP error messages showing a credential's value when "Bearer"/"Basic" came BEFORE its key name** | **PORT** | §2 — redactor rewrite, `src/utils/secretRedaction/` |
| 18 | **Percent-encoded Bearer tokens only partly masked** | **PORT** | §2 — origin-tracked redaction so slicing never cuts spans |
| 19 | **Secrets whose key name contains an invisible character (zero-width)** | **PORT** | §2 — `invisibleTolerantSource` builder + invisible-char classes |
| 20 | **URL passwords with punctuation `)`, quotes, `]`, `&`, second `@`, or running past `/` into bracketed host `[::1]`** | **PORT** | §2 — new URL userinfo scanner |
| 21 | **`/feedback` zip transcript containing invalid JSON lines after redaction** | **PORT** | §2 — JSONL-safe parse→deep-redact→re-serialize module ported; NOTE: OCC `/feedback` files a GitHub issue (no zip → upstream zip assembler `vkn` is NO-OP here); OCC's real raw-JSONL upload surface `submitTranscriptShare.ts` is wired instead |
| 22 | MCP connectors listing no tools for up to a day after server dropped the older handshake | DEFER | MCP handshake-fallback cache TTL |
| 23 | Repeat MCP sign-in request replacing the pending sign-in link | DEFER | OCC MCP OAuth simplified |
| 24 | `/usage` not crediting an MCP server for calls made while connecting | DEFER | usage attribution |
| 25 | Plugins enabled on claude.ai going missing after a transient server error | NO-OP | claude.ai plugin sync |
| 26 | Message typed into a running subagent showing twice in its transcript | DEFER | subagent transcript dedup |
| 27 | Subagent hand-back showing raw task id instead of agent name | DEFER | OCC has `subagentHandback.ts` — portable P2 candidate |
| 28 | Foreground subagents missing task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) | NO-OP | Task\* set is gated on `isTodoV2Enabled()` — off in OCC prod builds by design |
| 29 | Worktree-isolated subagents loading project CLAUDE.md a second time from the worktree copy | DEFER | CLAUDE.md discovery caching |
| 30 | Workflow tool subagents restarted from original prompt when a connection stalled mid-response | DEFER | WORKFLOW_SCRIPTS is LIVE in OCC — portable P2 candidate (resume-vs-restart on stall) |
| 31 | `/compact` `/clear` `/rewind` typed while viewing a bg agent's transcript silently acting on main conversation | DEFER | transcript-view targeting dialog |
| 32 | Background jobs showing done while waiting for approval | DEFER | job status states |
| 33 | Commit attribution reminder re-sent inside tool output when a fallback lasts one turn | DEFER | attribution reminder state |
| 34 | Click between words of a collapsed row highlighting without expanding (fullscreen) | DEFER | mouse hit-testing UI |
| 35 | Row with no details pushing every other row's details right in list screens | DEFER | list layout UI |
| 36 | Files with very long names not reaching a cloud session | NO-OP | cloud surface |
| 37 | Plugin errors for a refused marketplace now say why and how to fix | DEFER | marketplace error text |
| 38 | `/plugin` Discover "Checking …" line quoting inconsistency | DEFER | plugin UI text |
| 39 | Commit guidance: run a `verify` skill right before committing (except docs/tests-only) | DEFER | system-prompt text change — portable P3 (prompt string must be recovered byte-exact) |
| 40 | Send-now (ctrl+enter) in subagent view moves its running command to background | DEFER | subagent input UI |
| 41 | Background-agent replies no longer open with a recap of your message | DEFER | prompt/behavior change |
| 42 | claude.ai artifact link reads via WebFetch aligning with Artifact tool prompts | NO-OP | artifacts surface |
| 43 | Fetch/skill/file-read/sandbox-network/Chrome/workflow/notebook prompts matching file-edit look | DEFER | permission-prompt chrome |
| 44 | Bash/PowerShell/Monitor prompts showing command between dashed lines | DEFER | permission-prompt chrome |
| 45 | Fullscreen list scrollbars: no shift with "N more" rows; clickable ↑/↓ arrows | DEFER | list UI |
| 46 | External editor (Ctrl+G) opening on the cursor's line for line-number-aware editors | DEFER | editor integration |
| 47 | Slash-command suggestions: word-prefix matching on descriptions | DEFER | suggestion ranking |
| 48 | Output style picker opens on current style; descriptions under names; no number-key pick | DEFER | picker UI |
| 49 | `/hooks` detail closing line "this hook" instead of "it" | DEFER | trivial text — batch with next UI round |
| 50 | Fallback notice / autocompact-thrashing error saying when context dropped 1M→200K | DEFER | error text + context-window bookkeeping |
| 51 | SDK/`-p` responsiveness when host re-sends MCP enable for an already-connected server | DEFER | SDK control-path short-circuit |
| 52 | Claude apps gateway `/protocol` page update | NO-OP | gateway server-side |
| 53 | Prompts sent while idle show in normal text color right away | DEFER | input UI |
| 54 | Retry budget now covers a whole model call (≤14 requests at defaults) | DEFER | retry accounting — portable P2 |
| 55 | `--bare` connects only CLI-named MCP servers, no system reminders, no bg tasks; timeout stops instead of backgrounding | DEFER | verify OCC `--bare` surface first |
| 56 | Send-now (ctrl+enter) moves a skill's own shell command to background | DEFER | skill shell lifecycle |
| 57 | WebFetch rate-limited domain-safety error tells Claude not to retry in a loop | DEFER | error text — portable P3 |
| 58 | Plugin installs refuse npm sources that are git repos/folders; deps only from registry packages | DEFER | **security-adjacent** — P1 candidate for next round |
| 59 | List screens line up each row's details in one column | DEFER | list layout UI |
| 60 | Overflow rows read "↑ N more" / "↓ N more" | DEFER | list UI text |
| 61 | `/hooks` opens on one grouped-by-event list (one Enter instead of three) | DEFER | hooks UI rework |
| 62 | Theme picker: scrolling list that fits the terminal; no number-key pick | DEFER | picker UI |
| 63 | `/exit` Remove-worktree runs after stopping servers/shells started there | DEFER | exit ordering (Windows-motivated, portable) |
| 64 | `claude-api` skill Managed Agents examples use limited-networking environments | NO-OP | OCC skill .md files are intentional stubs |
| 65 | Browser link removed from `/ultrareview` output | NO-OP | no ultrareview surface in OCC |
| 66 | Windows: `--bg`/agents view refusing an already-trusted folder saved with different letter case | NO-OP | Windows + OCC `--bg` is daemon-redirected by design |
| 67–76 | `[VSCode]` ×10 (bookmarks panel; question rows/previews; message context rows; duplicate tab; settings-save 1MB; teleport spinner; manage-plugins dialog; Stop/Escape scope; status-bar item) | NO-OP | VSCode extension surface — OCC ships no IDE extension |
| 77–82 | `[Cloud sessions]` ×6 (idle reply; org setup-script; Runner menu; routine Runs status; Outputs media; Due label) | NO-OP | cloud surface |
| 83–88 | `[Claude Tag]` ×6 (Add-channel button; memory-recall model; Enterprise Grid move; Slack-thread restart; channel-name display; session titles) | NO-OP | Claude Tag/Slack surface |

**Tally:** 5 PORT (#17–21) · 37 NO-OP · 46 DEFER · 0 STAGE.

## §2 P1 — the v286 secret-redaction engine rewrite (bullets #17–21), LANDED

2.1.286's only portable security slice is a ground-up **redactor rewrite**. The v285 text-scrubber OCC previously mirrored (`redactUrl.ts`-era regexes) is replaced upstream by a multi-stage engine; all five redaction bullets are facets of that one rewrite, so it was ported whole rather than per-bullet.

### 2a. What upstream changed (byte forensics, md5 `7a1a1bf1…`)

- **#17** — the Bearer/Basic rule families (`An`/`Rn`/`Tn`/`On` pattern sets + the `http-auth-scheme` rule) now match a scheme word **before** the key name, closing the "Bearer … api_key=VALUE" leak where the old key-name-first ordering missed the value.
- **#18** — redaction became **origin-tracked** (`ot`/`at`/`ie`/`Te` tracked-doc primitives + `Su`/`re` UTF-16-safe slicing): percent-encoded tokens (`%2F`, `%40`, …) are masked over their full encoded span, so slicing can never cut a span and leave `%2B…` residue.
- **#19** — the `$Se` invisible-tolerant regex-source builder + `ape`/`jje` invisible-character classes make key-name matching tolerant of zero-width/soft-hyphen/BOM insertions (`api​key`, `pass­word`, `Bear​er`).
- **#20** — a dedicated URL userinfo scanner (`yn`/`dt` + regex battery `on`/`an`/`un`/`ln`/`cn`/`dn`/`fn`/`gn`/`hn`/`pn`/`mn`) handles passwords containing `)`, quotes, `]`, `&`, a **second** `@`, and passwords running past `/` into bracketed hosts (`ssh://u:pass/word@[::1]:22/…`).
- **#21** — transcript JSONL redaction (`wkn = zr(uOe(text))`) is now **parse → deep-redact → re-serialize** (`jt` per-key state machine over credentialProperty/credentialPropertyNames/propertyNames; `Nt`/`Wr` 64-hex request-id scrubbing), so every output line stays valid JSON. The `hr` line filter (only on the `wkn` path) **drops** `api-request` lines entirely and converts undeterminable lines to `{"type":"line-withheld","bytes":N}`.

### 2b. Port architecture (`src/utils/secretRedaction/`, 9 new files)

Upstream minified identifiers are kept **verbatim internally** (repo precedent: `mcp/redaction.ts` keeps `tQn`/`JGo`/`ezo`); readable public aliases live in the `index.ts` barrel (`Rs`→`redactSecrets`, `g4o`→`scanSecrets`, `wkn`→`redactTranscriptJsonl`, `zr`→`redactJsonlLines`, `$qt`→`redactJsonStructural`, `M4`→`redactJsonValue`, `D6r`→`redactKeyValue`, `OGt`→`redactCredentialKeys`, …). `tsconfig strict:false` lets the verbatim minified JS compile as TS unchanged.

| File | Upstream fragment (from `/tmp/gen286/`) | Content |
|---|---|---|
| `invisibleChars.ts` | — | `INVISIBLE_CHARS` (ape), `PREPENDED_CONCAT_MARKS`, `INVISIBLE_RUN` (jje), `invisibleTolerantSource` ($Se builder) |
| `textSlicing.ts` | textHelpers.js + textHelpers2.js | `Su` capitalize; `re`/`f`/`x` UTF-16-safe slicing (recovered from `ver_code.txt` @375038) |
| `trackedDoc.ts` | trackedDoc.js | `ot`/`at`/`ie`/`Te` origin-tracked span primitives |
| `urlScanner.ts` | urlScanner.js | #20 URL userinfo scanner (`dt` public) |
| `rules.ts` | rules.js + ir.js | rule batteries `Fe`/`St`/`On`/`ir` (incl. #17 http-auth-scheme families) |
| `pem.ts` | pem.js | PEM block detector `Dn`/`H6r`/`Et` |
| `engine.ts` | engine.js | core scan/redact engine `g4o`/`Rs`/`mQ`/`fZn`/`fvn`/`mZn`/`LSe`/`M4`/`D6r`/`OGt` |
| `jsonlRedact.ts` | lineFilter.js + bundler.js | #21 `zr`/`wkn`/`$qt` + divergence shims (§3) |
| `index.ts` | — | barrel with readable aliases |

Lint: the verbatim minified code intentionally trips 4 biome rules; suppressed **file-scoped** with `// biome-ignore-all` header comments (repo precedent `src/tools.ts:1`) — biome.json untouched.

### 2c. Consumer rewiring (3 files)

- `src/components/Feedback.tsx` — the old 42-line naive `redactSensitiveInfo` (pre-2.1.286 regex list) → thin alias of `redactSecrets`. All 7 internal call sites unchanged.
- `src/commands/feedback/index.ts` — inline naive redactor (70 lines incl. TDZ workaround) → `redactSecrets`; the api-request payload now goes through `redactJsonValue` (**deep-redact before serialize**, mirroring upstream's `$qt` path) instead of redact-after-stringify.
- `src/components/FeedbackSurvey/submitTranscriptShare.ts` — OCC's **real** bullet-#21 surface (uploads `rawTranscriptJsonl` + structured `transcript`/`subagentTranscripts` to the shared-session endpoint): `redactTranscriptJsonl` on the raw JSONL, `redactJsonStructural` on the structured transcripts; the outer whole-payload `redactSensitiveInfo(jsonStringify(data))` is kept as belt-and-braces.

## §3 Documented divergences (deliberate, behavior-constrained)

Upstream helpers `b`/`Vo`/`L`/`ft` live in chunks OCC does not port; they are shimmed in `jsonlRedact.ts` with behavior fully constrained by their (verbatim-ported) call sites:

- `b` — upstream wraps `JSON.stringify` with telemetry instrumentation (chunk-6w550002.js); shim = plain `JSON.stringify(e, n?, r?)`. Instrumentation intentionally stripped (OCC has no analytics).
- `Vo` — verbatim `JSON.parse` wrapper (chunk-xjjs8j5r.js @40796824).
- `L` — record guard; only consumer does `L(u) ? u.type : void 0`, so `typeof e === 'object' && e !== null` is equivalent.
- `ft` — lenient parse-or-null; only consumer (`zr`) treats null as "not JSON → redact whole line".
- `M6r`/`m4o` constants dropped (unused by any ported module); helpers `st`/`si`/`tc`/`P`/`qje`/`os`/`Jd`/`yQ` not ported (unused — YAGNI).
- `Nt` semantics verified byte-for-byte against `ctx_v286_Nt.txt`: 64-hex scrubbing fires **only** when the string being processed itself contains `api-request` — two tests initially written against a stronger expectation were corrected after re-reading upstream, not the port.

## §4 Verification (all green this round)

- **New tests:** `src/utils/__tests__/secretRedaction286.test.ts` — 24 tests / 53 expects covering bullets #17–21 facet-by-facet (incl. zero-width/soft-hyphen key names built via `String.fromCharCode`, bracketed-host ssh URLs, JSONL validity after redaction, `line-withheld` conversion, api-request line drop, 64-hex scrub scoping). **24 pass / 0 fail.**
- **Full suite A/B (stash-verified):** clean tree @`793b605` = 6417 pass / **78 fail** / 6497 tests; with this round = 6441 pass (+24 = exactly the new tests) / **78 fail** (identical set — DiskTaskOutput, Bedrock strings, MCP OAuth wiring, PowerShell shell-tag, large-memory-files, etc., all pre-existing/environmental) / 6521 tests. **Zero regressions.**
- **Lint:** `bunx biome lint` clean on all new + touched files.
- **tsc:** zero errors in touched files (repo carries ~645 pre-existing errors, non-gating per repo CLAUDE.md).
- **Build:** `bun run build` green — `dist/cli.js` 29.67 MB, `OCC 2.1.363` pre-bump.
- **Live e2e:** headless `echo "say PONG" | ./dist/cli.js -p` → `PONG`, exit 0. tmux REPL boot → welcome box renders → `/status` shows Version/Session/Model rows → clean `/exit`.

## §5 Carry-over to the next round

1. **2.1.287 delta** (published 2026-10-01T16:59Z, mid-round) — full triage owed; `stable` tag still 2.1.285.
2. **#58 plugin npm-source refusal** — security-adjacent, top DEFER candidate.
3. **#4 resume turn-loss / #5 tool-result 400 coercion / #54 retry budget / #30 workflow-subagent stall restart** (WORKFLOW_SCRIPTS is live in OCC) / **#27 hand-back name** — highest-value portable DEFERs.
4. UI-chrome batch (#1/#2/#34/#35/#43/#44/#45/#59/#60) — port together to amortize per-site decompilation.

## §6 Round notes

- Programmer-agent runtime died twice ("runtime went offline"); OCC Leader recovered the round in-session per the stall-watchdog trigger and completed triage → port → tests → verification → release personally (no sub-issues, per issue discipline).
- Corpus `/tmp/cc-diff-286/` + `/tmp/gen286/` deleted at round end; ported file headers carry the source md5 + fragment provenance so any future round can re-extract and re-verify without this runtime (occ141 §8 lesson applied).
