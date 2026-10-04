# Cluster F — Mods / plugin-UI runtime + core-ink text & border fixes (2.1.288 → 2.1.289)

Research round: official Claude Code 2.1.288→2.1.289 catch-up (OCC aligned at 2.1.288).
Method: byte-level forensics on the OFFICIAL linux-x64 binaries at
`/tmp/cc-diff-289/{v288,v289}/package/claude` (NEVER executed — `grep -aboF` offsets +
`dd bs=1` byte windows only; `ugrep` needs `-a` on the ELF). A/B against OCC `src/`
(read-only) + live `bun` probes under `/tmp` (`/tmp/probe19.tsx`, `/tmp/probe19b.tsx` —
repo untouched; this doc is the only repo file created). Offsets are byte offsets into
the ELF; minified names shift between versions (v288→v289 renames noted per entry).

Entries (numbers = `changelog-entries-289.txt` line numbers):
**#5, #8, #9, #11, #12, #13, #17, #18, #19, #20, #21, #23, #24, #25, #27**.

## Verdict summary

| # | Verdict | One-line evidence |
|---|---------|-------------------|
| 5  | **NO-OP{NO-SURFACE}** | plugin code pane is mods runtime; OCC has no `ui.render`/pane surface (grep table below) |
| 8  | **NO-OP{NO-SURFACE}** | "plugin rows above prompt" don't exist in OCC (no AbovePrompt surface, no plugin statics) |
| 9  | **NO-OP{NO-SURFACE}** | plugin pane link drawing absent in OCC |
| 11 | **PORT** (core-ink half; mod-input half NO-OP) | OCC probe CRASHES: `TypeError: undefined is not an object (evaluating 'box.topLeft')`; v288 official crashes identically, v289 adds validating `Dvn` + skip (`if(g!==void 0)`) @203025539 |
| 12 | **NO-OP{NO-SURFACE}** | fix is the Client host rejection handler `be(...)` "the session goes on" @218198922 — no Client surface in OCC |
| 13 | **NO-OP{NO-SURFACE}** | fix is Client measure-loop state machine (`measurings`, `frameOutcome`, cap 8/20) @218198922 — no Client surface in OCC |
| 17 | **NO-OP{NO-SURFACE}** (+STAGED note) | `$.agent.list` impl `Yco`→`nfo` @208518832/@208823898; OCC has no mod `$` API; internal `agent()`/`spawnTeammate` are not plugin-exposed |
| 18 | **NO-OP{NO-SURFACE}** | `ui.render` engine row fallbacks (`l1r`/`d1r`/`Pmn`) — no `ui.render` hook in OCC (`HOOK_EVENTS` has no `ui.*`) |
| 19 | **PORT** (shared text-normalization pipeline) **+ STAGED** (blit-cache/`paintsPastRect` machinery) | v289 adds `Oc/Hc/$rr/p9r/Ua/Va/La/Ya` pipeline (@201062051, `pR=/[\x90\x98\x9d-\x9f]/g` count v288=0→v289=2) used by BOTH measure (`cE`→`mE`) and render (`Ps`→`Gs` via `dC`); v288 was asymmetric (`YW` guard `if(!e.includes("\t"))return e`). OCC probes: stray ESC **eats following chars** (`a\x1bb`→`a`), C1 silently dropped (official→`�`), tabs emitted as fragile CUF escapes |
| 20 | **NO-OP{NO-SURFACE}** | pane/band close mark `[-]` is mods chrome; absent in OCC |
| 21 | **NO-OP{NO-SURFACE}** | `ui.fault` dispatcher `ko` + `ui_client_fault` subtype (0→8 strings in v289) — no fault surface in OCC |
| 23 | **NO-OP{NO-SURFACE}** | band/cards layout is mods chrome; absent in OCC |
| 24 | **NO-OP{NO-SURFACE}** | failed-component reason fallback `Ae(r,i)` in mod draw region — absent in OCC |
| 25 | **NO-OP{NO-SURFACE}** | mod-author failure line (`d1r`/`Pmn`/`vUt` telemetry) — absent in OCC |
| 27 | **NO-OP{NO-SURFACE}** | Client region recovery state (`isDestroyed`, `mountGeneration`, `thrownAt`) @218198922 — absent in OCC |

