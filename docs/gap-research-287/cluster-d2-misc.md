# OCC-105 Cluster D2 — RC / cloud / plugin / misc (26 items)

Round: official 2.1.286 → 2.1.287. Byte forensics only (binaries never executed).
Binaries: `/tmp/cc-diff-287/v286/package/claude`, `/tmp/cc-diff-287/v287/package/claude`.
OCC repo: `workdir/occ` @ 6dcc320 (read-only).
Method: `LC_ALL=C rg -aob -F` offsets + python window extraction; novelty = hit-count in v286
and sorted-unique string diff (`s286s.txt` vs `s287s.txt`, `new287.txt`).

## Verdict table

| # | Item (abridged) | Verdict |
|---|---|---|
| 1 | RC reconnect gives up after 30s | NO-OP{ALREADY-ALIGNED} (architectural) |
| 2 | asyncRewake missing-script repeated waking | **PORT-CANDIDATE (rank 3)** |
| 3 | Chrome browser picker JSON parse error | NO-OP{NO-SURFACE} |
| 4 | claude agents worktree reopen | NO-OP{NO-SURFACE} |
| 5 | /advisor pairing (Sonnet 5.5 advises Opus 4.7/4.8) | STAGED (data-only upstream) |
| 6 | Bash prompt "Contains simple_expansion" | **PORT-CANDIDATE (rank 1)** |
| 7 | "unrecoverable interface error" fullscreen crash | NO-OP{NO-SURFACE} |
| 8 | claude agents permission prompt | NO-OP{NO-SURFACE} |
| 9 | /ultrareview ×2 | NO-OP{NO-SURFACE} (gated off) |
| 10 | remote-control register behind HTTP proxy | STAGED — official fix NOT RECOVERED (code-only) |
| 11 | Reduce-motion: dot + 3 spinners + /rewind ago | **PORT-CANDIDATE (rank 6, small)** |
| 12 | claude agents times in screen reader mode | NO-OP{NO-SURFACE} |
| 13 | cloud session restart during compaction | NO-OP{NO-SURFACE} |
| 14 | plugin reload × --plugin-url cache corruption | NO-OP{ALREADY-ALIGNED} |
| 15 | /desktop quoting partial output | **PORT-CANDIDATE (rank 5, small)** |
| 16 | SessionStart hooks from synced plugins (cloud) | NO-OP{NO-SURFACE} |
| 17 | "N hooks ran" counts internal callbacks | NO-OP{ALREADY-ALIGNED + NO-SURFACE} |
| 18 | remote file-delivery family (7 entries) | NO-OP{NO-SURFACE} |
| 19 | mid-session repo adds (cloud/SDK) | NO-OP{NO-SURFACE} |
| 20 | macOS idle sleep stops RC turn | NO-OP{PLATFORM} |
| 21 | Windows raw-mode piped stdin guard | **PORT-CANDIDATE (rank 2)** |
| 22 | marketplace plain-language errors | STAGED (bundle with admission validator) |
| 23 | plugin dependency notes / install retry | NO-OP{NO-SURFACE} |
| 24 | Claude apps gateway Bedrock model ID error | NO-OP{PLATFORM} (server-side) |
| 25 | light-theme prompt border + ❯ contrast | **PORT-CANDIDATE (rank 4, tiny)** |
| 26 | Windows Bash subshell removal | NO-OP{PLATFORM} |

Ranked PORT-CANDIDATES: **#6 > #21 > #2 > #25 > #15 > #11**.

---

## #6 — Bash permission prompt plain-language mapping — PORT-CANDIDATE (rank 1)

Changelog: "Fixed Bash permission prompts showing internal parser names such as
'Contains simple_expansion' instead of a plain explanation".

Official v286 `_()` (too-complex builder) @ ~200529981:

```js
function _(e){return{kind:"too-complex",reason:e.type==="ERROR"?"Parse error":Ee.has(e.type)?`Contains ${e.type}`:`Contains shell syntax (${e.type}) that cannot be statically analyzed`,nodeType:e.type}}
```

