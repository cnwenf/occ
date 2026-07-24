# OCC-28 Upstream Version-Gap Report (2026-07-24)

> **Verdict: NO version gap.** OCC is at the official Claude Code latest (`2.1.218`).
> There is no newer upstream release to port. Recommended next step is the
> issue's "版本追齐后的自验收" — strict REPL self-acceptance against the
> official binary; any inconsistency found becomes a gap to fix.

## 1. Versions in play

| Axis | Value | Source |
|---|---|---|
| Official Claude Code — `latest` dist-tag | **`2.1.218`** | `npm view @anthropic-ai/claude-code dist-tags` → `{stable: 2.1.206, latest: 2.1.218, next: 2.1.218}` |
| Official Claude Code — `next` dist-tag | **`2.1.218`** | same |
| Official Claude Code — `stable` dist-tag | `2.1.206` | same (stable lags latest; not a newer release) |
| Official `2.1.218` publish time | 2026-07-22T19:55:32Z | npm registry `time` |
| OCC **tracked** upstream version | **`2.1.218`** | `README.md` badge "Tracks: Claude Code 2.1.218"; `CLAUDE.md` "last fully aligned to Claude Code `2.1.218`" |
| OCC **own** release version | `2.1.282` | `package.json` `version` — OCC-specific, monotonic above the `2.1.214` baseline; **not** an upstream version |

> The OCC package version (`2.1.282`) and the tracked upstream version
> (`2.1.218`) are different axes. OCC ships its own releases above the
> `2.1.214` baseline while tracking upstream `2.1.218` behavior. Do not
> confuse the two.

## 2. Intermediate changelog & code diff

**None.** OCC is already at the official latest (`2.1.218`), and no
`2.1.219+` version exists on npm (`latest` and `next` both point at
`2.1.218`; the registry's highest published version is `2.1.218`). There is
no intermediate upstream version to diff or port.

The last three upstream releases, for reference:

| Upstream | Published (UTC) | OCC status |
|---|---|---|
| `2.1.216` | 2026-07-20T20:19:37Z | ported (OCC-15/19) |
| `2.1.217` | 2026-07-21T19:55:38Z | ported (OCC-15/19) |
| `2.1.218` | 2026-07-22T19:55:32Z | ported — **full portable alignment** (OCC-19 PRs #199–#228) |

## 3. OCC alignment status against `2.1.218`

### 3.1 Already aligned (every portable 2.1.216/217/218 item is on `main`)

Per `CLAUDE.md`: *"It last fully aligned to Claude Code `2.1.218` (official
latest as of 2026-07-22; full portable alignment via OCC-19, PRs #199–#228 —
every portable 2.1.216/217/218 item is on `main`)."*

The OCC-19 gap report (`docs/upstream-version-gap-occ19.md`, 2026-07-23)
originally listed Stages 5–6 + 🟡 assess items as pending. Those were closed
by the subsequent PR wave:

- **OCC-19 TUI/REPL batch** — PRs #219–#225 (`#219` sandbox-IDE/GUI editor,
  `#221` screen-reader/space-echo/startup, `#222` multi-line paste Ctrl+J /
  left-arrow confirm / Esc agent-view, `#223` slash-menu hot-reload /
  plugin-skill prefix / `/fork` one-line confirm, `#224` nested-UI stack guard /
  dataviz skill, `#225` `@`-mention / statusline / resume-picker /
  `/code-review` recon), gap-report verdicts `#226`/`#220`.
- **OCC-21 Gap-1/Gap-2** — PRs #228–#232: `#228` catch up to 2.1.218 (full
  portable alignment), `#229` Gap-1 track 2.1.218 in README/CLAUDE,
  `#230` Gap-2 CLI flag alignment + `mcp list` glyphs, `#231` Gap-2 security
  LOW hardening (plugin-url timeout + temp cleanup), `#232` release 2.1.279.
- **OCC-22 `mcp login`/`logout` + flag/help parity** — PRs #233–#236
  (release 2.1.281): `mcp login`/`mcp logout` (OAuth via
  `performMCPOAuthFlow`/`revokeServerTokens`, `--no-browser`),
  `mcp get`/`list` `⏸ Pending approval` copy parity, `--brief`/
  `--remote-control`/`--remote-control-session-name-prefix` exposed in
  `--help`, `helpWidth: 80` for non-TTY so leaf-subcommand `--help` is
  byte-identical to 2.1.218.
- **OCC-25 welcome logo** — PRs #234/#235 (release 2.1.280); `#234`
  restores green CI.