**Bottom line: 1 PORT (#11 core-ink border validation), 1 PORT+STAGED (#19 text
normalization), 13 NO-OP** — the entire mods/plugin-UI runtime (`ui.render`, `ui.fault`,
`Client`, panes/bands, `$.agent`, AbovePrompt rows) is a v289 surface OCC does not have.

---

## Surface-absence proof (covers #5, #8, #9, #12, #13, #17, #18, #20, #21, #23, #24, #25, #27)

Explore-agent grep over OCC `src/` (all zero-hit unless noted):

| Grep (OCC src/) | Hits |
|---|---|
| `ui.render`, `ui.fault`, `ui_client_fault`, `ui_client_module`, `ui_client_press`, `ui_message` | 0 |
| `$.agent`, `$.tool`, `$.ui`, `$.state` (mod API) | 0 |
| `class Client` (vm-sandbox host) | 0 |
| AbovePrompt / pane / band plugin surfaces | 0 |
| `src/entrypoints/sdk/coreTypes.ts:25-69` `HOOK_EVENTS` | **no `ui.*` events** |
| `src/types/plugin.ts:52-81` plugin components | **content-only** (no live-drawn components) |

Official v289 counter-evidence (fix sites all live in the mods runtime):

- **ui.fault machinery NEW in v289**: `ui.fault` string count 0→12; `ui_client_fault`
  SDK control subtype 0→8 (new_strings.txt). Dispatcher `ko` logs
  `ui.fault ${i.plugin}/${i.fault.element}: the chain threw` (@218198922 region).
- **Client host state machine** (@218198922; `surface.rows` count v288=0→v289=2):
  `ve=(r,i)=>({...,measurings:0,frameOutcome:"unmeasured",isUnsettled:!1,...,thrownAt:void 0,toldLast:0,isDestroyed:!1,...,mountGeneration:0,...})`;
  loop caps `Re={instance:\`its region changed size on each of ${se=8} measurings in one frame, so it is drawn as last measured; give the Client a height and a width, or draw no more than surface.rows and surface.columns\`, frame:...${ne=20} passes...}` (#13);
  async-throw rejection handler `be(...)`: "Client: a promise a surface module did not return was rejected: ...; the session goes on" (#12);
  region-failure recovery via `isDestroyed`/`mountGeneration`/`frameOutcome` (#27, #21).
- **#18/#24/#25 draw-failure strings** (mod draw region ~@206373709):
  `l1r=(e,n)=>\`ui.render (${e}) refused: ${n}; the engine drew its own\``;
  `d1r=(e,n)=>\`ui.render (${e}) threw while drawn: ${n}; \`+(Pmn[e]??"the engine drew its own")`;
  `Pmn={AbovePrompt:"nothing was drawn",Pane:"the pane was closed"}`;
  `vUt` telemetry `plugin_function_hooks_draw` / `threw_while_drawn` / `client_threw_while_drawn`
  with `\`ui.render (${e}): a plugin's ${r} threw while drawn (plugin ${...}, ${...})\``;
  #24 fallback `Ae(r,i)`: `w.trim()!==""?w:f==="Error"?VYn:f` (empty/`Error` message →
  real reason `VYn`); tree-validation message "a hook returned a tree that does not validate (...); drawing the engine's own".
- **#17** `$.agent.list` impl rename `Yco`(v288 @208518832)→`nfo`(v289 @208823898):
  status mapping `return s?"waiting":g?"idle":"running"` (s=awaitingPlanApproval||isIdle),
  completed-case keepaliveReasons→waiting/idle/running, `case"paused":return"idle"`,
  entries `{id,teammateId?,description,type,status,parentId?,spawnedBy?:Ce(hookCaller from spawnProvenance),name?}`;
  `i_o` maps tool result `status==="teammate_spawned"`+`teammate_id` →
  `{...result,agentId:(registry task.id)??teammate_id,resolvedModel}` ("one agent id").
  OCC counterparts (`src/Task.ts:17-22` TaskStatus, `src/tools/WorkflowTool/primitives.ts:412-424`
  `agent()`, `src/tools/shared/spawnMultiAgent.ts:1144` spawnTeammate) are INTERNAL, not
  plugin-exposed → nothing to port. STAGED: fold into the future mod-`$`-API port.
- **#9**: v289 link-normalization for pane drawing (localhost / `@` in path / uppercase
  host / `file:` scheme) lives in the mods pane module; v288 note: official SDK text
  sanitizer `qFt=(e)=>YW(b0(e)).replace(/[؜‪-‮⁦-⁩]/gu,"�")`
  @206038933 confirms the plugin-side pipeline OCC lacks entirely.
- **#5/#8/#20/#23**: pane/band/AbovePrompt layout code (highlighted-view laid out once
  at final width; stale-row invalidation while fullscreen dialogs own the screen;
  `[-]` close-mark column reservation; band-fail card stepping) — all mods chrome.
  OCC's own fullscreen paths (`src/screens/REPL.tsx:5225-5235`,
  `src/components/FullscreenLayout.tsx:396-418`, `src/components/tasks/BackgroundTasksDialog.tsx`)
  draw no plugin rows, so the stale-row bug has no OCC instance.

