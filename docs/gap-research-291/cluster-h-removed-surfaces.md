# Cluster H — Removed / Never-Had Surfaces (2.1.290 gap sweep)

**Scope.** This cluster sweeps every line of `/tmp/changelog-290.txt` (official Claude Code
2.1.290, 190 bullet entries on lines 3–192) that is **not** claimed by another cluster
(bash auto-approve, Read-deny/symlink TOCTOU, settings/managed-settings, sandbox rules,
plan/auto-mode classifier, proxy/beta-header, MCP memory/403/combining-chars, stream-stall,
markdown/compaction/paste/secret-scan freezes, rewind, `--json-schema`/`--include-partial-messages`,
scheduled-task compaction/resume, resumed-subagent cache, effort-on-fallback, resume
responsiveness, "You should know", dialog-timeout, `❯` pointer, Bash changed-files, Read
binary msg, `Press ← again`, nonessential-traffic warm-up, WebSearch refill, line-break
filenames, SKILL.md name mismatch, Bash alias/PATH loss, "Premature close", `!` control chars,
`plansDirectory` backslash, first-launch login, macOS `/login` keychain, compaction Mac-sleep,
mod `$.process.spawn`, `/code-review` medium effort, and the 2.1.291 items).

**Total remaining entries swept: 120** (190 total − 70 owned by other clusters = 120).
Verdicts: **46 NEEDS-REVIEW**, **74 N-A**.

Method: per-surface `grep`/read verification against `src/`. A surface is **N-A** when OCC has
no real code path (stub / absent / product-only surface OCC never shipped). A surface is
**NEEDS-REVIEW** when a real OCC code path exists that the official fix would apply to (even if
the exact bug is unconfirmed — that confirmation is the follow-up review). Binaries under
`/tmp/cc29{0,1}/package/claude` were **not** executed. No files other than this one were
modified; no builds run.

---

## Surface status (grep evidence backbone)

### ABSENT / STUB surfaces → N-A

| Surface | Evidence |
|---|---|
| **Claude apps gateway** (server product: sign-in approval page, postgres store, IdP cert, retention sweep) | `grep -rInE "postgres_url\|identity provider\|retention sweep\|apps gateway\|sign-in approval" src/` → 0 relevant (the 3 `postgres` hits are MCP-server classification / `postgresql.org` preapproved URL / `POSTGRESQL_VERSION` env — unrelated). No gateway server. |
| **Claude Tag / Slack product** (fast mode, access bundles, memory files, settings cards, routines, channel instructions) | `grep -ri "Claude Tag\|claudeTag\|ClaudeTag" src/` → **0**. Only a thin `install-slack-app` installer command exists (`src/commands/install-slack-app/`), not the product backend. |
| **GitHub Code Review** (`@claude review` SaaS on PRs, nit labels, fork/Manual-mode PRs) | `grep -rInE "@claude review\|blocking review\|fork.*pull request"` → 0. OCC's `/code-review` is a *local* review (another cluster), not the GitHub Code Review product. |
| **VSCode extension** (chat UI, file pills, timestamps, agent map, Continue After Reload, settings/branch dialogs) | No `extensions/`/`vscode/` dir; `package.json` has no `vscode` engine. `grep "from 'vscode'"` → 0 real imports. The 20 `vscode` hits are all `clientType === 'claude-vscode'` SDK-host *detection* (`main.tsx:869`), terminal-env detection, and an SDK-MCP client name — OCC runs *inside* the extension's terminal but ships no extension UI. |
| **Self-hosted runner** | `src/self-hosted-runner/main.ts` = **3-line auto-generated stub** (`selfHostedRunnerMain = () => Promise.resolve()`). No `--environment` CLI flag (`grep "--environment" src/main.tsx` → 0). |
| **Mod hook API** (`turn.step`, `tool.check` event, `prompt.submit`, `turn.complete`, pane/band drawing, `$.process.spawn`, `ThemeKey`/`Color`, `gatingHooks`) | `grep -rInE "turn\.step\|tool\.check\|prompt\.submit\|turn\.complete\|gatingHooks\|ThemeKey\|\.process\.spawn" src/` → only `tool.checkPermissions` (the unrelated `Tool` interface method). The "mod" rich-hook/drawing subsystem is absent. |
| **Artifacts** (`/artifacts`, ReviewArtifactTool) | `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:3` → `export const ReviewArtifactTool: Record<string, unknown> = {};` (**empty stub**). No `/artifacts` command (only an `app:openArtifact` keybinding string). |
| **Cowork cloud-session product** | Only a hidden `--cowork` plugin-dir flag (`main.tsx:4724`, "Use cowork_plugins directory") + an opaque `"cowork"` session-kind string (`bridge/types.ts:75`). No Cowork cloud-session runner. |
| **Managed Agents onboard** (`/claude-api managed-agents-onboard`) | `grep -rInE "managed-agents-onboard\|ant apply\|deep-researcher\|quickstart" src/skills/` → 0. The `claude-api` skill exists (`src/skills/bundled/claudeApi.ts`, 196 lines + 247KB content) but has no `managed-agents-onboard` subcommand and no Managed-Agents examples. |
| **`claude plugin test`** | Plugin subcommands are `validate/list/marketplace{add,list,remove,update}/install/uninstall/enable/disable/update` (`main.tsx:4727–4844`). **No `test` subcommand.** |
| **`plugin-authoring` skill / desktop `/plugin` Code tab** | `grep "plugin-authoring"` → 0 (bundled skill .md files are intentional stubs). No desktop-app surface. |
| **Cloud-session web product** (routines, History page, working indicator, prompt-suggestions env, container `/loop` wakeup, plan presentation, `gh api` in container) | OCC is only a remote-review **client** (`RemoteAgentTask` polls a cloud review; `remoteReviewFailure.ts` strings "cloud session returned an error/exceeded/archived"). It does not host or render the claude.ai cloud-session product UI/routines/container. |
| **Interactive agents-view TUI** (sections, Ctrl+X delete, Esc "Press enter again to restart", `/loop` live status line/countdown, `n:`/Ctrl+F search focus, paste-into-reply) | `src/cli/handlers/agents.ts` header: "a background-sessions **dashboard**" — prints rows or `--json`. `grep -nE "Ctrl\+X\|section\|Press enter again\|restart this session\|isn't responding"` → 0. OCC's `claude agents` is print-only, not the interactive TUI. |

### REAL surfaces → NEEDS-REVIEW candidates

