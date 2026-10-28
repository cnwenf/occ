# Upstream Gap Triage — Claude Code 2.1.310 → 2.1.311, changelog items 20–42 (Track T2)

Forensics: read-only string/byte-offset analysis of the official Bun-compiled ELF binaries
`/tmp/cc-diff-311/v310/package/claude` (2.1.310) and `/tmp/cc-diff-311/v311/package/claude` (2.1.311).
Method: `grep -aboF "LITERAL"` → byte offset → `dd`/python-seek window; v310↔v311 comparison; OCC `src/`
surface check. JS embedded region is >238M offsets; <230M is the Bun string table (UTF-16/null garbage
possible — `tr -d '\0'` applied where noted). Byte offsets below are decimal file offsets.

Verdicts:
- **PORT** — OCC has the surface AND official behavior differs; byte-verifiable work package below.
- **STAGED** — surface exists but the mechanism is ambiguous or depends on an unported subsystem.
- **N-A** — surface absent by design in OCC (or already aligned); nothing to port.

## Summary table

| # | Changelog (abridged) | Verdict | One-line reason |
|---|---|---|---|
| 20 | Remote Control / cloud attachment disk-full cause not told to Claude; >20 attachments dropped | **N-A** | No Remote Control / cloud-session surface in OCC |
| 21 | WebFetch/WebSearch hang in Cowork cloud; now fail after 300s | **N-A** | Cowork-cloud only; OCC already aligned (`WEBFETCH_DEADLINE_MS_DEFAULT=300_000`) |
| 22 | Background session crashed between turns not restarted while attached/pinned/scheduled | **N-A** | No official bg-session daemon in OCC (own daemon supervisor, different model) |
| 23 | "background service did not respond" error suggested disabled `daemon restart`; now `daemon stop --any` + "ends background sessions" | **N-A** | OCC has no `…did not respond — it may be stalled` surface; own daemon already says `stop --any` (`daemon.ts:232`) |
| 24 | `claude respawn <id>` started bg service before reporting no match | **N-A** | OCC has no `respawn` CLI verb |
| 25 | `/effort` not warning about prompt-cache miss in plan mode when plan model ≠ session model | **STAGED** | `promptCacheLedger`/`PROMPT_CACHE_MISS_CAUSES` never ported; not byte-pinnable |
| 26 | `/ide` said VS Code extension installed before install finished / when it failed | **PORT** | OCC `ide.tsx:476-485` ≡ v310 fire-and-forget success claim; v311 awaits result |
| 27 | Write tool file preview skipping rows / miscounting hidden lines when a line is wider than the terminal | **STAGED** | OCC Write preview = `FileWriteToolDiff` (diff, no wrap/hidden); OCC `PreviewBox` slices wide lines (no wrap) → specific bug absent. Root-cause wrap-util fix (Z/Te) is a separable general improvement to `src/ink/wrapAnsi.ts` |
| 28 | ↑ in an agent's chat tab recalled a still-pending message → resend sent a second copy | **N-A** | No agent chat tabs (agent-teams absent) |
| 29 | Cowork cloud sessions lost connectors/tools after restart when a plugin/settings named an `agent` | **N-A** | No Cowork cloud sessions |
| 30 | Agent-teams sessions showed empty task list on `--resume`/`--continue`/`/resume`/`--session-id`; `/branch` wrote to original list | **N-A** | No agent-teams task-list surface |
| 31 | Pasting text mentioning an image file (`! open /tmp/shot.png`) attached the image and dropped its path from the prompt | **PORT** | OCC `usePasteHandler.ts:215-223` ≡ v310 flatten-split bug; v311 per-line validation |
| 32 | Feedback draft card showed its 1/2/0 + Esc shortcuts while the prompt has text | **N-A** | Claude-drafted feedback card never ported (0 hits for `drafted:`, `Send without reviewing`, `more queued`); OCC survey is a different, unchanged card |
| 33 | A lone backslash in quotes/brackets (`"\"`, `(\)`) disappeared from Claude's responses | **PORT** | v311-new `wrappedBackslash` marked inline extension; absent in OCC markdown |
| 34 | Agent teammates compacted their history when `DISABLE_COMPACT` is set | **N-A** | No agent-teams |
| 35 | Rewind menu offered "Summarize from here"/"up to here" when `DISABLE_COMPACT` is set | **PORT** | OCC `REPL.tsx:5355` always passes `onSummarize`; v311 gates it on `DISABLE_COMPACT` |
| 36 | Finished `/code-review` (or sub-agent skill) ran a second time when a cloud/bg session restarts | **N-A** | OCC `/code-review` is own impl; no cloud/bg-session restart replay |
| 37 | Long hidden thinking cut off as idle on Vertex/Foundry/Bedrock (endpoint sends thinking-progress updates) | **N-A** | Already aligned: OCC resets stream-idle timer on every SSE part incl. thinking progress; official fix is logic-only, not byte-pinnable |
| 38 | `/ide` said it installed the JetBrains plugin when nothing was installed | **PORT** | Same `/ide` install-flow rework as #26; OCC `ide.tsx:461-485` claims success without awaiting |
| 39 | Claude Pro/Max subscribers told to "ask their admin" when their subscription can't be used; now points to billing | **PORT** | v311 plan-type branch (`pro`/`max` → billing msg); OCC `errors.ts:255` returns OCC-unique text with no plan branch |
| 40 | Diff pane opened by itself after an edit in wide fullscreen when it had nothing to show | **N-A** | No docked fullscreen diff pane in OCC (`diffPanelVisible`/`replTab` = 0 hits); OCC uses `DiffDialog` overlay; official selectors unchanged v310↔v311 |
| 41 | `/mcp` showed a remote server as failed after "Clear authentication" when the server works without sign-in | **PORT** | v311 clear-auth handler adds validation + reconnect; OCC `MCPRemoteServerMenu.tsx:344` sets type `'failed'` |
| 42 | `/mcp` showed "authenticated" for a remote server Claude Code sends no credentials to | **PORT** | v311 three-state auth row (`not signed in`); OCC `MCPSettings.tsx:78-84` ≡ v310 two-state |

