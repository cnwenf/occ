# Upstream Version Gap — OCC-162 Round (2026-10-19): strict self-acceptance vs official 2.1.302

> Status: **IN PROGRESS** — no official version gap (2.1.302 aligned in v2.1.388/389). Per the issue's "版本追齐后的自验收" clause: strict self-acceptance A/B round, prioritizing the newest ported surface (2.1.302 PORT ×12 + acceptance-fix ×12).
> Prior-round ledgers: [occ120-2026-10](./upstream-version-gap-occ120-2026-10.md) (2.1.302 PORT round + acceptance-fix round), [occ160-2026-10](./upstream-version-gap-occ160-2026-10.md), [occ157-2026-10](./upstream-version-gap-occ157-2026-10.md), [occ156-2026-10](./upstream-version-gap-occ156-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official binary: forensics only (`strings` / `grep -aboF` / bounded `dd`); uvx official may be run for interaction evidence per issue's uvx-consistency clause — no sensitive data fed.

## 1. Baseline (verified 2026-10-19, this run)

| Item | Value |
|---|---|
| OCC main HEAD | `010116ee` == tag `v2.1.389` (worktree clean at checkout) |
| Build | green — `dist/cli.js` 30.29 MB, MACRO.VERSION=2.1.389 injected |
| Official npm dist-tags (this run) | `latest = next = 2.1.302`, `stable = 2.1.292` |
| STAGED re-review trigger (`stable ≥ 2.1.296`) | **NOT fired** — STAGED set carries as-is |
| Work branch | `agent/occ/17882c36` |

## 2. Self-acceptance ① — 2.1.302 PORT ×12 surface

### 2.1 Unit-pin re-verification (all green, both orders)

23 test files covering PORT ×12 + acceptance-fix pins (`*302*.test.ts`): **174 pass / 0 fail / 413 expect** combined under `CI=true` (forward order 1472ms, reverse order 1427ms). Leak-pair discipline: `imageReadCap302`+`allowLarge296` culprit pair **65/65 both orders**.

### 2.2 Official ground-truth re-verification (byte forensics, this run)

Official `@anthropic-ai/claude-code-linux-x64@2.1.302` re-downloaded: tarball 129,008,778 B; ELF 285,793,528 B; **md5 `39885c1377a0f0d922b73bf8653a6c3f` — exact match to occ120 §1**. Marker counts (grep -aboF): image-refusal ×2, pipe/device-refusal ×2, `Already available in this conversation` ×2, `no search is needed` ×2, `gitfile does not point to a valid repository` ×2, `forkSubagentDisabled` ×3 — all match occ120. dd spot-checks: **@245156620** `tool_decision` v302 attribute order verbatim (`{decision,source,tool_name,tool_use_id,...w0r(mcpInfo),...tool_parameters,...be,permission_mode}` — identifiers first, truncatable tail last); **@246248862** `ant=12;function` (hook cap); **@244374771** `HYe` auto-mode ladder verbatim (config `src:"gb"` w/ warn-once `env:shadowed` → env `a_e(...)` → `externalSonnet5Probe!=="demoted"` → default). Official strings: ToolSearch isMeta sentence + pipe-refusal full text match occ120 records verbatim. ELF deleted after forensics (resource-safety discipline); extracted comparison strings kept under `/tmp/cc162-verify/extracted/` until round end.

### 2.3 OCC landing-site cross-checks (vs byte-verified official shapes)

- `yoloClassifier.ts` ladder: warn-once key `env:shadowed` + official warning text **byte-identical** to dd @244374771 dump. ✓
- `promptAgentConcurrencyCap302.ts`: `HOOK_PROMPT_AGENT_CONCURRENCY_CAP = 12`, predicate `hook.type === 'prompt' || hook.type === 'agent'` — verbatim official `Iee`. ✓
- `permissionLogging.ts`: v302 field set/order incl. `tool_use_id`/`tool_source`/`tool_parameters` (+ occ160 `decisionReason`), pinned by `toolDecisionOtelFields302`. ✓

### 2.4 Live behavioral probes (production dist, real API gateway)

| # | Probe | Result |
|---|---|---|
| — | `occ --version` | `OCC 2.1.389`, EXIT=0 ✓ |
| — | `-p` PONG baseline | `PONG`, EXIT=0 ✓ (known gateway `unrecognized_model` stderr noise, pre-existing) |
| #31 | `-p` + `CLAUDE_CODE_FORK_SUBAGENT=1` / `=0` | `PONG`, EXIT=0 both — no startup crash (bug-2 regression clear in live dist) ✓ |
| #23 | `-p` inside stray-gitfile dir (`.git` file → invalid target) | `PONG`, EXIT=0 — graceful; git-2.56 stderr class unit-pinned (`worktreeGitfile302`); local git 2.43 can't emit the new text live (noted) |
| #35 | `-p` real Bash call w/ settings hooks (PreToolUse ×2 + PostToolUse ×1) | all 3 fired in order (`PREHOOK1/PREHOOK2/POSTHOOK`), tool output returned, EXIT=0 ✓; ≤12 cap itself pinned by mutation-verified `hookConcurrencyCapProduction302` (cap applies to prompt/agent-type hooks only — official `Iee`) |
| #06 | `-p` model Reads real 130MB PNG | refusal surfaced **verbatim through full production path**: `File is too large to read as an image (the limit is 128MB): /tmp/occ162-image-probe/big.png. If it is an image, resize it or export a smaller copy, then read that.` EXIT=0 ✓ |
| #16 | signed-out `occ remote-control --help` | **F-1 observation**: prints TOP-LEVEL Commander help, EXIT=0 — the #16 fix lives inside `feature("BRIDGE_MODE")` which is NOT allowlisted → structurally correct but production-dormant (same class as #29). No regression (pre-#16 behavior identical); OCC ships no `remote-control` subcommand by design. Recorded, no action. |

## 2A. NEW FINDING (this run) — official 2.1.302 footer mode-indicator surface drift (candidate GAP occ162-01)

Official 2.1.302 ELF contains **zero** occurrences (direct `grep -aboF` on the binary, not just strings-dump): `(shift+tab to cycle)`, `shift+tab to cycle`, `manual mode on`, `← for agents`, `to cycle)`. OCC renders all of these today (`PromptInputFooterLeftSide.tsx:130` chip suffix; `manualModeCycleHint108` pins; occ156 recorded official **2.1.296** live footers byte-identical WITH the suffix + `← for agents`). So the official footer surface changed somewhere in (2.1.296, 2.1.302] and no intermediate ledger (occ158/occ160/occ119-suppl/occ120) recorded it. Official 2.1.302 mode labels present: `auto mode on`, `plan mode on`, `accept edits on` (+ dialog label array `X=[{label:"default"...},{label:"accept edits on"...},{label:"plan mode on"...},{label:"auto mode on"...}]` with `confirm:cycleMode` demo component). Consequence for carryover: **occ156-01 (`← for agents` footer hint missing in OCC) premise may be void** — official itself no longer ships the hint. Live A/B (official ELF vs OCC dist, tmux S-Tab cycle, isolated HOMEs) in progress — verdict + severity in §5.

**Security note (uvx channel):** PyPI `claude-code` is a **0.0.1 placeholder/squatted package** (PyPI JSON: only release = 0.0.1) — NOT Anthropic's distribution (official channel = npm `@anthropic-ai/claude-code`). `uvx claude-code@2.1.302` → unresolvable; running unpinned `uvx claude-code` would execute an unofficial binary with gateway credentials in env — **declined**. Official-side interaction forensics this round run the md5-verified official npm ELF under an isolated clean HOME (no host `~/.claude*` exposure), per the Leader's uvx-clause override of never-execute (interaction evidence only, no sensitive data).

## 3. Self-acceptance ② — acceptance-fix ×12 findings re-verification

(TBD)

## 4. Self-acceptance ③ — core trunk spot-checks

(TBD)

## 5. Carryover dispositions

(TBD)

## 6. Full suite + e2e record

(TBD)

## 7. Merge / handoff record

(TBD)
