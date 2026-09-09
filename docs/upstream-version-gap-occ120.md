# OCC-120 Upstream Version Gap — official Claude Code 2.1.266 (staged-subset landing round)

- **Round**: OCC-120 (autopilot, 2026-09-10)
- **OCC aligned-at (entry)**: official 2.1.266 at changelog level (OCC-81 round, OCC release 2.1.326, main `2e70b01`) — but with three items explicitly staged as "next-round candidates" in `docs/upstream-version-gap-occ81.md` §4, and the 2.1.265 entry #19 (two-key chord timeout) mis-bucketed into the coarse "not portable" pass even though it lands on OCC's live `src/keybindings/` surface.
- **Official latest at round time**: 2.1.266 (`npm dist-tags.latest`; `next` = 2.1.267 — out of scope, single `maxEffortLevel` settings entry). No new official release since OCC-81; this round closes the OCC-81 staged backlog + the entries OCC-81 missed.
- **Method**: `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.263,2.1.266}` → `strings -n 8 | sort -u` → `comm` diff (added 14,372 / removed 13,091 lines) → fixed-substring window extraction (`ctx.py`) on the MB-long minified lines (regex grep is catastrophically slow there). Every landed string/constant below is byte-verified from the official 2.1.266 linux-x64 ELF.
- **Binary sha256**: 2.1.263 `26d020351e8112f4006790f3cfce43b4c9df0c1bb1d0e542364d64151b81d5ba`; 2.1.266 `19842705e989393fce936804df6d2ab034860e24b8f8880357981d87ffd83fac`.
- **Official 2.1.265 changelog**: 50 entries (2.1.266 adds 1 hotfix entry).

## 1. Landed this round

### Gap-120a — `/model` save-failure feedback (official 2.1.265 #25; OCC-81 staged candidate #1)

Official changelog: "Fixed `/model` claiming a model was 'saved as your default' when the settings file couldn't be written; it now says the save failed and why".

Byte-verified official 2.1.266 machinery (minified names): `DKe` = handleSelect assembly, `wMe` = save-with-3s-timeout returning `{kind:"saved"|"unconfirmed"|"failed"}`, `vMe` = failure-suffix copy:

```js
async function DKe(e,t,o,n,r,i,s,c){let d=o().fastMode;...
  let M=r?await wMe(t,c):null,S=M?.kind==="saved",
  p=`${moe}${gg(yh(t))}${S?" and saved as your default for new sessions":" for this session only"}`;
  return p+=gX(d,u,t,{announceKeptOn:!0}),p+=vMe(M),p+=(S?sin(t):"")||iin(t),p}
function vMe(e){if(e===null||e.kind==="saved")return"";
  let t=qc(ao("userSettings")??"settings.json");
  switch(e.kind){
    case"unconfirmed":return` · couldn't confirm it was saved as your default (${t} is still being written)`;
    case"failed":{let o=e.error.cause,n=o instanceof Error?`can't be written (${A(o)??o.message})`:"isn't valid JSON";
      return` · couldn't save it as your default: ${t} ${n}`}}}