**PORT set: 26, 31, 33, 35, 38, 39, 41, 42.** STAGED: 25, 27. N-A: 20, 21, 22, 23, 24, 28, 29, 30, 32, 34, 36, 37, 40.

---

## Per-item evidence

### Item 20 — Remote Control / cloud attachment disk-full cause · N-A
"Fixed Claude not being told the cause when a file attached to a message sent over Remote Control or to a
cloud session could not be saved because the disk was full, or that a message's attachments past the first
20 were left out." Probe `disk was full` → 0 hits in both binaries (message is dynamic / not a stable
literal). The surface is the Remote Control + cloud-session attachment save path, which OCC does not ship
(no Remote Control, no cloud sessions). **N-A** — surface absent by design.

### Item 21 — WebFetch/WebSearch Cowork-cloud 300s stall timeout · N-A
"Fixed WebFetch and WebSearch hanging on a stalled response in Cowork cloud sessions; an unfinished request
now fails after 300 seconds." This is the Cowork-cloud-session transport, absent in OCC. OCC's own WebFetch
already carries a 300s deadline (`WEBFETCH_DEADLINE_MS_DEFAULT=300_000`, WebFetchTool) — the general
behavior the changelog describes for cloud sessions is already OCC's default. **N-A** — cloud-session-only
surface; OCC already aligned on the local deadline.

### Item 22 — Background session crash-restart while attached/pinned/scheduled · N-A
"Fixed a background session that crashed between turns not being restarted while it was attached, pinned, or
had a scheduled task or wake-up set." Depends on the official background-session daemon + scheduler +
attach/pin state machine. OCC has its own daemon supervisor (`src/daemon/*`) with a different lifecycle
model and no attach/pin/scheduled-wake restart semantics. **N-A** — the official bg-session subsystem is
not ported.

### Item 23 — "background service did not respond" message · N-A
Official v311 refactor extracts `lun()` (v311@248202606 region):
```js
function Fg(){return o2e()?"daemon":"background service"}
function j_t(e){return r2e()?` \u2014 run 'claude daemon ${e}'`:""}
function lun(){let e=`${Fg()} did not respond \u2014 it may be stalled`;
  if(!r2e())return e;
  return o2e()?`${e}${j_t("restart")}`:`${e}${j_t("stop --any")} (ends background sessions)`}
```
`(ends background sessions)` is v311-only (0 hits v310, 2 hits v311 @123943541/@248202707). In v310 the
message was inline and always suggested `restart` (v310@254144639: `` `${Qp()} did not respond \u2014 it may
be stalled${dTe("restart")}` ``). The fix routes the non-daemon (`o2e()` false) case to `stop --any (ends
background sessions)` instead of the disabled `restart`.
OCC surface: `grep "did not respond"` in `src/` finds only the unrelated PreToolUse-hook timeout
(`src/utils/hooks.ts:213`) — OCC has no `…did not respond — it may be stalled` background-service message.
OCC's own daemon already suggests `stop --any` (`src/cli/handlers/daemon.ts:232`: `` `Run \`occ daemon stop
--any\` to stop any background sessions and report on the holder` ``, added in the CC 2.1.300 #43 port).
**N-A** — the official message surface is absent; OCC's own daemon text already carries the `stop --any`
suggestion.

### Item 24 — `claude respawn <id>` ordering · N-A
v311@238605950: `else if(d[0]==="respawn")await l.respawnHandler(d[1],a)`. OCC has no `respawn` CLI verb
(`grep -rn respawn src` → none in the CLI command table). **N-A** — surface absent.

### Item 25 — `/effort` plan-mode prompt-cache-miss warning · STAGED
"Fixed `/effort` not warning about a prompt cache miss in plan mode when the plan model differs from the
session model." This depends on the prompt-cache-miss ledger (`promptCacheLedger` /
`PROMPT_CACHE_MISS_CAUSES`) and the plan-model-vs-session-model comparison. OCC never ported the cache-miss
ledger; probes for `plan model`/`planModel` return none, and the `/effort` cache-miss warning surface is
absent. The mechanism is not byte-pinnable in the diff (no new stable literal isolates the plan-mode branch).
**STAGED** — depends on the unported `promptCacheLedger` subsystem; needs a dedicated decompilation of the
`/effort` warning path before it can be ported faithfully. Not guessed per `aligning-with-official-binary`.

### Item 26 & 38 — `/ide` install-status rework (VS Code + JetBrains) · PORT
Item 26: "`/ide` saying the VS Code extension was installed before the install finished or when it failed."
Item 38: "`/ide` saying it had installed the JetBrains plugin when nothing was installed." Same root cause:
the v310 install handler fired the install and immediately claimed success without awaiting the result.

**OCC surface (≡ v310 exactly)** — `src/commands/ide/ide.tsx:476-485`:
```
476: if (detectedIDEs.length === 0 && context.onInstallIDEExtension && !isSupportedTerminal()) {
480:   context.onInstallIDEExtension(ide);
483:   onDone(`Installed plugin to ${chalk.bold(toIDEDisplayName(ide))}\n` +
             `Please ${chalk.bold('restart your IDE')} completely for it to take effect`);
485:   onDone(`Installed extension to ${chalk.bold(toIDEDisplayName(ide))}`);
```
Plus `:380` dialog title `"Select IDE to install extension"` (≡ v310), `:131` no-IDEs message, `:461-482`
JetBrains branch. Plumbing: `src/types/command.ts:115`
`onInstallIDEExtension?: (ide: IdeType) => void`; `src/screens/REPL.tsx:783` `useState<IdeType|null>`,
`:2700` `onInstallIDEExtension: setIDEToInstallExtension`;
`src/hooks/useIDEIntegration.tsx:54` `initializeIdeIntegration(addIde, ideToInstallExtension, …, status =>
setIDEInstallationState(status))`.

**Official evidence** — v310 handler `lt` (@282858000-282862500):
`h=(D)=>{if(o.onInstallIDEExtension)if(o.onInstallIDEExtension(D),Oke(D))p(\`Installed plugin to …\`);else
p(\`Installed extension to …\`)}` (fire-and-forget; success claimed synchronously). Dialogs
`Ue`("Select IDE to install extension") / `Qe`(single-IDE auto). Literals `Installed plugin to` /
`Installed extension to`: **2 in v310, 0 in v311** (removed).

