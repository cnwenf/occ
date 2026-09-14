# Upstream Version Gap Ledger — OCC-86 (self-acceptance round)

**Issue**: OCC-86 (Multica id `1b05720b-70b2-47f6-8e3f-4489d8d3c2d9`)
**Date**: 2026-09-15 (Asia/Shanghai)
**Round type**: No upstream gap → strict self-acceptance of the currently aligned version
**OCC version at round start**: `2.1.334` (branch `agent/occ-leader/169f1057`, HEAD == `origin/main` @ `01e089e`)
**Official Claude Code at round start**: `2.1.270`

---

## 1. Gap research — result: no gap

Three-way verification of the official latest version, all consistent:

| Source | Value |
|---|---|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = `2.1.270` |
| GitHub releases (anthropics/claude-code) | newest = `v2.1.270` |
| Official `CHANGELOG.md` head | `2.1.270` |

npm `time.modified` for the package was 2026-09-12 — no official release published since the
previous round (OCC-85) completed alignment to `2.1.270`.

OCC-side alignment markers all read `2.1.270`:

- `README.md:8` badge — `Tracks-Claude Code 2.1.270`
- `CHANGELOG.md` header — "Last fully caught up through Claude Code `2.1.270`"
- `package.json` version — `2.1.334` (OCC's own release counter)

`git diff v2.1.334..origin/main` is **docs-only** (README.md, README.zh-CN.md,
docs/upstream-version-gap-occ124.md, docs/upstream-version-gap-occ85.md; 4 files, +135/−7).
No source drift since the last release.

Per the issue rule ("版本追齐后的自验收"), with no gap this round is a strict self-acceptance
round: exercise OCC like a human user, prioritizing recently landed features (OCC-84 /
v2.1.333) and then core trunk, checking value consistency against the official
`@anthropic-ai/claude-code@2.1.270` binary (REPL behavior, output, parameters, error handling).
Any inconsistency is recorded as a gap.

The "another version-chasing issue is running" early-exit clause was checked and does **not**
apply — no other in-flight version issue exists.

### Official A/B methodology note

`uvx claude-code` is unusable as a distribution route: PyPI's `claude-code` package either
lacks the pinned version (`2.1.270` not published there) or, unpinned, provides no executable
("Package `claude-code` does not provide any executables"). The official binary for A/B was
therefore installed via npm (`@anthropic-ai/claude-code@2.1.270` → `node_modules/.bin/claude`)
into an isolated fixture prefix. This is the same package Anthropic ships; only the installer
differs.

## 2. Build baseline

- Built `dist/cli.js` from HEAD: **30,456,583 bytes** — byte-size identical to the OCC-85
  round artifact, independently corroborating zero source drift since that round.
- Build completed clean with no new warnings.

## 3. Test sweep (sanitized-env `bun test`, subagent-executed)

Run under `env -i PATH=… HOME=/root TERM=xterm-256color` (host-env pollution guard).

**Totals: 1434 pass / 1 skip / 1 fail + 1 error — zero NEW failures.**

| Group | Scope | Result |
|---|---|---|
| A | OCC-84 feature test files (E14, E23, E25, E27, E35, E42, E44, E51, E52) — 8 files | 123 pass, all green |
| B | Feature dirs (permissions, skill, prompt-suggestion, zipCache/dxt, parse-keypress, banner, LSP, alt-screen) | 447 pass, green |
| C | Core trunk (filesystem, commands, tools, services, utils) | 809 pass; only the known pre-existing baseline error in `lineage.compact.test.ts` ("Export named 'extractForkLineage' not found") — unrelated, present before this round |
| D | e2e alignment suites (version-2.1.219*, occ-versioning, commands-alignment) | 55 pass, green |

Logs: `/tmp/occ_[A-D]*.log`.

## 4. Live REPL e2e (tmux, built artifact, real gateway)

Harness per the repl-tmux-e2e-testing skill (Architecture A): detached tmux 200×50 driving
**built** `dist/cli.js`, poll-until-text (200 ms), no blind sleeps, sessions killed on exit.
Fixtures isolated outside the Multica workspace (`/root/occ86-e2e/`): fresh git repo with CJK
filenames (`测试文件甲.txt`, `测试文件乙.md`), fresh `HOME`, project skill
`.claude/skills/deploy-checker/`. Gateway env: `ANTHROPIC_BASE_URL` (DashScope Anthropic
endpoint), `ANTHROPIC_AUTH_TOKEN` (redacted), `ANTHROPIC_MODEL=qwen3.8-max`;
`ANTHROPIC_API_KEY` **unset** (custom-key dialog hazard); default permission mode.

17 live checks, **all PASS**:

### Session 1 — first launch (fresh HOME, onboarding chain)
1. Onboarding chain renders in official order: theme selection → security notes → folder
   trust dialog, official copy throughout.
2. Trust dialog fail-safe: default "No, exit" → clean exit code **1**, no trust persisted
   (correct conservative behavior).
3. Trust "Yes, I trust this folder" → `hasTrustDialogAccepted` persisted in
   `.claude.json`; subsequent launches skip straight to the prompt.
4. CJK prompt → model calls `Bash(echo 你好OCC86)`; read-only command auto-allowed with
   **zero prompts** (matches official 2.1.270 read-only auto-allow contract); correct Chinese
   reply rendered.
5. `Write(note86.txt)` → permission dialog with official 3-option copy ("Do you want to create
   note86.txt?" / 1. Yes / 2. Yes, allow all edits during this session (shift+tab) / 3. No /
   "Esc to cancel · Tab to amend") + diff preview → approve → "Wrote 1 lines" → content
   verified on disk (`OCC86-OK`).
6. `Read` of CJK filename → correct absolute path echoed, accurate empty-file report.
7. `@`-mention completion on CJK prefix → both `测试文件*` candidates listed; Tab completes
   the common prefix.
8. `/status` → slash-command completion with descriptions; panel shows Version `2.1.334`,
   session ID, cwd, auth token source, base URL, model `qwen3.8-max`, settings sources.
9. `/exit` → exit code **0**, clean teardown.

### Session 2 — returning user
10. Boots directly to prompt (trust persisted; no dialogs).
11. `Shift+Tab` mode cycling full loop: manual → "⏵⏵ accept edits on" → "⏸ plan mode on"
    → "⏵⏵ auto mode on" → "⏸ manual mode on" — 4 states, official labels/icons, loop closes.
12. Literal text echo into the input box; `Ctrl+U` clears with official kill-ring hint
    ("Ctrl+Y to paste deleted text").
13. `/exit` clean; tmux server fully gone afterwards (no leaked sessions).

### Headless (`-p` mode)
14. `-p` PONG round-trip through the gateway → correct output, exit **0**.
15. E52 probe: `/skill deploy-check` (bare, nonexistent) → exact official message
    `Unknown skill: deploy-check` (bare form — correct: suggestion candidates are
    colon-namespaced plugin skills only; bare project skills get the bare message, per the
    byte-verified port in `src/tools/SkillTool/SkillTool.ts`). Model independently discovered
    the project skill `deploy-checker` in `-p` mode → project skill discovery works.

### Official A/B side-by-side (same gateway, same prompt, same fixtures)
16. `--version`: official prints `2.1.270 (Claude Code)`; OCC prints `OCC 2.1.334` —
    documented branding divergence only.
17. Unrecognized-model signal parity: both emit the
    `[claude-code:unrecognized_model] {"model":…,"query_source":…}` tag on stderr with
    identical shape, then answer PONG and exit 0. `query_source` differs (`sdk` on OCC vs
    `generate_session_title` on official) — same subsystem, different firing call site in the
    traced execution; recorded as an observation, **not** a gap.

**Result: zero new gaps found in the live REPL / headless acceptance.**

## 5. Known divergences re-confirmed as documented (not new gaps)

- **Unknown-model-window advisory paragraph**: official 2.1.270 appends an extra advisory
  paragraph to the unrecognized-model notice. This is the documented staged divergence family
  (`docs/upstream-version-gap-occ46.md:180`, `docs/upstream-version-gap-occ114.md` §3
  分级保留): OCC's `getContextWindowForModel` lacks the host structure the advisory renders
  from, and the aligning-with-official-binary skill's "不猜" rule forbids speculative ports.
  This round captured the **first live side-by-side evidence** of the divergence for the
  ledger; no code change made.
- `[claude-code:unrecognized_model]` tag itself is intentional 2.1.233 alignment (OCC-95,
  `src/utils/model/unrecognizedModelSignal.ts`).

## 6. Security review (subagent) — verdict: CLEAN

Scope: `v2.1.332..v2.1.333 -- src/` (the OCC-84 code round: 21 files, +2596/−137, every
non-test file read in full) + confirmation that `v2.1.334..origin/main` is docs-only.

Backdoor sweep across all added lines: **zero** added network calls (`fetch`/`http(s)`/
WebSocket/net), `child_process`/spawn/exec, obfuscation (`eval`, dynamic `Function`, base64
blobs), credential reads, or out-of-path file writes. The single new telemetry event
(`tengu_skill_tool_suffix_match`) is number-only metadata per `LogEventMetadata` typing,
matching official E52; no user content or paths transmitted.

Security-regression analysis highlights:

- **E14 `!`-negation permission scoping is fail-CLOSED — it is a fix**: per-source `ignore()`
  matchers mean a `!` rule in source B can no longer negate a deny from source A (the
  pre-E14 merged matcher was the fail-open exposure). Bare `!` deny/ask rules are dropped with
  a warning, not honored. Allow-lookup miss returns `null` (not allowed).
- **zipCache (E42)**: all entries path-traversal/absolute-path/zip-bomb validated *before*
  extraction; chmod masked to `0o755` with `O_NOFOLLOW` + `nlink===1` re-open guard — no
  traversal path, no setuid survival, no swapped-link chmod.
- **Banner sanitize (E35)**: fixed-point ANSI strip + control-char→space pass guarantees no
  `\x1b` survives to the terminal; byte-matches official pipeline.
- **parse-keypress partial flush (E44)**: lone `ESC`/`ESC[` still flushes as Escape; IN_PASTE
  excluded — no keystroke loss.

Findings: 4 total, all **LOW/INFO** and either official-parity or documented in-code
deviations — (1) LOW: `SkillTool.ts` interpolates the caller-supplied skill `name` raw into
`Unknown skill: ${name}` while *suggested* names pass `isSkillNameSafeToDisplay`; identical to
official 2.1.269 behavior and to pre-change OCC, so not a regression — optional follow-up
hardening: gate `name` through the same check. (2) LOW: zipCache in-place fallback on
EBUSY/EPERM/ENOTEMPTY/EEXIST doesn't clear stale files (documented deviation; entries still
path-validated). (3) INFO: mode sweep hardens files only, not dirs (matches official `swo`).
(4) INFO: never-completing partial buffer retained without reset (no input loss; official
side-channels are debug-only).

