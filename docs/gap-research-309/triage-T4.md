# Triage T4 — cc 2.1.309 changelog items 58–79 ([VSCode], [Cloud sessions], [Claude Tag], [Code Review])

Scope: /tmp/cc-diff-309/items.txt lines 58–79.
Method: OCC surface grep (read-only) + byte-level forensics on BIN309 (`grep -aboF` / `dd`) and NEWSTR. Official binaries never executed.

Key structural facts established first (used by most verdicts below):

- **The VS Code extension is NOT embedded in the CLI ELF.** BIN309 contains zero hits for `acquireVsCodeApi`, `vscode-webview`, `extension.vsixmanifest`, `.vsix`, `claude-vscode-releases`, `Session history`. The extension ships as a separate marketplace VSIX; the CLI only *installs* it (`--install-extension anthropic.claude-code`, BIN309: 5 hits `install-extension`, 9 hits `anthropic.claude-code`, count 308≈309 → installer unchanged). OCC mirrors this: `src/utils/ide.ts:860-977` (marketplace install + internal artifactory path), and OCC contains **no extension package** (no `package.json` with `contributes`/`extensionKind`/`engines.vscode` anywhere in repo).
- **Cloud-sessions / Slack / Code-Review fixes are server-side (claude.ai web UI, Slack backend, GitHub check-run service).** Verified no corresponding client artifacts changed: `Add connector` 0 hits in both binaries; `read documentation` 0/0; `environment_variables` 43→44 (diff = rechunking only); slack strings `sessionChannelPersonTyped` 9=9, `claude-in-slack` 13=13, `approval card` 33=33; `review stop` 2=2; the GitHub workflow YAML templates (`name: Claude Code Review` region @308:131253176 / @309:131261192) are **byte-identical** between 308 and 309 (region diff = window-offset artifact only).
- **The one real CLI-side change in this range is the feedback refusal taxonomy (item 66)** — new in 309, absent from 308, and OCC's `Feedback.tsx` still has the exact bug the changelog describes.

---

### Item 58 — VERDICT: N-A
- changelog: [VSCode] log warning when dictation or the extension's own requests fail certificate verification (TLS-inspecting proxy)
- OCC surface: no VS Code extension shipped (no vsix/webview package; `grep contributes|extensionKind` over all package.json = 0). CLI dictation exists (`src/services/voiceStreamSTT.ts`, `src/commands/voice/voice.ts`) but the warning is an extension-output-channel artifact.
- official evidence: extension code absent from BIN309 (0 hits `acquireVsCodeApi`/`vscode-webview`). The CLI-side cert guidance strings ("TLS-inspecting corporate proxy…NODE_EXTRA_CA_CERTS…network-config") are old (2=2 in 308/309).
- action: dismiss — extension-only artifact OCC does not ship. **Adjacent finding (hand to network/cert triage owner, items 1–57):** 309 DID rework CLI CA-store diagnostics — new-in-309 strings at BIN309 ~129588200–129590000: `No certificate authority to trust: CLAUDE_CODE_CERT_STORE=system (or NODE_OPTIONS --use-system-ca or --use-openssl-ca) leaves out the runtime's bundled roots`, `every certificate in the system CA store is expired or on the deny list`, `the system CA store is empty: check…(SSL_CERT_FILE, SSL_CERT_DIR…)`, `the runtime has no system CA store`, `system_store_failed`, `issuer_missing_dropped`, `…certificate(s) that do not chain to a root in the CA list`, `not a self-signed CA certificate`, `the certificate does not carry the exact DNS hostname in a subjectAltName`. OCC `src/utils/caCerts.ts` (259 lines, tests named caDenyList303) lacks 5/7 probes of these — real gap, but belongs to the CA-store changelog item, not item 58.

### Item 59 — VERDICT: N-A
- changelog: [VSCode] Claude panel blank after editor cached incomplete copy of its files; self-recovery / actionable error
- OCC surface: absent — no extension/webview asset shipping or integrity-check code in OCC (0 hits `acquireVsCodeApi`, no extension package).
- official evidence: n/a — fix lives in the VSIX artifact, not BIN309 (no webview strings in binary).
- action: dismiss — extension webview asset-cache recovery; nothing to port into a CLI-only product.

### Item 60 — VERDICT: N-A
- changelog: [VSCode] Session history filling with empty "Untitled" sessions when starting without sending a message
- OCC surface: absent — extension's Session history panel. OCC has CLI `/resume` (`src/commands/resume`) but the fix is extension session lifecycle.
- official evidence: `Untitled` count identical 308 vs 309 (25=25); `Session history` 0 hits in BIN309 → no CLI-side change.
- action: dismiss — extension-only.

