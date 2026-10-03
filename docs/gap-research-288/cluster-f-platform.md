# Gap Research 288 — Cluster F: Platform-specific

Official Claude Code **2.1.287 → 2.1.288** catch-up. Cluster F covers the
platform/product surfaces: Cowork cloud sessions, Claude-in-Chrome, Claude
Desktop, LSP, Remote Control, VS Code extension, Cloud sessions admin,
Claude Tag (Slack), and plugin hooks.

**Method.** Byte-level forensics on the official ELF binaries
(`/tmp/cc-diff-288/v287|v288/package/claude`, `strings` dumps
`s287s.txt`/`s288s.txt`, added/deleted sets `new288.txt`/`del288.txt`;
`grep -aobF` for byte offsets + `dd` for context — binaries never executed)
cross-checked against OCC source (`file:line` evidence). Verdicts:
**PORT-CANDIDATE** (real OCC surface shares the bug AND official delta
recovered byte-level), **STAGED**, **NO-OP{ALREADY-ALIGNED|PLATFORM|NO-SURFACE}**.

> **Correction to the round's priors.** The task brief expected these to be
> near-uniformly NO-OP and flagged LSP as "removed" (CLAUDE.md line 189
> `LSP Server | Removed`). That table row is **stale**: OCC ships a **live LSP
> client** (`src/services/lsp/`, initialized unconditionally at
> `src/main.tsx:2720`) and a live plugin-hook + worktree-subagent surface. One
> entry (**#55**) is a genuine PORT-CANDIDATE; two more (**#23**, **#43**) are
> verified ALREADY-ALIGNED rather than absent.

## Summary

| # | Surface | Verdict | One-line evidence |
|---|---------|---------|-------------------|
| 18 | Cowork cloud session state | NO-OP{PLATFORM} | "waiting for input" is a Cowork Sessions-API server state; no CLI delta; OCC cloud surface is poll-only (`RemoteAgentTask.tsx:633`) |
| 19 | Cowork phone-join suggestions | NO-OP{PLATFORM} | `set_prompt_suggestions_paused` byte-identical v287↔v288; OCC has no joining-host relay (`remoteControlServer.ts` = /status,/prompt,/stop only) |
| 23 | plugin hook + worktree subagent cwd | **NO-OP{ALREADY-ALIGNED}** | whole worktree turn wrapped in `runWithCwdOverride` (`AgentTool.tsx:813/867`); hooks + Bash/Grep/Glob all read ALS-aware `getCwd()`; hook spawns with `cwd:safeCwd` (`hooks.ts:1956`) |
| 33 | Cowork Edit-and-Retry vs /compact | NO-OP{PLATFORM} | delta fully recovered (`transcriptGcOn`→`rowsOffDisk` + deleted-rows check) but lives in remote `rewind_conversation`; OCC rewind is local-only (`REPL.tsx:3884`) |
| 42 | Desktop Code-tab MCP `memory` | NO-OP{PLATFORM} | "memory" ∉ OCC reserved MCP names (`config.ts:1588`); subagent MCP wiring (`runAgent.ts:242`) has no name filter |
| 43 | Claude-in-Chrome read-only asks | **NO-OP{ALREADY-ALIGNED}** | OCC `WebBrowserTool` auto-allows read-only `screenshot`/`get_page_text`, gates only `navigate` (`WebBrowserTool.ts:9-12`, `actions.ts:25`) |
| 51 | Remote Control cleanup archiving | NO-OP{PLATFORM} | zero "archiv" in `src/remote|daemon|server`; only cloud-review sidecar archives (`teleport.archiveRemoteSession`); no string delta ("re-attached"=0 both) |
| 55 | LSP request timeout | **PORT-CANDIDATE** | OCC LSP client live (`main.tsx:2720`), `sendRequest` has NO timeout (`LSPClient.ts:289-304`); official adds `requestTimeout` "Defaults to 60000" (v287:0 → v288:2 @byte 101997701) |
| 81 | VS Code MCP "Check connection" | NO-OP{PLATFORM} | "Check connection" ∉ binary; OCC CLI /mcp status strings already match (`services/mcp/utils.ts:461`) |
| 82 | VS Code New-Conversation shortcut | NO-OP{PLATFORM} | no marker in binary; OCC is single-view terminal REPL (`ctrl+n`=`select:next`, `defaultBindings.ts:144`) |
| 83 | VS Code chat-view archive/resume | NO-OP{PLATFORM} | no marker; OCC has no chat-view archive-then-resume surface |
| 84 | Cloud-sessions admin switch | NO-OP{PLATFORM} | claude.ai org-admin web UI; nothing in CLI binary, no OCC admin surface |
| 85 | Stop vs self-hosted runner starting | NO-OP{NO-SURFACE} | OCC `self-hosted-runner/main.ts` is a 3-line stub; fix is server-side queue cancel (no client delta) |
| 86 | Claude Tag "Remove this scope" | NO-OP{PLATFORM} | ∉ binary; OCC Slack surface is only `/install-slack-app` browser opener |
| 87 | Claude Tag cross-channel thread follow | NO-OP{PLATFORM} | relay prompts identical v287↔v288; OCC RemoteControl binds a single channel, no thread concept |
| 88 | Claude Tag Configure-page save errors | NO-OP{PLATFORM} | ∉ binary; no OCC channel-Configure surface |

**Tally: 1 PORT-CANDIDATE (#55) · 2 NO-OP{ALREADY-ALIGNED} (#23,#43) · 12 NO-OP{PLATFORM} · 1 NO-OP{NO-SURFACE} (#85).**

---

## #55 — PORT-CANDIDATE (the one real port in this cluster)

**Changelog (abridged).** LSP tool calls hung indefinitely when a language
server uses dynamic capability registration or stops responding; requests now
time out after 60s (per-server `requestTimeout`).

**Official delta (byte-level, v287→v288).** New LSP server-config field. The
schema `.describe()` strings sit contiguously at v288 byte **101997701**:
```
Maximum time to wait for server startup (milliseconds)          → startupTimeout
Maximum time to wait for graceful shutdown (milliseconds)       → shutdownTimeout
Maximum time to wait for the server to answer a request
  (milliseconds). Defaults to 60000.                            → requestTimeout  ★NEW
Whether to restart the server if it crashes.
```
- `grep -aobF "Maximum time to wait for the server to answer a request"`:
  **v287 = 0 hits, v288 = 2 hits** (confirmed in `s287s.txt`=0 / `s288s.txt`=2).
- Zod field: `requestTimeout: z.number().int().positive().max(2147483647).optional()`.
- Arming code (v288): `…"close",()=>this.deleteSession(r,s)),n.requestTimeout)s.setTimeout(n.requestTimeout,i);…`
- Runtime error text (v288): `Request has exceeded the configured ${r} ms requestTimeout.`
- (`"Cannot destructure property 'requestTimeout'…"` also appears but in an
  **AWS-SDK/NodeHttpHandler** context @byte 102127176 — coincidental, not the LSP marker.)

**OCC surface shares the bug (live, verified).**
- LSP client subsystem is **live**, not removed: `initializeLspServerManager()`
  is called **unconditionally** at `src/main.tsx:2720` (after trust); LSP servers
  are contributed by plugins (`src/services/lsp/config.ts:11` "only supported via
  plugins"). `shutdownLspServerManager` registered for cleanup (`init.ts:189`);
  re-initialized on plugin change (`useManagePlugins.ts:146`, `plugins/refresh.ts:145`).
- Live consumers: `FileEditTool.ts:686-700` and `FileWriteTool.ts:631-643` call
  `lspManager.changeFile()/saveFile()`; the `ENABLE_LSP_TOOL`-gated `LSPTool`
  (`tools.ts:228`) sends **requests** `goToDefinition`/`hover`/`documentSymbol`
  (`LSPTool.ts:63-95`).
- **The gap:** `src/services/lsp/LSPClient.ts:289-304` `sendRequest()` is
  `return await connection.sendRequest(method, params)` inside a try/catch that
  only *logs* — **no timeout**. A server that stops answering (or stalls on
  dynamic capability registration) hangs the request forever.
- OCC's LSP config reads `startupTimeout` (implemented, `LSPServerInstance.ts:240-244`)
  and `shutdownTimeout` (warns "not yet implemented", `:100-102`) but has **no
  `requestTimeout`**; `grep -rniI "requestTimeout|answer a request|60000" src/services/lsp src/tools/LSPTool` → empty. Config type is a stub (`types.ts` = `any`).

**Port guidance (feasible, faithful).** OCC already has the exact helper pattern
to reuse: `withTimeout(promise, ms, message)` at `LSPServerInstance.ts:499-510`
(currently used for `startupTimeout`). Port = (1) add `requestTimeout` to the LSP
server config read path (default **60000ms**), (2) wrap `LSPClient.sendRequest`'s
`connection.sendRequest(...)` in `withTimeout(..., config.requestTimeout ?? 60000,
"Request has exceeded the configured ${ms} ms requestTimeout.")`. **Blast radius:**
only affects sessions where a plugin provides an LSP server (and, for tool calls,
`ENABLE_LSP_TOOL`); the passive FileEdit/FileWrite path uses notifications, so the
hang primarily bites `LSPTool` requests and any pull-diagnostics request. Before
landing, extract the full official `sendRequest` wrapper from v288 for byte-faithful
error text + default-application site (per `aligning-with-official-binary`).

**Verdict: PORT-CANDIDATE.**

---

## #23 — NO-OP{ALREADY-ALIGNED}

**Changelog (abridged).** A plugin's `tool.call` hook made Bash fail and file
searches read the wrong folder in subagents that run in a worktree.

**Official mechanism.** A plugin hook on tool calls perturbed the cwd seen by the
subsequent tool when the subagent ran in an isolated worktree — i.e. the hook path
let the tool's `getCwd()` resolve to the *parent* cwd instead of the worktree.
(The fix is a cwd-source/logic change; it adds no distinctive string, so it is not
isolable in the string diff — expected for this class of fix.)

**OCC is architecturally immune / already correct.**
- OCC has real worktree-isolated subagents: `createAgentWorktree` +
  `buildWorktreeNotice(worktreeCwd, parentCwd)` (`forkSubagent.ts:205-209`),
  `getWorktreeResult()` (`agentToolUtils.ts:546`).
- The **entire** subagent lifecycle runs inside the cwd override:
  `wrapWithCwd = fn => cwdOverridePath ? runWithCwdOverride(cwdOverridePath, fn) : fn()`
  (`AgentTool.tsx:712`), applied to both async and sync agent runs
  (`AgentTool.tsx:813` and `:867`, wrapping `runAsyncAgentLifecycle` / the sync body).
  The code comment (`AgentTool.tsx:689-692`) states this is deliberate so even
  `buildAgentSystemPrompt()` runs where `getCwd()` returns the worktree.
- `runWithCwdOverride` uses `AsyncLocalStorage` and `getCwd()` reads it
  (`src/utils/cwd.ts:12-31`), propagating across await/generator boundaries.
- **Both** the hook payload and the tools read the same ALS-aware `getCwd()`:
  hook input `cwd: getCwd()` (`hooks.ts:475`), hook child process spawned with
  `cwd: safeCwd` where `safeCwd = (await pathExists(getCwd())) ? getCwd() : getOriginalCwd()`
  (`hooks.ts:1956-2023`, with an explicit comment about worktree-removed paths via
  AsyncLocalStorage); `BashTool.tsx:30`, `GrepTool.ts:4/259`, `GlobTool.ts:5/116`
  all source cwd from `getCwd()`.
- OCC's hook events are **gating/post-hoc** (`PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, … — `loadPluginHooks.ts:31-63`); there is **no wrapping
  `tool.call` middleware** that re-dispatches the tool in a fresh context, which is
  the vector that loses the ALS store. `runPreToolUseHooks` resolves a permission
  decision (`toolHooks.ts:529+`), it does not re-invoke the tool.

Since hooks and tools share one ALS context that is never reset by hook execution,
OCC cannot reproduce "hook makes Bash/file-search use the parent cwd."
**Verdict: NO-OP{ALREADY-ALIGNED}.**

## #42 — NO-OP{PLATFORM}

**Changelog (abridged).** Subagents in Claude Desktop's Code tab got none of the
tools of a user-configured MCP server named `memory`.

- Trigger surface (Claude Desktop Code tab) is absent from OCC.
- The bug mechanism (an MCP server named `memory` dropped for subagents) does not
  map to OCC: `isReservedMcpServerName` (`services/mcp/config.ts:1588`) reserves
  only `claude-in-chrome`, `computer-use`, the Claude Browser/Preview set,
  `workspace`, and `widgets` — **not `memory`**. `grep -rniI "'memory'|memoryServer"
  src/services/mcp src/tools/AgentTool/*` → no name-based filter.
- OCC subagent MCP wiring connects servers by name and merges parent+agent clients
  (`runAgent.ts:242 getMcpConfigByName`, `:857-869`) with no `memory` collision.

**Verdict: NO-OP{PLATFORM}** (Desktop-Code-tab product; OCC subagent-MCP path has
no `memory` name filter, so no shared bug).

## #43 — NO-OP{ALREADY-ALIGNED}

**Changelog (abridged).** Claude in Chrome asked before every screenshot and page
read on an allowed site when auto mode is unavailable (e.g. `disableAutoMode` or an
older model); typing, navigation and JavaScript still ask.

- OCC's browser-action executor already implements the *fixed* granularity:
  `WebBrowserTool.ts:9-12` — `navigate` (state-mutating; asks per host),
  `get_page_text` (read-only; **auto-allowed**), `screenshot` (read-only;
  **auto-allowed**), `browser_batch` (read-only iff every sub-action is read-only);
  `isReadOnlyAction()` = `get_page_text || screenshot` (`actions.ts:25-26`). OCC's
  WebBrowser implements only navigate/get_page_text/screenshot/browser_batch
  (`actions.ts:155`) — no typing/JS actions exist to gate.
- OCC does have `disableAutoMode` plumbing (`REPL.tsx:732/2976`
  `checkAndDisableAutoModeIfNeeded`, gated by live `feature('TRANSCRIPT_CLASSIFIER')`;
  `policyLocks.ts:136/151`) and Claude-in-Chrome hooks — but those hooks only relay
  prompts and sync the overall permission *mode* to the extension
  (`usePromptsFromClaudeInChrome.tsx:51-52` `set_permission_mode` →
  `skip_all_permission_checks`|`ask`); they do **not** gate individual
  screenshots/page-reads. So there is no "ask before every read-only browser action"
  path in OCC to fix.

**Verdict: NO-OP{ALREADY-ALIGNED}** (read-only browser actions are unconditionally
auto-allowed in OCC; the official Chrome-extension product path is not replicated).

## #51 — NO-OP{PLATFORM}

**Changelog (abridged).** Remote Control cleanup archived a session that was still
connected or had just been re-attached by another Claude Code process.

- No string delta: `grep -aobF "re-attached"` = 0 in both binaries; `"still connected"`
  = 4 in both (pre-existing) → logic-only fix in the Remote Control cleanup path.
- OCC's Remote Control daemon has **no archive-on-cleanup lifecycle**:
  `grep -rniI "archiv" src/remote src/daemon src/server` → **zero** hits.
  `RemoteSessionManager.disconnect()` (`RemoteSessionManager.ts:308-315`) only closes
  the websocket and clears pending permission requests; `remoteControlServer.ts`
  exposes `/status,/prompt,/stop,/prompts/drain` with a single `activeChannel`
  binding (`:143-144`) and no session-archive concept.
- OCC's only session-archiving lives in the **cloud-review sidecar**
  (`RemoteAgentTask.tsx:20 archiveRemoteSession` from `utils/teleport.js`,
  `remoteReviewFailure.ts:64 'session_archived'`) — a different subsystem that polls
  review status, not a cleanup racing a live connection.

**Verdict: NO-OP{PLATFORM}** (OCC's Remote Control daemon differs and has no
cleanup-archiving a connected session).

---

## Cowork / Cloud-sessions cluster (#18, #19, #33, #84, #85)

### #18 — NO-OP{PLATFORM}
WebFetch permission prompt for an unapproved URL went unanswered 5 min → Cowork
cloud session stayed "waiting for input". Binary: `"WebFetch permission"` string
identical v287↔v288 (offsets 101900232 / 102016628); `permission_prompt` count
27=27; the cloud watcher string `"waiting for input that nothing on this machine
can give"` present in **both** (2=2, pre-existing). `needs_input` context diff =
minifier-rename noise only. OCC: `grep -rniE "requires_action|pendingAction"
src/remote src/server src/daemon` → no match; OCC's cloud surface is poll-only
(`RemoteAgentTask.tsx:633,738` check `sessionStatus === 'archived'|'idle'`) and
never reports a waiting-for-input state to a product UI. The "marked as waiting for
input" state is a Cowork Sessions-API server concern.

### #19 — NO-OP{PLATFORM}
Prompt suggestions missing on a phone joining a Cowork cloud session started
elsewhere. Binary: `set_prompt_suggestions_paused` 9=9 with byte-identical logic
(rename noise only); `promptSuggestions` 30=30; the sole real addition in that
context is a memoized Redux selector `function i1t(X){return X.promptSuggestion}` —
not join/host relay logic. OCC: `grep -rn "set_prompt_suggestions_paused|
setPromptSuggestionsPaused" src/` → no match; `remoteControlServer.ts` (473 lines)
has no host-attach or suggestions-relay protocol. Phone-join + suggestion relay is
Cowork mobile/backend.

### #33 — NO-OP{PLATFORM} (delta fully recovered; keep on file)
Edit-and-Retry refused a message sent before `/compact` though its history was
saved. Binary delta **fully recovered** in the remote-control `rewind_conversation`
path: flag renamed `transcriptGcOn` (v287:4 / v288:0, @103244909) → `rowsOffDisk`
(v287:0 / v288:4, @103348153); logic bodies @224921180 (v287) / @226246326 (v288).
v287 cut-resolver `Ql(e,r,n,{transcriptGcOn:s=!1})` unconditionally sliced history
from the last compact boundary (`e.findLastIndex(Bi)`) when GC was on → any
pre-`/compact` target resolved to `{refuse:"target_not_found"}` (the bug). v288
`Cd(e,r,n,{rowsOffDisk:s})` first tries the cut against **full** history and accepts
it if new helper `Vl(e,cut,s)` shows none of the rows the rewind needs are in
`s.deleted` (rows actually evicted from disk), only then falling back to
post-boundary slicing; handler also gained a settle-wait
`let J=$t.stopSettling;if(J!==void 0)await lt(J,vl);`. OCC:
`grep -rn "rewind_conversation|transcriptGcOn|rowsOffDisk" src/` → no match;
`remoteControlServer.ts` implements no control subtypes; OCC rewind is local-only
(`REPL.tsx:3884 rewindConversationTo` slices the in-memory array via `lastIndexOf`,
no compact-boundary/GC refusal) and cannot exhibit the bug. **Do not port now** (no
`rewind_conversation` surface); delta recorded should OCC ever add remote rewind.

### #84 — NO-OP{PLATFORM}
Cloud-sessions switch in Claude Code admin settings stayed locked off while an
unrelated security setting loaded/failed. `grep -aobF "locked off"` /
`"Cloud sessions switch"` in v288 → no match; `admin settings` strings in the binary
are only embedded prior-release changelog text. This is the claude.ai org-admin web
UI (not shipped in the CLI bundle); OCC has no admin-settings surface.

### #85 — NO-OP{NO-SURFACE}
Stop while a self-hosted runner was still starting didn't cancel the queued message
(could run once the runner came up). Binary: runner API surface identical
(`pollWork`, `ReleaseSession`, `NackSpawnHint`, `reportSessionFailure` unchanged;
`cancelQueued`/`interrupt` 6=6, rename-only); the only new `self_hosted` token is log
category `self_hosted_move_start` (@101120380), unrelated to Stop/cancel — the
queued-message cancellation lives in the cloud control plane (server queue),
invisible to the CLI. OCC: `src/self-hosted-runner/main.ts` is a **3-line
auto-generated stub** (`export const selfHostedRunnerMain = (args) =>
Promise.resolve()`); `grep -ciE "queued"` → 0. OCC has no self-hosted runner at all.

---

## VS Code extension + Claude Tag cluster (#81, #82, #83, #86, #87, #88)

Global binary finding: **none** of these six leaves a product-string delta in the
v288 CLI binary. `grep -acF` on `s288s.txt`: `"Remove this scope"`=0,
`"related Slack thread"`=0, `"channel instructions"`=0, `"lost access"`=0,
`"Check connection"`=0 (also 0 in s287), `"New Conversation shortcut"`=0,
`"archive the one"`=0. The VS Code extension (webview + extension host) and the
Claude Tag admin/Configure web UI ship outside the CLI binary.

### #81 — NO-OP{PLATFORM}
claude.ai connector stuck on "Needs authentication"; MCP dialog now offers *Check
connection*. `"Check connection"` ∉ binary (the 3 `checkConnection` hits are
undici's keep-alive pool, present in v287 too). `"Needs authentication"` is shared
CLI `/mcp` status text present in **both** versions (s287=4 / s288=4); the new288
lines are churned minified lines, not the fix. OCC already mirrors the official CLI
`/mcp` status strings (`services/mcp/utils.ts:461 return '! Needs authentication'`,
`components/mcp/MCPListPanel.tsx:360`, `cli/handlers/mcp.tsx:37`); *Check connection*
is a VS Code-extension MCP-dialog action the CLI (official and OCC) lacks.

### #82 — NO-OP{PLATFORM}
Cmd/Ctrl+N New-Conversation shortcut fired in every visible Claude view.
`"New Conversation"`=0 in new288; the 7 `newConversation` hits are `newConversationId`
on `conversation_reset` SDK events, unrelated to extension keybindings. OCC is a
single-view terminal REPL — `ctrl+n` = `select:next` list navigation
(`keybindings/defaultBindings.ts:144`); multi-view keybinding fan-out is structurally
impossible.

### #83 — NO-OP{PLATFORM}
Chat view resumed the next saved session after archiving the shown one; now starts a
new conversation. `"resuming the next"`=0; the 3 `"saved session"` hits are
provenance prompt text, not chat-view session handling. OCC has no chat-view
archive-then-resume surface (`grep -rniE "chatview|resumeNextSession|archivedSession"`
→ no match; `ResumeConversation.tsx` has no archive concept).

### #86 — NO-OP{PLATFORM}
Claude Tag admin settings offered "Remove this scope" (always failed) on
auto-created channel settings. `"Remove this scope"`=0 in new288/s288 (the 2
`"this scope"` hits are protobufjs CodeGen messages). `"Claude Tag"` appears 8× but
only as tip text (`/install-slack-app` promo), skill descriptions, a session-type
label (`"claude_in_slack"→"Claude Tag in Slack"`), a session prompt, and the embedded
changelog — no admin scope-management code. OCC's Slack surface is only
`commands/install-slack-app/install-slack-app.ts` (opens the Slack marketplace URL,
bumps `slackAppInstallCount`).

### #87 — NO-OP{PLATFORM}
Claude now also follows a related Slack thread in another channel it only read.
`"Slack thread"` hits are the Claude-Tag relay prompt (`"[Verified human message
relayed from the bound Slack thread]"`) present **identically in v287** (2=2) + a
skill-doc example; cross-channel phrases (`"related thread"`, `"another channel"`,
`"thread subscription"`, `"bind thread"`) = 0 in new288. OCC's Remote Control binds
a single `activeChannel` (`remoteControlServer.ts:144`) with no thread concept;
`SlackChannelHeader.tsx` only renders `#channel-name`. Server-side Claude Tag
thread-subscription orchestration.

### #88 — NO-OP{PLATFORM}
Configure-page save errors: too-long channel instructions now say "shorten"; a save
refused for lost access no longer says "try again". `"Configure page"`=1 hit inside
the embedded historical changelog blob; `"channel instructions"`=0; `"lost access"`=0;
the `"shorten"`/`"too-long"` hits are generic CLI internals (reactive-compact
`prompt-too-long`, `x-cc-retry-after-too-long` header, SDK schema describe). No OCC
channel-Configure surface.

---

## Cluster conclusion

Of 16 platform-specific entries, exactly **one** is a real portable fix for OCC:

- **#55 (LSP `requestTimeout`, default 60s)** — **PORT-CANDIDATE**. OCC's LSP client
  is live and its `sendRequest` has no timeout; the official delta (config field +
  "Defaults to 60000" + arming + error text) is recovered byte-level and OCC already
  has the `withTimeout` helper to reuse.

Two entries the brief expected to be absent are instead **already correct** in OCC
and need no work: **#23** (worktree-subagent cwd is uniformly ALS-sourced across
hooks and tools; no wrapping `tool.call` middleware) and **#43** (WebBrowserTool
auto-allows read-only screenshot/get_page_text). The remaining 13 are
**NO-OP{PLATFORM}** (Cowork product/backend, Claude Desktop Code tab, claude.ai
admin web UI, VS Code extension, Claude Tag/Slack web UI, Remote Control cleanup) or
**NO-OP{NO-SURFACE}** (#85 — OCC's self-hosted runner is a stub). #33's remote-rewind
delta is fully documented above for future reference but has no OCC surface today.
