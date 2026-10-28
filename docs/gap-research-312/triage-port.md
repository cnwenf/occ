# Triage — PORT items (official claude-code 2.1.312, OCC-136 round)

Byte evidence per ported changelog item. Offsets are byte offsets in the official ELFs:
v311 = `@anthropic-ai/claude-code-linux-x64@2.1.311` (md5 `e41a6ebc58e3e5ccf4d4544d910d0bdb`),
v312 = `…@2.1.312` (md5 `be77f401c2b9c1c79c98f828abe8a6e7`). "new-in-312" = `strings -n 8 |
sort -u` hit count 0 in v311, ≥1 in v312. All strings were re-verified verbatim before landing.

## Item 2 — click to send (WP-A)

> Added click to send: in fullscreen, clicking the "to send now" hint under a queued message sends it right away, as its key does

- new-in-312: `"click to send now"` (@129059798 string table / @275853182 code), `input_send_now_click` (telemetry), `no_handler_took_it`.
- Official @275853182: press handler only when fullscreen (`iH()==="full"`):
  `He=H===null||iH()!=="full"?void 0:()=>{if(H())g("input_send_now_click");else m("input_send_now_click","no_handler_took_it")}`;
  label `We=D===""?"click to send now":BT({chord:D,action:"send now",…})`; rendered pressable (`onPress:He`).
- OCC pre-state: `SendNowHint` (PromptInput.tsx) returned null when no chord — hint invisible/keyboard-only. Click infra already vendored (ink Box `onClick`).
- Landed: `src/utils/sendNow.ts` pure resolvers + `SendNowHint` pressable in fullscreen; literal `click to send now`; telemetry via OCC's established `logEvent` emitter. Tests: `sendNowHintClick312.test.tsx` (8).

## Item 4 — Write guard after context-seeded head cut (WP-F)

> Fixed Claude overwriting a very large CLAUDE.md, rules file or @-included file in a subdirectory after seeing only its start; Write now asks Claude to read it all or edit in place

- new-in-312 guidance message `e7o` @241153414: `` `You were given only the start of this file, and nothing shows that you have since read all of it in one call, so a Write could lose the rest. To change part of it, use ${it}. To replace it whole, first Read it in one call with no offset or limit. If Read returns only a page or says the file is too large, Read it again with ${Dee}: true. If even that cannot return all of it, use ${it}.` `` with `it="Edit"`, **`Dee="allow_large"` resolved** @240867736 (`var Ve="Read",Dee="allow_large",…`).
- Eviction-proof read-state set `Sa` @244819043: `startOnly=new Set; markStartOnly(e){this.startOnly.add(rn(e))}; holdsOnlyStartOf(e){…return this.startOnly.has(n)&&!Yoe(this.cache.get(n))}`; predicates `Yoe` @244818076 (≡ OCC `isFileStateFullyTrusted`), `CR` @244818957 (≡ OCC `isFullReadOfFileState`).
- Write validateInput @249830441: `if(s.readFileState.holdsOnlyStartOf(G))return{result:!1,message:e7o,errorCode:19}` — BEFORE the not-read branch (errorCode 19 new). Call-path throw @249832895: `if(h.holdsOnlyStartOf(G))throw new BX(e7o)`.
- Marking site (ported) @251721817: nested memory/@-include head cut, gate `tengu_quizzical_mango` default **true** → `ze?.markStartOnly(G.path)` when content was cut. Watcher @251734727: changed file that `holdsOnlyStartOf` re-seeds with `contentNotInModelContext:!0`.
- **STAGED sub-part**: `tengu_velvet_possum` top-level CLAUDE.md cut @257559298 (gate default **false** upstream) + `announced_file_cut` telemetry — not ported (contested/experiment).
- OCC pre-state: only the generic errorCode-2 refusal via `isPartialView` on the LRU entry (eviction loses the block; no corrective guidance).

## Item 5 — skills discovery survives `cd` (WP-G)

> Fixed per-directory and `paths:` skills not being found after a Bash `cd` deeper into a git repository

- v311 (buggy) @251543607: trigger base = raw live cwd `fe()`; discovery walk @251540112 bounded by live cwd (`while(Q.startsWith(y+zy))`); `paths:` activation skips `..`-relatives.
- v312 (fixed) trigger `Sq` @251527988: stable base `H` = original cwd when the cd stayed inside the same git worktree (`ZG` containment + `ir` worktree-root agreement), `{cwd,workTree}` ctx threaded down.
- v312 discovery @251524152: three-state check for dirs not below ctx.cwd (confirmed → load; gitignored → skip; unconfirmed → `deferredSkillDirs.set(dir, base)` + skip, stale-base eviction, `clear()` on reset). new-in-312 strings: `[skills] Skipped gitignored or unconfirmed skills dir: …`, `[skills] Skipped skills dir with an unconfirmed target: …`.
- OCC pre-state replicated the 311 bug 1:1 (`loadSkillsDir.ts:1622` walk bound = live `getCwd()`; `:1771` `..`-relative skip).
- Unpinnable (documented): `vN()`/`Ee()` exact semantics inferred (original/launch cwd); `fSn`/`CEe` internals pinned via call shape only.

