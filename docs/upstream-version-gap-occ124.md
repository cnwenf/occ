# Upstream Version Gap — OCC-124 (official 2.1.269 → 2.1.270)

- **Round:** OCC-124 (autopilot 版本追齐, 2026-09-14)
- **OCC aligned-at (round start):** official Claude Code `2.1.269` — OCC release `2.1.333`
- **Official latest (round start):** `2.1.270` (npm published `2026-09-12T18:52:44.937Z`; binary `BUILD_TIME` `2026-09-12T18:08:42Z`, `GIT_SHA` `97ecbf7abeb4170dcfd26c4d4b397afd9015030e`)
- **Method:** `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.269,2.1.270}` → full-binary **module-split pairwise diff**: split the text-JS region at the 1681 `\n// Version: 2.1.NNN\n` module headers (index order identical across builds), canonicalize (`chunk-*.js`→`chunk-X.js`, version/timestamp/sha normalization), then two masking passes — (1) mask **all** identifiers → structural diff; (2) mask bare identifiers, **preserve** property accesses → catches call/property swaps. Surviving clusters re-diffed at line level (pseudo-lines split on `;{}`) with `difflib` opcode clustering (gap ≤ 3 lines merged) to isolate the real hunks. Strings-level `comm` diff + `win.py` fixed-substring window extraction used for corroboration.
- **Binary sha256:**
  - v269: `25e44883f54419569a3d739f38cbbdaebe83b09895da0f343e1b003710a4775b` (matches OCC-123 ledger), size 219,651,568
  - v270: `3a624a5a7cd79bbad4d32bd7db36f1197ecf458bc5bf1e2aed81834a01ad3ef0`, size 223,981,040
- **Strings diff:** v269 279,836 / v270 279,834 unique; 7,303 added / 7,305 removed (short-line filtered inspection: **all** added/removed pairs are minifier rename noise — e.g. the skills `loadedCommands` cache key `` `${iNr()}:${Rh()}:${ke()}:${ev()}:${f7()}:${vde()}:${e}` `` (v269) vs `` `${aNr()}:${Rh()}:${ke()}:${ev()}:${p7()}:${Cde()}:${e}` `` (v270) is the same 6-component key with renamed getters; `permissions_external-09691b13.txt.zst` embedded-data hash **identical** in both).
- **Official 2.1.270 changelog:** exactly 1 bullet — `Fixed read-only git commands in Bash unexpectedly asking for permission after a session had been running for a while (regression in 2.1.269)`.

**Bun-binary layout note (this round):** the text-JS region (1681 modules, ~40 MB) shifted by exactly +4,328,448 bytes in v270 while growing only +1,024 bytes itself (module 274: +358, module 1680 Bun tail metadata: +666); the remaining ~4.33 MB growth is entirely in the **bytecode region** (chunks `// @bun @bytecode`, no textual function bodies). Bytecode encodes identifier names, so the v269→v270 minifier rename cascade recompiles essentially every chunk — the region is opaque to source-level diffing this round.

**Verdict summary:** 0 LAND, 1 STAGED-because-bytecode (the changelog git-permission fix), 4 NO-OP (text-region deltas — refusal-fallback machinery absent from OCC by design).

---

## 1. Exhaustive text-region delta (all 1681 modules)

Pass (1) (all-identifier mask): only modules **274** and **1680** differ structurally. 1680 is the Bun ELF tail (chunk-name table + `---- Bun! ----` metadata) — build noise. Module 274 (the 5.98 MB main CLI module) line-level masked diff yields exactly **5 hunks / 4 functional changes**, all in the refusal-fallback + model-error-retry machinery:

### F1 — refusal-fallback latch bypass option `visibleRouteDeclined` (hunks @77695, @127490; +39 B)

```js
// v269
function bpt(e){if(dG(e))return;return fG()&&Nn(e)===Nn(pc())?e:void 0}
// v270
function Spt(e,{visibleRouteDeclined:n=!1}={}){if(!n&&dG(e))return;return fG()&&Nn(e)===Nn(pc())?e:void 0}
// call site (refusal arm wiring): v269 `()=>!mt&&!Ct?bpt(tE):void 0`
//                              → v270 `(js)=>!mt&&!Ct?Spt(nE,{visibleRouteDeclined:js}):void 0`
```

### F2 — refusal retry-outcome state reset + telemetry (hunks @127765–127779; +219 B)