v311 (@284841600-284845800): dialog title becomes `"Select IDE to set up Claude Code"`; the VS Code install
component `We` **awaits** `c(o)` → result `D`:
```js
D?.installed → i(D.previouslyInstalled
    ? `The Claude Code extension is installed in ${d}. Reload the ${t} window (Developer: Reload Window), then run /ide again.`
    : `Installed the Claude Code extension in ${d}.`)
D?.error     → i(`Couldn't install the Claude Code extension in ${d}:\n${D.error}\n${E}`)
else         → v = MNr() ?? (Rt() ? "this session's workspace is remote" : null);
               i(`Didn't install the Claude Code extension in ${d}${v ? ` because ${v}` : ""}.\n${E}`)
E = `To install it yourself, see ${Jln}`;  Jln = "https://code.claude.com/docs/en/vs-code#install-the-extension"
```
Pending UI: message `Installing the Claude Code extension in ${t}\u2026`, `escAction:"stop waiting"`,
`onCancel → i(\`Still installing the Claude Code extension in ${t}. /status shows the result when it
finishes.\`, {display:"system"})`, unmount guard `h=!0→!1`.
JetBrains branch `gn`:
```js
if(mye(p)){ c(p); let h=Iw(p);
  i(`Couldn't find the Claude Code plugin running in ${he.bold(h)}. ${he.bold(`restart ${h}`)} completely and run /ide again.`);
  return }
```
`o.length===1` → `je` auto-install effect, else `Fe` dialog. Reason function `MNr()` (@251640870):
```js
if(i.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL) return "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set";
if(!(ue().autoInstallIdeExtension ?? !0)) return "the autoInstallIdeExtension setting is off";
return null
```
Orchestrator `bDo`: catch → `{installed:!1, error:w.message||"Installation failed", installedVersion:null,
ideType:S}`; install fn `kSr`; capability check `cEe`; refresh `RNr`.
All five v311 literals (`Installed the Claude Code extension in`, `Couldn't install the Claude Code
extension`, `Couldn't find the Claude Code plugin running`, `Still installing the Claude Code extension`,
`Installing the Claude Code extension in`) = **0 in v310, 2 each in v311**. `Didn't install the Claude Code
extension` v311-only (@129942456/@284843121).

**Action (PORT 26 + 38 together — one work package).** Rework the `/ide` install flow in
`src/commands/ide/ide.tsx` (and the `onInstallIDEExtension` plumbing in `src/types/command.ts` /
`src/screens/REPL.tsx` / `src/hooks/useIDEIntegration.tsx`) to await an install result object
`{installed, previouslyInstalled?, error?}` instead of claiming success synchronously:
1. Change the `onInstallIDEExtension` callback contract to return a promise of the result object (or thread
   an async installer through `useIDEIntegration`).
2. Emit a pending state (`Installing the Claude Code extension in ${ide}…`, `escAction:"stop waiting"`); on
   cancel emit `Still installing the Claude Code extension in ${ide}. /status shows the result when it
   finishes.` as a `system` message; guard unmount so the late result is dropped.
3. On result: `installed && previouslyInstalled` → `The Claude Code extension is installed in ${ide}. Reload
   the ${ide} window (Developer: Reload Window), then run /ide again.`; `installed` (fresh) → `Installed the
   Claude Code extension in ${ide}.`; `error` → `Couldn't install the Claude Code extension in
   ${ide}:\n${error}\nTo install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension`;
   `!installed && !error` → `Didn't install the Claude Code extension in ${ide}${reason ? ` because ${reason}`
   : ""}.\n<same To-install-it-yourself line>`, where `reason` comes from an OCC `MNr()` equivalent
   (`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set` / `the autoInstallIdeExtension setting is off`) falling back to
   `this session's workspace is remote` when the workspace is remote.
4. JetBrains: replace the unconditional "Installed plugin to …" claim with the not-running check →
   `Couldn't find the Claude Code plugin running in ${bold(displayName)}. ${bold(`restart ${displayName}`)}
   completely and run /ide again.`
5. Update the dialog title `Select IDE to install extension` → `Select IDE to set up Claude Code`.
6. Remove the now-dead `Installed plugin to` / `Installed extension to` success strings.
Use byte-verbatim strings from v311 above. `Jln = "https://code.claude.com/docs/en/vs-code#install-the-extension"`.

### Item 27 — Write tool preview wrap / hidden-line miscount · STAGED
"Fixed the Write tool's file preview skipping rows and miscounting hidden lines when a line is wider than the
terminal."

**Official fix is in the wrap util, not the preview component.** The preview component is identical
v310↔v311 (`exe`@273974895 ≡ `jxe`@275623690): it wraps wide lines
`oo=(uo)=>le(uo)>yt?vu(uo,yt,{hard:!0,trim:!1}).split("\n"):uo` and counts hidden lines `pn=io.length-Ve`,
label `✂ N lines hidden`. v311 routes all three `Bun.wrapAnsi` returns through a new postprocess `Z`
(v311@240029591) that hard-splits any line still wider than the width after wrapping:
```js
function Z(e,t,n,s){ if(!s?.hard||n<1)return e; let r=e.split("\n");
  if(r.every((c)=>le(c)<=n)||!me())return e;
  let u=t.split(Fe),a=[];
  for(let c of u){ let o=!0; for(let i of U6t(c)) if(i.type==="sequence"?!Ee.test(i.value):QRt(i.value)){o=!1;break} a.push(o) }
  if(!a.includes(!0))return e;
  if(a.includes(!1))return u.map((c)=>j(c,n,s)).join("\n");
  let l=[]; for(let c of r){ if(le(c)<=n){l.push(c);continue} Te(c,n,!1,l) } return l.join("\n") }
function Te(e,t,n,s){ /* grapheme-aware hard splitter: walks U6t tokens, Fa().segment graphemes,
  pushes wrapped fragments; recurses Te(r,t,!0,s) when a fragment still exceeds t */ }
```
Gate `me()` (v311@240023743): `t=n("tengu_frolicking_nest",!0); return e.wrapFitEnabled=t.value!==!1`
(default on). `le`=display width, `U6t`=ansi tokenizer, `Fa().segment`=grapheme segmenter, `Fe=/\r\n?|\n/`.
String dumps: s310 line 129869 / s311 line 134666.

