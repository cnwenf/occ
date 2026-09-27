# Upstream Version Gap — OCC-139 (strict self-acceptance round, official 2.1.283)

**Date:** 2026-09-28 · **OCC release at round start:** 2.1.356 (main HEAD `a96f75b`) · **Official tracked:** Claude Code 2.1.283 (npm dist-tags: latest 2.1.283 / stable 2.1.274)

Round type: version already caught up (OCC-138 + OCC-98 both merged) → per the issue's
"版本追齐后的自验收" rule this round is a **strict self-acceptance round**: drive OCC's REPL
like a human, A/B against the official 2.1.283 linux-x64 binary
(`official-cc/node_modules/.bin/claude`), record every inconsistency as a gap, and fix what
can be byte-verified.

---

## 1. Fixed this round

### Gap-139a — `--effort` CLI parser family (silent upstream change in 2.1.283)

The official binary replaced the strict 2.1.218-era Commander validation
(`InvalidArgumentError` → exit 1 with `It must be one of: …`) with a **lenient
warn-and-continue argParser**. No upstream CHANGELOG entry exists (silent change; Gap-58
precedent). Byte-verified from the linux-x64 ELF:

```js
var G={med:"medium"},J={ultracode:"xhigh"};
function NNe(e){…}            // keyword normalize (trim+lowercase+hasOwn)
function yct(e){…}            // keyword → level ('ultracode'→'xhigh')
function fhe(e){…}            // CLI level parse (trim+lowercase+alias)
function _5e(e){…}            // CLI flag parse → {level, warning}
function oL(e){…}             // env/session parse (int pass-through, NO trim, parseInt fallback)
function kzn(e){return oL(e)??yct(e)}   // session-init parse
function xzn(e){return Je().ultracode===!0||NNe(e)==="ultracode"}  // startup ultracode gate
function N$(){…}              // CLAUDE_CODE_EFFORT_LEVEL override (unset/auto → null)
```

Official registration:

```js
.addOption(new ls("--effort <level>",`Effort level for the current session (${wd.join(", ")})`)
  .argParser((S)=>{let{level:C,warning:G}=_5e(S);
    if(G!==void 0)process.stderr.write(`Warning: ${G}\n`);return C}))
```

**OCC port** (symbol map in the `src/utils/effort.ts` header comment):

| Official | OCC |
|---|---|
| `G` | `EFFORT_LEVEL_ALIASES` (`{med:'medium'}`, frozen) |
| `J` | `EFFORT_KEYWORD_LEVELS` (`{ultracode:'xhigh'}`, frozen) |
| `NNe` | `normalizeEffortKeyword` |
| `yct` | `parseEffortKeywordLevel` |
| `fhe` | `parseEffortCliLevel` |
| `_5e` | `parseEffortCliFlag` |
| `oL` | `parseEffortEnvValue` |
| `kzn` | `parseEffortSessionInit` |
| `xzn` | startup gate in `src/main.tsx` (`enableUltracodeForSession()`) |
| `N$` | `getEffortEnvOverride` (now alias-aware: `CLAUDE_CODE_EFFORT_LEVEL=med` → `'medium'`) |

Wiring changes in `src/main.tsx`:
- `--effort` argParser now warns on stderr and returns `undefined` (option unset → settings
  fallback) instead of hard-failing:
  `Warning: Unknown --effort value '<RAW>' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.`
  (em dash U+2014, raw case preserved — byte-exact).
- Session-init call sites (×3) use `parseEffortSessionInit(options.effort)` so
  `--effort ultracode` maps to `'xhigh'` (official `kzn`).
- Startup ultracode gate (official `xzn`): `--effort ultracode` enables the session
  ultracode flag.

`parseEffortValue` (frontmatter callers: `loadAgentsDir.ts`, `loadSkillsDir.ts`) is
**intentionally unchanged** — strict semantics kept; regression-guarded by test.

