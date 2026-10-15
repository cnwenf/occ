# Triage T4 — OCC gap research round 2026-10-16 (official Claude Code 2.1.299 → 2.1.300)

Cluster T4. Assigned entries: 5, 13, 15, 16, 17, 21, 31, 32, 34, 39, 47, 53, 60, 63, 67–78 (26 entries).

Evidence method per brief: official ELFs inspected ONLY with `strings` / `grep -aboF` / `grep -c` / bounded `dd` (never executed). Binaries: `/tmp/cc-diff-300/v299/package/claude` (2.1.299), `/tmp/cc-diff-300/v300/package/claude` (2.1.300).

Disposition summary: **PORT 5** (entries 5, 31, 34, 47, 63) · **STAGED 3** (15, 17, 53) · **N-A 18** (13, 16, 21, 32, 39, 60, 67–78).

---

## 5 — PORT: `/advisor` on Claude Platform on AWS

**Official evidence (binary):**

- v299 gate `bxt()` @221830809:
  `function bxt(){if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL||TA())return!1;return Oe()==="firstParty"&&Kh()}`
- v300 gate `_It()` @222993478:
  `function _It(){if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL||bP())return!1;let e=Ie();return(e==="firstParty"||wD(e))&&ny()}`
- v300 helper `wD` @216213859:
  `function wD(e=Ie()){return e==="anthropicAws"||e==="anthropicGoogleCloud"}`
  (sibling `VG(e)` = firstParty || wD || foundry || mantle)
- Statsig default changed: v299 `ek()` → `k("tengu_sage_compass2",{})`; v300 `gk()` → `k("tengu_sage_compass2",{enabled:wD(Ie())})`.
- Provider map `$v` @216211900 (v300): `{bedrock:"Amazon Bedrock",…,anthropicAws:"Claude Platform on AWS",anthropicGoogleCloud:"Claude Platform on Google Cloud",mantle:…,gateway:"Cloud gateway"}`; env map `QXe`: `anthropicAws:"CLAUDE_CODE_USE_ANTHROPIC_AWS"`.
- Onboarding text @218824611: `anthropicAws:"Claude Platform on AWS: set CLAUDE_CODE_USE_ANTHROPIC_AWS=1 (https://code.claude.com/docs/en/claude-platform-on-aws)"`.
- The `anthropicAws` provider itself already exists in v299 (@215996104) — the only v300 delta is the widened advisor gate (`firstParty` → `firstParty||wD`) plus the statsig default parameter.

**OCC evidence:**

- `src/utils/advisor.ts:119-156` `isAdvisorEnabled()` — :133 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` check, :138 advisor-org-disabled check, **:145 `if (getAPIProvider() !== 'firstParty') { return false }`** (exactly the v299 gate), :148 `DISABLE_EXPERIMENTAL_BETAS`, :152 `ENABLE_EXPERIMENTAL_ADVISOR_TOOL`, :155 `getAdvisorConfig().enabled ?? false`.
- `src/utils/model/providers.ts:5-12` APIProvider union includes `'anthropic_aws'`; :26-27 `CLAUDE_CODE_USE_ANTHROPIC_AWS` → `'anthropic_aws'`; :100-102 `isAnthropicAwsProvider()`; :182-189 `isAnthropicOwnedProvider()` = firstParty || anthropic_aws || gateway; comment :177 documents OCC folds official `anthropicGoogleCloud` into firstParty (so the `wD` google arm is already covered by OCC's firstParty).
- `src/commands/advisor.ts` (130 lines): `/advisor` command with `advisorModel` get/set — surface exists.
- Statsig/analytics are stubbed in OCC (CLAUDE.md), so the `{enabled:wD(...)}` parameter has no live counterpart to port.

**Sketch:**

1. `src/utils/advisor.ts:145` — replace the strict `getAPIProvider() !== 'firstParty'` early-return with the official v300 gate shape: enabled when provider is `'firstParty'` OR `isAnthropicAwsProvider()` (OCC's `'anthropic_aws'` = official `anthropicAws`; `anthropicGoogleCloud` already folds into firstParty, so no extra arm needed). Simplest faithful form: `const provider = getAPIProvider(); if (provider !== 'firstParty' && provider !== 'anthropic_aws') return false`.
2. Keep all other checks (:133/:138/:148/:152/:155) unchanged — they mirror the official gate order (env kill-switch → org disable → provider → betas/opt-in → config default).
3. The "no advisor runs until you pick one" behavior is the pre-existing `getAdvisorConfig().enabled ?? false` default (:155) — already aligned; note in the code comment that v300's statsig default `{enabled:wD(Ie())}` is analytics-only and stubbed in OCC.
4. Test idea: unit test `isAdvisorEnabled()` with `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` + advisor configured → true; without configuration → false; with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` → false; bedrock/vertex → false.