```

**OCC change** (`src/commands/model/model.tsx`): `handleSelect` no longer fire-and-forgets `updateSettingsForSource`. New exported helpers:
- `saveModelAsDefault(model): ModelDefaultSaveResult` — wraps OCC's **synchronous** `updateSettingsForSource("userSettings", { model })` into `{kind:'saved'} | {kind:'failed', error}`.
- `renderModelSaveFailureSuffix(result)` — byte-verified `vMe` failed-branch copy: `` ` · couldn't save it as your default: ${path} ${reason}` `` with `reason` = `isn't valid JSON` when the settings error is the JSON-syntax failure (`updateSettingsForSource` surfaces it as `Invalid JSON syntax in settings file at …`), else ``can't be written (${error.message})``.
- Base message switches on the outcome: saved → ` and saved as your default for new sessions` (unchanged success copy), failed → ` for this session only`.
- Assembly order matches official `DKe`: base → effort → fast-mode → **failure suffix** → billed-as-extra-usage → (pre-existing OCC) fast-mode-OFF.

**Documented divergences (deliberate, minimal-faithful):**
1. **No `unconfirmed` branch** — official `wMe` is async with a 3s timeout (`var I=3000; At(…, o)`); a still-in-flight write yields `unconfirmed` (`· couldn't confirm it was saved…is still being written`). OCC's `updateSettingsForSource` is synchronous — by the time it returns, the write either succeeded or failed. The `unconfirmed` state is unreachable; the union omits it rather than carrying dead code.
2. **Path formatter** — official `qc(ao("userSettings") ?? "settings.json")`: `ao` = `getSettingsFilePathForSource`; `qc` is **not identifiable from strings** (minified name collisions — `function qc(` hits in 2.1.266 are a mention-parser and an AST-walker). OCC uses its own established settings-path display convention `path.replace(homedir(), '~')` (precedent: `src/utils/doctorDiagnostic.ts:433`, `src/utils/nativeInstaller/installer.ts:950`). For the userSettings file (`~/.claude/settings.json`) the rendered result is the natural `~`-shortened path.
3. **Analytics omitted** — official `wMe` fires `model_set_default` with `unconfirmed`/`write_failed`/success markers; OCC's analytics surface is an empty implementation and the existing `tengu_model_command_menu` event is kept unchanged.
4. **Official error-cause unwrap** (`o=e.error.cause; A(o)??o.message`) maps to OCC's flat `error.message` — OCC's `updateSettingsForSource` builds `new Error(\`Failed to read raw settings from ${filePath}: ${e}\`)` with the cause inlined into the message, so the rendered `can't be written (…)` carries equivalent information.
5. The official picker-hotkey save path `V1` (emitting a `Model set to…` notification with key `model-switched`) belongs to a picker surface OCC does not have — skipped.
6. `handleSessionOnlySelect` (the `'s'` session-only hotkey) is intentionally untouched — it never claimed a save.

### Gap-120b — two-key chord timeout 1s → 3s + cancellation notice (official 2.1.265 #19)

Official changelog: "Fixed two-key keyboard shortcuts cancelling silently when the second key arrived more than a second later, as happens inside tmux; they now wait 3 seconds and show a notice when they time out".

Byte-verified official 2.1.266: `var Nn=3000;` and the timeout callback emits

```js
l({key:"chord-timeout",kind:"feedback",
   text:`${tK(x,w0())} cancelled — no next key within ${Nn/1000}s`,
   priority:"immediate",timeoutMs:3000})
```

with `tK` = `chordToDisplayString`, `w0` = `getPlatform`.

**OCC change** (`src/keybindings/KeybindingProviderSetup.tsx`):
- `CHORD_TIMEOUT_MS` 1000 → **3000**, now exported.
- The timeout callback emits the official notification through the existing `useNotifications()` sink (same pattern as `useKeybindingWarnings`): key `chord-timeout`, text `` `${chordToDisplayString(timedOutChord, getPlatform())} cancelled — no next key within ${CHORD_TIMEOUT_MS / 1000}s` ``, `priority: "immediate"`, `timeoutMs: 3000`.

**Documented divergence:** official carries `kind:"feedback"`; OCC's `TextNotification` type has no `kind` field — the feedback kind maps to default notification styling, so it is omitted.

**Note on OCC-81 triage:** this entry was swept into OCC-81's "remaining ~50 entries touch trimmed/backend-only surfaces" bucket. Per-entry triage this round shows keybindings/chords are a **live** OCC surface (`src/keybindings/` with default bindings, chord resolver, hot-reload) — landed.

### Gap-120c — `/model opusplan[1m]` acceptance (official 2.1.265 #7; OCC-81 staged candidate #3)

Official changelog: "Fixed `/model opusplan[1m]` being rejected with 'Model not found'".

Byte-verified official 2.1.266 (the trace OCC-81 could not complete — recovered this round via the `lin`/`ND`/`v9`/`XC` cluster):