---

## #11 — unknown border style: OCC crash CONFIRMED, official v289 fix is core-ink → **PORT**

> 11 - Fixed a freeze or forced quit at launch when a plugin drew a Box with a border
> style the terminal does not know

### Official forensics — the fix has TWO parts

**(a) Core-ink fix (the part OCC needs).** v288 core ink resolves border styles with a
crash-prone lookup — same bug OCC has:

```js
// v288 caller (Zx): @~213376499 region
let R = typeof f.style.borderStyle==="string"
  ? Qx[f.style.borderStyle] ?? mv.default[f.style.borderStyle]   // unknown → undefined
  : f.style.borderStyle;
// ...later R.topLeft → TypeError → render loop dies → freeze/forced quit
```

v289 replaces it with a validating resolver (`Dvn` @203025539, styles object
`quote:{top:` @203025405):

```js
var o={...R.default,...n};
function Dvn(t){let i=typeof t==="string"&&Object.hasOwn(o,t)?o[t]:t;return p(i)?i:void 0}
var aas=Object.keys(o).filter((t)=>Dvn(t)!==void 0);export{Dvn,aas};
// v289 caller: var eC=(n,u,f,m,y)=>{let g=Dvn(f.style.borderStyle);if(g!==void 0){...draw...}}
//                                                   ^^^ unknown style → NO border, no crash
```

Note the custom style set `o={...R.default,...n}` includes `{dashed, quote}` (official
has had `quote` since ≤v288; OCC's `CUSTOM_BORDER_STYLES` only has `dashed` — separate
pre-existing gap, note only).

**(b) Mod-input validation (NO-OP for OCC)** @~206373709:

```js
function Hmn(e){return `Box borderStyle ${typeof e==="string"?`"${AH(e)}" is not a border style`:`is ${ZD(e)}, not a style name`} (the styles are ${[...IGt].join(", ")}); the Box is drawn with no border`}
// wBo({input,style,origin}) called via Rmn(a1r(D),(Z)=>wBo(...)) inside the ui.render engine u1r
```

### OCC A/B — crash reproduced live

`src/ink/render-border.ts:91-96` does `CUSTOM_BORDER_STYLES[style] ?? cliBoxes[style]`
→ `undefined` → `box.topLeft` TypeError at :128. Uncaught through `Ink.onRender`
(`src/ink/ink.tsx:712`, queueMicrotask :366) → process-level crash. No validation exists
anywhere in the OCC tree.

Probe (`/tmp/probe19.tsx` probe B, `BaseBox borderStyle="totally-unknown-style"`):

```
=== PROBE B (#11 unknown borderStyle) ===
frame: ""
crashed: TypeError: undefined is not an object (evaluating 'box.topLeft')
```

### PORT spec (faithful to v289 `Dvn`/`eC`)

- `src/ink/render-border.ts`: resolve the style through a validating lookup
  (`Object.hasOwn` over `cliBoxes ∪ CUSTOM_BORDER_STYLES`, or pass-through of a
  complete custom style object); on unknown → **skip border drawing entirely**
  (v289 `if(g!==void 0)`), never throw.
