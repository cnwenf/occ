# Triage T2 — 2.1.310 items 7–12

Round: official claude-code 2.1.309 → 2.1.310. Evidence discipline per
`aligning-with-official-binary` skill: every official claim below carries
`grep -caboF` hit counts against BOTH binaries plus `dd`-extracted verbatim
excerpts. BIN310 = `/tmp/cc-diff-310/bin310/package/claude`,
BIN309 = `/tmp/cc-diff-310/bin309/package/claude`. Neither binary was executed.

## Verdict tally

| # | Changelog (short) | Verdict |
|---|-------------------|---------|
| 7 | Windows hooks let tool call through when Git Bash missing + quoted-strings-only command | **STAGED** — depends on unported default-hook-shell→PowerShell fallback routing |
| 8 | Auto mode prompt before first read outside working dirs mentions shell-command asks | **STAGED** — `auto_mode_outside_reads` dialog absent from OCC (staged since OCC-107/108) |
| 9 | Memory use of non-interactive sessions during compaction with very large transcript | **STAGED** — mechanism not byte-pinnable (zero distinguishing string deltas) |
| 10 | Mod `Image` draws inside tmux with `allow-passthrough` + `focus-events` | **N-A** — no mods engine and no terminal-image rendering in OCC |
| 11 | Linux `/sandbox` + startup warning name Ubuntu AppArmor userns restriction | **PORT** — OCC sandbox surface exists, AppArmor probe absent, mechanism fully pinned |
| 11 note | | |
| 12 | MCP tool-call timeout error while elicitation unanswered (non-interactive) | **PORT** — OCC MCP client + elicitation handler exist, `openQuestions`/`mcp_question_unanswered` absent, mechanism fully pinned |

**PORT 2 · STAGED 3 · N-A 1**

---

## Item 7 — Windows: PreToolUse/PermissionRequest hooks letting a tool call through when Git Bash is missing and the hook command is only quoted strings

**Changelog (verbatim):** "Windows: Fixed PreToolUse and PermissionRequest hooks letting a tool call through when Git Bash is missing and the hook's command is only quoted strings, such as a quoted path"

**Verdict: STAGED** — the fix lives entirely inside the official's
"default hook shell falls back to PowerShell when Git Bash is missing"
routing, which OCC has not ported (OCC hard-exits instead). Mechanism fully
byte-pinned below for when the routing lands.

### OCC surface

- `src/utils/hooks.ts:1850` — `const shellType = hook.shell ?? DEFAULT_HOOK_SHELL`
- `src/utils/shell/shellProvider.ts:3` — `export const DEFAULT_HOOK_SHELL: ShellType = 'bash'` (a **constant**; no dynamic PowerShell fallback)
- `src/utils/hooks.ts:2077-2083` — bash spawn branch: `const shell = isWindows ? findGitBashPath() : true`
- `src/utils/windowsPaths.ts:98-120` — `findGitBashPath()` **hard-exits** (`process.exit(1)`) when Git Bash is not found; `src/entrypoints/init.ts:185` calls `setShellIfWindows()` at startup, so a Git-Bash-less Windows machine never reaches hook execution at all
- `src/utils/shell/powershellProvider.ts:52-53` — OCC already ports the 2.1.309 #32 exit-code-2 wrapper (`POWERSHELL_HOOK_EXIT_WRAPPER`), and `:101-110` `buildHookPowerShellCommand()` mirrors the official 309 ternary `hookEvent === "PermissionRequest" || startsWithPowerShellDeclaration(cmd) ? cmd : cmd + wrapper`
- `grep -rn "blocking because Git Bash" src/` → **0 hits**; `grep -rn "noBash\|only exit code 0 or 2" src/` → **0 hits** — the official's no-Git-Bash hook messaging is absent from OCC

### Current OCC behavior

On Windows, every default-shell (bash) hook goes through `findGitBashPath()`,
which `process.exit(1)`s the whole CLI when Git Bash is missing. The
official's bug scenario — default hooks silently rerouted to PowerShell,
where a command like `"C:\path\to\hook.exe"` is a bare string expression
that *prints the path and exits 0*, so PreToolUse/PermissionRequest read the
exit-0-no-JSON result as "allow" — **cannot occur in OCC**: the process dies
at startup instead, and OCC's PS wrapper path is only reachable for hooks
with explicit `"shell": "powershell"` (which the official fix explicitly
excludes via `e.shell===void 0`). So OCC is immune to the bug today but
diverges from the official (official keeps running without Git Bash).
`src/utils/hooks.ts:2028-2033` already records this as "Relaxing that is
phase 1 of the design's implementation order (separate PR)" (the referenced
`docs/design/ps-shell-selection.md` is not in the tree — `find docs -name '*ps-shell*'` → 0).

### Official evidence

Default-shell routing (already in BIN309 — the routing is NOT new in 310):

```
grep -caboF '"bash":"powershell"' → s309: 4, s310: 4
```

BIN309 @~126.3M region (dd-extracted):

```js
hd())return"powershell";if(e==="powershell"&&!Gv())return"bash";return e??(hd()?"bash":"powershell")
```