Official v287 replacement @ ~202492998 — **recovered verbatim**:

```js
function _(e){if(e.type==="ERROR")return{kind:"too-complex",reason:"Parse error",nodeType:e.type};let t=Rt.get(e.type);return{kind:"too-complex",reason:t===void 0?"Part of this command cannot be checked in advance":`Part of this command (${t}) cannot be checked in advance`,nodeType:e.type}}
var Rt=new Map([["simple_expansion","a variable"],["expansion","a variable in braces"],["command_substitution","the output of another command"],["process_substitution","another command used as a file"],["brace_expression","a brace pattern"],["ansi_c_string","text with escape codes"],["translated_string","text the shell may translate"],["test_command","a test in brackets"],["herestring_redirect","a here-string"],["heredoc_redirect","a here-document"],["subshell","a group of commands in parentheses"],["compound_statement","a group of commands in braces or double parentheses"],["for_statement","a for or select loop"],["c_style_for_statement","a for loop with a counter"],["while_statement","a while or until loop"],["until_statement","an until loop"],["if_statement","an if statement"],["case_statement","a case statement"],["function_definition","a function definition"],["array","a list of values"],["string","quoted text"],["file_redirect","a redirect to or from a file"],["pipeline","a pipeline"],["concatenation","text joined from several pieces"],["variable_assignment","a variable assignment"],["variable_assignments","several variable assignments"]]);
```

Novelty: "Part of this command" 0 hits in v286, present in v287; "Contains ${" gone from the
too-complex path.

OCC is affected (same leak, same surfacing chain):
- `src/utils/bash/ast.ts` — `DANGEROUS_TYPES` set @420; `tooComplex()` @~2704 returns
  `` `Contains ${node.type}` `` — exactly the v286 behavior.
- `src/tools/BashTool/bashPermissions.ts:2758` — `reason: astResult.reason` on the too-complex branch.
- `src/utils/permissions/permissions.ts:152` — `createPermissionRequestMessage`, `case 'other': return decisionReason.reason` → raw parser name renders verbatim in the permission prompt.

Port: add the `Rt` map (as a `NODE_TYPE_EXPLANATIONS: ReadonlyMap<string,string>` constant),
rewrite `tooComplex()` to the v287 shape (ERROR → "Parse error"; mapped → "Part of this command
(X) cannot be checked in advance"; unmapped → "Part of this command cannot be checked in
advance"). No caller changes needed.

## #21 — Piped/redirected stdin startup guard — PORT-CANDIDATE (rank 2)

Changelog (Windows-framed, but the guard covers piped stdin / CI / missing /dev/tty on all
platforms): "Fixed interactive claude hanging or crashing with 'Raw mode is not supported'
when its input is piped or redirected; it now says why and exits (use -p for piped input)".

Official v287 @ ~215311316 — **recovered verbatim**:

```js
var lr="Claude Code can't read the keyboard here: stdin is not a terminal (it is piped, redirected, or supplied by the program that launched claude)",
ns={windows:{lines:[`${lr}, and on Windows it can't fall back to the console for input yet.`,"Run claude directly in Windows Terminal, PowerShell, or Command Prompt, without piping or redirecting its input."],reader:"type"},
    ci:{lines:[`${lr}, and the CI environment variable is set, so it doesn't fall back to the terminal for input.`,"Unset the CI environment variable to work interactively."],reader:"cat"},
    tty_unavailable:{lines:[`${lr}, and the terminal device (/dev/tty) couldn't be opened to read the keyboard instead.`,"Start claude directly from a terminal."],reader:"cat"}};