## Item 8 — cleanup rmdir race vs fresh PDF render dirs (WP-H)

> Fixed the Read tool sometimes failing on PDF pages with "pdftoppm failed: Could not write image" when the clean-up of old session files ran at the same time

- PDF extraction code byte-identical 311→312 (identifier-normalized ±1500 B windows around all 9 `pdftoppm` hits + difflib of the extraction regions → 0 structural ops). The fix is cleanup-side @259860697:
  - 311: unconditional `await T(ee,n)` / `await T(L,n)` (tool subdir, tool-results dir).
  - 312: `if(ne.length>0||await Q(q,n).catch(()=>1/0)<e.getTime())await T(q,n)` (+ same for tool-results) — rmdir only when leftovers exist OR dir mtime < cutoff; fresh empty dir survives. `T` @259853708 (exists→rmdir, swallowed), `Q` @259855632 (`lstat().mtimeMs`).
- OCC pre-state: `cleanup.ts:286/:289` unconditional `tryRmdir` — exact race with `pdf.ts:246` (`mkdir pdf-<uuid>` then pdftoppm writes).
- Not folded (unrelated same-chunk delta): history-cleanup signature-file truncation (`dns`/`cns` @239646772 region). Outer session/project rmdirs left unguarded (not pinned in the official delta).

## Items 9 + 16 — `sentEffort` in-force effort state (WP-A, folded: one change)

> 9: Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force
> 16: Improved the prompt's effort indicator: a change made mid-task now says it may wait for your next message, and the note clears when it no longer applies

