# Upstream Version Gap — OCC-126 (official 2.1.270 → 2.1.272)

Round: OCC-126 version catch-up (2026-09-15/16). Baseline: OCC tracked upstream `2.1.270`
(package version 2.1.335, next release tag v2.1.336). Official npm `@anthropic-ai/claude-code`
latest re-verified this round: **`2.1.272`** (unchanged since dispatch; `next` also 2.1.272).

Methodology per `upstream-tracking` + `aligning-with-official-binary` skills: binary
forensics on the official linux-x64 ELFs (`npm pack @anthropic-ai/claude-code-linux-x64@<ver>`),
`strings -n 8 | sort -u` + `comm -13` diff, python `re.finditer` context extraction for
verbatim minified-JS recovery. **Never invent** — every landed behavior below is backed by
byte-verbatim binary evidence; anything ambiguous stays STAGED with rationale.

Forensic artifacts (this round):

| Artifact | Value |
|---|---|
| 2.1.270 ELF (`vprev/package/claude`) | 223,981,040 bytes |
| 2.1.272 ELF (`vver/package/claude`) | 227,115,320 bytes (+3.13 MB) |
| strings(2.1.270) `s1s.txt` | 279,834 lines |
| strings(2.1.272) `s2s.txt` | 282,164 lines |
| new-in-2.1.272 strings (`comm -13`) | 15,025 lines |
| Official changelog | 2.1.271 = ~60 entries (substantive); 2.1.272 = "Bug fixes and reliability improvements" only |

2.1.272 carries no new changelog prose, but the binary diff shows one behavioral flip that
matters: the Statsig gate **`tengu_breezy_crescent` default changed `false`→`true`**
(`Yq(){return py("tengu_breezy_crescent",!0)}` in 2.1.272 vs `py("tengu_breezy_crescent",!1)`
in 2.1.270). OCC has no Statsig — gated code collapses to the default — so the gated-ON
Monitor deadline behavior (Gap-126a) is what OCC must implement.

## 0. Verdict summary

| # | Official item (2.1.271 unless noted) | Verdict | Where |
|---|---|---|---|
| 1 | Monitor deadline: every monitor expires ≤30 min (10 min in `-p`), expiry notice with event count (2.1.272 gate flip) | **LAND** | §1 Gap-126a |
| 2 | `omitClaudeMd` in agent frontmatter + `--agents` JSON for custom/plugin agents | **LAND** | §2 Gap-126b |
| 3 | Bash permission: file after unrecognized option (`fmt`/`column`) | see §3 | §3 Gap-126c |
| 4 | Bash permission: wildcard in pattern/option value (`grep -v dir/* file`) | see §3 | §3 Gap-126c |
| 5 | Bash permission: variable-declaration flags misrepresenting the command | see §3 | §3 Gap-126c |
| 6 | Bash `cd`-chain/subshell/`cd`+`git` under `blockReadsOutsideWorkingDirectories` | **N/A** | §5.1 |
| 7 | `/fast off` org-disabled, SKIP_FAST_MODE_ORG_CHECK re-send, RETRY_WATCHDOG fallback, fast-in-Remote | see §4 | §4 |
| 8 | `/config` panel fullscreen mouse support | see §4 | §4 |
| 9 | sandbox per-command `allowed_domains` (Bash/PowerShell/Monitor auto mode) | see §4 | §4 |
| 10 | `claude plugin install/update --accept-command <sha256>` | **N/A** | §5.2 |
| 11 | `modelPricing`/gateway `multiplier` up to 10 | **N/A** | §5.3 |
| 12 | `self-hosted-runner --drain-marker-file` / `--host-config-snapshot` | **N/A** | §5.4 |
| 13 | Spinner status "deep in thought" @45s + "picking the thought back up" | **STAGED** | §6 |
| 14 | Org-policy cache/refresh fixes (5 entries), managed-mcp.json exclusivity, ANTHROPIC_UNIX_SOCKET policy fetch | **N/A** | §5.5 |
| 15 | Cloud/Remote/claude.ai-surface fixes (cloud subagent schema, cross-session SendMessage notice, Remote Control, artifacts, teleport, Chrome-in-cloud, desktop-app spinner tips, claude.ai skill sync cleanup) | **N/A** | §5.6 |
| 16 | Assorted local fixes (git config.lock, macOS settings watcher polling, `-p` MCP-only defer_loading, text/plain gateway reply, MCP list_changed loop, MCP OAuth registration, bare-name tool search, Ctrl+O reconnect cancel, compaction bg-command restart, /model cache warning, /reload-skills count, /resume fullscreen count, resume file-read tracking, --resume 1M window, inode-0 virtual drive, /add-dir cursor, leading-`!` fields, /hooks `__proto__` matcher crash, fullscreen stale bg color, st/rxvt keys, DA reply leak, render perf, startup validation skip, hook spinner feedback, workflow usage-limit pause, mcp serve progress, Foundry alwaysLoad, artifact markdown render) | triaged | §5.7 |

