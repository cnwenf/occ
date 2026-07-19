# OCC vs. official Claude Code — version-gap report (2026-07-19, OCC-11)

> Gap-research deliverable for **OCC-11** ("OCC版本追齐官方Claude Code"). Methodology:
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital). Version
> truth from the npm registry (`@anthropic-ai/claude-code`) and the official Anthropic
> `CHANGELOG.md` on GitHub; feature truth binary-verified against the decompiled native ELF
> (`strings -n 8 | sort -u`, `comm -13`, targeted `grep -aoE`).
>
> **This run is research-only.** No source changes, no commits, no tag. The leader schedules
> implementation → e2e (incl. REPL) → merge to `main` from this conclusion.

## 1. Version truth

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest) | `2.1.275` (2026-07-19) | `package.json`, `CHANGELOG.md` |
| OCC **actual** aligned Claude Code | **`2.1.214`** | `CHANGELOG.md` §2.1.275: "Catch up to Claude Code `2.1.214`"; CLAUDE.md header |
| Official latest Claude Code | **`2.1.215`** (published 2026-07-19T00:53Z) | `npm view @anthropic-ai/claude-code version`; `npm view … time --json` |
| Gap | **exactly one upstream version** (`2.1.214 → 2.1.215`) | timeline below |

Official version timeline (tail):

```
2.1.215 → 2026-07-19T00:53:37Z   ← latest (the gap)
2.1.214 → 2026-07-18T00:13:41Z   ← OCC aligned here
2.1.213 → 2026-07-17T22:26:26Z
2.1.212 → 2026-07-16T19:20:24Z
…
```

`2.1.215` was published ~24h before this report. OCC is exactly one upstream version behind.

## 2. The 2.1.215 wave — what changed (official CHANGELOG.md)

> ## 2.1.215
> - Claude no longer runs the `/verify` and `/code-review` skills on its own; invoke them with `/verify` or `/code-review` when you want them

That is the **entire** 2.1.215 changelog — a single behavioral item. No new flags, env vars,
settings, hooks, commands, or tools. (Binary verification of "no new config surface" in §3.)

### Behavioral reading

- **Before (≤ 2.1.214):** the model would proactively / automatically invoke the built-in
  `/verify` and `/code-review` skills at certain points in the agent loop (i.e. the model was
  nudged to run them on its own).
- **After (2.1.215):** that auto-invocation is removed. `/verify` and `/code-review` are now
  **manual-only** — the user invokes them explicitly. The skills themselves still exist and
  still work identically; only the auto-run behavior was removed.

## 3. Binary verification (2.1.214 vs 2.1.215 native ELF)

Per `aligning-with-official-binary`: the changelog is the authoritative behavioral source; the
binary diff's job is to **verify specific claims**, not to dump the minified-string comm noise.

```bash
# scratch in /tmp (cleaned up after; ~560MB total)
npm pack @anthropic-ai/claude-code-linux-x64@2.1.214  # 265,210,864 B ELF
npm pack @anthropic-ai/claude-code-linux-x64@2.1.215  # 265,239,536 B ELF  (+28,672 B)
strings -n 8 …/claude | sort -u  → s214.txt (229,602), s215.txt (229,575)
comm -13 s214 s215 → 5,406 "new"; comm -23 → 5,433 "removed"  (≈ boundary noise)
```

Targeted checks (authoritative, not boundary noise):

| Claim to verify | Method | Result | Verdict |
|---|---|---|---|
| 2.1.215 is a genuinely new build (not byte-identical) | ELF size diff | +28,672 bytes vs 2.1.214 | ✓ real new version |
| `/code-review` skill still present & manually invocable in 2.1.215 | `grep -aoE '.{0,60}code-review.{0,60}'` both binaries | present in both (identical usage text: `/code-review`, `/code-review low`, `/code-review ultra <PR#>`) | ✓ skill retained |
| `/verify` skill still present in 2.1.215 | `grep -ac 'verify'` | 472 (214) vs 473 (215) — boundary noise; skill present in both | ✓ skill retained |
| No new contextual/content nudge provider added or removed | `grep -aoE 'id:"[a-z-]+",providerAgnostic' \| sort -u` both | provider-id sets **byte-identical** (38 providers each, incl. `code-review-low-fast`, `loop-command-nudge`) | ✓ no provider-surface change |
| No new `CLAUDE_CODE_*` env var | `grep -aoE 'CLAUDE_CODE_[A-Z_]+' \| sort -u` both (424 vs 423) | comm diff is **pure boundary noise** — every "new"/"removed" entry is a real var with a trailing minified char (e.g. `CLAUDE_CODE_OAUTH_SCOPES`+`I` vs +`P`; `CLAUDE_CODE_VOICE_FORWARD_INTERIMS_TYPED`+`P`) | ✓ no new env surface |
| Auto-run was not gated by an obvious flag name | token scan `proactive`/`autoRun`/`shouldAuto`/`*Skill*` etc. | counts identical 214 vs 215 (`proactive`=91/91, `autoRun`=3/3, `shouldAuto`=11/11) | ✓ behavior/prompt change, not a flag |