**Verification:**
- Unit: `src/utils/__tests__/effortCliFlag283.test.ts` — 23 pass / 0 fail / 63 expect().
- e2e: `test/e2e/version-2.1.283-effort-cli-flag.e2e.test.ts` — 4 pass / 0 fail (fast
  no-input `-p` path; warning emitted at Commander parse time, no wire call).
- Live A/B vs official binary (`--effort X -p </dev/null`): `BoGuS` → byte-identical
  warning + identical downstream input error on both; `med` / `ultracode` / `HIGH` →
  clean pass-through, identical input error on both.
- Regression: effort suites 135 pass / 0 fail; ultracode-related suites 129 pass / 0 fail.

### Gap-139b — `--bare` help text

Official 283 text (byte-verified) expands the hooks clause:

> `Minimal mode: skip hooks (those defined in settings and by installed plugins; features built into Claude Code are unaffected), LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. …`

Parenthetical added to OCC's `--bare` option text. Help-text-only change.

---

## 2. Self-acceptance A/B record (REPL, tmux, 200×50)

Scripted tmux drive of both binaries from an identical cwd
(`repl-tmux-e2e-testing` skill, Architecture A):

| Surface | Result |
|---|---|
| Boot → input ready | ✅ both: `⏵⏵ auto mode on (shift+tab to cycle)`, `◉ xhigh · /effort` pill, `glm-5.2 with xhigh effort · API Usage Billing` |
| Shift+Tab cycling | ✅ identical order on both: auto → `⏸ manual mode on` → `⏵⏵ accept edits on` |
| `/help` panel | ✅ byte-identical content (tabs, shortcut grid incl. `ctrl + g to edit in $EDITOR` / `/keybindings to customize`, docs URL, feedback line, `Esc to cancel`) |
| Real chat turn | ✅ identical round-trip on both: `❯ Reply with exactly one word: PONG139` → `● PONG139` (live model call through the configured proxy) |
| Unknown slash command | ✅ identical message on both: `Unknown command: /definitely-not-a-command` (+ OCC suggestion line `No commands match "…"`) |
| `/status` panel | ⚠️ divergences — see §3 items 1–2 |
| tmux focus-events advisory bar | ⚠️ official-only — see §3 item 3 |
| `repl-interactive.e2e.test.ts` | 2 pass / 1 fail — the failing "auto-mode opt-in dialog" test is the **known pre-existing** failure (git-stash A/B verified in OCC-44; reproduced this round) |

CLI surface A/B (flags, subcommand helps, error handling) completed earlier in the round:
all diffs traced to known staged ledger items (§3 item 6 + prior ledgers); error-handling
outputs byte-identical.