| Surface | Evidence |
|---|---|
| **daemon** (supervisor/workers/logs/respawn/scheduled) | `src/daemon/` (3252 lines, 14 files). `daemon start/stop/restart/status/logs/install/uninstall/scheduled/remote-control/hub` (`main.tsx:4628–4682`). `daemon logs` tails raw via `execSync("tail -n 200 …")` (`handlers/daemon.ts:211`) — **no control-char escaping**. `daemon/respawn.ts` = worker-process respawn (ERESPAWN budget, force SIGKILL+spawn). |
| **background sessions** (idle/transcript/scheduled lifecycle) | daemon `workerRegistry.ts` + `sessionStorage` + `ScheduleCronTool` + `.claude/scheduled_tasks.json`. |
| **attach / logs / stop commands** | `main.tsx:4684–4696` — `stop <id>` (alias `kill`), `attach <id>`, `logs <id>`. Take `<id>`; partial-**name** resolution unverified. |
| **Remote Control / remote sessions / bridge** | `src/remote/` (1132 lines: `SessionsWebSocket`, `RemoteSessionManager`, `remotePermissionBridge`, `sdkMessageAdapter`), `src/bridge/` (30+ files), `remote-control`/`rc` command (`main.tsx:4961`). |
| **teleport** | `src/utils/teleport.tsx` + `src/utils/teleport/gitBundle.ts` (`git stash create → update-ref refs/seed/stash`, `teleport.tsx:861` bundle-mode uncommitted upload). `--teleport`/`/teleport` wired (`main.tsx`). |
| **ultrareview + working-tree bundle** | `ultrareview [target]` (`main.tsx:4906`), `src/cli/handlers/ultrareview.ts`, `src/commands/review/reviewRemote.ts:236` "Branch mode: bundle the working tree" — but `reviewRemote.ts:7` `TODO(#22051): pass useBundleMode once landed so local-only / uncommitted …`. Shares `gitBundle.ts` with teleport. |
| **Claude in Chrome / WebBrowserTool / browser_batch** | `src/utils/claudeInChrome/setup.ts` (`CHROME_EXTENSION_RECONNECT_URL='https://clau.de/chrome/reconnect'`, `shouldEnableClaudeInChrome`/`shouldAutoEnableClaudeInChrome`), `--chrome`/`--no-chrome` (`main.tsx:1137`), `WebBrowserTool/actions.ts:148` `browser_batch` action. |
| **marketplace** | `src/utils/plugins/marketplaceManager.ts` (name-collision precedence at `:1325–2337`), `officialMarketplace.ts`, `plugin marketplace add/list/remove/update` (`main.tsx:4750–4787`). |
| **plugin hooks (classic events) + loading/validate/update** | `src/utils/plugins/loadPluginHooks.ts` (`PreToolUse/PostToolUse/PostToolUseFailure/Notification/UserPromptSubmit/SessionStart/Stop/StopFailure/SubagentStop/PreCompact/TeammateIdle/DirectoryAdded`), `src/utils/hooks.ts` (7306 lines; `spawn` + POSIX/shell-quote + UTF-16-safe **clipping** at `:511`), `plugin validate/update`. |
| **managed/org plugins + MCP** | `src/utils/plugins/managedPlugins.ts`, `managed-mcp.json` (`services/mcp/config.ts:70`), claude.ai cloud connectors (`settings/types.ts:553`). |
| **`--channels` permission relay** | `--channels <servers...>` (`main.tsx:4292`), `parseChannelEntries(rawChannels,'--channels')` (`main.tsx:2031`). |
| **cross-session messaging socket / SendMessageTool** | `src/tools/SendMessageTool/crossSessionSecurity.ts` (2.1.166 G5). NOTE: `--restricted`/`CLAUDE_CODE_RESTRICTED` is **not a registered flag** (`grep "--restricted" src/main.tsx` → 0; only unrelated `isRestrictedToPluginOnly`). |
| **in-process teammates** | `src/tools/shared/spawnMultiAgent.ts` (`teammate_id`, `formatAgentId`, `agent_id:552`), `TeammateIdle` hook registered. |
| **background subagents + worktree** | `src/tools/AgentTool/forkSubagent.ts` (`worktreeCwd`, isolated-worktree notice `:201–207`). |
| **WebFetch (100k truncation, no offset)** | `WebFetchTool.ts:84 maxResultSizeChars: 100_000`; `utils.ts:190 MAX_MARKDOWN_LENGTH = 100_000`, truncation at `:657`. `grep "offset" src/tools/WebFetchTool/*` → **0** (no `offset` param, no "unread" count). |
| **Workflow tool** | `WORKFLOW_SCRIPTS` flag is allowlisted/live (CLAUDE.md); `src/tools/WorkflowTool/`. |
| **/permissions + fullscreen + search** | `components/permissions/PermissionRequest.tsx:92` (fullscreen sticky area), `REPL.tsx:297 isFullscreenEnvEnabled`. |
| **skills/commands `!` shell** | `!` shell-block handling in skills/commands (Windows CRLF path relevant; the *control-char* refusal is another cluster). |
| **CLAUDE_CODE_DISABLE_ATTACHMENTS** | `src/utils/attachments.ts:837 isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS)`. |
| **SDK hosts + managed-settings startup** | SDK-host entrypoint detection (`main.tsx:869 CLAUDE_CODE_ENTRYPOINT==='claude-vscode'`), managed settings read at startup. |

---

## Coverage table — all 120 remaining entries

`L#` = line in `/tmp/changelog-290.txt`. Verdict key: **N-A** = surface stub/absent in OCC;
**NR** = NEEDS-REVIEW (real OCC code path the fix would apply to).

