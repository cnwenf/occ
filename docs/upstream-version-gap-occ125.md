# Upstream Version Gap — OCC-125 (official 2.1.270, no-op round → strict self-acceptance)

- **Round:** OCC-125 (autopilot 版本追齐, 2026-09-15)
- **OCC aligned-at (round start):** official Claude Code `2.1.270` — OCC release `2.1.334` (tags == releases == 134)
- **Official latest (round check):** `2.1.270` — npm `@anthropic-ai/claude-code` dist-tag `latest` re-verified live this round: **PASS, unchanged**. No new official release since OCC-124 → per the issue's "无 gap → 严格自验收" branch this round is a **self-acceptance round against the official 2.1.270 binary**, not a catch-up.
- **Acceptance environment:** dashscope gateway (`ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`, model `qwen3.8-max`); OCC build `dist/cli.js` 30.46 MB, `occ --version` → `OCC 2.1.334`. Official reference binary: `@anthropic-ai/claude-code-linux-x64@2.1.270` (Bun-compiled ELF, text region >180 MB offset). Dual tmux REPL sessions (`occ` HOME=/tmp/home-occ vs `off` HOME=/tmp/home-official, both cwd /tmp/accept-repo) driven with poll-until-text capture.

**Verdict summary:** 2 LAND (Gap-125a `/output-style` full port — unblocks OCC-123 E2; Gap-125b markdown serializer `html`/default-token parity fix — discovered live during e2e), 2 staged-verdicts re-confirmed with new binary evidence (E3 `bashEditDiffEnabled`, E11 `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING`), 1 documented divergence retained (del tokenizer), core-trunk e2e all PASS.

---

## 1. Priority 2.1.269/2.1.270-surface acceptance

