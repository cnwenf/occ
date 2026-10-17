# Gap triage — Claude Code 2.1.302, cluster T3

Entries: #02, #03, #12, #13, #15, #16, #17, #20, #22, #24, #33, #34 + trivially-N-A tail #37–#63.

Theme: UI / render / terminal / config / agents-view / footer / system-prompt.

Method: marker-string counts in `/tmp/cc-diff-302/{new_strings,s1s,s2s}.txt` (s1s = v2.1.301 sorted strings, s2s = v2.1.302, new_strings = `comm -13` v301→v302 additions), byte offsets via `grep -aboF` on the two official ELFs (`v301/package/claude` md5 `7f52c3d8eda2796a6002cb7380aabfb9`, `v302/package/claude` md5 `39885c1377a0f0d922b73bf8653a6c3f`, **never executed**), bounded `dd bs=1 skip=OFFSET count=N` excerpts, then OCC-side `grep -rn` under `occ/src/`. Dispositions: **PORT** / **ALREADY-ALIGNED** / **STAGED** / **N-A** / **CAND**.

Disposition summary: **PORT ×1** (#16) · **ALREADY-ALIGNED ×2** (#20, #34) · **STAGED ×2** (#02, #33) · **CAND ×1** (#22) · **N-A ×6** (#03, #12, #13, #15, #17, #24) · **N-A batch ×27** (#37–#63).

---

## #02 — `Idle compaction` row in `/config` + post-idle-compaction notices say how to turn it off

**Changelog:** Added an `Idle compaction` row to `/config` for turning idle compaction off or back on; the notices shown after an idle compaction now say how to turn it off.

**Disposition: STAGED** (whole idle-compaction feature absent from OCC; the two v302 deltas are the final touches on a v2.1.290 feature OCC never ported — deferred with a full feature spec below).

**Marker counts (v301 / v302 / new):**

| marker | v301 | v302 | new | note |
|---|---|---|---|---|
| `Idle compaction` (the `/config` label) | 0 | 2 | 2 | **NEW in v302** — the config row |
| `turn off with "idleCompaction": false in settings.json` | 0 | 2 | 2 | **NEW in v302** — the notice suffix |
| `idleCompaction` | 4 | 9 | 8 | feature pre-exists in v301, expanded in v302 |
| `IDLE_COMPACT` | 6 | 6 | 5 | balanced — feature existed in v301 |
| `Compacted while idle, before the prompt cache expired` | 2 | 2 | 1 | notice text pre-exists (suffix is what's new) |
| `Compacted after an hour idle, using a summary written while you were away` | 2 | 2 | 1 | notice text pre-exists |
| `tengu_sunny_locket` (statsig gate) | 2 | 2 | 1 | gate pre-exists |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | 6 | 6 | 5 | env pre-exists |

**Byte offsets:** v302 `Idle compaction` @122181160 (config-label registry) and @256654344 (config-row builder); `idleCompaction` cluster @256654001–256654637 (config row); notice region @244214408 (`turn off with "idleCompaction"`) / @244214469 (`Compacted while idle`). Feature spec (embedded changelog) v301 @234497900 / v302 @252068900; settings-schema descriptor v301 @217298900.

**dd excerpts — what official idle compaction IS (recovered):**

Embedded changelog (v301 @234497900, v302 @252068900):
```
- Added idle compaction in the terminal: a 200K+ token conversation left idle for about 54
  minutes is compacted before its one-hour prompt cache expires, so your next message doesn't
  reprocess it all
- Added `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` to change idle compaction's 200K-token minimum;
  `"idleCompaction": false` in settings.json turns it off. Both need v2.1.290 or later
```

Settings-schema descriptor (v301 @217298900):
```js
idleCompaction:()=>M().optional().describe("Set to false to stop Claude Code from compacting a
long conversation while the session is idle. Setting it to true does not turn idle compaction on.")
```

Trigger/gate constants + notices + config reader (v302 @244213800):
```js
var i1o=200000,      // default min tokens (200K)
    l1o=1e5,         // floor (100K)
    d1o=0.9,         // default fireAtFraction
    u1o=0.5, c1o=0.95, // fireAtFraction range
    Wye="tengu_sunny_locket",  // statsig gate
    Q2t=` \xB7${h8n}turn off with "idleCompaction": false in settings.json`,  // NEW v302 suffix
    wms=`Compacted while idle, before the prompt cache expired${Q2t}`,          // notice A
    m1o=["log","compact","compact_on_return"],                                  // modes
    vms=`Compacted after an hour idle, using a summary written while you were away${Q2t}`; // notice B
function Y2t(){let e=k(Wye,null),n=a.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS??e?.minTokens;
  return{mode:m1o.find(r=>r===e?.mode)??"off",
         minTokens:V2t(n)?Math.max(l1o,n):i1o,
         fireAtFraction:V2t(e?.fireAtFraction)?Math.min(c1o,Math.max(u1o,e.fireAtFraction)):d1o}}
function Ems(){let e=CWe(Wye)?k(Wye,null):(Fm()||x0r()?r3()[Wye]:null),
  n=typeof e==="object"&&e!==null&&"mode"in e?e.mode:void 0;
  return n==="compact"||n==="compact_on_return"}   // gate for the /config row
function g1o(e,...){if(e.mode==="off")return"disabled";if(!Xp())return"compaction_off";
  if(!Bmt())return"idle_compaction_off";  // Bmt() = idleCompaction setting (default true)
  if(e.mode==="compact_on_return"&&!ROr())return"precompute_compaction_off"; ...}
```

`/config` row builder (v302 @256653700) — the NEW row, gated on `Ems()` (mode is compact/compact_on_return) AND `fo` (setting source is userSettings, or default-with-userSettings-present):
```js
Ue=bs("idleCompaction",!0).source, fo=Ue==="userSettings"||Ue==="default"&&nn("userSettings"),
He=[{id:"autoCompact",label:"Auto-compact",value:s.autoCompactEnabled,type:"boolean",onChange(e){...}},
 ...Ems()&&fo?[{id:"idleCompaction",label:"Idle compaction",value:r?.idleCompaction??!0,type:"boolean",
   async onChange(e){T(l=>({...l,idleCompaction:e}));let o=await P({idleCompaction:e});
     if(o?.error){let l=Bmt();return T(h=>({...h,idleCompaction:l})),{error:o.error}}
     i("tengu_idle_compaction_setting_changed",{enabled:e}),L.toggle("idleCompaction",e)}}]:[], ...]
```
Config-label registry (v302 @122181160) shows `…Auto-compact / Idle compaction / Continue automatically at usage limit…` — the label is inserted right after `Auto-compact`.

**Net v302 change = exactly two things:** (1) the `/config` boolean row `Idle compaction` (id `idleCompaction`, default true, telemetry `tengu_idle_compaction_setting_changed`, controller `L.toggle("idleCompaction",e)`); (2) the suffix `Q2t = " ·turn off with \"idleCompaction\": false in settings.json"` appended to the two pre-existing idle-compaction notices (`wms`, `vms`). **The feature substrate (idle timer, 200K/54-min trigger, `tengu_sunny_locket` gate, modes, env) all pre-exists in v301** (and since v2.1.290).

**OCC-side findings — the entire feature is absent:**
- Confirmed 0 hits in `src/` for `idleCompaction`, `idle compaction`/`Idle compaction`, `IDLE_COMPACT`, `compactIdle`. (`idle-compact` 6 hits are all false positives — the API-retry-budget path in `src/services/api/modelCallRetries.ts` / `withRetry.ts`, unrelated to conversation compaction.)
- `/config` row registry: `src/components/Settings/Config.tsx:266` (`const settingsItems: Setting[] = [ … ]`, ~42 rows); row type shape at `:62-85` (`{id,label,value,onChange,type:'boolean'|'enum'|'managedEnum'}`). Example toggle `Auto-compact` at `:268-286`. Parallel registries a port must also touch: `src/commands/config/config-noninteractive.ts:21-46` (`CONFIG_KEYS`), `src/tools/ConfigTool/supportedSettings.ts:54-58`, config schema `src/utils/config.ts:242/622/667`.
- Existing auto-compaction is **token-threshold only, no idle trigger**: `src/services/compact/autoCompact.ts` (`autoCompactIfNeeded` :307, `shouldAutoCompact` :224, thresholds :84-104), fired at the start of each query turn (`src/query.ts:546`). No timer, no idle detection. (Only `setInterval` in compact services is a WebSocket keepalive at `compact.ts:1251`.)
- Nearest idle-adjacent feature: **"idle return" (willow mode)** — `REPL.tsx:3567-3582` (`IdleReturnDialog` after ≥75 min idle AND ≥100k tokens) and `REPL.tsx:4299-4330` (hint suggesting `/clear`). It only **prompts the user to clear**, never compacts, and is gated on GrowthBook `tengu_willow_mode` default `'off'` (`src/services/analytics/growthbook.ts:734`). The `lastQueryCompletionTimeRef` idle tracker (`REPL.tsx:3570`) is the nearest hook point for a future idle timer.
- Post-compaction notice sites (where the "how to turn it off" suffix would land): `src/components/messages/CompactBoundaryMessage.tsx:322` (`✻ Conversation compacted{compactBoundaryDetail(...)}`) and the transient notification `src/screens/REPL.tsx:5388-5393` (`Conversation summarized…`, `timeoutMs:8000`).

**Gap sizing / staged port plan:** This is a **whole-feature gap, not a config-row gap.** The two v302 deltas are trivial (~15 lines for the row: a boolean `Setting` at `Config.tsx:266`, a `CONFIG_KEYS` entry, a config-schema key, optional `supportedSettings.ts`; plus appending the suffix at the two notice sites). The missing substrate is the bulk of the work: (a) an **idle timer** that fires compaction while the session sits idle (nothing exists — hook off `REPL.tsx:3570` `lastQueryCompletionTimeRef`); (b) a trigger predicate mirroring official `Y2t`/`Ems`/`g1o` (min tokens 200K / floor 100K, ~54-min idle, `fireAtFraction` 0.9, modes `off|log|compact|compact_on_return`, gate `tengu_sunny_locket`, env `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, settings `idleCompaction:false`); (c) plumbing a `trigger:'idle'` flag through `autoCompactIfNeeded`/`compact.ts` so notices can distinguish idle compaction; (d) the two notice strings + suffix. **Recommend a dedicated future round** to port idle compaction as a unit (it is a real behavior — auto-compacting idle sessions before the 1-hour prompt cache expires saves reprocessing the whole conversation on the next message). Complexity of the full feature: **L**; the two v302 deltas alone, once the substrate exists: **S**.

---

## #03 — `/design-sync` `/design-login` Claude Design closing notice

**Changelog:** Added a notice to `/design-sync` and `/design-login` that standalone Claude Design (claude.ai/design) closes by December 14, 2026.

**Disposition: N-A** (OCC has no design commands — batch with #17).

**Marker counts:** `December 14, 2026` v301=0 / v302=3 / new=3 (**NEW**); `design-sync` 20→21; `claude.ai/design` 25→30.

**Byte offsets:** v302 `December 14, 2026` @124901202, @124901374, @242506082, @242506252 (two per site × two design commands).

**dd excerpt (v302 @124900900) — official notice strings (recorded for completeness):**
```
Standalone Claude Design (claude.ai/design) closes by December 14, 2026. Claude Design now lives in Claude.
This sign-in is only for standalone Claude Design (claude.ai/design). It goes away when standalone
closes, by December 14, 2026. Until then it still works, so sign in if /design-sync or /design consent
sent you here.
```

**OCC-side:** `ls src/commands | grep design` → empty; 0 design-command dirs; 0 hits in `src/` for `design-sync`, `design-login`, `/design consent`, `/design revoke`, `claude.ai/design`. OCC has no Claude Design surface at all. → **N-A.**

---

## #17 — `/design consent` `/design revoke` cloud-session message

**Changelog:** Fixed `/design consent` and `/design revoke` suggesting `/design-login` when they fail in a cloud session, where it isn't available; the message now points to claude.ai/design/settings.

**Disposition: N-A** (OCC has no design commands — batch with #03).

**Marker counts:** `claude.ai/design/settings` v301=2 / v302=5 / new=4 (+3); `/design consent` 7→11; `design/settings` 2→5.

**Byte offsets:** v302 `claude.ai/design/settings` @121910863, @121911344, @121911950, @256572705, @256579561, @256580199.

**dd excerpt (v302 @121910600) — official cloud-session messages (recorded for completeness):**
```
/design consent failed in a cloud session:
Couldn't record Design agent access for your Claude Design projects from this cloud session.
Try again, or grant it at claude.ai/design/settings and then retry your Design request.
/design revoke failed in a cloud session:
Couldn't revoke Design agent access for your Claude Design projects from this cloud session.
Try again, or revoke it at claude.ai/design/settings.
```
(non-cloud path still reads `…Try again, or run /design-login to authorize Claude Design for this account.`)

**OCC-side:** none — no design commands (see #03). → **N-A.**

---

## #12 — desktop app MCP authorize/reconnect pointing at claude.ai settings or `/mcp`

**Changelog:** Fixed Claude in the desktop app pointing you to claude.ai settings or `/mcp` to authorize or reconnect an MCP server where that option isn't available.

**Disposition: N-A** (desktop-app surface absent — OCC is the CLI/terminal, not the Electron desktop app).

**Marker counts:** `isn't available` v301=116 / v302=118 / new=53 (+2 net; the surface-adaptive reconnect messaging churned).

**Binary evidence (v302, MCP reconnect messaging recovered via `grep -aoiE`):** the official reconnect message adapts to the surface —
```js
`${P} disabled.`+(H>0&&!o?" Reply `/mcp reconnect all` here to retry.":"")+(o?h(" Use `/mcp` in the term…
```
i.e. when `o` (the desktop/remote surface where `/mcp` isn't available) it swaps the `/mcp`-in-terminal guidance for a different remedy; the fix removes the bogus "claude.ai settings or `/mcp`" pointer on the desktop surface.

**OCC-side:** OCC has desktop *handoff/upsell* only — `src/components/DesktopHandoff.tsx`, `src/components/DesktopUpsell/DesktopUpsellStartup.tsx` (these tell the user to **get/open** the desktop app; they are not the desktop app's own MCP-authorize UI). The 24 `desktop`+`mcp|authorize|reconnect` hits are these handoff/upsell paths plus terminal `/mcp reconnect` messaging. OCC does not *run inside* the desktop app and renders no desktop-app MCP authorize/reconnect screen. → **N-A.**

---

## #13 — artifact publishes: empty edits list + wrong retry after a newer version

**Changelog:** Fixed artifact publishes sometimes failing when Claude sent an empty list of edits, and Claude retrying an artifact update the wrong way after a newer version of the artifact turned it away.

**Disposition: N-A** (no artifact-publish pipeline; `ReviewArtifactTool` is a stub — occ119 #42 precedent).

**Marker counts:** `empty list of edits` 0/0/0; `emptyEdits` 0/0/0 — no distinctive string (the fix is logic in the artifact-publish path). The artifact subsystem is present in the binary via constants (`ARTIFACT_*`, `CHAIN_REPUBLISH_ALLOW_REASON`, `CONFLICT_REJECTION_PREFIX`, `STALE_GUARD_*`, `rideStateAfter`, `isPublishShapedArtifactAction`, `safePublishUrl`) but the empty-edits/stale-retry handling is bytecode/minified logic, not string-recoverable.

**OCC-side:** `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` is a 3-line stub (`// Auto-generated stub — replace with real implementation` / `export {}` / `export const ReviewArtifactTool: Record<string, unknown> = {}`). No artifact publish/republish pipeline (5 `artifact.*publish|list of edits` hits are type/tool-name references only). → **N-A.** (Preserve the official constant names above if/when OCC builds artifact publishing.)

---

## #15 — agents view rows staying blank after moving down a long list or folding a section

**Changelog:** Fixed rows in the agents view staying blank after moving down a long list or folding a section.

**Disposition: N-A** (OCC's agents views are **not** scroll-virtualized — structurally immune to the blank-row bug; the one virtualized+fold list OCC has is the message transcript, not an agents view).

**Binary evidence:** the official fix is a virtualized-list blank-row defect (rows render empty after the scroll window advances past loaded data, or after a section fold changes row indices). No distinctive marker string — it is a render/index-logic fix inside the official agents view's windowing.

**OCC-side findings — three "agents views", none scroll-virtualized:**
1. **`/agents` subagents management screen** (the primary agents view): `src/components/agents/AgentsMenu.tsx` (mode state machine; `list-agents` branch renders `<AgentsList>` at `:255`) → `src/components/agents/AgentsList.tsx`. Row renderer `renderAgent` at `AgentsList.tsx:55-66`, invoked via full `.map()` at `:179` (built-in section), `:195` (per-source group), `:328` (main list). Navigation `handleKeyDown` `:123-163` moves `selectedAgent` through `selectableAgentsInOrder` with wraparound — **no scroll offset, no visible-window, no `slice(start,end)`, no row-height.** Sections are static source groupings (`AGENT_SOURCE_GROUPS`) via `renderAgentGroup` `:190-196` — **no fold/collapse toggle.** Every row always renders → immune.
2. **FleetView** (inline background/daemon sessions panel): `src/components/FleetView/FleetView.tsx` uses a **top-N cap** `visibleRunning = running.slice(0, maxRows)` at `:71` (`maxRows = budget−2`, budget 4–12 via `rowHelpers.ts:199-203`), rows via `visibleRunning.map(FleetRow)` `:84-92`, overflow `…+N more jobs` `:93-97`; "fold" is a `✓ N done` count summary `:98-102` (`buildFleetRows` `rowHelpers.ts:37-59`). The window is a fixed top-N slice (does not scroll with `selectedIndex`, nav wraps modulo `navCount` `FleetViewScreen.tsx:145-153`) → rendered rows always carry data, never blank. (Adjacent non-blank-row limitation: selecting a running row beyond `maxRows` leaves the selection indicator off-screen — distinct from the official bug.)
3. **`occ agents` daemon dashboard**: `src/cli/handlers/agents.ts` — plain `console.log` text table (`renderSessionTable` `:209-238`); no React/Ink, no virtualization, no fold.
- The shared virtualized list + fold machinery that *could* exhibit a blank-row bug — `src/components/VirtualMessageList.tsx` (`messages.slice(start,end)` `:894`, `topSpacer`/`bottomSpacer` `:893/:902`, `StickyTracker`) and `src/components/deferredRowCollapse.ts` (`DEFERRED_COLLAPSE_MS=250`) — is used **exclusively by the conversation transcript**, wired at `VirtualMessageList.tsx:859-884`; neither `src/components/agents/` nor `src/components/FleetView/` imports it. `src/components/CustomSelect/use-select-navigation.ts:609-616` is a genuine sliding window but AgentsMenu uses `Select` only for the ≤4-item per-agent action menu (`AgentsMenu.tsx:434`) and 2-item delete-confirm (`:646`), never the long agent list.

→ **N-A.** OCC does not share the blank-row bug because its agents lists render every row (or a data-bearing top-N cap) rather than a scroll-offset virtual window.

---

## #16 — `claude remote-control --help` not printing usage when not signed in

**Changelog:** Fixed `claude remote-control --help` not printing its usage and exiting when not signed in.

**Disposition: PORT** (complexity **S**) — latent parity fix. OCC shares the exact bug pattern in source (auth-exit before the help dispatch); it is **dormant** in shipping builds because `BRIDGE_MODE` is off in every allowlist, but the fix is cheap, correct, and reverses a prior mis-classification.

**Marker counts:** `remote-control` v301=134 / v302=135 / new=63 (+1 net); `remoteControl` 88→88.

**Byte offsets / dd (v302 @117867900) — remote-control command setup region:**
```
--remote-control [name]   Start an interactive session with Remote Control enabled (optionally named)
--rc [name]               Alias for --remote-control
--remote-control-session-name-prefix <prefix>
run_main_options_built configureHelp enablePositionalOptions argument helpOption addOption
argParser hideHelp rootCommand … auth_failed request_failed stale_tunnel_credential
untiered_login stored_login env_token_only key_helper_only hasOAuthToken oauthEffective
```
(Commander-style help machinery + auth/login state codes co-located — the official fix reorders so the `helpOption`/usage path runs before the auth gate.)

**OCC-side findings — bug pattern present, but dormant:**
- Live dispatch is a **fast-path in the entrypoint**, not a `src/commands/` file: `src/entrypoints/cli.tsx:164-213`, gated `if (feature("BRIDGE_MODE") && (args[0]==="remote-control"|"rc"|"remote"|"sync"|"bridge"))` (`:168-175`), ending in `await bridgeMain(args.slice(1))` at `:211`. Defensive (unreachable) Commander registration at `src/main.tsx:5030-5043` (`program.command('remote-control',{hidden:true}).alias('rc')`, commented *"Unreachable — cli.tsx fast-path handles this before main.tsx loads"*). Implementation `src/bridge/bridgeMain.ts:2129` (real, ~3,170 lines — not a stub).
- **The offending order** in `src/entrypoints/cli.tsx`: `:189-192` runs `const {getClaudeAIOAuthTokens}=await import("../utils/auth.js"); if(!getClaudeAIOAuthTokens()?.accessToken){exitWithError(BRIDGE_LOGIN_ERROR)}` — **auth check, `process.exit(1)` with no usage** (`exitWithError` = `src/utils/process.ts:201`; message `src/bridge/types.ts:9-11` "You must be logged in to use Remote Control…") — then `:193-196` GrowthBook gate, `:197-200` min-version, `:203-210` policy limits, and only at `:211` `bridgeMain(...)`, whose **first act** (`:2130-2135`) is `if(parsed.help){await printHelp();return}`. So `remote-control --help` signed-out dies at `cli.tsx:191` before reaching the help printer — **structurally identical to the official pre-2.1.302 bug.**
- Inside `bridgeMain` the order is already correct (help at `:2132` precedes its own token check at `:2254-2260`), confirming the wrapper pre-check is the culprit. `parseArgs` `:1866` recognizes `--help`/`-h` at `:1881-1882`; `printHelp()` `:2038-2100`.
- **Reachability caveat:** `feature("BRIDGE_MODE")` is **not** in any OCC allowlist — `src/utils/featureFlags.ts:13-64` (runtime), `scripts/build.ts:26-29` (dist), `src/entrypoints/cli.tsx:8-12` (dev polyfill). In shipping OCC, `occ remote-control --help` never hits the fast-path (nor the equally-gated Commander registration) — it falls through as an unknown command. The bug is **latent source-level, not user-reproducible in the current build.** (Prior rounds recorded it as NO-OP without inspecting the fast-path ordering: `docs/upstream-version-gap-occ102-2026-10.md:72`, `docs/upstream-version-gap-occ142.md:54` — this round corrects that.)
- **Correct pattern** (help needs no auth): `occ daemon --help` / `daemon remote-control` `src/cli/handlers/daemon.ts:295-298` prints usage via `printDaemonUsage()` (`:191`) with zero auth checks; the daemon fast-path `cli.tsx:216-225` has no auth pre-check before `daemonMain`. Commander subcommands (`auth`, `mcp`, `plugin`, `doctor`) serve help via `helpOption` (`main.tsx:1065`) with the init `preAction` hook explicitly skipped for help (`main.tsx:967-968`) — e.g. `occ auth login --help` prints usage signed-out.

**PORT landing plan (S):** in `src/entrypoints/cli.tsx:185-192`, scan `args.slice(1)` for `--help`/`-h` **before** the auth/GrowthBook/min-version/policy gate chain and delegate straight to `bridgeMain(args.slice(1))` (which prints help pre-auth at `:2132`); **or** move the four wrapper gates into `bridgeMain` after its `parsed.help` branch (it already re-checks the token at `:2254`, so the wrapper check is partly redundant). Test: with no OAuth token, `occ remote-control --help` (BRIDGE_MODE forced on) prints usage and exits 0, not the login error + exit 1. Low urgency (dormant) but land opportunistically for parity + to retire the stale NO-OP classification.

---

## #20 — backtick URLs clickable only on first row when wrapped → whole URL one link

**Changelog:** Fixed URLs written in backticks being clickable only on their first row when they wrap; the whole URL is now one link in terminals that support hyperlinks.

**Disposition: ALREADY-ALIGNED** (OCC's wrapped-hyperlink mechanism already emits one logical link across rows) **+ adjacent CAND** (OCC never linkifies backtick/codespan URLs at all — a separate pre-existing gap, not what #20 changed).

**Marker counts:** `]8;;` v301=5 / v302=5 / new=4; `hyperlink` 85→85 / new=28; `linkId` 1→1 / new=1; `8;;id=` **0/0/0** (official does **not** use the OSC-8 `id=` param — it groups wrapped rows via its own `linkId`).

**Byte offsets / dd — single-segment wrap path is UNCHANGED v301→v302 (name churn only):**

v301 @232001500:
```js
if(fe&&V.length===1){let me=V[0],de=jb(te,ae,ne,H);Se=de.softWrap,
 ue=de.wrapped.split("\n").map((ye)=>{let Ee=o5e(ye,me.styles);if(me.hyperlink)Ee=Ul(Ee,me.hyperlink);return Ee}).join("\n")}
```
v302 @249765750:
```js
if(fe&&Y.length===1){let me=Y[0],de=Vb(ne,ae,te,H);Se=de.softWrap,
 ue=de.wrapped.split("\n").map((ye)=>{let Ee=j6e(ye,me.styles);if(me.hyperlink)Ee=Ol(Ee,me.hyperlink);return Ee}).join("\n")}
```
Identical modulo minified names (`V→Y`, `jb→Vb`, `o5e→j6e`, `Ul→Ol`): both split the wrapped text into lines and re-apply the hyperlink to **each** line. Hyperlink emitter `Ol` (v302 @249760815): ``function Ol(n,u){return`${Ib}8;;${u}${Gb}${n}${Ib}8;;${Gb}`}`` = `ESC]8;;URL BEL text ESC]8;; BEL` (no `id=`). Codespan processing confirmed in official's marked tokenizer (`codespan({text:e}){return e}`, `if(t.type==="codespan")return!(("defanged"in t)&&t.defanged===!0)&&…`, `if(n.type==="codespan"||n.type==="link"&&Zt(n.href,t))Object.assign(n,{…})`) — official linkifies/defangs backtick URLs. The exact v301→v302 delta is **not pinnable to one recovered function** (the single-segment path is unchanged; the fix sits in the multi-segment wrap path and/or the codespan-linkify + `linkId` grouping).

**OCC-side findings:**
- **Backtick URLs are never hyperlinked in OCC:** `src/utils/markdown.ts` `formatToken()` `case 'codespan'` `:316-319` only colorizes (`color('permission',theme)(token.text)`) — no URL detection inside codespans anywhere. (`case 'link'` `:369-389` does hyperlink `[text](url)` via `createHyperlink`.) This is the adjacent gap, **not** the #20 fix subject (#20 assumes backtick URLs are already clickable and fixes their wrap).
- **OCC's wrapped-hyperlink grouping is already correct** (matches post-fix official behavior): OSC-8 emission `src/utils/hyperlink.ts` `createHyperlink()` `:42-68` (`OSC8_START='\x1b]8;;'`); render-layer per-row wrap `src/ink/render-node-to-output.ts:685-701` (comment `:692-696`: *"a single wrapper around the whole block would only apply the hyperlink to the first line"* — i.e. OCC deliberately wraps per-row) and multi-segment `applyStylesToWrappedText()` `:216-339` (hyperlink flushes `:263-265`, `:282-284`); cross-row regrouping at terminal-output time via `src/ink/termio/osc.ts` `link()` `:513-520` + `osc8Id()` `:522-527` (auto-adds `id=<url-hash>` so terminals group wrapped rows into one link) and `src/ink/log-update.ts` `renderFullFrame()` `:65-112` (re-emits via `oscLink()` with the `id=`). So a wrapped `[text](url)` link is already one logical link across rows in OCC.

**Verdict:** the #20 *mechanism* (whole URL one link across wrapped rows) is **ALREADY-ALIGNED** in OCC's `<Link>`/cell render path. OCC simply never produces a hyperlink for a backtick URL, so it cannot exhibit the "first row only" symptom. **Adjacent CAND** (optional, separate from #20): route codespan URLs through `createHyperlink()` at `markdown.ts:316-319` — would need guarding against `renderTokenWindowed()` (`markdown.ts:197-221`, strips OSC-8 on windowed tokens for huge docs) and would then auto-benefit from the already-correct wrap grouping. Complexity of the CAND: **S–M**.

---

## #22 — emoji that a link starts inside wrapping one column too wide

**Changelog:** Fixed an emoji that a link starts inside wrapping one column too wide, which hid it in question previews and turned tables into lists.

**Disposition: CAND** (OCC has adjacent emoji-width divergence surfaces that could reproduce the symptom, but the live `Bun.stringWidth` path measures correctly and the exact official delta is not string-recoverable — recommend a targeted reproduction test before porting).

**Marker counts:** `emoji` v301=55 / v302=59 / new=33 (+4 net, but the new lines are dominated by Unicode-property tables, Zod `emoji` validation, and the emoji-picker `emoji:${id}` rows — not a width fix); `grapheme` 28→28 / new=12; `stringWidth` 3→3 / new=2; `getStringWidth` 17→17. No distinctive width-fix string recovered → the fix is a logic change in the width/link path (bytecode/minified), consistent with the official symptom (an emoji at link start over-measured by one column).

**OCC-side findings — width sinks and the over-measure class:**
- Canonical utility `src/ink/stringWidth.ts`: `stringWidth` export `:220-222` prefers **`Bun.stringWidth(str,{ambiguousIsNarrow:true})`** `:213-218`; JS fallback `stringWidthJavaScript()` `:20-90` with `needsSegmentation()` `:92-104`, **`getEmojiWidth()` `:106-127`** (any emoji-regex-matching grapheme hard-coded width **2** — over-measures *text-presentation* emoji such as a bare `⚠` without VS16, which terminals render width 1), `isZeroWidth()` `:129-203`.
- Second sink `src/utils/sliceAnsi.ts:45-46`: width = `token.fullWidth ? 2 : stringWidth(token.value)` — `@alcalzone/ansi-tokenize`'s `fullWidth` flag **overrides** `stringWidth` for char tokens. Probe: it tokenizes `👉`/`⚠️`/`1️⃣` inside OSC-8 correctly, but a bare `⚠` gets `fullWidth=false`→1 while the JS fallback `getEmojiWidth` returns 2 — a **live one-column disagreement class** adjacent to OSC-8 boundaries.
- Third sink `src/ink/output.ts` `flushBuffer()` `:587-620` (per-grapheme `width:stringWidth(grapheme)` ~`:617`); `src/ink/wrap-text.ts` `sliceFit()` `:10-13` retries when a boundary-spanning wide char overshoots by 1.
- **Consumer surfaces matching the official symptom:** question preview `src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx:165-167` (`sliceAnsi(line,0,innerWidth)` truncation) + panel sizing `AskUserQuestionPermissionRequest.tsx:113-127` (`stringWidth(line)` `:123`) — a link-leading emoji measured one too wide is exactly what "hid it in question previews"; tables→lists `src/components/MarkdownTable.tsx` widths from `stringWidth(getPlainText(...))` in `getMinWidth` `:118-123` / `getIdealWidth` `:126-128`, falling back to `renderVerticalFormat()` (list) when `maxLineWidth > terminalWidth − SAFETY_MARGIN` `:362-371` — one extra column on an emoji inside a link cell trips this fallback (the OCC analogue of "turned tables into lists").
- Note: the live path prefers `Bun.stringWidth` (probe shows it measures `⚠️`/`👉`/`1️⃣` inside OSC-8 correctly), so OCC's exposure is mainly the **JS fallback** (`getEmojiWidth` width-2 hard-code) and **sliceAnsi's `fullWidth` override** — and only when those paths are hit (non-Bun runtime, or the sliceAnsi truncation/size path).

**Recommendation (CAND):** write a reproduction test first — a link whose text starts with a text-presentation emoji (e.g. `[⚠ click](url)`) rendered (a) in a question preview near the truncation width and (b) in a table cell near `terminalWidth − SAFETY_MARGIN`; assert the emoji is visible and the table does not fall back to a list. If OCC reproduces, fix `getEmojiWidth()` (`stringWidth.ts:106-127`) to return width 1 for text-presentation emoji (no VS16 / not `Emoji_Presentation`) and reconcile `sliceAnsi.ts:45-46`'s `fullWidth` precedence with `stringWidth` for emoji adjacent to OSC-8. Complexity if pursued: **M** (width-correctness ripples across preview/table/wrap consumers — regression-test all four sinks).

---

## #24 — cloud session cost/usage restarting from zero after resume in a new process

**Changelog:** Fixed a cloud session's cost and usage restarting from zero after the session resumed in a new process.

**Disposition: N-A** (cloud-only; OCC has no cloud-session cost/usage tracking that persists across a process resume).

**Marker counts:** `resumed in a new process` 0/0/0; no cost-resume string recovered (cloud-session accounting logic, not a CLI string).

**OCC-side:** 0 hits for cloud cost/usage resume (`cloud`+`cost|usage`+`resume|restart|persist|zero`); `src/cost-tracker.ts` / `src/costHook.ts` have **no cloud-session awareness** (0 `cloudSession`/`cloud session` hits). OCC's 33 `cloudSession` references are CLI-side awareness only — a `listCloudSessions()` tool function, background-session error-relay strings, test fixtures, and an "N cloud sessions" counter display — none of which tracks a cloud session's cumulative cost/usage across a process boundary. → **N-A.**

---

## #33 — `← for agents` footer hint hides 10s after session opens; waiting-agent count still shows

**Changelog:** Changed the `← for agents` footer hint to hide 10 seconds after a session opens; the count of agents waiting on you still shows.

**Disposition: STAGED** (two-layer gap: OCC renders neither the `← for agents` footer hint nor an "agents waiting on you" counter — the #33 behavior has no landing surface until the hint itself is added, a known OCC-108 divergence).

**Marker counts:** `for agents` v301=4 / v302=4 (balanced); `← for agents` 0/0/0 (the arrow is a separate glyph run); `waiting on you` v301=3 / v302=3 (balanced); `forAgentsHint`/`agentHint`/`footerHint` 0/0/0. **No new string** → the 10s auto-hide is a logic-only change (`setTimeout(…,10000)`), not string-recoverable; the changelog is the authoritative spec.

**Byte offsets / dd (searched, not the footer):** `for agents` v302 @118395953 / @243996731 / @267003050 / @284576387 — dd @243996300 is the **AgentTool subagent-handoff prompt prose** ("…only wait or cancel…"), not the footer hint. `waiting on you` v302 @118903462 / @251921290 / @252068051 / @252109224 — dd @251920900 is **background-session prompt delivery** ("it is waiting on your answer to a question"), @252067700 is the embedded changelog. The footer-hint render + timer live in minified React; the exact 10s timer was not recovered (low value given no OCC landing surface).

**OCC-side findings:**
- **The `← for agents` hint is NOT rendered.** The literal appears only in documentation of the official footer: `src/components/PromptInput/PromptInputFooterLeftSide.tsx:148` (comment: *"the official manual-mode footer reads `⏸ manual mode on · ? for shortcuts · ← for agents`"*) and `src/components/PromptInput/__tests__/manualModeCycleHint108.test.ts:7` (records the official `…? for shortcuts · ← for agents` vs OCC `⏸ manual mode on (shift+tab to cycle)` as a known **OCC-108 parity divergence**). What OCC pushes into the same `parts` list: `? for shortcuts` (`PromptInputFooterLeftSide.tsx:466-468`), `↓/Enter to manage` (`:506-510`), spinner hints (`getSpinnerHintParts` `:540-569`). Hint composition: footer wrapper `PromptInputFooter.tsx:65`, left side `PromptInputFooterLeftSide.tsx:161`, inner `ModeIndicator` `:271` building `parts` `:408`, joined with ` · ` by `Byline` (`src/components/design-system/Byline.tsx`).
- **The capability exists but is fullscreen-only:** `src/components/FleetView/FleetViewScreen.tsx:112` (`leftArrowOpensAgents = getInitialSettings().leftArrowOpensAgents ?? true`) and `:131` (`key.leftArrow && leftArrowOpensAgents` activates the fleet), mounted only in fullscreen env — `src/screens/REPL.tsx:5300` (`isFullscreenEnvEnabled() && <FleetViewScreen …>`). (Inside the fleet view, `FleetView.tsx:81` renders `· ↓/← to navigate` — not the prompt footer.)
- **No "agents waiting on you" counter** anywhere (0 hits `waitingCount`/`needsAttention`/`awaiting` as a footer counter). Nearest adjacent (none is the counter): `src/components/tasks/BackgroundTaskStatus.tsx` (footer tasks pill, rendered `PromptInputFooterLeftSide.tsx:442,457`), `FleetView/SessionPreview.tsx:231` (per-session `'awaiting approval'`), `REPL.tsx:4291` (`'Claude is waiting for your input'` desktop-notification text).
- **Timer precedent** for when this lands: `src/components/PromptInput/useShowFastIconHint.ts:3,22` — session-once hint auto-hidden after `HINT_DISPLAY_DURATION_MS = 5000` via `setTimeout` + module-level `hasShownThisSession` guard (`:5`). A 10s agents-hint timer copies this with `10_000`. `PromptInputFooterLeftSide.tsx` itself has no timers (hint visibility is render-gated `showHint = !suppressHint && !showVim` `:231-234`).

**Staged landing plan (when the hint is added):** (1) hint part — a new `<Text dimColor>← for agents</Text>` push in `PromptInputFooterLeftSide.tsx` near the `? for shortcuts` fallback (`~:458-469`), gated on `leftArrowOpensAgents` + `isFullscreenEnvEnabled()` (mirror `REPL.tsx:5300`); (2) 10s auto-hide — a hook modeled on `useShowFastIconHint.ts` (module-level once-per-session flag + `useEffect`/`setTimeout(…,10_000)`) consumed by `ModeIndicator`; (3) waiting counter (persists after the hint hides) — a new always-on footer part derived from AppState `tasks`/`teamContext` (in-process teammates awaiting input/approval, cf. `SessionPreview.tsx:231`). **Prerequisite:** the `← for agents` hint itself (separate OCC-108 divergence) — #33 cannot land before it. Note: in OCC's default non-fullscreen mode the hint may legitimately never show (FleetView is fullscreen-only), so #33's user-visible value in OCC is bounded. Complexity once unblocked: **M**.

---

## #34 — Claude in Chrome instructions moved in the system prompt for shared prompt-cache hits

**Changelog:** Changed where the Claude in Chrome instructions sit in the system prompt so that new conversations can read them from the shared prompt cache.

**Disposition: ALREADY-ALIGNED** (OCC's Chrome instructions already sit in cache-stable **tail** positions; the `'global'`-scoped shared prefix is chrome-independent; OCC even ships the *stronger* variant — late-chrome-connect moves the instructions out of the system prompt entirely into a delta attachment).

**Marker counts:** `Claude in Chrome` v301=241 / v302=238 / new=58 (balanced, −3); `claude-in-chrome` 71→71 / new=22; `Chrome extension` 41→41 / new=11. **No new chrome-instruction string** → the change is a *reorder of an existing block* (positional), not recoverable as a string delta. The cache-prefix rationale is the authoritative spec: the Anthropic prompt cache is prefix-based, so a conditional/less-common section sitting **early** busts the shared prefix for every conversation; moving it **late** (after the cache-stable prefix) lets new conversations hit the shared cache.

**OCC-side findings — Chrome instructions are already tail-positioned:**
- System-prompt assembly `src/constants/prompts.ts:408-586` (`getSystemPrompt()`). **Static cacheable prefix first:** `getSimpleIntroSection` `:565`, `getSimpleSystemSection` `:566`, `getSimpleDoingTasksSection` `:567-570`, `getActionsSection` `:571`; then `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker `:577-579` (when `shouldUseGlobalCacheScope()`), then dynamic sections `:462-553`. `grep -i "chrome|browser" src/constants/prompts.ts` → **0 hits** (no early static section contains chrome content).
- `buildEffectiveSystemPrompt()` `src/utils/systemPrompt.ts:42-128`: `[...defaultSystemPrompt, appendSystemPrompt?]` — **`appendSystemPrompt` always last** (`:126`).
- Per-request wrap `src/services/api/claude.ts:2061-2075`, final wire order: `getAttributionHeader` `:2066` → `getCLISyspromptPrefix` `:2067` ("You are Claude Code…") → `...systemPrompt` `:2071` → `ADVISOR_TOOL_INSTRUCTIONS` `:2072` → **`CHROME_TOOL_SEARCH_INSTRUCTIONS` `:2073` (the LAST block)**.
- Chrome text source `src/utils/claudeInChrome/prompt.ts` (`BASE_CHROME_PROMPT` `:1-50`, `CHROME_TOOL_SEARCH_INSTRUCTIONS` `:56-70`, `CLAUDE_IN_CHROME_SKILL_HINT` `:78`). **All injection sites are tail:** full-chrome `--chrome` merges `BASE_CHROME_PROMPT` into `appendSystemPrompt` (`src/main.tsx:1885-1903`); auto-enable appends `CLAUDE_IN_CHROME_SKILL_HINT` to `appendSystemPrompt` (`main.tsx:1914-1924`); ToolSearch instructions are dead-last (`claude.ts:2073`).
- **Stronger-than-official variant:** when `isMcpInstructionsDeltaEnabled()`, chrome instructions leave the system prompt entirely and ride as an `mcp_instructions_delta` **user-message attachment** (`src/utils/attachments.ts:1721-1747`, client block `:1738-1741`) — the comment at `claude.ts:2050-2053` explicitly states the per-request sys-prompt append "busts the prompt cache when chrome connects late," which is why the delta path exists.
- Cache machinery: `buildSystemPromptBlocks()` `claude.ts:4605-4631` (adds `cache_control:getCacheControl(...)` when `cacheScope!==null`), `getCacheControl()` `:399-417` (`{type:'ephemeral',ttl?:'1h',scope?:'global'}`), `splitSysPromptPrefix()` `src/utils/api.ts:348-465` — global-cache mode marks the **static-before-boundary** block `'global'` (the cross-conversation shared prefix: intro/system/doing-tasks/actions, `prompts.ts:565-571`), dynamic-after-boundary `null`. Chrome state never touches that `'global'` prefix.

**Verdict:** OCC does **not** have the cache-busting placement official #34 fixed — the shared prefix is byte-identical across conversations regardless of chrome state, and chrome instructions live in the tail / delta attachment. → **ALREADY-ALIGNED**, no reorder needed. Only nuance for the ledger: in full-chrome mode `BASE_CHROME_PROMPT` is prepended *within* `appendSystemPrompt` (`main.tsx:1902`), ahead of any user `--append-system-prompt` text — order-inside-the-tail only, irrelevant to prefix caching.

---

## #37–#63 — trivially-N-A tail (batch verification)

27 entries across five surfaces OCC does not ship. One grep per surface; N-A recorded in batch.

| #s | Surface | Verification grep (OCC `src/`) | Result | Disposition |
|---|---|---|---|---|
| #37 #38 #39 | **[VSCode]** extension (streaming markdown in list, MCP sign-in query-string, `@browser` banner) | `ls -d vscode* extensions` = 0 dirs; `grep -rlE "from 'vscode'\|vscode\.window\|extension.ts" src/` = **0** | No VS Code extension. The 123 `\bvscode\b` src hits are env-detection (`TERM_PROGRAM=vscode`/`isVSCode`/`VSCODE_` = 37), CLI option descriptions (`.vscode/` protected paths), and comments (`entrypoint==="claude-vscode"`). Entries live entirely in the official extension bundle. | **N-A ×3** |
| #40–#47 | **[Cloud sessions]** web UI (routine-page banner, Rewind-to-here, PR status bar, routine-run status, diff view, scheduled re-run, cross-device sync, connection-lost error) | `grep -rF 'Rewind to here' src/` = **0** (#41); `cloudSession` = 33 hits | No cloud-session **web UI**. The 33 `cloudSession` hits are CLI-side awareness only: `listCloudSessions()` tool fn, background-session error-relay strings, test fixtures, an "N cloud sessions" counter — none is a routine page / PR status bar / diff view / rewind UI. | **N-A ×8** |
| #48 | **[Remote Control]** subagent pane spinning forever after computer goes offline | `cat src/commands/remoteControlServer/index.js` = `export default {}` (1-line stub); `grep -riE 'pane\|spinning\|offline' src/remote/ src/commands/remoteControlServer/` = 6 (all `onDisconnected`/`disconnect` callbacks) | No Remote Control **subagent-pane UI**. `src/remote/` is client session management (`RemoteSessionManager.ts`, `SessionsWebSocket.ts`, `remotePermissionBridge.ts`, `sdkMessageAdapter.ts`); the "subagent pane" hits elsewhere are the **VS Code** subagent panel (SDK consumers), not Remote Control panes. | **N-A ×1** |
| #49–#62 | **[Claude Tag]** Slack bot + admin settings (thinking indicator, URL angle-brackets, image attachments, channel-manager roles, connector hosts, DM retry, Enterprise Grid, spend-limit notice, link formatting, repo search, Add place/domain, tabs, Roles page) | `grep -rF 'Claude Tag' src/` = **0**; `\bslack\b` = 138 hits | No Claude Tag / Claude-in-Slack product. The 138 `slack` hits are a **Slack MCP connector** (`SLACK_APP_URL=slack.com/marketplace/…claude`, posting via MCP tool), `slack`=margin in a rate-limiter, and prompt examples. OCC has neither the `@claude` Slack bot nor the Claude Tag admin web settings. | **N-A ×14** |
| #63 | **[Code Review]** setup resuming after connecting GitHub → repository picker (admin settings, web) | `head src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` = stub; `grep -rF 'Code Review' src/` = 9 (type/tool refs) | No Code Review **admin/setup web surface**. `ReviewArtifactTool` is a stub; the 9 hits are type/tool-name references. Entry is entirely in the claude.ai/admin Code Review web product. | **N-A ×1** |

**Batch total: 27 entries (#37–#63), all N-A.**

---

# Cross-entry observations

1. **Two whole-feature gaps dominate this cluster, both STAGED, both with no v302-only actionable delta:** #02 (idle compaction — a v2.1.290 feature OCC never ported; the v302 `/config` row + notice suffix are the trivial last touches on an **L**-sized substrate) and #33 (the `← for agents` footer hint + waiting counter — blocked on the OCC-108 missing-hint divergence). Neither is worth partial groundwork now; both are documented with full specs so a future round can port the substrate as a unit.
2. **OCC is *ahead* of official on two cache/render behaviors:** #34 (chrome instructions already tail/delta-attached, shared prefix chrome-independent — OCC ships the stronger late-connect delta path) and #20 (wrapped-hyperlink cross-row grouping already correct via per-row OSC-8 + `id=`). Both ALREADY-ALIGNED; no action.
3. **#16 reverses a stale NO-OP:** prior rounds (occ102, occ142) classified remote-control `--help` as NO-OP without inspecting the `cli.tsx` fast-path ordering. The bug pattern *is* present in source (auth-exit at `cli.tsx:191` before help dispatch), just dormant behind `BRIDGE_MODE` (off in all allowlists). Cheap **S** parity fix; land opportunistically.
4. **The one genuine PORT (#16) and the two CAND-adjacent opportunities (#20 backtick-linkify, #22 emoji width) are all low-urgency:** #16 is dormant; #20's mechanism is already aligned (only the backtick-linkify prerequisite is missing, a never-had behavior); #22 needs a reproduction test first because the live `Bun.stringWidth` path measures correctly (exposure is the JS fallback + `sliceAnsi` `fullWidth` override).
5. **N-A discipline held via surface greps, not raw counts:** `[VSCode]`/`[Cloud sessions]`/`[Claude Tag]` all have non-trivial raw keyword counts (123 / 33 / 138) that are *env-detection, CLI-side awareness, and an MCP connector* respectively — not the shipped web/extension/Slack surfaces the entries touch. Each batch row records the discriminating grep so the N-A is defensible.
6. **Region map for future work (v302 ELF byte offsets):** idle-compaction config-row builder ~256.654M, notices/triggers ~244.214M, feature spec (embedded changelog) ~252.069M & ~234.498M (v301), settings schema ~217.299M (v301); design closing notice ~124.901M, design cloud-session messages ~121.911M; remote-control command setup ~117.868M; markdown hyperlink single-segment wrap ~249.766M (v302) / ~232.002M (v301), `Ol` emitter ~249.761M; config-label registry ~122.181M.

# PORT / action complexity summary

| Entry | Disposition | Complexity | Landing point |
|---|---|---|---|
| #16 remote-control `--help` before auth | **PORT** | **S** | `src/entrypoints/cli.tsx:185-192` — help-check before the auth/gate chain (delegate to `bridgeMain`, which prints help pre-auth at `:2132`); dormant until `BRIDGE_MODE` enabled |
| #20 backtick-URL wrap → one link | **ALREADY-ALIGNED** | — | wrap-grouping already correct (`render-node-to-output.ts:685-701`, `termio/osc.ts:513-527`, `log-update.ts:65-112`); adjacent CAND: linkify codespan URLs at `markdown.ts:316-319` (**S–M**) |
| #34 chrome-instruction prompt position | **ALREADY-ALIGNED** | — | already tail/delta-attached (`claude.ts:2073`, `systemPrompt.ts:126`, `attachments.ts:1738-1741`); no reorder |
| #22 emoji width at link start | **CAND** | **M** (if reproduced) | `stringWidth.ts:106-127` `getEmojiWidth` (text-presentation → 1) + `sliceAnsi.ts:45-46` `fullWidth` reconcile; reproduction test first |
| #02 idle compaction `/config` row + notice | **STAGED** | **L** (feature) / **S** (v302 deltas) | substrate absent — idle timer off `REPL.tsx:3570`, trigger predicate (`autoCompact.ts`), `trigger:'idle'` plumbing, then row at `Config.tsx:266` + suffix at `CompactBoundaryMessage.tsx:322` / `REPL.tsx:5388` |
| #33 `← for agents` 10s hint + counter | **STAGED** | **M** (once unblocked) | prerequisite: add the hint (`PromptInputFooterLeftSide.tsx:~458-469`); then 10s timer modeled on `useShowFastIconHint.ts` + waiting counter footer part |
| #03 #17 design notices | **N-A** | — | no design commands |
| #12 desktop MCP authorize | **N-A** | — | no desktop-app surface |
| #13 artifact empty-edits/retry | **N-A** | — | `ReviewArtifactTool` stub |
| #15 agents-view blank rows | **N-A** | — | agents lists not virtualized (immune) |
| #24 cloud-session cost resume | **N-A** | — | no cloud cost tracking |
| #37–#63 (×27) | **N-A** | — | VSCode ext / cloud-session web UI / RC subagent panes / Claude Tag Slack / Code Review admin all absent |