| L# | changelog entry (short quote) | surface | OCC grep evidence (result summary) | verdict |
|----|-------------------------------|---------|------------------------------------|---------|
| 3 | "Added `serverToolUses` to … a mod's `turn.step` hook" | mod hook API | `turn.step` → 0 | N-A |
| 4 | "Added `agentId` to the `tool.check` event of plugin hooks" | mod hook API | `tool.check` event → 0 (only `tool.checkPermissions`) | N-A |
| 5 | "Added `ceiling` to … a mod's `tool.check` hook" | mod hook API | `tool.check` → 0 | N-A |
| 6 | "Added `ThemeKey` and `Color` types to the plugin hooks typings" | mod hook API | `ThemeKey` → 0 | N-A |
| 7 | "`claude plugin validate`: each hook a mod registers … `gatingHooks`" | mod hook API (plugin validate exists) | `gatingHooks` → 0; `plugin validate` real but no mod/gating concept | N-A |
| 8 | "Added a Deny button to the Claude apps gateway's sign-in approval page" | Claude apps gateway | `sign-in approval`/`apps gateway` → 0 | N-A |
| 9 | "Added `claude attach <name>` and `claude logs <name>`: part of a session name works" | attach/logs cmds | `attach <id>`/`logs <id>` real (`main.tsx:4688/4692`); name-resolution? | **NR** |
| 10 | "`/claude-api managed-agents-onboard <url>` … `ant apply` files" | Managed Agents onboard | `managed-agents-onboard`/`ant apply` → 0 | N-A |
| 11 | "`/claude-api managed-agents-onboard <quickstart-name>` … `deep-researcher`" | Managed Agents onboard | `deep-researcher`/`quickstart` → 0 | N-A |
| 18 | "WebFetch silently dropping page text past 100,000 characters … takes an `offset`" | WebFetch | `MAX_MARKDOWN_LENGTH=100_000` real; `offset` → 0 | **NR** |
| 27 | "MCP server provided by your organization being relisted as your own after signing in" | managed/cloud MCP | `managed-mcp.json` + cloud connectors + reconnect real | **NR** |
| 28 | "`/ultrareview` dropping uncommitted changes … on Windows when `git stash create` failed … `git add -N`" | ultrareview/gitBundle | `gitBundle.ts:218` "git stash create failed … proceeding without WIP" real | **NR** |
| 30 | "replies in very long Remote Control and cloud sessions … a block at a time instead of streaming" | Remote Control | `src/remote/` + `remote-control` cmd real | **NR** |
| 31 | "background daemon's log passing terminal control characters … now show as `\uXXXX`" | daemon logs | `daemon logs` tails raw (`handlers/daemon.ts:211`), no escaping | **NR** |
| 32 | "Self-hosted runner: … very long line of … error output freezing the runner" | self-hosted runner | `main.ts` = 3-line stub | N-A |
| 33 | "plugin hook with a `.catch` being unloaded, and its `.catch` skipped … hooks worker busy" | mod hook API | `.catch`/hooks-worker → 0; OCC hooks are subprocess-`spawn` (no in-process mod worker) | N-A |
| 34 | "a mod's `turn.step` result listing a tool call … fallback had discarded" | mod hook API | `turn.step` → 0 | N-A |
| 35 | "Cowork cloud session's reply sometimes never finishing when its container restarted" | Cowork | only `--cowork` plugin-dir flag + opaque session-kind string | N-A |
| 36 | "`claude plugin validate` and plugin loading refusing a hooks module that destructures an option" | plugin loading | `plugin validate` + `loadPluginHooks.ts` real | **NR** |
| 37 | "`/ultrareview` failing to upload uncommitted changes when `core.safecrlf=true`" | ultrareview/gitBundle | working-tree bundle real (`reviewRemote.ts:236`); `safecrlf` → 0 | **NR** |
| 39 | "Windows: multi-line `!` shell blocks in skills and commands failing … CRLF" | skills/commands `!` shell | `!` shell handling real; CRLF path unverified | **NR** |
| 40 | "hanging until killed when a `/permissions` tab was clicked while searching in fullscreen" | /permissions UI | `PermissionRequest.tsx:92` fullscreen + search real | **NR** |
| 42 | "plugin hooks reading an empty `answer` on `turn.complete` for a subagent" | mod hook API | `turn.complete` → 0 (OCC has `SubagentStop`, not `turn.complete`) | N-A |
| 43 | "a mod being unloaded without a message when a refresh followed its failed reload" | mod hook API | mod reload/unload → 0 | N-A |
| 44 | "a mod's `prompt.submit` hook that drops a prompt after calling `next(e)`" | mod hook API | `prompt.submit`/`next(e)` → 0 | N-A |
| 45 | "a mod's pane or band being redrawn without end … tree that changed height" | mod drawing | `pane`/`band` drawing → 0 | N-A |
| 47 | "user-installed mod could get an organization's plugin unloaded; the mod is … unloaded" | mod hook API | mod concept → 0 (OCC has managed plugins but no mod/plugin unload-priority) | N-A |
| 49 | "a mod's inline pane being redrawn without end … tree changed height" | mod drawing | inline-pane drawing → 0 | N-A |
| 51 | "Esc in the agents view confirming 'Press enter again to restart … isn't responding'" | interactive agents view | agents = print-only dashboard; `Press enter again` → 0 | N-A |
| 52 | "agent view losing a background session's `/loop` run count, countdown and live status line … worktree" | interactive agents view | no live status line/countdown TUI | N-A |
| 53 | "`claude agents` sessions in manual permission mode asking … to read an image pasted into a reply" | interactive agents view | no paste-into-reply (print-only agents) | N-A |
| 56 | "user-installed mod could make an organization's guard skip its check; … mod … unloaded" | mod hook API | mod/guard → 0 | N-A |
| 57 | "plugin hooks stalling each redraw when a mod draws a long multi-line text … non-Latin" | mod drawing | mod draw → 0 | N-A |
| 58 | "repeated Ctrl+X in the agents view deleting the whole next section" | interactive agents view | `Ctrl+X`/section → 0 | N-A |
| 62 | "`claude respawn` re-sending an earlier message to a backgrounded session … no saved transcript" | respawn | no user `respawn` cmd; `daemon/respawn.ts` (worker respawn) + transcript resume real | **NR** |
| 63 | "Esc after an `n:` or Ctrl+F search in the agents view moving focus to a section header" | interactive agents view | search/section TUI → 0 | N-A |
| 64 | "`claude agents` saving a slash command it could not deliver to a stopped session … running it … next … restart" | background-session delivery | daemon workers + bridge messaging real | **NR** |
| 65 | "`/ultrareview` uploading uncommitted changes unfiltered for … git filter driver named `unset`/`unspecified`" | ultrareview/gitBundle | bundle upload real; filter-driver handling → 0 | **NR** |
| 67 | "`claude --teleport` and `/teleport` deleting the files in a folder … when you chose to stash" | teleport | `teleport/gitBundle.ts` `git stash create` real | **NR** |
| 68 | "Esc confirming agent view's 'Press enter again to restart this session fresh'" | interactive agents view | restart-fresh TUI → 0 | N-A |
| 69 | "agent view's `/loop` run count freezing and its countdown disappearing after `/clear`" | interactive agents view | countdown TUI → 0 | N-A |
| 70 | "`--channels` permission relay: a reply ID that repeats within a session is now ignored" | --channels relay | `--channels` + `parseChannelEntries` real | **NR** |
| 71 | "`/chrome` 'Reconnect extension' not restoring browser tools after a failed Chrome connection" | Claude in Chrome | `CHROME_EXTENSION_RECONNECT_URL` + reconnect logic real | **NR** |
| 72 | "mods staying off for people who reach Claude through a gateway (`ANTHROPIC_BASE_URL` … `ANTHROPIC_AUTH_TOKEN`)" | mod hook API | mod system → 0; no `ANTHROPIC_AUTH_TOKEN` gating in plugins | N-A |
| 73 | "replies sent from `claude agents` just after a background session crashed … retried for up to 12 seconds" | background-session delivery | daemon workers + bridge reply path real | **NR** |
| 74 | "slash commands and answers to a multiple-choice question that `claude agents` could not deliver … sent … next … restarted" | background-session delivery | daemon workers + bridge messaging real | **NR** |
| 76 | "`claude agents` failing with 'Couldn't restart the background service' … after a Homebrew upgrade" | daemon restart | daemon supervisor + `install` (launchd/systemd) real | **NR** |
| 77 | "agent view's 'restart this session fresh' re-sending an earlier message" | interactive agents view | restart-fresh TUI → 0 (respawn logic covered by L62) | N-A |
| 79 | "`claude plugin test` refusing to run after an upgrade … out-of-date saved setting" | plugin test cmd | no `plugin test` subcommand | N-A |
| 83 | "`/ultrareview` of a local branch silently leaving uncommitted work out … branches outside `.git` (git 2.54+)" | ultrareview/gitBundle | bundle path real; git-dir/2.54 handling unverified | **NR** |
| 84 | "cloud sessions staying asleep after a container restart lost a pending `/loop` wakeup" | cloud-session product | OCC is a remote-review client; no cloud-container `/loop` | N-A |
| 85 | "Claude apps gateway's retention sweep deleting a returning developer's identity row … PostgreSQL" | Claude apps gateway | `retention sweep`/gateway → 0 | N-A |
| 87 | "Claude apps gateway failing to start when the certificate … has an empty subject" | Claude apps gateway | IdP-cert/gateway → 0 | N-A |
| 88 | "Claude apps gateway exiting with a bare 'Invalid URL' when `store.postgres_url` can't be parsed" | Claude apps gateway | `store.postgres_url` → 0 | N-A |
| 89 | "background agents failing with 'Agent stalled' and Workflow tool subagents restarting … Mac woke from sleep" | bg agents + Workflow + Mac sleep | daemon bg agents + live Workflow tool real | **NR** |
| 90 | "slow or failed startup … under SDK hosts such as the VS Code extension when managed settings deny reads of many paths" | SDK-host startup | SDK-host detect (`claude-vscode`) + managed-settings startup read real | **NR** |
| 94 | "a plan written in plan mode being lost when a cloud session's container restarted" | cloud-session product | no cloud-container plan presentation | N-A |
| 97 | "artifact operations failing in a Claude Code run started from inside a cloud session" | artifacts | `ReviewArtifactTool = {}` empty stub | N-A |
| 98 | "files sent from remote sessions … refused as 'not the one approved' when four or more were sent" | remote sessions | `src/remote/` + `bridge/inboundAttachments.ts` real | **NR** |
| 100 | "a marketplace named after another GitHub marketplace's download folder stopping that marketplace" | marketplace | `marketplaceManager.ts:1325–2337` collision logic real | **NR** |
| 104 | "self-hosted runner sessions resumed after a stopped runner failing … worktree … relative symlink" | self-hosted runner | `main.ts` = 3-line stub | N-A |
| 110 | "Claude in Chrome's browser picker showing a message meant for Claude … VS Code dialog's list going stale" | Claude in Chrome | chrome integration real (VS Code-dialog half N-A) | **NR** |
| 111 | "background subagents losing write and Bash access in their worktree after the main session enters or exits a … worktree" | bg subagents + worktree | `forkSubagent.ts` worktree isolation real | **NR** |
| 112 | "background commands, the agents view and daemon workers sending telemetry and a feature-flag request … behind a Claude apps gateway" | Claude apps gateway | no apps gateway; scenario gateway-specific | N-A |
| 113 | "`--restricted` (and `CLAUDE_CODE_RESTRICTED=1`) sessions opening the cross-session messaging socket" | cross-session socket | `crossSessionSecurity.ts` real; `--restricted` flag NOT registered (staged) | **NR** |
| 114 | "sessions moved to the background while idle reopening as 'no saved transcript' after a restart or idle cleanup" | background sessions | daemon workers + transcript resume real | **NR** |
| 115 | "background workers honoring `--allow-dangerously-skip-permissions` on respawn without the … disclaimer … accepted" | daemon respawn | `daemon/respawn.ts` + permission-bypass path real | **NR** |
| 116 | "Claude replying in an endless loop when a plugin's async Stop hook passes an unquoted script path under a folder with a space" | plugin Stop hook | `Stop` hook + `hooks.ts` spawn/quoting real | **NR** |
| 129 | "permission prompts from background agents to show the Ctrl+X Ctrl+K shortcut that stops all background agents" | bg agents + permission prompt | daemon bg agents + permission-prompt UI real | **NR** |
| 130 | "built-in `plugin-authoring` skill: … the one command … to install a mod you made" | plugin-authoring skill | `plugin-authoring` → 0 (skill stubs) | N-A |
| 131 | "reply to `/plugin` in the desktop app's Code tab" | desktop app | no desktop-app surface | N-A |
| 133 | "Claude apps gateway's log when an upstream's cloud credentials or connection fail" | Claude apps gateway | gateway → 0 | N-A |
| 134 | "error … when a cloud session is started without a claude.ai sign-in: it now names `claude auth login` and /login" | remote-review auth | `remoteReviewFailure.ts` handles sign-in/account-mismatch | **NR** |
| 136 | "error … when a git config file stops the `/ultrareview` upload … half as long" | ultrareview upload errors | `diffTooLargeError.ts` + `formatPreconditionError` real | **NR** |
| 137 | "errors … when the `/ultrareview` upload refuses a checkout: each known cause … its own message" | ultrareview upload errors | ultrareview error-formatting path real | **NR** |
| 138 | "Claude apps gateway to log a warning during the last 30 days before the certificate … expires" | Claude apps gateway | gateway/IdP-cert → 0 | N-A |
| 139 | "Claude in Chrome: a `browser_batch` call now gets 90 seconds, up from 60" | Claude in Chrome | `WebBrowserTool/actions.ts:148` `browser_batch` real | **NR** |
| 140 | "Claude apps gateway's browser sign-in pages: brand fonts, centered layout, and dark mode" | Claude apps gateway | gateway sign-in pages → 0 | N-A |
| 144 | "Claude in Chrome … a project's settings files can no longer turn it on; use `--chrome`, `/chrome` or … user settings" | Claude in Chrome settings | `shouldEnableClaudeInChrome` reads settings; `--chrome` real | **NR** |
| 147 | "background daemon's log to write a multi-line message as one JSON-quoted line" | daemon log | daemon log write path real | **NR** |
| 149 | "`/artifacts`: opening an artifact in your browser now closes the list" | artifacts | `ReviewArtifactTool = {}` stub; no `/artifacts` cmd | N-A |
| 151 | "plugin hooks … long text is clipped and logged instead of being refused or dropped silently" | plugin hooks | `hooks.ts:511` UTF-16-safe clipping real | **NR** |
| 152 | "background sessions whose scheduled task is gone: they now move to Completed about 20 seconds later" | background sessions + scheduled | daemon scheduled + `.claude/scheduled_tasks.json` real | **NR** |
| 154 | "errors … when the `/ultrareview` upload fails at a git step: they name the step and what to try" | ultrareview upload errors | ultrareview error-formatting path real | **NR** |
| 156 | "in-process teammate's `agent_id` … to its agent ID (`name@team` stays in `teammate_id`); TeammateIdle hooks no longer fire from … subagents or forks" | teammates | `spawnMultiAgent.ts` `teammate_id`/`agent_id` + `TeammateIdle` real | **NR** |
| 157 | "background sessions waiting on a scheduled wakeup (`/loop`): … left running through updates and low memory" | background sessions + /loop | daemon scheduled + `/loop` real | **NR** |
| 158 | "`/model`, `/effort` and `/rename` sent from `claude agents` to a busy background session to apply right away" | background-session delivery | daemon workers + bridge command delivery real | **NR** |
| 159 | "Claude apps gateway's minimum supported PostgreSQL version from 14 to 11" | Claude apps gateway | gateway/postgres → 0 | N-A |
| 161 | "`CLAUDE_CODE_DISABLE_ATTACHMENTS` … a repository's `.claude/settings.json` … can no longer set it" | attachments env | `attachments.ts:837` reads env; settings→env propagation real | **NR** |
| 162 | "`claude plugin update` on a plugin loaded from a directory to print just its reason, without … 'Failed to update plugin'" | plugin update | `plugin update` cmd real (`main.tsx:4834`) | **NR** |
| 163 | "built-in `gh api` in cloud sessions: a host other than github.com set in `GH_HOST`/`GH_REPO` … refused" | cloud-session product | no cloud-container `gh api` | N-A |
| 164 | "`claude-api` skill's Managed Agents examples … turn off the web tools … `auto` permission policy" | Managed Agents content | `managed agents` examples → 0 in claude-api skill | N-A |
| 165 | "Self-hosted runners: … `claude --environment <id>` … through the current Sessions API" | self-hosted runner | runner stub; no `--environment` flag | N-A |
| 166 | "[VSCode] … screen reader announcement, 'Message queued.'" | VSCode extension | no extension UI | N-A |
| 167 | "[VSCode] … run a plugin marketplace's install or update command from the Manage plugins dialog" | VSCode extension | no extension UI | N-A |
| 168 | "[VSCode] … blank chat … keeping a background Claude process running" | VSCode extension | no extension UI | N-A |
| 169 | "[VSCode] … settings dialogs blaming a timeout when Claude Code stopped … during a save" | VSCode extension | no extension UI | N-A |
| 170 | "[VSCode] … branch switch dialog offering to switch when it could not check for uncommitted changes" | VSCode extension | no extension UI | N-A |
| 171 | "[VSCode] … permission prompt … behind an open dialog taking keyboard focus" | VSCode extension | no extension UI | N-A |
| 172 | "[VSCode] … sign-in and new sessions giving no clear reason when Claude Code cannot find or start its program" | VSCode extension | no extension UI | N-A |
| 173 | "[VSCode] … agent map showing a nested sub-agent with 'Tool calls (0)'" | VSCode extension | no extension UI | N-A |
| 174 | "[VSCode] Improved Continue After Reload" | VSCode extension | no extension UI | N-A |
| 175 | "[VSCode] … file pills … hovering one now shows the file's path" | VSCode extension | no extension UI | N-A |
| 176 | "[VSCode] … message timestamps to show by default" | VSCode extension | no extension UI | N-A |
| 177 | "[Cloud sessions] … turning off prompt suggestions through a cloud environment's environment variables" | cloud-session product | no cloud-env product surface | N-A |
| 178 | "[Cloud sessions] … working indicator … spinning on for several seconds after Claude's reply had finished" | cloud-session product | no cloud-session web UI | N-A |
| 179 | "[Cloud sessions] … History on a never-run routine's page still saying 'No runs yet' after … Run now" | cloud-session product | no routines/History UI | N-A |
| 180 | "[Cloud sessions] … unarchived cloud session looking as if Claude were still working" | cloud-session product | no cloud-session web UI | N-A |
| 181 | "[Remote Control] … a computer that just started Remote Control taking up to a minute to appear in the … menu" | Remote Control | `remote-control` cmd + `RemoteSessionManager` real | **NR** |
| 182 | "[Claude Tag] Added fast mode in Slack: … `!fast`" | Claude Tag/Slack | `Claude Tag` → 0 | N-A |
| 183 | "[Claude Tag] … Path prefixes field … custom connection in an access bundle" | Claude Tag/Slack | access-bundle → 0 | N-A |
| 184 | "[Claude Tag] … Admin permission getting 'Couldn't load memory files' on the Activity page's Memory tab" | Claude Tag/Slack | product → 0 | N-A |
| 185 | "[Claude Tag] … workspace guest's Confirm on a Claude settings card in Slack removing its buttons" | Claude Tag/Slack | product → 0 | N-A |
| 186 | "[Claude Tag] … scheduled routines in Slack channels running on a model other than the channel's default" | Claude Tag/Slack | product → 0 | N-A |
| 187 | "[Claude Tag] … GitHub repositories in an access bundle attached by a channel-name rule being refused" | Claude Tag/Slack | product → 0 | N-A |
| 188 | "[Claude Tag] … notice in your direct messages when your own Claude plan's usage limit is reached" | Claude Tag/Slack | product → 0 | N-A |
| 189 | "[Claude Tag] … earlier Claude in Slack app's reply when it can't start a session" | Claude Tag/Slack | product → 0 | N-A |
| 190 | "[Claude Tag] … channel instructions limit to 8,192 characters instead of bytes" | Claude Tag/Slack | product → 0 | N-A |
| 191 | "[Code Review] … blocking review comments sometimes opening with a 'nit' label" | GitHub Code Review | `@claude review`/nit → 0 | N-A |
| 192 | "[Code Review] … tips to comment '@claude review' … on fork and Manual-mode pull requests" | GitHub Code Review | product → 0 | N-A |

