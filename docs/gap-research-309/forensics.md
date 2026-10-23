# Binary forensics: claude-code 2.1.308 → 2.1.309

Method: strings set-diff (`s1.txt`=308, `s2.txt`=309) + `rg -aboF` byte offsets + `dd` verbatim dumps on
BIN309=`/tmp/cc-diff-309/vver/package/claude` (v2.1.309) and BIN308=`/tmp/cc-diff-309/vprev/package/claude`.
Binaries were NEVER executed. "Newness count" = `rg -c "<phrase>" s1.txt s2.txt`; s1:0→s2:N means new in 309
(JS-region + UTF-16 pool duplicates each string, so N=2 is the typical "new once" signature).
All offsets are decimal byte offsets into the named binary. OCC = repo at `workdir/occ` (tracks 2.1.308); read-only checks.

Changelog reference: `/tmp/cc-CHANGELOG.md` `## 2.1.309` (79 items; numbered copy `/tmp/cc-diff-309/items.txt`).

---

## Finding F-1: "Waiting for API response" stall hint becomes route-dependent (20s Anthropic backend / 45s elsewhere)
- what: The stream-stall watchdog's first "stalled" hint delay was a fixed 20000ms in 308. In 309 it is
  `ikr()` = `Gce() ? 20000 : 45000` — 20s only when the route is Anthropic's own backend (firstParty or
  anthropicAws-without-custom-base-url), 45s for gateways/proxies that send only keepalive pings. The 90s
  abort ceiling and the 30s poll are unchanged.
- official evidence (BIN309):
  - @251775589: `var Zkn=1e4,Pkn=20000,skr=45000;function ikr(){try{return Gce()?Pkn:skr}catch(e){return l(N(e)),Pkn}}var akr=90000,lkr=30`
  - @251867337 (watchdog setup): `RI=i.CLAUDE_ENABLE_STREAM_WATCHDOG??!0,VS=vun(),tP=VS/2,SE=ikr(),CI=Math.min(qFr(xe()),RI?VS:1/0),xI=Math.min(akr,CI-SE)`
  - producer @251856071: `setTimeout(()=>{... Q.onRetryStatus?.({kind:"stalled",deadline:ke.now()+Math.max(0,CI-ch)})},SE,{unref:!0})`
  - route predicate (both versions): `function Gce(e=xe()){if(e==="anthropicAws")return i.ANTHROPIC_AWS_BASE_URL===void 0;return e==="firstParty"&&Li()}`
  - `vun(){return Math.max(Dp()??0,300000)}` where Dp reads `CLAUDE_STREAM_IDLE_TIMEOUT_MS` / managed `streamIdleTimeoutSec` (pre-existing, s1:2/s2:2)
- 308 comparison: BIN308 has the fixed form only: `var Yhn=1e4,lZe=20000,Fhr=90000,$hr=30` (producer @250946033);
  no `ikr`, no 45000 stall constant. Banner text "Waiting for API response" itself is identical in both
  (309 @267333098 / 308 @266319932) — only the delay selection changed.
- OCC status: absent — `src/services/api/modelCallRetries.ts` has the `stalled` stream-state taxonomy
  (lines 76-84, 157, 418, 467) but no 20000/45000 hint-delay constants anywhere in `src/services/api/`;
  "Waiting for API response" string absent from repo.
- maps to changelog item(s): #38
- recommended: PORT — small, exactly-specified constant + predicate change; port in the 309 form
  (route-dependent), not the old fixed 20s.

## Finding F-2: Claude Code's own git commands now always run in English (LC_ALL=C + LANGUAGE=C, opt-out `userLocale`)
- what: A frozen env object `{LC_ALL:"C",LANGUAGE:"C"}` is merged into every internal git invocation unless the
  caller passes `userLocale:true`, so git's error text is parseable regardless of the user's locale.
- official evidence (BIN309): git-env module dump @240283400 (+3600 bytes):
  - @240285277: `b=Object.freeze({LC_ALL:"C",LANGUAGE:"C"})` — NEW
  - builder: `function Ts(e,r={}){let n=e?.GIT_ALLOW_PROTOCOL?.split(":").includes("ssh")??!1;return B(E({...M,...r.userLocale!==!0&&b,...!n&&F},e,r))}`
  - worktree create passes `env:WNt(e,{LC_ALL:"C",...yne(be)})`; branch checkout adds `...be.inForce&&{LC_ALL:"C"}`
- 308 comparison: `userLocale` s1:0 → s2:25 (identifier new); `LANGUAGE:"C"` s1:2 → s2:3 (new merge site).
  No frozen LC_ALL/LANGUAGE object in BIN308's git-env module.
