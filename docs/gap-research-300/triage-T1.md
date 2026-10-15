# Triage T1 — official Claude Code 2.1.299 → 2.1.300 (round 2026-10-16)

Cluster: mods / OTel / cloud / Cowork / Slack / CodeReview / RemoteControl-diff / runner / desktop.
Assigned entries: 1, 2, 3, 4, 6, 7, 8, 9, 14, 20, 25, 26, 27, 35, 45, 48, 49, 50, 51, 52, 54, 57, 64, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88.

Verdict summary: **1 PORT** (#2), **1 STAGED** (#6), **1 ALREADY-ALIGNED** (#25), **30 N-A**.

Key cluster-level finding: **OCC has a REAL OpenTelemetry path** — `src/utils/telemetry/instrumentation.ts` (836 lines; console/OTLP-grpc/OTLP-http/Prometheus/BigQuery exporters, `OTEL_EXPORTER_OTLP_*` env handling incl. `ANT_OTEL_*` overrides), `src/utils/telemetry/events.ts` (`logOTelEvent`), `src/services/api/logging.ts` (`api_request`/`api_error`/`assistant_response` events), `src/utils/telemetry/sessionTracing.ts` (998 lines; interaction/llm_request/tool spans). `grep -rn 'OTEL_\|opentelemetry\|otlp' src/ | wc -l` → **444**. OTel entries were therefore triaged seriously, not dismissed.

Mods subsystem absence (covers #1/3/4/7/8/26/27/35/52): `grep -rn 'virtualText\|promptDecoration\|\$\.ui' src/ | wc -l` → **0**; `grep -rn 'prompt\.submit\|agent\.spawn' src/ | wc -l` → **0**; `grep -rn "prompt\.change\|prompt\.edit" src/ | wc -l` → **0**. (OCC's plugin-hook hot-reload in `src/setup.ts:313-327` is the classic hooks engine, not the mods JS-plugin-hook subsystem.)

---

## 1 — N-A: mod `virtualText` prompt decorations

Mods subsystem absent in OCC. Proof: `grep -rn 'virtualText' src/ | wc -l` → 0; no `$.ui` / mod-hook registry anywhere in `src/` (cluster-wide grep above). Official-only surface (mod prompt decorations drawn in the prompt box).

## 2 — PORT: OTel `api_request` gains `cache_creation_5m_tokens` / `cache_creation_1h_tokens`

**Official binary evidence (v300 only; both strings absent from s299.txt):**
- String-table offsets: `cache_creation_5m_tokens` @107102784, `cache_creation_1h_tokens` @107102816 (`grep -aboF` on `v300/package/claude`; second copies @227728049/227728121).
- v300 `api_request` builder @227727872 (dd excerpt):
  `pi("api_request",{model:e,input_tokens:w.input_tokens,output_tokens:w.output_tokens,cache_read_tokens:w.cache_read_input_tokens,cache_creation_tokens:w.cache_creation_input_tokens,cache_creation_5m_tokens:w.cache_creation?.ephemeral_5m_input_tokens??0,cache_creation_1h_tokens:w.cache_creation?.ephemeral_1h_input_tokens??0,cost_usd:Nr,cost_usd_micros:Math.round(Nr*1e6),...})`
- v299 builder @226508395 (dd excerpt) has the identical field list **minus** the two new fields → delta is exactly `cache_creation_5m_tokens` + `cache_creation_1h_tokens`, sourced from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens ?? 0`.

**OCC-side evidence:**
- `src/services/api/logging.ts:722-731` — the single `logOTelEvent('api_request', {...})` emit site (verified sole site: `grep -rn "logOTelEvent('api_request'" src/` → 1 hit). Emits `cache_creation_tokens: String(usage.cache_creation_input_tokens)` but **no** 5m/1h split (`grep -rn 'cache_creation_5m_tokens\|cache_creation_1h_tokens' src/` → 0).
- Type support already present: `src/entrypoints/sdk/sdkUtilityTypes.ts:15-18` — `NonNullableUsage.cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number }`; the fields are already consumed elsewhere (`src/services/api/claude.ts:4279-4284`).

**Sketch:** In `src/services/api/logging.ts:727` (right after `cache_creation_tokens`), add:
```ts
cache_creation_5m_tokens: String(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
cache_creation_1h_tokens: String(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
```
Keep OCC's `String(...)` convention for this event (pre-existing OCC divergence: official sends raw numbers; OCC stringified all `api_request` values since ≤2.1.299 — out of scope here). Use the official defensive `?. … ?? 0` form even though `cache_creation` is non-optional on `NonNullableUsage`.
**Test idea:** unit test with a mocked event logger (`getEventLogger` seam in `src/bootstrap/state.ts`): call `logAPISuccessAndDuration` with `usage.cache_creation = {ephemeral_5m_input_tokens: 1200, ephemeral_1h_input_tokens: 3400}` → assert emitted `api_request` attributes contain `cache_creation_5m_tokens: "1200"`, `cache_creation_1h_tokens: "3400"`; second case with `cache_creation` absent at runtime → both `"0"`.

## 3 — N-A: `$.ui.view({ agentId })` for mods

Mods subsystem absent (`grep -rn '\$\.ui' src/ | wc -l` → 0). Official-only mods UI surface.

## 4 — N-A: `dir` prop on mod `Text` (RTL)

Mods UI framework absent (same 0-hit proof as #1/#3). OCC's Ink fork has no mod-rendered `Text` component surface.

## 6 — STAGED: OTel GenAI semantic-convention span attributes

**Official binary evidence:** all `gen_ai.*` strings are NEW in v300 (0 hits in s299.txt): `gen_ai.system` @222469943, `gen_ai.request.model` @222469971, `gen_ai.request.attempt` @222470602, `gen_ai.response.id` @222472035, `gen_ai.response.finish_reasons` @222472416, `gen_ai.operation.name` @222468004/222473036, `gen_ai.tool.name` @222473075, `gen_ai.tool.call.id` (kt() @~222464800), `gen_ai.conversation.id` @222467388, `gen_ai.provider.name` @222465291; plus `"error.type"` @222474709 (`s["error.type"]="tool_error"` on failed tool spans in `Muo`). All live in ONE module region (tracing, ~222464700–222475600). Recovered shapes (dd excerpts):
- Base attrs builder: `Ct(){return{...rA()?Gt():CDt(),"gen_ai.provider.name":Yt(Ie())}}`; provider map `Yt`: bedrock/mantle→`aws.bedrock`, vertex→`gcp.vertex_ai`, firstParty/anthropicAws/anthropicGoogleCloud/foundry/gateway→`anthropic`.
- llm_request span: `C("llm_request",{model:h,"gen_ai.system":"anthropic","gen_ai.request.model":h,"llm_request.context":…})` with `h=rA()?On(n):n` (model sanitized under gate); attempt event `addEvent("gen_ai.request.attempt",{attempt,client_request_id?})`; end attrs add `gen_ai.response.id=requestId`, `gen_ai.response.finish_reasons:[stopReason]`.
- tool span: `C("tool",{tool_name:m,tool_name_safe:g,"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":h?.mcpToolName??m,…})`; `kt(span,toolUseId)` sets `tool_use_id` + `gen_ai.tool.call.id`; conversation id via `N(agentCtx)` (main→session id, subagent→agent id, teammate→none).
- **Gate `rA()` = `Ynn()`** (@220456900): `iCr.resolve(()=>sCr()!==null)` — an arm/freeze latch; `sCr()` (@220456320) validates `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (parseable URL, https or localhost-http, no credentials/query/hash). When the gate is ON, attributes switch to semconv shape AND privacy-sensitive legacy attrs are suppressed (`query_source`, agent attrs, error messages: `H(n)` only sets message when `!rA()`).

**OCC-side evidence:** real tracing surface exists — `src/utils/telemetry/sessionTracing.ts` (spans `interaction`/`llm_request`/`tool`/`tool.blocked_on_user`/`tool.execution`, `createSpanAttributes` @162-175, tracer name identical `com.anthropic.claude_code.tracing` @159); `grep -rn 'gen_ai' src/ | grep -v test` → **0** (no semconv attrs); no OTLP-traces-endpoint latch concept (OCC gates = `isEnhancedTelemetryEnabled()`/`isBetaTracingEnabled()` @132-157).

**Why STAGED, not PORT:** the change is a module-wide dual-shape rework (every span start/end site gains gated semconv attrs; several legacy attrs become gate-suppressed; new arm/freeze latch semantics interact with OCC's existing enable gates; perfetto parity in `src/utils/telemetry/perfettoTracing.ts` unclear). Porting only the attribute names without the gate/sanitization semantics (`On(n)`, `Zt(n)` tool-name folding, `din(e)` suppression) would be a partial/invented port.
**Next-round probe:** extract the full tracing-module region 222464700–222475600 site-by-site (esp. `On`, `Zt`, `CDt`, `din`, `gt`, `pt`, the `iCr` latch arm/freeze call sites, and whether perfetto spans receive semconv attrs), then map 1:1 onto `sessionTracing.ts` `startInteractionSpan`/llm/tool span functions; decide gate placement (env-read timing vs OCC's `bootstrapTelemetry`).

## 7 — N-A: workflow-agent `prompt`/`model` rewrite in `agent.spawn` mod hook

No mod-hook surface: `grep -rn 'agent\.spawn' src/ | wc -l` → 0. OCC's WorkflowTool (`src/tools/WorkflowTool/`, `WORKFLOW_SCRIPTS` live) spawns agents but exposes no `agent.spawn` hook to JS mods — the official entry is about the mods hook gaining rewrite capability (it could previously only refuse). Nothing to port.

## 8 — N-A: `prompt.change` mod hook

`grep -rn 'prompt\.change' src/ | wc -l` → 0; mods absent (see cluster proof). Official-only mods hook event.

## 9 — N-A: cloud sessions misattributing host block to org policy

Cloud-session network-settings/host-allowlist surface absent in OCC: `grep -rn 'Allowed hosts' src/` → 0 hits (official v300 new_strings line 3758 carries the new "Allowed hosts come from network settings…" text). OCC's `policy_blocked` hits (`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:176`, `src/utils/config.ts:513`) are remote-agent-task/plugin-marketplace statuses, not cloud-session host blocking. The v299/v300 `la()`/`aa()` policy-decision function is byte-identical across versions — the fix is in the cloud-session network path OCC doesn't have.

## 14 — N-A: background agent "lost, not resumable" after cloud container replacement

No cloud-session container lifecycle in OCC. `grep -rn 'cloudSession' src/` → 2 hits, both in `src/tools/ListPeersTool/ListPeersTool.ts` (110, 206) — and ListPeersTool is dead code: `src/tools.ts:128` gates it behind `feature('UDS_INBOX')`, not in the 6-flag allowlist (documented hang-risk flag, CLAUDE.md). Container-replacement resume bookkeeping is Anthropic cloud-backend + cloud-mode CLI surface.

## 20 — N-A: Desktop/RC diff view missing conflicted cherry-pick/revert in reftable repos

Official fix lives in the `[bridge:worktree] collectWorktreeState` module (v300 @254701800-254703300): detector `A(e,r)` keeps the v299 file-existence scan `[rebase-merge, rebase-apply, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, BISECT_LOG, sequencer]` (v299 `M(e)` @253184702 — file scan ONLY, returns null) but **adds a git-query fallback** `Pct(r,["CHERRY_PICK_HEAD","REVERT_HEAD"], o=>(await u(e,o)).exitCode)` throwing new string `"git could not say whether a cherry-pick or revert is in progress"` (@254703008 region; new in v300) — because under reftable storage pseudo-refs live in the tables, not as gitdir files.
**OCC absence proof:** `grep -rn 'collectWorktreeState\|mid_operation\|unpushed_count\|bridge_worktree' src/` → 0; OCC's bridge (`src/bridge/`) is dead code — `isBridgeEnabled()` gates on `feature('BRIDGE_MODE')` (`src/bridge/bridgeEnabled.ts:32-36`), not in the allowlist; OCC's daemon `remoteControlServer.ts` is a self-built local HTTP bridge (status/prompt/stop only — `grep -n -i diff` → only a token-compare variable) with no diff view.
**Advisory (not 2.1.300 parity, opportunistic):** OCC's LOCAL transient-state checkers are fs-only and share the reftable blind spot class — `src/utils/gitDiff.ts:308-327 isInTransientGitState()` (fs.access on MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD; feeds `fetchGitDiff`/`fetchGitDiffHunks` → DiffDialog/useDiffData) and `src/utils/commitAttribution.ts:869-894 isGitTransientState()` (stat on rebase-merge/rebase-apply/MERGE_HEAD/CHERRY_PICK_HEAD/BISECT_LOG). OCC already has reftable detection helpers (`src/utils/worktree.ts:927 isReftableGitDir`). A v300-pattern hardening (git-query fallback when reftable) could be a self-initiated follow-up issue.

## 25 — ALREADY-ALIGNED: OTel `tool_result` `git_commit_id` after `git commit -q` in reftable repos

**Official evidence:** v299 fallback `uMo(preState)` (@215930860) reads `.git/logs/HEAD` tail **via filesystem only** → in reftable repos (reflogs live in reftable `.log` tables, no `logs/HEAD` file) it returns undefined → `git commit -q` (empty stdout) yields no `git_commit_id`. v300 renames/rewires to `jSs` (@223539375) whose fallback `zLo` (@217078429) starts `if(e.reftableNewest!==void 0)return Us(e,e.reftableNewest)`; `Us`/`hr` (@217079058) run `git log --walk-reflogs --max-count=N --format=%H%x09%gd%x09%gs HEAD --` (reftable-safe, git-mediated) with pre-state `reftableNewest` captured at call start (@217078207: `if(await cyt(r)){let c=await hr(r,1);…n.reftableNewest=c[0]?.key??null}`), then verifies via `mr` (HEAD symbol read + `refs/heads/<b>` equality).
**OCC proof:** OCC never implemented the fs `logs/HEAD` mechanism — its `git_commit_id` path (ported at 2.1.296 #044) spawns git directly: `src/services/tools/toolExecution.ts:230-259 readGitHeadState()` = `git rev-parse HEAD` + `rev-parse --abbrev-ref HEAD` pre (`:1354-1358`) and post (`:1550-1568` → `resolveGitCommitInfo` @268-285: stdout `[branch sha]` parse first, else pre/post HEAD diff). `git rev-parse` resolves HEAD natively under reftable, so the official bug (missing `git_commit_id` in reftable repos after `git commit -q`) cannot occur in OCC — observable contract already matches fixed official behavior, via the documented mechanism divergence (git spawns vs official file reads; noted in the `readGitHeadState` comment block). Root-commit case also resolves through the diff (pre `headSha` undefined → post present).

## 26 — N-A: mod-rewritten prompt recorded as typed in OTel `user_prompt`/interaction span/title requests

Requires the mods `prompt.submit` rewrite/drop hook — absent in OCC (`grep -rn 'prompt\.submit' src/ | wc -l` → 0). OCC does have the affected sinks (`sessionTracing.ts:182-218 startInteractionSpan` records `user_prompt`, called from `src/utils/processUserInput/processTextPrompt.ts:54`), but with no rewrite source the recorded text is always the typed text — the defect cannot arise. (If mods are ever ported, revisit.)

## 27 — N-A: mod hot-reload note appearing in transcript as user-typed

Mods subsystem absent (`grep -rn 'virtualText\|\$\.ui\|prompt\.submit' src/` → 0). OCC's hot-reload code (`src/setup.ts:313-327 setupPluginHookHotReload`) is the classic plugin-hooks cache refresh — it injects no transcript notes (`grep -rn 'hot.reload' src/` hits are comments only).

## 35 — N-A: mod `prompt.edit` hook not raised for `chat:newline` keybinding

`prompt.edit` is a mod hook; mods absent (`grep -rn "prompt\.edit" src/ | wc -l` → 0). OCC has the `chat:newline` keybinding itself but no hook event to raise.

## 45 — N-A: Cowork cloud Write/Edit/NotebookEdit reporting success for host-local paths

Cowork host-path mapping absent from OCC file tools: `grep -rn 'HOST_PATHS\|hostPath' src/tools/FileWriteTool src/tools/FileEditTool src/tools/NotebookEditTool` → 0. (`CLAUDE_CODE_WORKSPACE_HOST_PATHS` appears in OCC only as a telemetry attribute in `src/utils/telemetry/events.ts:85-89`.) OCC's file tools write to the real cwd — no cloud-container/host path split exists.

## 48 — N-A: cloud sessions hanging 5 min/turn when org policy unreadable

No per-turn cloud-session org-policy read in OCC. OCC's policy/settings fetch is `src/services/remoteManagedSettings/index.ts` (managed-settings sync, `LOADING_PROMISE_TIMEOUT_MS = 30000` @74, `SETTINGS_TIMEOUT_MS` @301, explicit `'timeout'` error case @374-375) — a different subsystem that already fails fast; the cloud-session turn-blocking policy read (`decision:"organization policy unavailable"` path) has no OCC call site (`grep -rn 'Allowed hosts\|policy unavailable' src/` → 0).

## 49 — N-A: cloud session re-running an answered message after restart mid-reply

Cloud-session restart/message-dedup surface absent (same proof as #14: `cloudSession` only in dead `UDS_INBOX`-gated ListPeersTool). OCC's resume path is local transcript-based with its own interrupted-turn handling (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, OCC-44) — unrelated mechanism, not in scope of this fix.

## 50 — N-A: self-hosted runner/orchestrator freezing while nobody reads output

OCC's runner is a stub: `src/environment-runner/main.ts` is 3 lines — `// Auto-generated stub — replace with real implementation` + `export const environmentRunnerMain = () => Promise.resolve()`. No orchestrator, no `/healthz`, no SIGTERM shutdown, no log ring buffer (`grep -rn 'healthz\|SIGTERM' src/environment-runner/` → 0). Official fix (256 KiB log tail + drop counter on non-Windows) has no OCC surface. (`/healthz` confirmed present in official binary: 34 hits in s300.txt, e.g. @101192804.)

## 51 — N-A: WebFetch in Cowork telling Claude a page failed moments ago

Cowork-scoped improvement. OCC's WebFetchTool (`src/tools/WebFetchTool/`, incl. `cacheTtl.ts` success caching) has no recent-failure memory and no Cowork mode (`grep -rn -i 'recent.*fail\|failed moments' src/tools/WebFetchTool/` → 0; `grep -rn -i cowork src/tools/WebFetchTool/` → 0). OCC never runs as a Cowork cloud session.

## 52 — N-A: `plugin-authoring` skill mod-sharing scan/consent flow

No `plugin-authoring` bundled skill in OCC (`grep -rn 'plugin-authoring' src/` → 0; `ls src/skills/bundled/` → claude-api, claudeInChrome, debug, dream, hunter, keybindings, loop, loremIpsum, remember, scheduleRemoteAgents, simplify, skillify, stuck, updateConfig, verify). The entry also concerns mod file sharing — mods absent (#1 proof).

## 54 — N-A: artifact update+republish in one call

No Artifact tool in OCC: `grep -rn "name = 'Artifact'\|ARTIFACT_TOOL" src/` → 0; `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` is a 3-line auto-generated stub (`export const ReviewArtifactTool: Record<string, unknown> = {}`). Official entry extends the Artifact tool's update/republish actions — no OCC surface.

## 57 — N-A: Claude Desktop Code tab applying managed settings for Anthropic-operated `forceLoginGatewayUrl` gateways

Claude Desktop host behavior (Code tab embedded session). OCC has no Desktop host integration. OCC's `forceLoginGatewayUrl` reads (`src/utils/settings/allowedProvidersEnforcement.ts:437-460 isGatewayForcedByPolicy`) are provider-enforcement parity code with a documented divergence ("not an OCC schema key… never produced by OCC policy parsing") — the 2.1.300 change (gateway must serve the session hostname + be reachable at start, else managed settings not applied by Desktop) does not map to any OCC code path.

## 64 — N-A: Cowork PermissionRequest hooks ignoring `setMode` in allow results

Cowork-cloud-only behavior change. OCC supports PermissionRequest hooks with `updatedPermissions`/`setMode` locally (`src/utils/hooks.ts`, `src/hooks/toolPermission/PermissionContext.ts`, `src/utils/permissions/permissions.ts`) and has **zero** cowork gating in the hooks engine (`grep -rn -i cowork src/utils/hooks/` → 0). The official change deliberately narrows hook power only inside Cowork cloud sessions — a mode OCC never runs in; porting it locally would be a behavior regression against official local semantics.

## 79 — N-A: "Allow for this task" missing from Cowork connector approvals

Cowork approval-prompt UI surface absent (`grep -rn -i 'Allow for this task' src/` → 0; no Cowork session host). Regression-fix scoped to Cowork cloud sessions (2.1.292 regression).

## 80 — N-A: cloud-session / menu losing command descriptions after second message

Cloud-session command-menu sync surface absent. OCC's slash menu is the local REPL menu (`src/commands.ts` + PromptInput completions), which is not the affected surface (bug is scoped to cloud sessions); OCC's only cloud-session touchpoint is dead `UDS_INBOX`-gated ListPeersTool (#14 proof). Bridge (which could serve remote menus) is `BRIDGE_MODE`-gated dead code (#20 proof).

## 81 — N-A: RC diff view showing deleted/renamed files as modified (machine-side, ≥2.1.296)

Machine-side Remote Control diff payload surface absent in OCC: bridge dead-code (`feature('BRIDGE_MODE')` → false, `src/bridge/bridgeEnabled.ts:32-36`), no worktree/diff state reporter (`grep -rn 'collectWorktreeState\|mid_operation' src/` → 0), and OCC's teleport `PreservedGitState` (`src/utils/git.ts:575-592`) ships a raw `patch` + `format_patch` via `git rev-parse`/`git diff` (reftable-safe, no per-file status classification that could confuse deleted/renamed with modified). The daemon `remoteControlServer.ts` exposes status/prompt/stop only.

## 82 — N-A: [Claude Tag] Slack Connect channels

Claude Tag / Claude-in-Slack is an Anthropic service + Slack app surface. OCC's 244 `slack` hits are: MCP connector name normalization (`claude_ai_Slack` — `src/services/mcp/config.ts`, `src/tools/MCPTool/`), a daemon remote-control channel binding label (`src/daemon/remoteControlServer.ts` `RemoteChannel`), and notification-destination strings — no Slack Connect / access-bundle / Claude-in-Slack message handling anywhere.

## 83 — N-A: [Claude Tag] private Allow once / Deny approval cards in Slack threads

Same absence proof as #82 — no Slack message/card rendering or approval-card plumbing in OCC (`grep -rn -i 'Allow once' src/ | wc -l` → 0; connector approval cards are service-side).

## 84 — N-A: [Claude Tag] Slack voice clips

No Slack ingestion surface at all (#82 proof); OCC voice mode is additionally removed by design (CLAUDE.md stub table: "Magic Docs / Voice Mode / LSP Server — Removed").

## 85 — N-A: [Claude Tag] not answering another app's thread tag under Claude's own message

Slack thread-routing logic is Claude-in-Slack service-side (#82 proof). No OCC surface.

## 86 — N-A: [Claude Tag] access bundles persisting across Slack Connect conversion

Access-bundle/channel-permission service concept absent (#82 proof). No OCC surface.

## 87 — N-A: [Code Review] ignoring `@claude review` from private org members

Code Review GitHub app surface absent: `grep -rn '@claude review' src/ | wc -l` → 0; no GitHub-app comment-intake/write-access/membership checking in `src/`. OCC's `/code-review` is a local slash command (CLAUDE.md OCC-31: "OCC's /code-review surface is implemented separately"), not the hosted review service.

## 88 — N-A: [Code Review] "paused for this repository" comment links

Same absence proof as #87 — the paused-repository admin comment and Git-providers settings page are hosted Code Review service artifacts; no OCC surface.
