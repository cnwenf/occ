# Triage T2 — claude-code 2.1.308 → 2.1.309, changelog items 17–40

> Round: OCC catch-up to official 2.1.309. Scope: items 17–40 of `/tmp/cc-diff-309/items.txt` (== `## 2.1.309` in `/tmp/cc-CHANGELOG.md`).
> REPO = `workdir/occ` (branch `agent/occ/8ab7772c`), read-only. BIN309 = `/tmp/cc-diff-309/vver/package/claude`. Official ELF **never executed** — `strings`/`grep -aboF`/bounded `dd` only.
> Verdicts: **PORT** = OCC subsystem exists + lacks the fix, implement this round. **STAGED** = depends on unported subsystem / Anthropic-cloud-or-desktop-only / fix mechanism not byte-pinnable; record. **N-A** = subsystem absent, already aligned, or Claude-Desktop/Slack/GitHub-cloud/skill-content-stub only.
>
> **Tally: PORT 9 · STAGED 4 · N-A 11 (24 items).**

---

### Item 17 — VERDICT: N-A (structurally immune)
- changelog: Fixed Read reporting "File does not exist" for PDF page ranges in Linux sandboxes that share the parent's `/proc`.
- OCC surface: PRESENT. `src/tools/FileReadTool/FileReadTool.ts` (PDF branch + error message) and `src/utils/pdf.ts` (poppler `pdftoppm`/`pdfinfo` via `extractPDFPages`).
- current OCC behavior: NOT AFFECTED — structurally immune (verified by full call-chain trace). The user-facing "File does not exist." is produced at `FileReadTool.ts:1031`, inside `call()`'s catch gated on `getErrnoCode(error) === 'ENOENT'` (`:998-999`). The PDF page-range branch (`:1364-1414`) calls `extractPDFPages` (`pdf.ts:202`), which does an in-process `fs.stat` (`:212-214`) and an **unsandboxed** spawn of `pdftoppm`:
  ```ts
  // src/utils/pdf.ts:259-264
  const { code, stderr } = await execFileNoThrow('pdftoppm', args, {
    timeout: PDF_RENDER_TIMEOUT_MS, abortSignal: signal, useCwd: false,
  })
  ```
  `execFileNoThrow` runs plain `execa` (`execFileNoThrow.ts:97-191`), **never through the bwrap sandbox**, and nothing in the read path consults `/proc` (only the `isBlockedDevicePath` string check, `FileReadTool.ts:146-157`). Crucially, page-range failures are re-thrown as a plain `Error` (`FileReadTool.ts:1414`) carrying **no errno**, so the ENOENT-gated "File does not exist" branch is **unreachable** from the page-range path; internal render errors instead wrap to `{success:false, reason:'unknown'}` (`pdf.ts:327-335`). Therefore the changelog symptom (false "File does not exist" for PDF page ranges under a Linux sandbox sharing `/proc`) cannot manifest in OCC.
- official evidence: PDF page-extraction internals @ BIN309:125999980 — `Directory containing extracted page images` · `Base64-encoded page image; empty when the page could not be processed` · `Why the page could not be processed as an image; set only when base64 is empty`. Official's underlying hardening is fd-level `/proc/self/fd` verified-open, which OCC tracks **separately as STAGED** (`src/utils/permissions/symlinkResolutionStash.ts:24-33`), not on the PDF read path.
- action: N-A. OCC's PDF page-range read is structurally immune to this specific bug (unsandboxed render subprocess + ENOENT branch unreachable from page-range). The related `/proc/self/fd` verified-open hardening is a distinct STAGED track (`symlinkResolutionStash.ts`), not this changelog item. No port needed for item 17. (Supersedes an earlier draft that misattributed the message producer to `imageRead.ts`; the authoritative trace is `FileReadTool.ts:1031`/`pdf.ts:202`.)

### Item 18 — VERDICT: STAGED
- changelog: Fixed messages from a Claude Desktop-hosted session sometimes being lost when its connection refreshed.
- OCC surface: PARTIAL/ANALOGUE. OCC has a remote-control bridge (`src/bridge/replBridge.ts` — `handleIngressMessage`, `isEligibleBridgeMessage`, `BoundedUUIDSet` dedup; `bridgeMessaging.ts`), but **not** the Claude-Desktop-hosted-session transport (the desktop app spawning/driving a CC session).
- current OCC behavior: The desktop-hosted connection-refresh path is absent. OCC's bridge does ingress message dedup (`BoundedUUIDSet`) for claude.ai remote-control, a different transport than the desktop-hosted session handoff.
- official evidence: message-handoff dedup family @ BIN309:122053224 — `invalid_handoff: another handed-off turn is still queued` · `invalid_handoff: the turn carries messages the conversation already holds` · `invalid_handoff: the turn does not carry the lines of its pending delivery` · `invalid_handoff: some of the calls are already answered` · `invalid_handoff: the conversation has moved on past the part of the turn it holds`. This is a turn-handoff/dedup layer guarding against lost/duplicated messages across a connection refresh.
- action: STAGED. Depends on the Claude-Desktop-hosted session transport (Anthropic-surface, unported). OCC's `replBridge` has an ingress-dedup analogue but not the desktop handoff/connection-refresh path. Record the `invalid_handoff` dedup semantics; revisit if/when OCC ports desktop-hosted sessions or hardens bridge reconnect against message loss.

