# Upstream Version Gap — OCC-95 round (occ135)

Multica issue: **OCC-95**「OCC版本追齐官方Claude Code」(autopilot daily trigger 2026-09-24 01:00 Asia/Shanghai)
Date: 2026-09-24
Round type: **no-upstream-movement (latest/stable) → strict self-acceptance round** (issue's no-gap clause)
Predecessor: `docs/upstream-version-gap-occ134.md` (2.1.278→2.1.280 catch-up round, OCC v2.1.350)

## §1 Version facts (three-way verified, 2026-09-24)

| Source | Official Claude Code | OCC |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = **2.1.280**, `stable` = 2.1.267, `next` = **2.1.281** | `@cnwenf/occ` latest = **2.1.350** |
| GitHub releases `anthropics/claude-code` | newest **v2.1.280** (no v2.1.281 release) | `cnwenf/occ` newest v2.1.350 |
| Tracking marker | OCC tracks **2.1.280** (byte-verified through occ134) | — |

| Binary | Size | md5 |
|---|---|---|
| official linux-x64 v2.1.280 | 233,709,640 B | `31162c871610fc8111e7f08ca1be8218` (continuity with occ134 ✓) |
| official linux-x64 v2.1.281 (`next`) | 237,375,560 B | `d00df59384be94d0b5cac74849540075` (`// Version: 2.1.281` marker present) |

**No-gap determination:** `latest` unchanged at 2.1.280 since occ134 (which completed the
2.1.278→2.1.280 catch-up); no 2.1.281 on latest/stable and no v2.1.281 GitHub release.
→ The issue's no-gap clause applies: **strict self-acceptance** — run real tasks in the OCC
REPL like a human user, prioritizing recently-ported features, holding the highest standard
of consistency with the official binary (REPL behavior, output, params, error handling);
any inconsistency = record as a gap and fix per process.

## §2 Self-acceptance method (A/B harness)

- tmux 200×50, isolated HOMEs (`ab135/home-off`, `ab135/home-occ`), shared project dir
  (`ab135/proj` with AGENTS.md sentinel `ACCEPT95-SENTINEL-OK`).
- Third-party gateway env (dashscope `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` /
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` =
  `qwen3.8-max`, API key + auth token set; NO `ANTHROPIC_DEFAULT_FABLE_MODEL`, no
  `ANTHROPIC_DEFAULT_MODEL`) → provider=firstParty behind a custom base URL, non-subscriber,
  allowlist inactive (`Ov()`=true), Opus-1M-merge active (`jk()`=true).
- Official side: v2.1.280 ELF (`ab135/claude-official-280`). OCC side: this branch's build.
- Real human-style tasks: REPL boot, sentinel read + PONG (`-p` and interactive), Edit-tool
  round-trip, `/status`, `/model` picker open (capture-pane; stdout must be a TTY; no pipes).
- Captures archived under `ab135/captures/` (`off-*.txt` official, `occ-*.txt` OCC).

**Result:** boot / PONG / Edit round-trip / `/status` all consistent. The `/model` picker
showed **5 divergences** (Gaps A–E below) — recorded and fixed this round.

## §3 /model picker divergences (Gaps A–E) — evidence, root cause, fix

Evidence: `ab135/captures/off-model.txt` (official) vs `occ-model.txt` (pre-fix OCC), same
gateway env. All official sources byte-verified against the v2.1.280 linux-x64 ELF.

| ID | Divergence (pre-fix OCC → official) | Root cause → fix |
|----|-----------------------------------|------------------|
| **Gap A** | No Fable row. Official row 3: `Fable — Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok` | OCC `getModelOptions` lacked the official `wj` Fable post-step (@196280400): `allowlistInactive && firstParty && NSe() && !options.some(fi)` → insert `VG(X_(), fastMode)` via `ui` sorted-insert. Fixed in `modelOptions.ts`: ported `NSe` (isFableAvailableForPicker), `vv` (getFableMarketingName), `VG`/`YG` (fable row builders), `ui` (insertModelOptionSorted), `pj` (gateway-row decoration), `F7t`/`r7`/`Pv` (family→concrete + 1M-merge resolution), `Ov` (allowlist-inactive) |
| **Gap B** | Extra trailing row `qwen3.8-max ✔ Custom model` carrying ✔+focus; official instead puts ✔+focus on row 2 `qwen3.8-max ✔ Custom Opus model` (5 rows, no tail) | OCC's tail-row builder used strict string equality. Official gates the tail row on `zr` (family-aware row equality, @196283926) against existing rows and resolves the initial value with `F5t` (find-matching-option-value, @196282164). Fixed: ported `zr`→`modelRowsValueEqual`, `Rv`→`fableRowKey`, `F5t`→`findMatchingOptionValue`, `qt`/`Xn` (1m-tag strippers), `Pc`→`pickerFamily`, `fi`→`isFableModelValue`; ModelPicker initial value now `F5t(options, initial) ?? initial` (official `jt` @217541095 region) and the "Current model" row (`Nn` row-1) checks the RESOLVED value's strict presence + `qr(Or)` allowlist gate |
| **Gap C** | Default row: `Use the default model (currently qwen3.8-max)` — official: `(currently qwen3.8-max[1m])` | `getDefaultMainLoopModelSetting` lacked the 2.1.280 `cv` resolver upgrade (@193434108): `Xn() ? Qd() : al()` → `jk() ? WF(X_()) : X_()` — non-subscriber on an Anthropic-OWNED provider gets the merged Opus default (dedup'd `[1m]`), not Sonnet. Fixed in `model.ts` (env-default arm → ant arm → subscriber/owned-provider arm → mantle/bedrock/vertex/sonnet fallbacks) + new `isAnthropicOwnedProvider()` in `providers.ts` (port of `al` @193045941). Also aligned `parseUserSpecifiedModel` (`kt` @193434460 region): alias arms use `has1mTag ? WF(X()) : X()` (dedup, not concat), fable arm's tag-append gate, legacy-Opus remap gated on `al()` |
| **Gap D** | Footer: `Enter to set as defaults to use this session only · Esc to exit` — official: `Enter to set as default · s to use this session only · Esc to cancel` | Three defects: (1) footer hints nested inside ONE fragment child → `Byline`'s `Children.toArray` sees a single child → separators swallowed; (2) missing the `s` `KeyboardShortcutHint` and the singular/plural `set as default`/`confirm` switch on `onSessionOnlySelect`; (3) literal "exit" instead of `ConfigurableShortcutHint action="select:cancel"` ("cancel"). Fixed in `ModelPicker.tsx` `t27` footer (un-nested children, official `t31` @217547161 region shape) |
| **Gap E** | Effort line: `● High effort (default) ← → to adjust` — official: `←/→ to adjust` | Literal arrow text instead of `KeyboardShortcutHint shortcut="←/→" action="adjust"`; effort label also lacked the official `xhigh → "xHigh"` / capitalize mapping (`nr==="xhigh"?"xHigh":nr?xSt(nr):""`). Fixed in `ModelPicker.tsx` `t24` |

### Documented simplifications / staged items (this round)

- `sessionTail:!0` telemetry marker (official `bn()` @206369033) — never set; OCC has no
  session-tail telemetry consumer.
- `Nn` row-2 "Base model" row + `Vhe`/`Ht` session-override folding into the picker initial
  value — OCC keeps initial-only semantics (`Ht = initial`); the session-override resolver is
  not extracted. Staged (needs dedicated `Vhe` decompilation).
- Official `kt` 1P-fable-strip branch — dead under OCC's `modelSupports1M`
  (`claude-fable-*` → false); only the tag-append gate is ported.
- `ui`'s `fF()` (managed-settings rows) and `soe()?.picker.options` (managed picker)
  candidate sources; `Ov`'s `iF().size===0` managed-models term — omitted (no managed-picker
  surface in OCC; precedent `docs/upstream-version-gap-occ113.md`).
- `F7t`'s `yde(s)`/`AS(s)` (internal deprecated/coming-soon) exclusions — OCC's
  `ALL_MODEL_CONFIGS` has no such flags; every registered config is live.
- `Xn` strips `[1m]` only (official also `[2m]`) — no `[2m]` surface in OCC.
- Official footer's `!1` placeholder child (renders nothing) — omitted.

## §4 Verification

- New unit suite `modelOptionsHelpers280.test.ts`: **33 pass / 0 fail** (qt/Xn/Pc/fi/Rv/zr/F5t
  in isolation, incl. the A/B tail-row and picker-focus cases).
- Updated suites (semantic changes vetted against official 2.1.280 before editing):
  `anthropicDefaultModel236`, `opus55Launch280`, `modelOptionsTierWiring280` — model dir
  total **140 pass / 0 fail**.
- Pre-existing-failure A/B (git-stash proof): 3 tmux e2e timeouts in
  `version-2.1.329-effort-cap.e2e.test.ts` fail identically at HEAD without this round's
  changes → environmental (nested tmux in sandbox), not regressions; CI-gated-out per file header.
- `bun run build`: green (`dist/cli.js` 29.32 MB, MACRO.VERSION=2.1.350).
- Full CI gate `scripts/ci-test.sh` (clean env): see §4b.
- tmux `/model` A/B re-run vs `off-model.txt`: see §4b.

## §4b CI + A/B re-run results

**tmux `/model` A/B re-run (post-fix build, same gateway env, HOME=ab135/home-occ):**
picker section normalized-diff vs `ab135/captures/off-model.txt` → **MATCH: True** (all 9
lines identical; capture archived `ab135/captures/occ-model-postfix.txt`):

- Rows: `1. Default (recommended) — currently qwen3.8-max[1m]` (Gap C ✓) · `❯ 2. qwen3.8-max ✔ Custom Opus model` (Gap B ✓ — ✔+focus on the resolved opus row, NO trailing `Custom model` row) · `3. Fable — Fable 5.1 · Most capable… · $10/$50 per Mtok` (Gap A ✓) · `4/5. Custom Sonnet/Haiku` ✓
- Effort line: `● High effort (default) ←/→ to adjust` (Gap E ✓)
- Footer: `Enter to set as default · s to use this session only · Esc to cancel` (Gap D ✓ — separators restored via Byline un-nesting)
- Interaction: Down moves focus to row 3 ✓; Escape cancels with `Kept model as qwen3.8-max` ✓; live gateway turn `Reply with the single word PONG` → `● PONG` in 8s on the merged-Opus default (`qwen3.8-max[1m]`) ✓.

**Full CI gate** `scripts/ci-test.sh` (CI=true, clean env, per-file bun isolation):
**5771 pass / 0 fail / 115 skip — 597 files checked, 0 failed** (exit 0). Baseline at round
start was 5738 pass / 0 fail / 115 skip over 596 files; the delta is exactly the new
`modelOptionsHelpers280.test.ts` (+33 tests, +1 file). Zero regressions.

Semantic-drift tests updated this round (each vetted against the official 2.1.280 `cv`
resolver BEFORE editing — all asserted the pre-2.1.280 "PAYG → Sonnet default"):
`anthropicDefaultModel236.test.ts`, `opus55Launch280.test.ts`, `modelOptionsTierWiring280.test.ts`
(+8 Fable post-step rows), `useMainLoopModelWiring280.test.tsx` (PAYG → `claude-opus-5-5[1m]`),
`modelCostSonnet5Tier105.test.ts` (Default row → `Opus 5.5 (1M context)` + `$4/$20`).

## §5 2.1.281 (`next` channel) pre-triage — archived for the next round

2.1.281 is published on `next` only (no GitHub release; `latest`/`stable` unchanged), so per
the issue's tracking rule (stable/latest channel) it is NOT this round's target. Pre-triage
facts archived for the next round's full triage:

- String-level diff v280→v281: **19,520 new / 15,537 removed** unique strings
  (`cc-diff-281/new_281.txt` / `removed_281.txt`; identifier churn included).
- Binary: 237,375,560 B (+3.6 MB vs v280), md5 `d00df59384be94d0b5cac74849540075`.
- **35 genuinely-new `CLAUDE_CODE_*` env markers** (`cc-diff-281/env_genuinely_new.txt`;
  names carry trailing strings-extraction noise chars, re-verify before porting). Highlights:
  `CLAUDE_CODE_INLINE_TOOLS`, `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS`,
  `CLAUDE_CODE_MCP_APPS_HOST`, `CLAUDE_CODE_MARKETPLACE_NAME`,
  `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE`, `CLAUDE_CODE_HOST_GATEWAY_LINEAGE`,
  `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`, `CLAUDE_CODE_SUBAGENT_CACHE_EVICT`,
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET`,
  `CLAUDE_CODE_ARTIFACT_*` (3), `CLAUDE_CODE_*_FOR_TESTING` (2).

## §6 Disposition

- Gaps A–E: **fixed this round** (files: `src/components/ModelPicker.tsx`,
  `src/utils/model/{model,modelOptions,providers}.ts` + 4 test files).
- Staged items: §3 list (each with per-site rationale).
- Release: v2.1.35x after merge to main (publish.yml: build → npm publish → gh release).
