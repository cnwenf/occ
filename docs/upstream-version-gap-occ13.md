# OCC vs. official Claude Code — version-gap report (2026-07-20, OCC-13)

> Gap-research deliverable for **OCC-13** ("OCC版本追齐官方Claude Code"). Methodology:
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital). Version
> truth from the npm registry (`@anthropic-ai/claude-code`) and the official Anthropic
> `CHANGELOG.md` on GitHub.
>
> **This run is research-only at the version-truth layer.** OCC-11 (release `2.1.276`,
> 2026-07-19) already caught OCC up to Claude Code `2.1.215`. This report confirms whether any
> newer upstream version exists as of 2026-07-20 and whether any further alignment work is
> required. Conclusion first: **there is no upstream gap to close.**

## 1. Version truth

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest on `main`) | `2.1.276` (2026-07-19) | `package.json`; `origin/main` HEAD `3b480cc`; `CHANGELOG.md` §2.1.276 |
| OCC **actual** aligned Claude Code | **`2.1.215`** | `CHANGELOG.md` §2.1.276: "Catch up to Claude Code `2.1.215`"; `CLAUDE.md` header; `docs/upstream-version-gap-occ11.md` |
| Official latest Claude Code (npm `latest` tag) | **`2.1.215`** | `npm view @anthropic-ai/claude-code version` → `2.1.215` |
| Official latest Claude Code (npm `next` tag) | **`2.1.215`** | `npm view @anthropic-ai/claude-code dist-tags` → `{stable:2.1.205, latest:2.1.215, next:2.1.215}` |
| Official latest Claude Code (GitHub `CHANGELOG.md`) | **`2.1.215`** | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` — top entry `## 2.1.215` |
| Newer pre-release on npm | **none** | `npm view … versions --json` tail: `…2.1.211, 2.1.212, 2.1.213, 2.1.214, 2.1.215]` (467 total, 2.1.215 is last) |
| Gap | **0 versions** | timeline below |

Official version timeline (tail):

```
2.1.215 → 2026-07-19T00:53:37Z   ← official latest; OCC aligned here (OCC-11, release 2.1.276)
2.1.214 → 2026-07-18T00:13:41Z
2.1.213 → 2026-07-17T22:26:26Z
2.1.212 → 2026-07-16T19:20:24Z
…
```

`2.1.215` was published 2026-07-19T00:53Z. OCC's `2.1.276` catch-up release is dated
2026-07-19 (same day). This report is run 2026-07-20 — ~1 day later; **no new upstream
version has been published in that window**. `latest` and `next` dist-tags on npm both
still resolve to `2.1.215`, and the official GitHub `CHANGELOG.md` top entry is still
`## 2.1.215`. There is no `2.1.216` or newer on the registry or in the changelog.

## 2. The 2.1.215 wave — already ported (recap)

The entire official `2.1.215` changelog is a single behavioral item:

> ## 2.1.215
> - Claude no longer runs the `/verify` and `/code-review` skills on its own; invoke them with `/verify` or `/code-review` when you want them

OCC-11 already disposed of this wave (see `docs/upstream-version-gap-occ11.md` §4–§5):
OCC never ported the auto-invocation that 2.1.215 removes, so OCC's behavior already
matched 2.1.215. The catch-up was a doc bump + version bump (`2.1.276`) + e2e
confirmation, all merged to `main` in `082ed83` (and the `v2.1.276` tag backfilled in
`3b480cc`). No source/logic change was required then, and none is required now.

## 3. Binary verification — not applicable this run

`aligning-with-official-binary` prescribes a native-ELF string diff to *verify specific
changelog claims* when a new upstream version exists. Here there is **no new upstream
version**: the candidate pair would be `2.1.215` vs `2.1.215`, which is byte-identical by
construction (same npm tarball, same published artifact). A binary diff would produce zero
new/removed strings and verify nothing beyond what OCC-11 already verified for the
`2.1.214 → 2.1.215` transition. Per the skill's version-selection rule ("Skip no-op
versions … binary is byte-identical"), this diff is skipped — no ~560 MB of reproducible
ELF tarballs are downloaded or left in `/tmp`.

## 4. OCC source cross-check (is there porting work?)

No. The only upstream behavior in scope (`2.1.215`) was already reconciled in OCC-11.
Re-confirming the two anchor facts:

| Check | Command | Result |
|---|---|---|
| `/verify` skill exists in OCC (manual) | `grep -rn 'verify' src/skills/bundled/` | ✓ present (manual skill) |
| `/code-review` skill exists in OCC (manual) | `grep -rn 'code-review' src/skills/bundled/` | ✓ present (manual, merged-finder) |
| Any auto-run / proactive-trigger logic added since OCC-11? | `grep -rnE 'auto.*verify|proactive.*verify|auto.*code-review' src/` | ✗ none |

**Conclusion: no porting work.** OCC remains behaviorally aligned to `2.1.215`.

## 5. Disposition — what "catching up" means for OCC-13

Because OCC is already at the official latest and no newer upstream version exists, the
catch-up is **a no-op version-gap confirmation + a fresh real e2e (incl. REPL) regression
gate**, not a feature implementation:

| # | Work item | Type | Effort | Status |
|---|---|---|---|---|
| 1 | **Version-truth confirmation**: npm `latest`/`next` = `2.1.215`; GitHub CHANGELOG top = `2.1.215`; no `2.1.216+`. | research | XS | ✓ done (§1) |
| 2 | **No source/logic changes** required — OCC already at `2.1.215` (OCC-11, merged to `main`). | — | 0 | ✓ confirmed (§4) |
| 3 | **No version bump** — `package.json` stays `2.1.276`; no new release tag. (Bumping would imply a new upstream version that does not exist.) | release | 0 | ✓ n/a |
| 4 | **Real e2e incl. REPL** (regression gate): rebuild `dist/cli.js`, smoke pipe mode, drive an interactive `tmux` REPL session, and re-assert the 2.1.215 contract — `/verify` & `/code-review` are silent unless explicitly invoked. This is the only substantive gate this wave; it guards against drift since the OCC-11 merge. | e2e | M | see §6 |
| 5 | **Doc**: this gap report (`docs/upstream-version-gap-occ13.md`) + `CHANGELOG.md` pointer note + `CLAUDE.md` catch-up pointer bumped to reference `occ13`. | docs | XS | this commit |

> Honest note: there is **no new feature to port and no new version to align to** in this
> wave. The leader's downstream relay (security / acceptance / ops) should expect a
> confirmation + regression-e2e wave, not a feature implementation. Per the issue brief, when
> there is no version to align to, the substantive work shifts to ops (X promotion of the
> GitHub project) — that is the operations agent's lane, not the programmer's.

## 6. Real e2e (incl. REPL) — regression gate

Re-run against the current `main` build to confirm no drift since the OCC-11 merge. Full
commands + captured output are recorded in the result comment on OCC-13; summarized here:

- **Build**: `bun install` → `bun run build` → `dist/cli.js` produced, `occ` launches and prints `OCC 2.1.276`.
- **Pipe mode smoke**: `occ -p` responds to a non-work prompt with no hang.
- **2.1.215 contract (pipe, behavior-driven-done gate)**: after a work-producing turn (file create), the `Skill` tool is not auto-invoked for `/verify` or `/code-review` — silent unless explicitly invoked.
- **Manual invocation**: `/code-review low` on explicit invoke emits a Code Review Report; `/verify` and `/code-review` remain manually invocable.
- **Interactive REPL (tmux)**: per the `repl-tmux-e2e-testing` skill — launch `occ` in a tmux pane, send a prompt, assert the REPL renders a response (not a blank alt-screen), then exit cleanly. This is the gap the OCC-11 run flagged as blocked by the sandbox's MCP-init stall / Ink alt-screen capture quirk; OCC-13 retries it.

## 7. Resource cleanup

- No npm tarballs or ELF binaries downloaded this run (§3), so there is nothing in `/tmp` to
  prune. The hourly `/tmp` prune cron at :07/:37 remains as a backstop.

## 8. TL;DR

- OCC aligns to **`2.1.215`**; official latest is **`2.1.215`** (npm `latest`+`next`, GitHub CHANGELOG top, 2026-07-19). Gap = **0 versions**.
- No `2.1.216` or newer exists on the npm registry or in the official CHANGELOG as of 2026-07-20.
- OCC-11 already merged the `2.1.215` catch-up (release `2.1.276`) to `main` — `082ed83` + tag `v2.1.276` (`3b480cc`).
- **No feature port, no version bump, no new tag.** The only substantive work this wave is a real e2e (incl. REPL) regression gate + this gap report.
- Downstream: ops lane (X promotion) is the active content lane when there is no version to align to; security/acceptance re-confirm no drift.
