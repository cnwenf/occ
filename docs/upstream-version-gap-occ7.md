# OCC vs. official Claude Code — version-gap report (OCC-7, 2026-07-16)

> Gap-research deliverable for **OCC-7** ("OCC版本追齐官方Claude Code"). Supersedes
> the OCC-5 report in `docs/upstream-version-gap.md`, which found a 2.1.210→2.1.211 gap
> that has since been **closed**. Methodology: `upstream-tracking` +
> `aligning-with-official-binary` skills. Version truth from the npm registry
> (`@anthropic-ai/claude-code`); feature truth binary-verified + source-verified.

## TL;DR — conclusion

**There is no version gap.** OCC is caught up to the official latest Claude Code
**`2.1.211`**, which is itself the newest published version. No new version needs
aligning this round.

| Item | Value | Source |
|------|-------|--------|
| Official latest Claude Code | **`2.1.211`** | `npm view @anthropic-ai/claude-code version` → `2.1.211`; `dist-tags`: `latest`/`next` = `2.1.211`, `stable` = `2.1.204` |
| Official newest publish time | 2026-07-15T19:24Z | `npm view … time --json` |
| OCC own release (latest) | `2.1.270` (2026-07-16) | `package.json`, `CHANGELOG.md` |
| OCC actual aligned Claude Code | **`2.1.211`** (parity) | `CHANGELOG.md` header "Currently caught up through Claude Code `2.1.211`"; source-verified below |
| Gap to close | **None** | — |

The `aligning-with-official-binary` skill's "currently 2.1.200" pointer is **stale**
(it predates the 2.1.269/2.1.270 catch-up waves) and should be bumped to `2.1.211`.

## 1. Version truth (re-verified this run)

```bash
npm view @anthropic-ai/claude-code version        # → 2.1.211
npm view @anthropic-ai/claude-code dist-tags      # → { stable:'2.1.204', next:'2.1.211', latest:'2.1.211' }
# timeline tail: 2.1.206→07-09, 2.1.207→07-10, 2.1.208→07-13,
#                2.1.209→07-14, 2.1.210→07-14, 2.1.211→07-15  (nothing newer)
```

No `2.1.212`+ exists. `2.1.211` is the authoritative newest official version as of
2026-07-16.

## 2. What changed since the OCC-5 report

The OCC-5 report (`docs/upstream-version-gap.md`, also 2026-07-16, earlier in the day)
found OCC at `2.1.210` with a one-version gap to `2.1.211`, and listed a §3.2 work-list.
Two OCC releases have since landed:

- **OCC `2.1.269`** (2026-07-15) — "Catch up to Claude Code `2.1.210`": 25 upstream-feature
  clusters ported from official 2.1.206→2.1.210 (screen-reader mode, mouse-click
  multi-select, `vimInsertModeRemaps`, markdown table >200-row cap, Bedrock content-type
  guard, apiKeyHelper 401 retry, auto-mode classifier→Sonnet 5, memory over-limit guard,
  MCP stdio stderr 64MB cap, plan-mode edited-by-user guard, pipe-mode output fixes, …).
  Per-cluster recon in `.occ-research/occ-vs-2.1.210-gaps.md`.
- **OCC `2.1.270`** (2026-07-16, today) — ports the CC `2.1.211` behavior change:
  `hookAskFloor` — auto mode no longer overrides a PreToolUse hook's `ask` decision for
  unsandboxed Bash (floored at "prompt the user"; denied in headless). Also fixes the
  npm-global-install launcher (libc filtering + probe-run, OCC-6).

## 3. Source verification that the 2.1.211 wave is actually ported

The CHANGELOG header claims parity with 2.1.211. Verified against `src/` (not just the
changelog prose):