---

## 13 — N-A: `claude agents` not refreshing a PR's status on incomplete data

**OCC-surface-absence proof:** OCC's agents dashboard has no per-agent pull-request status surface at all.

- `src/main.tsx:4927-4937`: `program.command('agents').description('Show background sessions dashboard …')` → delegates to `src/cli/handlers/agents.ts`.
- `grep -rniE '\bpr\b|pull[_ -]?request|reviewDecision' src/cli/handlers/agents.ts` → **0 hits** (word-boundary verified; earlier case-insensitive substring hits were `program`/`process`/`Reviewer`-role text only).
- OCC's only PR-status surface is the footer badge: `src/utils/ghPrStatus.ts` `fetchPrStatus` = current-branch-only `gh pr view --json number,url,reviewDecision,isDraft,headRefName,state` (:81-90) + glab MR fallback (:73-75), consumed via `src/hooks/usePrStatus.ts` (60s poll) → `src/components/PrBadge.tsx` → `PromptInputFooterLeftSide.tsx`. `grep -rn 'ghPrStatus\|PrBadge' src/components/FleetView/ src/cli/handlers/agents.ts` → 0 hits.

There is no "agents list showing each agent's PR" to fix; the official bug (a batch refresh aborting when one PR's data came back incomplete) has no OCC counterpart.

---

## 15 — STAGED: subagents you typed messages to disappearing from `/tasks` after finishing

**OCC evidence (real surface, pre-fix behavior present):**

- `src/commands/tasks/tasks.tsx`: `/tasks` → `BackgroundTasksDialog`.
- `src/tasks/types.ts:41-49` `isBackgroundTask`: `if (task.status !== 'running' && task.status !== 'pending') return false;` — completed tasks are dropped, plus `isBackgrounded === false` exclusion. So a finished subagent you had typed messages to vanishes from `/tasks` — exactly the official pre-2.1.300 behavior.
- `src/components/tasks/BackgroundTasksDialog.tsx`: :135-138 `getSelectableBackgroundTasks`, :204 filter via `isBackgroundTask`, :224 teammates filter (`showSpinnerTree ? [] : …in_process_teammate`), :226-231 leader entry, :146 spinner-tree mode; `enterTeammateView`/`exitTeammateView` imported :8.
- Typed-message surface exists: `src/screens/REPL.tsx:45-46` `injectUserMessageToTeammate` / `queuePendingMessage` / `appendMessageToLocalAgent`.
- No `removeTask`/`deleteTask` for `InProcessTeammateTask`/`LocalAgentTask` in `src/tasks/framework.ts`.

**Why not PORT:** the official v300 retention rule (which finished typed-message subagents stay listed, for how long, and how "way back to the conversation" is wired — re-enter view vs. resume transcript) could not be recovered from strings within this round's budget; the tasks-dialog retention predicate lives in minified React state code with no distinctive marker strings. Guessing the retention window/UX would violate "never invent".

**Next-round probe:** decompile the v300 tasks-dialog region around the teammate-row builder (locate via the `in_process_teammate`-equivalent literal in v300 and walk the filter function); determine (a) whether completed typed-message teammates are kept indefinitely or time-bounded, (b) what selecting a finished row does (enterTeammateView on a dead task vs. transcript replay). Then port: relax `isBackgroundTask` (types.ts:41-49) to retain tasks with a `hasTypedMessages`-style marker and make the dialog row route to the existing `enterTeammateView` read-only path.

---

## 16 — N-A: completed parent agent dropping off the breadcrumb (child re-rooted)

**OCC-surface-absence proof:** OCC has no hierarchical agent breadcrumb UI.

- `src/components/TeammateViewHeader.tsx` (81 lines): :31 `<Text>Viewing </Text>`, :38 `@{viewedTeammate.identity.agentName}`, :47 esc-return hint — a flat single-name header, no parent chain.
- `grep -rn 'AgentBreadcrumb\|agentTrail\|viewStack\|re-root' src/` → 0 hits (the compound-pattern "root" substring hits are test fixtures: grepTool210, otelGitCommitId, sandboxWsl, bareGitRepo — unrelated).
- OCC's only "breadcrumb" concepts are transcript-recovery breadcrumbs (`src/utils/conversationRecovery.ts:372/:456/:858-870`, the CC 2.1.267 port) and the scroll-context breadcrumb (`src/components/FullscreenLayout.tsx:574`) — neither is an agent-hierarchy breadcrumb.

No breadcrumb → no re-root bug. If OCC ever adds hierarchical agent viewing, revisit.

---

## 17 — STAGED: agents view taking typed words ("up"/"down"/"escape") for keys on burst input

**OCC evidence (real surface):**

- `src/components/FleetView/FleetViewScreen.tsx:119-197` — `useInput` navigation handler registered ahead of text input: :128-138 ENTRY-name path with guard :129 `if (inputValue !== '') return`; :145-181 up/down/return/escape handling with `event.stopImmediatePropagation()`; :183-194 ctrl+g group mode and 'x' kill. :199 "Phase 1 stub" comment.
- `src/components/FleetView/FleetView.tsx:79`: `↑↓ navigate · ⏎ peek · esc back`; `SessionPreview.tsx` = peek surface. So OCC's agents view does consume raw up/down/escape keys — the same class of bug (a burst of typed text containing "up"/"down"/"escape" being misread as navigation) is plausible on OCC's surface.

**Why not PORT:** the official fix's mechanism was not recoverable from strings — no distinctive new marker string in v300 identifies whether the fix is (a) bracketed-paste/burst detection in the keypress parser, (b) an input-mode flag suppressing navigation keys while typing, or (c) a timing heuristic. Porting the wrong mechanism risks breaking FleetView navigation.

**Next-round probe:** diff the v299→v300 keypress-parser region (search both binaries for the escape-sequence table literals, e.g. `\x1b[A`-adjacent strings, and compare surrounding code via bounded dd); identify the burst/paste discriminator the official agents view now checks. Then audit OCC's `src/ink/parse-keypress.ts` for the same discriminator and gate `FleetViewScreen.tsx:145-181` navigation keys on it (or on "input arrived as multi-char burst"). Test idea: e2e — type the literal word "escape" into the FleetView filter while a peek is open; assert selection/peek unchanged.

---

## 21 — N-A: Artifact tool row reading `Artifact("(unprintable path)")` while input arrives

**OCC-surface-absence proof:** OCC has no real Artifact tool.

- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` full content: `// Auto-generated stub — replace with real implementation` / `export {};` / `export const ReviewArtifactTool: Record<string, unknown> = {};`.
- Gated by `feature('REVIEW_ARTIFACT')` (`src/components/permissions/PermissionRequest.tsx:36/:57/:136`); `grep -c 'REVIEW_ARTIFACT' src/utils/featureFlags.ts` → 0 — not in the 6-flag allowlist → dead code.
- `grep -rn '(unprintable path)' src/` → 0 hits.
- The Bash-row parity target the official fix imitates does exist in OCC (`src/tools/BashTool/UI.tsx:149 Running…`, `:157 Waiting…`) but there is no Artifact row to fix.

---

## 31 — PORT: scratchpad files named by bare filename / relative path

**Official evidence (binary):**

- v300-only sentence @224570825 (0 hits in v299; agt scratchpad-builder dd @224570300):
  `Whenever you name a file in it to the user, write the file's complete absolute path in one piece, not a bare filename, a path that starts at the scratchpad folder, or the directory followed by filenames: a shortened path is read against the working directory and leads nowhere.`
- v299 same builder dd @223389814 is byte-identical minus that sentence — the fix is a pure prompt-text append.
- Note: OCC's scratchpad prompt phrasing ("Always use this scratchpad") has ZERO hits in both official binaries — OCC's surrounding prompt format is its own divergence; only the new sentence is portable byte-exact.

**OCC evidence:**

- `src/constants/prompts.ts:849-871` `getScratchpadInstructions()` — lacks the v300 sentence.
- Wiring: `src/utils/filesystem.ts:334/:420` consume the instructions (scratchpad dir creation + prompt injection).

**Sketch:**

1. `src/constants/prompts.ts` `getScratchpadInstructions()` (:849-871) — append the official sentence byte-exact:
   `Whenever you name a file in it to the user, write the file's complete absolute path in one piece, not a bare filename, a path that starts at the scratchpad folder, or the directory followed by filenames: a shortened path is read against the working directory and leads nowhere.`
2. Match the official placement (end of the scratchpad instruction block per the dd excerpt); do NOT otherwise reformat OCC's divergent surrounding phrasing this round.
3. Test idea: snapshot/unit test asserting `getScratchpadInstructions()` contains the exact sentence; e2e prompt-dump check (`-p` with `--exclude-dynamic-system-prompt-sections` off) that the sentence appears in the first user message/system prompt.

---

## 32 — N-A: `claude remote-control` servers giving up renewing after a brief sign-in error

**OCC-surface-absence proof:** the cloud Remote Control bridge is dead code in OCC.

- Gate: `src/main.tsx:2702` `if (feature('BRIDGE_MODE') && remoteControlOption !== undefined)`; `BRIDGE_MODE` ∉ `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts:13-17`, `feature` impl :65) → the cloud path never runs.
- The cloud client itself: `src/remote/SessionsWebSocket.ts` (:78 comment `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`, :108-109 URL build, :34-35 `PERMANENT_CLOSE_CODES = new Set([4003 …])`, :247 no-reconnect on permanent, :262 4001 retry budget) — unreachable behind the dead gate.
- OCC's LIVE `remote-control` surface is a different architecture: local daemon HTTP over a Unix socket (`src/daemon/remoteControlClient.ts:1-12` header — lockfile `~/.claude/daemon.lock` discovery; `src/daemon/remoteControlServer.ts` 473 lines, Node `http` only :19, `stopped:true` responses :373/:379 to explicit POST /stop). There is no cloud connection renewal, no keychain sign-in loop, and no `claude /login` warn-on-renew path to fix.