- new-in-312: `sentEffort` (11 hits), `setSentEffort` (6 hits); 0 in v311.
- Spinner suffix builder gained a 4th param — v312 `Sbn` @243469955: `let f=s??kS(e,n,{turnEffort:r})…return\` with ${e6(U0(f))} effort\``; v311 `cbn` @243589087 was 3-param (picked value only).
- Store reset @259429372 adds `sentEffort:null`; stream handler @277260243: `message_start` → `setSentEffort(h.sentEffort??null)`, assistant → `if(h.effort!==void 0)setSentEffort(h.effort)`; query-engine emit @251161309 `{sentEffort:Yh}`.
- Indicator template UNCHANGED 311→312 (`EH` @275881776 ≡ `xH` @274520391): `` `${D?"effort:":jQ(h)} ${h}${x?" · ultracode":""} · ${H?"may wait for your next message":"/effort"}` ``; the 312 delta is the caller's flag @276688231: `uT=tre!==null&&QNe===null&&tre!==_D&&JEt(In)` (sent≠null ∧ turnEffort==null ∧ sent≠resolved ∧ model supports effort; `JEt` @243468953).
- NAMING TRAP recorded: OCC's pre-existing `getSentEffortLevel` ≡ official resolver `kWe` — the new state slot is `getSentEffort`/`setSentEffort` (`src/utils/effort/sentEffort.ts`).
- Landed: slot + wire capture (`claude.ts` message_start `sentEffort`, assistant `effort`) + REPL population/reset + 4-param `getEffortSuffix` + Spinner + `isEffortChangePending`/may-wait note. Official 10 s transient notification machinery (`Ta`/`$i`/`key:"effort-level"`) deliberately NOT adopted — OCC keeps the steady borderText (2.1.200 reduction); "note clears" is free because borderText is derived per-render.
- Honest gaps: OTel-leg is covered only up to the assistant-message `effort` field (the official span attribute line is identical 311/312 → not a 312 delta; OCC's OTel is stubbed anyway); 311's may-wait flag `dAt` expression not pinned (312's `uT` fully pinned — port unaffected).

## Item 14 — vim `gj`/`gk` rowsRunOut (WP-B)

> Fixed vim mode `d`, `c` and `y` with a `gj` or `gk` count larger than the lines left deleting or copying text; like Vim, they now only move the cursor

- new-in-312: `rowsRunOut` (0 → 4 hits). Official operator fn `q` @259579735: `if(e==="gj"||e==="gk"){let u=le(e,r,n);if(u.rowsRunOut){n.setOffset(rQ(n.cursor,u.offset));return}}` — move-only, no delete/change/yank, no recording.
- Helper `le` @259587549: `c=(t==="gj"?o.length-1-i:i)<e` (wrapped-lines count, current line, count; strict `<` — count == rows left proceeds normally). `rQ` = clampOffset + `snapOutOfPlaceholder` fallback (`Ale` verified byte-identical to OCC's `clampOffset`).
- Landed: guard in `executeOperatorMotion` (`src/vim/operators.ts`); tests `gjGkRowsRunOut312.test.ts` (9, incl. strict-`<` controls).
- Deviation (documented): `le`'s wantedColumn recomputation not ported — OCC's `resolveMotion` down/up already preserves display column and clamps per step (OCC carries no separate wantedColumn state).

## Item 15 — /verify short menu description (orchestrator-direct)

> Fixed `/verify` showing a long description meant for Claude in `/help` and the `/` command menu instead of a short one

- new-in-312: `"Try your change and report if it works"` (0 → 2). Official registration @258727734: `ol({name:Cue,description:zi,menuDescription:"Try your change and report if it works",userInvocable:!0,…})`.
- OCC pre-state: `/verify` shipped as bundled skill WITHOUT `menuDescription` (plumbing existed since 2.1.307 B7). Landed: `src/skills/bundled/verify.ts` + tests `verifyMenuDescription312.test.ts` (3).

## Item 20 — "session limit" → "5-hour limit" + Over% branch (orchestrator-direct)

> Changed usage limit messages to call the 5-hour window the "5-hour limit" instead of the "session limit"

- Display map: v311 `wce={five_hour:"session limit",…}` @246735413 → v312 `Hce={five_hour:"5-hour limit",…}` @246569205.
- Sub-delta (new-in-312, folded here): early-warning formatter `$t` @246574430 adds `m=n?void 0:Ke(e.surpassedThreshold)` and branch `` n?`You've used ${n}% of your ${r}`:m?`Over ${m}% of your ${r} used`:`Approaching ${r}` `` with `Ke` @246573773: `if(e===void 0||!Number.isFinite(e)||e<=0||e>=1)return;return Math.min(99,Math.floor(Math.round(e*1e4)/100))` (both 0 hits v311, 1 hit v312).
- Related renames new-in-312: `Reset your 5-hour limit now` (×3), `Continue now at lower priority after reaching your 5-hour limit; run again to stop` (×2) — these live on the official `tengu_nifty_lemur` reset-limit command surface (v311 said "session limit" there); **OCC does not ship that command → N-A for OCC** (recorded, not ported).
- Official classifier legacy fallback `if(c(d.five_hour)||c("session limit"))return"session"` — OCC has no such text classifier (prefix matcher keys on `You've hit your` etc., rename-proof) → nothing to port.
- Pre-existing divergence NOT touched (identical in v311/v312 → out of scope): OCC overage wording `extra usage` vs official `usage credits`/`usage credit limit`.
- Landed: `claudeAiLimits.ts` map + `rateLimitMessages.ts` (3 sites) + `clampSurpassedThreshold` (≡ `Ke`) + Over% branch with official `base · resets · upsell` join; tests `rateLimitMessages312.test.ts` (15) + 299-test expectations retargeted.

## Item 22 — hook concurrency 24 session + 12 overdue + 1 s floor (WP-E)

> Changed prompt and agent hooks to run at most 24 at a time per session, sub-agents included, plus at most 12 that have waited longer than their event's timeout; a `timeout` under 1 second now counts as 1 second

- new-in-312 @251761428: `var Wet=12,kvn=24,fEr=12,pEr=1,bvn=1e4;class Rvn{slots=new byt;holder=new cEr}…Uet="model hooks",mEr="overdue model hooks";function zB(e){return e.type==="prompt"||e.type==="agent"}function BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}`.
- Two-tier seating `wvn`: fast path `occupy` when `!slots.wouldWait(Uet,kvn)`; else bounded wait (`waitLimitMs` = session ctx `limitMs`); `seated===!1` → `slots.acquire(mEr,fEr,…)` (overdue pool). Semaphore `byt` @250558442, bounded waiter `P0r` @250558987. ALS holder (`cEr`) shares the 24 seats session-wide (sub-agents included) with reentrancy guard.
- v311 had only the single-tier cap-12 stagger (OCC's 2.1.302 port `promptAgentConcurrencyCap302.ts`).
- Landed: `src/utils/hooks/hookSessionSlots312.ts` (constants + semaphore + ALS session slots + `hookTimeoutMs` ≡ BM + merge ≡ `Ovn`), caller rewired in `hooks.ts`; 15 new tests; 302 production test retargeted (stagger cap `Wet=12` retained upstream → maxLive=12 assertion still holds).
- Honest notes: floor applies to prompt/agent hooks ONLY (official callback/command/http sites have no floor — untouched); `execPromptHook.ts:157`/`execAgentHook.ts:122` inner derivation fixed in WP-H task 2; remote keepalive stream (`CLAUDE_CODE_REMOTE_SEND_KEEPALIVES`) not portable (same as 302 round); official host-keyed singleton `Mvn.of(host)` reduced to one module singleton (single session/process).

## Item 23 — subagent autoCompactWindow caps the env window (orchestrator-direct)

> Changed a subagent's `autoCompactWindow` to lower the window set by `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, where it had no effect before; it still never raises that window

- v311 `US` @249997782: `if(S.source==="env"||S.window<=w)return S` → v312 `VS` @249961062: `if(S.window<=w)return S` — env exemption deleted (both byte-verified this round).
- Landed: `src/utils/autoCompactWindow.ts` ceiling branch drops `inner.source === 'env' ||`; 296 subagent test inverted + at-or-below-ceiling passthrough case added (43/43 green with the existing window suite).
