# Upstream version gap — OCC-108 round (2026-10-06)

> NOTE: `docs/upstream-version-gap-occ108.md` (no date suffix) is the OLD
> 2.1.248-era OCC-108 catch-up ledger. This file is the **2026-10 strict
> self-acceptance round** on Multica issue OCC-108
> (`741e0add-c1ea-4d94-a76f-653791bddf03`).

## 1. Round shape — no version gap

- Official latest (npm `@anthropic-ai/claude-code`): **2.1.289** — unchanged
  since the OCC-107 round.
- OCC version: **2.1.370** (already aligned to 2.1.289 surface).
- Therefore this round is a **self-acceptance round** per the dispatch:
  re-verify carry-over items, then drive the real REPL (tmux) like a human
  user and compare against the official binary; any inconsistency → gap →
  TDD fix → e2e → main.

## 2. Carry-over re-verification (all three closed)

| Item | Status |
|---|---|
| NPM_TOKEN rotation | **STILL NOT ROTATED.** npm `latest` for `@cnwenf/occ` is 2.1.367; Publish run 37256891728 for v2.1.370 failed E404 (`'@cnwenf/occ@2.1.370' is not in this registry` — auth failure). Owner action: rotate the secret, then **re-run** the Publish workflow for the existing v2.1.370 tag (idempotent — do NOT re-push the tag). Reminded in the issue. |
| STAGED #6a (plugin local-folder marketplace stale copy) | Still correctly staged — unchanged rationale (see occ139 ledger). |
| ink tab+wrap P2 residual | Deferred — OCC output is byte-identical to official; no user-visible gap. |

## 3. REPL self-acceptance (tmux, real machine, official 2.1.289 linux-x64 ELF as control)

Official control: `workdir/official-cc/native-x64/package/claude` (npm pack),
tmux session `ccB`. OCC under test: built `dist/cli.js` (`bun dist/cli.js`),
tmux session `occA`. Same playground, same idle states.

OCC-107 PORTED features — **all 7 consistent**:

| # | Feature | Verdict |
|---|---|---|
| 2 | hljs budgeted emitter | ✓ no freeze on large code block, output matches |
| 3 | symlink Read deny | ✓ denied on both sides |
| 11 | border-style validation | ✓ same rejection surface |
| 14 | env-prefix quote-aware stripping | ✓ denied on both sides |
| 16/22a | plugin-validate co-location | ✓ same message placement |
| 19 | ink text normalization | ✓ same wrapped output |
| — | trust dialog / PONG / Bash deny / Shift+Tab mode cycling (accept-edits, plan, auto footers) | ✓ byte-consistent |

Known ledgered re-observations (NOT new gaps): turn-duration `· done` suffix +
30s gate (Gap-140e P3), `/status` tabs/rows (occ119/occ133), session
auto-naming (Gap-140e).

## 4. NEW GAP found + fixed this round — manual-mode footer cycle hint (Gap-108f)

**Live divergence** (idle REPL, default/manual mode):

```
official: ⏸ manual mode on · ? for shortcuts · ← for agents
OCC (before): ⏸ manual mode on (shift+tab to cycle)
```

Every NON-default mode matched on both sides (`⏵⏵ accept edits on
(shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`, `⏵⏵ auto mode
on (shift+tab to cycle)`) — divergence was specific to default/manual mode.

