# Upstream Version Gap — OCC-93 (2.1.229 → 2.1.231 alignment)

**Round:** OCC-93, 2026-08-14
**OCC entering state:** `2.1.299` (npm `@cnwenf/occ`; fully aligned through official **2.1.228** per OCC-91 — read-gate flagship landed, hidden-227 machinery reconciled; test baseline entering this round: 1857 pass / 0 fail / 4405 expect / 199 files).
**Official target this round:** `2.1.231` (2.1.230 was never published — npm jumped 2.1.229 → 2.1.231).

## 1. Official latest — three-way verification

| Source | Result |
|---|---|
| npm registry | `latest` = `next` = **2.1.231**; `@anthropic-ai/claude-code@2.1.230` does not exist (publish skipped) |
| GitHub | releases `v2.1.231` and `v2.1.229` present (`gh api repos/anthropics/claude-code/releases`); no `v2.1.230` |
| Fresh ELFs | official linux-x64 2.1.229 and 2.1.231 downloaded to `/tmp/occ93/v229/package/claude` and `/tmp/occ93/v231/package/claude` (both 311,175,440 bytes — identical size, consistent with 231 being a one-item hotfix over 229). Strings dumps `s229s.txt` / `s231s.txt` (40.4 MB each); 2.1.228 baseline dump retained from OCC-91 as `s228s.txt`. Line-level diffs: `added229.txt`/`removed229.txt`, `added231.txt`/`removed231.txt` |

Verification-method caveat (carried from OCC-91): strings dumps are ASCII-only and line-fragmented; byte-verified ports below were recovered via escaped literals + surrounding minified code windows (`win.py` / python mmap on the raw ELF), never guessed. No 2.1.228 ELF was retained (only its strings dump), so 228-side probes use `s228s.txt`.

## 2. The 2.1.229 changelog — 32 items, per-item verdicts