### Item 19 — VERDICT: N-A
- changelog: Fixed features missing from Claude Code sessions in the Claude desktop app when the terminal on the same computer was signed in to a different account or organization.
- OCC surface: ABSENT. This is the Claude **desktop app** gating CC-session features based on a concurrent terminal sign-in (different account/org on the same machine). OCC is a CLI; it has no desktop-app feature-gating surface keyed to another process's account/org.
- current OCC behavior: N/A — no analogue. (`src/components/DesktopHandoff.tsx` is a handoff TO desktop, not desktop-hosted feature gating.)
- official evidence: Desktop-app account/org feature gating — Anthropic-surface; no portable string isolated (correctly so; it lives in the desktop app's session-feature reconciliation).
- action: N-A. Claude-desktop-app-only behavior (account/org reconciliation between the desktop app and a terminal sign-in). No OCC surface to port.

### Item 20 — VERDICT: PORT
- changelog: Fixed the `claude remote-control` status line showing `HEAD` as the branch for a folder that is not in a git repository.
- OCC surface: PRESENT. Remote-control status line: `src/bridge/bridgeMain.ts` (`getBranch()` @:2504/:3057), `src/bridge/initReplBridge.ts:661`, `src/bridge/bridgeUI.ts` (render @:161/:220/:436), `src/bridge/bridgeApi.ts:159` (registration payload). Branch detection: `src/utils/git/gitFilesystem.ts` (`getBranch`→`getCachedBranch`→`computeBranch`).
- current OCC behavior: BUGGY. `computeBranch` returns the literal `'HEAD'` when the folder is not a git repo, and the remote-control path renders any truthy string unfiltered:
  ```ts
  // src/utils/git/gitFilesystem.ts:617
  async function computeBranch(): Promise<string> {
    const gitDir = await resolveGitDir()
    if (!gitDir) {
      return 'HEAD'
    }
  ```
  Other surfaces already filter this — `CondensedLogo.tsx:58` (`currentBranch === 'HEAD' ? undefined : currentBranch`), `git.ts:902`, `toolExecution.ts:265` — proving the guard pattern exists but was not applied to the bridge status line.
- official evidence: branch-detection sentinel @ BIN309:121672596 — `not_a_repo` immediately adjacent to `--abbrev-ref` (@:121672618), `default_branch`, `push_remote`, `visibility_cache`, `untracked_normal`, `porcelain`. Official returns a `not_a_repo` sentinel (not `HEAD`) from branch detection so the status line never shows `HEAD` for a non-repo.
- action: PORT. Make the remote-control status line never show `HEAD` for a non-git folder. Preferred: change `computeBranch` (`gitFilesystem.ts:617`) to return a not-a-repo sentinel (mirror official `not_a_repo`) and have callers render empty/omit; minimal alternative: apply the existing `=== 'HEAD' ? undefined` guard on the bridge path (`bridgeMain.ts:2504`/`bridgeUI.ts` render + `bridgeApi.ts:159` payload). Add a regression test for a non-git cwd.

### Item 21 — VERDICT: PORT
- changelog: Fixed split-pane agent teammates not inheriting the tool deny and `--tools` rules given on the leader's command line.
- OCC surface: PRESENT. Split-pane spawn: `src/tools/shared/spawnMultiAgent.ts` (`handleSpawnSplitPane:362`, `handleSpawnSeparateWindow:602`), `src/utils/swarm/backends/PaneBackendExecutor.ts:117-158`, flag builder `buildInheritedCliFlags` (`spawnMultiAgent.ts:253-318`, `spawnUtils.ts:38-89`), env forwarding `TEAMMATE_ENV_VARS` (`spawnUtils.ts:95-133`). In-process path: `InProcessBackend.ts:127`, `runAgent.ts:705-716`.
- current OCC behavior: BUGGY (split-pane path only). `buildInheritedCliFlags` propagates only permission mode / `--dangerously-skip-permissions`, `--model`, `--settings`, `--setting-sources`, `--plugin-dir`, `--teammate-mode`, `--chrome`. `--tools` / `--allowedTools` / `--disallowedTools` appear **nowhere** in the split-pane flag builder, env list, or identity args, and `bootstrap/state.ts` has no getter storing the leader's raw tool flags. A pane-spawned teammate starts a fresh CLI with the full default tool set — the leader's deny rules and `--tools` allowlist are lost. (The in-process path DOES inherit via `allowedTools: config.permissions`.)
  ```ts
  // src/utils/swarm/spawnUtils.ts:38 — the complete inheritance surface
  export function buildInheritedCliFlags(options?: {
    planModeRequired?: boolean
    permissionMode?: PermissionMode
  }): string {
    const flags: string[] = []
  ```
- official evidence: coordinator/teammate tool-filter primitives @ BIN309:119356050 — `applyCoordinatorToolFilter` · `coordinatorExtraToolNames` · `coordinatorMainThreadUsesMcpServer` · `mergeAndFilterTools` · `stripSoleNonDeniableTool` · `withoutStaticMcpShadows` (alongside `isTeamLead`, `isTeammate`, `teammateIdentities`). Official filters/merges the teammate tool set from the leader's rules.
- action: PORT. Propagate the leader's tool deny + `--tools` allowlist to split-pane (and separate-window) teammates. Store the leader's raw `--tools`/`--allowedTools`/`--disallowedTools` in `bootstrap/state.ts`, then emit them in `buildInheritedCliFlags` (`spawnUtils.ts:38` / `spawnMultiAgent.ts:253-318`) so the spawned CLI reconstructs the same restrictions. Add a regression test asserting a pane teammate's spawn command carries the leader's deny/allow tool flags.

### Item 22 — VERDICT: N-A (already aligned)
- changelog: Fixed sessions renamed with `/rename` appearing to other sessions under a generated name after a VS Code window reload or a non-interactive `--resume`.
- OCC surface: PRESENT. `src/commands/rename/{rename.ts,generateSessionName.ts,index.ts}`; persistence `src/utils/sessionStorage.ts`; readers `listSessionsImpl.ts`, `print.ts` (`restoreSessionMetadata`), bridge `initReplBridge.ts`.
- current OCC behavior: **FIXED / already aligned.** OCC stores a user rename and an AI-generated title as **distinct** JSONL entries and never lets the generated one clobber the rename:
  - `rename.ts:56` `saveCustomTitle(...)` → `sessionStorage.ts:3426-3447` appends `{type:'custom-title', customTitle}`.
  - AI title uses a separate entry: `print.ts:4123` `saveAiGeneratedTitle(...)` → `sessionStorage.ts:3476-3481` appends `{type:'ai-title', aiTitle}`.
  - `loadTranscriptFile` fills `customTitles` **only** from `custom-title` entries (`sessionStorage.ts:4421,:4521`); readers prefer `customTitle` over `aiTitle` (`sessionStorage.ts:5758-5762`, `listSessionsImpl.ts:96-102`); bridge auto-titling skips when a user title exists (`initReplBridge.ts:522-524,:533`). Documented anti-clobber resume safety at `sessionStorage.ts:3455-3460`.
- official evidence: `customTitle` field in resumed-session metadata @ BIN309:120330588 (region: `tengu_session_resumed`, `sessionCwd`, `customTitle`, `resumedMessages`, `fileHistorySnapshots`, `inheritPredecessorLinks`); title taxonomy `sessionTitle`/`aiSessionTitle`/`agentTitle`/`haikuTitle`/`terminalTitle` @ BIN309:119929368. Official likewise separates a user `customTitle` from the generated `aiSessionTitle`.
- action: N-A. OCC already implements the fixed behavior (distinct custom-title vs ai-title entries + resume-safe load). No port needed; keep the `sessionStorage.ts:3455-3460` invariant under regression test.

### Item 23 — VERDICT: PORT
- changelog: Fixed the `/rewind` list showing "No code changes" for a turn that changed checkpointed files through `/code-review --fix`, a subagent or a shell command.
- OCC surface: PRESENT. `src/commands/rewind/rewind.ts`, `src/components/RewindMessageSelector.tsx`, `src/components/MessageSelector.tsx` (list UI), `src/utils/fileHistory.ts` (checkpoint store), `src/utils/queuedRewindMessages.ts`.
- current OCC behavior: BUGGY (two levels). The pick-list row computes changes by scanning **parent-transcript tool results** for `filePath` + `structuredPatch` (only Edit/Write emit it):
  ```ts
  // src/components/MessageSelector.tsx:739-742
  const result = msg.toolUseResult as FileEditOutput | FileWriteToolOutput;
  if (!result || !result.filePath || !result.structuredPatch) {
    continue;
  }
  ```
  (`MessageSelector.tsx:296,382,722-766`; `structuredPatch` only from `FileEditTool.ts:845`/`FileWriteTool.ts:748`.) (1) **Bash** edits ARE checkpointed (`BashTool.tsx:473` `fileHistoryTrackEdit`) but carry no `structuredPatch`, so the scan skips them → "No code changes". (2) **Subagent** results never enter parent `messages[]` (only `type:'progress'`, excluded by `isToolUseResultMessage`, `messages.ts:1059`), and subagent checkpointing is a hardwired no-op:
  ```ts
  // src/utils/forkedAgent.ts:528
  updateFileHistoryState: () => {},
  ```
  so `fileHistoryTrackEdit` bails (`fileHistory.ts:111`) — forked `/code-review --fix` (`simplify.ts:286-296`, `context:'fork'` → `SkillTool.ts:270` → `runAgent.ts:1009`) and Task-subagent edits are invisible to both the list AND the store. Internal inconsistency proves the bug: the confirm/restore path uses snapshot-based `fileHistoryGetDiffStats` (`MessageSelector.tsx:77,173`; `fileHistory.ts:449-519`), which DOES catch bash-tracked edits; the pick-list does not.
- official evidence: rewind change-detection UI @ BIN309:120166240 — `No code changes` · `No code restore` · `files changed` (@:120164456); diff panel @ BIN309:120164200 — `No changes this session` · `Only hidden files changed` · `Only read-denied files changed` · `Only tests and generated files changed` · `linesAdded`/`linesRemoved`/`filesCount`/`preSessionFiles`; `fileHistorySnapshots` @ BIN309:120330632. Official drives the row from the snapshot store, not a transcript scan.
- action: PORT. Make the `/rewind` pick-list row read from the checkpoint/snapshot store (`fileHistoryGetDiffStats`, as the confirm path already does) instead of the `structuredPatch` transcript scan, so Bash- and subagent-made changes count. Additionally, enable subagent checkpointing by replacing the no-op `updateFileHistoryState` (`forkedAgent.ts:528`) with a real updater that feeds `fileHistoryTrackEdit`, so forked `/code-review --fix` and Task edits land in the store. Add regression tests: a turn whose only change is a Bash `sed -i` and a turn whose only change is a subagent edit must not render "No code changes".

### Item 24 — VERDICT: PORT
- changelog: Fixed `/privacy-settings` showing an out-of-date "Help improve our AI models" value; it now also says when the setting can't be fetched.
- OCC surface: PRESENT. `src/commands/privacy-settings/privacy-settings.tsx`, dialog `src/components/grove/Grove.tsx` (label "Help improve Claude", :435), fetch layer `src/services/api/grove.ts`. (`src/utils/privacyLevel.ts` is unrelated — env traffic gate.)
- current OCC behavior: BUGGY (mostly). `getGroveSettings` is **session-memoized** and `/privacy-settings` never invalidates it, so a second open shows a stale `grove_enabled`:
  ```ts
  // src/services/api/grove.ts:58
  export const getGroveSettings = memoize(async () => { ... })  // "Memoized for the session" (:55)
  ```
  Cache cleared only on failure (`grove.ts:98`), `markGroveNoticeViewed` (:135), `updateGroveSettings` (:171), `/logout` (`logout.tsx:71`). Dialog seeds local state once (`Grove.tsx:364` `useState(settings.grove_enabled)`). **No "can't be fetched" state** — fetch failure collapses into the same generic fallback as "not qualified":
  ```ts
  // src/commands/privacy-settings/privacy-settings.tsx:6
  const FALLBACK_MESSAGE = 'Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls';
  ```
  (`privacy-settings.tsx:13,17-19`; zero hits for "could not be fetched" on this surface.) Extra stale vector: `updateGroveSettings` swallows PATCH errors (`grove.ts:168-169`) while the dialog keeps the optimistic toggle (`Grove.tsx:377-379`).
- official evidence: privacy toggle + copy @ BIN309:120720143/120720700 — `Help improve our AI models` · `Allow the use of your chats and coding sessions to train and improve Anthropic AI models. You can change this anytime in Privacy Settings` · `Turning ON the improve Claude setting extends data retention from 30 days to 5 years. Turning it OFF keeps the default 30-day data retention.` · `Review and manage your privacy settings at` `https://claude.ai/settings/data-privacy-controls` · states `Help improve our AI models: ON` / `: OFF` / `: OFF (for emails with your domain)`. (The exact new "can't be fetched" literal was not uniquely isolated; several `could not be fetched` hits exist binary-wide but none pinned to this surface — implement per changelog spec.)
- action: PORT. (1) Re-fetch `getGroveSettings` fresh on `/privacy-settings` open (invalidate the session memo, or bypass it for this command) so the displayed value is current. (2) Add an explicit "can't be fetched" UI state distinct from the not-qualified fallback (surface a fetch-error message rather than silently printing `FALLBACK_MESSAGE`). (3) Don't keep an optimistic toggle when `updateGroveSettings` PATCH fails (`grove.ts:168-169` / `Grove.tsx:377-379`). Add tests for stale-on-reopen and fetch-failure messaging.

### Item 25 — VERDICT: PORT
- changelog: Fixed feedback saying "try again later" when your organization does not accept feedback; it now shows the server's reason and where to report a bug.
- OCC surface: PRESENT. `src/components/Feedback.tsx` (all logic), `src/commands/feedback/feedback.tsx` (thin renderer).
- current OCC behavior: BUGGY (partial). The server's reason is never surfaced — it is substring-matched to a boolean then discarded, and a hardcoded client string is shown:
  ```ts
  // src/components/Feedback.tsx:546-548
  if (axios.isAxiosError(err) && err.response?.status === 403) {
    const errorData = err.response.data;
    if (errorData?.error?.type === 'permission_error' && errorData?.error?.message?.includes('Custom data retention settings')) {
  ```
  → `return { success:false, isZdrOrg:true }` (:546-553) → fixed UI text `'Feedback collection is not available for organizations with custom data retention policies.'` (:216-217). Any other 403 falls through to generic `'Could not submit feedback. Please try again later.'` (:219). No error path points to where to report a bug (`GITHUB_ISSUES_REPO_URL` :36 is used only in the success flow `createGitHubIssueUrl`, opened at :255-261).
- official evidence: feedback failure-reason classification @ BIN309:120417850 — `Your organization does not accept feedback` · `Couldn't send feedback: ` · reason codes `isZdrOrg`/`feedback_retention_blocked`/`permission_error`, `zdr_org`/`Custom data retention settings`, `feedback_disabled`, `feedback_third_party_blocked`/`org_refused`, `oauth_scope_insufficient`/`auth_refused`, `feedback_check_unavailable`, `http_error`. Official classifies the failure and shows the server's reason rather than a single generic string.
- action: PORT. Replace the generic "try again later" with the server's reason: classify the feedback error (mirror official reason codes: org ZDR/refused, org-disabled, third-party-blocked, auth/scope, check-unavailable, http-error), surface `err.response.data.error.message` (or the mapped reason) in `setError`, and add a "where to report a bug" pointer (reuse `GITHUB_ISSUES_REPO_URL`) on the error paths (`Feedback.tsx:216-219,546-553`). Add tests per reason class.

### Item 26 — VERDICT: PORT
- changelog: Fixed oversized /feedback reports failing instead of being resent without the transcript.
- OCC surface: PRESENT. `src/components/Feedback.tsx` (`submitFeedback` :489-562; payload assembly :180-198).
- current OCC behavior: BUGGY. Single POST, no payload-size check, no 413 handling, no retry-without-transcript:
  ```ts
  // src/components/Feedback.tsx:514-516
  const response = await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {
    content: jsonStringify(data)
  }, {
  ```
  Payload always includes `transcript: normalizeMessagesForAPI(messages)` + `subagentTranscripts` + `rawTranscriptJsonl` (:180-198). The only size handling is a **pre-check** omitting the raw JSONL if >50 MiB (`MAX_TRANSCRIPT_READ_BYTES`, `sessionStorage.ts:316`) at :111-127 — not a retry. On any failure (incl. oversize rejection): `catch` :539 → `{success:false}` → generic "try again later" (:219); user resubmits the identical full payload (fails again). Grep `413|payload_too_large|without the transcript|resend` across feedback files: zero hits.
- official evidence: feedback payload budgeting @ BIN309:121047600 — `Feedback payload too large. Try again without the transcript, or shorten the details` · `fitFeedbackPayloadToBudget(` · `fitFeedbackPayloadToBudget: still ... bytes after trim (budget ...)` · `transcript_truncated: ` · `(trimmed client-side to fit the upload size limit)` · `omitted the raw session log` · `KiB of the raw session log (newest kept first)` · `keptMessageCount`/`totalMessageCount`/`rawTail`/`rawTailKeptBytes`/`oversize...`. Official trims the transcript to fit the upload budget and resends.
- action: PORT. Add a `fitFeedbackPayloadToBudget`-style path: on an oversized submission (413 / payload-too-large), trim or drop `transcript`/`rawTranscriptJsonl`/`subagentTranscripts` (newest-kept-first), mark `transcript_truncated`, and resend within the upload budget; surface the official message `Feedback payload too large. Try again without the transcript, or shorten the details` when it still won't fit (`Feedback.tsx:180-198,514-521,539-560`). Add tests: oversize payload → automatic resend without transcript succeeds; still-oversize → clear message.

### Item 27 — VERDICT: PORT
- changelog: Fixed a skill in an `--add-dir` folder being unreachable when another skill already held its name; it is now offered as `<folder>:<name>`.
- OCC surface: PRESENT. Skills loader `src/skills/loadSkillsDir.ts` (`--add-dir` load :1003-1068; dedup :1090-1128; namespace primitive `buildNamespace`/`getSkillCommandName` :847-867); resolution `src/commands.ts:406`, `src/screens/REPL.tsx:3449`.
- current OCC behavior: BUGGY. Dedup is by **resolved file identity (realpath), first-wins** — not by name (`loadSkillsDir.ts:1090-1128`):
  ```ts
  // loadSkillsDir.ts:1118-1124 (dedup keys on fileId, not name)
  const existingSource = seenFileIds.get(fileId)
  if (existingSource !== undefined) {
    logForDebugging(`Skipping duplicate skill '${skill.name}' ...`)
    continue
  }
  ```
  Two skills sharing a **name** but living in **different files** are both kept (file-identity dedup misses them; `dropShadowedBundledSkills` :271-287 only removes bundled dups). Invocation resolution is **first-match** on `name`/`aliases` (`commands.ts:406` `COMMANDS().find(_ => _.name === name || _.aliases?.includes(name))`), so the second (e.g. an `--add-dir` skill colliding with an already-loaded name) is **shadowed/unreachable**. `buildNamespace` (:847-867) namespaces only nested subfolders **within** one skill dir (joins with `:`), never the `--add-dir` folder name and never on collision. Bare-mode comment confirms the gap: `// No dedup needed — explicit dirs, user controls uniqueness.` (:1028).
- official evidence: skill loader source categories + same-file dedup @ BIN309:126394725 — `Skipping duplicate skill '...' (same file already loaded from ...)` · `Deduplicated ... skills (same file)` · `Skipping host catalog skill '...': the account syncs a skill of that name` · `': another skills folder links to the same file` · `conditional skills stored (activated when matching files are touched)` · `unique skills (... unconditional, ... conditional, managed: ..., user: ..., project: ..., additional: ..., legacy commands: ...)`. Official categorizes an `additional` (`--add-dir`) source and dedups by same-file; the collision-namespace literal `<folder>:<name>` was not isolated as a string (it is a runtime template), but the changelog gives the exact output format and OCC already uses the `:` namespace convention.
- action: PORT. When two **different-file** skills resolve to the same invocation name, disambiguate the later/`--add-dir` one as `<folder>:<name>` (folder = the add-dir folder name), reusing OCC's existing `:` namespace convention (`buildNamespace`/`getSkillCommandName`, `loadSkillsDir.ts:847-867`). Add a name-collision pass after the file-identity dedup (`loadSkillsDir.ts:1090-1128`) that renames colliding add-dir skills, and ensure `commands.ts:406` resolution surfaces both. Add a regression test: skill `foo` in cwd + skill `foo` in an `--add-dir` folder `bar` → both reachable, second as `bar:foo`.

### Item 28 — VERDICT: STAGED
- changelog: Fixed `/verify` and `/code-review` not finding a nested package's own skill when its files were changed from the shell.
- OCC surface: PRESENT. `/verify` bundled skill `src/skills/bundled/verify.ts` + `verify/SKILL.md`; nested discovery `discoverSkillDirsForPaths` / `activateConditionalSkillsForPaths` (`src/skills/loadSkillsDir.ts:1226-1285`); `/code-review` via `src/commands/review.ts:36`.
- current OCC behavior: BUGGY. Nested-package skill discovery/activation is triggered **only** from file tools — `FileEditTool.ts:634,648`, `FileReadTool.ts:965,976`, `FileWriteTool.ts:569,580`. **BashTool has no `discoverSkillDirsForPaths`/`activateConditionalSkillsForPaths` call** (grep of `src/tools/BashTool/*` returns only prompt-text hits, `prompt.ts:111-126`). So when files are changed from the shell, no tool invokes nested-package skill discovery and a nested package's own `verify`/`code-review` skill is not loaded/activated. `verify/SKILL.md:75-106` only *instructs* the model to `ls <touched-dir>/.claude/skills/` (prose, not code wiring).
- official evidence: `conditional skills stored (activated when matching files are touched)` @ BIN309:126394725 region — official activates conditional/nested skills when matching files are "touched". The **shell-change-detection mechanism** (how official learns which files a Bash command touched — git-status diff, mtime scan, or cwd walk) was **not isolated at byte level**.
- action: STAGED. OCC's gap is concrete (Bash never triggers nested-skill discovery), but the official trigger mechanism for shell-touched files is not byte-pinnable, and naively wiring `discoverSkillDirsForPaths` into BashTool requires knowing which paths a shell command changed — inventing that risks divergence. Record: extend "touched files" tracking to shell changes (likely a post-Bash changed-files scan) so `activateConditionalSkillsForPaths` fires, then verify `/verify` and `/code-review` resolve the nested package's own skill. Defer pending mechanism extraction.

### Item 29 — VERDICT: N-A
- changelog: Fixed the /claude-api skill saying that `ant beta:worker poll --on-work` passes trace context to the command.
- OCC surface: ABSENT (content). The `/claude-api` skill exists (`src/skills/bundled/claudeApi.ts`, `claudeApiContent.ts`) but **all** its `.md` content files are intentional **1-byte stubs** (`src/skills/bundled/claude-api/**.md`, e.g. `SKILL.md` = `0a`; `csharp/claude-api.md` = 1 byte). Documented OCC-44 trim policy: `claudeApiContent.ts:64` "shared/models.md catalog) are intentional 1-byte stubs in OCC (OCC-44)".
- current OCC behavior: N/A — there is no skill prose to correct. The tracing/`--on-work` guidance does not exist in OCC (grep `on-work`/`OpenTelemetry`/`tracing` in `claude-api/`: zero hits).
- official evidence: claude-api skill markdown content (embedded in BIN309); the exact `ant beta:worker poll --on-work` correction is skill prose, not separately forensicated (no OCC content surface). Prior-round S1 precedent (`/claude-api api-version`) treats claude-api `.md` content as trimmed-by-design.
- action: N-A. claude-api skill `.md` content is intentionally stubbed in OCC (OCC-44). No content surface to correct. Same trim-policy precedent as prior-round S1.

### Item 30 — VERDICT: N-A
- changelog: Fixed the /claude-api skill's C# tracing setup missing spans from the cloud platform clients.
- OCC surface: ABSENT (content). `src/skills/bundled/claude-api/csharp/claude-api.md` is a 1-byte stub (OCC-44). No C# tracing prose exists in OCC.
- current OCC behavior: N/A — stubbed content.
- official evidence: claude-api C# skill markdown (embedded); content-only correction, not separately forensicated (no OCC surface).
- action: N-A. claude-api skill `.md` content intentionally stubbed (OCC-44). Nothing to correct.

### Item 31 — VERDICT: N-A
- changelog: Fixed the /claude-api skill saying that API spans for requests to Claude Platform on AWS can't join the caller's trace.
- OCC surface: ABSENT (content). claude-api skill `.md` files are 1-byte stubs (OCC-44); no AWS-span tracing prose in OCC.
- current OCC behavior: N/A — stubbed content.
- official evidence: claude-api skill markdown (embedded); content-only correction, not separately forensicated (no OCC surface).
- action: N-A. claude-api skill `.md` content intentionally stubbed (OCC-44). Nothing to correct.

### Item 32 — VERDICT: PORT
- changelog: Fixed hooks that run in PowerShell not blocking when the hook's program exits with code 2, and on Windows `PreToolUse` and `PermissionRequest` hooks with `"shell": "powershell"` failing open when Git for Windows isn't installed.
- OCC surface: PRESENT. Hook `shell` field `src/schemas/hooks.ts:51-55`; resolution `src/utils/hooks.ts:1847-1849`; PowerShell spawn `hooks.ts:2051-2065`; arg builder `src/utils/shell/powershellProvider.ts:12-18`; exit-2 blocking `hooks.ts:4466,4314-4319,4239,4420`; Git-Bash discovery `src/utils/windowsPaths.ts:98-125` (`findGitBashPath` → `process.exit(1)` when absent), `src/entrypoints/init.ts:186`.
- current OCC behavior: BUGGY on the exit-2 half; the Git-for-Windows half is structurally avoided. OCC blocks on `result.status === 2` (shell-agnostic), but the **hook** PowerShell spawn uses raw `-Command cmd` with **no `$LASTEXITCODE`/`exit` propagation**:
  ```ts
  // src/utils/shell/powershellProvider.ts:12-18 (hook path — NO exit-code wrapper)
  return ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', cmd]
  ```
  `finalCommand` for PS is the raw `command` (no `exit $LASTEXITCODE` appended, `hooks.ts:1935-1938`). `pwsh -Command "<native exe>"` does not reliably surface the inner program's exit 2 as the process exit code, so a PowerShell hook whose program exits 2 generally won't produce `result.status === 2` → does not block. (Contrast: OCC's BashTool provider path DOES append `$LASTEXITCODE` propagation, `powershellProvider.ts:62-65`.) Git-for-Windows fail-open: can't occur as described — OCC hard-exits at startup when git-bash is absent (`windowsPaths.ts:120-124`) and PreToolUse/PermissionRequest already fail-closed (`hooks.ts:2862-2866`); but OCC gives no pwsh-only-without-Git-Bash support.
- official evidence: PowerShell hook fix @ BIN309:126297750 — exit-code-propagation wrapper `; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }.` · `Hook "..." has shell: 'powershell' but no PowerShell executable (pwsh or powershell) was found on PATH. Install PowerShell, or remove "shell": "powershell" to use bash.` · `... requires bash but Git Bash was not found.` · async-hook schema `If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async.` (@:129538750) · `"shell": "powershell"` config @:126298038.
- action: PORT (exit-2 propagation). Wrap the PowerShell **hook** command so a program exit code 2 surfaces as the process exit code — append official's `; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }` (or equivalent `exit $LASTEXITCODE` propagation) in the hook path (`hooks.ts:1935-1938` / `powershellProvider.ts:12-18`), so `result.status === 2` blocks. Also add the official guard message when `"shell":"powershell"` is set but no pwsh/powershell is on PATH. The Git-for-Windows fail-open half is already avoided by OCC's startup hard-exit + fail-closed guards — note it but no change needed. Add a Windows/PowerShell hook test asserting exit-2 blocks.

### Item 33 — VERDICT: N-A
- changelog: Fixed a mod's `turn.step` hook that names a model by alias, such as `haiku`, failing every request with a model error: the alias now resolves to its model.
- OCC surface: ABSENT. No "mods" / `turn.step` hook subsystem in OCC (grep `turn.step|turnStep|"mods"|ModDefinition|registerMod|modHook`: zero hits in `src/`).
- current OCC behavior: N/A — the mod/`turn.step` feature does not exist in OCC, so a mod hook naming a model alias cannot fail.
- official evidence: `turn.step` mod-hook system @ BIN309:123644664 — `turn.step hooks` · `turn.step` · `turn.step: a request resuming a truncated thought keeps its model` · `a model rewrite applies from the next request` · `the engine sent the request as the thought began`. Official has a mod `turn.step` hook that can rewrite the model per request.
- action: N-A. The "mods" / `turn.step` hook subsystem is absent from OCC. Nothing to port until/unless OCC adds mods.

### Item 34 — VERDICT: N-A
- changelog: Fixed plugins and skills synced from claude.ai being removed, sometimes mid-session, after a disk read error.
- OCC surface: ABSENT. The claude.ai plugin/skill **cloud-sync** subsystem does not exist in OCC. `src/types/command.ts:232-238` `loadedFrom` union has no `syncedSkills`; `src/utils/skills/reservedNames.ts:36-48` documents "OCC has no synced-skills infrastructure … `isSyncedSkillHolder` is forward-compat only … always returns false"; `src/commands.ts:447-449` notes the official `loadedFrom!=="syncedSkills"` guard is omitted; `src/utils/plugins/schemas.ts:297-298` "no claude.ai-hosted marketplaces".
- current OCC behavior: N/A — OCC never syncs plugins/skills **from** claude.ai, so the "removed after a disk read error" bug cannot manifest. (Plugin managers do handle ENOENT defensively — `installedPluginsManager.ts:137,145,270,1214` — but there is no cloud-sync store to remove entries from.)
- official evidence: claude.ai sync feature @ BIN309:120733349 — `... synced from claude.ai loaded but never invoked. Each one adds to the system prompt every turn. Disable in /skills, or turn off on claude.ai. A deleted synced copy is re-downloaded on the next sync.` Official has a cloud sync that re-downloads deleted synced copies.
- action: N-A. The claude.ai plugin/skill sync subsystem is intentionally trimmed from OCC (forward-compat stubs only). No surface for the fix.

### Item 35 — VERDICT: N-A
- changelog: Fixed artifact publishes and updates being refused for some ordinary pages, such as pages with certain minified scripts or artifacts Claude could not read first.
- OCC surface: ABSENT (stub). `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` is a 3-line auto-generated stub (`export const ReviewArtifactTool: Record<string, unknown> = {}`). The artifact publish/update/workshop subsystem (cloud sessions, `claude --watch-artifact`, page publishing) is not implemented; artifacts are a cloud-session/desktop feature.
- current OCC behavior: N/A — no artifact publish/update path exists.
- official evidence: artifact publish/watch surface @ BIN309:122368550 — `Publishing an artifact from this session normally arms one [a watch]` · `a watch is a durable wake subscription held by the artifact service (it outlives the session)` · `No artifact watches in this session` · `[artifact] /deploy/direct` · `nested_page_repaired`/`hoisted_comment_dropped`/`content_scan_transient` (@:124709812). Official artifact publishing is a cloud/artifact-service subsystem.
- action: N-A. Artifact publish/update subsystem is a stub in OCC and is cloud/desktop-only. No surface to port.

### Item 36 — VERDICT: N-A
- changelog: Fixed Claude asking for permission on each artifact update for the rest of a turn after the conversation was compacted in that turn.
- OCC surface: ABSENT (stub). Same as item 35 — `ReviewArtifactTool` is a stub; `src/components/permissions/ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.ts` exists but the artifact-update permission/compaction interaction is not implemented (no artifact publish/update subsystem).
- current OCC behavior: N/A — no artifact-update permission path; the compaction-resets-artifact-permission bug cannot occur.
- official evidence: artifact update/permission + compaction interaction — inside the unported artifact/cloud subsystem (see item 35 evidence).
- action: N-A. Artifact subsystem is a stub / cloud-only in OCC. No surface to port.

### Item 37 — VERDICT: PORT
- changelog: Fixed fine-grained tool streaming staying off on Amazon Bedrock when `ANTHROPIC_BEDROCK_BASE_URL` is set to the default `bedrock-runtime.<region>.amazonaws.com` endpoint.
- OCC surface: PRESENT. FGTS gate `src/utils/api.ts:221-233` (sets `base.eager_input_streaming`); base-URL predicate `src/utils/model/providers.ts:149-167` (`isFirstPartyAnthropicBaseUrl`); provider `getAPIProvider()` returns `'bedrock'` (`src/services/api/claude.ts:558,1790,2634`, `bedrockContentTypeGuard.ts:84`).
- current OCC behavior: BUGGY. FGTS is hard-gated to `firstParty` provider + `api.anthropic.com` host; on Bedrock `getAPIProvider()` returns `'bedrock'`, so the gate can never pass and `eager_input_streaming` is never set — regardless of `ANTHROPIC_BEDROCK_BASE_URL`:
  ```ts
  // src/utils/api.ts:226
  if (
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl() &&
    (getFeatureValue_CACHED_MAY_BE_STALE('tengu_fgts', false) ||
      isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING))
  ) {
    base.eager_input_streaming = true
  }
  ```
  The comment at `api.ts:224` documents the intentional exclusion ("Bedrock/Vertex with Claude 4.5 reject this field with 400"). Also `isFirstPartyAnthropicBaseUrl()` reads `ANTHROPIC_BASE_URL` (`providers.ts:153`), **not** `ANTHROPIC_BEDROCK_BASE_URL`, so the Bedrock env var never reaches the check. No branch treats the default `bedrock-runtime.<region>.amazonaws.com` endpoint as FGTS-eligible.
- official evidence: per-provider FGTS capability in the model catalog @ BIN309:240725004 — `eager_input_streaming:{vertex:!0}` (per-model/per-provider capability map, alongside `provider_ids:{first_party,bedrock,vertex,foundry,anthropic_aws,...}`); `ANTHROPIC_BEDROCK_BASE_URL` env @ BIN309:121027608; Bedrock default-endpoint resolution `https://bedrock-runtime.{Region}.{PartitionResult#dnsSuffix}` @ BIN309:128105200. Official 309 enables FGTS on Bedrock when the base URL is the **default** `bedrock-runtime.<region>.amazonaws.com` endpoint (real AWS now accepts `eager_input_streaming`), leaving it off for proxies/custom endpoints. (The exact gate arm literal was not isolated; the changelog + OCC's firstParty-only gate give the spec.)
- action: PORT. Extend the FGTS gate (`api.ts:226`) to also enable `eager_input_streaming` when `getAPIProvider() === 'bedrock'` **and** `ANTHROPIC_BEDROCK_BASE_URL` is unset or equals the default `bedrock-runtime.<region>.amazonaws.com` endpoint (add a default-Bedrock-endpoint detector; do not read `ANTHROPIC_BASE_URL` for the Bedrock arm). Keep it OFF for custom/proxy Bedrock endpoints (preserving the GH#32742 400-avoidance). Gate behind the same `tengu_fgts`/env flag. Add tests: default Bedrock endpoint → FGTS on; custom `ANTHROPIC_BEDROCK_BASE_URL` → off. NOTE risk: validate against a real Bedrock region before shipping, since OCC's comment records that Bedrock historically rejected the field.

### Item 38 — VERDICT: STAGED
- changelog: Fixed the "Waiting for API response" hint flickering behind gateways that send only keepalive pings: routes off Anthropic's backend now wait 45 seconds.
- OCC surface: ABSENT (specific subsystem). The string "Waiting for API response" appears **nowhere** in `src/` (zero hits). `src/services/api/claude.ts` has **no `ping`/keepalive event handling**. OCC's slow-response UX is a purely **time-based rotating hint** (`src/components/Spinner/thinkingHints.ts` + `ThinkingHintLine.tsx`, fixed `afterMs` thresholds 1s→165s) plus TTFT metric tracking (`Spinner.tsx:53`, `computeTtftText`) — not gated on backend/provider, no keepalive-ping reset/suppress, no 45s off-Anthropic threshold. (`CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` gateway/byte-watchdog subsystem never ported — prior-round A5 N-A; the only `45_000` constants in-tree are unrelated: `LocalShellTask.tsx:30`, `SSETransport.ts:21`, `fetchPluginZip.ts:31`.)
- current OCC behavior: The specific flicker bug cannot occur (no ping-triggered hint), but neither does OCC have the fixed behavior — the whole ping-aware wait-banner + first-byte-timeout + provider-gated 45s surface is missing.
- official evidence: wait-banner region @ BIN309:121135464 — `Waiting for API response` · `will retry in` · `check your network` · `next try in` · `attempt` · `esc to interrupt` · `No response from the API after` · `A proxy or gateway that buffers streaming responses can cause this — set CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to change the first wait` · `Retrying in` · `waitBanner`/`isNetworkDown`/`isSSLError`; `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` @:121135853. (The 45s off-backend threshold literal was not isolated.)
- action: STAGED. Depends on the unported first-byte-timeout / ping-aware wait-banner subsystem (prior-round A5 precedent). Porting the 45s-off-backend + keepalive-flicker fix requires first porting that subsystem. Record; do not bolt a 45s constant onto OCC's time-based rotating hints (different mechanism).

### Item 39 — VERDICT: STAGED
- changelog: Fixed Claude notifying unrelated GitHub users by writing role names and placeholders as mentions in PRs, issues and comments.
- OCC surface: PARTIAL. OCC does not compose GitHub PR/issue/comment bodies in code — it is prompt-driven through the `gh` CLI: `src/tools/BashTool/prompt.ts:199-208` (`gh pr create --body "$(cat <<'EOF' ... EOF)"`), `src/commands/commit-push-pr.ts:102-105` (+ `--reviewer`/`--add-reviewer` :50-51), `src/commands/feedback/index.ts:220` (`gh issue create --body`), `src/constants/github-app.ts` + `src/commands/install-github-app/setupGitHubActions.ts` (install the `@claude` GitHub Action). There is **no** mention-sanitization/escaping utility anywhere (grep `mention|escape|notify|role name|placeholder|sanitize` in the GitHub surface: zero relevant hits).
- current OCC behavior: Bodies are authored verbatim by the model and passed through `gh` heredocs with no post-processing, so OCC has **no mechanism** to stop role names (`@reviewer`, `@team`) or placeholders from becoming real GitHub @mentions that notify unrelated users. Neither a fix nor a code-level sanitizer is present.
- official evidence: **Not byte-pinnable.** Searched BIN309 for `as mentions`, `role names` (only AWS-credential hits), `placeholders as`, `@-mention` (only a `/powerup` tour string), `do not mention` (only subagent-notification metadata), `will notify`/`notifying` (MCP/artifact contexts) — none map to a GitHub mention sanitizer or guidance. The fix is likely a system-prompt/guidance change in the GitHub-app or cloud `@claude` path, or a body sanitizer, whose exact form was not isolated.
- action: STAGED. OCC's `gh`-based PR/issue/comment writing has no mention sanitization (bug could occur locally), but the official fix mechanism produced no distinctive new string and may live in the GitHub-app/cloud `@claude` guidance. Record: add mention-sanitization guidance (don't write role names/placeholders as `@mentions`) to the PR/issue-writing prompts (`BashTool/prompt.ts`, `commit-push-pr.ts`) and/or a body sanitizer, pending extraction of the official approach. Do not invent a sanitizer this round.

### Item 40 — VERDICT: N-A (structurally immune)
- changelog: Linux: Fixed sandbox write denies lifting when a background command outlived the session.
- OCC surface: PRESENT (different implementation). Live Linux sandbox = `SandboxManager` adapter (`src/utils/sandbox/sandbox-adapter.ts`) over `@anthropic-ai/sandbox-runtime@0.0.44` (`package.json:45`) + OCC patch; gating `shouldUseSandbox.ts:317-341`; integration `Shell.ts:339` (`wrapWithSandbox`).
- current OCC behavior: NOT AFFECTED — no session-scoped deny state to lift. `denyWrite` is built in `convertToSandboxRuntimeConfig` (`sandbox-adapter.ts:564-648`, applied `:861`) and **re-applied per command** via `wrapWithSandbox` → synchronous `refreshConfig()` (`:1739`, `:1841-1846`). Denies are rebuilt synchronously for every command with **zero session-scoped state**, so there is no persisted deny set that could "lift" when a background command outlives the session. Background cleanup (`Shell.ts:470-484`) runs in `.then()` on the result promise, which resolves only after the bwrap child actually exits (`ShellCommand.ts:310-360`; `background(taskId)` `:381` does not resolve it) — so it never fires while a backgrounded sandbox child lives, and it only scrubs 0-byte stubs/planted paths, never deny state. Grep for `outlive`/`isPidAlive`/background-liveness in the sandbox subsystem: empty. The adjacent "nested userns can undo write denies" vector is **already fixed** via the CC 2.1.305 backport in `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` (`--unsetenv SRT_ALLOW_NESTED_USERNS` + `--disable-userns`; `allowNestedUserNamespaces` in `src/entrypoints/sandboxTypes.ts:190`).
- official evidence: base-deny sandbox model @ BIN309:125523850 — `addAllowWrite` · `allowWrite` · `keepBaseDenyWrite` (@:125524084) · `dropAllowRead` · `denyWrite` · `addDenyWrite` · `denyRead` · `addDenyRead` · `allowRead`. Official maintains a session/base deny-write set (`keepBaseDenyWrite`) that can lift across a background process's lifetime; OCC's per-command rebuild has no such persisted state.
- action: N-A. OCC's Linux sandbox rebuilds `denyWrite` per command with no session-scoped state, so the "denies lifting when a background command outlived the session" bug has no analogue; the related nested-userns deny-bypass is already patched (2.1.305 backport). Caveat: verdict is from source semantics (byte-diff vs official 2.1.309 not possible in a read-only session). No port needed for item 40. (Supersedes an earlier draft that misread OCC's sandbox as a hand-rolled allowlist-only bubblewrap; the live path is the `@anthropic-ai/sandbox-runtime` adapter.)

---

## Summary table

| # | Verdict | One-line reason |
|---|---|---|
| 17 | N-A | OCC PDF page-range renders via **unsandboxed** `execa` (`pdf.ts:259`/`execFileNoThrow.ts:97`) and re-throws plain `Error` w/o errno (`FileReadTool.ts:1414`), so the ENOENT-gated "File does not exist" (`:1031`) is unreachable — bug cannot manifest |
| 18 | STAGED | Claude-Desktop-hosted session transport unported; OCC `replBridge` has ingress dedup but not the desktop connection-refresh handoff (`invalid_handoff` family) |
| 19 | N-A | Claude-desktop-app account/org feature gating — no OCC surface (CLI) |
| 20 | PORT | `computeBranch` returns literal `'HEAD'` for non-repo (`gitFilesystem.ts:617`); remote-control status renders it unfiltered; official uses `not_a_repo` sentinel |
| 21 | PORT | Split-pane teammates' `buildInheritedCliFlags` omits `--tools`/deny rules (`spawnUtils.ts:38`); official has `applyCoordinatorToolFilter`/`mergeAndFilterTools` |
| 22 | N-A | Already aligned — OCC stores `custom-title` vs `ai-title` separately + resume-safe load (`sessionStorage.ts:3455-3460`) |
| 23 | PORT | `/rewind` list scans transcript for `structuredPatch` (Edit/Write only); Bash + subagent edits missed, subagent checkpointing no-op (`MessageSelector.tsx:739`, `forkedAgent.ts:528`) |
| 24 | PORT | `/privacy-settings` shows session-memoized stale value (`grove.ts:58`), no "can't be fetched" state (`privacy-settings.tsx:6,17-19`) |
| 25 | PORT | Feedback discards server reason, shows hardcoded ZDR string / generic "try again later", no bug-report pointer (`Feedback.tsx:216-219,546-553`) |
| 26 | PORT | Oversized feedback single POST, no 413/retry-without-transcript (`Feedback.tsx:514-521`); official has `fitFeedbackPayloadToBudget` |
| 27 | PORT | Name-colliding `--add-dir` skill shadowed by first-match resolution (`loadSkillsDir.ts:1118`, `commands.ts:406`); no `<folder>:<name>` disambiguation |
| 28 | STAGED | Nested-skill discovery wired only to Read/Edit/Write, not Bash (`FileEditTool.ts:634` vs BashTool); official shell-touched-files mechanism not byte-pinnable |
| 29 | N-A | claude-api skill `.md` content intentionally 1-byte stubs (OCC-44) |
| 30 | N-A | claude-api C# `.md` stub (OCC-44) |
| 31 | N-A | claude-api `.md` stub (OCC-44) |
| 32 | PORT | PowerShell hook spawn lacks `$LASTEXITCODE`/exit-2 propagation (`powershellProvider.ts:12-18`); official wraps `if ($LASTEXITCODE -eq 2) { exit 2 }` |
| 33 | N-A | No "mods"/`turn.step` subsystem in OCC |
| 34 | N-A | claude.ai plugin/skill sync subsystem trimmed (`reservedNames.ts:36-48`) |
| 35 | N-A | `ReviewArtifactTool` stub; artifact publish = cloud/desktop-only |
| 36 | N-A | Artifact subsystem stub/cloud-only |
| 37 | PORT | FGTS gate is `firstParty`-only (`api.ts:226`), Bedrock excluded; official enables on default `bedrock-runtime.<region>.amazonaws.com` |
| 38 | STAGED | "Waiting for API response" ping-aware wait-banner + first-byte-timeout subsystem absent (prior-round A5); OCC has only time-based rotating hints |
| 39 | STAGED | OCC writes GitHub bodies via `gh` verbatim, no mention sanitizer; official fix mechanism not byte-pinnable (likely GitHub-app/cloud guidance) |
| 40 | N-A | OCC's live Linux sandbox is the `@anthropic-ai/sandbox-runtime` adapter that **rebuilds `denyWrite` per command** (`sandbox-adapter.ts:1739,1841`) with no session-scoped state; nested-userns bypass already patched (2.1.305 backport) |

**PORT count: 9** (items 20, 21, 23, 24, 25, 26, 27, 32, 37).