**Binary evidence** (`workdir/official-strings.txt`, @36621715 region — the
footer-left renderer's non-loading branch):

- `Gn=!CQo(An)` where `An=E?.mode`; `function CQo(e){return e==="default"||e===void 0}`
  — OCC's existing `isDefaultMode()` is byte-equivalent.
- Mode chip: `es=An&&Is?e(s,{…children:e(Ix,{mode:An,children:Gn&&vs&&r(n,
  {dimColor:!0,children:[" ",e(B,{chord:Nt,action:"cycle",parens:!0,
  format:{keyCase:"lower"}})]})})},"mode"):null` → the `(shift+tab to cycle)`
  child renders ONLY when `Gn` (non-default mode) AND `vs` (`sr<2` +
  width-headroom terms; `sr=(Qo||Gn?1:0)+(rs?1:0)`).
- Shortcuts-hint fallback: `if(ds.length===0&&!Qr&&!(An&&Is&&Gn)&&!Ir&&
  is.length===0&&!vr&&N){if(!wn)ds.push(e(n,{dimColor:!0,
  children:"? for shortcuts"},"shortcuts-hint"))}` — `ds` EXCLUDES the mode
  chip, and the `!(An&&Is&&Gn)` term only suppresses the fallback for a
  NON-DEFAULT chip. So the manual-mode chip renders ALONGSIDE
  `? for shortcuts`.

Previously staged as ambiguous/cosmetic (occ118 §4 item 1, occ139 §4 item 4:
"官方页脚由段过滤器拼装，状态机需逐点反编译才可信"). The gate is now
decompiled per-site and byte-verified, and the live official footer confirms
the decompilation — the ambiguity that justified STOP is resolved.

**Fix (TDD, RED→GREEN):**

- `src/components/PromptInput/PromptInputFooterLeftSide.tsx`:
  - New exported pure helpers with byte-evidence docblocks:
    `shouldRenderModeCycleHint(mode, primaryItemCount)` (= `!isDefaultMode(mode)
    && primaryItemCount < 2`) and `shouldRenderShortcutsHint({partsCount,
    hasTasksPart, hasModePart, hasActiveModePart, showHint})` (=
    `partsCount===0 && !hasTasksPart && !hasActiveModePart && showHint`).
  - `shouldShowModeHint` rewired from `primaryItemCount < 2` to
    `shouldRenderModeCycleHint(currentMode, primaryItemCount)`.
  - Shortcuts-hint empty-check rewired from
    `parts.length===0 && !tasksPart && !modePart && showHint` to
    `shouldRenderShortcutsHint(…)` with `hasActiveModePart = !!modePart &&
    hasActiveMode` — the manual chip no longer suppresses `? for shortcuts`;
    a non-default chip still does (official `!(An&&Is&&Gn)`).
  - The fullscreen empty-row guard (`parts.length===0 && !tasksPart &&
    !modePart` → blank row) is a different concern and stays unchanged.
- `src/components/PromptInput/__tests__/manualModeCycleHint108.test.ts` (new):
  6 tests / 21 expects — default+undefined suppress the cycle hint at every
  primary-item count; all 5 non-default modes keep it below 2 items and lose
  it at 2+; shortcuts hint renders with the manual chip, suppressed by a
  non-default chip / any part / tasks pill / `showHint=false`.
- e2e ready-marker updates (default-mode boots no longer render "shift+tab"):
  `goal-gate` ×2, `trust-gate` ×3 (non-bypass cases; the
  `--dangerously-skip-permissions` cases keep the hint — bypass is
  non-default), `version-hooks-2.1.248` ×1, `version-2.1.210-plan-approval`
  ×2 → marker switched to the always-present chip text `manual mode on`;
  stale "mode chip suppresses the shortcuts hint" comments corrected.

**STAY STAGED** (not guessed, per `aligning-with-official-binary`):

- `← for agents` manual-mode footer segment (separate renderer concern, not
  decompiled per-site this round).
- The `vs` width-headroom terms (`Gt<60+(Kr?8:0)+ss` etc.) — only the
  `sr<2` primary-item term is ported.

**Verification:**

- New unit test GREEN (6 pass / 21 expect); PromptInput suite 53 pass.
- Full `bun test src`: 7737 pass / 105 fail — **identical failure count to
  the clean-HEAD baseline** (stash A/B: 105 fail on clean HEAD too; all
  pre-existing, none in touched files; sample isolates pass 45/45).
- e2e: goal-gate + trust-gate + version-hooks-2.1.248 → **19 pass / 0 fail**.
  repl-interactive + both keybinding-flavor suites → 8 pass / 1 fail; the
  failure ("Shift+Tab shows the auto-mode opt-in dialog") reproduces
  identically on clean HEAD (stash A/B) — pre-existing since OCC-44 §4, not
  caused by this change.
- `bun run build` green (dist/cli.js 29.84 MB, MACRO.VERSION=2.1.370).
- **Live tmux parity re-check with the new build**: OCC manual-mode footer
  now renders `⏸ manual mode on · ? for shortcuts` (official: `⏸ manual
  mode on · ? for shortcuts · ← for agents` — residual = the staged
  `← for agents` segment only); plan/auto modes keep
  `(shift+tab to cycle)` on both sides.

## 5. Handoff

Code changed this round → `@OCC 安全审核员` relay per the dispatch. Release
cut stays gated on acceptance (no version bump this round — the fix rides the
next release train).