**Row count check:** 120 rows (L3–L192 excluding the 70 other-cluster lines). 46 NR + 74 N-A = 120. ✔

---

## NEEDS-REVIEW detail (46 entries)

Grouped by surface. Each quotes the changelog and states the real OCC code path + what the
follow-up review must confirm.

### Remote Control / remote sessions / bridge (L30, L98, L181)

- **L30** — *"Fixed replies in very long Remote Control and cloud sessions that could appear a
  block at a time instead of streaming in."* OCC ships a real Remote Control stack
  (`src/remote/RemoteSessionManager.ts`, `SessionsWebSocket.ts`, `remote-control`/`rc` command at
  `main.tsx:4961`). Review whether OCC's remote-session reply transport degrades to block-at-a-time
  delivery on long sessions (buffering/flush in the WS relay) rather than streaming token-by-token.
- **L98** — *"Fixed files sent from remote sessions sometimes being refused as 'not the one
  approved' when four or more were sent at once."* OCC has `src/bridge/inboundAttachments.ts` and a
  remote permission bridge (`src/remote/remotePermissionBridge.ts`). Review the multi-attachment
  approval path for an index/identity mismatch when ≥4 files arrive together.
- **L181** — *"[Remote Control] Fixed a computer that just started Remote Control taking up to a
  minute to appear in the Remote Control menu of a new session; it now appears within seconds."*
  OCC has the `remote-control` worker + `RemoteSessionManager` peer discovery (`ListPeersTool`).
  Review the peer-announcement/discovery interval that governs how fast a newly started RC host
  shows up.