- Keep the `dashed` custom style; optionally add `quote` for parity (separate gap).
- e2e: render unknown borderStyle → frame draws content with no border, process alive.

---

## #19 — tab / stray-escape / C1 / CRLF text overdraw → **PORT (normalization) + STAGED (blit machinery)**

> 19 - Fixed text with a tab, a stray escape and a C1 control, or a short text with a
> tab and CRLF line endings, drawing over the rows below it

The changelog files this under plugin panes, but the v289 fix landed in **core ink**
(the same layer OCC forked). Three coordinated changes:

### (1) Shared text-normalization pipeline — NEW in v289 (@201062051 + @213553684)

Constants (v289 only — `YSt=8` count v288=0; `pR` regex `x90\x98\x9d-\x9f` count
**v288=0 → v289=2**; tab-stop math `-r%` gains a site @201062459):

```js
var YSt=8,                        // tab width
    uR=/(\t|\n)/,                 // split keeping tab/newline
    hR=/[\x1b\x9b]/g,             // ESC + C1 CSI  → replaced with \x18 (CAN)
    pR=/[\x90\x98\x9d-\x9f]/g,    // remaining C1 (DCS,SOS,OSC,PM,APC) → �   ← NEW
    _R=/[\x1b\x90\x98\x9b\x9d-\x9f]/,  // quick dirty test (u9r)
    mR=/^\x1b[P\]X^_k]/,          // string introducers
    gR=/^\x1b[P_].*\x07$|\x9c/s;  // terminated string sequences
function $se(e,s=YSt){return e.includes("\t")||p9r([e])?$rr([e],s).join(""):e}
```

Pipeline:

```js
function $rr(e,s=YSt){ /* per piece: tokenize (Ua), expand \t to next s-col stop
  (g=s-r%s; spaces), \n resets column r=0, else r+=ae(p) — column tracked ACROSS pieces */ }
function Ua(e,s){let r=Mme({forOutput:!0}),n=r.feed(e),i=r.buffer();
  if(i!=="")n.push({type:s&&!mR.test(i)?"sequence":"text",value:i});return n}
function Va(e){ if(e.type==="text"||e.value.includes("\n")||gR.test(e.value))
    return La(e.value.replace(hR,"\x18"));          // stray ESC/CSI → CAN
  if(e.value.startsWith("\x1Bk")) return La(e.value.replace(/\x9b/g,"\x18")); return }
function La(e){return e.replace(pR,"�")}       // C1 → U+FFFD (visible, width-stable)
function p9r(e){return e.some((s,r)=>u9r(s)&&Ua(s,r===e.length-1).some((n)=>(Va(n)??n.value)!==n.value))}
function Hc(n){return p9r(n)?$rr(n.map((u)=>Ya(u))):void 0}
// screen-writer side (@213553684):
function Ya(n){return h0.test(n)?n.replace(R8e,"�"):n}   // bidi overrides → �
  // R8e=new RegExp("[؜‪-‮⁦-⁩]","gu") @205420347
function XX(n){return Oc([n],!1)}                            // stripAnsi now normalizes
function Oc(n,u){let f=Hc(n);if(f!==void 0)return f.join("");
  let m=u?n.join(""):Ya(n.join(""));
  return m.includes("\t")?$rr([m]).join(""):m}
function dC(n){ /* styled-piece variant of Oc: rewrites each piece's .text in place */ }
```

### (2) Measure AND render both go through it — v288 was asymmetric (root cause)

v288 measure (`cE` @213275517) vs v289 measure (`mE` @213590147):

```js
// v288: single-string, tab-gated only:
g = (wrap-mode) ? YW(m) : $q(m);
//   YW guard: if(!e.includes("\t"))return e;   ← stray ESC/C1 WITHOUT a tab: NO normalization
//   $q(n)=Rgr.test(n)?YW(Tc(n)):n              ← strip-then-YW; no C1/bidi replacement
// v289: piece-aware, ESC/C1-gated too:
g = Oc( n.nodeName!=="#text" && u9r(m) ? wr(n).map(M=>M.text) : [m], ja(y) );
```