**OCC surface.** OCC's Write tool preview is `src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx`
(88 lines) — a diff view with **no** wrap/hidden-count logic. The `✂ N lines hidden` box exists only in
`src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx` (the AskUserQuestion preview),
which **slices** wide lines rather than wrapping:
`const displayLine = lineWidth > innerWidth ? sliceAnsi(line_0, 0, innerWidth) : line_0;` (:166) and
`hiddenCount = contentLines.length - effectiveMaxLines` (:147) — internally consistent (slicing adds no
extra display lines), so the official miscount does not arise. OCC's wrap layer is
`src/ink/wrapAnsi.ts` (`wrapAnsi = Bun.wrapAnsi ?? npm wrap-ansi`), used with `{hard:true}` by
`src/ink/wrap-text.ts` → `src/ink/render-node-to-output.ts`; no `tengu_frolicking_nest` / `wrapFitEnabled`
gate exists in OCC.

**Verdict STAGED.** The changelog's specific surface (Write-preview wrap miscount) does not manifest in OCC
— the Write preview is a diff, and the preview box slices instead of wraps. The official root-cause fix
(Z/Te grapheme-aware hard-splitter for `Bun.wrapAnsi` hard mode) is a *general* improvement to OCC's ink
wrap layer, not the Write-preview surface. Porting Z/Te into `src/ink/wrapAnsi.ts` (apply after
`Bun.wrapAnsi` when `options.hard`) is a legitimate follow-up, but it is separable from this changelog item,
OCC's dual `Bun ?? npm` wrap path and absent statsig gate make the exact gating ambiguous, and it must not be
guessed. Left STAGED pending a dedicated wrap-layer port + behavioral test.

### Item 28 — Agent chat tab ↑ recalls pending message · N-A
"Fixed ↑ in an agent's chat tab recalling a message that was still waiting to be delivered, so resending it
sent a second copy." Agent chat tabs are part of the agent-teams surface, absent in OCC. **N-A.**

### Item 29 — Cowork cloud connectors lost after restart with an `agent` setting · N-A
Cowork-cloud-session only. OCC has no Cowork cloud sessions. **N-A.**

### Item 30 — Agent-teams empty task list on resume; `/branch` wrote to original list · N-A
Agent-teams task-list + `/branch` session semantics; not ported to OCC. **N-A.**