**Recommendation: accept.** Finding 1 recorded as optional hardening follow-up (not blocking,
official-parity).

## 7. Acceptance checks (issue §验收员)

| Check | Result |
|---|---|
| True alignment with official Claude Code (human-like usage) | PASS — §4: 17/17 live checks; §5 divergences all pre-documented |
| All work merged to main | PASS — HEAD == `origin/main` @ `01e089e`; this ledger is the only pending addition (docs-only) |
| GitHub residual branches cleaned | PASS — remote branches = `main` only |
| `/releases` == `/tags` | PASS — 134 == 134, `comm -23` empty |
| Notify programmer to release | **N/A — no release this round** (see §8) |

## 8. Release decision: none

This round lands **docs-only** (this ledger). Per the OCC-85 R2.7 precedent (OCC-40):
no-op releases pollute `/releases` and npm with version bumps that carry zero artifact
change. No tag cut, no `publish.yml` run, `/releases` == `/tags` invariant preserved at 134.

## 9. Cleanup

- tmux sessions `occ86*` killed (server confirmed gone).
- `/root/occ86-e2e/` fixtures (repo, OCC home, official home, npm prefix) removed after the
  round — outside the Multica workspace, contained the redacted gateway token in env only,
  nothing persisted to the repo.

## 10. Conclusion

Official `2.1.270` == OCC aligned `2.1.270`: **no gap**. Self-acceptance round completed:
build baseline stable, 1434-test sweep green with zero new failures, 17/17 live REPL/headless
checks pass against the real gateway and the official binary A/B, security review CLEAN
(no backdoors; E14/E42/E35/E44 are net hardening), zero new gaps recorded. The only deltas
vs official are pre-documented staged divergences (§5). Round closed docs-only; no release.