v288 render (`Ps` @213384542) wrapped and wrote the **raw joined pieces**
(`X=I.map(ee=>ee.text).join("")` → `xv(X,...)` → `u.write(H,k,ce,Ee)` — no `YW`/`$q`),
while measure used `YW`-expanded text → measure/render disagreed on width and row
count → rows painted below the measured box. v289 render (`Gs` @213699402) uses the
same pipeline: `let Z=wr(n,...), ie=dC(Z);` then wraps/measures `ie` (with
`XX`=`Oc`-normalized strip for width tests).

### (3) Overdraw containment in the screen writer — NEW v289 (blit-cache invalidation)

- Node gains `paintsPastRect` (DOM factory `_r` @213587604; count v288=0 → v289=7).
  Setter propagates up the box tree (@213710428):
  `Q||=X.paintsPastRect===!0 ... return n.paintsPastRect=!Av(n)&&(K||Q),K`
  (`Av` = overflow hidden/scroll clip; `K` = child cachedLayout escapes parent rect).
- Cache-hit blit is no longer unconditional (v288 `Ps` blits on cache hit; v289 `Gs`
  requires `!gC(n,K,x)`), with `gC` (@213711217):
  `if(u.unpainted)return!0; return f!==void 0&&f.grew&&(n.hasAbsoluteDescendant===!0||n.paintsPastRect===!0||!Zl(f.now,f.before,{...rect}))`
  plus clip-growth tracking `{now,before,grew}` via `Ql`/`Zl`.
- `unpainted` marking NEW (`unpainted` count v288=0 → v289=5): `xC` (v288 `mC`) sets
  `cachedLayout={...,unpainted:!0}` and now clears (`tst`) display:none subtrees;
  `EC` (v288 `hC`) skips blitting `z.unpainted` layouts; zero-height skip branch
  (present in BOTH versions: v288 `K===0&&fC(n,T)` / v289 `z===0&&bC(n,H)`) now also
  resets `paintsPastRect=!1` and marks skipped subtrees unpainted.
- `clips` threading NEW: `Gs(n,u,f,{...,clips:x,...})`; child render `sf` passes
  `clips:R` down; ink-box computes `ce=g?yC(x,I,K?.clip):x` (clip chain), `pC` builds
  clip rects from overflow styles (v288 `ef` had no clips parameter).
- Closed lead: the screen-reader sanitizer (`Us`→`js`) and its guard regex
  `/[\x00-\x08\x0b-\x1f\x7f-\x9f؜‪-‮⁦-⁩]/` are **byte-identical**
  in v288/v289 — NOT the fix site.

### OCC A/B — live probes (`/tmp/probe19b.tsx`, offscreen PassThrough frames)

| Input | OCC frame (plain) | Official v289 semantics | Gap |
|---|---|---|---|
| `a\tb` | `a\x1b[7Cb` (tab → CUF escape) | `a       b` (literal spaces, 8-col stop, shared by measure+wrap) | CUF count is computed pre-wrap; after a soft wrap the column base is wrong → misplacement/overdraw on real terminals |
| `a\x1bb` (stray ESC) | `a` — **ESC and following char(s) swallowed** | ESC→`\x18`, rest kept (`a\x18b`) | silent content loss |
| `a\x9bb` (C1 CSI) | `ab` — C1 silently dropped | C1→`�` (visible) | silent drop vs visible replacement |
| `line1\rline2` | `line1line2` (CR dropped) | tokenizer forOutput keeps CR inside text token | minor divergence |
| `line1\r\nline2` + sentinel | `line1` / `line2` / `SENTINEL` — OK | same | none in this path |
| `a\tb\r\nc` in `height:1` box + sentinel | `ab` / `SENTINEL` — clipped, no overdraw, **content lost** | measures normalized text; rows beyond height skipped with unpainted marking | different failure mode (loss vs overdraw) |