Priority-feature verification (task order #3 — OCC-138/OCC-98 rounds): 220 unit tests pass
across the 11 targeted 2.1.283-feature test files (prompt-id header, OTEL `tool.output`,
managed model governance, system-prompt merge, sandbox fail-closed, keybinding modifier
validation).

Full `bun test src` A/B (git-stash discipline):
- clean main: 5680 pass / **73 fail**
- with this round's changes: 5703 pass / **73 fail** (+23 = exactly the new unit tests)
- → all 73 failures are **pre-existing on main**; none introduced this round; none in
  effort/ultracode/main-argparse suites.

Repo `bun run lint` exits non-zero on **clean main too** (stash A/B verified). The files
touched this round: `effort.ts` + both new test files lint **clean** (0 warnings); the 12
warnings attributed to `main.tsx` sit in pre-existing regions.

---

## 3. Observed divergences recorded as gaps (NOT fixed this round)

1. **`/status` tabs & rows** — official 283 renders 5 tabs (`Settings Status Config Usage
   Stats`); OCC renders 3 (`Status Config Usage`). Official rows missing in OCC:
   `Session kind: interactive` (already staged in the OCC-46 ledger — needs attacher-state
   resolution), `Managed settings (remote): not fetched — not available with a custom
   ANTHROPIC_BASE_URL`, `Organization policy: not fetched with a custom ANTHROPIC_BASE_URL`.
   Official uses an aligned two-column layout; OCC compact `label: value`. Staged:
   tab/row additions need per-site decompilation (Settings/Stats tab contents unknown —
   do not invent).
2. **`/status` cosmetic** — official prints a tmux advisory bar when focus-events is off
   (see item 3); OCC does not surface managed/org-policy state anywhere in the panel.
3. **tmux `focus-events off` advisory bar** — official renders
   `tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for
   focus tracking` in the REPL header region. OCC handles focus via DECSET 1004 with a
   different reliability heuristic (`src/ink/components/App.tsx:544` comment) and renders
   no advisory. Cosmetic; staged (official detection/trigger conditions need per-site
   decompilation).
4. **Footer hint in manual mode** — official: `⏸ manual mode on · ? for shortcuts · ← for
   agents`; OCC: `⏸ manual mode on (shift+tab to cycle)`. Cosmetic; staged with item 3
   (same footer-render site).
5. **Pre-existing test failures (main)** — (a) `version-2.1.329-effort-cap.e2e.test.ts`
   test-f3 (⑥ ModelPicker capped-note/clamp e2e): `settings.model` is `undefined` after the
   picker interaction while `effortLevel: 'high'` IS written (clamp works, model
   persistence doesn't). Fails identically on clean main (git-stash A/B this round) —
   pre-existing gap candidate in the ModelPicker model-persistence path. (b) The 73
   pre-existing `bun test src` failures (§2). (c) `repl-interactive` auto-mode opt-in
   dialog (known since OCC-44).
6. **STAGE carry-over (text-only port would misrepresent behavior)** — `--safe-mode`
   expanded official semantics vs OCC's narrower by-design scope (documented in
   CLAUDE.md); `--plugin-dir` `.zip`/folder help text (OCC plugin surface trimmed);
   `--fallback-model` official suffix `(only works with --print)` (OCC honors it in REPL
   too); agent/skill frontmatter `effort:` alias surface — official frontmatter parser
   NOT extracted this round, so `parseEffortValue` stays strict (regression-guarded);
   do not port the aliases to frontmatter without per-site decompilation.
7. **Security-review follow-up candidates (pre-existing, LOW)** — from this round's
   security review (record comment on OCC-139): (a) `CLAUDE_CODE_ULTRACODE` is absent from
   `PROJECT_SCOPE_BLOCKED_ENV_KEYS`, so an untrusted project-settings env block could
   enable ultracode (cost impact only, no privilege escalation); (b) the ultracode module
   comment claims the settings-key half is covered but `ULTRACODE_SETTING_KEY` has no
   consumer (fail-closed fidelity note). Neither introduced by this round; both staged.

---

## 4. Security review

security-reviewer agent on the full diff: **no CRITICAL or HIGH findings — ship-able**.
Prototype-pollution safe (`Object.hasOwn` + frozen maps + `isEffortLevel` allowlist),
no fail-open (`undefined` → settings fallback; `'ultracode'` never reaches the wire —
`claude.ts` serializes only string levels post cap-clamp), stderr interpolation matches
official byte-for-byte (LOW/informational, same trust model as official), no secrets,
parseInt fallback NaN/overflow-safe. Full record posted as a threaded comment on OCC-139.

## 5. Deliverables

- `src/utils/effort.ts` — official 283 parser family (new exports) + alias-aware
  `getEffortEnvOverride`
- `src/main.tsx` — lenient `--effort` argParser, session-init call sites ×3 →
  `parseEffortSessionInit`, startup ultracode gate, `--bare` help text
- `src/utils/__tests__/effortCliFlag283.test.ts` (23 tests)
- `test/e2e/version-2.1.283-effort-cli-flag.e2e.test.ts` (4 tests)
- This ledger