### daemon (L31, L147) + background sessions (L64, L73, L74, L76, L114, L115, L129, L152, L157, L158) + respawn (L62)

- **L31** — *"Fixed the background daemon's log passing terminal control characters to the screen
  under `claude daemon run` and `claude daemon logs`; they now show as `\uXXXX` escapes."* OCC's
  `daemon logs` handler (`src/cli/handlers/daemon.ts:211`) does `execSync("tail -n 200 …")` and
  writes raw bytes to the terminal with **no** control-char escaping. Directly applicable — review
  adding `\uXXXX` escaping on the tail/print path.
- **L147** — *"Changed the background daemon's log to write a multi-line message as one JSON-quoted
  line."* OCC's daemon writes JSON for scheduled status (`daemon.ts:304`) but the log-event writer
  should be checked to confirm multi-line messages are emitted as a single JSON-quoted line (not
  raw multi-line, which breaks `tail`/`grep` per-pid filtering at `daemon.ts:391`).
- **L62** — *"Fixed `claude respawn` re-sending an earlier message to a backgrounded session that
  has no saved transcript instead of starting it with an empty conversation."* OCC has **no user
  `respawn` command**, but `src/daemon/respawn.ts` force-respawns workers (SIGKILL + spawn fresh)
  and background sessions restore transcripts. Review whether a respawned worker with no saved
  transcript starts empty vs. re-sending a stale message.