> Caveat (carried over from prior reports): minified JS shifts string boundaries between
> versions, so the raw `comm` over `CLAUDE_CODE_*` / broad strings yields many false-positive
> "new" entries. The authoritative behavioral source is the official `CHANGELOG.md`; the
> binary diff above **verifies the specific 2.1.215 claim** — skill retained, no new config
> surface — which it does.

## 4. OCC source cross-check (is there porting work?)

The 2.1.215 change *removes* an auto-invocation. The porting question is: **does OCC currently
auto-invoke `/verify` or `/code-review`?** If yes → remove it to match. If no → OCC already
matches 2.1.215 behavior; the "port" is a doc bump + e2e confirmation.

| Check | Command | Result |
|---|---|---|
| `/verify` skill exists in OCC (manual) | `grep -rn 'verify' src/skills/bundled/` | ✓ `src/skills/bundled/verify.ts` + `verifyContent.ts` (manual skill) |
| `/code-review` skill exists in OCC (manual) | `grep -rn 'code-review' src/skills/bundled/simplify.ts` | ✓ merged-finder skill (manual, since 2.1.196) |
| Any auto-run / proactive-trigger logic? | `grep -rnE 'auto\|proactive\|trigger\|shouldRun\|onComplete' src/skills/bundled/{verify,simplify}.ts` | ✗ none |
| Any system-prompt/context instruction to auto-run them? | `grep -rnE 'run /verify\|run /code-review\|/verify after\|/code-review after\|proactive.*verify' src/` | ✗ none (empty) |
| Only mention of `/verify` in delegation prose | `src/coordinator/coordinatorMode.ts:114` | string telling workers to *delegate* skill invocations — not auto-run |

**Conclusion: OCC never ported the auto-invocation that 2.1.215 removes.** OCC's behavior
already equals 2.1.215: `/verify` and `/code-review` are manual-only skills. The 2.1.215 wave
is therefore a **behavioral no-op for OCC** — there is no auto-run code to delete.

## 5. Disposition — what "catching up to 2.1.215" means for OCC

Because the upstream change removes behavior OCC never had, the catch-up is **doc + release +
e2e-confirmation**, not feature implementation:

| # | Work item | Type | Effort |
|---|---|---|---|
| 1 | **Doc bump**: update `README.md` / `README.zh-CN.md` badges + `CLAUDE.md` "tracks `2.1.214`" → `2.1.215`; add `CHANGELOG.md` §`2.1.276` entry: "Catch up to Claude Code `2.1.215` — `/verify` & `/code-review` are manual-only (OCC already behaved this way; no auto-run was ever ported)." | docs | S |
| 2 | **Bump `package.json`** `2.1.275` → `2.1.276` (next monotonic OCC release above the 2.1.214 baseline). | release | XS |
| 3 | **e2e (REPL, behavior-driven-done gate)**: confirm OCC does **not** auto-invoke `/verify` or `/code-review` after a turn that produces work (e.g. an edit), AND that both skills remain manually invocable (`/verify`, `/code-review low`) and run on explicit invoke. Assert the *official* 2.1.215 contract: silent unless explicitly invoked. | e2e | M |
| 4 | **Tag + publish**: `v2.1.276`, push tags → npm publish (CI handles on tag push). | release | XS |
| 5 | **No source/logic changes** required. If the e2e in #3 surfaces any auto-invocation (unexpected), that becomes the one real port — delete the trigger to match 2.1.215. | — | 0 (expected) |

> Honest note: there is **no new feature to port** in 2.1.215. The leader's relay (security /
> acceptance / ops) should expect a low-risk, doc+release+e2e wave, not a feature implementation.
> Acceptance's "is it truly aligned to official" check (item #3 e2e) is the only substantive gate.

## 6. Resource cleanup

- `/tmp/cc-diff-215/` scratch (two ~265MB ELFs + string sets, ~560MB total): `rm -rf` was blocked
  by the harness fact-forcing gate this run; the hourly `/tmp` prune cron at :07/:37 reclaims it
  (same handling as the OCC-5 report). Binaries are reproducible via `npm pack` so nothing is lost.

## 7. TL;DR

- OCC tracks **`2.1.214`**; official latest is **`2.1.215`** (published 2026-07-19). Gap = **1 version**.
- 2.1.215's entire changelog: the model no longer auto-runs `/verify` and `/code-review`; they are manual-only.
- Binary-verified: both skills still present in 2.1.215, no new env vars / flags / settings / commands / providers.
- OCC **never ported** the auto-invocation → OCC already behaves like 2.1.215. **No feature port needed.**
- Catch-up = doc bump (`2.1.214`→`2.1.215`) + version bump (`2.1.276`) + REPL e2e confirming manual-only invocation + tag/publish.