```js
// v270 inserts before `yield{type:"query_model_change",...}`:
let SC=bp;
if(SC)bp=!1,Yd=void 0,Fu=void 0,i("tengu_convolute_arcades_retry_outcome",{
  outcome:y("error"),queryChainId:Zo,queryDepth:Wr.depth,querySource:ii(A)});
if(yield{type:"query_model_change",toModel:js.fallbackModel},SC)
  yield{type:"refusal_continuation",phase:"end"};
```

### F3 — "bio"-category silent rearm when route unmatched (hunk @155446; +82 B)

```js
// v269
let Xb=_h==="refusal"&&hm===void 0?m.refusalFallbackSilentRearm?.():void 0,pv=fg??Xb;
// v270
let Jb=up?.matched==="none"&&ll.delta.stop_details?.category==="bio"&&!iz(),
    mv=_h==="refusal"&&(hm===void 0||Jb)?m.refusalFallbackSilentRearm?.(Jb):void 0,Uh=cg??mv;
```

### F4 — version-banner literals

`VERSION:"2.1.270"`, `BUILD_TIME`, `GIT_SHA` in the ~12 embedded `cli:{ISSUES_EXPLAINER,...}` banner objects — expected per-build churn.

Pass (2) (property-preserving mask, catches bare-identifier call swaps): 16 modules differ; 14 of them are **spread-rename artifacts** (`...Gq`→`...qq` — the `.foo` inside `...foo` is protected by the property regex), verified hunk-by-hunk; the remaining 2 are modules 274/1680 above. **No git/bash-permission code changed anywhere in the text region** — the `safeFlags` git-command table window (v269 @184077267 / v270 @188411588, ±45 KB) diffs to pure renames; `editRuleContents`-cache region likewise.

**OCC surface check (F1–F3):** `grep -r` over `src/` finds **none** of `refusalFallbackSilentRearm`, `x-is-refusal-fallback`, `x-cc-fallback-latched-by`, `visibleRouteDeclined`, `refusal_continuation`, `refusal_fallback_prompt`, `armedFallbackModel`, `stop_details`, `convolute_arcades`. OCC's refusal handling is the plain `getErrorMessageIfRefusal` path (`src/services/api/errors.ts:1220`, `claude.ts:2592`) with `fallbackModel` list support (`src/utils/model/fallbackModel.ts`) — the refusal-fallback *dialog/latch/rearm* subsystem (SDK-assistant machinery) was never an OCC surface. **Verdict: NO-OP ×4.**

## 2. The changelog git-permission fix — STAGED (bytecode-opaque)

`Fixed read-only git commands in Bash unexpectedly asking for permission after a session had been running for a while (regression in 2.1.269)`:

- Not present in the text region (exhaustive per §1 — the bash/git permission code there is rename-identical).
- Therefore the fixed code lives in a **bytecode-only chunk**; with ~4.33 MB of region-wide recompile noise from the rename cascade, the delta cannot be recovered as source this round.
- Adjacent GitHub issues probed (`gh search`): #92484 (`git diff -U0` prompting), #91837 (`cd DIR && ...` compounds losing auto-approval, 2.1.258-era), #91754/#91694 (auto-mode classifier) — none is the exact 2.1.269 regression report; the fix mechanism stays unconfirmed.
- **OCC exposure audit:** the regression class is "decision flips after the session ages" ⇒ requires a TTL/staleness/eviction mechanism in the permission-decision path. OCC's path — `src/tools/BashTool/readOnlyValidation.ts` (2000 L), `src/utils/shell/readOnlyCommandValidation.ts` (1893 L), `src/tools/BashTool/bashPermissions.ts`, `src/utils/permissions/{filesystem,permissions}.ts` — contains **no TTL caches** (grep for `ttl|expire|setTimeout.*delete|stale` returns comment-only hits about snapshot handling, none about cache expiry). OCC's 2.1.269 E14 port (per-source `!`-negation deny/ask scoping) is deterministic per-call with no session-age state. **The regression cannot manifest in OCC's implementation as written.**
- **Action:** behavior-verify in self-acceptance (read-only git commands must stay auto-allowed across a long-running OCC session, §4); monitor 2.1.271+ text region for the fix surfacing (if the module migrates back to text or a follow-up string appears, port then).

## 3. STAGED / NO-OP ledger (this round)

| # | Item | Verdict | Reason |
|---|---|---|---|
| G1 | changelog git read-only permission regression fix | **STAGED** | bytecode-only; OCC exposure audited negative (§2); behavior-verified in §4 |
| F1 | `visibleRouteDeclined` latch bypass | NO-OP | refusal-fallback dialog subsystem absent from OCC |
| F2 | retry-outcome reset + `tengu_convolute_arcades_retry_outcome` + `refusal_continuation:end` | NO-OP | same subsystem absent; OCC telemetry stubbed |
| F3 | `bio`-category silent rearm on unmatched route | NO-OP | same subsystem absent |
| F4 | version banners | NO-OP | build metadata |