- **L64 / L74** — *"Fixed `claude agents` saving a slash command it could not deliver to a stopped
  session and then running it by itself the next time that session restarted"* / *"Fixed slash
  commands and answers to a multiple-choice question that `claude agents` could not deliver to a
  running session being saved and sent by themselves the next time it was restarted."* OCC has
  daemon workers + bridge inbound messaging (`src/bridge/inboundMessages.ts`, `SendMessageTool`).
  Review the undeliverable-message queue: whether a queued slash-command/answer is replayed
  unprompted on the next restart.
- **L73** — *"Fixed replies sent from `claude agents` just after a background session crashed being
  refused after 2 seconds: they are now retried for up to 12 seconds while the session restarts."*
  OCC's bridge reply path + daemon crash/respawn exist. Review the reply-after-crash timeout/retry
  window (2s vs a longer retry-until-restart).
- **L76** — *"Fixed `claude agents` failing with 'Couldn't restart the background service' and
  background sessions stopping after a Homebrew upgrade (takes effect from the upgrade after this
  one)."* OCC has a daemon supervisor + `daemon install` (launchd/systemd). Review the
  supervisor-restart-after-binary-swap path (the Homebrew trigger is packaging-specific, but the
  "service can't restart after its binary changes" failure mode maps to OCC's supervisor).
- **L114** — *"Fixed sessions moved to the background while idle reopening as 'no saved transcript'
  after a restart or idle cleanup; they now resume their conversation."* OCC has daemon background
  sessions + `sessionStorage` transcript persistence. Review the idle-cleanup/restart → transcript
  reload path for a "no saved transcript" false negative.
- **L115** — *"Fixed background workers honoring `--allow-dangerously-skip-permissions` on respawn
  without the bypass-permissions disclaimer having been accepted."* OCC's `daemon/respawn.ts` +
  worker permission mode exist. **Security-relevant** — review whether a respawned worker inherits
  bypass-permissions without re-gating on the accepted disclaimer.
- **L129** — *"Improved permission prompts from background agents to show the Ctrl+X Ctrl+K shortcut
  that stops all background agents."* OCC has background agents (daemon) + a permission-prompt UI.
  Review whether the background-agent permission prompt surfaces a "stop all background agents"
  shortcut (and whether OCC binds Ctrl+X Ctrl+K).
- **L152** — *"Changed background sessions whose scheduled task is gone: they now move to Completed
  about 20 seconds later and can be updated or shut down when idle."* OCC has daemon scheduled
  tasks (`daemon scheduled …`, `.claude/scheduled_tasks.json`). Review the lifecycle transition when
  a background session's scheduled task disappears.
- **L157** — *"Changed background sessions waiting on a scheduled wakeup (`/loop`): they are now
  left running through updates and low memory, where being restarted or shut down could silently
  lose the wakeup."* OCC has `/loop` + daemon scheduled wakeups. Review the supervisor's
  update/low-memory eviction policy for sessions with a pending wakeup (risk: silently losing it).
- **L158** — *"Changed `/model`, `/effort` and `/rename` sent from `claude agents` to a busy
  background session to apply right away, without a confirmation, instead of when the turn ends."*
  OCC has bridge command delivery to background sessions. Review whether these control commands are
  applied immediately vs. deferred to turn end.

### ultrareview + gitBundle upload (L28, L37, L65, L83, L136, L137, L154) + teleport (L67)

> OCC's `/ultrareview` (`src/cli/handlers/ultrareview.ts` → `commands/review/reviewRemote.ts`)
> bundles the working tree for cloud review; the uncommitted-changes path is **partially landed**
> (`reviewRemote.ts:7` `TODO(#22051): pass useBundleMode once landed so local-only / uncommitted
> …`). The `git stash create` machinery lives in `src/utils/teleport/gitBundle.ts` and is **shared**
> with teleport (`teleport.tsx:861`). All eight entries below touch that shared bundle/stash path.

- **L28** — *"Fixed `/ultrareview` dropping uncommitted changes without a warning on Windows when
  `git stash create` failed, and refusing them after a `git add -N` file was deleted or moved."*
  `gitBundle.ts:218` already logs "git stash create failed … proceeding without WIP" — review
  whether that silent-proceed needs a user-facing warning on Windows, and the `git add -N`
  (intent-to-add) deleted/moved handling.
- **L37** — *"Fixed `/ultrareview` failing to upload uncommitted changes when `core.safecrlf=true`
  is set in git's configuration."* `grep safecrlf src/` → 0. Review whether the bundle/stash path
  breaks under `core.safecrlf=true` (CRLF conversion on stash/apply).
- **L65** — *"Fixed `/ultrareview` uploading uncommitted changes unfiltered for files under a git
  filter driver named `unset` or `unspecified`; the upload now stops and asks you to rename the
  driver."* Review the bundle path against `.gitattributes` filter drivers `unset`/`unspecified`
  (currently unfiltered → potential corrupt/leaked upload).
- **L83** — *"Fixed `/ultrareview` of a local branch silently leaving uncommitted work out of the
  upload in a repository that keeps its branches outside `.git` (git 2.54+); it now refuses with an
  explanation."* Review the git-dir/refs resolution for git 2.54+ repos with external branch storage.
- **L136** — *"Improved the error shown when a git config file stops the `/ultrareview` upload: it is
  about half as long and says what kind of file is the problem."* OCC has `diffTooLargeError.ts` +
  `formatPreconditionError`; review the git-config-blocks-upload error wording.
- **L137** — *"Improved the errors shown when the `/ultrareview` upload refuses a checkout: each
  known cause now has its own message, with a way to fix it."* Review the checkout-refusal error
  taxonomy in the ultrareview/upload path.
- **L154** — *"Changed the errors shown when the `/ultrareview` upload fails at a git step: they name
  the step and what to try, and no longer repeat git's own error text."* Review the git-step failure
  messages (name the step + remedy; drop raw git stderr echo).
- **L67** — *"Fixed `claude --teleport` and `/teleport` deleting the files in a folder that had
  replaced a tracked file of the same name when you chose to stash: the stash is now refused, and
  says why."* `teleport/gitBundle.ts` performs `git stash create`; review the folder-replaced-a-
  tracked-file case where stashing would delete untracked files (data-loss risk → refuse + explain).

### Claude in Chrome / WebBrowserTool (L71, L110, L139, L144)

- **L71** — *"Fixed `/chrome` 'Reconnect extension' not restoring browser tools after a failed Chrome
  connection, and added an explanation when it can't (anthropics/claude-code#98135)."* OCC has
  `CHROME_EXTENSION_RECONNECT_URL` + reconnect flow (`claudeInChrome/setup.ts:256`). Review whether
  a failed-then-reconnected Chrome restores the browser tools (and the explanatory message).
- **L110** — *"Fixed Claude in Chrome's browser picker showing a message meant for Claude when the
  chosen browser is no longer connected, and the VS Code dialog's list going stale after a switch."*
  OCC has the chrome browser-picker path; review the "browser no longer connected" message. (The
  VS Code-dialog half is N-A — OCC ships no extension.)
- **L139** — *"Improved Claude in Chrome: a `browser_batch` call now gets 90 seconds, up from 60,
  before it is reported as timed out."* OCC has `browser_batch` (`WebBrowserTool/actions.ts:148`).
  Review the per-call timeout constant (60s → 90s).
- **L144** — *"Changed Claude in Chrome so that a project's settings files can no longer turn it on;
  use `--chrome`, `/chrome` or your user settings."* OCC's `shouldEnableClaudeInChrome`/
  `shouldAutoEnableClaudeInChrome` read settings. **Security-relevant** — review whether a
  *project* `.claude/settings.json` can currently enable Chrome (should be user/flag-only).

### plugin hooks / loading / update (classic events) (L36, L116, L151, L162)

- **L36** — *"Fixed `claude plugin validate` and plugin loading refusing a hooks module that
  destructures an option named like one of its top-level functions."* OCC has `plugin validate` +
  `loadPluginHooks.ts`. Review the hooks-module load/validate path for a name-collision false
  rejection (a destructured option shadowing a top-level function name).
- **L116** — *"Fixed Claude replying in an endless loop when a plugin's async Stop hook passes an
  unquoted script path under a folder with a space, such as Application Support."* OCC registers
  `Stop` hooks and spawns hook commands via `src/utils/hooks.ts` (`spawn`, with shell-quote/POSIX
  quoting at `:1890`). Review the async-Stop-hook command construction for an unquoted path
  containing spaces (would split into extra args → loop).
- **L151** — *"Changed plugin hooks so long text is clipped and logged instead of being refused or
  dropped silently."* OCC's `hooks.ts:511` already clips (UTF-16-surrogate-safe). Review whether
  over-long hook text is clipped+logged vs refused/dropped, matching the new behavior.
- **L162** — *"Changed `claude plugin update` on a plugin loaded from a directory to print just its
  reason, without the 'Failed to update plugin' prefix, as for built-in plugins."* OCC has
  `plugin update` (`main.tsx:4834`). Review the directory-loaded-plugin update error wording
  (`grep "Failed to update plugin"` → 0, so the prefix may already be absent — confirm parity).

### teammates (L156) / background subagents + worktree (L111) / Workflow + Mac sleep (L89)

- **L156** — *"Changed an in-process teammate's `agent_id` in Agent results to its agent ID (its
  `name@team` address stays in `teammate_id`); TeammateIdle hooks no longer fire from its subagents
  or forks."* OCC's `spawnMultiAgent.ts` sets both `teammate_id` and `agent_id` (`:552`) and
  registers `TeammateIdle`. Review the `agent_id` semantics (agent ID vs `name@team`) and whether
  `TeammateIdle` fires from a teammate's subagents/forks (should not).