### Item 61 — VERDICT: N-A
- changelog: [VSCode] long slash-command messages (e.g. `/goal`) now fold behind Show more (#97469)
- OCC surface: absent — chat-panel message folding is extension webview UI. `/goal` exists in OCC (`src/commands/goal`) but rendering fix is not CLI-side.
- official evidence: n/a — `Show more` 1 hit in BIN309 (unrelated), no webview fold code in binary.
- action: dismiss — extension UI.

### Item 62 — VERDICT: N-A
- changelog: [VSCode] long messages not folding behind Show more after panel narrowed
- OCC surface: absent — same extension webview folding code as item 61.
- official evidence: n/a — surface absent from BIN309.
- action: dismiss — extension UI.

### Item 63 — VERDICT: N-A
- changelog: [VSCode] Ctrl+J in chat input always inserted newline; now left to VS Code/OS when `"ctrl+j": null` in Chat context of ~/.claude/keybindings.json
- OCC surface: CLI-side keybindings fully present and ALREADY correct: `src/keybindings/defaultBindings.ts:89` (`'ctrl+j': 'chat:newline'`), `src/keybindings/schema.ts:44` (Chat context), `src/keybindings/resolver.ts:57-58,242-243` (`action === null` → `{type:'unbound'}`, incl. chord-shadowing comment at 207-210). The fix is the *extension* honoring that null.
- official evidence: `chat:newline` count 5=5 in 308/309; `ctrl+j` 6=6 → zero CLI-side keybinding change in 309; fix is VSIX-side.
- action: dismiss — OCC CLI already implements the null-unbind contract the extension now consumes; no extension to fix.

### Item 64 — VERDICT: N-A
- changelog: [VSCode] mod's "From the … plugin" label drawn over slash-command/@-mention menus (#102981)
- OCC surface: absent — extension chat-panel z-order/rendering. (OCC has plugin/mod infra CLI-side, but the label overlap is webview CSS.)
- official evidence: n/a — surface absent from BIN309.
- action: dismiss — extension UI.

### Item 65 — VERDICT: N-A
- changelog: [VSCode] empty list item/paragraph/code block and renumbered list items when pasting LaTeX math
- OCC surface: absent — extension webview markdown/paste pipeline.
- official evidence: n/a — surface absent from BIN309.
- action: dismiss — extension UI.

### Item 66 — VERDICT: PORT
- changelog: [VSCode] feedback error showing only an HTTP status when your organization does not accept feedback (twin of main-list item: "Fixed feedback saying 'try again later' when your organization does not accept feedback; it now shows the server's reason and where to report a bug")
- OCC surface: PRESENT and stale — `src/components/Feedback.tsx` + `src/commands/feedback/feedback.tsx`. `submitFeedback()` (Feedback.tsx ~489-580) only classifies ZDR (403 `permission_error` + "Custom data retention settings" → `isZdrOrg`); every other failure collapses to `setError('Could not submit feedback. Please try again later.')` (line 219) — literally the bug text the changelog fixes. No `feedback_retention_blocked`/`feedback_disabled`/`org_refused`/`scope_refused`/`auth_refused` anywhere in OCC (grep = 0).
- official evidence: NEW in 309 (all 0 hits in 308 binary): `Your organization does not accept feedback` @BIN309 120418212/258326955; `Feedback has not been enabled for your organization.` (2 hits); `Feedback containing third-party provider content cannot be submitted.` (2); `feedback_third_party_blocked` (3); `org_refused`, `auth_refused` (2 each); enum cluster `zdr_org / feedback_disabled / org_refused / oauth_scope_insufficient / auth_refused / feedback_check_unavailable / http_error` @ ~120414500-120418500; `scope_refused` @120414560. Full readable implementation at NEWSTR offset ~20383400-20385000: classifier `As(status, body)` parsing zod schema `{error:{type,message,details:{error_code}}}`:
  - `feedback_retention_blocked` (or legacy 403 permission_error+"Custom data retention settings") → `{isZdrOrg:true, failureReason:'zdr_org', refusal:{kind:'org',serverMessage}}`
  - `feedback_disabled` / `feedback_third_party_blocked` (or 403 with message === "Feedback has not been enabled for your organization." / third-party text) → `failureReason:'org_refused'`, `refusal.kind:'org'` (+`reportContent:true` for third-party)
  - `oauth_scope_insufficient` → `'scope_refused'`; any 401 → `'auth_refused'`; `refusal.kind:'credential'`
  - else `failureReason:'http_error'`, `refusal.kind: ('feedback_check_unavailable'||408||429||>=500) ? 'transient':'other'`
  Message builders: org → `serverMessage ?? "Your organization does not accept feedback."` (ZDR keeps "Feedback collection is not available for organizations with custom data retention policies."); credential/scope → "Couldn't send feedback: the sign-in this session uses is not allowed to send feedback (server returned NNN: msg)." / "…the server did not accept the credentials this session uses…". The refusal object is returned through the SDK `submitFeedback` control request (BIN309 control-method table @ ~120415000 lists `messageRated…submitFeedback…launchUltrareview`) — that is how the [VSCode] panel gets the reason instead of a bare status.
- action: PORT to `src/components/Feedback.tsx` (and the SDK `submitFeedback` control-response path once located): extend `submitFeedback()` return with `failureReason` + `refusal {kind, serverMessage, reportContent?}`, implement the `As()` classifier above (error_code-first, HTTP-status fallbacks), replace line 219's generic message with: org refusals → server message / "Your organization does not accept feedback."; credential refusals → the two scope/auth messages with `(server returned NNN: msg)` suffix; transient → keep retry-later wording; persistent failures → append "If it keeps failing, you can file at <GITHUB_ISSUES_REPO_URL>" (string already exists in 308 and OCC has the URL const at Feedback.tsx:36). NOTE: the identical shared-module fix backs main-list item ~25 ("try again later") — coordinate with the items-1–57 triager so it is ported once, not twice. Add AAA tests: each error_code → expected failureReason/refusal/message; 401 without code → auth_refused; 500 → transient.

### Item 67 — VERDICT: N-A
- changelog: [VSCode] Edit/Write speed in chat panel — wait for new problems after each edit now 0.75s (was 1–1.5s)
- OCC surface: CLI-side diagnostic tracking exists (`src/services/diagnosticTracking.ts`, `FileEditTool.ts:651,743-754`, LSPDiagnosticRegistry) but the 0.75s knob is the extension chat panel's post-edit diagnostics wait.
- official evidence: no CLI-side diagnostics change in 309: `getDiagnostics` 6=6, `new_diagnostics`/`diagnosticsTimeout`/`waitForEditorDiagnostics` 0/0 in both binaries.
- action: dismiss — extension-side tuning. (If OCC ever tunes its own LSP wait, that's a separate perf decision, not this item.)

### Item 68 — VERDICT: N-A
- changelog: [Cloud sessions] Add connector list in routine forms said "no connectors" while still loading
- OCC surface: absent — claude.ai web UI (routines + connector picker). OCC has MCP connectors CLI-side (`src/commands/mcp`) but no routine forms. `Add connector` = 0 hits in BIN309/308.
- official evidence: n/a — server/web-side fix.
- action: dismiss — web UI.

### Item 69 — VERDICT: N-A
- changelog: [Cloud sessions] cloud environment editor shuffling env vars and adding backslashes to values containing both quote kinds
- OCC surface: absent — web env editor. OCC's `src/components/RemoteEnvironmentDialog.tsx` (339 lines) only *selects* a default environment (getEnvironmentSelectionInfo); it has no env-var editing/serialization (grep `envVars|serializeEnv|shell-quote` = 0). `environment_variables` string diff 308→309 = rechunking only (43→44, no new short strings).
- official evidence: n/a — no client-side serialization change in BIN309.
- action: dismiss — web UI. Keep the quoting-bug pattern in mind if OCC's remote-env dialog ever grows env editing.

### Item 70 — VERDICT: N-A
- changelog: [Cloud sessions] self-hosted environment details dialog in admin settings — title/tabs/buttons stay in view while content scrolls
- OCC surface: absent — claude.ai admin settings web dialog. OCC's `src/self-hosted-runner/` is the runner process, not an admin-settings UI; no dialog/scroll code.
- official evidence: n/a — web CSS/layout fix.
- action: dismiss — web UI.

### Item 71 — VERDICT: N-A
- changelog: [Cloud sessions] "read documentation" tool row showed escaped JSON instead of a readable page
- OCC surface: absent — web transcript renderer for cloud sessions. `read documentation` = 0 hits in both binaries (tool-row label is web-side).
- official evidence: n/a — server/web-side rendering fix.
- action: dismiss — web UI.

### Item 72 — VERDICT: N-A
- changelog: [Cloud sessions] Changes pane now says when it lists only pushed commits or only Claude's edits
- OCC surface: absent — web Changes pane. (`Changes pane` string 6=6 in binaries, pre-existing/unrelated; no new client code.)
- official evidence: n/a — web UI.
- action: dismiss — web UI.

### Item 73 — VERDICT: N-A
- changelog: [Claude Tag] Slack draft approved for a channel posted into DM by mistake; a post with no channel is now refused
- OCC surface: absent — OCC's entire Slack surface is `src/commands/install-slack-app/install-slack-app.ts` (30 lines): opens `https://slack.com/marketplace/A08SF47R6P4-claude` and bumps `slackAppInstallCount`. No Slack posting/draft tools (grep `slack_post|postDraft|channel is required` → no OCC-side send code; binary strings `slack_post` 2=2, `post_message` 5=5 unchanged).
- official evidence: draft-string diff 308→309 shows only one behavioral micro-change (". The draft is still queued. Try again later." → ". The draft is still queued.") in unrelated CLI draft-preview code; no channel-validation strings added. Fix is Slack-backend.
- action: dismiss — Anthropic Slack backend.

### Item 74 — VERDICT: N-A
- changelog: [Claude Tag] Allow/Deny on Slack approval cards did nothing when session had stopped; answer now restarts the session
- OCC surface: absent — approval-card + session-restart orchestration is Anthropic's Slack backend. OCC has permission prompts CLI-side only; `approval card` string count 33=33 (pre-existing, unchanged).
- official evidence: n/a — no 309 client-side delta.
- action: dismiss — backend.

### Item 75 — VERDICT: N-A
- changelog: [Claude Tag] Claude ignoring untagged channel messages after workspace moved orgs (incl. Enterprise Grid unshared channels)
- OCC surface: absent — org/workspace mapping is Slack-backend. `Enterprise Grid` appears 1× in NEWSTR as rechunked pre-existing text; `claude-in-slack` 13=13.
- official evidence: n/a — backend fix.
- action: dismiss — backend.

### Item 76 — VERDICT: N-A
- changelog: [Claude Tag] threaded reply posted before reading a newer message just added to the thread
- OCC surface: absent — Slack event-delivery ordering in Anthropic backend. OCC has no Slack event ingestion (install-slack-app only).
- official evidence: n/a — backend fix.
- action: dismiss — backend.

### Item 77 — VERDICT: N-A
- changelog: [Claude Tag] Slack page in Claude Tag admin settings showed "no workspaces" when list failed to load; now error + Retry
- OCC surface: absent — claude.ai admin settings web page.
- official evidence: n/a — web UI fix.
- action: dismiss — web UI.

### Item 78 — VERDICT: N-A
- changelog: [Code Review] finished review showed no PR check when earlier creation attempts failed; a final attempt now adds a completed check
- OCC surface: related surfaces exist but none owns check-run creation: `src/commands/review/` (local /review, `reviewRemote.ts` = ultrareview→CCR teleport via RemoteAgentTask, quota/overage gating), `src/commands/install-github-app/setupGitHubActions.ts` (writes workflow YAMLs, sets secrets, opens compare-URL PR page). No GitHub check-run API code anywhere in OCC (grep `check_run|checks` in review/install-github-app = only analytics/eligibility hits).
- official evidence: check lifecycle lives in the cloud review service / `anthropics/claude-code-action` (pinned `@v1` in both OCC `src/constants/github-app.ts:40,135` and official template). Workflow template regions byte-compared 308@131253176 vs 309@131261192 → identical; `completed check`/`check now closes` 0 hits in both binaries.
- action: dismiss — server/action-side; the CLI artifact (workflow templates) did not change, so there is nothing to port.

### Item 79 — VERDICT: N-A
- changelog: [Code Review] push queued behind a running review still started a review after `@claude review stop`; its check now closes and says why
- OCC surface: same as item 78 — OCC has no review-queue/check-close logic. `review stop` string 2=2 in 308/309 (unchanged help/comment text); RemoteAgentTask stop path is CCR-session stop, not GitHub check close.
- official evidence: no client-side delta (workflow templates byte-identical; no new queue/check strings).
- action: dismiss — server/action-side.

---

## Summary

| Item | Block | Verdict |
|---|---|---|
| 58 | VSCode cert-warning | N-A (adjacent: 309 CLI CA-store logging rework — OCC caCerts.ts behind; refer to network-item owner) |
| 59 | VSCode blank panel | N-A |
| 60 | VSCode Untitled sessions | N-A |
| 61 | VSCode /goal folding | N-A |
| 62 | VSCode refold on resize | N-A |
| 63 | VSCode Ctrl+J null | N-A (OCC CLI null-unbind already correct) |
| 64 | VSCode mod label z-order | N-A |
| 65 | VSCode LaTeX paste | N-A |
| 66 | VSCode feedback error | **PORT** |
| 67 | VSCode 0.75s diagnostics | N-A |
| 68–72 | Cloud sessions (5) | N-A (web UI; OCC remote-env is select-only) |
| 73–77 | Claude Tag Slack (5) | N-A (backend; OCC slack surface = URL opener) |
| 78–79 | Code Review (2) | N-A (service/action; templates byte-identical 308↔309) |

**PORT count: 1** (item 66 — feedback refusal classifier, shared CLI module; dedupe with main-list twin item ~25).
Secondary handoff: item 58 note — new-in-309 CLI CA-store diagnostic strings (BIN309 ~129.588-129.590MB) missing from OCC `src/utils/caCerts.ts`; route to whoever owns the network/cert items in 1–57.