| # | Item (abridged) | Verdict | Evidence / rationale |
|---|---|---|---|
| 1 | Documented `remote-control --continue` | **N/A** | Remote Control surface trimmed from OCC. Docs-only anyway. |
| 2 | Server-supplied hooks for self-hosted runner sessions | **N/A** | Self-hosted-runner subsystem not part of OCC's surface. |
| 3 | SSE keepalive pings on gateway streaming (Vertex/Bedrock upstreams) | **N/A** | Fix targets the gateway-relay streaming layer; OCC has no gateway relay surface (verified — no SSE relay emitter in OCC's streaming path). |
| 4 | Plugin marketplace `command` sources | **N/A** | Plugins/marketplace trimmed from OCC. |
| 5 | `ListAgents` offline/cloud labels | **N/A** | Remote Control / cloud-session surface trimmed. |
| 6 | Long responses partly disappearing while streaming / printed twice | **Staged** | Streaming-render dedup fix; no recoverable marker in the strings diff without a dedicated decompilation of the render/dedup path → staged per never-invent. |
| 7 | Crash when a tool call had non-string `glob`/`file_path`/`command` | **Staged** | Input-coercion fix; fix site not recoverable from the strings diff (no new marker string) → staged. OCC note: OCC's tool-input normalization (`normalizeToolInput` family) does coerce some non-object inputs, but per-tool non-string-scalar handling was not byte-verified this round. |
| 8 | RangeError crash: progress bar / markdown table in very narrow terminal | **Staged** | Ink layout-range fix; no recoverable marker → staged. No narrow-terminal crash observed in this round's REPL acceptance. |
| 9 | Windows crash on extended-length (`\\?\`) / UNC paths | **N/A** | Windows-only path handling. |
| 10 | Auto mode failing on every tool call when `CLAUDE_CODE_ATTRIBUTION_HEADER` disables the header (direct Anthropic API) | **PORTED (flagship)** | §4a. |
| 11 | `/model` rejecting Sonnet/Opus 1M for claude.ai subscribers on a custom `ANTHROPIC_BASE_URL` gateway | **Staged** | Exhaustive probe of all candidate gate symbols (entitlement check, `model_unavailable_gate`, `vetUserSpecifiedModel`, extra-usage getter, picker builder) shows them byte-identical 228↔229; the fix is isolated to the picker row-builder disabled-reason logic, which needs its own decompilation round. OCC note: OCC's `check1mAccess` has no base-URL gate at all, so OCC most likely already behaves post-fix for the subscriber case; a blind port risks regressing it. |
| 12 | MCP OAuth redirect `127.0.0.1` instead of `localhost` | **Net-zero** | Reverted in 2.1.231 (§3). OCC's `buildRedirectUri` uses `localhost` — matches the final 2.1.231 net state. No-op. |
| 13 | Remote Control stuck working spinner | **N/A** | Remote Control trimmed. |
| 14 | `/install-github-app` review workflow not posting | **N/A** | GitHub-app surface + bundled workflows trimmed from OCC (CLAUDE.md "Bundled workflows — trimmed by design"). |
| 15 | Multi-second UI stalls with thousands of IDE diagnostics | **N/A** | IDE-extension surface trimmed. |
| 16 | One-shot `claude plugin` commands leaving stray liveness file | **N/A** | Plugins trimmed. |
| 17 | Dynamic workflows using host core count in CPU-limited containers | **N/A by construction** | OCC's workflow concurrency is not core-count-based: fixed `WORKFLOW_DEFAULT_CONCURRENCY = 10`, or `max(1, floor(tokenBudget / 100_000))` when a budget is set (`src/tools/WorkflowTool/primitives.ts`). No cgroup-vs-host divergence possible. |
| 18 | File-watcher handle leak after atomic replacements (+ Windows scheduled-tasks watcher error) | **Staged** | Watcher-lifecycle fix; no recoverable marker in the strings diff → staged. The Windows half is N/A anyway. |
| 19 | Whitespace-only message → 400 in SDK / stream-json sessions | **Staged** | Changelog: "Fixed SDK and `--input-format stream-json` sessions getting a 400 API error when a whitespace-only message was submitted". Probe result: the whitespace-only-**assistant** filter (`tengu_filtered_whitespace_only_assistant`) and the empty-assistant-content fixer are byte-identical 228↔229 (only minified names differ — `S9t`/`TYt`, `kIf`/`pMf`); the 400 fix carries no new marker string and its site is not recoverable from the line-level strings diff without a dedicated ELF-structure decompilation → staged per never-invent. OCC note: OCC's stream-json path enqueues user messages without a whitespace gate (`src/cli/print.ts` user branch), so the same 400 is plausible in OCC — first candidate for a future dedicated round. |
| 20 | 32 MB-limit conversations retrying compaction when nothing can be stripped; now fail once with a clear message | **Staged** | The fix lives in the **reactive-compaction** machinery (official gate `!hasAttempted && …`; failure message `${API_ERROR_PREFIX} · automatic compaction failed: <detail>`; 32 MB constants 33554432 / 33554432−8388608). OCC's reactive compaction is a stub (`src/services/compact/reactiveCompact.ts` — every entry point returns null/false; the call sites in `src/query.ts` are wired but no-op). There is no retry loop in OCC to fix and no compaction machinery to hang the clear message on → staged until reactive compaction itself is ported. |
| 21 | OpenTelemetry export rejected by Desktop-managed gateway | **N/A** | Claude Desktop surface trimmed. |
| 22 | Remote sessions exiting at startup when `managed-mcp.json` delivers servers | **N/A** | Self-hosted-runner surface trimmed. |
| 23 | Self-hosted runner repo prep hanging on Git Credential Manager prompt | **N/A** | Self-hosted-runner surface trimmed. |
| 24 | Workflow fan-outs stagger same-prefix siblings so later agents read the cached prompt prefix (`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS=0` disables) | **PORTED** | §4b. |
| 25 | "prompt is too long" errors now explain why automatic compaction could not recover | **Staged** | Companion of #20 — the explanation text is produced by the reactive-compaction failure path (`automatic compaction failed: …`). With OCC's reactive compaction stubbed, the message would describe machinery OCC doesn't run → staged with #20 (never-invent: don't ship a message about a non-existent recovery path). |
| 26 | Sandbox IPv6 literals bracketed in network domain lists; ambiguous spellings fail-closed + flagged by `/doctor` | **Staged** | Mechanism lives inside the `@anthropic-ai/sandbox-runtime` package (OCC pins 0.0.44; registry latest 0.0.71). Bumping the runtime dep without a dedicated compatibility round is risky (OCC-39 already found OCC must enforce some sandbox settings OCC-side because 0.0.44's schema strips unknown fields) → staged. |
| 27 | `/login` repeats the `CLAUDE_CODE_OAUTH_TOKEN` override warning after successful login | **PORTED** | §4c. |
| 28 | `/commit-push-pr`: git/gh commands with dangerous flags no longer auto-approved | **N/A by construction** | `/commit-push-pr` is a bundled workflow; OCC ships zero bundled workflows (CLAUDE.md). |
| 29 | Self-hosted runner Windows startup requires explicit `--base-dir` | **N/A** | Windows / self-hosted-runner surface trimmed. |
| 30 | [VSCode] feedback dialog replaces retired survey link | **N/A** | VSCode extension surface trimmed. |
| 31 | [VSCode] `/btw` panel resizable | **N/A** | VSCode trimmed. |
| 32 | [VSCode] sidebar session groups | **N/A** | VSCode trimmed. |

**2.1.229 round verdict: 3 items ported (10, 24, 27); 6 staged with per-site rationale (6, 7, 8, 11, 18, 19 + 20/25/26 as machinery-blocked); 1 net-zero (12); the rest N/A (trimmed surfaces).**

## 3. The 2.1.231 changelog — one item, net-zero

Official 2.1.231 has exactly one entry: MCP OAuth redirect-URI mismatch for pre-registered clients — the 2.1.229 switch to `127.0.0.1` (item 12 above) broke strict pre-registered clients whose registered redirect URI is `localhost`, so the redirect host handling was reconciled. Binary diff `added231.txt`/`removed231.txt` confirms 231 ≈ 229 + that one adjustment (identical ELF size).

OCC's `src/services/mcp/oauthPort.ts` `buildRedirectUri` emits `http://localhost:<port>/callback` — the exact 2.1.231 net state. **No-op for OCC; nothing to port.**

## 4. Ports landed this round (byte-verified mechanisms)

### 4a. Item 10 — auto-mode attribution force (flagship)

Official 2.1.229 fix: auto-mode classifiers were broken for users who set `CLAUDE_CODE_ATTRIBUTION_HEADER` to a falsy value, because the classifier side-queries go through the same attribution generator and came out empty — the API then rejected every classifier call. The fix adds an `ignoreEnvOptOut` path used **only** by the live auto-mode surfaces.

Binary mechanism (2.1.229, `LGo` — was `HUo` in 228):

```js
function LGo(e,t,r,n,o){
  let i=Xn(); // getAPIProvider()
  if(!(o?.ignoreEnvOptOut===!0 && i==="firstParty" && _4t() && !Q.ANTHROPIC_UNIX_SOCKET)
     && Tp(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  ...
}
// _4t(): plain-host check — true when ANTHROPIC_BASE_URL unset or host === api.anthropic.com
```

Side-query call site passes the flag only for the auto-mode surfaces:
`M=LGo(L,v,void 0,void 0,p&&!G5t()?{ignoreEnvOptOut:!0}:void 0)` where `p`=forceAttributionHeader; the callers with `forceAttributionHeader:!0` are the auto_mode_critique query and the two auto-mode classifier queries (fast xml + full xml). `G5t` ≡ false in OCC (no federation surface) → the condition reduces to `forceAttributionHeader`.

OCC port:
- `src/constants/system.ts` — `getAttributionHeader(fingerprint, opts?)` gains `{ ignoreEnvOptOut?: boolean }` with the exact bypass condition: provider `firstParty` AND plain `api.anthropic.com` base URL AND no `ANTHROPIC_UNIX_SOCKET`.
- `src/utils/sideQuery.ts` — `SideQueryOptions.forceAttributionHeader?: boolean`, threaded into the `getAttributionHeader` call.
- Call sites: the auto-mode critique handler and the auto-mode classifier side-queries pass `forceAttributionHeader: true` (auto mode is a LIVE surface in OCC — `TRANSCRIPT_CLASSIFIER`/`BASH_CLASSIFIER` are in the 6-flag allowlist).

### 4b. Item 24 — workflow prefix stagger

Official 2.1.229 adds a stagger gate so that when a workflow fans out same-prefix sibling agents, later siblings wait briefly for the first sibling's first response (the prompt-cache warm-up) instead of all re-paying the uncached prefix simultaneously.

Binary mechanism (2.1.229; full class extracted):
- Prefix key = `[resolvedModel, effort, agentType, toolNames.join(","), schema?JSON.stringify:"", cwd].join("\n")`.
- Gate singleton with `enter()/done()/responded()/markWarm()`; warm TTL **270000 ms**; default stagger cap **5000 ms**; cap is 0 when `DISABLE_PROMPT_CACHING` is set; override via `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` (int ≥ 0).
- `responded()` fires at the first non-error assistant message / api-metrics start; a sibling that enters while a same-prefix agent is cold waits up to `capMs` for `markWarm`.
- Debug log: `workflow agent [<name>] held <N>ms for a same-prefix sibling's first response (prompt-cache warm-up)`.

OCC port (implemented): new module `src/tools/WorkflowTool/prefixStagger.ts` carrying the verbatim `IZp` mechanism (`enter`/`done`/`responded`/`markWarm`/`stateOf`/`clear`, warming-entry factory, ready-vs-timeout-vs-abort race, singleton getter, cap resolver) + integration into `src/tools/WorkflowTool/primitives.ts` `agent()`:
- prefix key built from `[agentModel, opts.effort, agentDef.agentType, availableTools names join(","), schema JSON, worktreePath ?? getCwd()].join("\n")` — binary `Ze` shape;
- `enter()` before the started emit (binary: enter precedes the runner's start event; wall-clock start captured before the wait, so held time counts in elapsed);
- `waitedMs > 0` → `logForDebugging` of the byte-exact held line;
- `responded()` via runAgent's per-message `onQueryProgress` hook — OCC's runAgent consumes stream events internally, so `onQueryProgress` is the earliest per-response signal it surfaces (official trigger #1 `api_metrics start`; trigger #2's first non-error assistant message arrives strictly later, so the earlier signal subsumes it); `responded()` is idempotent;
- `done()` in the `finally` around the drain (binary: `try { Ge = await Ue(...) } finally { ht.done() }`) so a failed leader releases waiters.

### 4c. Item 27 — /login OAUTH_TOKEN warning repeat

Official 2.1.229 reworks the `/login` flow so the `CLAUDE_CODE_OAUTH_TOKEN` environment warning is shown **both** when login starts and after a successful login (228's wording — itself absent from OCC — was replaced entirely).

Binary mechanism (2.1.229, full extraction):

```js
// getLoginStartingMessage — NEW in 229
function KWm(){
  return Q.CLAUDE_CODE_OAUTH_TOKEN
    ? `Warning: CLAUDE_CODE_OAUTH_TOKEN is set in your environment. This session will switch to your new credentials after logging in, ${VWm}`
    : void 0
}
// VWm (shared tail):
// "but if that variable is set in your shell profile or a Claude Code settings file,
//  new `claude` sessions will keep using the old token until you remove it there."

// buildLoginDoneMessage (note: two literal newlines between base and env note — byte-exact)
function XWm(e,t){
  if(!e) return "Login interrupted";
  let r = t.bridgeDisconnected ? `Login successful. ${RRe}` : "Login successful";
  return t.envTokenWasSet && !t.gatewayActive ? `${r}\n\n${YWm}` : r
}
// YWm = `Note: CLAUDE_CODE_OAUTH_TOKEN was set in your environment when /login started.
//        This session will use your new credentials, ${VWm}`
// RRe = "Remote Control disconnected." (bridge surface; unreachable in OCC — kept for byte-parity)
```

The command handler captures `envTokenWasSet` at call start (`CLAUDE_CODE_OAUTH_TOKEN` present), passes the starting message into the OAuth flow, and on done computes `gatewayActive = getAPIProvider()==="gateway"`.

OCC port (`src/commands/login/login.tsx` — confirmed clean target; OCC has neither the 228 start warning nor the 229 repeat warning):
- `getLoginStartingMessage()` + `buildLoginDoneMessage()` with byte-exact strings;
- `startingMessage` wired through `<Login>` → `<ConsoleOAuthFlow>` (prop already exists on the flow component);
- `envTokenWasSet` captured at `call()` entry; `gatewayActive` = `getAPIProvider() === 'gateway'` — faithful to the binary condition; OCC's `getAPIProvider()` never returns `'gateway'`, so it is always false here (OCC's bridge is trimmed → `bridgeDisconnected` always false too).

## 5. Staged backlog carried forward

From OCC-91 (2.1.228): items 1 (Ink redraw recovery), 14 (Vertex retry policy), 15 (compaction progress UI) — unchanged.

New from this round (2.1.229): 6 (streaming double-print), 7 (non-string tool-arg crash), 8 (narrow-terminal RangeError), 11 (`/model` 1M gateway row-builder), 18 (file-watcher leak), 19 (whitespace-only stream-json 400 — **top candidate**, plausible same bug in OCC), 20+25 (reactive-compaction fail-once + explanation — blocked on the stubbed reactive-compaction subsystem), 26 (sandbox IPv6 — blocked on sandbox-runtime bump).

## 6. Test & acceptance plan

1. Full unit suite: `bun test src` — baseline entering: 1857 pass / 0 fail / 4405 expect / 199 files.
2. Targeted new tests for the three ports (attribution bypass, login warning messages, stagger gate).
3. `bun run build` green (`dist/cli.js` ~29 MB).
4. Biome lint clean on touched files (lint is the gate; formatter disabled).
5. Live smoke: `occ --version`, `echo "say PONG" | occ -p` → PONG, tmux REPL acceptance (boot, `/login` surface renders without OAUTH token set — warning path only fires when the env var is present).

**Execution results (2026-08-14):** all green. 41 new unit tests (22 stagger-gate, 10 attribution-bypass, 9 login-message); full src suite **1898 pass / 0 fail / 4480 expect() / 202 files**; e2e subset **56 pass** (occ-versioning + commands-alignment + five version-2.1.219-* + resume-interrupted-turn-221); `bun run build` green (`dist/cli.js` 28.89 MB); Biome lint on touched files: 0 new findings (3 pre-existing warnings outside this diff); live smoke: `bun dist/cli.js --version` → `OCC 2.1.299`, `-p` PONG round trip, tmux REPL boot + `/login` with the warning absent (env unset) and present byte-exact (env set). Security review (subagent): no backdoor, no CRITICAL/HIGH/MEDIUM — bypass scoping probed against URL userinfo-spoof / parser-differential edge cases, all fail-closed. Acceptance review (subagent): APPROVE — byte-parity verified for all three ports, no scope creep.

## 7. Release

Version 2.1.299 → 2.1.300; CHANGELOG.md updated; tag `v2.1.300` after merge to main; publish.yml verifies `releases == tags` count.