- OCC status: partial/divergent — ad-hoc `LC_ALL:'C'` only in `src/utils/worktree.ts:301,350,516` and
  `src/utils/formatBriefTimestamp.ts`; no central frozen `{LC_ALL,LANGUAGE}` set, no `userLocale` option,
  no LANGUAGE anywhere.
- maps to changelog item(s): #44 (English git errors half; the Windows-speed half is internal)
- recommended: PORT — centralize in OCC's git-env builder as a frozen `{LC_ALL:"C",LANGUAGE:"C"}` merge with a
  `userLocale` opt-out, matching `Ts()`.

## Finding F-3: Internal git env hardening — replace refs ignored for worktrees/branch checkouts + full GIT_* scrub set
- what: The shared frozen env `M` used by all internal git spawns now carries
  `GIT_NO_REPLACE_OBJECTS:"1"` and `GIT_NO_LAZY_FETCH:"1"` plus protocol lockdown; worktree creation and branch
  checkout use it (previously they didn't get replace-ref neutralization). A scrub list removes inherited
  GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE/GIT_CEILING_DIRECTORIES/GIT_DISCOVERY_ACROSS_FILESYSTEM/
  GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_SHALLOW_FILE/GIT_NAMESPACE/GIT_IMPLICIT_WORK_TREE/
  GIT_REFERENCE_BACKEND + GIT_CONFIG_*.
- official evidence (BIN309, dump @240283400+3600):
  - `_n=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor="]`
  - `M=Object.freeze({GIT_ALLOW_PROTOCOL:"/",GIT_CONFIG_PARAMETERS:p,GIT_NO_LAZY_FETCH:"1",GIT_NO_REPLACE_OBJECTS:"1",GIT_TERMINAL_PROMPT:"0",GIT_LFS_SKIP_SMUDGE:"1"})`,
    p = join of `["'alias.remote-none=version'","'alias.remote-none.command=version'","'alias.remote-/.command=version'","'fetch.bundleURI='","'help.autocorrect=0'"]`
  - `F=Object.freeze({GIT_SSH_COMMAND:"false"})` applied unless GIT_ALLOW_PROTOCOL lists `ssh`
  - `vTt=[..._n,"-c","safe.bareRepository=explicit","-c","protocol.file.allow=never"]`
  - validation error: `GIT_ALLOW_PROTOCOL may list only transport names made of letters, digits and "-"`
- 308 comparison: `M` exists in 308 but worktree/checkout paths bypassed replace-ref neutralization (changelog #10
  is the fix); `GIT_NO_REPLACE_OBJECTS` count rises with the new merge sites; `air(e,r)` variant
  (`{GIT_NO_REPLACE_OBJECTS:"1"}` while clearing GIT_LFS_SKIP_SMUDGE/GIT_NO_LAZY_FETCH) is new.
- OCC status: absent — `GIT_NO_REPLACE_OBJECTS` appears only in a comment
  (`src/utils/plugins/gitSshCommand.ts:30`); no central frozen git-env builder; worktree.ts sets env ad hoc.
- maps to changelog item(s): #10 (also underpins #44, #56)
- recommended: PORT — OCC should adopt the single frozen git-env builder (M/b/F/Ts) rather than more ad-hoc sites.

## Finding F-4: Worktree creation/reuse switches git on-demand (lazy) fetching OFF; partial clones pre-fetch with retry messaging
- what: Worktrees and branch checkouts now run with lazy fetching disabled (`GIT_NO_LAZY_FETCH=1`); for partial
  clones (promisor remotes) with a Bash sandbox configured, objects are fetched up front, and a whole new
  user-facing message family explains partial-clone failures.
- official evidence (BIN309):
  - `(Claude Code checks worktrees out with git's on-demand fetching switched off). Check that the remote is reachable (` — s1:0 → s2:6
  - `[git] ${n} is a partial clone: retrying with ${S==="off"?lazy...` (retry log)
  - `No lazy fetch from the promisor remote was attempted:` and
    `Nothing was fetched: a partial clone's lazy fetch runs over ${D} only...` + http.<url>.extraHeader advice
  - `Ssn="This partial clone does not hold every file of its working tree locally..."`
  - module consts: `Nsr=104857600` (100MB), `Lsr=3600`, `Fsr=10`, `ysn=120`, `hZ=300`, `Bsr=180000`
  - `GIT_NO_LAZY_FETCH` occurrence count 17 → 18
- 308 comparison: none of the message family exists in s1 (0 hits).
- OCC status: knowingly not ported — `src/utils/plugins/gitTransport.ts:36`: "no OCC counterpart
  (`rg "GIT_NO_LAZY_FETCH" src` → comment-only). Not ported."; no promisor/partial-clone messaging; "on-demand
  fetching" absent.
- maps to changelog item(s): #56 (and the fetch-failure messaging that supports #70-style cloud env cases)
- recommended: STAGED — sizable subsystem (promisor detection, pre-fetch, retry ladder, sandbox interaction);
  port as its own work item after F-3's central git-env builder lands.

## Finding F-5: `sed -i` loses the simulated file-edit preview — standard Bash prompt, runs as written
- what: 308 detected `sed -i` in Bash commands and rendered a file-edit-style diff preview permission request.
  In 309 that simulation is gone: `sed -i` gets the ordinary Bash prompt and executes as written (and like other
  Bash edits is no longer restored by /rewind). The generic bashEditDiff infrastructure itself is unchanged.
- official evidence:
  - BIN308 @271962725 (preview block, 308-ONLY): `B=y||P||w||x||D===h?[]:[{old_string:D,new_string:h,replace_all:!1}]`
    with messages: `Network path — diff not previewed. The sed command will run against ${iH(r)} on approval.`,
    the symlink variant ("`sed -i` reads THROUGH the link and writes the result as a regular file in the link's
    place"), "Not previewable as an in-place edit here...", UTF-8/too-large variants.
  - counts: "The sed command will run against" s1:1 → s2:0; "in-place edit" s1:1 → s2:0.
  - BIN309: remaining sed hits are the deny-rule-circumvention prompt text + oidc package.json artifact only;
    `CLAUDE_CODE_BASH_EDIT_DIFF` and bashEditDiff infra unchanged (4/4 both versions).
- 308 comparison: this IS the 308→309 removal (evidence above).
- OCC status: divergent — OCC still implements the 308 behavior: `src/tools/BashTool/sedEditParser.ts`,
  `src/tools/BashTool/sedValidation.ts`, `src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx`,
  wired from `BashTool.tsx`, `UI.tsx`, `BashPermissionRequest.tsx`.
- maps to changelog item(s): #52 (items.txt) / "#71" in earlier triage numbering
- recommended: PORT — remove the sed-edit simulation path so `sed -i` takes the standard Bash prompt (delete or
  deprecate sedEditParser/sedValidation/SedEditPermissionRequest wiring), keep bashEditDiff infra.

## Finding F-6: `claude ultrareview` now requires workspace trust (prompt / `--trust-workspace` / env disable)
- what: ultrareview refuses to run in an untrusted folder: on a terminal it asks a trust question (300s timeout),
  otherwise it refuses. Scripts pass valueless `--trust-workspace` (a following value is an explicit error) or set
  `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK=1`. Gated by GrowthBook `tengu_twinkly_breeze` (safe:!0).
- official evidence (BIN309):
  - @267724700 (verbatim error): ``Ultrareview did not start: `--trust-workspace` takes no value, but ${_(a)} follows it. If you do not trust this folder, leave the flag out.${n}`` (preceding fragment: "...ch goes before it." = "...number or base branch goes before it.")
  - @267725106: `O=i.CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK`; flow:
    `if(!A&&!O)await vi().catch(()=>{});if(A||!O&&Jr("tengu_twinkly_breeze",{safe:!0})){$L();let N=await k({dir:Ee(),isHomeDir:mC(),canPrompt:A,storageV5:p,answerTimeoutMs:300000,asker:{feature:"cli_ultrareview_workspace_trust",name:"Ultrareview",command:"claude ultrareview",opening:"Ultrareview runs git in this folder to collect your changes:",grant:"This folder's git settings can make git run other programs. Trusting the folder also applies to Claude Code: sessions started here can read, edit, and execute files, and this folder's project settings (hooks, MCP servers, permission rules, helper commands) apply to them.",unattendedRemedy:v0e()?"":" Or, in a script or CI job, pass `--trust-workspace` to trust the folder for this run only."}})`
  - env name @127972744 (UTF-16 registry); also listed in env scrub-allowlist @244216258
  - telemetry: `g("cli_ultrareview_workspace_trust",{trust_source:b("flag")})`
- 308 comparison: env name and all trust strings absent from BIN308.
- OCC status: absent — `src/cli/handlers/ultrareview.ts` has zero "trust" references;
  `--trust-workspace` / `DISABLE_ULTRAREVIEW_TRUST_CHECK` nowhere in repo (ultrareview command itself exists:
  src/commands.ts, src/cli/handlers/ultrareview.ts).
- maps to changelog item(s): #53
- recommended: STAGED — the flag parsing, error text and env disable are directly portable, but the interactive
  asker is the shared workspace-trust dialog subsystem (`k({dir,isHomeDir,canPrompt,storageV5,...})`), which OCC
  has not ported (cross-check: triage-T3 item 53 — `offerBridgeWorkspaceTrust` absent). Port refusal/flag/env
  half now; interactive prompt when the trust-dialog subsystem lands. Treat the GrowthBook gate as default-on
  (`safe:!0`).

## Finding F-7: Disk-full (ENOSPC/EDQUOT) handling — clear startup error + Bash cut-off/inode messages naming the folder
- what: (a) startup: if Claude Code's temp dir can't be created due to ENOSPC/EDQUOT, a clear error names the
  volume and CLAUDE_CODE_TMPDIR instead of a raw ENOSPC; (b) Bash: a command cut off by a full disk says so,
  names the temp folder, reports free MB (statvfs bavail*bsize < 10MB threshold) or free inodes, and appends
  advice j9.
- official evidence (BIN309):
  - startup, module dump @240105600 (string @240106440 / UTF-16 @129654316), verbatim:
    `if(Rst(o)){let s=E(o),c=s==="EDQUOT"?`your disk quota on the volume holding ${n} is used up (${s})`:`the volume holding ${n} is full (${s})`;throw new R(`Claude Code's temporary directory ${r} could not be created: ${c}. Free space on that volume, or set CLAUDE_CODE_TMPDIR to a directory on another one, then try again.`,"claude temp dir not created: volume full (ENOSPC/EDQUOT)")}`
    with `Rst(n){return e==="ENOSPC"||e==="EDQUOT"}`
  - Bash cut-off @249267424 (verbatim template): ``Disk full: this computer's volume holding ${r} (Claude Code's temporary directory) has ${H} MB free, ${h} ${j9}``
    where `${h}` = `this computer's disk quota is used up (${Ss})` or `this computer's disk is full (${Ss})`
  - j9 (same module, verbatim): `j9="Free space on that volume, or restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another one, then retry. If this is the user's own computer, tell them before deleting anything to make room."` (const `eco=5000`)
  - inode variant: ``Nearly out of inodes: ... has ${w.ffree} free inodes, so creating files there may fail and the command may have failed for that reason. ${j9}``
  - `...and its own writes may have failed with "No space left on device".` — s1:0 → s2:3
  - error-class set: `_Se=new Set(["ENOSPC","EDQUOT","ENFILE","EMFILE"])`
- 308 comparison: all of the above s1:0 (new). "The command was not started: ..." variant is pre-existing (2/2).
- OCC status: absent — `src/tools/BashTool/BashTool.tsx:944-949` only has ENOSPC/EDQUOT comments about
  temp-output-file delete semantics; no "Disk full" messages, no statvfs free-space/inode checks, no startup
  temp-dir ENOSPC error.
- maps to changelog item(s): #46
- recommended: PORT — high user value, fully specified texts; port startup throw + Bash cut-off/inode messages
  verbatim (including j9 advice string).

## Finding F-8: Hooks JS-module load failure now names the file ("ran out of stack linking")
- what: When a hooks module (or its import chain) is nested too deep to link, the error names the file via
  `S.identifier` instead of a bare stack-overflow message.
- official evidence (BIN309): @243816148 (UTF-16 @128353853), verbatim:
  ``(`${p}: ${Zo(a,S.identifier)}: the engine ran out of stack linking the file and its imports (code nested too deep, or a chain of imports too long): ${j.message}`)``
  adjacent VM linking code: `function H(S){if(S.status==="errored")throw S.error;if(S.status==="linked"){...S.evaluate(s)...}`
- 308 comparison: s1:0 → s2:2 (new).
- OCC status: N-A surface — OCC has no JS-module hooks engine (`SourceTextModule` / "hooks module" absent from
  src/); OCC hooks are shell commands.
- maps to changelog item(s): #45
- recommended: STAGED — error path belongs to the ESM hooks-module VM linker (`SourceTextModule`) which OCC has
  not ported; carry this verbatim message when/if JS hooks modules land (cross-check: triage-T3 item 45).

## Finding F-9: /privacy-settings shows an explicit failure message when settings can't be fetched
- what: New companion string to the existing fallback: on fetch failure the command prints "Unable to fetch your
  privacy settings at this time. Check https://claude.ai/settings/data-privacy-controls" and returns, instead of
  silently showing a stale value.
- official evidence (BIN309): @284071377 (UTF-16 @131215172), verbatim:
  `var p="Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls",d="Unable to fetch your privacy settings at this time. Check https://claude.ai/settings/data-privacy-controls"`
  usage: `let i=await Iee(s.credentials);if(!i.success){t(d,{display:"system"});return}let n=i.data,m=n.grove_enabled?"true":"false"`
- 308 comparison: `d` string s1:0 (new); `p` pre-existing; /privacy-settings command registration pre-existing.
- OCC status: partial — `src/commands/privacy-settings/privacy-settings.tsx:6` has FALLBACK_MESSAGE (= official
  `p`) and 2.1.304-era errorStatus plumbing (`src/services/api/grove.ts:41-48`), but NO user-facing "Unable to
  fetch" message on failure.
- maps to changelog item(s): #24
- recommended: PORT — one string + one failure branch in the existing command.

## Finding F-10: Feedback — organization refusal shows the server's reason; oversized reports resend without transcript
- what: (a) When the org doesn't accept feedback, the server's `refusal.serverMessage` is shown (fallback "Your
  organization does not accept feedback."), replacing generic "try again later"; policy-blocked orgs get "Feedback
  is disabled by your organization's policy."; credential refusal keeps the draft queued ("The draft is still
  queued."). (b) An oversized /feedback payload is resent without the transcript instead of failing.
- official evidence (BIN309): @258326955 (UTF-16 @120418212), verbatim:
  `function yxe(e){...if(e.refusal?.kind!=="org")return;return e.refusal.serverMessage??"Your organization does not accept feedback."}`;
  `CYt` → `Couldn't send feedback: ${s}`; policy_blocked → `zne()??"Feedback is disabled by your organization's policy."`;
  resend entry: `async function Zit({draft:e,includeTranscript:r,currentSessionMessages:T,surface:u="cli",via:s="panel",...})`;
  "Feedback payload too large. Try again without the transcript, or shorten the details." is pre-existing (2/2) —
  the resend wiring around it is what's new.
  - refusal classifier (cross-check: triage-T4 item 66, new-in-309, BIN309 @120414500–120418500): error codes
    `feedback_retention_blocked`/`feedback_disabled`/`feedback_third_party_blocked`/`oauth_scope_insufficient`/
    `feedback_check_unavailable` → `failureReason` `zdr_org|org_refused|scope_refused|auth_refused|http_error`
    + `refusal{kind,serverMessage}`.
- 308 comparison: yxe/CYt/Zit strings s1:0 (new).
- OCC status: divergent — `src/components/Feedback.tsx:217-219` still shows the pre-fix behavior:
  'Feedback collection is not available for organizations with custom data retention policies.' and
  'Could not submit feedback. Please try again later.'; no refusal.serverMessage path, no draft-queued message,
  no automatic resend-without-transcript.
- maps to changelog item(s): #25, #26 (and VSCode #66 same root fix)
- recommended: PORT — replace the generic error with the server-reason chain + add the oversized resend.

## Finding F-11: ctrl+o transcript shows other agents'/sessions' messages "Waiting to be delivered"
- what: The transcript view (ctrl+o) gains a dimmed "Waiting to be delivered" section listing full messages from
  other agents/sessions not yet delivered, deduped against transcript rows, with `transcript_waiting_messages`
  telemetry on first render.
- official evidence (BIN309): @274929797 (UTF-16 @120102976), verbatim component body:
  `xo=()=>{if(wo)g("transcript_waiting_messages")}` … `zo=e(n,{dimColor:!0,children:"Waiting to be delivered"})` …
  `ln=fo.rows.map(xMt)` … `co=r(s,{flexDirection:"column",marginTop:1,children:[zo,ln]})`;
  dedupe: `function yLe(h,x,D,H){let J=new Set(x),be=[...H&&h.transcriptLength===D?h.rows.filter((He)=>!J.has(He)):[],...x];return ...}`
- 308 comparison: "Waiting to be delivered" s1:0; `transcript_waiting_messages` s1:0 → s2:3 (new).
- OCC status: absent — no "Waiting to be delivered" / waitingToDeliver in repo; transcript components exist
  (src/components/VirtualMessageList.tsx, Messages.tsx) without the waiting section.
- maps to changelog item(s): #15
- recommended: PORT — self-contained UI addition; port the header text, dimColor styling, dedupe logic and
  telemetry event name verbatim.

## Finding F-12: Skill name collisions now offered as `<folder>:<name>` instead of being unreachable
- what: When a skill in an --add-dir folder collides with an already-registered name, it is offered under a
  qualified name `EM(folder,name)` = `` `${folder}:${name}` `` with scoped descriptions, and the collision is
  logged ("is not offered: another skill would share the name").
- official evidence (BIN309):
  - qualifier, verbatim: `function EM(e,n){return`${e}:${n}`}` plus `aDt(e,n){return e.type==="prompt"&&e.loadedFrom!=="syncedSkills"&&e.unqualifiedName===n}`
  - log @251219951 (UTF-16 @126465341): ``t(`[skills] ${$c(yo)} is not offered: another skill would share the name`)``
  - scoping descriptions (`vdr(e,n,r,s)`), verbatim:
    ``scoped to ${n}/ — use this instead of the unscoped "${e.name}" skill when the files being changed are under ${n}/``
    and ``from ${n}/.claude/skills — applies when working on files under ${n}/``
  - folder derivation `CTe(e)` = skillRoot before `${sep}.claude${sep}`; telemetry `BD(EM(...),"is not offered")`,
    `xTe({name,path,change:"path"})`; selection: `Bn=pn!==null&&UHt()&&YX(EM(pn,on.name))||!Yln(on,pn)?null:pn`
- 308 comparison: all collision-offering strings s1:0 (new).
- OCC status: divergent — OCC implements only the 2.1.186-era shadow passes
  (`src/skills/loadSkillsDir.ts:263-326`: drop bundled/fallback skills shadowed by same-named ones); no
  qualified-name offering (`unqualifiedName` appears only in a comment, `src/tools/SkillTool/SkillTool.ts:663`).
- maps to changelog item(s): #27 (related: #28 nested-package skill discovery)
- recommended: PORT — add the `<folder>:<name>` qualified offering + log + scoped descriptions; keep existing
  shadow passes (official keeps both).

## Finding F-13: New env `CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS` — resume shows interrupted tool calls (killswitched)
- what: Opt-in env (===true) enabling display of cut-off tool calls when resuming a session: tail kind
  "interrupted_prompt" with `cutOffCalls{shown,hidden,inTurn,repeatsPrevious}` telemetry; disabled by
  GrowthBook killswitch `tengu_mutable_phoenix_killswitch` and by CG()/IQt() predicates.
- official evidence (BIN309): env name @121791564; usage @242532595, verbatim:
  `function hZo(){return i.CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS===!0&&IQt()&&!CG()&&!k("tengu_mutable_phoenix_killswitch",!1)}`;
  telemetry shape @250802944.
- 308 comparison: absent from BIN308 (true-new env).
- OCC status: absent — no cutOffCalls / cut_off_calls / RESUME_SHOWS_CUT_OFF_CALLS in repo.
- maps to changelog item(s): none (unlisted; sibling of runner item #49's "outcome unknown" concept)
- recommended: STAGED — experimental, env+killswitch gated; port only after the resume-tail taxonomy it depends
  on is tracked in OCC.

## Finding F-14: New env name `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MSG` — registry-only, no code usage in 309
- what: The name appears exactly once in BIN309, in the UTF-16 string pool (@125566540); no JS-region reader.
  The sibling `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is pre-existing and fully wired: registry map
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:()=>Fx` (@240057130), SDK-env read
  `let We=mu(I.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS),bs=Number.isFinite(We)&&We>=0?We:s$t` (@266946035,
  default `s$t=600000`), and the print-mode drain warning @277303129, verbatim:
  ``process.stderr.write(`Background tasks still running ${un(H,{hideTrailingZeros:!0})} after the last turn (${eb(s)}); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n`)``
  gated by `tengu_print_ceiling_stop_agents` (default !0).
- 308 comparison: MS variant, warning text and gate are all pre-existing (2/2); only the MSG name is new (309-only).
- OCC status: absent — no windDown/bgWaitCeiling/PRINT_BG_WAIT anywhere in src/ (the whole print-mode bg-wait
  ceiling feature is an OCC gap vs 308 already, not a 309 delta).
- maps to changelog item(s): none
- recommended: N-A — no locatable behavior change in 309 (name registered but unread); if OCC ever ports the
  print-drain ceiling feature, port the MS semantics above and re-check MSG.

## Finding F-15: New env `CLAUDE_CODE_SYNC_PLUGINS_DOWNLOAD_CONCURRENCY` — plugin/skill sync download limiter
- what: Caps concurrent downloads when syncing plugins/skills from claude.ai:
  `To=i.CLAUDE_CODE_SYNC_PLUGINS_DOWNLOAD_CONCURRENCY??Ofe` then `Promise.all(fn.map(Aa(To,...)))`, with failure
  causes download/root_refused/extract/local/deferred.
- official evidence (BIN309): env name @121791092; usage @249654931 (verbatim above).
- 308 comparison: absent from BIN308.
- OCC status: absent — OCC trimmed the claude.ai plugin-sync surface; no sync-download concurrency code.
- maps to changelog item(s): adjacent to #34 (synced plugins/skills removal after disk read error)
- recommended: STAGED — only meaningful once/if OCC ports claude.ai plugin sync; pin the env name then.

## Finding F-16: Self-hosted runner "outcome unknown" for interrupted tool calls — strings pre-existing, wiring-only change
- what: The toldAs map (`withdrew`/`timed_out`/`still_running`/`delivery_unknown` → "was reported with its
  outcome unknown"/`interrupted`) exists identically in 308 and 309 (2/2); 309's improvement is wiring
  (which sessions get the correction), inside Anthropic's self-hosted runner infrastructure.
- official evidence: verbatim map in both binaries:
  `most likely not run (it was withdrawn while this session was backed up)",timed_out:"was reported as unanswered (that machine did not answer in time)",still_running:"was reported as still running there",delivery_unknown:"was reported with its outcome unknown",interrupted:"was reported as interrupted"}[e.toldAs];return`Correction: the ea...`
- 308 comparison: identical (2/2) — NOT a new string family.
- OCC status: N-A — OCC has no self-hosted runner.
- maps to changelog item(s): #49 (also #43)
- recommended: N-A — runner-infrastructure wiring; nothing portable identified.

## Finding F-17: Sandbox startup-files fix (#1) — no portable JS delta found
- what: Changelog #1 (shell startup files ran outside the sandbox before each command) leaves no new
  user-visible strings: sandbox snapshot messages are 2/2 across versions, BASH_ENV occurrences 10/10. The fix
  lives in the native sandbox-exec/landlock layer or in unchanged-text code paths.
- official evidence: none new (that is the finding); checked snapshot/BASH_ENV/startup-file phrase families in
  s1 vs s2 — no 0→N transitions.
- 308 comparison: n/a.
- OCC status: OCC's sandbox port would need the native-side diff, out of scope for string forensics.
- maps to changelog item(s): #1
- recommended: N-A — no portable evidence to port from strings; track via sandbox code diff if OCC's sandbox
  layer is ever audited (items #2, #3, #40, #55 similar: native/permission internals, no new portable strings).

## Finding F-18: Pure-Anthropic-surface items (no OCC counterpart) — N-A one-liners
- `CLAUDE_CODE_CCR_OWN_CONNECTION_POOL` (new env @121790900) — CCR = Claude Code Remote cloud infra — N-A.
- `CLAUDE_CODE_ARTIFACT_SHARE_PROBE_REUSE_MS` (new env @123580908) + artifact items #35/#36 — artifacts backend — N-A.
- Slack / Claude Tag items #73-#77 — Slack integration surface — N-A.
- VSCode items #58-#67 (incl. #61 long slash-command folding, #63 Ctrl+J, #67 edit-problem wait 0.75s) — extension code, not in the CLI binary's portable surface — N-A.
- Cloud sessions items #68-#72 — claude.ai cloud UI — N-A.
- Code Review items #78/#79 — GitHub App backend — N-A.
- claude-api skill items #29/#30/#31/#47/#48/#51/#57 and dataviz item #50 — bundled skill *content* (synced separately, not binary logic) — N-A for binary alignment; OCC bundled-skill text can be refreshed when skills sync is ported.
- Item #54 (rm/rmdir rewrite hint) — Desktop app/VSCode bypass-mode surface; the only "rewrite" strings in the diff are hooks rewriteRefused plumbing — N-A.
- Items #18/#19/#22 (Claude Desktop-hosted sessions), #20 (remote-control status line), #37 (Bedrock fine-grained streaming default endpoint) — cloud/vendor-route behaviors; #37 is technically portable but only affects `ANTHROPIC_BEDROCK_BASE_URL` default-endpoint detection: STAGED-note (verify OCC Bedrock route predicate if Bedrock support is tracked; no new user-visible strings).

## Finding F-19: macOS Command Line Tools — proactive fs-based check replaces reactive dialog trigger (from triage-T3 item 42)
- what: 308 opened the "Install Command Line Developer Tools" dialog reactively on each start when Xcode/CLT was
  missing; 309 adds an fs-based proactive check with an explicit `xcode-select --install` guidance message.
- official evidence (BIN309): verbatim message region @240801195 (full text and predicate in
  `/tmp/cc-diff-309/triage-T3.md`, item 42).
- 308 comparison: reactive-only path (triage-T3 item 42).
- OCC status: reactive only — `officialMarketplaceStartupCheck.ts:369` (per triage-T3).
- maps to changelog item(s): #42
- recommended: PORT — macOS-only startup check; port the fs probe + verbatim message when touching startup path.

## Finding F-20: CLI CA-store diagnostics rework (from triage-T4 handoff note)
- what: 309 reworks the CLI certificate-store failure diagnostics: new explicit messages for an empty/untrusted
  system CA store and for an all-expired CA store.
- official evidence (BIN309): new strings ~@129588000 region: "No certificate authority to trust…",
  "every certificate in the system CA store is expired…" (detail in `/tmp/cc-diff-309/triage-T4.md`, item 58 note).
- 308 comparison: absent (new-in-309 per triage-T4).
- OCC status: absent — OCC `caCerts.ts` lacks these diagnostics.
- maps to changelog item(s): adjacent to #58 (VSCode item) but this half is CLI-side and portable
- recommended: PORT — network/TLS diagnostics are fully in OCC's surface; port the two message paths verbatim.

---

## Negative findings (verified non-deltas)
1. **Slash-command registry unchanged**: 99 commands extracted from each binary (cmds308.txt/cmds309.txt) — zero
   added, zero removed in 309.
2. **No new settings.json keys identified**: NEWSTR key-shaped sweep surfaced only generic/pre-existing names
   (userSettings, enabledPlugins, disableAllHooks, allowedMcpServers…); `streamIdleTimeoutSec` managed setting is
   pre-existing (s1:2/s2:2).
3. **Minifier false positives in the raw new-strings diff** (present in 308, do NOT port as "new"):
   `CLAUDE_CODE_GATEWAY_HINT_HEADERS` (usage byte-identical: 309 @244456161 vs 308 @243601000,
   `U3n()` with `tengu_splendid_sutton`), `CLAUDE_CODE_SIMULATE_PROXY_USAGE`, the 45000/idle-interval spinner
   consts (`Un=[1e4,45000,300000]`, `Qn=45000` — identical both versions; only F-1's stall delay changed),
   "Extra seconds to wait for model output..." (managed-setting help, 2/2), "The command was not started" (2/2),
   "Feedback payload too large..." (2/2), and trailing-char env artifacts (e.g. `..._FALLBACKJ`).
4. **"Waiting for API response" banner text and spinner constants are pre-existing** — F-1 is strictly the delay
   selection change (fixed 20000 → `Gce()?20000:45000`).

## Port priority summary
| # | Finding | Verdict |
|---|---------|---------|
| F-1 | 45s route-dependent stall hint | PORT |
| F-2 | git English errors (LC_ALL/LANGUAGE + userLocale) | PORT |
| F-3 | git env hardening (replace refs, frozen sets, scrub) | PORT |
| F-4 | worktree lazy-fetch off + partial-clone messaging | STAGED |
| F-5 | sed -i preview removal | PORT |
| F-6 | ultrareview workspace trust | STAGED (flag/env/refusal portable now; asker subsystem unported) |
| F-7 | disk-full ENOSPC/EDQUOT messages | PORT |
| F-8 | hooks module-too-deep error | STAGED |
| F-9 | privacy fetch-failure message | PORT |
| F-10 | feedback org reason + oversized resend | PORT |
| F-11 | ctrl+o "Waiting to be delivered" | PORT |
| F-12 | skill `<folder>:<name>` offering | PORT |
| F-13 | RESUME_SHOWS_CUT_OFF_CALLS | STAGED |
| F-14 | PRINT_BG_WAIT_CEILING_MSG (registry-only) | N-A |
| F-15 | SYNC_PLUGINS_DOWNLOAD_CONCURRENCY | STAGED |
| F-16 | runner outcome-unknown wiring | N-A |
| F-17 | sandbox startup-files (native, no strings) | N-A |
| F-18 | cloud/VSCode/Slack/skill-content items | N-A |
| F-19 | macOS CLT proactive check | PORT |
| F-20 | CLI CA-store diagnostics | PORT |

Companion per-item triage (changelog-driven, same evidence rules): `/tmp/cc-diff-309/triage-T1-A.md` (items
1-3,11), `triage-T1-C.md` (items 8-10), `triage-T2.md` (items 17-40), `triage-T3.md` (items 41-57),
`triage-T4.md` (items 58-79). Items 4-7 triaged inline in-session: STAGED×4 (MCP/Bash permission internals).