BIN310 (dd @250335417 region — `JG` is the 310 minified name):

```js
function JG(){return vd()?"bash":"powershell"}   // default hook shell: powershell when Git Bash absent
```

**New in 310** — the no-verdict wrapper. `grep -caboF 'claudeNoVerdict'`:
BIN310 = 8 hits (@124393530, 124394591, 124394664, 124394702 + 4 in the
second copy region), **BIN309 = 0 hits** (`grep -c claudeNoVerdict s309.txt` → 0).

Hook-spawn PS branch, BIN310 dd @250334200+3600 (verbatim; `x1e` = 309's
`IWe` = OCC's `startsWithPowerShellDeclaration`, `IGe=127`, `Jn` = final
command, `n` = hookEvent, `e` = hook config, `Sme` = predicate below):

```js
let ts=!x1e(Jn),
Hs=n==="PermissionRequest"||!ts?Jn:Jn+`
; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }`,
Zs=ts&&e.shell===void 0&&n!=="StatusLine"&&n!=="FileSuggestion"&&Sme(e,n)?Hs+`
; if (-not $?) { exit 1 }
; $claudeNoVerdict = $false
; try { $claudeSeen = $false; $claudeOnlyStrings = $true; foreach ($claudeStatement in $MyInvocation.MyCommand.ScriptBlock.Ast.EndBlock.Statements) { if ($claudeStatement.Extent.StartOffset -lt `+Jn.length+`) { $claudeSeen = $true; $claudeElements = 0; foreach ($claudeElement in $claudeStatement.PipelineElements) { $claudeElements++; if ($claudeElement.PSTypeNames -notcontains 'System.Management.Automation.Language.CommandExpressionAst') { $claudeOnlyStrings = $false } elseif ($claudeElement.Expression.PSTypeNames -contains 'System.Management.Automation.Language.ExpandableStringExpressionAst') { foreach ($claudeNested in $claudeElement.Expression.NestedExpressions) { if ($claudeNested.PSTypeNames -contains 'System.Management.Automation.Language.SubExpressionAst') { $claudeOnlyStrings = $false } } } elseif ($claudeElement.Expression.PSTypeNames -notcontains 'System.Management.Automation.Language.StringConstantExpressionAst') { $claudeOnlyStrings = $false } }; if ($claudeElements -ne 1) { $claudeOnlyStrings = $false } } }; $claudeNoVerdict = $claudeSeen -and $claudeOnlyStrings } catch { }
; if ($claudeNoVerdict) { exit `+IGe+` }
; $claudeNoVerdict = $false`:Hs;
xr=Hxe(dr,_Wn(Zs),{env:ro,cwd:Tr,detached:Oo,windowsHide:!0,...Wht(n)})
```

309's same branch (dd @252636600+2200) has only the `Hs` arm — no `Zs`, no
AST check:

```js
let vs=n==="PermissionRequest"||IWe(to)?to:to+`
; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }`;
ys=Txe($r,$1n(vs),{...})
```

Supporting definitions (s310, verbatim):

```js
var IGe=127;
function Sme(e,n){return e.type==="command"&&e.async!==!0&&e.asyncRewake!==!0&&e.args===void 0&&e.onFailure!=="continue"&&JG()==="powershell"&&W0(n)}
dq=new Set(["PreToolUse","PermissionRequest"]);
function W0(e){return dq.has(e)&&a8()}    // a8() = payload/settings gate, defaults true
```

The 127 exit is then converted into a **blocking** hook answer (s310, dd-verified
via `grep -oE` around `ZWt`/`oLo`; `ZWt` classifies the failure source as
`"noBash"` when `Sme(e,n)`; new-in-310 message — `grep -c 'blocking because Git Bash'` s309=2, s310=3):

```
blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict. The hook ended with exit code 127. If its command is only quoted strings, PowerShell started no program. To run a program, install Git for Windows (https://git-scm.com/downloads/win) and start a new session, or put the program in "command" and its arguments in "args" ("args": [] if it has none) and set "onFailure" to "block" so that failures still block. To print this text, such as a JSON answer, set "shell" to "powershell". The user needs to do this; Claude should not change the hook.
```