- **OCC-27 binary-name audit** — PR #237 (release 2.1.282): resume hints and
  cross-project copy now use the real `occ` executable injected from
  `package.json.bin`; production build injects `MACRO.BINARY_NAME=occ`.

The 2.1.218 changelog items ported into OCC source (verified by code comment
markers `CC 2.1.218 #NN` in `src/QueryEngine.ts`, `src/history.ts`,
`src/tasks/LocalMainSessionTask.ts`, `src/tools/EnterPlanModeTool/*`, etc.)
include #4 left-arrow confirm, #6 multi-line paste Ctrl+J, #12 teardown race,
#13 spurious "[Request interrupted]", #16 nested-UI stack guard, #19 monotonic
turn-duration, #21 prompt-history race, #22 Ctrl+B backgrounding caps,
#23 agent-frontmatter trust gate, #24 fork lineage, #25 resume malformed
delta, #27 auto-mode classifier, #30 `/deep-research` manual-only, #31 plan
mode + auto, #34 agent-name `:` rejection, #35/36 skill frontmatter
`background`/boolean tokens.

### 3.2 Not aligned — **by design**, not alignment debt

These divergences are documented in `CLAUDE.md` as intentional
(flag-safety or OCC-specific features). They are **not** gaps to close; the
rationale is recorded so a future reviewer does not mistake them for debt.

- **`--brief` / `--remote-control` / `--remote-control-session-name-prefix`**
  — registered + visible in `occ --help` for parity, but feature behavior is
  **not** activated (no feature flags added to the build allowlist).
  Re-activating would re-trigger the historical BriefTool 5-minute loop /
  remote-control bridge hang. Flag visibility is separated from behavior
  activation on purpose.
- **`occ -p --output-format=stream-json` init tool-set** — differs from the
  2.1.218 binary. OCC-only extras (WebBrowser / print-mode-interactive tools)
  are present; official-only tools exist in `getBaseTools()` but are filtered
  from `-p` init via intentionally-off feature flags (`KAIROS`/`KAIROS_BRIEF`
  for `BriefTool`/`SendMessage`; `isTodoV2Enabled()` for the `Task*` set).
  Re-enabling re-activates the BriefTool hang. The interactive REPL
  (non-`-p`) path still surfaces these tools through its own enablement.
- **Top-level `occ --help` / `mcp --help` Commands list wrapping** — diverges
  from the binary's separate-indented-line + wrap layout. Root cause: OCC's
  bundled Commander `Help` layout algorithm differs for long signatures, and
  the `helpWidth` knob does not change that algorithm. **Leaf-subcommand**
  `--help` (`mcp login/get/list --help`, etc.) **is byte-identical** to
  2.1.218. Forcing a custom `helpInformation` override risks regressing the
  byte-identical leaf helps — deferred with rationale, low priority.
- **`mcp login` on a `claudeai-proxy` connector** — routes to `auth login`
  (account-level auth) rather than the per-server consent flow, because the
  connector authenticates via the Anthropic account. `mcp logout` on a
  stdio/connector server reports no stored OAuth credentials. Matches the
  official 2.1.218 routing.

### 3.3 Deferred acceptance coverage (not a version gap)

`CLAUDE.md` notes: *"Live TUI/REPL acceptance e2e is deferred to a
non-sandbox environment per the OCC-11 sandbox-stall constraint."* This is a
test-coverage deferral, not an alignment gap. The issue's
"版本追齐后的自验收" section is exactly the mechanism to retire this
deferral — run the real REPL like a human user and confirm behavior/output/
params/error-handling match the official binary.

## 4. Conclusion & recommendation

- **Version gap to align: none.** Official latest = `2.1.218` = OCC tracked.
  No `2.1.219+` exists upstream.
- **Item-level portable alignment: complete** (full portable alignment via
  OCC-19 PRs #199–#228 + OCC-21/22/25/27 follow-ups).
- **Remaining divergences: by design** (flag-safety / OCC-specific), each
  documented with rationale in `CLAUDE.md` — not debt.

**Recommended next step** (per the issue's "版本追齐后的自验收" section and
the OCC Leader's instruction): enter strict self-acceptance — drive OCC's
REPL like a human user (real e2e incl. REPL, not just unit tests), with the
highest priority being **consistency with the official `2.1.218` binary**
(`uvx claude-code` / `npx @anthropic-ai/claude-code@2.1.218`) across REPL
behavior, output, params, and error handling. Any inconsistency discovered
gets recorded as a gap and fixed per the normal flow. Await OCC Leader
confirmation before starting.
