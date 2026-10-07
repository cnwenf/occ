# Upstream Version Gap — OCC-149 (2026-10-08 round)

**Round:** autopilot daily (triggered 2026-10-08 01:00 Asia/Shanghai), issue
OCC-149 `026f09ca-9959-41f8-a672-a613ee2206ac`.
**Official:** `2.1.291` → **`2.1.292`** (published 2026-10-06T17:10:31Z, npm
`latest`+`next`; GitHub release `v2.1.292`; ~95 changelog entries).
**OCC:** package `2.1.373` (≙ official 2.1.291) → **`2.1.374`** (≙ 2.1.292).
**Base:** origin/main `9d16235` (chore(release): 2.1.373), branch
`agent/occ-leader/77562aa6`.
**Method:** upstream-tracking skill — changelog triage + byte-forensics on the
official `2.1.292` linux-x64 ELF (`@anthropic-ai/claude-code-linux-x64@2.1.292`,
251,456,696 bytes; binary deleted from /tmp after extraction per skill rule).

## §0 — Round summary

| # | Official 2.1.292 item | OCC landing | Tests |
|---|---|---|---|
| P1 | MCP tool name >128 chars fails every request → tool left out + MCP error names it | `src/services/mcp/mcpToolNameFilter.ts` (new) + `src/Tool.ts` + `src/services/api/claude.ts` | 9 |
| P2 | `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` env var | `src/services/api/withRetry.ts` | 18 |
| P3 | Agent tool `effort` parameter | `src/tools/AgentTool/AgentTool.tsx` + `runAgent.ts` | 5 |
| P4 | Read PDF `pages` list ("6,9,15") silently read first entry → strict error | `src/utils/pdfUtils.ts` + `src/tools/FileReadTool/FileReadTool.ts` | 18 |
| P5 | @-mentioned text files >256KB left out silently → size + read-in-portions notice | `src/utils/attachments.ts` + `src/components/messages/AttachmentMessage.tsx` + `src/utils/messages.ts` | 7 |
| P6 | NO_PROXY ignored for own API requests when HTTPS_PROXY set | `src/utils/proxy.ts` + `src/services/mcp/client.ts` (4 wiring sites) | 18 |