(`E1e="Git for Windows (https://git-scm.com/downloads/win)"`, `N0=`Install ${E1e}` — s310 verbatim.)

Also new in the same wrapper family: the fragment `` `; if (-not $?) { exit 1 }` ``
(first NoVerdict fragment) — 0 hits in BIN309's hook path.

### Action (STAGED)

**Record, do not port now.** What's missing in OCC (unblock preconditions):

1. Default-hook-shell routing: OCC needs the official's `JG()`-equivalent
   (`DEFAULT_HOOK_SHELL` becomes `isGitBashFound() ? "bash" : "powershell"` on
   Windows) plus removal/relaxation of the `findGitBashPath()` hard-exit —
   tracked as "phase 1 … (separate PR)" in `src/utils/hooks.ts:2028-2033`.
2. The no-Git-Bash blocking-answer machinery: `Sme`/`ZWt`("noBash")/`oLo`
   message pair (both the pre-existing 309 message and the new 127 variant
   above), wired into the onFailure→blocking conversion (`src/utils/hooks/onFailureBlock.ts`).
3. When (1)+(2) land, extend `buildHookPowerShellCommand()` in
   `src/utils/shell/powershellProvider.ts` with the verbatim `Zs` arm shown
   above (condition `ts && hook.shell===undefined && hookEvent!=="StatusLine"
   && hookEvent!=="FileSuggestion" && Sme(hook,hookEvent)`, appending after the
   existing 309 wrapper), with `exit 127` and the AST block byte-verbatim
   (including the leading `\n` of each fragment, `Jn.length` = the final
   command's `.length`, and the trailing `$claudeNoVerdict = $false` reset).

---

## Item 8 — Auto mode's prompt before the first read outside the working directories

**Changelog (verbatim):** "Improved auto mode's prompt before the first read outside the working directories: it now says when blocking those reads makes shell commands ask for permission"

**Verdict: STAGED** — the prompt belongs to the official's
`auto_mode_outside_reads` confirmation dialog, which OCC has never ported
(the underlying `permissions.blockReadsOutsideWorkingDirectories` setting is
itself absent from OCC's settings schema). New official text recorded below.

### OCC surface

- `grep -rn "Auto mode and the sandbox read outside|Sandboxed commands are not changed|Sandboxed commands lose your home" src/` → **0 hits**
- `grep -rn "auto_mode_outside_reads" src/` → **0 hits** (only `outsideReadsBlocked` telemetry classification exists: `src/hooks/toolPermission/safetyEvent.ts:254,489,527,586`)
- `grep -rn "blockReadsOutsideWorkingDirectories" src/schemas/ src/utils/settings/` → **0 hits** — the setting is not in OCC's settings schema; the 8 files mentioning it are comments/tests + the deny-message constant
- `src/utils/permissions/readDeny.ts:33-36` (verbatim): "Official `sy` (isReadBlocked) additionally ORs `restricted === true` and `blockReadsOutsideWorkingDirectories === true`; **neither surface exists in OCC (grep-proven N-A, staged since OCC-107/108)**"
- `src/hooks/toolPermission/safetyEvent.ts:320` — OCC carries only the deny-side message: `'Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.'`

### Current OCC behavior

No pre-read confirmation dialog exists. Since the setting can't be set
through OCC's schema and no dialog writes it, the "first read outside the
working directories" prompt never fires in OCC; enforcement-side strings
exist only for classification parity.

### Official evidence

`grep -caboF` (BIN310 vs BIN309):

| literal | 310 | 309 |
|---|---|---|
| `Auto mode asks before each shell command` | **2** | 0 |
| `The sandbox doesn't enforce it on this machine` | **2** | 0 |
| `Sandboxed commands are not changed on this machine` | 0 | **2** |
| `auto_mode_outside_reads` | 3 | 3 |

Dialog builder, BIN310 dd @128668800+3000 (string-table copy; the s310 code
copy shows the same ternary), verbatim:

```
Auto mode and the sandbox read outside the working directories without asking. Yes or No answers for this read; the rest is for later reads. Block: the file tools refuse reads outside the working directories in every project. "+(e?"Sandboxed commands lose your home directory (SSH keys, home-installed tools) until you re-open paths with sandbox.filesystem.allowRead.":"The sandbox doesn't enforce it on this machine (off, filesystem rules relaxed, managed read-path lock on, or working directory name has glob characters). Auto mode asks before each shell command it can't check.")+" To undo, remove permissions.blockReadsOutsideWorkingDirectories from your user settings; file tools follow next session, sandboxed commands at once.
```

BIN309 dd @122637500+3000 — the same explainer with the OLD second-branch text:

```
Sandboxed commands are not changed on this machine (the sandbox is off, its filesystem rules are relaxed, a managed read-path lock is on, or the working directory name has glob characters).
```

So the 310 change is exactly: non-sandbox-fenced branch reworded to
"The sandbox doesn't enforce it on this machine (off, filesystem rules
relaxed, managed read-path lock on, or working directory name has glob
characters). **Auto mode asks before each shell command it can't check.**" —
the added sentence is the "says when blocking those reads makes shell
commands ask for permission" of the changelog. The dialog kind is
`{kind:"auto_mode_outside_reads", payload:{toolName,path,title,question,explainer,options}}`
(s310, verbatim tail of the same extraction).

### Action (STAGED)

Record the new official wording (above, byte-verbatim) against the existing
OCC-107/108 staging note in `src/utils/permissions/readDeny.ts`. Unblock
precondition: port of the `auto_mode_outside_reads` dialog + the
`permissions.blockReadsOutsideWorkingDirectories` setting surface (schema,
`sy`/isReadBlocked predicate arm, undo path). When ported, the explainer MUST
use the 310 text, not the 309 text.

---

## Item 9 — Memory use of non-interactive sessions during compaction with a very large transcript

**Changelog (verbatim):** "Improved memory use of non-interactive sessions (`-p`, Agent SDK) during compaction when the transcript file is very large"

**Verdict: STAGED** — internal memory optimization with **no distinguishing
string delta**; the mechanism is not byte-pinnable from the evidence available
(strings/counts). Per skill discipline: record, don't guess.