No literal "drawing over the rows below" reproduced in OCC offscreen frames — OCC's
screen writer defensively skips malformed content instead — but the **root-cause
asymmetry is present**: measure expands tabs (`src/ink/dom.ts:370-372` expandTabs via
`src/ink/tabstops.ts:9-46`) while render wraps the **unexpanded** text
(`src/ink/render-node-to-output.ts:627-658`) and re-expands at screen-write
(`src/ink/output.ts:663-676`); `src/ink/measure-text.ts:11-45` splits `\n`-only while
`Bun.wrapAnsi` (via `src/ink/wrapAnsi.ts`) converts lone `\r`/`\r\n` to `\n` **at
render, adding rows**; `src/ink/output.ts:478-480` has no per-node vertical clip. On a
live terminal (wrap + CUF interaction, \r-conversion row inflation) this is the same
bug class the official fixed.

### PORT spec (minimal, faithful to v289)

1. Introduce one shared normalizer used by BOTH measure and render (port of
   `Oc/Hc/$rr/$se/Ua/Va/La/Ya` + constants): tabs → literal spaces at 8-col stops
   (column tracked across styled pieces, reset at `\n`), `\x1b`/`\x9b` → `\x18`,
   `\x90\x98\x9d-\x9f` → `�`, bidi `؜‪-‮⁦-⁩` → `�`.
   Files: `src/ink/measure-text.ts`, `src/ink/dom.ts` (measureTextNode),
   `src/ink/render-node-to-output.ts` (normalize pieces before wrap; drop CUF emission
   in `src/ink/output.ts:663-676`/`src/ink/tabstops.ts` once tabs are pre-expanded),
   `src/ink/stringWidth.ts`/`src/ink/widest-line.ts` (measure the normalized text),
   `src/ink/wrapAnsi.ts` (wrap normalized text so `\r` can't inflate rows),
   `src/ink/bidi.ts`/`src/ink/screen-reader-render.ts` (reuse the same FFFD maps).
2. e2e: `a\tb` frame contains 8-col spacing (no CUF); `a\x1bb` keeps `b` with `\x18`;
   `a\x9bb` shows `�`; `height:1` box with `x\ty\r\nz` doesn't touch the row below.

### STAGED (renderer deep-machinery, separate issue)

`paintsPastRect` up-propagation + `gC`/`unpainted` blit-cache invalidation +
clip-growth (`Ql/Zl/grew`) tracking + `clips` threading — v289's containment net for
any node that still paints past its rect. Requires an OCC renderer audit
(`src/ink/renderer.ts`, `src/ink/output.ts` blit/cachedLayout equivalents) before
porting; land after the normalization PORT.

---

## Evidence index (offsets into `/tmp/cc-diff-289/vXXX/package/claude`)

| Item | v288 | v289 |
|---|---|---|
| #11 border resolver | `Qx[..]??mv.default[..]` caller, `quote:{top:` @213376499 | `function Dvn` @203025539, `quote:{top:` @203025405, `Hmn`/`wBo` @~206373709 |
| #19 constants | (absent; `YW` @200797858 tab-gated) | @201062051 (`YSt=8,uR,hR,pR,_R,mR,gR,$se`) |
| #19 pipeline | `$q` @213239354, `YW` @200797858 | `$rr/p9r/Ua/Va/La` @201062272, `Ya/XX/Oc` @213553684, `dC` @213698657, `Hc` @213553915 |
| #19 measure fn | `cE` @213275517 | `mE` @213590147 |
| #19 render fn | `Ps` @213384542 | `Gs` @213699402, `paintsPastRect` setter @213710428, `gC/vC` @213711217, `sf/tst/xC/EC` @213712xxx, `bC/Av` @213711xxx |
| #12/#13/#21/#27 Client host | (`surface.rows`=0) | @218198922 (`ve`,`Re`,`ko`,`be`) |
| #17 agent list | `Yco` @208518832 | `nfo` @208823898, `i_o` teammate_spawned map |
| #18/#24/#25 draw failures | (absent) | `l1r/d1r/Pmn/vUt/Ae` @~206373709 region |
| screen-reader sanitizer | `Us` guard @213393704 region | `js` — byte-identical (not the fix site) |

Probe files (transient, /tmp only): `/tmp/probe19.tsx` (crash + height-1 box),
`/tmp/probe19b.tsx` (tab/CRLF/CR/C1/ESC matrix). Dumps: `/tmp/ins288.txt`,`/tmp/ins289.txt`,
`/tmp/up288.txt`,`/tmp/up289.txt`, plus the precomputed `new_strings.txt`/`removed_strings.txt`.
