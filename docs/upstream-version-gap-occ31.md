# OCC vs. official Claude Code — version-gap report (2026-07-24, OCC-31)

> Gap-research deliverable for **OCC-31** ("OCC版本追齐官方Claude Code — 2026-07-24
> gap调研/对齐"), step 1: confirm OCC's aligned official version, the official
> latest, and the changelog/code-diff gap between them. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital).
> Version truth from the npm registry (`@anthropic-ai/claude-code`) and the official
> Anthropic `CHANGELOG.md` on GitHub; feature truth cross-checked against OCC `src/`.

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest on `main`) | `2.1.284` (`2026-07-24`) | `package.json`, `CHANGELOG.md` §2.1.284 |
| OCC **actual** aligned Claude Code | **`2.1.218`** (fully aligned) | `CLAUDE.md` header; `CHANGELOG.md` §2.1.278 "catch up to Claude Code `2.1.218`"; OCC-28 no-gap confirmation (PR #239) |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.218`** (published `2026-07-22T19:55:32Z`) | `npm view @anthropic-ai/claude-code version`; `npm view … time --json` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.218` | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` |
| Version gap | **NONE** — OCC is at official latest `2.1.218` | all three sources agree |
| Internal doc-drift gap (found + fixed this run) | `CHANGELOG.md` header narrative still described the 2.1.216→2.1.218 catch-up as "in progress / P0 landed" | fixed in this PR to state 2.1.218 is fully caught up |

**Conclusion: no version gap.** OCC is caught up to official latest `2.1.218`
(published 2026-07-22; two days stale on the official side — no newer official
release exists). The path is therefore **self-acceptance** (per the issue's
"版本追齐后的自验收" branch), not alignment: run OCC's REPL against real tasks
and verify behavior/output/params/error-handling match `uvx claude-code` (2.1.218).

The only real finding this run is an **internal doc-drift** (not a feature gap):
the `CHANGELOG.md` header narrative was stale — it said "Last fully caught up
through `2.1.215`; `2.1.216`→`2.1.217` in progress (Stages 5–6 pending);
`2.1.218` started (P0 landed)" — contradicting the completed state (PR #228
"catch up to Claude Code `2.1.218`", PR #229 updated `CLAUDE.md`, PR #239 OCC-28
no-gap confirmation). Fixed in this PR; no code/feature change.

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.218` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.218`, `next=2.1.218`, `stable=2.1.206` | `npm view … dist-tags --json` |
| npm native binary `linux-x64` | `2.1.218` | `npm view @anthropic-ai/claude-code-linux-x64 version` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.218` | `curl …/anthropics/claude-code/main/CHANGELOG.md` |
| OCC aligned version | `2.1.218` (full) | `CLAUDE.md` header; `CHANGELOG.md` §2.1.278; `docs/upstream-version-gap-occ19.md`; OCC-28 PR #239 |

Official version timeline (tail):

```
2.1.218 → 2026-07-22T19:55:32Z   ← official latest (OCC fully aligned here)
2.1.217 → 2026-07-21T19:55:38Z   ← OCC-15 + OCC-19 ported
2.1.216 → 2026-07-20T20:19:37Z   ← OCC-15 + OCC-19 ported
2.1.215 → 2026-07-19T00:53:37Z   ← OCC fully aligned (OCC-13 no-gap)
2.1.214 → 2026-07-18T00:13:41Z
…
```

No official release after `2.1.218` as of this run (2026-07-24). The official
side has been quiet for two days; there is nothing newer to align to.

## 2. Methodology (skills used)

- `upstream-tracking` — per-version workflow: research → implement → e2e → accept
  → security → commit. Version-selection rules: skip unpublished / no-op /
  VSCode-only. Here the selection rule short-circuits: there is **no version
  newer than the aligned one**, so the alignment branch is empty and the
  self-acceptance branch fires.
- `aligning-with-official-binary` — do not trust doc claims; verify against the
  official binary. With `2.1.218` already on `main` and the official binary at
  `2.1.218`, the binary-diff surface is zero (same version). Verification this
  run was therefore: (a) confirm npm/GitHub agree official latest = 2.1.218,
  (b) confirm OCC `CLAUDE.md`/`CHANGELOG.md`/merged-PR ledger agree OCC = 2.1.218,
  (c) source-grep OCC for a sample of 2.1.216/217/218 headline identifiers to
  confirm they are actually present (not just claimed).

### 2.1 Source cross-checks (2.1.216/217/218 headline identifiers in OCC `src/`)

| Upstream version | Headline identifier | OCC `src/` hit? | File |
|---|---|---|---|
| 2.1.218 | `/code-review` background subagent | ✅ | `src/cli/handlers/ultrareview.ts`, `src/tools/AgentTool/AgentTool.tsx`, `src/skills/__tests__/codeReviewBackground.test.ts` |
| 2.1.218 | `--ax-screen-reader` mode | ✅ | `src/main.tsx`, `src/utils/srA11y.ts`, `src/utils/screenReader.ts` |
| 2.1.218 | `/ultrareview` | ✅ | `src/commands.ts`, `src/cli/handlers/ultrareview.ts` |
| 2.1.217 | emoji shortcode autocomplete (`emojiCompletionEnabled`) | ✅ | `src/utils/settings/types.ts` |
| 2.1.216 | (subset ported via OCC-15/19 — see `docs/upstream-version-gap-occ19.md` ledger) | ✅ | PRs #199–#228 merged |

These hits confirm the 2.1.216/217/218 features are present in OCC source, not
just advertised in docs. (Per the `aligning-with-official-binary` skill,
source-grep proves the string *exists*, not that the feature *works* —
behavioral e2e is the self-acceptance gate in §3.)

### 2.2 Merged-PR ledger (OCC-19 wave that closed the gap)

OCC-19's 2026-07-23 gap report (this file's sibling, `upstream-version-gap-occ19.md`)
said "real gap exists — 2.1.218 unported, 2.1.216/217 Stages 5–6 pending."
The gap was then closed by PRs #199–#228, culminating in:

- PR #228 — `chore(release): 2.1.278 — catch up to Claude Code 2.1.218` (2026-07-23)
- PR #229 — `docs(occ21): Gap-1 — track Claude Code 2.1.218 in README/CLAUDE` (2026-07-24)
- PR #239 — `docs(occ28): no-gap confirmation — OCC at official Claude Code 2.1.218` (2026-07-24)
- PR #240 — `fix(occ28): auto-mode subcommand parity with Claude Code 2.1.218` (2026-07-24) — self-acceptance finding

So OCC-28 already produced a no-gap confirmation and ran the first self-acceptance
pass (auto-mode subcommand byte-parity with the 2.1.218 binary). OCC-31 re-confirms
both conclusions as of 2026-07-24.

## 3. Self-acceptance plan (no-gap branch)

Per the issue's "版本追齐后的自验收" section and the `repl-tmux-e2e-testing` skill:
use OCC's REPL to run real tasks (like a human user), verify recently-added
features then core trunk, and check consistency with `uvx claude-code` (2.1.218)
on behavior / output / params / error-handling. Any inconsistency is recorded
as a gap and fixed.

### 3.1 In-sandbox-feasible this run

- ✅ **Version/help parity (non-LLM).** `occ --version` = `2.1.284`;
  `occ --help` / `mcp --help` / `daemon --help` show `occ` command name with
  zero `claude` residue (OCC-29, PR #241). `auto-mode` / `auto-mode defaults` /
  `config` / `reset` / `critique --help` and `defaults` output are
  byte-identical to the 2.1.218 binary (OCC-28, PR #240).
- ⚠️ **Live TUI/REPL + LLM e2e deferred to non-sandbox** — per the OCC-11
  sandbox-stall constraint (documented in `CLAUDE.md` and `upstream-version-gap-occ11.md`):
  interactive PTY/TUI e2e and node-pty `resume` e2e stall under the sandbox.
  `uvx` is also not installed in this sandbox, so a direct `uvx claude-code`
  comparison run is not available here. This slice is handed to the 验收员
  (acceptor) the leader dispatches next, to run in a non-sandbox environment.

### 3.2 Self-acceptance checklist for the non-sandbox pass (recently-added → core trunk)

Priority order (recently-added first, then core), each compared against
`uvx claude-code` (2.1.218):

1. **`/code-review` as background subagent** (2.1.218 #1) — review work no longer
   fills the conversation; stacked slash commands remain the review target.
2. **`--ax-screen-reader` deleted-text announcements** (2.1.218 #2) —
   `Option+Delete` / `Ctrl+W` / `Cmd+Backspace` / `Ctrl+U` / `Ctrl+K`.
3. **`/ultrareview` argument handling** (2.1.218 #8/#26) — descriptive args
   ("review my auth changes") apply the text as a note to a branch review;
   invalid args get corrective feedback instead of a retry loop.
4. **auto-mode classifier** (2.1.218) — dangerous-`rm`, background-`&`,
   suspicious-Windows-path no longer open permission dialogs; static-analyzer
   can't-prove-read-only Bash in plan+auto judged by classifier, not prompted.
5. **`context: fork` skills run in background by default** (2.1.218) —
   `background: false` opt-out; frontmatter booleans accept `yes/no/on/off/1/0`.
6. **`/deep-research` manual-only** (2.1.218) — Claude no longer auto-launches it.
7. **Emoji shortcode autocomplete** (2.1.217 #1) — `:heart:` → ❤️; disable via
   `emojiCompletionEnabled`.
8. **Transcript-write failure warning** (2.1.217 #2) — disk-full etc. surfaced.
9. **Core trunk:** REPL prompt + `2+2 → ● 4`, `/help`, `/exit`, `/clear` cost
   reset, `/context` post-compact usage, `/resume`, error handling on bad
   args, `occ -p` pipe-mode output contract vs `uvx claude-code -p`.
10. **CLI flag parity** (OCC-21/24) — `--help` byte-identical for leaf
    subcommands; divergences (`--bg`/`--plugin-url`/`--exclude-dynamic-system-prompt-sections`/`--prompt-suggestions`) are by-design and documented in `CLAUDE.md`.

Items 1–10 are the acceptance scope; any divergence found is recorded as a gap
and fixed via the standard TDD + e2e + security-reviewer flow.

## 4. The one finding this run — internal doc-drift (fixed)

`CHANGELOG.md` header narrative (lines 8–24 pre-edit) was stale:

- Said: "Last fully caught up through `2.1.215`; `2.1.216`→`2.1.217` catch-up
  (OCC-15) in progress (Stages 5–6 pending); `2.1.218` catch-up (OCC-19) has
  started (P0 slice landed)."
- Reality: 2.1.216/217/218 are all fully ported (PRs #199–#228; release
  `2.1.278`), confirmed by `CLAUDE.md` and OCC-28 PR #239.

**Fix:** rewrote the header narrative to state 2.1.218 is fully caught up,
marked the OCC-15/OCC-19 catch-ups complete, and added a pointer to this
(OCC-31) doc. No code or feature change; doc-only.

This is the kind of drift the `aligning-with-official-binary` skill warns about
("source-grep e2e is not the done-gate" — and neither is a stale doc claim);
the fix keeps the docs honest for the next run.

## 5. Reproduction

```bash
# version truth
npm view @anthropic-ai/claude-code version            # → 2.1.218
npm view @anthropic-ai/claude-code dist-tags --json  # latest=next=2.1.218
npm view @anthropic-ai/claude-code time --json        # 2.1.218 → 2026-07-22

# official changelog top entry
curl -sL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | head -5

# OCC aligned version
grep -n "2.1.218" CLAUDE.md                              # header claim
git log --oneline | grep -i "2.1.218\|catch up"        # PR #228 release 2.1.278
gh pr list --repo cnwenf/occ --state merged --limit 45 # PRs #199–#241 ledger

# OCC source has 2.1.218 headline identifiers
grep -rln "ultrareview\|ax-screen-reader\|codeReviewBackground\|emojiCompletion" src/
```

## 6. Next step (for the leader)

No gap → self-acceptance branch. In-sandbox help/flag/auto-mode parity is green
(OCC-28/29). The live TUI/REPL + `uvx claude-code` comparison is deferred to a
non-sandbox environment per OCC-11 — hand to the 验收员 the leader dispatches,
using the §3.2 checklist. The 验收员 should run OCC REPL and `uvx claude-code`
side-by-side on real tasks (items 1–10) and report any divergence as a gap for
the 程序员 to fix.