function uro(e){return ns[e].lines.join("\n")}
async function rs(e){let{lines:o,reader:n}=ns[e];return jS([...o,Vl(n)].join("\n")),await sar(e),Vs()}
function Vl(e){return`To send text as a prompt and print the reply instead, add -p; it also works with --continue and --resume <session-id> (for example: ${e} notes.md | claude -p --continue).`}
async function Xl(){let e=await new Promise((o)=>{Yl(0,(n,r)=>o(n?void 0:r))});if(e===void 0)return"unknown";if(e.isFIFO())return"pipe";if(e.isFile())return"file";if(e.isSocket())return"socket";if(e.isCharacterDevice())return"character_device";return"other"}
```

Novelty: "read the keyboard here" — 0 hits v286, 2 hits v287, 0 hits OCC src.
(`jS`=print-to-stderr, `sar`=telemetry/exit-flush, `Vs`=exit, `Yl`=fs.stat on fd 0; the
`Xl` fd-0 stat classifier feeds telemetry: pipe/file/socket/character_device/other/unknown.)

OCC is affected:
- `src/utils/renderOptions.ts` — `getStdinOverride()` returns `undefined` in exactly the three
  situations the official guard names (stdin not TTY + CI set + /dev/tty open failure); with
  `undefined`, interactive Ink boots and dies on the raw-mode throw.
- `src/ink/components/App.tsx:225/227` — the "Raw mode is not supported on the current
  process.stdin..." throws are byte-identical to official v286/v287 (the fix is the
  higher-level startup guard, not this throw).
- `src/main.tsx:903` — `getInputPrompt` handles `!process.stdin.isTTY` only for `-p` piping;
  interactive mode has no guard.

Port: at startup (before Ink mounts), when `getStdinOverride()` is undefined AND mode is
interactive AND stdin is not a TTY → classify (windows / ci / tty_unavailable), print
`lines.join("\n")` + the `-p` advice line to stderr, exit non-zero. Emit the fd-0 stat
classifier with the exit telemetry.

## #2 — asyncRewake missing hook script reported once — PORT-CANDIDATE (rank 3)

Changelog: "Fixed hooks configured with asyncRewake waking Claude over and over with
'found issues' notifications when the hook's script file is missing; the broken hook is now
reported once".

Official v287 `QLe` (asyncRewake exit-2 handler) @ ~208352408 — **recovered verbatim** (key part):

```js
let Ae=Se.code===2?await Bit({stdout:Ee,stderr:Ce,scriptPaths:G??[]}):void 0;
if(Hit(Uit.of(U().host),`${h}\n${S}`,Ae?.output)){t(`Hooks: asyncRewake hook "${h}" (${S}) exited 2 again because ${Ae?.scriptPath} cannot be opened; already reported, not waking the model`,{level:"warn"});return}
if(Se.code===2){let Pe,Fe,Ne;if(Ae!==void 0)Pe=`${h} hook could not run: ${Ae.scriptPath} cannot be opened, so its command exited with code 2 without doing any work. This is a broken hook installation, not feedback on your work; it is reported this once and identical repeats are dropped. Interpreter output:`,Fe=`${g} hook could not open ${uWt(Ae.scriptPath)}`,Ne=Ae.output;else Pe=H??`Stop hook blocking error from command "${h}":`,Fe=xe??j??"Stop hook feedback",Ne=Ce||Ee;FMt({summary:Fe,body:`${Pe} ${Ne}`,priority:"next",stopHookActive:!0,turnAttribution:"inherit"})}
```

`Bit` = missing-script detector (scans stdout/stderr for interpreter "can't open file"
patterns against the hook's script paths, returns `{scriptPath, output}`); `Hit` =
already-reported dedup keyed on `${hookName}\n${command}`; `FMt` = enqueue rewake.
Novelty: the "cannot be opened, so its command exited with code 2" and "already reported,
not waking the model" strings are new in v287 (absent in s286s.txt).

OCC is affected:
- `src/utils/hooks.ts:341-349` — asyncRewake exit-code-2 branch unconditionally enqueues
  `Stop hook blocking error from command "${hookName}": ${stderr||stdout}` as a
  task-notification → a missing script wakes the model on every run, forever.
- `src/utils/hooks.ts:1085` — `looksLikeMissingHookScript()` already exists (ported from
  official 2.1.248, updated 2.1.285) but is NOT called on the asyncRewake path.

Port: in the asyncRewake exit-2 branch, call `looksLikeMissingHookScript` (extend to return
the offending script path like official `Bit`), add a module-level reported-set keyed on
`hookName\ncommand`, emit the two official message forms verbatim, and drop repeats with the
warn log line.

## #25 — Light-theme prompt border + ❯ contrast — PORT-CANDIDATE (rank 4, tiny)

Changelog: "Improved the contrast of the prompt input border in light themes and of the ❯
before your earlier messages".

Official theme diff (full key-by-key comparison of the `autoAccept:"rgb(135,0,255)"`-anchored
theme objects, v286 vs v287): **the only changed value in the entire theme table** is

- `promptBorder:"rgb(153,153,153)"` (v286 @202424665, @202431672)
  → `promptBorder:"rgb(138,138,138)"` (v287 @204448151, @204455158).
- `promptBorderShimmer` stays `rgb(183,183,183)`; dark themes stay `rgb(136,136,136)`;
  ansi themes stay `ansi:white`; `subtle`/`inactive`/`text` values identical across versions
  (verified by exhaustive regex counts of each key in both binaries).
- Two occurrences per version = light + light-daltonized (matches OCC's layout exactly:
  v286 had 153×2 / white×2 / 136×2; v287 has 138×2 / white×2 / 136×2).

❯ pointer: official rtt (HighlightedThinkingText) non-brief branch —
v286: `r(n,{"aria-label":y?"selected:":"you:",color:y?"suggestion":"subtle",children:[J.pointer," "]})`
v287: `r(n,{"aria-label":y?"selected:":"you:",color:y?"suggestion":"inactive",children:[X.pointer," "]})`
(v286 hit @~209766637 region; v287 @~222068923 region; `"subtle"` global count 54→50).
Brief-layout branch (`_=y?"suggestion":x?"subtle":"text"`) unchanged.

OCC targets:
- `src/utils/theme.ts:169` (lightTheme) and `:416` (lightDaltonizedTheme) —
  `promptBorder: 'rgb(153,153,153)'` → `'rgb(138,138,138)'` (both).
- `src/components/messages/HighlightedThinkingText.tsx:30` —
  `const pointerColor = isSelected ? "suggestion" : "subtle"` → `"inactive"`.

## #15 — /desktop names the failure cause — PORT-CANDIDATE (rank 5, small)

Changelog: "Fixed /desktop quoting partial output when opening Claude Desktop timed out or
printed too much output; the error now names the cause".

Official v287 opener-result builder `y()` (whole deep-link chunk @218727474 region) —
**recovered verbatim**:

```js
var P=200;
function y(e,n){let{code:o,exitCode:r,stderr:a,error:s,timedOut:u,maxBufferExceeded:c}=n;
if(o===0)return{opened:!0};
let i=a||s;
if(t(`Deep link opener ${e} failed: code ${o}, exitCode ${r??"undefined"}${i?`: ${i}`:""}`),u)return{opened:!1,detail:`\`${e}\` timed out`};
if(c)return{opened:!1,detail:`\`${e}\` printed too much output`};
let d=r===void 0?`\`${e}\` failed`:`\`${e}\` exited ${r}`,
f=Lt(Dr(a.trim())||(r===void 0?s:"")||"",P).replace(/\.+$/,"");
return{opened:!1,detail:f.length===0?d:`${d}: ${f}`}}
```

Novelty: "printed too much output" — 0 hits v286, 2 hits v287 (JS @218727474 + data-segment
copy @96585794). v286's builder is the `D(r,e)` form OCC already documents verbatim.

OCC is affected: OCC has a live `/desktop` (`src/commands/desktop/index.ts:15`,
`desktop.tsx` → `src/components/DesktopHandoff.tsx` → `openCurrentSessionInDesktop`).
`src/utils/desktopDeepLink.ts:~290 buildDeepLinkOpenerResult` ports the v276/v286 `D()`
shape: `OpenerExecResult` (line ~200) has no `timedOut`/`maxBufferExceeded` fields, so a
10-min-timeout kill or output overflow quotes partial stderr — the exact v286 bug.

Port: add `timedOut?: boolean; maxBufferExceeded?: boolean` to `OpenerExecResult`; execa
already reports `timedOut` and `maxBufferExceeded` on failure results — pass them through in
`runOpenerCommand`; add the two early-return branches to `buildDeepLinkOpenerResult` before
the `failed`/`exited N` fallthrough (verbatim strings above).

## #11 — Reduce-motion gaps — PORT-CANDIDATE (rank 6, small)

Changelog: "Fixed the running-tool dot and three spinners still moving with the 'Reduce
motion' setting on, and /rewind's confirm screen updating its 'ago' time while you type a note".
Official fix is code-only (no new strings in the sorted-unique diff for spinner/reduce-motion).

OCC status — mostly aligned, two real gaps:
- ALIGNED: `Spinner.tsx:107/347/534`, `SpinnerAnimationRow.tsx:104/137/138/145` (explicit
  `reducedMotion` gating), `TextInput.tsx:43`, `VoiceIndicator.tsx:95`,
  `RemoteSessionProgress.tsx:93`, `LogoV2/AnimatedAsterisk.tsx:22`, `LogoV2/OccMark.tsx:316`
  all read `settings.prefersReducedMotion`; setting toggle wired end-to-end
  (`Settings/Config.tsx:305-326`, `REPL.tsx:1552`).
- GAP 1: `src/components/messages/AssistantThinkingMessage.tsx:72` renders
  `<InlineThinkingSpinner />` with no prop → `reducedMotion = false` default
  (`Spinner/InlineThinkingSpinner.tsx:25-27`) → thinking spinner animates with Reduce motion on.
- GAP 2: `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:43`
  hardcodes `useShimmerAnimation("requesting", CHECKING_TEXT, false)` → classifier shimmer
  animates regardless of the setting.
- NO-SURFACE halves: running-tool dot — no animated per-tool dot component in OCC
  (rg `RunningTool|running.?dot|ToolRunning` src/components = 0); /rewind "ago" confirm
  screen — OCC's `src/commands/rewind/` has no confirm/note/"ago" UI (rg = 0).

Port: thread `settings.prefersReducedMotion` into both call sites (behavior parity; no
official code to copy verbatim — it's a prop-wiring fix).

## #1 — RC reconnect 30s deadline — NO-OP{ALREADY-ALIGNED} (architectural)

Official v287 added a **connect deadline to the SSE transport** (new: `connectTimeoutMs`
0 hits in v286 → 9 in v287). Constants block v287 @~221086700:
`var wn=1000,Rn=30000,Se=15,Tn=60,Mn=30000,An=30000,Cn=15000,ct=3` (`An=30000` = default
connectTimeoutMs — the changelog's "30 seconds"; `Mn=30000` = liveness grace; liveness timer
itself existed in v286: `resetLivenessTimer` 7 hits in both). connect() v287 @221088086 window:
`let g=Math.min(...this.connectTimeoutMs,ku),R=g>0?setTimeout(()=>{S=!0,v.abort()},g):void 0`
… catch: `if(S){t(\`SSETransport: No response within ${g}ms, reconnecting\`),...,this.connectErrorsSeen.add("connect_timeout"),this.diagConnectFailure(\`no response in ${g/1000}s\`,e),this.handleConnectionError()}`.
v286's connect() (same window in v286) does `let v=new AbortController;...await fetch(...)`
with **no deadline timer** — the hang the changelog describes. (The `ku` cap value and the
separate `beginReconnectHold`/`reconnect_hold_ms` telemetry — new v287 strings — were not
recovered to constant level; the hold telemetry belongs to the remote-tool ask module, data
segment @94142600.)

OCC NOT affected: OCC's bridge is poll-based, not a long-lived SSE fetch. Every bridge HTTP
call carries an explicit timeout (`src/bridge/bridgeApi.ts:181/220/264/290/312/337/376/407/435`
— 10s/15s axios timeouts; `reconnectSession` already `timeout: 10_000` @358;
`replBridge.ts:462/769` `AbortSignal.timeout(15_000)`); no `event-stream`/`getReader`/bare
`fetch(` in `replBridgeTransport.ts`/`remoteBridgeCore.ts` (rg = 0). No unbounded
receive path exists to hang.

## #2 — (see PORT-CANDIDATE section above)

## #3 — Chrome browser picker — NO-OP{NO-SURFACE}

`rg -in "browser.?picker|chooseBrowser|pick a browser" src` = 0 hits. OCC's WebBrowserTool
launches its own headless Chrome via CDP (`src/tools/WebBrowserTool/browser.ts`,
`OCC_WEBBROWSER_CHROME_PATH ?? '/usr/bin/google-chrome-stable'`); the Claude-in-Chrome
picker JSON-parse path does not exist in OCC.

## #4 — claude agents worktree reopen — NO-OP{NO-SURFACE}

`rg -ln worktree src/daemon` = 0 hits (daemon supervisor files: install/lockfile/main/
process/respawn/supervisor/remoteControl*). No `claude agents` view, no per-session worktree
creation/removal lifecycle in OCC.

## #5 — /advisor pairing — STAGED (data-only upstream change)

Official pairing LOGIC is byte-identical v286→v287 (`sde/Eh/kh` v287 @205061734 vs
`Ile/Ch/Th` v286 @203043886 — same structure; rule `base_rank <= advisor_rank`); only the
model-catalog `advisor_rank` DATA changed (v287 catalog @~199523091):
claude-fable-5 5→8, fable-5-1 5→9, mythos-5 5→8, mythos-5-1 5→9, opus-4-7 4→5, opus-4-8 4→5,
opus-5 4→7, opus-5-5 4→7, sonnet-5 3→4, sonnet-5-5 3→6; unchanged haiku-4-5=1, opus-4-6=3,
sonnet-4-6=2. Changelog claim verified: sonnet-5-5 (6) ≥ opus-4-7 (5).
OCC has NO rank table — `src/utils/advisor.ts:180-208` uses identical hardcoded substring
allowlists (`opus-4-6|sonnet-4-6|opus-5|sonnet-5` + `USER_TYPE==='ant'`); the flag-up-front
half already exists (`src/commands/advisor.ts` checks `modelSupportsAdvisor` /
`isValidAdvisorModel` / `isModelAllowed` before use). STAGED: adopt ranks only when/if OCC
ports the model-catalog advisor_rank field (pre-existing OCC-37 gap: opus-4-7/4-8 missing
from OCC's allowlist entirely).

## #7 — fullscreen "unrecoverable interface error" — NO-OP{NO-SURFACE}

`rg -n "unrecoverable interface error" src` = 0 hits. OCC has no equivalent
crash-wrapper/exit message; the official fix lives in their fullscreen Ink crash handler.

## #8 — claude agents permission prompt — NO-OP{NO-SURFACE}

No `claude agents` TUI in OCC (replaced by daemon supervisor; see #4 evidence).

## #9 — /ultrareview ×2 — NO-OP{NO-SURFACE}

`/ultrareview` exists only as a gated lazy command: `src/commands/review.ts:3,48-53`
(`isUltrareviewEnabled()` from `review/ultrareviewEnabled.ts`, GrowthBook stub → off);
comment @45: "/ultrareview is the ONLY entry point to the remote bughunter path". No upload/
.gitattributes/settings-advice code runs in OCC.

## #10 — remote-control register behind HTTP proxy — STAGED (official fix NOT RECOVERED)

Byte-compared the two candidate sites; both are **identical v286↔v287**:
`registerBridgeEnvironment` body (v286 @219266823 vs v287 @221513576 — same structure,
`timeout:15000`, same 409 special-case) and `handleErrorStatus` (v286 `C()` vs v287 `A()`;
403 branch verbatim-equal: `` `${n}: Access denied (403)${g?`: ${g}`:""}. Check your organization permissions.` ``).
Sorted-unique string diff shows NO new proxy/register/403 user-facing strings (checked
'proxy','HTTP proxy','a proxy','403','register' against s287s−s286s: only self-hosted-runner
and gateway-login proxy strings, unrelated). Conclusion: the fix is code-only at the
transport/error-classifier level and I could not localize it — **stated honestly as
unrecovered**. OCC exposure: `src/bridge/bridgeApi.ts` uses plain axios (honors
HTTP(S)_PROXY env by default) and carries the same 403 text @475; no `ERR_PROXY`/
`isAxiosError` special-casing (rg = 0). Low impact; revisit if a user reports it (upstream
issue anthropics/claude-code#97352).

## #12 — claude agents times (screen reader) — NO-OP{NO-SURFACE}

No agents view in OCC (see #4/#8). Screen-reader cluster is E's scope regardless.

## #13 — cloud session restart during compaction — NO-OP{NO-SURFACE}

OCC has no cloud-session host. `rg -in "cloud session" src` hits only RemoteAgentTask relay
strings (`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:378`, test files) — relay side, not
the session lifecycle the fix touches.

## #14 — plugin reload × --plugin-url cache race — NO-OP{ALREADY-ALIGNED}

Official fix is code-only (new287 `plugin-url` hits are all unrelated flag-plumbing lines; no
new corruption/lock strings). OCC is structurally immune: `src/utils/plugins/fetchPluginZip.ts:111`
downloads each invocation into a unique per-call temp dir `` join(tmpdir(), `occ-plugin-url-${randomUUID()}`) ``
with cleanup on every failure branch — there is no shared deterministic cache path for a
concurrent `/reload-plugins` (`src/hooks/useManagePlugins.ts` → refreshActivePlugins) to
corrupt; startup clears inline-plugin cache once (`src/main.tsx:1023 clearPluginCache('preAction: --plugin-dir/--plugin-url inline plugins')`).

## #16 — SessionStart hooks from synced plugins (cloud) — NO-OP{NO-SURFACE}

Cloud plugin sync does not exist in OCC (`rg -in "cloud session" src` evidence per #13; no
synced-plugin SessionStart path).

## #17 — "N hooks ran" / matched-hooks count — NO-OP{ALREADY-ALIGNED + NO-SURFACE}

Telemetry half ALREADY-ALIGNED: `src/utils/hooks.ts:3120` and `:4557` both do
`const userHooks = matchingHooks.filter(h => !isInternalHook(h))` before
`getPluginHookCounts`/`getHookTypeCounts` for `tengu_run_hook` (`isInternalHook` @2466 =
`hook.type==='callback' && hook.internal===true`) — internal callbacks already excluded.
Transcript half NO-SURFACE: `rg "hooks ran" src` = 0 (no such summary UI in OCC).

## #18 — remote file-delivery family (7 entries) — NO-OP{NO-SURFACE}

One verification for the whole family: OCC's bridge has **no outbound file delivery** —
`rg -in "uploadFile|sendFile|/files" src/bridge/bridgeApi.ts` = 0; bridge writes are JSON
event batches only (`replBridgeTransport.ts:19` SerialBatchEventUploader). So the 30s→35s
upload timeout, retry-once-on-502/503/504, stream-from-disk + size-limit naming, oversized-image
scaling (>8000px), and refusal-explanation entries all have no OCC surface. Inbound
attachments exist (`src/bridge/inboundAttachments.ts`) but have **no 16-file cap** (no
slice/limit on `attachments.length`; rg 'MAX|slice' only uuid-slice @102) — the
17-to-20-attachments bug doesn't map. No download-retry there either (single catch @93/110);
noted as a possible future hardening item, not a 287 port.

## #19 — mid-session repo adds — NO-OP{NO-SURFACE}

SDK half: `rg -n "add_directory|addDirectory" src/entrypoints src/services` = 0 — OCC's SDK
control protocol has no mid-session directory-add request. (`additionalDirectoriesForClaudeMd`
in `src/bootstrap/state.ts:224` is the static settings surface, unrelated.) Cloud half: no
cloud sessions (#13).

## #20 — macOS idle sleep — NO-OP{PLATFORM}

macOS-only (idle-sleep assertions around `claude remote-control`); OCC is Linux-first with no
sleep-prevention surface (no IOKit/pm assertions anywhere in src/bridge).

## #22 — marketplace plain-language errors — STAGED

Base-case messages OCC shows are UNCHANGED v286→v287 (verified identical counts in both
binaries: "is registered from an untrusted source", "Invalid marketplace config:",
"Failed to load marketplace configuration:") — no regression, nothing to port for them.
v287 ADDS new plain-language variants (sorted-unique diff): "so it is ignored. Remove it
with:" 2→8, "a spelling of the name reserved for the built-in" 0→2, "the name reserved for
the built-in" 0→4, "that is not the built-in" 0→2, plus "Cannot add marketplace X from this
source…clash in the marketplaces folder", "Marketplace 'X' is already added; nothing changed",
"Details: the repository does have a marketplace.json, but it isn't a valid marketplace file",
"Run /reload-plugins, or: claude plugin marketplace update X". These belong to the admission-
validator family OCC-104 STAGED #39 (validator never ported; OCC's copies live at
`src/utils/plugins/schemas.ts:232/237/277`, `src/utils/plugins/marketplaceManager.ts:320/418/439`).
Keep STAGED; port validator + v287 message set together in a dedicated issue.

## #23 — plugin dependency notes / install retry — NO-OP{NO-SURFACE}

OCC has plugin↔plugin dependency RESOLUTION (`src/utils/plugins/dependencyResolver.ts` —
enablement graph, cross-marketplace blocking) but no dependency INSTALLER:
`rg -in "installDependenc|npm install|bun install" src/utils/plugins` → only
`npmPluginFetch.ts` docs about the deliberately-disabled lifecycle-script `npm install`
(RCE hardening, v2.1.274). The official "dependencies were not installed" listing note and
update-retries-install surface don't exist in OCC (matches OCC-104 #60 disposition).

## #24 — Claude apps gateway Bedrock model ID error — NO-OP{PLATFORM}

Server-side (Claude apps gateway) change; no client binary surface, nothing for OCC.

## #26 — Windows Bash subshell removal — NO-OP{PLATFORM}

Windows-only perf fix. `rg -n "comspec|cmd.exe|/s /c" src/tools/BashTool -i` = 0 — OCC's
BashTool has no pre-command Windows subshell to remove.

---

## Ranked port list (all with verbatim official code above)

1. **#6** bash too-complex plain-language mapping (`Rt` table + `_()` rewrite) —
   `src/utils/bash/ast.ts:~2704`; user-visible on every complex-command permission prompt.
2. **#21** piped/redirected-stdin startup guard (`lr/ns/uro/rs/Vl/Xl`) — new startup check
   before Ink mount; `src/utils/renderOptions.ts` + `src/main.tsx` boot path.
3. **#2** asyncRewake missing-script reported-once (`QLe` + dedup) — `src/utils/hooks.ts:341-349`,
   reuses existing `looksLikeMissingHookScript` @1085.
4. **#25** contrast: `src/utils/theme.ts:169,416` 153→138;
   `HighlightedThinkingText.tsx:30` "subtle"→"inactive". Two-line change.
5. **#15** /desktop cause-naming detail — `src/utils/desktopDeepLink.ts`
   (add timedOut/maxBufferExceeded to OpenerExecResult + two branches).
6. **#11** reduce-motion wiring — `AssistantThinkingMessage.tsx:72` pass prop;
   `BashPermissionRequest.tsx:43` replace hardcoded `false`.

STAGED (not this round): #5 (advisor ranks — needs catalog field), #10 (unrecovered),
#22 (bundle with admission validator).

Honesty notes: #10's exact official fix could not be localized (byte-identical candidates;
no new strings) — reported as unrecovered. #1's `ku` cap constant value and the
`reconnect_hold` telemetry semantics were not recovered to constant level; the core 30s
default (`An=30000`) and deadline shape are verbatim above. Everything else is
byte-offset-verified.