```js
function lin(e){let t=e.toLowerCase();if(!(t.includes("sonnet[1m]")||t.includes("sonnet-4-6[1m]")
  ||t.includes("sonnet-5[1m]")||t.trim()==="opusplan[1m]"))return!1;
  if(Hg(Et(e)))return!1;return!LD()}                       // sonnet-1m gate
function ain(e){let t=e.toLowerCase();if(!(t.includes("opus")&&t.includes("[1m]")))return!1;
  if(E(e).every((o)=>Hg(o)))return!1;return!TP()&&!ov()}   // opus-1m gate (unchanged in OCC)
function ND(e){if(e==="opusplan")return"Opus Plan";if(Lg(e))return Gs(Et(e));return Gs(e)}
function v9(e){if(e==="opusplan"||e==="opusplan[1m]")return"opus";if(e==="haiku")return"sonnet";return null}
function XC(e){return e==="opusplan"||e==="haiku"}
```

**OCC change (minimal-faithful to OCC's architecture):**
- `src/utils/model/aliases.ts`: `MODEL_ALIASES` gains `'opusplan[1m]'`. **Divergence note**: the official fix site is inside command validation (the official alias array extracted by OCC-81 — `["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]` — is identical in 263↔266, i.e. official did **not** add `opusplan[1m]` to that array). OCC's `/model <name>` acceptance path is alias-list-driven (`isKnownAlias` → `MODEL_ALIASES.includes`), so the alias entry is OCC's equivalent acceptance fix; the observable contract (`/model opusplan[1m]` is accepted, resolves to sonnet-default+`[1m]`, plan-mode-upgrades to opus) matches official.
- Resolution was already correct: `parseUserSpecifiedModel('opusplan[1m]')` strips `[1m]` before the alias switch → `getDefaultSonnetModel() + '[1m]'`; the plan-mode upgrade at `model.ts` lines ~289/294 already handles `opusplan[1m]`.
- `src/utils/model/model.ts` `renderModelSetting`: special case `'opusplan[1m]'` → `renderModelName(parseUserSpecifiedModel(setting))`, mirroring official `ND`'s alias branch (`Gs(Et(e))`) and avoiding the `capitalize()` fallback's `Opusplan[1m]`. `renderDefaultModelSetting` already matched official `bW` (only bare `opusplan` gets the plan-mode sentence).
- `src/commands/model/model.tsx` `isSonnet1mUnavailable`: gate set extended to the official `lin` verbatim set — `sonnet[1m]` / `sonnet-4-6[1m]` / **`sonnet-5[1m]`** / **exact `opusplan[1m]`** (opusplan[1m] routes through the Sonnet gate because it resolves to Sonnet in normal mode). `isOpus1mUnavailable` is unchanged — OCC's `m.includes('opus') && m.includes('[1m]')` already matches the official `ain` shape (and also catches `opusplan[1m]` first, same as official evaluation order).
- Consumer audit: `agent.ts AGENT_MODEL_OPTIONS` (type-level only; `getAgentModelOptions()` picker rows are hardcoded — unchanged), `validateModel.ts:40` (early-accept — the intended acceptance), `modelAllowlist.ts` (alias resolution now treats `opusplan[1m]` like `opusplan`/`sonnet[1m]` — benign, family matching via `includes('opus')` was already true).

**Staged (forensicated, not landed):** the official alias-`[1m]` **rejection family** (`T`/`E` cluster) — three staged messages + analytics (`model_switch` with `alias_1m_disabled` / `alias_1m_unsupported` / `alias_1m_no_mode_variant`):
- disabled: `1M context is turned off here (CLAUDE_CODE_DISABLE_1M_CONTEXT is set), so '<alias>' isn't available. Run /model <base> instead.`
- unsupported: `<carrier> doesn't have a 1M context window, so '<alias>' isn't available. Run /model <base> to use it with its standard context window.`
- no-mode-dependent-variant: `'<alias>' isn't available: the <base> setting switches models in plan mode and has no 1M form. Run /model <base>, or /model sonnet[1m] for a 1M context window.`

Why staged: wiring the three-branch family requires the official's mode-dependent-variant helper semantics (`v9`/`XC`) to be mapped onto OCC's gate ordering (which fires first for `opusplan[1m]` when both 1M accesses are off — OCC: Opus gate; official: depends on `E(e).every(Hg)`), a behavioral question that needs its own A/B round. Byte evidence captured above; no user-facing regression meanwhile (both gates still reject with the official unavailable copy).

### Gap-120d — stale 1M-unavailable copy (discovered via byte diff; not a changelog entry)

`s263`/`s266` string comparison showed the official unavailable copy is **identical in both** binaries:

- `Opus with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`
- `Sonnet with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`

OCC carried stale `Opus 4.6 with…` / `Sonnet 4.6 with…` wording in `SetModelAndClose` — fixed to the byte-current strings (URL unchanged). The `/model` **picker row descriptions** in `modelOptions.ts` ("Opus 5 with 1M context window - for long sessions with large codebases" etc.) ARE official (s263 hits) — deliberately untouched.

## 2. NO-OP (verified this round)

| Official entry | Verdict | Evidence |
|---|---|---|
| 2.1.266 `CLAUDE_CODE_USE_GATEWAY` regression hotfix | no-op | zero `CLAUDE_CODE_USE_GATEWAY` hits in OCC src (confirms OCC-81) |
| #29 `claude-api` skill error-code reference 403→404/400 | no-op | zero 403-copy hits in OCC bundle; OCC's skill `.md` files are intentional stubs |
| #43 `.claude` permission label | already landed | OCC-81 / PR #341 |
| #10 plugin backslash symlink-containment bypass | not applicable | OCC's `copyDir` containment (`pluginLoader.ts:295-340`) is POSIX-native `realpath` + `resolvedTarget.startsWith(srcPrefix)` — structurally immune to the official's Windows-backslash bypass |
| gateway / OTLP relay / Remote Control / VSCode / Desktop / artifact-DB / connector / native-image-extraction / cloud-session / billing entries | not portable | surfaces removed or Anthropic-backend-only in OCC (per CLAUDE.md trimmed-module table); matches OCC-81's bucket after per-entry re-verification |

## 3. Staged (per-entry triage of the remaining 2.1.265 entries; leads captured)

| Entry (#) | Lead / why staged |
|---|---|
| #2 `--plugin-dir` folder-of-plugins | new feature surface; OCC's plugin loading is trimmed — needs its own design round |
| #3 1 GB tool-result cap + truncation preview | official copy fragments found in SELF_HOSTED_RUNNER_TOOLS persistence: `full file saved to ${re.filepath}; head follows` / `saving the full file to disk failed; a truncated head follows` — needs per-site forensics on OCC's tool-result persistence path |
| #30 `cd` persistence in non-interactive sessions | strong lead: `src/QueryEngine.ts:292` — `setCwd(cwd)` inside `submitMessage` with cwd destructured from `this.config` (frozen at construction). Broad blast radius (REPL + print + agents) — needs dedicated A/B round |
| #31 MCP `http`→legacy-SSE fallback | only the protocol-version-negotiation string found in the binary (`Version negotiation failed: … pre-2026-07-28 protocol version to fall back to`); no legacy-SSE transport copy recoverable — STOP per never-invent |
| #4/#5/#6 prompt-cache resume fixes | backend prompt-prefix ordering; not verifiable from OCC side without live cache-metrics A/B |
| #8 sigil highlighting (Ruby `?`/Erlang `$/Perl `$`) | highlighter internals; needs per-language repro fixtures |
| #9 fullscreen transcript row jump on suggestion list | OCC fullscreen transcript layout differs; needs live repro |
| #27 `/config` dialog tab height | OCC `/config` surface differs (trimmed rows); cosmetic |
| #28 workflow journal resume failure message | OCC workflow engine journals differ; message copy not found recoverable |
| #15 nested-repo git clean filters | needs git-config A/B harness |
| #41 image decode error copy | native image path removed in OCC |
| #36 `--worktree` parallel checkout | OCC has no `--worktree` flag |
| #39 lazy MCP OAuth registration | OCC MCP OAuth is simplified (CLAUDE.md); behavior change needs its own round |
| #38 slash-command suggestion list (mid-prompt matches) | prompt-input UI rework |
| #37 `/workflows` agent detail | OCC workflow UI differs |
| #40 resume speed for long sessions | perf work, no byte surface |
| #34 recovery-notice copy | background-session surface differs (daemon supervisor) |
| #14 `--bg` mid-turn retire | OCC `--bg` redirects to daemon subcommands (OCC-21 divergence) |
| #16 advisor re-decision | advisor surface not shipped |
| #17 artifact publish tool names | artifact surface not shipped |
| #18 `/add-dir` managed-lock nuance | managed-settings surface partial in OCC |
| #11 plugin two-dot dirs / #21 plugin component-folder reporting / #23 `/plugin` metadata / #46 plugin metadata preference | plugin surface trimmed |
| Gap-120c rejection family (`T`/`E`) | see §1 Gap-120c |
| `fable[1m]` alias (OCC-81 carryover) | official carries it in the alias array (both 263/266); OCC lacks it. `parseUserSpecifiedModel` already resolves `fable[1m]` (strip-then-switch), but downstream 1M-access gating and picker rows for fable are unverified — half-working-alias risk per OCC-81; stays staged |
| Gap-119b / Gap-119c (OCC-119 carryovers) | brand-conflict / cross-cutting — unchanged |

## 4. Security review (issue requirement)

- All landed changes are UI copy, a timeout constant, an alias-list entry, and a save-outcome check. **No** new network calls, eval/exec, fs surfaces beyond the pre-existing settings write (now *checked* instead of fire-and-forget — strictly safer), credential handling, or telemetry.
- `strings` diff (added.txt 14,372 lines) scanned for suspicious additions: 4 new env vars all artifact-DB/tether backend (OCC-81 §2), no new hook events, no new command surface; nothing resembling a backdoor in the official 2.1.263→2.1.266 delta.
- Gap-120a *reduces* a silent-failure class (settings write failures now surfaced to the user).
- No hardcoded secrets in the diff; `getDisplayPath`/`homedir` usage is display-only.
- **Verdict: APPROVE.**

## 5. Tests & verification

- New unit tests: `test/utils/model/version-2.1.266-gap120.test.ts` — 16 tests / 36 expects: Gap-120a suffix copy (both failure kinds, saved → empty, deterministic `CLAUDE_CONFIG_DIR`), handleSelect assembly order (source-verified), Gap-120b constant + notification copy + `chordToDisplayString` shape (`ctrl+c r cancelled — no next key within 3s`), Gap-120c alias registration / parse / `renderModelSetting` / `renderDefaultModelSetting` / `lin` gate set, Gap-120d current copy present + stale copy absent.
- Targeted suites: `src/utils/model` + `src/keybindings` + `test/utils/model` → **139 pass / 0 fail**.
- Model/keybinding e2e (8 files): **46 pass / 6 fail** — all 6 fails are the tmux-REPL keybinding-flavor e2e timing out at 20s; **git-stash A/B on unmodified main fails identically** (environmental: tmux/TTY in this sandbox), pre-existing, not caused by this round. Consistent with the CI baseline's environmental-fail set.
- Biome lint on all touched files: clean (0 errors / 0 warnings).
- Full `scripts/ci-test.sh` + `bun run build`: see release notes (run before merge).

## 6. Release

- `package.json` 2.1.326 → **2.1.327**; `CHANGELOG.md` header extended + `## 2.1.327 - 2026-09-10 (OCC-120)` entry.
- Flow: PR → merge to main → tag `v2.1.327` → push tag triggers `.github/workflows/publish.yml` → verify tags count == releases count and `comm -23` gap empty → report.