## 1. Gap-126a — Monitor deadline (LAND)

**Official evidence** (2.1.272 binary, Monitor module — byte-verbatim):

```js
var Aqe=300000,lat=3600000,o=1800000,r=600000;
function VSe(){return BAe()?r:o}   // BAe() = singleShotPrintSession()
var s="[Monitor timed out — re-arm if needed.]";
function Yq(){return py("tengu_breezy_crescent",!0)}   // gate ON by default in 2.1.272
function PMt(e){return`${Math.round(e/60000)} minutes`}
function _kr(e,t){if(t)return{timeout_ms:Math.min(e.timeout_ms,VSe()),persistent:!1}; /* legacy gate-off path */}
function Crn(e,t,n){if(!n)return s;let i=Lt(e,{hideTrailingZeros:!0});
 if(t===0)return`[Monitor expired after ${i} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`;
 return`[Monitor expired after ${i} with ${t} ${x(t,"event")} delivered. Re-arm it if you still need the watch.]`}
```

Description sentence (gate ON), replacing the old "Timeout → killed. Set `persistent: true` …":

> Every monitor expires after `timeout_ms` (default ${PMt(Aqe)}, at most ${PMt(VSe())}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set `timeout_ms` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected.

Input-schema `describe`s for `timeout_ms` ("Kill the monitor after this deadline. Default
300000ms, max 3600000ms. Ignored when persistent is true.") and `persistent` ("Run for the
lifetime of the session (no timeout)…") are **unchanged** between 2.1.270 and 2.1.272
(verified in both strings files) — the schema stays as-is; only normalization + expiry notice
+ description prose change.

**OCC port** (src/tools/MonitorTool/MonitorTool.ts): [FILLED AFTER SUBAGENT — constants
MONITOR_DEADLINE_CAP_MS=1_800_000 / MONITOR_DEADLINE_CAP_PRINT_MS=600_000, `monitorDeadlineCap()`
via `getIsNonInteractiveSession()` (= official `BAe()`), normalization forcing `persistent:false`
+ `timeoutMs=min(input ?? 300000, cap)`, always-armed kill timer, `Crn` expiry notice through
the side-channel emitter using src/utils/format.ts `hideTrailingZeros` formatter, dynamic
DESCRIPTION sentence.]

## 2. Gap-126b — `omitClaudeMd` for custom/plugin agents (LAND)

Official 2.1.271: "Added `omitClaudeMd` to agent frontmatter and `--agents` JSON, letting
custom and plugin subagents run without user, project and local CLAUDE.md files; managed
policy files still load."

Binary evidence (2.1.272; 19 `omitClaudeMd` string hits vs 6 in 2.1.270 — the 2.1.270 hits
are all built-in agents + enforcement, no custom-agent input chain):

- markdown frontmatter parse: `let pe=r.omitClaudeMd,Se=pe==="true"||pe===!0?!0:void 0`
  (placed right after the `background` parse; **no invalid-value warning**, unlike background's
  "has invalid background value" log)
- plugin agent parse: `let rt=H.omitClaudeMd,kt=rt==="true"||rt===!0?!0:void 0` + spread
  `...kt&&{omitClaudeMd:kt}`
- `--agents` JSON schema: `omitClaudeMd:P().optional()` (z.boolean) with describe "Run this
  agent without the user, project and local CLAUDE.md instruction files when it runs as a
  subagent; managed policy files are kept. For agents that take everything they need from the
  delegation prompt. No effect on the main session agent."
- frontmatter known-keys list gains `"omitClaudeMd"` (between `"background"` and `"isolation"`)
- enforcement unchanged: `Co=e.omitClaudeMd&&!U?.userContext,{claudeMd:Wr,...Zo}=Rr,zr=Co?Zo:Rr`
  — identical to OCC's existing runAgent.ts:443 `shouldOmitClaudeMd` (full `claudeMd` strip
  from userContext; "managed policy files still load" is a property of how policy CLAUDE.md is
  delivered, not of this strip).

**OCC port**: enforcement already existed (built-in Explore/Plan, prior round). This round
wires the input chain in `src/tools/AgentTool/loadAgentsDir.ts`:
1. `AgentJsonSchema`: `omitClaudeMd: z.boolean().optional()` between `background` and `isolation`
2. `parseAgentFromJson`: spread `...(parsed.omitClaudeMd ? { omitClaudeMd: parsed.omitClaudeMd } : {})`
3. `parseAgentFromMarkdown`: silent `'true' || true` parse (official has no warning for this
   key) + spread `...(omitClaudeMd ? { omitClaudeMd } : {})`
4. `BaseAgentDefinition.omitClaudeMd` doc comment updated (custom/plugin agents since 2.1.271)

OCC's `FrontmatterData` has a `[key: string]: unknown` index signature — the key passes
through the YAML parser untouched, matching the official's direct `r.omitClaudeMd` read.
Tests: `src/tools/AgentTool/__tests__/omitClaudeMd272.test.ts` (11 new; 16 pass across the
two agent-parse suites).

VERSION bumped: `src/entrypoints/cli.tsx` MACRO `2.1.270`→`2.1.272` (+ CLAUDE.md dev-mode note).

## 3. Gap-126c — Bash permission-check fixes (§3 items 3–5)

[FILLED AFTER SUBAGENT B — verdicts for A (fmt/column unrecognized-option file), B (wildcard
expansion in pattern/option value), C (variable-declaration flags), with probe evidence.]

## 4. fast mode / `/config` mouse / sandbox per-command `allowed_domains`

[FILLED AFTER SUBAGENT C.]

## 5. N/A items with root cause

### 5.1 Bash `cd`-chain fix — N/A (setting absent)
The official fix only applies under `permissions.blockReadsOutsideWorkingDirectories`. That
setting does not exist in OCC (grep-verified: zero hits in src/). The whole guarded surface
is absent, so there is nothing to fix; introducing the setting itself is a separate
(large, security-sensitive) port out of scope for a catch-up round.

### 5.2 `plugin install/update --accept-command <sha256>` — N/A (trimmed surface)
OCC removed the plugin CLI surface (Plugins/Marketplace = "Removed" per CLAUDE.md stub
table; `--plugin-url` is the only plugin-adjacent flag, HTTPS-hardened). There is no
`plugin install`/`update` command to receive the flag.

### 5.3 `modelPricing` multiplier — N/A (no managed modelPricing surface)
OCC has no `modelPricing` managed setting and no Claude-apps-gateway `pricing` block
(grep: zero hits). Pricing lives in the static `MODEL_COSTS` table. The multiplier feature
has no host to attach to.

### 5.4 `self-hosted-runner --drain-marker-file` / `--host-config-snapshot` — N/A (stub)
`src/self-hosted-runner/main.ts` is an auto-generated no-op stub
(`selfHostedRunnerMain = () => Promise.resolve()`). The runner subsystem (host drain
telemetry, host-config snapshots) is cloud/ant-only surface OCC does not implement.

### 5.5 Org-policy family — N/A (no org-policy subsystem)
The five org-policy fixes (cached policy after account switch, tool/command list refresh on
policy load, managed-mcp.json exclusivity, ANTHROPIC_UNIX_SOCKET policy fetch, policy-driven
fast-mode gating) all live in the organization-policy fetch/cache subsystem — first-party
Anthropic infra absent from OCC (no policy endpoint, no managed-mcp.json reader; grep
`orgPolicy|managed-mcp` → zero live hits).

### 5.6 Cloud / Remote / claude.ai surface — N/A
Cloud-session subagent schema fix, cross-session SendMessage delivery notices, Remote Control
empty-session cleanup, `/artifacts` persistence, `/teleport` file-read tracking, Chrome-in-cloud
messaging, desktop-app spinner tips, claude.ai skill-sync trash cleanup, fast-mode-in-Remote:
all require the claude.ai cloud/Remote-Control backend OCC does not talk to.

### 5.7 Assorted local fixes — triaged against OCC surface

Surface-presence sweep (grep over src/) sorts the remaining 2.1.271 long tail into three
buckets. Per `aligning-with-official-binary`, items with a live OCC surface still need
per-site decompilation of the official fix before porting — they are recorded STAGED with
the surface evidence, not guessed at in a catch-up round.

**N/A (no OCC surface):**
- stale `.git/config.lock` breaking git commands after failed sandbox start — zero
  `config.lock` hits in src/ (OCC never takes/clears a git config lock guard).
- macOS settings-watcher polling fallback — no settings FSWatcher/polling code in src/.
- inode-0 virtual drive agent/command loading — OCC has no inode-keyed dedup in its loaders
  (the `inode` grep hits are PowerShell/Bash validation prose, unrelated).
- workflow usage-limit pause — requires claude.ai usage-limit reset events (cloud surface);
  OCC's workflow engine has no usage-limit channel.
- Foundry/AWS `alwaysLoad` mid-conversation, artifact markdown render, Chrome-in-cloud,
  Remote Control, desktop-app spinner tips — 3P/cloud surfaces per §5.5/§5.6.

**STAGED (live OCC surface; needs per-site official decompilation before porting):**
- resumed `-p` MCP-only sessions "At least one tool must have defer_loading=false" —
  `defer_loading` lives in src/Tool.ts, src/services/api/claude.ts, src/utils/api.ts.
- MCP `list_changed` tight-loop CPU — src/services/mcp/client.ts +
  useManageMCPConnections.ts handle the notification today with no rate guard visible.
- text/plain non-streaming gateway reply — src/services/api/claude.ts parses responses;
  the official's content-type tolerance needs extraction before mirroring.
- bare-name MCP tool search match — src/tools/ToolSearchTool/ exists.
- `/hooks` menu `__proto__`/`constructor` matcher crash — src/commands/hooks exists;
  likely a `Object.prototype` lookup guard, needs the official fix site.
- `/reload-skills` count vs slash menu after `/cd` — src/commands/reload-skills/ exists.
- `--resume` dropping `[1m]` across model families — src/migrations/* handle the `[1m]`
  suffix today.
- `/resume`+`/teleport` file-read tracking carry-over — OCC resume path exists
  (readFileState rehydration in QueryEngine/print path).
- `/add-dir` cursor + Enter-adds-only-typed-path — src/commands add-dir UI exists.
- leading-`!` moved to end in non-prompt text fields — PromptInput/text-field components.
- DA-reply (`^[[?1;2c`) leaking to shell after exit/suspend — OCC's ink fork issues
  capability queries (src/ink keypress parsing references `1;2c`).
- st Delete / rxvt Alt+arrow in attached background sessions — OCC daemon attach surface.
- fullscreen stale background color after box loses bg — src/ink render pipeline.
- `claude mcp serve` 30s tool-call progress updates — src/main.tsx registers `mcp serve`.
- hook-run spinner feedback (SessionStart/UserPromptSubmit/PreToolUse/SessionEnd elapsed +
  Esc cancel) — Spinner.tsx/REPL.tsx have hook-adjacent plumbing; needs official extraction.
- compaction background-command double-start guard — OCC has bg tasks + compaction.
- `/model` cache-loss warning when switching back — /model picker exists.
- render perf + startup model-data validation skip — broad, unmeasurable without the
  official diff sites; low priority.
- MCP OAuth client-registration fixes — OCC's MCP OAuth is "Simplified" per CLAUDE.md;
  the registration lifecycle being fixed doesn't exist in OCC's form.
- Ctrl+O cancels pending MCP reconnects; `/mcp` from Remote Control — reconnect path exists,
  Remote Control half is §5.6.

## 6. STAGED — spinner status ladder ("deep in thought" / "picking the thought back up")

Official 2.1.272 spinner ladder (byte-verbatim from s2s.txt):

```js
var mr=1e4,fr=20000,pr=30000,dr=45000;
function kr(t){if(t>=dr)return"deep in thought";if(t>=pr)return"thinking some more";
 if(t>=fr)return"thinking more";if(t>=mr)return"still thinking";return"thinking"}
function Tr({attempt:t,limit:o}){return t>1?`picking the thought back up (${t} of ${o})`:"picking the thought back up"}
```

("picking the thought back up" = 0 hits in s1s → new in 2.1.271/272; 2.1.270 had
"almost done thinking" at the 45s rung.)

STAGED, not landed: OCC's spinner is an architectural divergence that predates 2.1.270 —
`src/components/Spinner.tsx` samples random verbs (`getSpinnerVerbs()`) and ships a v109-era
`THINKING_HINTS` ladder ("Hmm…", "Reticulating splines…") that exists in **neither** official
binary. The official `kr()` ladder is a time-threshold function over elapsed thinking time
whose render-assembly site (`zn`) is not decompiled; bolting the official strings onto OCC's
random-verb sampler would produce a hybrid that matches neither system — exactly the
"invent nothing" violation the skill forbids. Proper port = decompile the spinner
render assembly + recovery-attempt plumbing (`{attempt, limit}` comes from output-token-limit
recovery) first. Recorded as staged with this root cause.

## 7. Gates

[FILLED AT END — bun test totals, CI=1 bash scripts/ci-test.sh, bun run build size, live -p
smoke, tmux REPL e2e vs official uvx claude-code@2.1.272 consistency checks.]

## 8. Release

VERSION (MACRO) → 2.1.272 this round. Package version bump → 2.1.336 + CHANGELOG.md entry +
tag happen only after 验收员 approval per the issue's release flow (not in this commit).
