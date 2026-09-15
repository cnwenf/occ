# Upstream Version Gap — OCC-126 (official 2.1.270 → 2.1.272)

Round: OCC-126 version catch-up (2026-09-15/16). Baseline: OCC tracked upstream `2.1.270`
(package version 2.1.335 at round start; the parallel PR #375 self-acceptance round — see
appendix — took `2.1.336`, so this round's release tag is **v2.1.337**). Official npm
`@anthropic-ai/claude-code` dist-tags re-verified live: **`latest: 2.1.272`** (unchanged
since dispatch), `next: 2.1.273` (prerelease channel — out of scope, OCC tracks `latest`),
`stable: 2.1.236`.

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
| 3 | Bash permission: file after unrecognized option (`fmt`/`column`) | **COVERED-BY-#375** (probe-verified; OCC structurally immune to the `lM` bug class) | §3.A |
| 4 | Bash permission: wildcard in pattern/option value (`grep -v dir/* file`) | **LAND** (`pC`/`q4o` read-only augmentation port) | §3.B |
| 5 | Bash permission: variable-declaration flags misrepresenting the command | **LAND** (live parity pinned; dormant-AST charsets byte-exact 2.1.272) | §3.C |
| 6 | Bash `cd`-chain/subshell/`cd`+`git` under `blockReadsOutsideWorkingDirectories` | **N/A** | §5.1 |
| 7 | `/fast off` org-disabled, SKIP_FAST_MODE_ORG_CHECK re-send, RETRY_WATCHDOG fallback, fast-in-Remote | **LAND** (2/4 fixed; SKIP env + Remote/CCR = N/A no substrate) | §4.1 |
| 8 | `/config` panel fullscreen mouse support | **SCOPED-NOT-LANDED** (PORTABLE-LARGE; needs Ink onWheel prop + mouse test harness; occ127 candidate) | §4.2 |
| 9 | sandbox per-command `allowed_domains` (Bash/PowerShell/Monitor auto mode) | **SCOPED-NOT-LANDED** (standing OCC gap since ≤2.1.270, not a 270→272 delta; PORTABLE-LARGE, occ127 candidate) | §4.3 |
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

**OCC port** (`src/tools/MonitorTool/MonitorTool.ts`, +103/−17, subagent-implemented from the
forensics above): constants `MONITOR_DEADLINE_CAP_MS = 1_800_000` (`o`) /
`MONITOR_DEADLINE_CAP_PRINT_MS = 600_000` (`r`); `monitorDeadlineCap()` (`VSe`) keyed off
`getIsNonInteractiveSession()` (`BAe`); exported pure helpers `normalizeMonitorInput` (`_kr`
gate-ON path: forces `persistent:false`, caps `timeoutMs` at the deadline cap) and
`monitorExpiredNotice` (`Crn`, using `formatDuration(ms, {hideTrailingZeros:true})` as `Lt` +
existing `pluralize` as `x`). `call()` always arms the kill timer (no `persistent` bypass); on
expiry the `Crn` notice (with delivered-event count) goes out through the side-channel emitter
before the kill. `DESCRIPTION` const → `buildDescription()` with the dynamic deadline sentence
(`PMt` = `${Math.round(ms/60000)} minutes`; byte-level diff verified: only that one sentence
changed, prefix/suffix exact; print mode renders "at most 10 minutes"). Schema `describe`s
untouched, test-pinned. Justified deviations: `monitorExpiredNotice` drops `Crn`'s unused third
param; expiry-notice wiring is closure-private so the notice is unit-tested via the pure helper
plus a real 1000 ms-timer `call()` test proving the deadline kills even with `persistent:true`.
Tests: `__tests__/monitorDeadline272.test.ts` (new, 20 pass); pre-existing Monitor suites
untouched (8 + 16 pass); blast-radius regression `bun test src/tools src/tasks` 675 pass / 0 fail;
biome lint clean on both files.

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

All verdicts byte-verified against official 2.1.270 (`s1s.txt`) and 2.1.272 (`s2s.txt`)
linux-x64 strings + extracted `declaration_command` handler from the 2.1.272 ELF.
Commit: `56047be` (fix(bash): official 2.1.271 permission fixes).

### 3.A fmt/column unrecognized-option file reads — ALREADY-COVERED-BY-#375 (no code change)
Official 2.1.270 bug lived in extractor `lM`: a *known valued* flag consumed the following
file token even after an *unknown* flag had appeared (`lM` kept trusting flag values);
2.1.272 replaced it with the per-char `$I` classifier that sets distrust `b=!1` after any
unknown option. OCC's `filterOutFlags` **never consumes flag values** (drops every
`-`-prefixed token pre-`--`, keeps the rest), so the `lM` bug class is structurally
impossible: files after unknown flags are always extracted → validated → ask. #375 (ITEM 17,
appendix §2) wired tac/rev/fold/expand/unexpand/**fmt**/comm/cmp/pr/tsort into
`PATH_EXTRACTORS`; column/cut/paste were wired pre-#375. 9 probe tests pin the behavior
(`fmt --unknown-opt <outside>`, `fmt --weird-flag --width <outside>` — the true `lM`-miss
shape — `column -t -s, --mystery <outside>`, `cut -d, --mystery-flag`, `tac --unknown`,
`fold -w40 --nope` → ask; LIVE `Bash(fmt *)`/`Bash(column *)` → ask), all GREEN pre- and
post-edit — pure verification, no #375 file touched. Boundary (not a gap): official `QL`
includes `numfmt`, #375 excludes it — verified on coreutils 9.4 that
`numfmt --invalid=ignore /etc/passwd` echoes the operand and exits 0 **without opening it**
(numfmt takes NUMBERs, not files), so the exclusion is empirically justified.
Tests: `src/tools/BashTool/__tests__/textutilUnknownOptionRead271.test.ts`.