---

## 34 — PORT: editor CLI launched twice to check for the IDE extension (integrated terminal)

**Official evidence (binary):**

- v299 orchestrator `ino` @227223885 (double launch): `if(fEe(w))sEn(w).then(async(H)=>{JWr(w,y).catch((G)=>({installed:!1,error:G.message||"Installation failed",installedVersion:null,ideType:w})).then((G)=>{if(s(G),G?.installed&&!h?.aborted)Bur().then(e);if(!H&&G?.installed===!0&&!Vur())r(G)})});else if(C_e(w))…` — `sEn` = isIDEExtensionInstalled (editor CLI launch #1), `JWr` = maybeInstall (launch #2 via install).
- v300 orchestrator `Eio` @228451386 (single launch): `if(Cxe(w))P6r(w,y).catch((H)=>({installed:!1,error:H.message||"Installation failed",installedVersion:null,ideType:w})).then((H)=>{if(s(H),H?.installed&&!h?.aborted)ygr().then(e);if(H?.installed===!0&&!H.previouslyInstalled&&!vgr())r(H)});else if(Hbe(w))I6r(w).then(async(H)=>{if(H&&!vgr())r(null)})` — the pre-check launch is gone; onboarding gated on `!H.previouslyInstalled`.
- v300 installer `O6r` @228445620 returns the new shape: `let r=await D6r(n),s=r!==null;if(!r||pM(r,qxn())){await X(500);let h=await ct(n,["--force","--install-extension","anthropic.claude-code"],{env:Ttt()});if(h.code!==0)throw Object.assign(Error(\`${h.code}: ${h.error}: ${h.stderr}\`),{code:\`EXIT_${h.code}\`});r=qxn()}return{installedVersion:r,previouslyInstalled:s}` — vs v299 `e1r` @227218560 returning bare `r`/null.
- `previouslyInstalled`: v299 → 0 hits; v300 → 6 hits (107680264, 228442594, 228442857, 228446019, 228446072, 228451386). OCC → 0 hits.
- Bonus parity: v300 install env `Ttt()` = `{...process.env,DISPLAY:"",WAYLAND_DISPLAY:""}` (OCC clears DISPLAY only).

**OCC evidence:**

- `src/utils/ide.ts`: `IDEExtensionInstallationStatus` :583-588 `{installed,error,installedVersion,ideType}`; `maybeInstallIDEExtension` :590-622; `isIDEExtensionInstalled` :852-877 (`command --list-extensions`, EXTENSION_ID :847-850); `installIDEExtension` :879-911 returns `string|null` — calls `getInstalledVSCodeExtensionVersion` :931-949 (`--list-extensions --show-versions`) then conditional `--force --install-extension anthropic.claude-code` with `await sleep(500)`; `getInstallationEnv` :913-925 (DISPLAY only); `initializeIdeIntegration` :1288-1348 — **:1307 `void isIDEExtensionInstalled(ideType).then(async isAlreadyInstalled => {` :1308 `void maybeInstallIDEExtension(ideType)`** (the double launch), onboarding gate :1327 `!isAlreadyInstalled && status?.installed === true && !…HasBeenShown()`; JetBrains branch :1335-1344 (official left it unchanged too).

**Sketch:**

1. `src/utils/ide.ts` `installIDEExtension` (:879-911): return `{ installedVersion: string | null, previouslyInstalled: boolean }` — capture `previouslyInstalled = existingVersion !== null` before the conditional `--force --install-extension` run (mirrors official `O6r`: `s=r!==null` … `return{installedVersion:r,previouslyInstalled:s}`).
2. Extend `IDEExtensionInstallationStatus` (:583-588) with `previouslyInstalled?: boolean`; thread it through `maybeInstallIDEExtension` (:590-622).
3. `initializeIdeIntegration` (:1288-1348): in the VS Code-family branch, drop the `isIDEExtensionInstalled` wrapper (:1307-1308) — call `maybeInstallIDEExtension(ideType)` directly once; gate the onboarding suggestion on `!status.previouslyInstalled && status.installed === true && !…HasBeenShown()` (official `!H.previouslyInstalled&&!vgr()`). Leave the JetBrains branch (:1335-1344) as-is (official `Hbe(w)` branch still uses the installed-check).
4. Optional same-PR parity: `getInstallationEnv` (:913-925) add `WAYLAND_DISPLAY: ''` alongside `DISPLAY: ''` (official `Ttt()`).
5. Test idea: unit test with a fake editor CLI counting spawns — assert exactly ONE spawn during initializeIdeIntegration for vscode/cursor; assert onboarding fires when `previouslyInstalled === false && installed === true` and stays silent on upgrade-in-place (`previouslyInstalled === true`).

---

## 39 — N-A: Remote Control sessions marked stopped while still running (multi-session host)

**OCC-surface-absence proof:** same dead cloud-bridge surface as entry 32.

- Cloud Remote Control gated by `feature('BRIDGE_MODE')` (`src/main.tsx:2702`), BRIDGE_MODE ∉ FEATURE_ALLOWLIST (`src/utils/featureFlags.ts:13-17`) → dead.
- OCC's live daemon remote-control (`src/daemon/remoteControlServer.ts`, Unix-socket HTTP, `stopped:true` only in response to an explicit POST /stop at :373/:379) has no cloud session registry, no multi-session "serving several sessions at once" host state, and no server-side stopped-marking path — the official bug's surface (cloud session lifecycle state reported to claude.ai) does not exist in OCC. `src/remote/RemoteSessionManager.ts` (344 lines, :318 force reconnect) is likewise behind the dead gate.

---

## 47 — PORT: dim text indistinguishable under dark ANSI theme / 16-color terminals (faintInk)

**Official evidence (binary):**

- v299 themed-Text wrapper @234021584/234022100: destructuring includes `faintInk:b` as an explicit caller prop; `I=b===void 0?!1:b`; `T=dimColor`; `_=Ae($7e)`; `H=T&&!_?M.inactive:J(d,M)`; `const G=I&&T&&!_?j:void 0` — faintInk passed down ONLY when the caller explicitly set the prop. Renders `e(Mc,{color:j,backgroundColor:Y,bold:B,faintInk:G,…})`.
- v300 wrapper @235309350/235309900: destructuring `({color:d,backgroundColor:l,dimColor:f,bold:b,italic:C,underline:h,strikethrough:x,inverse:v,wrap:E,children:u,...m}=o)` — **the faintInk prop is gone**; `A=f===void 0?!1:f` (dimColor); `W=Ae(Wet)`; `L=A&&!W?_.inactive:Y(d,_)`; `const G=A&&!W?D:void 0` — faintInk now set automatically for ALL dimColor text when the theme is dark ("whitish" detector false path). Renders `e(Dc,{color:D,backgroundColor:z,bold:T,faintInk:G,…})`. **This is the fix.**
- v300 style applicator `h6e` @219912500 vs v299 `F4e` @218792200 — sole delta: `if(i.faintInk&&i.faintInk===i.color&&!i.bold&&!i.dim&&!i.backgroundColor&&!i.inverse&&M.has(i.color))e=he.dim(e);` (v300 adds the `!i.backgroundColor&&!i.inverse` guards).
- Whitish-detector class (`M` in v300 / `f` in v299) identical in both versions: true iff chalk.level>0 and the color's render equals white/black. Palettes identical (dark-ansi v300 @219919343 vs v299 @218799003).
- `faintInk` offsets: v299 8 hits; v300 6 hits (219912817/219912829 applicator, 231403881 `Dc` props, 235310341 wrapper).

**OCC evidence:**

- `grep -rn 'faintInk' src/` → **0 hits** — subsystem absent.
- `src/components/design-system/ThemedText.tsx`: :104 `const resolvedColor = !color && hoverColor ? resolveColor(hoverColor, theme) : dimColor ? theme.inactive as Color : resolveColor(color, theme);` :108 renders `<Text color={resolvedColor} backgroundColor={resolvedBackgroundColor} bold={bold} …>` — dimColor maps to `theme.inactive` but no faint styling is applied, so under dark ANSI (`text:'ansi:whiteBright'`, `inactive:'ansi:white'`, `subtle:'ansi:white'` — `src/utils/theme.ts:323-389`, matching the official palette exactly) dim text is a near-invisible step, and on 16-color terminals `ansi:white` vs `ansi:whiteBright` often render identically.
- `src/ink/colorize.ts` `applyTextStyles` :176-225: `if (styles.dim) result = chalk.dim(result)` :210-211; inverse via raw SGR-7 :185-192 — no faintInk branch.

**Sketch:**

1. `src/ink/colorize.ts`: add `faintInk?: string` to the TextStyles type; in `applyTextStyles` add the official v300 branch (after color application): `if (styles.faintInk && styles.faintInk === styles.color && !styles.bold && !styles.dim && !styles.backgroundColor && !styles.inverse && isWhitish(styles.color)) result = chalk.dim(result)` — port the official whitish-detector (`M` class): true iff `chalk.level > 0` and the color's rendered form equals white/black.
2. `src/ink/Text.tsx` (or the Text props type): thread the `faintInk` prop into the styles object passed to `applyTextStyles`.
3. `src/components/design-system/ThemedText.tsx`: mirror the v300 wrapper — remove any opt-in semantics and compute automatically: `const faintInk = dimColor && !isDarkThemeOverride ? resolvedColor : undefined` (official `const G=A&&!W?D:void 0`: dimColor && !whitish-theme → faintInk = resolved color); pass to `<Text … faintInk={faintInk}>` at :108.
4. Test idea: unit-test `applyTextStyles` — whitish color + faintInk===color + no bold/dim/bg/inverse → output wrapped in `\x1b[2m`; with backgroundColor or inverse set → NOT dimmed; non-whitish color → untouched. Component test: ThemedText with `dimColor` under darkAnsiTheme emits faintInk equal to its resolved color.

---

## 53 — STAGED: improved @-mentioned-PDF note for Claude 3 models

**Official evidence (binary):**

- v300 PDF-note builder dd @107641100 adds two v300-only strings: `'You have NOT seen this file…'` @107641299/229315029 and a whole-file-refused branch `'This model cannot be sent a PDF file, only its pages as images. Before you write anything else…'` @107641448/107641736/229315193/229315476.

**OCC evidence:**

- `src/utils/messages.ts:4289-4301` `pdf_reference` note text matches the **v299** wording verbatim (pre-improvement).
- `src/utils/attachments.ts:354-361` `PDFReferenceAttachment` lacks `wholeRefusedByModel` / `modelReadsByPage` / `stillArriving` fields; `pageCount` is non-nullable.
- Creation path `src/utils/messages.ts:3533-3556`, gated by `PDF_AT_MENTION_INLINE_THRESHOLD = 10` (`src/utils/apiLimits.ts:119`); `isPDFSupported()` at `src/tools/FileReadTool.ts:1553`.

**Why not PORT:** the improved note text itself IS fully recovered from v300 strings, but it is emitted conditionally on new attachment-state fields whose semantics are only partly inferable: `wholeRefusedByModel` can be wired from OCC's existing `isPDFSupported()` (FileReadTool.ts:1553), but `modelReadsByPage` encodes a per-model capability distinction (which Claude 3 models read pages-as-images vs. accept whole PDFs) that has no marker string mapping model IDs → capability in the recovered regions. Guessing the model list would violate "never invent".

**Next-round probe:** bounded-dd the v300 builder around @107641100 wider (±4 KB) to recover the full conditional tree and the `modelReadsByPage` computation (look for the model-family predicate it calls); then port: extend `PDFReferenceAttachment` (attachments.ts:354-361) with the three fields (nullable `pageCount`), update the note builder (messages.ts:4289-4301) to the v300 text byte-exact, wire `wholeRefusedByModel = !isPDFSupported(model)`. Test: snapshot the three note variants (normal / not-seen-yet / whole-refused).

---

## 60 — N-A: `claude-api` skill leaving Managed Agents sessions in place

**OCC-surface-absence proof (documented by-design divergence):** OCC's bundled skill `.md` files are intentional 1-byte stubs (CLAUDE.md / OCC-44: "OCC's skill .md files are intentional 1-byte stubs").

- `src/skills/bundled/claude-api/**` — every `.md` is a 1-byte `0a` stub; `grep -rn 'Managed Agent' src/` → 0 hits.

The official change edits the `claude-api` skill's prose about Managed Agents sessions; OCC ships no skill prose to edit. Precedent: prior rounds dispositioned claude-api-skill content entries the same way.

---

## 63 — PORT: `/sandbox` options read "Sandbox commands" instead of "Sandbox BashTool"

**Official evidence (binary):**

- v300 option-builder dd @257304200: `L=A?[{label:"Sandbox commands, with auto-allow",value:"auto-allow"}]:[]` … `{label:A?"Sandbox commands, with regular permissions":"Sandbox commands",value:"regular"}` … `{label:"No Sandbox",value:"disabled"}`.
- Offsets: v300 `'Sandbox commands'` @112391320/112391364/112391416/257304381/257304495; `grep -c 'Sandbox BashTool'` v300 → 0. v299 inverse ("Sandbox BashTool" present, "Sandbox commands" absent).
- Note the official label is conditional: the "with regular permissions" suffix only when auto-allow is supported (`A`); plain `"Sandbox commands"` otherwise.

**OCC evidence:**

- `src/components/sandbox/SandboxSettings.tsx:62/:74/:86` — labels `"Sandbox BashTool, with auto-allow"` / `"Sandbox BashTool, with regular permissions"` / `"No Sandbox"` (v299 wording).

**Sketch:**

1. `SandboxSettings.tsx:62` → `"Sandbox commands, with auto-allow"`; :74 → mirror the official conditional: `"Sandbox commands, with regular permissions"` when the auto-allow arm is available, else `"Sandbox commands"` (OCC currently renders the suffix unconditionally — check whether OCC has the `A`-equivalent auto-allow-support flag in this component; if not, keep the suffixed form since OCC always shows the auto-allow row). :86 `"No Sandbox"` unchanged.
2. Sweep `grep -rn 'Sandbox BashTool' src/ test/` for any other copy (help text, tests asserting the old label) and update in the same change.
3. Test idea: update/add the SandboxSettings snapshot or label assertion to expect "Sandbox commands…"; `grep -c 'Sandbox BashTool' src/` → 0 as a lint-style check.

---

## 67–78 — N-A: VSCode extension entries (shared proof)

**Shared OCC-surface-absence proof (verified once):** OCC ships no VSCode extension.

- No `extensions/` (or any `*.vsix`, extension-manifest) directory in the repo; `package.json` has no `contributes`, `activationEvents`, or `engines.vscode` keys — it is the `@cnwenf/occ` CLI package.
- `grep -rn 'vscode' src/` hits are CLI-side only (e.g. `src/utils/vscodeSdkMcp.ts:44` — an Anthropic-internal gate), not extension code.

Each entry below is N-A by this shared proof; the fix lives entirely in the official extension's TypeScript source, which OCC does not ship.

## 67 — N-A: [VSCode] `claudeCode.attachSelection` setting
Shared VSCode proof above — setting belongs to the extension's `contributes.configuration`; OCC has no extension manifest.

## 68 — N-A: [VSCode] fast mode staying on after usage credits ran out
Shared VSCode proof above — extension-side fast-mode toggle/notice; no OCC extension surface.

## 69 — N-A: [VSCode] Thinking toggle switching to Off on always-thinking models
Shared VSCode proof above — extension webview toggle; no OCC extension surface.

## 70 — N-A: [VSCode] "Edit prompt" on a flagged message opening the file/command menu
Shared VSCode proof above — extension prompt-restore behavior; no OCC extension surface.

## 71 — N-A: [VSCode] Shift+drag file insert `/c:/…` path on Windows
Shared VSCode proof above — extension drag-and-drop path handling; no OCC extension surface.

## 72 — N-A: [VSCode] chat font size settings needing reload / undone by theme change
Shared VSCode proof above — extension font-size wiring; no OCC extension surface.

## 73 — N-A: [VSCode] "Resume session"/restored tabs opening empty conversation after worktree move
Shared VSCode proof above — extension session-restore; no OCC extension surface. (OCC's worktree subsystem is CLI-side and unaffected by an extension tab-restore bug.)

## 74 — N-A: [VSCode] ↑+Enter on recalled slash command running without arguments
Shared VSCode proof above — extension recalled-prompt menu behavior; no OCC extension surface.

## 75 — N-A: [VSCode] Shift+drag file insert nothing in WSL/SSH/Dev Container
Shared VSCode proof above — extension remote-window drag handling; no OCC extension surface.

## 76 — N-A: [VSCode] Ctrl+Alt+F toggling Focus view instead of Find
Shared VSCode proof above — extension keybinding registration; no OCC extension surface.

## 77 — N-A: [VSCode] extra processes from `ps` PATH search on macOS session check
Shared VSCode proof above — extension process-spawn behavior; no OCC extension surface.

## 78 — N-A: [VSCode] Windows "still open somewhere else" after crash/power loss (reused PID)
Shared VSCode proof above — extension Windows lockfile/PID logic; no OCC extension surface.