| Item | Result |
|---|---|
| `/output-style` | **GAP → FIXED (Gap-125a)** — command absent from OCC; ported byte-faithfully (§2) |
| Markdown `<style>` render | **GAP → FIXED (Gap-125b)** — html tokens dropped by OCC serializer; official renders verbatim (§3) |
| `claude plugin eval` | PASS — OCC `plugin` command surface removed by design (documented trim); unknown-subcommand path exits gracefully, no crash |
| `bashEditDiffEnabled` | **STAGED (re-confirmed, §4)** — OCC-123 E3 verdict stands; inert-smoke PASS (unknown settings key tolerated, `-p` round-trip green with the key set) |
| `/focus` tip | PASS — gating verified earlier this round (tip surfaces only on the official's Remote-Control-capable path; OCC renders the command surface without crash) |
| `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING` | **STAGED (re-confirmed, §4)** — OCC-123 E11 verdict stands; env var inert in OCC (analytics stub); `-p` round-trip green with `=1` |
| Read-only git no-permission (2.1.270 changelog fix) | PASS — verified live in both REPLs before AND after `/compact`: `git status`/`git log`/`git diff` auto-allowed, zero prompts; write-path (`git commit`) still prompts and honors deny |

## 2. Gap-125a — `/output-style` full port (OCC-123 E2 unblocked)

**Blocker lifted:** OCC-123 staged E2 because the arg-less list-match allowlists `nN` (LIST_ARGS) / `Jw` (HELP_ARGS) were bytecode-only in the v269 binary. In the **2.1.270** binary they are recoverable from text chunk `chunk-vfsq2z4g` (`Jw` @ offset 185269045): `Jw=["help","-h","--help"]`, `nN=["list","show","display","current","view","get","check","describe","print","version","about","status","?"]`. With those, the entire official module (offset 202167402, chunk-87knjp1g) is byte-recoverable.

**Landed:**
- `src/commands/output-style/index.ts` — official command def (`oLt` @195160405): `type:"local"`, `name:"output-style"`, `supportsNonInteractive:!0`, `description:"List output styles or switch to one"`, `argumentHint:"[style]"`. Official `isEnabled:()=>ke()||!E9()` / `isHidden` getter collapse to defaults in OCC (`E9()` = statsig `tengu_maple_sundial` → false; statsig trimmed). Dead official local-jsx variant (`wNr`, "moved to /config") not ported — never runs upstream.
- `src/commands/output-style/output-style.ts` — full `call` port with helper mapping documented in-file (`qD(Z(),storageV5)`→`getAllOutputStyles(getCwd())`, `Gse()`→settings `outputStyle`||`default`, `jJe`→`isBuiltinStyle`, `Oee`/`ao`→`isRelayedContext` (always false in OCC — no Remote-Control/Slack bridge; optional-field read kept for structural fidelity), `Sr`→`isSettingSourceEnabled('localSettings')`, `Kt`→`updateSettingsForSource`, `$k("output_style")`→no-op (OCC re-reads style per-turn via attachments.ts), `jht`→`telemetryStyleName` (`Object.hasOwn(OUTPUT_STYLE_CONFIG,·)?·:'custom'`), `_n`→identity (REPL input layer strips control chars — empirically verified)). Verbatim exports `CUSTOM_CURRENT_STYLE_PLACEHOLDER`, `SAVE_FAILURE_OFF_BOX`; verbatim `pEt`/`fEt` messages; `tengu_output_style_changed` telemetry with official metadata (`source:'slash_command'`, `settings_source:'localSettings'`).
- `src/commands.ts` — registered in `COMMANDS` (alphabetical slot between `model` and `remoteEnv`).
- `test/commands/output-style.test.ts` — 21 unit tests over the official output contract (listing + current marker, LIST/HELP allowlist fall-through incl. case-insensitivity, unknown-style exact message + raw-case echo + no side effects, case-insensitive set → canonical name, already-active short-circuit, telemetry metadata exactness, custom-style `'custom'` telemetry, localSettings-disabled `fEt`, save-error detailed message). All pass.

**Intentional divergence:** `Proactive` style absent (dormant `PROACTIVE` flag — OCC-100 ledger); official list shows it, OCC's list is `default/Concise/Explanatory/Learning` + any custom styles.

**Live REPL e2e (occ session, fresh build):** all branches byte-parity with the official capture —
- `/output-style` → `Output style: default` / `Available styles:` / `- default (current)` / descriptions / `Usage: /output-style <style>` (html `<style>` now renders — Gap-125b)
- `/output-style nope` → `Unknown output style "nope". Available styles: default, Concise, Explanatory, Learning`
- `/output-style concise` → `Output style set to Concise` + `.claude/settings.local.json` flips to `{"outputStyle": "Concise"}`
- `/output-style concise` (again) → `Output style is already Concise`
- `/output-style help` → listing with `Output style: Concise`, `- Concise (current): …`
- `/output-style default` → `Output style set to default`, settings reverted

## 3. Gap-125b — markdown serializer html/default-token parity (discovered during e2e)

Live diff: OCC rendered `Usage: /output-style` where official renders `Usage: /output-style <style>`. Root cause in `src/utils/markdown.ts` `formatToken`: OCC dropped `html` tokens (`case 'html': return ''`) and had `return ''` as the switch default. Official 2.1.270 serializer (`Fk` @197018715, switch end @197023577):

```js
case"escape":return e.text;case"html":return e.text;case"def":return""}return e.raw
```

**Fix (binary-verified):** `html` → `token.text` (raw HTML text rendered verbatim), switch default → `token.raw` (unhandled token types fall back to raw source instead of being silently dropped). `def` → `''` retained (matches official).

**Documented divergence retained:** the official tokenizer overrides (`j` @197017684) include a **strict** `~~`-regex `del` tokenizer plus a `table` override; OCC's `configureMarked()` disables `del` entirely (pre-existing, deliberate — model uses `~` for "approximate"). `del` tokens therefore never reach the serializer in OCC; the `case 'del': return ''` arm is kept as a defensive no-op with a comment. Not force-aligned this round (changing strikethrough handling is a behavior change beyond the observed gap).

**Blast radius:** `formatToken` is the shared markdown serializer — full `bun test` suite re-run as the regression gate (§6).

## 4. Staged verdicts re-confirmed with new binary evidence

- **E3 `bashEditDiffEnabled`** (new-in-v269 Bash file-edit diff): gate extracted verbatim from 2.1.270: `if(a.CLAUDE_CODE_BASH_EDIT_DIFF!==void 0)return a.CLAUDE_CODE_BASH_EDIT_DIFF; let n=NC("bashEditDiffEnabled")[0]; if(n===!1||Ge().bashEditDiffEnabled===!1)return!1; if(n===!0)return!0; return(e==="auto"||e==="bypassPermissions")&&cot()`. The feature body is a git-tree snapshot/diff subsystem (`J2s` git-command regex, snapshot Maps, `Gke`/`iOr` async snapshot+diff assembly, cap `rOr`, `bashEditDiff: snapshot failed:` telemetry) spread across bytecode helpers — per-site decompilation still required; **default-off in manual mode** (gate needs `auto`/`bypassPermissions` or explicit opt-in), so the acceptance path is unaffected. Inert-smoke PASS: OCC tolerates the unknown settings key (`{"bashEditDiffEnabled": true}` in project settings → boots, `-p` round-trip green). Remains STAGED per OCC-123 §E3.
- **E11 `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING`**: new evidence — `ls(){return a.CLAUDE_CODE_BG_TASKS_REPORT_RUNNING!==!1}` / `il(){return …===!0}`; the located `ls()` call site gates the `cli_idle_gate_report_idle` **analytics** emission (`Ti()` idle-gate reporter) — OCC's analytics are stubbed (empty implementations), and remote/headless "waiting for your input" reporting is official-cloud surface replaced by OCC's daemon supervisor. Env var inert-smoke PASS (`=1` → boots, round-trip green). Remains STAGED/NO-OP per OCC-123 §E11.

## 5. Core-trunk acceptance (all PASS, live this round)

| Surface | Method | Result |
|---|---|---|
| Startup | dual-REPL boot banner + auth-conflict advisory parity | PASS |
| Resume | `occ -p` seed (`ZEBRA-77`) → `occ -c -p` recall | PASS — exact codeword returned |
| Permission flow | write-path dialog + deny honored; read-only git auto-allow | PASS |
| Hooks | project `PreToolUse` matcher `Bash`: `touch` sentinel + `permissionDecision:"allow"` JSON → command ran with no prompt, sentinel file created | PASS |
| MCP | `occ mcp list` vs `claude mcp list` — `No MCP servers configured. Use \`<bin> mcp add\` …` (program-name delta only) | PASS |
| Skills | `.claude/skills/codeword/SKILL.md` discovery + invocation → exact `MAGIC-42` | PASS |
| Subagents | Task tool spawn (`general-purpose`) → `PONG-SUB` relayed | PASS |
| Background tasks | Bash `run_in_background` → `sleep 2 && echo BG-TASK-DONE` → output collected via task read | PASS — `BG-TASK-DONE` |
| Compact | read-only-git permission regression after `/compact` (the official 2.1.270 changelog fix) | PASS |
| Inert flags | `bashEditDiffEnabled` setting + `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING=1` | PASS (§4) |

## 6. Gates

- `bun run lint` — changed files clean (`biome lint` on the 5 touched files: 0 issues). Repo-wide informational lint noise (`suppressions/unused`) unchanged — CI runs lint `continue-on-error` per ci.yml.
- `bun run build` — green (`dist/cli.js` 30,460,853 B, `OCC 2.1.334`); built artifact is what the live REPL e2e ran against.
- **Full CI gate `CI=1 bash scripts/ci-test.sh`** (460 files, per-file process isolation — the exact gate GitHub Actions runs): **3937 pass / 2 fail / 114 skip**.
  - Fail #1 `version-2.1.144-commands-rename.e2e.test.ts` E17 — **stale test, fixed this round**: it asserted the 2.1.200-era contract "`/output-style` NOT registered"; official 2.1.269 re-added the command. Test rewritten to assert the official 2.1.270 definition (name/type/description/argumentHint/supportsNonInteractive). Post-fix: 8 pass / 0 fail.
  - Fail #2 `feedback-ai.e2e.test.ts` ("live agent files an issue via fake gh") — **pre-existing environmental failure**, not a regression: identical `5 pass / 1 fail` signature was clean-tree A/B-verified in OCC-108 §(干净树 A/B 复核) and recurs in the OCC-83/107/109/110/119 ledgers; the test is live-model synthesis (gateway `qwen3.8-max` title/body wording) and is skipped in CI without `ANTHROPIC_API_KEY`. This round's diff cannot reach it — `formatToken` is terminal-render only; `/feedback`'s prompt template goes to the model verbatim and the gh shim captures tool args, neither passing through the markdown serializer.
  - Effective post-fix result: **3938 pass / 1 known-environmental fail / 114 skip**.
- New unit tests: `test/commands/output-style.test.ts` 21/21 pass (included in the gate run).
- Live `-p` smoke + dual-REPL e2e — green (§1, §2, §5).

## 7. Release

Code changed this round (Gap-125a + Gap-125b) → release per issue-body flow is **gated on 验收员 acceptance**; no version bump cut in this commit.