### Item 31 — Pasting text mentioning an image file · PORT
"Fixed pasting text that mentions an image file, such as `! open /tmp/shot.png` or `/review look at
/tmp/shot.png`, attaching the image and dropping its path from the prompt."

**Root cause** (v310 `Llt`@~257938500): the paste handler split on `/ (?=\/|[A-Za-z]:\\)/` (any space
followed by a path root), flat-mapped newlines, and treated every fragment matching `isImageFilePath` as an
attachment — so a command line *mentioning* an image path had that path extracted and removed from the prompt
text:
```js
let ae=z.split(/ (?=\/|[A-Za-z]:\\)/).flatMap((B)=>B.split("\n")).filter((B)=>B.trim()),te=[],D=[];
for(let B of ae) if(_Cs(B)) te.push(B); else D.push(B);
// te = attached images, D.join("\n") = kept text  → path dropped from prompt
```

**v311 fix** (`Vct`@259374800-259379000): per-line validation — a line is only treated as image paths if
**every** whitespace-separated token is a path (quoted or path-rooted), otherwise the whole line is kept as
text:
```js
Rr=50,
Mr=/ (?=["']?(?:\/|[A-Za-z]:\\))/,                       // quote-aware path split
Wr=/^(?:\/(?!\/)[^ \r\\/]*(?:\\.[^ \r\\/]*)*\/|[A-Za-z]:\\|\\\\)[^\r]*$/,  // path-root token
Ir=/^(["'])(?:\/[^/\r]+\/|[A-Za-z]:\\|\\\\)[^\r]*\1$/,   // quoted path
Dr=/[^\\] /,                                             // unescaped space
Yt=/\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i; // macOS screencapture fallback

let q=[],ie=[];
for(let I of J.split("\n")){
  let V=I.split(Mr).filter((N)=>N.trim());
  if(V.length>1 && !V.every((N)=>{ let re=N.trim();
        return Ir.test(re) || (Wr.test(re) && (!Dr.test(re) || BEo(re))) })){
    ie.push(I); continue;                                // mixed line → keep as text
  }
  for(let N of V) if(BEo(N)) ie.push(q.length),q.push(N); else ie.push(N);
}
```
Reconstruction keeps non-image tokens inline and only strips successfully-read images:
`Te=ie.flatMap((ne)=> typeof ne==="string" ? [ne] : (N[ne]===null||N[ne]==="refused") && !(ke&&Yt.test(q[ne]??"")) ? [q[ne]??""] : []).join("\n")`;
then `if(Te)H(Te)` (resubmit remaining text) + attach each read image `pe` with `{mediaType, filename,
dimensions, sourcePath, continuesGesture:ne>0}`. The imagePaste helper chunk (`WLt`/`BEo`/`jEo`/`yDs`/`WEo`,
quote-strip `P`, backslash-normalize `x`, WSL `S`) is **identical v310↔v311** (pure renames) — the fix is
entirely in the paste-handler caller.

**OCC surface (≡ v310 bug)** — `src/hooks/usePasteHandler.ts:215-223`:
```
215: .split(/ (?=\/|[A-Za-z]:\\)/).flatMap(part => part.split('\n')).filter(line => line.trim())
     imagePaths = lines.filter(line => isImageFilePath(line))
225: (onImagePaste branch)
264-266: nonImageLines = lines.filter(line => !isImageFilePath(line))
275: allPastedImagePathsAbsolute
378-381: hasImageFilePath = input.split(...).flatMap(...).some(line => isImageFilePath(line.trim()))
396-402: shouldHandleAsPaste pre-check
```
OCC has its own chunk-batching architecture (`pastePendingRef`, `PASTE_THRESHOLD`) — the port must fit that.

**Action (PORT).** In `src/hooks/usePasteHandler.ts`, replace the flatten-split extraction (:215-223 and the
:378-381 pre-check) with per-line "all tokens must be paths" validation mirroring v311 `Vct`:
1. Add the regexes (byte-verbatim): `Mr=/ (?=["']?(?:\/|[A-Za-z]:\\))/`,
   `Wr=/^(?:\/(?!\/)[^ \r\\/]*(?:\\.[^ \r\\/]*)*\/|[A-Za-z]:\\|\\\\)[^\r]*$/`,
   `Ir=/^(["'])(?:\/[^/\r]+\/|[A-Za-z]:\\|\\\\)[^\r]*\1$/`, `Dr=/[^\\] /`,
   `Yt=/\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i`.
2. For each line: split on `Mr`; if >1 token and NOT every token is a quoted path (`Ir`) or a path-root token
   (`Wr`) that either has no unescaped space (`!Dr`) or is itself an image path (`isImageFilePath`), keep the
   **whole line as text** (do not extract).
3. Only extract image paths from lines that pass the all-tokens-are-paths rule; keep a mixed
   string/index reconstruction so non-extracted text is resubmitted verbatim and only successfully-read
   images are stripped.
4. Preserve OCC's `pastePendingRef`/`PASTE_THRESHOLD` chunking and the `screencaptureui` (`Yt`) fallback.
The macOS `screencaptureui` fallback and `continuesGesture` semantics follow v311.

### Item 32 — Feedback draft card 1/2/0 + Esc shortcuts while prompt has text · N-A
"Fixed the feedback draft card showing its 1/2/0 and Esc shortcuts while the prompt has text, when those keys
act on the prompt instead of the card."
v311 gates the chord hints on `Co=Ge===""||(wt==="error"?/^[01]$/:/^[012]$/).test(Ge.normalize("NFKC"))`
(Ge = prompt text); when the prompt has non-digit text, hints are replaced with `clear text to review, send,
or dismiss` / `clear text to answer it` / `clear text to open review or to dismiss` (v311@275337600-275340100).
**OCC never ported the Claude-drafted feedback card** — 0 hits for `drafted:`, `Send without reviewing`,
`more queued`, `Turn off Claude-drafted`. OCC's `src/components/Feedback.tsx` is the `/feedback` GitHub-issue
dialog; `src/components/FeedbackSurvey/FeedbackSurveyView.tsx` is the separate session survey
(`1: Bad`/`2: Fine`/`3: Good`/`0: Dismiss`). The official survey card is **unchanged** v310↔v311 (verified:
v310 `uL`@273692800 ≡ v311 `PL`@275340485 — same `iet/Z6/aet/e4/det=10/t4` structure and strings,
rename-only). The v311 fix touched only the draft card. **N-A** — the affected surface (draft card) is absent;
the survey OCC does have is unchanged upstream.

### Item 33 — Lone backslash in quotes/brackets disappears · PORT
"Fixed a lone backslash in quotes or brackets, like `"\"` or `(\)`, disappearing from Claude's responses."

**Official v311-new marked inline extension** `wrappedBackslash` (@254743052; region 254741800-254744400;
absent in v310):
```js
Kt={'"':'"',"'":"'",")":"(","]":"[","}":"{",">":"<"}   // closer → required opener
Qt=/^\\.[\p{L}\p{N}\\*_`~]/u
qt=/[\p{L}\p{N}].$/u
Xt={extensions:[{name:"wrappedBackslash",level:"inline",tokenizer(e,t){
  let n=e[1];
  if(e[0]!=="\\"||n===void 0||this.lexer.state.inLink)return;
  let r=Kt[n],s=t.at(-1);
  if(r===void 0||s?.type!=="text"||!s.raw.endsWith(r)||qt.test(s.raw)||Qt.test(e))return;
  let o=t.at(-2);
  if(s.raw===r&&o!==void 0&&o.type!=="br"&&!(o.type==="escape"&&o.text===o.raw))return;
  let l=`\\${n}`; return {type:"escape",raw:l,text:l}
}}]};
function hOt(){ if(Be.configured)return; Be.set(), uh.use(ze,Xt) }   // registers the extension
```
v310 counterpart @253396300 is `function $xt(){ if($e.configured)return; $e.set(), eh.use(ze) }` — **no `Xt`**
extension. The escape serializer is unchanged (`case"escape":return e.text`; v310@253404740 ≡
v311@254750222), so emitting `{type:"escape", text:"\\"+closer}` renders the backslash+closer literally
instead of letting marked drop the lone backslash.

**OCC surface.** `src/utils/markdown.ts:51-123` `configureMarked()` registers marked **without** any escape /
wrappedBackslash override; `:556-558` `case 'escape': return token.text`; `src/components/Markdown.tsx:100-122`;
`src/utils/markdownWindowed.ts`. `grep 'wrappedBackslash' src` → 0. Empirically OCC reproduces the bug:
`"C:\"` renders `"C:"`, `(\)` renders `()`.

**Action (PORT).** In `src/utils/markdown.ts`, add the `wrappedBackslash` inline tokenizer extension to the
`marked.use(...)` configuration (the `configureMarked`/`hOt` equivalent), byte-verbatim from v311:
- `Kt={'"':'"',"'":"'",")":"(","]":"[","}":"{",">":"<"}`, `Qt=/^\\.[\p{L}\p{N}\\*_`~]/u`,
  `qt=/[\p{L}\p{N}].$/u`.
- Extension `{name:"wrappedBackslash", level:"inline", tokenizer(src, tokens)}` with the exact guard chain
  above (returns `{type:"escape", raw:`\\${closer}`, text:`\\${closer}`}` when a lone backslash precedes a
  closer whose matching opener is the previous text token's last char, not word-adjacent, not in a link).
- The existing `case 'escape': return token.text` serializer then renders it correctly. Verify against both
  the plain (`markdown.ts`) and windowed (`markdownWindowed.ts`) render paths, and against
  `Markdown.tsx`. Add an e2e asserting `"\"` and `(\)` survive round-trip (official behavior).

### Item 34 — Agent teammates compact when DISABLE_COMPACT set · N-A
Agent-teams teammate compaction; no agent-teams in OCC. **N-A.**

### Item 35 — Rewind menu offers Summarize when DISABLE_COMPACT set · PORT
"Fixed the rewind menu offering 'Summarize from here' and 'Summarize up to here' when `DISABLE_COMPACT` is
set."

**Official fix** — the MessageSelector component is unchanged; both summarize options are gated on the
`onSummarize` prop (`if(Z) zr.push({value:"summarize",…}), zr.push({value:"summarize_up_to",…})`;
v310 `UUe`@273140600 ≡ v311 `aWe`@274776200, destructure `onSummarize:Z/J`). The fix is at the **pass-through
site**:
- v310@~273155312: `onSummarize: x.runsNoModelTurn ? void 0 : x.handleSummarize`
- v311@~274792948: `onSummarize: x.runsNoModelTurn || Le(process.env.DISABLE_COMPACT) ? void 0 : x.handleSummarize`
`Le` is the official env-truthy parser (`bool()`). So when `DISABLE_COMPACT` is truthy, `onSummarize` is
`undefined` → the menu omits both summarize options.

**OCC surface.** `src/screens/REPL.tsx:5355` passes `onSummarize={async (message, feedback?, direction='from')
=> {…}}` **unconditionally** (no DISABLE_COMPACT gate). `src/components/MessageSelector.tsx:37` declares
`onSummarize` as a **required** (non-optional) prop and pushes the `summarize` option unconditionally
(`getRestoreOptions`, `:120-135`); `summarize_up_to` is gated behind `("external" as string) === 'ant'`
(always false in OCC's build). OCC uses `isEnvTruthy(process.env.DISABLE_COMPACT)` elsewhere
(`src/services/compact/autoCompact.ts:184,216,328`; `src/commands/compact/index.ts:8`) — the OCC equivalent
of `Le(...)`. OCC has no `runsNoModelTurn` concept (`grep runsNoModelTurn src` → 0).

**Action (PORT).**
1. `src/components/MessageSelector.tsx`: make `onSummarize` optional
   (`onSummarize?: (…) => Promise<void>`) and gate both summarize options on its presence — mirror the
   official `if(onSummarize) { push "summarize"; push "summarize_up_to" }`. (OCC's `summarize_up_to`
   `ant`-only gate is a pre-existing OCC divergence; the official exposes both options whenever `onSummarize`
   is provided — aligning means both appear when compaction is enabled. Confirm against product intent; the
   byte-verifiable official behavior is "both gated on `onSummarize` presence".)
2. `src/screens/REPL.tsx:5355`: pass `onSummarize={isEnvTruthy(process.env.DISABLE_COMPACT) ? undefined :
   async (…) => {…}}` (import `isEnvTruthy`). `runsNoModelTurn` has no OCC analogue — OCC's turn/controller
   model differs — so only the `DISABLE_COMPACT` half of the guard is portable; document that.
Result: when `DISABLE_COMPACT` is set, the rewind menu no longer offers "Summarize from here"/"up to here",
matching official v311.

### Item 36 — Finished `/code-review` re-runs on cloud/bg session restart · N-A
"Fixed a finished `/code-review`, or another skill that runs in a sub-agent, running a second time when a
cloud or background session restarts." Depends on cloud/bg-session restart + skill-run dedup state. OCC's
`/code-review` is an own implementation and there is no cloud/bg-session restart replay. **N-A.**

### Item 37 — Long hidden thinking cut off as idle (Vertex/Foundry/Bedrock) · N-A (already aligned)
"Fixed long hidden thinking being cut off as idle on Google Vertex AI, Microsoft Foundry and Claude Platform
on AWS, where the endpoint sends thinking progress updates."
The official stream-idle watchdog is **identical v310↔v311** (event tier v310@249548000 ≡ v311@251159600:
`Streaming idle warning: no chunks received for ${X}s` / `Streaming idle timeout: no chunks received for
${X}s, aborting stream` / `tengu_streaming_idle_timeout`, tier:"event"; byte tier v311@251190957 with
`idleMs,bytesReceived,ttfbMs,bodyReadPending,sleptMs,cfRay`, tier:"byte"). The thinking-progress pipeline is
unchanged (7 hits each version). The v311-new machinery near the watchdog is unrelated: `armStallTimer`
(@276552309) = SDK stream-json output-stall telemetry (`tengu_sdk_stall`); the new `idleMs` cluster
(@276921991-276924023) = Remote Control keepalive (`ccr_keepalive_post_turn_wait`, `qb=30000`); the delta-fold
generator `Fsn` (`tengu_toasty_giraffe`, default false, `api_stream_delta_merge`, `Wlr=8192`) excludes
estimated_tokens-only thinking deltas from folding — entirely absent from v310. The item-37 fix itself is a
logic-only change (treating thinking-progress updates as stream activity) that is **not byte-pinnable**.
**OCC already aligned**: `src/services/api/claude.ts:~3624-3650` calls `resetStreamIdleTimer()` and then
`for await (const part of stream) { resetStreamIdleTimer(); … }` — every SSE part (including thinking-progress
updates) resets the idle timer, so progress updates already prevent an idle abort. Plus
`STALL_THRESHOLD_MS=30_000` `tengu_streaming_stall` logging. **N-A** — OCC's watchdog already counts
progress updates as activity; no portable diff.

### Item 39 — Pro/Max subscribers told to "ask admin" · PORT
"Fixed Claude Pro and Max subscribers being told to ask their admin when their subscription can't be used; the
message now points to billing settings."

**Official v311** adds a plan-type branch. New billing message (@248212940):
```js
var qUr="Claude Code can't use your Claude subscription, usually because a payment is past due \xB7 Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead";
```
Org-disabled message (@~250027510) + chooser:
```js
var B2o="Your organization has disabled Claude subscription access for Claude Code \xB7 Use an Anthropic API key instead, or ask your admin to enable access";
function j2o(){ let e=cr(); if(e==="pro"||e==="max") return qUr; return B2o }   // cr() = plan-type getter
```
Usage (@250049767): `if($9t(e)) return Ws({error:"oauth_org_not_allowed", content:j2o()})`.
v311 classifier (@248215221):
```js
case"oauth_org_not_allowed": return n===qUr
  ? {state:"blocked", needs:"can't use subscription \u2014 pay or renew, or use API key"}
  : {state:"blocked", needs:"org disabled OAuth \u2014 use API key or ask admin"}
```
**v310** (@248245240/@248245562): only `var v9o=<B2o org-disabled text>; function R9o(){return v9o}` — no
plan branch; usage @248267820 `content:R9o()`. So v310 always returned the org-disabled/"ask your admin"
text regardless of plan; v311 returns the billing text for `pro`/`max`.

**OCC surface.** `src/services/api/errors.ts:255` `getOauthOrgNotAllowedErrorMessage()` returns OCC-unique
texts — interactive: `"Your account does not have access to Claude Code. Please run /login."`;
non-interactive: `"Your organization does not have access to Claude. Please login again or contact your
administrator."` (neither literal appears in v310 or v311; official has **no** non-interactive branch). Used
at `errors.ts:1085` (401/403 `'OAuth authentication is currently not allowed for this organization'` arm);
classifier `errors.ts:1414` → `'oauth_org_not_allowed'`. Plan getter: `getSubscriptionType()` in
`src/utils/auth.ts` (~2374-2445) — the OCC equivalent of official `cr()`. The official's `needs:`
classifier-suggestion surface is absent in OCC (that sub-part is N-A).

**Action (PORT).** In `src/services/api/errors.ts`, rework `getOauthOrgNotAllowedErrorMessage()` to branch on
plan type via `getSubscriptionType()`:
- `pro`/`max` → the billing message (byte-verbatim from v311 `qUr`):
  `Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at
  https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key
  instead` (the `·` is `\xB7`).
- otherwise → the org-disabled message (byte-verbatim from v311 `B2o`):
  `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key
  instead, or ask your admin to enable access`.
Replace the current OCC-unique strings with the official literals; drop or re-justify the non-interactive
branch (official has none — if OCC keeps it for headless UX, document it as an OCC divergence, but the
subscription-facing text must match official). Wire `getSubscriptionType()` from `src/utils/auth.ts`. The
`needs:`-style classifier suggestion is out of scope (surface absent). Add an e2e: a `pro`/`max` account
hitting `oauth_org_not_allowed` sees the billing message, not "ask your admin".

### Item 40 — Diff pane opens by itself after an edit in wide fullscreen · N-A
"Fixed the diff pane opening by itself after an edit in wide fullscreen terminals when it had nothing to
show." Official selectors are **identical v310↔v311** (`diffPane` 10/10, `panelFileView` 14/14,
`replTab:"diff"` 1/1, `diffPanelVisible` 10/10; selector pairs `CKo`/`_Ko` ≡ `o2o`/`n2o`:
`return zi.diffPanelVisible?zi:{…zi,diffPanelVisible:!0}` / `…:!1`; earlier DIFF flags were dd-window
misalignment artifacts, confirmed rename-only on visual inspection). OCC has **zero** hits for
`diffPanelVisible`/`replTab` — the docked fullscreen diff panel was never ported. OCC's diff surface is
`src/components/diff/DiffDialog.tsx` (overlay dialog, `ViewMode 'list'|'detail'`, `useDiffData`/`useTurnDiffs`,
`useRegisterOverlay`); `src/components/FullscreenLayout.tsx` (671 lines) has no docked diff pane. **N-A** —
surface absent; and the official change is not a pinnable selector diff anyway.

### Item 41 — `/mcp` shows remote server failed after "Clear authentication" · PORT
"Fixed `/mcp` showing a remote server as failed after 'Clear authentication' when the server works without
sign-in."

**Official v310** clear-auth handler (`Kt`@~281713204): revokeServerTokens → telemetry → dropDiscoveryEntry →
clearServerCache → store update `{…Ft, type:"failed"}` → `Authentication cleared for ${co(i.name)}.` — it
**leaves the server in `failed` state** even when the server works unauthenticated.

**Official v311** clear-auth handler (`hn`@~283694821) adds: a re-entrancy guard (`yt.current`/`Se(!0)` +
finally); scope-extra config `de=q8.has(i.scope)?zG(i.name):null`; a **validation** step, and a **reconnect**:
```js
if(!await phr(i.name,[{...i.config,scope:i.scope}, i.client.config, ...de?[de]:[]])){
  A(`Authentication for ${co(i.name)} was not cleared: sign-in data is still stored, or the credential store could not be read. Try Clear authentication again.`);
  return;
}
// if prior type wasn't failed/disabled and not policy-blocked:
let It=await Be(i.name,{discardDiscovery:!1, revokeTokens:!0}),
    {message:kn}=vct(It,i.name,{persistsOffBox:Zr(Y)},{hasHeadersHelper:Un});
A(`${He} ${kn}`)
// catch: A(`${He} ${t8e(It,i.name,{config:i.config,persistsOffBox:Zr(Y)})}`)
```
Reconnect fn (@~276082972): `revokeTokens` waits in-flight
(`while(Sn.revokeTokens&&Dn&&Dn.epoch===Fr())await Dn.attempt.catch(()=>{})…`), `keepConfig` option, new throw:
`Claude Code did not reconnect to ${co(Co)}: sign-in data for the config in your settings is still stored, or
the credential store could not be read. Restart Claude Code and use Clear authentication again.` (reason
`MCP clear-auth reconnect: credential store not cleared`). Message helpers `vct`@282067535 (connected →
`Reconnected to X.`; needs-auth → `X requires authentication. Use the 'Authenticate' option.`; failed →
`Failed to reconnect to X…`) and `t8e`@282068929 (`Error reconnecting to X: …`) ≡ v310 `Ext` (pre-existing).
v311-only strings: `did not reconnect to`(2), `sign-in data for the config`(2), `revokeTokens`(3) — all 0 in
v310.

**OCC surface.** `src/components/mcp/MCPRemoteServerMenu.tsx:328-365` `handleClearAuth` → sets type `'failed'`
(:344), ≡ v310; menu options at `:522-539`.

**Action (PORT).** In `src/components/mcp/MCPRemoteServerMenu.tsx` `handleClearAuth` (:328-365), mirror v311
`hn`:
1. Add a re-entrancy guard (a `useRef` in-flight flag + `finally` reset).
2. After revoking/clearing, **validate** that sign-in data is actually gone (an OCC `phr` equivalent checking
   the stored config/client/scope-extra); if not cleared, emit
   `Authentication for ${name} was not cleared: sign-in data is still stored, or the credential store could
   not be read. Try Clear authentication again.` and return **without** marking failed.
3. If the server's prior type wasn't `failed`/`disabled` and isn't policy-blocked, **reconnect**
   (`{discardDiscovery:false, revokeTokens:true}`) and derive the result message via the OCC equivalents of
   `vct`/`t8e`: connected → `Reconnected to ${name}.`; needs-auth → `${name} requires authentication. Use the
   'Authenticate' option.`; failed → `Failed to reconnect to ${name}…`; error → `Error reconnecting to ${name}:
   …`. Prefix with the `Authentication cleared for ${name}.` (`He`) text.
4. Only leave the server in `failed` state when the reconnect genuinely fails — so a server that works
   without sign-in shows connected, not failed.
Use the reconnect/credential-store helpers in `src/services/mcp/auth.ts` / `src/services/mcp/client.ts`. Add
the v311-only literals verbatim where the OCC equivalents are missing (e.g. the `did not reconnect to …`
throw). e2e: clear auth on an unauthenticated remote server → it shows connected, not failed.

### Item 42 — `/mcp` shows "authenticated" for a credential-less remote server · PORT
"Fixed `/mcp` showing 'authenticated' for a remote server that Claude Code sends no credentials to."

**Official v310** auth row (@281719014): `gn ? <success/>+"authenticated" : <error/>+"not authenticated"`
(two-state), with `gn=i.isAuthenticated||wi(i.client)&&h>0` (`wi`=has-oauth-token, `h`=tool count). This shows
"authenticated" whenever tools are connected, even with no credentials sent.

**Official v311** auth row (@283701813) is **three-state**:
```js
_n ? <success/>+"authenticated"
   : Mn ? <dimColor/>+"not signed in"
        : <error/>+"not authenticated"
```
Derivations (v311@~283688400 / ~283699800):
```js
gn = i.isAuthenticated ?? (U!==null && Xr(U))            // Xr = oauth-token check
Fn = (sse||http) && G0(config)
cn = (sse||http) && Zot(config, D || (H!==null && Xr(H)))
Un = type!=="claudeai-proxy" && !!config.headersHelper
Mn = Li(i.client) && h>0                                 // Li = connectable-no-cred
_n = gn || (Mn && i.config.type!=="claudeai-proxy" && (mee(i.config) || cn ||
       (Spe(i.name,{...i.config,scope:i.scope}) && vd()!==null)))
Rn = disabled || ko || pV
```
Helpers (@242617944):
```js
function mee(e){ if(nW()&&e.oauth?.xaa)return!0; if(e.headersHelper||e.headers&&Object.keys(e.headers).length>0)return!0;
                 if(oF(e.url)&&Un())return!0; return!1 }
function Zot(e,n){ return G0(e)||_d(e)||(oF(e.url)&&Un()&&n) }
```
So v311 distinguishes "authenticated" (real credentials), "not signed in" (connectable but no credentials —
the new middle state), and "not authenticated" (error).

**OCC surface.** `src/components/mcp/MCPSettings.tsx:78-84`
`isAuthenticated = Boolean(tokens) || hasSessionAuth || hasToolsAndConnected` — the `hasToolsAndConnected`
disjunct is exactly the v310 bug (shows authenticated when tools connect without credentials).
`src/components/mcp/MCPRemoteServerMenu.tsx:100-103` `isEffectivelyAuthenticated`; auth/status rows at
`:566-587`; helpers in `src/services/mcp/auth.ts` / `src/services/mcp/client.ts`.

**Action (PORT).**
1. `src/components/mcp/MCPSettings.tsx:78-84`: remove the `hasToolsAndConnected` disjunct from
   `isAuthenticated` — authentication must reflect actual credentials (stored OAuth token / session auth /
   headers-helper / config credentials), not mere tool connectivity. Add an OCC `mee`-equivalent
   (headersHelper or non-empty headers, or the `oauth.xaa`/proxy cases) and a `Zot`-equivalent
   (credential-in-config check) so a server that genuinely sends credentials is still "authenticated".
2. `src/components/mcp/MCPRemoteServerMenu.tsx:566-587`: render the auth row **three-state** to match v311 —
   `authenticated` (success icon) when credentials exist; `not signed in` (dimColor, no error icon) when the
   server is connectable but OCC sends no credentials (`Mn`/`Li` equivalent: connectable, tool count > 0, no
   creds); `not authenticated` (error icon) otherwise. Derive the middle-state predicate mirroring `_n`/`Mn`
   (excluding `claudeai-proxy`).
3. Update `isEffectivelyAuthenticated` (`:100-103`) to the credential-based definition.
Add the `not signed in` literal (dimColor). e2e: a remote server that connects and lists tools but receives no
credentials shows "not signed in" (dimColor), not "authenticated".

---

## Notes on method / confidence

- **Byte-pinned PORTs** (exact v310↔v311 literal + offset deltas): 26, 31, 33, 35, 38, 39, 41, 42. Each
  work package quotes the official v311 literals and the OCC source site to change.
- **Not byte-pinnable** (logic-only or dynamic-message changes with no stable new literal isolating the fix):
  20, 25, 37 — recorded as such; 25 STAGED (unported subsystem), 37 N-A (already aligned), 20 N-A (surface
  absent).
- **STAGED**: 25 (prompt-cache ledger absent), 27 (Write-preview surface diverges — OCC diffs/slices, does not
  wrap; the wrap-util Z/Te improvement is a separable general port).
- Structural context diffs used short-identifier normalization
  (`sed 's/[A-Za-z0-9_$]\{1,3\}/X/g'`) to separate pure renames from functional change; fixed-width dd windows
  were re-verified visually where version offsets drifted (items 37, 40 earlier DIFF flags were
  window-misalignment artifacts — both confirmed rename-only / identical).