**75 new tests, all passing isolated and in-suite.** Zero regressions: full
`bun test src` failure set is byte-identical to the clean-HEAD baseline
(§9.1). P7 (occ148 STAGED #018 WebFetch offset) re-staged with completed
top-level forensics (§8).

## §1 — P1 LANDED: MCP tool-name >128 filter (official `o9e`)

Changelog: *"Fixed an MCP tool with a name longer than 128 characters making
every request fail; that tool is now left out and an MCP error names it."*

Byte-faithful port of official `o9e` (@219151099; constants `var $Qe=200,B6r=128`
@210585642, dedupe cap `C=256`):

- MCP tools whose full `server__tool` name exceeds **128** chars are dropped
  from the API request tools array (the Anthropic API rejects longer names —
  pre-fix one such tool failed EVERY request); non-MCP tools always pass.
- Warn-once per tool name (session-lifetime dedupe Set capped at 256 names):
  `Tool "${name}" is not sent to Claude: its name has ${len} characters and the API accepts at most ${128}`.
- Per-server skip counts → one `tengu_mcp_degraded` telemetry event per
  affected server, `reason: "tool_name_too_long"` (analytics stubbed in OCC —
  call kept for structure).
- Wired at the official site: the request-building path in
  `src/services/api/claude.ts` (@1621 marker).
- `hiddenFromModel === true` drop branch (official `_meta.ui.visibility` /
  toolsKeptFromModel feature) kept for faithfulness; **inert** in OCC until
  `mcpInfo` ever carries the flag (`src/Tool.ts:505` note).

**Documented deviations:** official `Wo(serverName, msg)` surfaces the warning
in the /mcp status UI — OCC has no per-server runtime warning store, so the
verbatim text goes to `logForDebugging` instead. Official `BP(n)` server-key
hash → OCC sha256-hex-16 (same purpose: no verbatim user-controlled server
names in analytics metadata).

## §2 — P2 LANDED: `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` (official `a$` 5th param)

Changelog: *"Added `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` environment
variable to set a longer base delay for the backoff when retrying an overloaded
(529) request."*

Official `a$` (@205639755) grew a 5th param; descriptor
`oB(Jt)?a.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS:void 0`. OCC port in
`withRetry.ts`: env override parsed with clamp **500 ≤ ms ≤ 32000**
(`OVERLOADED_RETRY_BASE_DELAY_MIN_MS`/`MAX_MS`), invalid/unset → existing
default; call site passes it through (line ~1185 marker).

## §3 — P3 LANDED: Agent tool `effort` parameter (official `Do` schema)

Changelog: *"Added an `effort` parameter to the Agent tool, so Claude runs a
sub-agent at the effort level you ask for."*

Byte-verified mappings (upgraded from inference this round):

- `var Hc=["low","medium","high","xhigh","max"]` @204121579 ≡ OCC
  `EFFORT_LEVELS` (`src/utils/effort.ts`).
- `function RZ(){return nNo()!=="disabled"}` @213411076 (beside the
  FORK_AGENT T1 definition) ≡ OCC `isForkSubagentEnabled()`.
- `Do` schema @219359930: `effort:j(Hc).optional().describe(...)` with the
  verbatim base description *"Reasoning effort for this agent. Set this ONLY
  when the user, or instructions such as CLAUDE.md or a skill, explicitly ask
  that this agent or delegated work run at a specific effort level, never on
  your own judgment; otherwise omit it and the agent runs at its usual
  effort."* + conditional fork clause `RZ()?' Ignored for subagent_type:
  "fork": a fork runs at your own effort.':""`.

Wiring: `AgentTool.tsx` schema/describe/call() (`effort: isForkPath ?
undefined : effort` — the fork path drops the param); `runAgent.ts` precedence
**tool param > agentDefinition.effort (frontmatter) > inherited session
effortValue** in the `agentGetAppState` closure.

## §4 — P4 LANDED: Read PDF `pages` strict parser (official `Dns`)

Changelog: *"Fixed the Read tool returning only the first entry, with no
error, when a PDF's `pages` was a list such as "6,9,15"; it now returns an
error saying to read each page or range separately."*

Official `Dns` @207454659: anchored `/^(\d{1,9})(?:\s*(-)\s*(\d{1,9})?)?$/`
against the trimmed string. Pre-fix parsers (official parseInt-lenient and
OCC's) degraded `"6,9,15"` → page 6 silently. OCC port:
`parsePDFPageRange()` in `pdfUtils.ts` (accepts `"5"`, `"1-10"`, `"1 - 10"`,
`"3-"`; rejects lists/zero/inverted/>9-digits → null); `FileReadTool.ts`
`validateInput` returns the official usage error **before any I/O**:
`Invalid pages parameter: "${pages}". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.`

**Live-verified against the official binary this round** (§9.4): same probe
through official `2.1.292` (`npx @anthropic-ai/claude-code@2.1.292 -p`) and
through OCC produce byte-identical error text.

## §5 — P5 LANDED: @-mention >256KB `at_mention_reference` (official `Wxr`/renderer)

Changelog: *"Fixed @-mentioned text files over 256KB being left out silently:
Claude is now told the file's size and to read it in portions."*

Official producer (@215045200 region, `Wxr`): too-large mentions become
`{type:"at_mention_reference",mentions:[path],unread:"too_large",fileSize,displayPath}`;
unexamined → `unread:"unexamined"`; no-attach sessions (`Uxr`) → bare
`mentions`. Renderer (@215812200) emits the three verbatim texts (too_large /
unexamined / undefined cases).

OCC landing: `AtMentionReferenceAttachment` type + union insertion +
`too_large` producer in `attachments.ts` (@345/@3366 markers, with
`fileSize` from stat); renderer case in `messages.ts` (@4239) with all three
verbatim texts (including the `${ct} call with no limit parameter will fail.
Read it in portions with the offset and limit parameters...` guidance);
display-side case in `AttachmentMessage.tsx` (@162).

**Documented deviation (kept):** official stores raw paths and applies the
display-shortening `Bd()` at RENDER time (`e.mentions.map(Bd).join(", ")`);
OCC applies the display path at CREATION time and the renderer skips `Bd` —
consistent with OCC's `compact_file_reference`/`pdf_reference` renderers which
use `attachment.filename` directly. The `displayPath` field is therefore
omitted (no consumer). Observable text is equivalent.

## §6 — P6 LANDED: NO_PROXY honored for own requests (official `Xi`/`YLe`/`py`/`yn`)

Changelog: *"Fixed `NO_PROXY` being ignored for Claude Code's own API requests
(sign-in, policy, feedback, artifacts) when `HTTPS_PROXY` is set."*

Root cause (official + OCC alike): an explicit `proxy` fetch option (Bun) or a
proxy dispatcher (Node) overrides the runtime's env-proxy logic — including
its NO_PROXY handling. Official proxy module (@203984200–203992500,
byte-extracted):

- `YLe`/`__r` ≡ `getNoProxy()`: `no_proxy==="*"||NO_PROXY==="*"` → `"*"`;
  both set & different → **merged** `` `${no_proxy},${NO_PROXY}` ``; else
  `no_proxy||NO_PROXY`. (Pre-292 OCC: precedence-only.)
- `py` ≡ `shouldBypassProxy()`: secure default-port now
  `protocol==="https:"||protocol==="wss:"` → 443 (wss: gained).
- `Xi` ≡ `getProxyFetchOptions()`: new `url` option —
  `if(e.url&&py(e.url))return{...o,...BRt()}` (base + TLS only, no
  proxy/dispatcher) BEFORE the proxy branch; unix-socket check still first.
- `yn` ≡ `getProxyAgent()`: `noProxy:YLe(...)` merged list.

OCC wiring — the four MCP transport fetch sites in `src/services/mcp/client.ts`
now pass the target URL (@1031 SSE eventSourceInit, @1058 sse-ide, @1192
StreamableHTTP, @1267 claudeai-proxy). `src/services/api/client.ts` (Anthropic
SDK) intentionally keeps the static `getProxyFetchOptions({forAnthropicAPI:true})`
— the SDK's `fetchOptions` type is `MergedRequestInit` (object only, no
function form), so a per-request URL cannot be threaded there; the changelog
fix scope ("sign-in, policy, feedback, artifacts" — CC's own non-SDK fetches)
matches the wired sites.

**Official proxy-module features NOT ported (staged, not in the 2.1.292
changelog — separate dormant subsystems):** `cW`/`dW`/`jRt` proxy-URL
validation + one-time console warning; proxy-auth-helper
(`CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER`, `Proxy-Authorization` header `et()`,
TTL refresh); CIDR-aware bypass `Qe`/`ze`/`lW` + `fallbackProxy`;
`API_FORCE_IDLE_TIMEOUT` (`timeout:!1` + `hasBodyIdleWatchdog`); `NO_PROXY_*`
telemetry classification modes @92978052 (analytics stubbed in OCC).

## §7 — 2.1.292 changelog triage (disposition of the ~95 entries)

**Landed (6):** §1–§6 above.

**N/A — subsystem not in OCC (no surface, verified by absence):** all
[Claude Tag] (7), [Code Review] (3), [Cloud sessions] (5), [Remote Control]
(2), desktop-app items (Send now, /bug-/share-/feedback Ctrl+O resume —
OCC is terminal-only), mods/plugin-engine items (prompt.autocomplete,
$.model.complete prompt caching, agent.spawn workflow-agents hook, tool.check
next(e) semantics, plugin validate/test/deny-reason-length, hooks-worker
restart family, `$` name collision unload, /theme config.set ordering — OCC's
plugin surface is the trimmed marketplace loader, no hooks-mod engine),
artifacts (`/remote-env`, Artifact tool listing 200, scheduled-run artifact
publish), `--teleport`/cowork items, `claude --resume` picker plan-mode
restore is present but the picker-side restore needs its own forensics
(grouped with candidates below).

**Windows-only:** `rm -rf` 8.3 short-name home/drive evasion (OCC is
Linux/macOS-first; no 8.3 surface), macOS/Windows notebook-PDF symlink-swap
(OCC read path does not re-resolve after approval on these platforms —
grouped with the security candidates below for verification).

**Security items needing dedicated forensics — NEXT ROUND TOP PRIORITY:**
PreToolUse hook approvals + auto mode bypassing the prompt for UNC network
paths; sandboxed reads of `/ultrareview` seed-admin staged copies; managed
sandbox read-deny path appearing/re-pointing mid-session; tampered on-disk
cache of server-managed settings unseating the policy plugin. (Each is a
binary-level site hunt; porting without verbatim extraction = inventing.)

**Real OCC-surface candidates (staged for future rounds, need per-site
forensics):** Grep accepts `file_path` for `path` + Write/WebFetch/Read
stray-param tolerance; Grep/Glob unreadable-target retry-once; hook output
`<system-reminder>` escaping; stdio-MCP startup `resources/list` skip (first
turn no longer waits); MCP protocol `2026-07-28` negotiation default +
`MCP_PROTOCOL_NEGOTIATION=legacy`; stdio-MCP 7-day slow-connect memory;
vim-mode cursor/j-k-column/f-t-F-T-;-,-cross-line fixes (OCC has the full vim
engine — `src/vim/`); agent-name 256-char cap (+ skill/plugin name ignore);
sandbox env-prefix auto-allow (`FOO=bar python3 app.py` under strict mode);
`allowed-tools` rule returning after leaving auto/plan mode mid-turn;
one-shot `-p`/SDK waiting for background commands past the 5s cutoff +
scheduled-wakeup drop; @-word "could not be examined" false note under Read
deny + symlinked cwd (P5 family); instruction-file stale lines after /cd;
compaction `/name` reserved-skill re-invocation; paste coalescing; /add-dir
Shift+Enter line break; footer-row fast-typing drops; iTerm2 fullscreen clear;
long-list render speed; Ctrl+C draft recovery; usage-limit alert repeat per
background agent; usage-limit links https; plan-mode resume restore.

**Standing divergence (unchanged):** OCC's model enum retains `fable` naming
(documented since the OCC-36/37 rounds); official effort enum `Hc` is
byte-identical to OCC `EFFORT_LEVELS` (§3).

## §8 — STAGED carry-over (never invented)

- **#018 WebFetch 100k reader + `offset`** (occ148's top candidate) —
  **forensics substantially completed this round, port still not safe.**
  Extracted verbatim from the 2.1.292 ELF (preserved at
  `/tmp/occ149-extracts.js` lines 1–19; re-download the binary if /tmp was
  wiped): full `LLo` result-builder body @213371685 (offset slicing,
  budget `pqt`, overflow split with `p1e=8000` summary reserve, remainder
  summarization via `summarizeRemainder`, verbatim `<INe>`-tag envelope with
  the untrusted-content warning), `M2t` continuation message
  `` ` — to read on, call ${dr} again with the same url and offset: ${e}` ``,
  `NLo` HTTP-error builder, `T2t` input schema with the `offset` param
  describe text (*"Character position in the page text to start reading from.
  Use it to read on through a page too long for one call, with the value the
  previous result gave."*), `FLo` output schema, and the tool-def `o_`
  (constants `p1e=8000,m2t=1000,k2t=255` @213371653).
  **Unresolved (why it stays staged):** the helper set `LLo` depends on was
  not extracted — `INe` (tag name), `ZK` (tag escaper), `Xl` (offset slicer),
  `ne` (truncator), `zJn` (remainder cap before summarization), `pqt` (result
  budget), `xeo` (reporting-rules text), `m1e` (content-type label), `cX`
  (status text), `Ve` (rethrown error class), the `summarizeRemainder` prompt
  construction at the call site, and — critically — the **call-site gating**:
  the official tool DESCRIPTION still says "answers `prompt` against it using
  a small fast model" while `LLo` returns verbatim text, so the two flows
  coexist behind an unextracted gate. Porting either path without resolving
  the gate = inventing. Next round: re-download the binary, grep
  `INe=`/`function ZK`/`function Xl`/`function ne`/`function zJn`/`pqt=`/
  `xeo=`/`function m1e`/`function cX` + the `LLo(` call sites and the gate
  condition, then port schema+reader+tests as one item.
- **#148 skills/custom-commands `!` raw-control-char refusal** — unchanged
  from occ148 §4 (runtime refusal site/message still not isolated).
- **OCC-109 STAGED list** (its ledger §5) stands unchanged.

## §9 — Verification

### 9.1 Unit tests — git-stash A/B (zero regressions)

| Run | Tree | Result |
|---|---|---|
| `bun test src` | HEAD+changes | **8132 pass / 109 fail / 1 error / 1 skip** (8242 tests, 657 files) |
| `bun test src` | clean HEAD `9d16235` (stashed) | **8057 pass / 109 fail / 1 error / 1 skip** (8167 tests, 651 files) |
| Failure-name diff | — | **byte-identical failure sets** — all 109 pre-existing on main (full-suite order/isolation artifacts; 30-file isolated rerun on HEAD drops to 18) |
| 6 new 292 suites isolated | HEAD+changes | **75 pass / 0 fail / 512 expect()** |
| MCP/proxy-adjacent regression (6 suites) | HEAD+changes | **93 pass / 0 fail** |

Delta accounting: +75 tests = exactly the 6 new files (9+18+5+18+7+18).

### 9.2 Build + e2e

- `bun run build` green: `dist/cli.js` 29.90 MB, MACRO.VERSION=2.1.373
  (bump to 2.1.374 in the release commit).
- Docker e2e A/B (`bash test/e2e/run.sh`, full 732-test suite in Ubuntu
  container, image rebuilt per tree):

| Run | Tree | Result |
|---|---|---|
| e2e | HEAD+changes | **658 pass / 73 fail / 1 skip / 12 errors** (2426 expect(), 155 files, 989.7s) |
| e2e | clean HEAD `9d16235` (stashed, image rebuilt) | **658 pass / 73 fail / 1 skip / 12 errors** (2426 expect(), 155 files, 988.9s) |
| Failure-name diff (66 unique) | — | **byte-identical failure sets — zero e2e regressions** |

  The 73 failures are pre-existing environmental suites (tmux/pty REPL
  welcome-page rendering, keybindings, trust-gate dialogs, live-model
  `glm-5.2` task suites against the containerized endpoint) — identical with
  and without this round's changes; none touch proxy/MCP/PDF/attachment/
  retry surfaces.

### 9.3 Live smoke (host, real API endpoint)

- `bun dist/cli.js --version` → `OCC 2.1.373`; headless
  `echo "say PONG…" | bun dist/cli.js -p` → `PONG`, exit 0 (the
  `[claude-code:unrecognized_model] {"model":"glm-5.2"}` notice is
  pre-existing env noise, identical on the official binary below).
- tmux REPL: boot banner (v2.1.373, model glm-5.2 xhigh, auto mode),
  `say PONG` → `● PONG` round-trip, `/status` renders (Version/Session/Auth
  token/base URL/MCP servers 3 connected), `/exit` clean.

### 9.4 Official consistency check (验收员-style, live official 2.1.292)

`npx -y @anthropic-ai/claude-code@2.1.292 --version` → `2.1.292 (Claude
Code)`. Same P4 probe (Read `/tmp/occ149-fake.pdf` with `pages:"6,9,15"`) run
through BOTH binaries in `-p` mode with the same env:

- Official: `Invalid pages parameter: "6,9,15". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.`
- OCC: **byte-identical.**

### 9.5 Security review (安全审查员, security-reviewer subagent on the full diff)

**Verdict: PASS-WITH-NOTES — safe to commit.** 0 CRITICAL / 0 HIGH /
0 MEDIUM / 4 LOW. Scope check: every hunk traces to P1–P6; no
package.json/CI/hook-config changes; no eval, no new network endpoints, no
hardcoded secrets, no obfuscated strings. Highlights: P6 bypass is
fail-closed on URL-parse error and adds/removes no credentials (route-only
change, mTLS preserved); all 4 mcp/client.ts wiring sites pass the correct
per-request URL; P1 telemetry carries only sha256-hex-16 server hash +
literal reason + count, dedupe Set bounded at 256; P4 regex empirically
ReDoS-free (<0.2 ms on 100k-char adversarial inputs); P5 discloses less
than official (cwd-relative path). LOW notes: (1) static requestInit proxy
decision at 3 MCP sites mirrors the official shape — note only; (2)
pre-existing unconditional SSE Bearer header (not this diff); (3) the
`[+-]?` sign in the P2 digits gate is byte-faithful — the official parser
extracted in a prior round is verbatim
`if(n?.digitsOnly && !/^[+-]?\d+$/.test(e.trim())) return;`
(`src/services/mcp/client.ts:282`); (4) unescaped mention text in the
system-reminder matches official behavior and is already staged as the
hook-output `<system-reminder>`-escaping candidate (§7).

### 9.6 Release

- Version: package.json `2.1.373 → 2.1.374`; CHANGELOG.md new
  `## 2.1.374 - 2026-10-08` section.
- Tag `v2.1.374` pushed. **Carry-over (owner action, still open):** repo
  secret `NPM_TOKEN` is invalid (npm `@cnwenf/occ` latest = `2.1.367`;
  v2.1.368–373 Publish runs all failed `E404 … PUT
  https://registry.npmjs.org/@cnwenf%2focc`). `publish.yml`'s GitHub-Release
  step is `if: success()` behind npm publish, so the Release is created
  manually (`gh release create v2.1.374 --generate-notes`, precedent
  v2.1.368–370/372/373) and /releases ≡ /tags parity is verified after.
  npm publish stays pending until the owner rotates `NPM_TOKEN` and re-runs
  Publish **for the newest tag only**.
- RELEASE_RESULT_PLACEHOLDER

## §10 — Next-round priorities

1. **Security forensics** of the four 2.1.292 security fixes with OCC-surface
   potential (UNC PreToolUse bypass first — OCC has PreToolUse approvals +
   auto mode; seed-admin/managed-sandbox/settings-cache after surface
   checks).
2. **#018 WebFetch offset** — helper-set extraction list in §8 (forensics
   70% done).
3. Candidate batch: Grep `file_path` alias + stray-param tolerance;
   Grep/Glob unreadable retry; hook-output `<system-reminder>` escaping;
   stdio-MCP `resources/list` startup skip + protocol `2026-07-28`.