### OCC surface

- Print-mode loop: `src/cli/print.ts` (compaction operates on the in-memory
  `mutableMessages`; see comment at `print.ts:1799` "Guard against
  mutableMessages shrinking (compaction truncates it)")
- Compaction services: `src/services/compact/` (compact.ts, autoCompact.ts,
  sessionMemoryCompact.ts, microCompact.ts, snipCompact.ts, …)
- Transcript reads are whole-file: `src/utils/log.ts:250` —
  `const content = await readFile(fullPath, { encoding: 'utf8' })` inside
  `loadLogList`; same whole-file pattern in `src/history.ts:391`
- Transcript loading for resume: `src/utils/sessionStorage.ts`,
  `src/utils/sessionRestore.ts`, `src/utils/conversationRecovery.ts`

### Current OCC behavior

Wherever OCC touches a transcript file it reads it whole
(`readFile(…, 'utf8')` + full JSON parse), holding the entire file string and
the parsed array in memory simultaneously. If the official fix was to stream
or chunk this read during print-mode compaction, OCC has the same
whole-file characteristic — but this is an inference about OCC, not a claim
about the official mechanism.

### Official evidence (absence of markers)

`grep -caboF` BIN310 vs BIN309 — every probe equal (no new/removed literal
identifiable with compaction-transcript reading):

| literal | 310 | 309 |
|---|---|---|
| `createReadStream` | 35 | 35 |
| `readline` | 99 | 99 |
| `loadTranscript` | 23 | 23 |
| `readTranscript` | 20 | 20 |
| `compactTranscriptUnavailable` | 8 | 8 |
| `transcript is too large` | 6 | 6 |
| `tailFile` | 2 | 2 |
| `precomputed compact` | 37 | 37 |
| `compaction` | 451 | 450 (±1, no readable delta found) |

`new_strings.txt` / `new_readable.txt` scans for transcript+compaction code
lines surfaced only unrelated neighbors (SDK status plumbing, deep-research
workflow script). The npm tarballs (`v309/`, `v310/`) contain only the
wrapper (`cli-wrapper.cjs`, `install.cjs`) — no diffable `cli.js`. The change
is therefore inside minified code with no new string literals: not
byte-pinnable without a full code-region diff/disassembly of the compaction
chunks, which is out of scope for string-evidence triage.

### Action (STAGED)

Record: "2.1.310 #9 — official reduced memory of `-p`/SDK compaction when the
transcript file is very large; mechanism unknown (no string delta)."
Unblock precondition: a code-level diff of the print-mode compaction path
between BIN309 and BIN310 (chunk-scoped disassembly or a future release that
surfaces a marker), or an official repo commit reference. Do NOT invent a
streaming rewrite of `src/utils/log.ts` / compact services in the meantime —
if OCC later ports it, match the recovered mechanism exactly.

---

## Item 10 — Mod `Image` inside tmux (allow-passthrough + focus-events, kitty/Ghostty/iTerm2 3.5+)

**Changelog (verbatim):** "Improved a mod's `Image` to draw inside tmux with `allow-passthrough` and `focus-events` on, in kitty, Ghostty, and iTerm2 3.5+ with fullscreen rendering, where it showed only its `alt` text"

**Verdict: N-A** — the mods subsystem and all terminal-image rendering are
absent from OCC (consistent with prior rounds: `docs/gap-research-293/triage-293.md`
items 3/21/22, `docs/gap-research-300/triage-T1.md` #3, `docs/gap-research-301/triage-T3.md` —
all "N-A: mods subsystem absent").

### OCC surface (absence proof)

- `grep -rn "\"mods\"|'mods'|mods/" src/ --include=*.ts --include=*.tsx` (non-test) → **0 hits**; every `mods` hit in `src/` is keyboard-modifier code (`src/ink/parse-keypress.ts:800-828`, `src/utils/computerUse/executor.ts:152`) or a ghostty *keybinding* config string (`src/commands/terminalSetup/terminalSetup.tsx:424` `mods = "Shift"`)
- `grep -rn "modRegistry|<Mod|ModImage|customMod|mod's Image" src/` → **0 hits**
- `grep -rn "sixel|kitty graphics|inline image" src/ -il` → **0 hits** — OCC renders no terminal images at all (no kitty graphics protocol, no sixel, no iTerm2 inline-images)
- `grep -rln "allow-passthrough" src/` → **0 hits**; the only `passthrough` hits are PowerShell permission-rule plumbing (`src/tools/PowerShellTool/*`), unrelated to tmux

### Current OCC behavior

Nothing to change: no mod can register an `Image` component because there is
no mods engine, and no rendering path exists that could emit image escape
sequences (or fall back to `alt` text).

### Official evidence (for the record)

`grep -caboF 'allow-passthrough'`: BIN310 = **14**, BIN309 = **0** — the tmux
image-passthrough machinery is new in 310. Offsets (310): 117809743,
117809799, 117810212, 117810479, 117810770, 117811430, 123493774 + second
copy region. `focus-events`: 310 = 21, 309 = 9.

dd @117809300+2600 (BIN310, verbatim excerpt of the new diagnostics):

```
images inside tmux need tmux 3.3 or later with allow-passthrough and focus-events on: run `tmux set -g allow-passthrough on` and `tmux set -g focus-events on`, detach and attach tmux again, then restart Claude Code
…
tmux does not know which terminal is outside it, so Claude Code draws no images here: attach tmux from kitty 0.28 or later, Ghostty, or iTerm2 3.5 or later, run `tmux set -g allow-passthrough on` and `tmux set -g focus-events on`, detach and attach again, then restart Claude Code
…
TMUX_PANE is not set (as in a tmux popup), so Claude Code cannot ask tmux about this pane; run Claude Code in a tmux pane to draw images
…
#{client_termtype} … #{allow-passthrough} … #{focus-events} … #{pane_top} …
```

(the `#{…}` set is a tmux `display-message -p` format query — the detection
mechanism). The prior-round baseline "Improved a mod's `Image` to draw its
picture in iTerm2 3.5 and later with fullscreen rendering, where it showed
only its `alt` text" is embedded in BIN310's changelog strings, confirming
the mod `Image` + `alt`-text fallback predates 310 and is a mods-engine feature.

### Action (N-A)

Immunity argument: the fix modifies (a) the mods engine's `Image` component
renderer and (b) a new tmux passthrough-detection layer that only serves
image drawing. OCC ships neither surface (0-hit greps above; precedent
triages 293/300/301). No action. If OCC ever ports the mods engine or
terminal-image rendering, this item's tmux detection strings (above) are the
starting evidence.

---

## Item 11 — Linux: `/sandbox` + startup warning naming Ubuntu's AppArmor user-namespace restriction

**Changelog (verbatim):** "Linux: Improved `/sandbox` and the sandbox startup warning to name Ubuntu's AppArmor restriction on user namespaces, and how to lift it, when it keeps bubblewrap from starting the sandbox"

**Verdict: PORT** — OCC has the full sandbox surface (`/sandbox` UI,
`checkDependencies`, startup warning via `getSandboxUnavailableReason`),
zero AppArmor handling, and the official mechanism is fully byte-pinned.

### OCC surface

- `src/utils/sandbox/sandbox-adapter.ts:1395-1401` — `const checkDependencies = memoize((): SandboxDependencyCheck => { … BaseSandboxManager.checkDependencies({command: rgPath, args: rgArgs}) })` — a thin pass-through to `@anthropic-ai/sandbox-runtime`'s `SandboxManager`; **no post-processing, no AppArmor probe**
- `src/utils/sandbox/sandbox-adapter.ts:1506-1535` — `getSandboxUnavailableReason()` (the sandbox startup warning source); its dependency-error branch: ``return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')} · ${hint}` ``
- Warning consumers: `src/cli/print.ts:731` and `src/screens/REPL.tsx:2520` (`SandboxManager.getSandboxUnavailableReason()`)
- `/sandbox` UI: `src/components/sandbox/SandboxDependenciesTab.tsx`, `src/components/sandbox/SandboxDoctorSection.tsx:18-27` (renders `depCheck.errors`/`warnings`), `src/commands/sandbox-toggle/`
- `grep -rn "apparmor" src/ -i` → **0 hits** (only `allowNestedUserNamespaces305` settings test + a comment at `sandbox-adapter.ts:451` about nested userns settings — no AppArmor detection)

### Current OCC behavior

On Ubuntu 23.10+/24.04 with `kernel.apparmor_restrict_unprivileged_userns=1`,
bubblewrap fails with `setting up uid map: Permission denied`. OCC's
`checkDependencies()` returns whatever sandbox-runtime reports (which does
not name AppArmor), and the startup warning says only "dependencies are
missing: … install missing tools (e.g. apt install bubblewrap socat) or run
/sandbox for details" — never mentioning the actual cause or the sysctl fix.

### Official evidence

`grep -caboF` (BIN310 vs BIN309):

| literal | 310 | 309 |
|---|---|---|
| `AppArmor` | **6** (@123274849, 123274945, 123275150 + second-copy @244329834, 244330011, 244330224) | **0** |
| `apparmor_restrict_unprivileged_userns` | **6** | 0 |
| `bubblewrap trial` | **2** | 0 |
| `setting up uid map: Permission denied` | **2** | 0 |
| `Failed RTM_NEWADDR` | **2** | 0 |

Probe + message builder, BIN310 dd @244327500+4500 (verbatim, complete):

```js
var Nue="/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    l$=/setting up uid map: Permission denied|Failed RTM_NEWADDR/,
    u$=["--unshare-user","--unshare-net","--dev-bind","/","/","/bin/true"],
    kue=2000;
function d$(e){try{
  if(e.readRestrictionSwitch()?.trim()!=="1")return;
  let n=e.resolveBubblewrap();if(n===null)return;
  let r=e.tryBubblewrap(n);if(!r.ran||r.exitCode===0)return;
  t(`[sandbox] kernel.apparmor_restrict_unprivileged_userns=1 and the bubblewrap trial (${n} ${u$.join(" ")}) exited ${r.exitCode}: ${r.stderr.trim()}`,{level:"warn"});
  let s=rd(r.stderr);if(!l$.test(s))return;
  return `Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here ("${s.split(`\n`).map((y)=>y.trim().replace(/^bwrap: /,"")).find((y)=>l$.test(y))?.slice(0,80)}"). Add bubblewrap's AppArmor profile from https://code.claude.com/docs/en/sandboxing, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` (holds until reboot), then restart Claude Code`
}catch(n){t(`[sandbox] the AppArmor user-namespace check could not be made: ${n}`,{level:"warn"});return}}
function f$(e){return{readRestrictionSwitch:Due,resolveBubblewrap:e,tryBubblewrap:Oue}}
function Due(){try{return Iue(Nue,"utf8")}catch{return}}   // readFileSync
function Oue(e){try{
  let n=Ist(e,u$,{cwd:"/",env:{PATH:"/usr/bin:/bin",USER_TYPE:"external",NODE_ENV:"production"},extendEnv:!1,stdio:["ignore","ignore","pipe"],reject:!1,timeout:kue});
  return{ran:!n.timedOut&&n.signal===void 0&&typeof n.exitCode==="number",exitCode:n.exitCode??null,stderr:n.stderr}
}catch{return{ran:!1,exitCode:null,stderr:""}}}
```

(`rd(e)` = ANSI/control-char sanitizer: `VE(Nb(e)).replace(/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,"")` — s310 verbatim; `Ist` = sandbox-runtime's sync-spawn helper.)

Call site — inside `checkDependencies` itself (BIN310 dd @244430031 region, verbatim):

```js
function Zde(){let e=FV();if(e)return e;
  let{rgPath:n,rgArgs:r}=mre(),s=tn.checkDependencies({command:n,args:r}),h=UV(s),y=O();
  if((y==="linux"||y==="wsl")&&h.errors.length===0&&!Ge().runtimeInitialized){
    let b=d$(f$(_Sn));if(b!==void 0)return{...h,errors:[b]}}
  return h}