- **L111** — *"Fixed background subagents losing write and Bash access in their worktree after the
  main session enters or exits a different worktree."* OCC has `forkSubagent.ts` worktree isolation
  (`worktreeCwd`). Review the permission/cwd binding of a background subagent's worktree when the
  main session switches worktrees (write+Bash access should persist).
- **L89** — *"Fixed background agents failing with 'Agent stalled' and Workflow tool subagents
  restarting from their prompt when a Mac woke from sleep."* OCC has daemon background agents + a
  **live** Workflow tool (`WORKFLOW_SCRIPTS` allowlisted). Review the Mac-wake path: monotonic-clock
  jumps causing a false "Agent stalled" and Workflow subagents re-running from their prompt.

### MCP org/cloud connector relisting (L27)

- **L27** — *"Fixed an MCP server provided by your organization being relisted as your own after
  signing in or reconnecting, including from a late result in headless and SDK sessions."* OCC
  loads `managed-mcp.json` (org/enterprise servers) alongside claude.ai cloud connectors
  (`settings/types.ts:553`) and user servers. Review the signin/reconnect merge for an org server
  being re-attributed as user-owned (incl. a late-arriving result in `-p`/SDK mode).

### WebFetch offset (L18)

- **L18** — *"Fixed WebFetch silently dropping page text past 100,000 characters; it now says how
  much was unread and takes an `offset` to read on."* OCC's WebFetch truncates at
  `MAX_MARKDOWN_LENGTH = 100_000` (`utils.ts:190`, `WebFetchTool.ts:84`) but has **no `offset`
  param** and no "unread" count. Review adding the unread-byte message + an `offset` input to
  continue reading (real, applicable gap).