| 2.1.211 item | Source evidence | Verdict |
|---|---|---|
| **Headline: `--forward-subagent-text` flag + `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` env** (the OCC-5 "binary-verified absent" gap) | `src/main.tsx` (option def + env resolution + guard call), `src/utils/forwardSubagentTextGuard.ts` (pure guard + exact error `'Error: --forward-subagent-text requires --print and --output-format=stream-json.'`) | ✅ ported |
| `hookAskFloor` (auto-mode vs PreToolUse `ask`) | `src/QueryEngine.ts`, `src/hooks/useCanUseTool.tsx`, `src/services/tools/toolHooks.ts`, `src/utils/permissions/permissions.ts` | ✅ ported |
| Memory over-limit frontmatter/HTML-comment strip refinement | `src/memdir/memoryScan.ts`, `src/memdir/memoryTypes.ts`, `src/memdir/__tests__/memoryWriteGuard.test.ts` | ✅ present |
| Integer env-var sci-notation generalization | `src/utils/envValidation.ts`, `src/utils/__tests__/parseEnvInt.test.ts` | ✅ present |
| Vim insert-mode remaps (2.1.210) + s/S substitute | `src/hooks/useVimInput.ts`, `src/utils/vimInsertModeRemaps.test.ts` | ✅ present |
| Always-allow repo-root persistence | `src/Tool.ts`, `src/QueryEngine.ts`, `src/tools/AgentTool/runAgent.ts` | ✅ present |
| Subagent model-override revert | `src/tools/shared/spawnMultiAgent.ts`, `src/hooks/useMainLoopModel.ts` | ✅ present |
| Permission-preview neutralization (subagent output sanitizer) | `src/tools/AgentTool/subagentOutputSanitizer.ts`, `…/__tests__/subagentOutputSanitizer.test.ts` | ✅ present |

Doc-drift flagged in OCC-5 (README/CLAUDE.md badges stuck at `2.1.204`) is **resolved**:
`README.md` badge + `CLAUDE.md` "tracks" line now read `2.1.211`; `README.zh-CN.md` reads
`当前跟踪 2.1.211`.

> A full per-item **behavioral** audit (real e2e incl. REPL, not source-grep) is the
> acceptance track's job, not this gap-research step. This report only establishes
> version parity and that the claimed ports exist in source — the done-gate
> (`behavior-driven-done`) still applies before any "shipped" assertion.

## 4. Implication for downstream 分工 (for OCC Leader)

Because **no new version needs aligning**, the round's shape changes:

| Track | Status this round | Note |
|---|---|---|
| Alignment implementation | **N/A** — already at parity (2.1.269 + 2.1.270) | No code to port |
| Real e2e (incl. REPL) for new alignment | **N/A** | Nothing new to test-drive |
| Auto-merge to `main` for new alignment | **N/A** | gh logged in, but no alignment PR to merge this round |
| Security review (backdoor audit) | **Still applies** | Independent of version gap; audit current `main` |
| Acceptance (parity + merge-to-main + residual-branch cleanup) | **Still applies** | Verify 2.1.211 parity holds behaviorally; confirm `main` is clean |
| Operations | **Path #1 (no new version)** — promote the GitHub project; do **not** take the "新版本对齐 X-highlight" path (#2) | Per issue desc §运营: "如果没有需要对齐的版本，则找个运营的内容，推广GitHub项目" |

## 5. Recommended follow-ups (low-priority, not blocking)

1. **Bump the `aligning-with-official-binary` skill's version pointer** from `2.1.200`
   → `2.1.211` (stale; misleading for future runs).
2. **Archive/annotate the OCC-5 `docs/upstream-version-gap.md`** as resolved, or fold it
   into this file, so future runs don't re-derive a closed gap.
3. Optional: run a one-shot `npm view @anthropic-ai/claude-code version` watch loop so
   the *next* official release (2.1.212+) is caught promptly — then OCC-7's
   implement→e2e→merge path re-activates.

## 6. Reproduction

```bash
# version truth
npm view @anthropic-ai/claude-code version          # → 2.1.211
npm view @anthropic-ai/claude-code dist-tags        # latest/next=2.1.211, stable=2.1.204
npm view @anthropic-ai/claude-code time --json      # 2.1.211 → 2026-07-15T19:24Z (newest)

# OCC parity claim
sed -n '1,25p' CHANGELOG.md                         # "Currently caught up through Claude Code 2.1.211"

# headline 2.1.211 feature is in source (was absent per OCC-5 report)
grep -rn "forward-subagent-text\|FORWARD_SUBAGENT" src/   # hits in main.tsx + forwardSubagentTextGuard.ts

# doc-drift fixed
grep -n "2.1.21" README.md CLAUDE.md README.zh-CN.md      # all read 2.1.211
```