…
checkDependenciesProbe=Qr(Zde)   // shared memoized probe on the sandbox-state singleton
```

Because both `/sandbox` and the startup warning read this one probe, the
AppArmor message reaches both surfaces — exactly the changelog claim.
`_Sn` (bubblewrap resolver, s310 verbatim): `function _Sn(){let e=Sor();if(e)return EB(e);return EB("bwrap")}`
(configured bwrap path if set, else resolve `"bwrap"` on PATH).

### Action (PORT)

Implement in `src/utils/sandbox/` (new small module, e.g.
`apparmorUsernsCheck.ts`) + wire into `src/utils/sandbox/sandbox-adapter.ts`:

1. Constants (byte-verbatim): switch path `"/proc/sys/kernel/apparmor_restrict_unprivileged_userns"`; stderr matcher `/setting up uid map: Permission denied|Failed RTM_NEWADDR/`; trial argv `["--unshare-user","--unshare-net","--dev-bind","/","/","/bin/true"]`; timeout `2000` ms.
2. `tryBubblewrap(bwrapPath)`: synchronous spawn (OCC equivalent of `Ist` — e.g. `execFileSync`/`spawnSync` wrapper) with `cwd:"/"`, `env:{PATH:"/usr/bin:/bin",USER_TYPE:"external",NODE_ENV:"production"}` (no inherit), stdio `["ignore","ignore","pipe"]`, 2000 ms timeout; return `{ran, exitCode, stderr}` exactly as `Oue` (ran = not timed out, no signal, numeric exitCode; catch → `{ran:false,exitCode:null,stderr:""}`).
3. `readRestrictionSwitch()`: `readFileSync(switchPath,"utf8")`, catch → `undefined`.
4. Probe (mirror `d$`): bail unless switch value trims to `"1"`; bail unless a bubblewrap path resolves (OCC needs a resolver equivalent to `_Sn` — configured bwrap path else `bwrap` on PATH); bail if trial didn't run or exited 0; log the warn-level debug line verbatim: `` `[sandbox] kernel.apparmor_restrict_unprivileged_userns=1 and the bubblewrap trial (${path} ${argv.join(" ")}) exited ${exitCode}: ${stderr.trim()}` ``; sanitize stderr (strip ANSI + `[\p{Cc}\p{Cf}\u2028\u2029]` except `\t\n`), bail unless the matcher hits; return the user-facing message verbatim: `` `Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here ("${firstMatchingLineTrimmed80}"). Add bubblewrap's AppArmor profile from https://code.claude.com/docs/en/sandboxing, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` (holds until reboot), then restart Claude Code` `` where the quoted part is the first stderr line matching the regex after `.trim().replace(/^bwrap: /,"")`, `.slice(0,80)`. Catch-all logs `` `[sandbox] the AppArmor user-namespace check could not be made: ${e}` `` (warn) and returns `undefined`.
5. Wire into OCC's `checkDependencies` (sandbox-adapter.ts:1395) mirroring `Zde`'s gate: only when platform is `linux` or `wsl`, base `errors.length === 0`, and the sandbox runtime is not yet initialized (map official `Ge().runtimeInitialized` to OCC's adapter init state around sandbox-adapter.ts:1784; if OCC exposes no equivalent, gate on the adapter's initialization flag — do not invent a new state). On a hit, return `{...base, errors: [message]}` (replace, per official — errors were empty; warnings preserved).
6. Both consumers (`/sandbox` tabs via `depCheck.errors`, startup warning via `getSandboxUnavailableReason`'s `deps.errors.join(', ')` branch) then carry the message with no further changes — matching the official single-probe design. Keep the memoization; official also re-seeds (`FV`) but that seeding logic is pre-310 and out of scope for this item.
7. Test: unit-test the probe with injected `{readRestrictionSwitch, resolveBubblewrap, tryBubblewrap}` (official's `f$` injection shape) covering: switch≠1 → undefined; no bwrap → undefined; exit 0 → undefined; non-matching stderr → undefined; matching stderr → exact message incl. 80-char line slice and `bwrap: ` prefix strip; throw → warn + undefined.

---

## Item 12 — MCP tool-call timeout error while the server's elicitation is unanswered (non-interactive)

**Changelog (verbatim):** "Changed the error for an MCP tool call that times out in a non-interactive session while the server's elicitation is unanswered: it now tells Claude that no answer came and not to repeat the call"

**Verdict: PORT** — OCC has the MCP client timeout path, the watchdog
concept, and the elicitation request handler; it lacks the `openQuestions`
counter and BOTH timeout-message arms (the 309-era `mcp_call_unanswered` arm
and the new 310 `mcp_question_unanswered` arm). Mechanism fully byte-pinned.

### OCC surface

- `src/services/mcp/client.ts:5031-5049` — timeout rejection (verbatim):
  ```ts
  reject(
    new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
      'MCP tool timeout',
    ),
  )
  ```
  — plain message; no in-flight-sends arm, no open-questions arm, no error code, no `mcpErrorSource`
- `src/services/mcp/client.ts:4996-5004` — watchdog creation `{armedAt: 0, offCriticalPath: false, toolUseId, ownSends: {started: 0, ranNothing: 0}}` added to `connectionState.activeCallWatchdogs`; removed at `:5235`
- `src/services/mcp/sendTracking.ts:60-65` — `interface ToolCallWatchdog { armedAt; offCriticalPath; toolUseId?; ownSends? }` — **no `openQuestions`, no `questionOpened`/`questionClosed`** (`grep -rn "questionOpened|questionClosed|openQuestions" src/` → 0 hits)
- `src/services/mcp/elicitationHandler.ts:92-195` — `registerElicitationHandler`'s `client.setRequestHandler(ElicitRequestSchema, …)`: runs elicitation hooks, queues to `appState.elicitation.queue`, awaits the user/hook response — **never touches the watchdog**
- `grep -rn "mcp_call_unanswered|The outcome is unknown|mcp_question_unanswered|no answer came" src/` → **0 hits**

### Current OCC behavior

An MCP tool call that times out always rejects with the plain
`MCP server "X" tool "Y" timed out after Ns` message regardless of whether
the server had an outstanding elicitation question or in-flight sends — so
in a non-interactive session where the server asked a question nobody will
ever answer, Claude gets no signal that the question went unanswered and may
repeat the call.

### Official evidence

`grep -caboF` (BIN310 vs BIN309):

| literal | 310 | 309 |
|---|---|---|
| `mcp_question_unanswered` | **2** | **0** |
| `openQuestions??0` | **2** (@275511322 elicitation handler, @278877668 timeout) | **0** |
| `openQuestions` (all) | **7** | 1 (unrelated deep-research workflow JSON schema) |
| `no answer came` | **4** | 2 (unrelated PR-posting string) |
| `mcp_call_unanswered` | 2 | 2 (pre-existing 309 baseline) |
| `questionOpened` / `question_open_ms` / `activeCallWatchdogs` | 3/2/25 | 3/2/25 (pre-existing) |

New message + code constants (BIN310 dd @243058480 region, verbatim):

```js
var … BJn="mcp_call_unanswered",
o8s="The server asked the user a question, and no answer came before the time limit. Do not call this tool again in this turn. Tell the user that the server's question got no answer, and wait for their reply.",
s8s="mcp_question_unanswered", …
cWr="The outcome is unknown: the call may have finished, may still be running, or may never have started. Check what it did before you repeat it."
```

(`cWr`/`BJn` also present in BIN309 — the 309 baseline OCC also lacks.)

Timeout handler, BIN310 dd @278877100+2400 (verbatim; `je` = watchdog, `Fe` =
in-flight sends set, `St` = reject fn, `Z`/`n` = server/tool):

```js
Te=(ve,Qe)=>{clearTimeout(he),he=setTimeout((ft,Tt,lt,Ut,$t,rt)=>{
  let At=`MCP server "${Tt}" tool "${lt}" timed out after ${Math.floor(Ut/1000)}s`,
      Bt=$t.size>0,
      dt=(rt.openQuestions??0)>0,
      zt=[...dt?[o8s]:[],...Bt?[cWr]:[]];
  ft(Object.assign(new R(zt.length>0?`${At}. ${zt.join(" ")}`:At,"MCP tool timeout",
      Bt?BJn:dt?s8s:void 0),{mcpErrorSource:"downstream_unreachable"}))
},ve,St,Z,n,Qe,Fe,je)}
```

BIN309 dd @280854400+1400 — same handler WITHOUT the questions arm:

```js
De=setTimeout((nt,vt,bt,Nt,It)=>{let ot=`MCP server "${vt}" tool "${bt}" timed out after ${Math.floor(Nt/1000)}s`,Lt=It.size>0;
nt(Object.assign(new R(Lt?`${ot}. ${xNr}`:ot,"MCP tool timeout",Lt?P5n:void 0),{mcpErrorSource:"downstream_unreachable"}))},…)
```

Elicitation request handler counter, BIN310 dd @275511304 region (verbatim):

```js
$n.forEach((Zn)=>Zn.questionOpened?.());
let tn=$n.length===1?$n[0]:void 0;
if(tn!==void 0)tn.openQuestions=(tn.openQuestions??0)+1;
let Mt=performance.now(),lr;
try{lr=await e.handleElicitation(Te,Ee.params.message,He,Ot,rn,In,Ft,Tt,Ze)}
finally{if(tn!==void 0)tn.openQuestions=(tn.openQuestions??1)-1;$n.forEach((Zn)=>Zn.questionClosed?.())}
```

BIN309 dd @277546600+1100 — same site WITHOUT the counter (only
`questionOpened?.()` / `questionClosed?.()` fan-out, which OCC also lacks):

```js
He.forEach((Ln)=>Ln.questionOpened?.());let It=performance.now(),Dt;
try{Dt=await e.handleElicitation(K,ne.params.message,Vt,Ae,Be,dt,$t,ln,ve)}
finally{He.forEach((Ln)=>Ln.questionClosed?.())}
```

(`$n`/`He` = active watchdogs filtered by `timing` vs `dialledUnder`; the
counter is attributed only when exactly ONE watchdog is active —
`$n.length===1`.)

### Action (PORT)

1. `src/services/mcp/sendTracking.ts` — extend `ToolCallWatchdog` with
   `openQuestions?: number` (and, matching the official watchdog shape used
   by the elicitation fan-out, `questionOpened?/questionClosed?` callbacks +
   `timing` if OCC ports the 309-era telemetry; minimum viable for THIS item
   is `openQuestions`).
2. `src/services/mcp/elicitationHandler.ts` (the `ElicitRequestSchema`
   handler at :92) — mirror the official: resolve the connection state's
   `activeCallWatchdogs`, call `questionOpened?.()` on the (timing-filtered)
   set, and when exactly one watchdog remains, increment its `openQuestions`
   before `await`ing the elicitation resolution and decrement in `finally`
   (`(w.openQuestions ?? 1) - 1`), then `questionClosed?.()` fan-out. The
   handler needs access to the per-server connection state — thread it
   through `registerElicitationHandler`'s params.
3. `src/services/mcp/client.ts` timeout rejection (~:5031) — replace the
   plain rejection with the official composition:
   - base: `` `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s` ``
   - `hasInFlight = inFlightSends.size > 0` (the 309 baseline arm OCC also lacks — port both, flagged separately in the commit as the 309 prerequisite)
   - `openQuestion = (callWatchdog.openQuestions ?? 0) > 0`
   - parts: `[...(openQuestion ? [QUESTION_UNANSWERED_MSG] : []), ...(hasInFlight ? [OUTCOME_UNKNOWN_MSG] : [])]`
   - message: `` parts.length > 0 ? `${base}. ${parts.join(" ")}` : base ``
   - error code (3rd ctor arg): `hasInFlight ? "mcp_call_unanswered" : openQuestion ? "mcp_question_unanswered" : undefined`
   - attach `{ mcpErrorSource: "downstream_unreachable" }` (`Object.assign`)
   - verbatim constants: `QUESTION_UNANSWERED_MSG = "The server asked the user a question, and no answer came before the time limit. Do not call this tool again in this turn. Tell the user that the server's question got no answer, and wait for their reply."`; `OUTCOME_UNKNOWN_MSG = "The outcome is unknown: the call may have finished, may still be running, or may never have started. Check what it did before you repeat it."`
4. Idle-timeout sibling (official 310 same region: `Tt=Fe.size>0; … new R(Tt?`${ft} ${cWr}`:ft,"MCP tool idle timeout",Tt?BJn:void 0)`) — check OCC's idle-timeout path when implementing; BIN309 already had this arm, so if OCC lacks it, it's a 309-baseline gap to close in the same PR.
5. Tests (AAA): (a) timeout with `openQuestions=1`, no in-flight sends → message = base + `. ` + QUESTION_UNANSWERED_MSG, code `mcp_question_unanswered`; (b) both → base + `. ` + question + ` ` + outcome, code `mcp_call_unanswered` (Bt wins); (c) neither → plain base, no code; (d) elicitation handler increments exactly-one-watchdog attribution and decrements in `finally` even when the handler throws; (e) two watchdogs active → no counter attribution (official `$n.length===1` guard).