### attach/logs name resolution (L9)

- **L9** — *"Added `claude attach <name>` and `claude logs <name>`: part of a session name works in
  place of the id."* OCC's `attach <id>` / `logs <id>` (`main.tsx:4688/4692`) take an id. Review
  adding partial-**name** → session resolution to both commands.

### --channels relay (L70) / cross-session socket (L113)

- **L70** — *"Fixed `--channels` permission relay: a reply ID that repeats within a session is now
  ignored instead of approving a different prompt."* OCC has `--channels` (`main.tsx:4292`) +
  `parseChannelEntries`. **Security-relevant** — review the relay reply-ID dedup (a repeated ID must
  not approve a different prompt).
- **L113** — *"Fixed `--restricted` (and `CLAUDE_CODE_RESTRICTED=1`) sessions opening the
  cross-session messaging socket."* OCC has the cross-session messaging socket
  (`SendMessageTool/crossSessionSecurity.ts`), but `--restricted` is **not a registered CLI flag**
  (only unrelated `isRestrictedToPluginOnly`; CLAUDE.md lists `--restricted` as *staged*). Review
  whether the socket opens unconditionally and how it should behave once `--restricted` lands.

### marketplace download collision (L100)

- **L100** — *"Fixed a marketplace named after another GitHub marketplace's download folder stopping
  that marketplace from downloading."* OCC's `marketplaceManager.ts` has name-collision precedence
  logic (`:1325–2337`). Review the download-folder naming when one marketplace's *name* equals
  another's *download folder* (should not block the download).

### /permissions fullscreen hang (L40)

- **L40** — *"Fixed Claude Code hanging until killed when a `/permissions` tab was clicked while
  searching in fullscreen mode."* OCC has `/permissions` + fullscreen mode
  (`PermissionRequest.tsx:92`, `REPL.tsx:297 isFullscreenEnvEnabled`) + search. Review the
  tab-click-while-searching-in-fullscreen interaction for a render/input deadlock.

### Windows `!` shell CRLF (L39)

- **L39** — *"Windows: Fixed multi-line `!` shell blocks in skills and commands failing when the
  file is saved with CRLF line endings."* OCC has `!` shell-block handling in skills/commands. Review
  the multi-line `!` block parser for CRLF-saved files on Windows (the *control-char refusal* is a
  separate, other-cluster item at L148).

### CLAUDE_CODE_DISABLE_ATTACHMENTS source restriction (L161)

- **L161** — *"Changed `CLAUDE_CODE_DISABLE_ATTACHMENTS` so a repository's `.claude/settings.json` or
  `.claude/settings.local.json` can no longer set it; shell, user and managed settings still can."*
  OCC reads `process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS` (`attachments.ts:837`). **Security-
  relevant** — review the settings→env propagation to ensure a *project*-scoped settings file cannot
  set this (only shell/user/managed).

### SDK-host startup with managed-settings deny-reads (L90)

- **L90** — *"Fixed slow or failed startup since 2.1.285 under SDK hosts such as the VS Code
  extension when managed settings deny reads of many paths on a slow filesystem (notably Windows
  drives under WSL)."* OCC detects the SDK-host entrypoint (`main.tsx:869`,
  `CLAUDE_CODE_ENTRYPOINT==='claude-vscode'`) and reads managed settings at startup. Review the
  startup settings-read path for a slow/failed boot when many deny-read rules hit a slow filesystem
  (the VS Code extension itself is N-A, but the SDK-host startup path is shared).

### remote-review auth error (L134)

- **L134** — *"Improved the error shown when a cloud session is started without a claude.ai sign-in:
  it now names `claude auth login` and /login and no longer blames API-key authentication."* OCC's
  `RemoteAgentTask/remoteReviewFailure.ts` already produces sign-in/account-mismatch strings ("cloud
  session was not found — … signed in to a different account"). Review the no-claude.ai-sign-in error
  wording to name `claude auth login`/`/login` and avoid blaming API-key auth.

---

## Notes on borderline calls

- **Interactive agents-view vs `claude agents` dashboard.** The official has a full interactive TUI
  (sections, Ctrl+X delete, Esc "Press enter again to restart", live `/loop` status line/countdown,
  `n:`/Ctrl+F search). OCC ships only a **print-only** `agents` dashboard (`--json` capable). All
  pure-TUI-interaction entries (L51, L52, L53, L58, L63, L68, L69, L77) are **N-A**; the underlying
  background-session infrastructure entries (L62, L64, L73, L74, L76, L114, L115, L129, L152, L157,
  L158) are **NEEDS-REVIEW** because OCC's daemon workers + bridge messaging are real.
- **"plugin hooks" vs "mod" hooks.** OCC has the *classic* hook events (`PreToolUse`/`Stop`/
  `SubagentStop`/`TeammateIdle`/…) and a real hook runner (`hooks.ts`, subprocess `spawn`). It does
  **not** have the *mod* rich-hook/drawing API (`turn.step`/`tool.check`/`prompt.submit`/
  `turn.complete`/pane/band/`$.process.spawn`/`ThemeKey`/`gatingHooks`). Entries about mod-specific
  events/drawing/reload (L3–L7, L33, L34, L42–L45, L47, L49, L56, L57, L72) are **N-A**; entries
  about classic hooks / plugin loading / validate / update (L36, L116, L151, L162) are
  **NEEDS-REVIEW**.
- **Cloud sessions.** OCC is a remote-review **client** (`RemoteAgentTask` polls a cloud review), not
  the claude.ai cloud-session **product**. Product-side entries (container-restart `/loop` wakeup
  L84, plan presentation L94, `gh api` in container L163, and the `[Cloud sessions]` UI block
  L177–L180) are **N-A**; client-side entries that map to OCC's remote/bridge/auth code (L30, L98,
  L134) are **NEEDS-REVIEW**.
- **ultrareview uncommitted-upload** is *partially* landed (`TODO(#22051)`), but the shared
  `gitBundle.ts` `git stash create` machinery is real (used by teleport), so the upload entries stay
  **NEEDS-REVIEW** rather than N-A.