## 4. Verification (no LAND gaps ⇒ strict self-acceptance per issue mandate)

**Focus:** 2.1.269-port recents first (E14 per-source `!`-negation scoping, E43 `tee` write-path, E29 permission-denial flags, E27/E51 CJK suggestions, E23 alt-screen cursor), then core trunk consistency; plus the §2 behavior check (read-only git stays auto-allowed in a long session).

**No source code changed this round** — the delta is this ledger + release metadata only, so the regression surface is nil; verification re-runs the 2.1.269-port acceptance set on the current tree.

**Unit sweep (per-directory `bun test` with timeouts):** `src/tools` 627/627 pass (incl. the 269-port suites `teeWritePath269`, BashTool 400/400), `src/services` 358/358, `src/utils/permissions` + `src/utils/shell` + `src/services/tools` + `src/services/tips` 198 pass / 1 skip / 0 fail (incl. `permissionDenialFlag269`, `resumeStaleness269`), `src/query` 9/9, `src/hooks` 17/17, `src/screens` 6/6, `src/components` 166/166. `src/utils` 23 fail + `src/commands` 1 fail/1 error — **pre-existing**, identical to the OCC-123 baseline (23 utils + `lineage.compact.test.ts` export error); working tree carries only this untracked doc, so A/B identical by construction.

**Build:** `bun run build` green — `dist/cli.js` 29.05 MB (30,456,583 B), `MACRO.VERSION=2.1.333` injected; `bun dist/cli.js --version` → `OCC 2.1.333`.

**Structural e2e (host mode):** `occ-versioning`, `commands-alignment`, `resume-interrupted-turn-221`, `version-2.1.98-160-bashperm-safety-gaps`, `version-2.1.160-196-permission-gaps` → **32/32 pass**. `repl-interactive` 2 pass / 1 fail — the fail is the known pre-existing auto-mode opt-in dialog case (documented since OCC-44, same as OCC-123).

**Live smoke (real API, dashscope gateway):** `echo "say PONG" | bun dist/cli.js -p` → `PONG`, exit 0.

**Live tmux REPL acceptance (trusted temp HOME, scratch git repo, default manual mode — NO `--dangerously-skip-permissions`):**

1. **§2 behavior check — read-only git auto-allow across an aged session:** turn 1 `git status --short` + `git log --oneline -3` → both executed with **no permission dialog**, correct answers (`?? b.txt`; `c2`/`c1`). Turn 2 compound pipeline `git diff HEAD~1 -- a.txt | head -8` → auto-allowed, correct summary. **After 4 turns + ~4.5 min wall-clock** (turns + idle), `git status --short` and `git rev-parse --abbrev-ref HEAD` again → **still auto-allowed, no dialog**, session context retained (model referenced the earlier denial unprompted). The official 2.1.269 regression class does not manifest in OCC. ✅
2. **Write-path permission gate:** `echo test > c.txt` → dialog `Do you want to proceed? [Yes / Yes+always / No]` with correct command preview; denied → `Interrupted · What should Claude do instead?`, file **not** created; subsequent turns unaffected. ✅
3. **Workspace-deletion guard (in vivo):** agent-side `rm -rf <workspace subdir>` → refused with `Dangerous rm operation detected … cannot be auto-allowed by permission rules`. ✅
4. **E27/E51 CJK rendering:** typed `解释一下git仓库的` into the prompt box → rendered intact, no mojibake/cursor corruption. ✅
5. REPL boot: OCC-branded banner, `MODEL qwen3.8-max`, `PROJ git:main`, auth-conflict advisory (TOKEN+API_KEY both set) displayed correctly; `/exit` clean teardown. ✅

**Release 2.1.334:** merged via PR #367 (merge commit `f328f52`); CHANGELOG `## 2.1.334 - 2026-09-14 (OCC-124)` + header caught-up pointer → `2.1.270`; `package.json` 2.1.333 → 2.1.334; tag `v2.1.334` on the merge commit triggered `publish.yml` run 34774553094 → **success**. Verified: npm `@cnwenf/occ` version = `2.1.334`, dist-tag `latest` = `2.1.334`; `gh api` releases count == tags count (134 == 134); GitHub Release https://github.com/cnwenf/occ/releases/tag/v2.1.334 ; remote branches = `main` only (agent branch deleted).