### 3.B wildcard expansion in pattern/option position — REAL GAP → FIXED (live path)
Official mechanism (2.1.272): `V4o` head computes `U=QL[e](n)` (extractor output),
`H=bAn(e,M,n,U)` (unextracted-glob-arg collector), `fe=F==="read"?[...U,...H]:U` — the
validation loop iterates `fe`. Legacy entry `K4o` calls with **no** SimpleCommand
(`M=undefined`), so `bAn` reduces to plain `q4o(args,U)` (git preamble gated on
`n!==void 0`; quote filter returns early on `n===void 0`). `q4o(e,n)`: push each arg whose
`pC(arg)!==-1` not already in the extracted set (deduped). `pC(t)`: index of first `*`/`?`,
or `[` with a later `]`; else `-1`.
OCC gap: `grep -v /OUT/pass* notes.txt` — the wildcard sits in grep's **pattern position**,
consumed/dropped by `parsePatternCommand`, so path validation saw only `notes.txt`; LIVE
with a `Bash(grep *)` allow rule → **auto-allow** while the shell expanded `/OUT/pass*` and
grep read those files. Official 2.1.272 asks. (Changelog: "Fixed Bash permission checks
skipping files a wildcard expands to when the wildcard sits in a command's pattern or
option value.")
Port (byte-faithful): `globCharIndex` = `pC`, `collectUnextractedGlobArgs` = `q4o`, and in
`validateCommandPaths` `paths = operationType==='read' ? [...extractedPaths,
...collectUnextractedGlobArgs(args, extractedPaths)] : extractedPaths` — mirrors official
`fe` exactly. **Read-only augmentation**: write/create commands are NOT augmented (official
routes write-globs through the `Oe`/`Ge` read-deny-rule channel OCC does not model —
augmenting there would invent stricter-than-official asks like `tee out*`). OCC's LIVE path
IS the legacy shell-quote path (TREE_SITTER_BASH not in the feature allowlist), so `q4o` is
the faithful reduction; the dormant AST path shares `validateCommandPaths` and matches
official's `argvUnquotedGlob`-absent fallback (`if(h===void 0||…)return d`) — both callers
get `q4o` semantics. Augmentation runs in step-3 `checkPathConstraints`, before step-5
prefix-allow, so it overrides allow rules — same ordering as official.
Tests: `src/tools/BashTool/__tests__/wildcardGlobArgRead271.test.ts` (6; RED-first verified —
2 live+path-layer grep-glob failures pre-fix).

### 3.C variable-declaration flags — live NO-GAP (official parity) + dormant-AST GAP → FIXED
Live path never parses declarations (legacy shell-quote): `export X=$(cat /etc/passwd)` →
command-substitution ask; `declare -x FOO=1 cat /etc/passwd` / `local -x y=2 head
/etc/shadow` → no bash-level allow in default mode (passthrough → outer flow asks). Full
extracted 2.1.272 `declaration_command` handler confirms: non-assignment operands (`cat`,
`/etc/passwd`) are merely `x.push(D)`'d onto argv with no path check; `declare` is not
path-restricted (`K4o` passthrough); bash never executes `cat` (invalid identifier → declare
errors, no read). OCC allowing under `Bash(declare *)` = **official parity** (pinned by tests).
Dormant AST gap: OCC charset `/^-[a-zA-Z]*[niaA]/` was narrower than official 2.1.270
(`[niaAEF]`) **and** 2.1.272 (`[nialuAEFLRZ]`), lacked the export/readonly branch
(`[iluEFLRZ]`), and had a stale reason string (`(nameref/integer/array)` — 2.1.270 already
said `float`). Fixed to byte-exact 2.1.272: declare/typeset/local `/^[+-].*[nialuAEFLRZ]/`
with reason `declare flag ${arg} changes assignment semantics
(nameref/integer/float/array/width-truncation/case-conversion)`; new export/readonly branch
`/^[+-].*[iluEFLRZ]/` with reason `${argv[0]} flag ${arg} — zsh bin_typeset mathevals
(-i/-E/-F), width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`
(em-dash = `—`, verbatim). Added l/u/L/R/Z = flags that **mutate the assigned value**,
so a tracked `NAME=value` literal would misrepresent later `$var` expansion (changelog:
"cannot misrepresent the command being run"). `[+-]` covers plus-form. Out of scope
(documented, unchanged): `-m` pattern-assign, `-f`+`-u` autoload, `-T` tied-pair, export
subscript checks — all present in official **2.1.270** strings, i.e. pre-existing OCC
narrowing predating 2.1.271, not part of this round's delta.
Tests: `src/tools/BashTool/__tests__/declarationFlagCharset271.test.ts` (16; 12 RED→GREEN).

### 3.D cd-chain / `blockReadsOutsideWorkingDirectories` — N/A-ARCHITECTURE (confirmed)
See §5.1: the official double-cd/subshell fix is gated on
`permissions.blockReadsOutsideWorkingDirectories===!0`; **0 occurrences** in OCC `src/` and
`test/` (grep re-confirmed this round). Nothing to port.

Gates: biome clean on all 5 touched files; `src/tools/BashTool/__tests__/` + `src/utils/bash/`
**451/0** (28 files); `src/utils/permissions/__tests__/` **163 pass/1 skip/0**;
e2e `version-2.1.98-160-bashperm-safety-gaps` **10/0**; 35 new tests green.

## 4. fast mode / `/config` mouse / sandbox per-command `allowed_domains`

Commit (area 1): `2a38a10` (fix(fast): official 2.1.272 fast-mode fixes).

### 4.1 fast mode fixes — PORTABLE-SMALL → LANDED (2 of 4 sub-items; 2 N/A)
- **`/fast off` under org disable — FIXED.** Official 2.1.272 gates the refusal on the enable
  argument: `let d=Sz(...); if(d&&e) return {kind:"refused", refusal:\`Fast mode
  unavailable: ${d}\`}` (2.1.270 had ungated `if(M)`, so `/fast off` answered "Fast mode
  unavailable" instead of turning off). OCC `fast.tsx` `handleFastModeShortcut` now
  `if (enable && unavailableReason)`.
- **Retry-watchdog interaction — FIXED.** 2.1.270 gated the whole fast retry block on `!VM()`
  (CLAUDE_CODE_RETRY_WATCHDOG off), so under the watchdog a usage-credits/overage 429 fell
  through to `shouldRetry` → CannotRetryError (turn failed instead of falling back to
  standard speed) and overload retried forever at fast speed. 2.1.272 drops the gate,
  captures `let Yn=sM()` before the block, and: silent short-retry sleep only when NOT under
  watchdog (`if(Jn&&!Yn){await Q(ar,...);continue}`); cooldown (standard-speed fallback)
  only for non-short retries (`if(!Jn){...}`); every fast-path `continue` clamps the attempt
  counter (`if(Yn&&pt>=s)pt=s`). Ported to `withRetry.ts` as `watchdogRetryEnabled =
  isRetryWatchdogEnabled()` + `isShortRetry && !watchdogRetryEnabled` gate + `!isShortRetry`
  cooldown wrap + three attempt clamps. OCC keeps its pre-existing
  `!isPersistentRetryEnabled()` gate (dead in production — UNATTENDED_RETRY not enabled —
  preserves documented persistent-mode behavior).
- **N/A: `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK`** — env var has zero substrate in OCC.
- **N/A: Remote/CCR fast mode** — no `user:ccr_inference` path in OCC.
Tests: `fastOff271.test.ts` + `fastModeWatchdogRetry271.test.ts` (8 new; RED-first verified —
4 fail without the fix); area suite 82 green; biome clean.

### 4.2 `/config` mouse support — PORTABLE-LARGE → SCOPED, NOT LANDED (occ127 candidate)
Genuine 2.1.271 addition (official `onWheel:yg`/`hg`, row `onClick:Sg`, value `onClick:bg`,
hover `to`/`oi` — byte-evidenced in s2s only). OCC's Ink fork has click/hover infra and
already wheels via keybindings, but a faithful port needs: an `onWheel`/`deltaY` Box prop
OCC's Ink lacks; a `toggleSetting` index refactor with two click semantics + guards; hover
state; and — the gate blocker — a component-level mouse-dispatch test harness OCC doesn't
have. Per round scope (no large subsystem builds), scoped and documented instead.

### 4.3 sandbox per-command `allowed_domains` — PORTABLE-LARGE → SCOPED, NOT LANDED (occ127 candidate)
Official feature **already existed in 2.1.270** (identical strings/logic across s1s/s2s) —
this is a standing OCC-vs-official gap, not a 2.1.270→2.1.272 delta. Official symbols
documented (`j2e`/`Uj`/`z2e`/`W2e`/`UXt`). OCC has only the session-level allowlist; missing:
per-command input schema, the live `customConfig` path (`Shell.ts:264` passes `undefined`),
the permission-review surface, the `W2e` guards, and Monitor sandboxing (raw `Bun.spawn`
today — a prerequisite project). Scoped and documented instead.

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
- ~~`/hooks` menu `__proto__`/`constructor` matcher crash~~ — **LANDED via PR #375**
  (appendix ITEM 45: null-prototype buckets in `groupHooksByEventAndMatcher`, 5 tests).
- `/reload-skills` count vs slash menu after `/cd` — src/commands/reload-skills/ exists.
- `--resume` dropping `[1m]` across model families — src/migrations/* handle the `[1m]`
  suffix today.
- `/resume`+`/teleport` file-read tracking carry-over — **LANDED via PR #375** (appendix
  ITEM 35: `readFileState.current.clear()` before merge in REPL resume, 4 tests).
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

All gates run this round on branch `agent/occ/db9aaf96` (post merge `078019d` of origin/main
f0f45d0/PR #375), commits `809bc1b` + `27f4105` + `56047be` + `2a38a10` + docs commit.

| Gate | Result |
|---|---|
| New-test RED-first verification | Monitor 20 (RED-first per §1), omitClaudeMd 11, Bash-perm 35 (16 RED pre-fix), fast-mode 8 (4 RED pre-fix) — all GREEN post-fix |
| Area suites (coordinator re-run) | 5 new 271/272 test files: **43 pass / 0 fail** |
| BashTool + bash utils (Agent B) | **451 pass / 0 fail** (28 files) |
| Permissions (Agent B) | **163 pass / 1 skip / 0 fail** (13 files) |
| e2e bashperm-safety (Agent B) | **10 pass / 0 fail** |
| fast-mode area suite (Agent C) | **82 pass**, biome clean |
| Full CI sweep `CI=1 bash scripts/ci-test.sh` (per-file isolation) | **4073 pass / 1 fail / 114 skip** (472 files) |
| `bun run build` | green — `dist/cli.js` 29.06 MB, injected MACRO.VERSION=2.1.336 (pkg release version, by design; dev-mode polyfill prints tracked 2.1.272) |
| `test/e2e/occ-versioning.e2e.test.ts` | **1 pass / 0 fail** |
| Live `-p` smoke (dashscope gateway, qwen3.8-max) | `bun dist/cli.js --version` → `OCC 2.1.336`; `-p "Reply with exactly one word: OK"` → `OK` |
| Dual tmux REPL e2e vs **official 2.1.272** | see below — all parity checks pass |

The single CI failure is `test/e2e/feedback-ai.e2e.test.ts` ("live agent files an issue via
fake gh"): a **known environmental live-model failure** — this exact file is in the
clean-tree-A/B-verified environmental set documented in `docs/upstream-version-gap-occ107.md`
§4a (re-confirmed in occ108/occ110/occ119 ledgers) and is `skipIf(CI||!TOKEN||!BASE_URL)` in
real CI. This round's failure mode is live-model decision drift (the model reasoned the `gh`
shim's fake URL meant "cannot really create issue" and posted a fallback link / left the
captured body empty, across two attempts with different signatures). Zero intersection with
this round's changed modules (`/feedback` flow untouched; pathValidation augmentation applies
only to read-op PATH_EXTRACTORS commands, `gh` not among them).

**Dual tmux REPL e2e method** (correcting the placeholder wording: the official reference is
NOT uvx — `uvx claude-code` is unusable here and the global npm install is stale 2.1.218; the
reference is the **extracted official 2.1.272 linux-x64 ELF** `/tmp/cc-diff-126/vver/package/claude`
from `npm pack @anthropic-ai/claude-code-linux-x64@2.1.272`). Two tmux sessions, same cwd
`/tmp/accept-repo-126`, separate HOMEs (`/tmp/home-occ` vs `/tmp/home-official`), same
dashscope gateway env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL=qwen3.8-max`):

1. **Trust dialog**: byte-identical layout/copy on both ("Quick safety check…", `❯ No, exit` /
   `Yes, I trust this folder`, `Enter to confirm · Esc to cancel`). ✔
2. **Main screen**: auth-conflict warning (both ANTHROPIC_AUTH_TOKEN + ANTHROPIC_API_KEY set)
   rendered equivalently; model line `qwen3.8-max · API Usage Billing`; cwd line; `● high ·
   /effort` indicator; `⏸ manual mode on` footer — all present on both (OCC footer adds
   `(shift+tab to cycle)`, pre-existing accepted delta; official adds `? for shortcuts · ←
   for agents` hints, an official-side tips surface). ✔
3. **Live round-trip**: identical prompt `reply with exactly: PONG` → both rendered
   `● PONG` (official additionally shows its `Thought for 2s` / `Churned for 3s · done`
   spinner telemetry lines — official-side cosmetic). ✔
4. **`/status`**: same field structure (Version / cwd / Model); OCC shows `2.1.336` (its own
   release version — the documented dual-versioning scheme: pkg release vs tracked upstream
   MACRO `2.1.272`, which `bun run dev` prints), official shows `2.1.272`. Expected-by-design,
   not a gap. ✔

Monitor deadline behavior (§1) not exercised live in the REPL (would need a ≥1 min real
watch); pinned instead by the 20-test suite incl. a real 1000 ms-timer `call()` test proving
the deadline kills even with `persistent:true`.

## 8. Release

VERSION (MACRO) → 2.1.272 this round; README "Tracks" badge 2.1.270 → 2.1.272 (byte-verified
catch-up complete, unlike the appendix round which correctly left the badge at 2.1.270).
Package version: PR #375 (appendix) already took `2.1.336` on main, so this round's release
tag is **v2.1.337** — bump + CHANGELOG.md entry + tag happen only after 验收员 approval per
the issue's release flow (not in this commit).

---

# Appendix — PR #375 strict self-acceptance round (landed on main, 2026-09-16)

> The section below is the complete ledger of the parallel OCC-126 strict self-acceptance pass (PR #375, OCC release 2.1.336), preserved verbatim after the add/add merge. Its 3 landed fixes (ITEM 17 fmt/column-family read extractors, ITEM 45 hook-matcher `__proto__`, ITEM 35 resume read-tracking) overlap entries triaged in Part A §5.7; where both rounds touch the same official 2.1.271 entry, Part A records the byte-verified binary forensic state and the appendix records what PR #375 already shipped. One correction to the appendix, superseded by Part A: the official 2.1.271/2.1.272 linux-x64 ELF **was** recoverable in this environment (npm tarball → `/tmp/cc-diff-126/vver/package/claude`), so the byte-verified port proceeded in Part A; the appendix's "cannot be downloaded" verdict reflects PR #375's sandbox at its run time, not the final round state.

# Upstream Version Gap — OCC-126 (official 2.1.270 → 2.1.272 gap; strict self-acceptance lands 3 corroborated security/crash fixes)

- **Round:** OCC-126 (autopilot 版本追齐, 2026-09-16 — Multica issue **OCC-87**)
- **OCC aligned-at (round start):** official Claude Code `2.1.270` — OCC release `2.1.335` (tags == releases)
- **Official latest (round check, live npm re-verify):** `@anthropic-ai/claude-code` dist-tags → `latest: 2.1.272`, `next: 2.1.273`, `stable: 2.1.236`. Publish times: `2.1.270` 2026-09-12, `2.1.271` 2026-09-14T19:45Z, `2.1.272` 2026-09-14T23:34Z, `2.1.273` 2026-09-15T18:06Z (`next`-channel prerelease, **not** `latest`). So OCC is **2 releases behind `latest`** (2.1.270 → 2.1.271 → 2.1.272), with a 2.1.273 prerelease on `next`.
- **Acceptance environment:** dashscope gateway (`ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`, model `qwen3.8-max`); OCC build `dist/cli.js`, `occ --version` → `OCC 2.1.335` at round start (→ `2.1.336` after this round's bump). Live e2e driven through a real tmux REPL (TTY preserved) + headless `-p`.

**Verdict summary:** Official advanced to `2.1.272`, but the official linux-x64 ELF **cannot be downloaded/decompiled in this environment**, so a byte-verified port of the 2.1.271/2.1.272 surface is impossible here — per the `aligning-with-official-binary` discipline ("Never invent", "STOP when ambiguous in the binary") **no invented/partial official port was landed** and the README "Tracks" badge stays at `2.1.270`. The round therefore took the issue's **"无 gap 可验证 → 严格自验收"** branch: a strict self-acceptance pass over OCC's own source + live REPL on real tasks, prioritizing recently-added features. That pass **independently discovered and fixed 3 genuine security/crash bugs in OCC source** — and all 3 map *exactly* onto official **2.1.271** changelog entries (independent corroboration that these are real parity fixes, not inventions). 3 LAND (ITEM 17 / 45 / 35), the rest of the 2.1.271 security set STAGED for occ127 pending binary verification, `2.1.272` is a no-op ("Bug fixes and reliability improvements" — no portable surface), `2.1.273` is a `next` prerelease (out of scope). Release `2.1.336` cut (3 real fixes — unlike OCC-40's no-op, this warrants a patch release).

---

## 1. Version gap triage — official 2.1.270 → 2.1.271 → 2.1.272 (→ 2.1.273 next)

| Release | Date | Surface | This-round disposition |
|---|---|---|---|
| `2.1.271` | 2026-09-14 | ~85 changelog entries (substantive; security-heavy) | **Researched at changelog level; byte-verified port STAGED** (no ELF access here). 3 entries independently landed via self-acceptance (§2–§4); the remaining security set staged for occ127 (§5). |
| `2.1.272` | 2026-09-14 | "Bug fixes and reliability improvements" (no itemized entries) | **NO-OP** — no portable named surface to triage; nothing to port without the binary. |
| `2.1.273` | 2026-09-15 | `next`-channel prerelease (not `latest`) | **Out of scope** — OCC tracks `latest`, not `next`. Recorded for awareness only. |

**Why no byte-verified port this round.** Every prior catch-up round (OCC-122/123/124/125) recovered landed strings/constants verbatim from the official linux-x64 ELF (e.g. "byte-verified from the official 2.1.270 ELF"). This environment cannot download/decompile the 2.1.271/2.1.272 ELF, so the per-site forensics those ports require are unavailable. Landing changelog-prose-only re-implementations would violate the repo's "Never invent / no invented/partial" discipline (the same rule that made OCC-40 refuse a no-op release). The honest outcome: document the gap, land only what is verifiable from OCC's own source, and stage the rest.

## 2. ITEM 17 — read-only text-util path-validation bypass (LAND)

**Official 2.1.271 corroboration:** *"Permission review includes files read by formatting/column utilities after unrecognized options"* — **security fix, Bash/permissions.** Discovered independently from OCC source during self-acceptance; the official shipped the same class of fix in 2.1.271.

**The bug (OCC source).** Ten read-only text utilities — `tac, rev, fold, expand, unexpand, fmt, comm, cmp, pr, tsort` — were listed in `READONLY_COMMANDS` (`src/tools/BashTool/readOnlyValidation.ts`, so `BashTool.isReadOnly()` returns true) but were **absent** from `PATH_EXTRACTORS` / `COMMAND_OPERATION_TYPE` / `ACTION_VERBS` / the `PathCommand` union in `src/tools/BashTool/pathValidation.ts`. The permission pipeline `bashToolCheckPermission` (`src/tools/BashTool/bashPermissions.ts`) runs `checkPathConstraints` at **step 3** (which only validates commands in `SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS)`) and the read-only auto-allow at **step 7** (`if (BashTool.isReadOnly(input)) return allow`). An unrecognized command therefore fell *through* step 3 to `passthrough`, then step 7 **auto-allowed it with no prompt** — even when the file argument pointed **outside** the session's working directories. Concrete pre-fix bypass: `fmt /etc/passwd` (or any of the ten on an outside path) silently exfiltrated a file the user never approved a read for — the exact guarantee `cat`/`head`/`tail` already enforce.

**The fix** (`src/tools/BashTool/pathValidation.ts`, +58 lines, all four maps):
- `PathCommand` union — added the 10 names (line ~65-66, after `| 'tee'`).
- `PATH_EXTRACTORS` — added `tac/rev/fold/expand/unexpand/fmt/comm/cmp/pr/tsort: filterOutFlags` (lines ~375-384, after `md5sum`), mirroring `cat`/`head`/`tail`. A long SECURITY comment (line ~361) documents the `fmt /etc/passwd` exfil vector and the deliberate exclusions.
- `ACTION_VERBS` — per-command prompt verbs (lines ~645-654, e.g. `fmt: 'format text from files in'`).
- `COMMAND_OPERATION_TYPE` — all 10 → `'read'` (lines ~696-705).
- `COMMAND_VALIDATOR` is `Partial<Record<…>>` — intentionally **not** edited (no exhaustiveness requirement; none of the ten has a `--target-directory`-class flag needing a custom validator).

**Deliberate exclusions** (`numfmt`/`readlink`/`realpath`/`basename`/`dirname`): kept read-only-auto-allow only. Their primary arguments are numbers or command names, not file paths, so path-extracting them would false-positive (e.g. `readlink -f /usr/bin/python` prompting on a binary that is not a document read). The security reviewer confirmed none can read arbitrary file **contents** (`numfmt` parses operands as numbers; `basename`/`dirname` are pure string ops; `readlink`/`realpath` emit resolved paths/symlink targets — metadata, not contents). See the SECURITY note in `pathValidation.ts`.

**Tests** — `src/tools/BashTool/__tests__/readonlyTextutilPathValidation.test.ts` (6 tests, mirrors `teeWritePath269.test.ts`): all 10 in `PATH_EXTRACTORS` (typeof function) + all 10 `'read'` in `COMMAND_OPERATION_TYPE`; `filterOutFlags` behavior (`fmt(['-s','/x/file.txt'])` → `['/x/file.txt']`, `pr(['--','-weird'])` → `['-weird']`); `checkPathConstraints({command:'<cmd> <outside>/secret.txt'})` → `'ask'` with message containing "was blocked" + "the allowed working directories" for all 10; in-workdir → `'passthrough'`; `/usr/bin/fmt <outside>` → `'passthrough'` (documents the pre-existing canonicalization boundary — `canonicalizePathCommandName` only basenames `tee`/`rm`/`rmdir`; the path-prefixed form is gated by the step-8 prompt since the READONLY regexes are `^cmd`-anchored, fail-closed and identical to `/usr/bin/cat`).

## 3. ITEM 45 — hook-matcher prototype-key crash (LAND)

**Official 2.1.271 corroboration:** *"Hooks menu no longer crashes when matcher names resemble built-in object properties"* — **bug fix, hooks/UI.** Discovered independently from OCC source; the official shipped the same fix in 2.1.271.

**The bug (OCC source).** A hook config's `matcher` is an unvalidated `z.string()` (`src/schemas/hooks.ts`), so a malicious settings/session hook can set `matcher: "__proto__"` (or `"constructor"`/`"prototype"`). `groupHooksByEventAndMatcher` (`src/utils/hooks/hooksConfigManager.ts`) built plain `{}` inner buckets keyed by that matcher:

```ts
if (!eventGroup[matcherKey]) eventGroup[matcherKey] = []
eventGroup[matcherKey].push(hook)
```

For `matcherKey === "__proto__"`, `eventGroup["__proto__"]` reads through `Object.prototype` (it *is* `Object.prototype`, truthy), so the `= []` init is **skipped** and `.push(hook)` runs on a non-array → "push is not a function", **crashing the `/hooks` menu** and all hook grouping. (`matcherKey = "__proto__"` on the assignment path would instead re-point the bucket's prototype.)

**The fix** (`src/utils/hooks/hooksConfigManager.ts`, +18 lines): after the `grouped` literal, re-create every inner bucket with a null prototype so attacker-chosen keys become inert own properties:

```ts
for (const event of Object.keys(grouped) as HookEvent[]) {
  grouped[event] = Object.create(null) as Record<string, IndividualHookConfig[]>
}
```

(comment at line ~344, loop at line ~356). The **outer** `grouped` object stays a normal literal — `event` is `z.enum(HOOK_EVENTS)`-validated, so the outer keys are not attacker-controlled (the security reviewer verified all three event-key sources are enum-bounded: settings files via `z.partialRecord(z.enum(HOOK_EVENTS),…)` — a `__proto__` event key is silently stripped, `constructor` fails the whole file → fail-closed; session hooks via `for (const event of HOOK_EVENTS)`; plugin hooks via `PluginHooksSchema`→`HooksSchema`).

**Tests** — `src/utils/hooks/__tests__/hooksMatcherPrototypeKey.test.ts` (5 tests): (1) vulnerability characterization — a plain `{}` bucket crashes on a `__proto__` matcher (reproduces the exact pre-fix bug), a null-proto bucket defuses `__proto__`/`constructor`/`prototype`; (2) the real `groupHooksByEventAndMatcher` returns null-proto buckets (`Object.getPrototypeOf(grouped[event]) === null`), attack keys inert; (3) end-to-end — a session hook with `matcher:'__proto__'` under `PreToolUse` keyed by `getSessionId()` flows through grouping without throwing, asserted via `Object.hasOwn(bucket, '__proto__')`. The security reviewer exhaustively grepped all bucket consumers (`getHooksForMatcher`, `getSortedMatchersForEvent`, `sortMatchersByPriority`, `HooksConfigMenu.tsx`, `SelectMatcherMode.tsx`) — all use index-access/`Object.keys`/`entries`/`values`; **zero** `hasOwnProperty`/`toString`/`valueOf`/`isPrototypeOf` calls on buckets; buckets are UI-transient (never `JSON.stringify`'d/persisted/spread). No consumer breaks.

## 4. ITEM 35 — in-session `/resume` read-tracking leak (LAND)

**Official 2.1.271 corroboration:** *"Resume/teleport no longer keeps old file-read tracking that could allow edits not read in the resumed chat"* — **security fix, resume/file tracking.** Discovered independently from OCC source; the official shipped the same fix in 2.1.271.

**The bug (OCC source).** `restoreReadFileState` (`src/screens/REPL.tsx`) rebuilds the read-before-edit tracking cache from a transcript and runs on **two** paths — the mount path (CLI `--resume-session`, fresh process, empty cache) and the **in-session `/resume`** path (switching conversations mid-process). It did:

```ts
readFileState.current = mergeFileStateCaches(readFileState.current, extracted)
```

`mergeFileStateCaches(first, second)` (`src/utils/fileStateCache.ts`) **clones `first`** then overlays `second`. On the in-session path `first` still holds the **previous (abandoned) conversation's reads**, so a merge-only restore leaked them into the resumed session: the read-before-edit guard would then accept an edit to a file the model only read in the abandoned conversation, never in the one it resumed into. (The `resume` callback does **not** run `clearConversation` before `restoreReadFileState`, so the stale cache survives.)

**The fix** (`src/screens/REPL.tsx`, +10 lines): clear before merging, matching the `/clear` (`src/commands/clear/conversation.ts`) and compact (`src/services/compact/compact.ts`) idiom:

```ts
readFileState.current.clear();
readFileState.current = mergeFileStateCaches(readFileState.current, extracted);
```

(comment at line ~2077, `clear()` at line ~2086, merge at line ~2087). On the mount path the cache is freshly created (empty), so `clear()` is a provable no-op (also idempotent under effect re-runs / StrictMode double-effect). The LRU is **not** reallocated (avoids the ~170 ms constructor cost). `bashTools.current` is intentionally **not** cleared — its only consumer is `tipRegistry.ts` (tip suppression), zero permission/security role; `/clear` clears it separately, so leaving it on resume is at most a cosmetic tip inconsistency, not a vulnerability.

**Tests** — `src/utils/__tests__/resumeReadFileStateClear.test.ts` (4 tests, pins the invariant at the unit-testable seam — the real `FileStateCache` + `mergeFileStateCaches`): merge-only (pre-fix) LEAKS a prior read; clear-then-merge (post-fix) restores exactly the resumed transcript; clear preserves a file the resumed transcript also read (newer timestamp wins); mount-path empty-cache clear+merge is a correct no-op (`merged.size === 1`).

## 5. STAGED — remaining official 2.1.271 security set (occ127 candidates, pending binary verification)

The 2.1.271 changelog carries several more security fixes in the same hardening theme. Each needs per-site ELF decompilation to port faithfully (unavailable here), so all are STAGED — **not** guessed. OCC exposure must be audited per-site before any port:

| Official 2.1.271 entry | Subsystem | OCC note |
|---|---|---|
| "Files produced by **wildcard expansion** are included in shell permission checks" | Bash/permissions | Audit OCC's glob-expansion path against `checkPathConstraints`. |
| "**Variable-declaration flags** can no longer hide the actual command during permission checks" | Bash/permissions | Audit `var x=1; cmd` / `env`-prefix forms in the legacy + AST paths. |
| "Certain **directory-change/subshell/git chains** no longer bypass the outside-workdir read prompt" | Bash/sandbox | Audit `cd /outside && git …` / `( … )` chains. |
| "**Auto-mode inline shell actions** from skills/commands follow default-mode permission rules" | auto mode/permissions | `BASH_CLASSIFIER` is in OCC's FEATURE_ALLOWLIST → likely live; audit. |
| "**Subagent completion** now uses a classifier-reviewed hand-back call" | auto mode/subagents | `TRANSCRIPT_CLASSIFIER` is live; audit `runAgent.ts` hand-back. |
| "**MCP OAuth** client registration handles consent denial, redirect mismatches, concurrent writes" | MCP/OAuth | OCC's MCP OAuth is "simplified" (CLAUDE.md) — verify the registration path exists before porting. |
| "**Org policy** no longer stays cached after credential changes" | org policy/auth | Verify OCC's policy-cache invalidation. |
| "**Signed-out synced skills** are cleaned up instead of persisting indefinitely" | skills/data retention | Audit OCC skill-sync retention. |
| "Unreadable enterprise **managed MCP** config still enforces exclusive MCP control" | MCP/enterprise | OCC trims enterprise/managed surface — likely no-op; verify. |
| "Gateway/Bedrock/Vertex/Foundry sessions no longer refresh unused leftover web logins" | auth/gateway | OCC trims much of this — likely no-op; verify. |

The bulk of the remaining ~75 entries touch subsystems OCC trims by design (cloud/Remote-Control sessions, Claude Tag, VS Code, artifacts publishing, self-hosted runner, mobile QR, Code Review cloud, Windows/PowerShell) → **no-op for OCC**; a few UI/spinner/workflow items may be portable and are left for occ127 triage against the binary.

## 6. Strict self-acceptance results (the issue's "无 gap → 严格自验收" branch)

The self-acceptance pass used OCC's **own REPL on real tasks**, prioritizing recently-added features, focused on consistency with the official. It surfaced the 3 bugs above (each then verified from OCC source alone). Live e2e (all green, against the round's built `dist/cli.js`):

| Surface | Method | Result |
|---|---|---|
| Headless `-p` | `echo "say PONG" \| bun dist/cli.js -p` | PASS — `PONG`, exit 0 (live API key) |
| REPL boot | bare `bun dist/cli.js` in tmux (TTY preserved) | PASS — banner "OCC v2.1.335 · Open C Code" |
| `/hooks` menu (ITEM 45 surface) | tmux REPL `/hooks` | PASS — renders "28 hooks configured" (exercises the fixed `groupHooksByEventAndMatcher` live; no crash) |
| Live model round-trip | tmux REPL "reply with exactly: REPL_OK" | PASS — "● REPL_OK" (57436 tokens) |
| Non-PTY e2e suite | `bun test test/e2e` (non-PTY) | PASS — 10 pass |

**Note on the PTY e2e:** `resume-command-name.e2e` (a PTY test) stalls at its 20 s timeout — git-stash A/B-verified to fail **identically on clean HEAD** (same line, same 20010 ms). This is the documented OCC-11 sandbox constraint ("Live TUI/REPL acceptance e2e is deferred to a non-sandbox environment"), **not** a regression from this round. The live REPL acceptance above was therefore driven through a real tmux session rather than the PTY harness.

## 7. Unit + regression gates

- **New unit tests:** 15 total — ITEM 17 (6) + ITEM 45 (5) + ITEM 35 (4) — **15 pass / 0 fail / 128 expect()**.
- **Regression sweeps (zero new failures):**
  - `src/tools/BashTool/` — **406 pass / 0 fail**.
  - `src/utils/hooks/` — **96 pass / 0 fail**.
  - `src/utils/__tests__/` — **814 pass / 12 fail**; the 12 (`mcpNeedsAuthNotice.test.ts`) are **pre-existing cross-file suite pollution** — git-stash A/B-verified byte-identical (clean HEAD = 810/12, with this diff = 814/12; the +4 pass are my new test, +0 fail), and the file passes 19/19 standalone.
  - permissions **163/163**, compact **21/21** (security reviewer's independent re-run).
  - e2e — **10 pass / 1 fail** (the 1 = the pre-existing PTY stall, §6).
- **Lint:** `biome lint` on the 3 changed source files + 3 new test files — **0 new warnings**. (One `noPrototypeBuiltins` warning my test initially triggered was fixed to `Object.hasOwn`; the 8 remaining repo-wide warnings are pre-existing REPL.tsx "unused biome-ignore suppression" noise — identical count on `git show HEAD:src/screens/REPL.tsx`, my edit added 0 biome-ignore lines.)
- **Build:** `bun run build` green (`dist/cli.js` ~29 MB); rebuilt after the version bump to confirm `2.1.336` compiles clean.

## 8. Security review (ecc:security-reviewer, run synchronously on the diff)

**Verdict: all three fixes CONFIRMED-SOUND. No CRITICAL/HIGH/MEDIUM. "Ship it."** The reviewer traced each fix end-to-end (live permission-pipeline probes for ITEM 17, exhaustive consumer grep for ITEM 45, merge-semantics proof for ITEM 35) and A/B-verified the regression baseline. **No new vulnerability introduced; no remaining bypass in the landed scope; no regression.** Four LOW findings:

1. **LOW (pre-existing, next-round):** `du` (and secondarily `readlink`/`realpath`) remain in `READONLY_COMMANDS` without `PATH_EXTRACTORS` → unprompted outside-workdir **metadata** disclosure (dir names/sizes, symlink targets — not file contents). Same class as ITEM 17; **staged for occ127** (§5 theme). Not introduced by this diff.
2. **LOW (fixed this round):** the ITEM 17 test comment misattributed the `/usr/bin/fmt` gate to "read-only auto-allow"; it is actually the **step-8 prompt** (READONLY regexes are `^cmd`-anchored, so `/usr/bin/fmt` does not match `isReadOnly`). Comment corrected; behavior is fail-closed and at parity with `/usr/bin/cat`.
3. **LOW (style, not a defect):** ITEM 45 re-creates buckets in place after the literal rather than building them null-proto initially. Object-literal syntax can't express null-proto buckets directly; the in-place loop is clear and documented. No change.
4. **LOW (pre-existing, fail-closed):** ITEM 35 — resume clears `readFileState` but not `loadedNestedMemoryPathsRef`/`discoveredSkillNamesRef` the way compact/`/clear` do. Fail-closed direction only (the model must `Read` before editing a nested CLAUDE.md). Not changed by this diff; recorded as an observation.

## 9. Release

3 genuine security/crash fixes landed (corroborated by the official 2.1.271 changelog) → a real patch release is warranted (unlike OCC-40's no-op, which correctly refused to bump). Flow per the issue body + CLAUDE.md "Release Workflow":

1. `CHANGELOG.md` — add `## 2.1.336 - 2026-09-16 (OCC-126)` section (this round's 3 fixes + the staged 2.1.271 set).
2. `package.json` — bump `2.1.335` → `2.1.336` (monotonic; OCC's own counter, independent of the upstream "Tracks" badge).
3. README "Tracks: Claude Code **2.1.270**" badge — **unchanged** (no full byte-verified catch-up to 2.1.271/2.1.272 this round; landing 3 corroborated parity fixes does not warrant claiming 2.1.272 alignment).
4. Commit → merge to `main` → `git tag v2.1.336` → push tag → `.github/workflows/publish.yml` (build → set version → npm publish → Create GitHub Release).
5. Acceptance: `gh api repos/cnwenf/occ/releases` count == `/tags` count, `comm -23 <(tags) <(releases)` empty; report the Release link back to the issue.

## 10. Round mapping note

Multica daily-issue numbers (OCC-84/85/87) and repo-internal round numbers (OCC-122…126) are **two interleaved sequences**. This Multica issue **OCC-87** maps to repo round **occ126** (this ledger). README cross-references both.