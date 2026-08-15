# Upstream version gap — OCC-95 (2026-08-16)

> Carryover from `docs/upstream-version-gap-occ94.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry, the official GitHub releases, AND fresh downloads of the official
> native ELFs (`@anthropic-ai/claude-code-linux-x64@2.1.232` and
> `@2.1.233`). Behavioral truth for the argument-substitution rework was
> established EMPIRICALLY: the official 2.1.233 `sCt` function was
> reconstructed byte-faithfully and probed with 16 test cases
> (`/tmp/occ95/scratch/sct2.mjs`) before a single line was ported; the
> permission-prompt hook was byte-recovered from ELF offsets ~312839400.

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.301` (OCC-94, PR #279, merge `19e8cea`) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.232` (full portable subset) | OCC-94 ledger |
| Official latest Claude Code | **`2.1.233`** — npm `latest`/`next` agree; GitHub release `v2.1.233` | `npm view`, `gh api` |
| Version gap | **REAL GAP: one release since OCC-94 — `2.1.233` (20 changelog entries)** | this doc §2 |
| Binary markers (fresh downloads) | 2.1.232 + 2.1.233 ELFs diffed via `strings -n 8 \| sort -u \| comm`; port sites recovered verbatim (`sCt`/`vLr`/`Ckn` substitution sentinels, `pkc`/`vPe`/`Qwn` notify hook, `$xi`/`T$S` unrecognized-model signal, `WJ_`/`Mwd` todo-gating) | `/tmp/occ95` research dir |
| Landed this round | **6 byte-verified ports** (§3): ① argument-substitution sCt security rework, ② permission-prompt Notification hooks, ③ unrecognized-model diagnostics, ④ WebFetch cache-TTL env, ⑤ todo/task model gating, ⑥ Bash `< file` input-redirect revert (2.1.232 Linux half rolled forward) | this doc §3 |

**Conclusion: official advanced once since OCC-94 (`2.1.233`, 20 changelog
entries). Full triage in §2: 6 items are portable and byte-verified in the
linux-x64 ELF — all 6 LANDED this round (§3). Three are STAGED with per-site
rationale (§4) — one is blocked on an unreleased Bun runtime feature, one fix
site is not byte-isolable, one needs a selector surface OCC does not render.
The remaining 11 entries are trimmed surfaces (gateway ×2, plugin validate,
cloud sessions, MCP v2 subscriptions/listen, self-hosted runner), Windows-only
(NT prefix, auto-mode cd, Cygwin-revert half), or net-zero in OCC (GitLab MR
worktree ingestion targets the official background-session `agents` view,
bundled-skill alias shadowing has no emitting surface, GitHub-app setup tip).**

## 1. Version truth (三方 — npm + GitHub + binary)

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.233` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.233`, `next=2.1.233` | `npm view … dist-tags --json` |
| Official GitHub releases | **`v2.1.233`** | `gh api repos/anthropics/claude-code/releases` |
| Fresh ELFs downloaded | 2.1.232 and 2.1.233 linux-x64 (`npm pack @anthropic-ai/claude-code-linux-x64@…`) | `/tmp/occ95/v232`, `/tmp/occ95/v233` |
| OCC aligned (start of round) | `2.1.232` full portable subset | OCC-94 ledger |
| OCC own version (start of round) | `2.1.301` | `package.json` |

## 2. Changelog triage (`2.1.233`, 20 entries)

Bucket assignments below; "portable" = no Anthropic-backend dependency,
verifiable in the linux-x64 ELF, and OCC has the surface.

### LANDED this round (§3)

| # | Item | Why portable |
|---|------|--------------|
| A | **"Fixed slash-command argument substitution re-expanding `$` markers inside substituted values; values containing sentinel characters are no longer honored"** (the `sCt` security rework) | The official `sCt` function was reconstructed byte-faithfully and all semantics verified via 16 empirical probes before porting (sentinel shielding, forgery sanitization, scoped `\$` escape with lookbehind, regex-escaped longest-first named args, miss-preservation, append-gate = substitution flag). Ported to `argumentSubstitution.ts`. Security-positive. |
| B | **"Notification hooks now fire for structured-IO permission prompts after 6 seconds unanswered"** (binary `pkc`) | Fully byte-visible: `pkc` body, `Qwn=6000`, display-name helper `vPe`, the raw-truthy `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS` gate, and both call-site shapes (`R.then(k, k)` cancel-on-either-settle on can_use_tool; try/finally on the sandbox ask path). Ported to `permissionPromptNotify.ts` + `structuredIO.ts`. |
| C | **"Added a `[claude-code:unrecognized_model]` diagnostic when a query uses a model the CLI does not recognize"** (binary `$xi`) | Fully byte-visible: tag constant `T$S`, once-store `ZE.claim`, the recognition set (catalog + `claude-3-{opus,sonnet,haiku}` + `claude-mythos-preview`), stderr-in-print / debug-log-otherwise split, `tengu_api_unrecognized_model` event, control-char sanitizer `vot`, swallow-all catch. Ported to `unrecognizedModelSignal.ts` + wired at the two query sites (`claude.ts`, `sideQuery.ts`). |
| D | **"Added `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` to override the WebFetch response-cache TTL"** | Env key + `parseInt` parse + clamp + description-suffix strings are byte-visible. Ported to `WebFetchTool/cacheTtl.ts` with the prompt-description sync. |
| E | **"TodoWrite and Task tools are now disabled on Opus 4.8, Sonnet 5, Fable 5 and newer models; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` restores them"** | Official gating (`WJ_` env override + `Mwd` model-set membership, checked per tool via `isEnabled`) recovered from the ELF. Ported to `todoToolsAvailability.ts` + wired into all 5 tools (TodoWrite, TaskCreate, TaskGet, TaskList, TaskUpdate). |
| F | **"Reverted the Bash `< file` input-redirect permission checks on Windows"** (Linux/macOS half rolled forward) | OCC-94 landed the 2.1.232 input-redirect checks. 2.1.233 reverts ONLY the Windows/Cygwin half; OCC ships the linux/darwin path, so the portable action is confirming OCC's AST path stays as landed and locking it with regression tests (the official Windows revert never reaches OCC's AST). |

### N/A — trimmed / dormant / platform-specific surfaces (11 entries)

| Bucket | Entries | Why N/A in OCC |
|--------|---------|----------------|
| Gateway | `forward_user_identity` gateway flag; gateway error forwarding from apps | Gateway surface is trimmed from OCC. |
| Cloud sessions | cloud-session fixes | Cloud sessions are trimmed from OCC (no `cloud:` surface exists to patch). |
| MCP v2 subscriptions/listen | protocol-level subscription stream | OCC's MCP layer is the simplified stdio/HTTP subset; the v2 subscriptions/listen transport is not implemented (no surface to patch). |
| Plugin validate | `/plugin validate` improvements | Plugins are trimmed from OCC. |
| Self-hosted runner | runner registration/heartbeat fixes | OCC has no self-hosted-runner surface. |
| Windows `\??\` NT prefix | path normalization | Windows-only; OCC ships the linux/darwin path. |
| Windows auto-mode cd | auto-mode working-directory behavior | Windows-only. |
| Cygwin symlink revert (second half of item F) | writes through Cygwin-style symlinks revert | Windows/Cygwin-only — the same 2.1.233 entry whose Linux half is item F. |
| GitLab MR `--worktree` ingestion | MR-URL support in `--worktree` + the `claude agents` review view | The MR-URL ingestion feeds the official PR/MR-review background-session `agents` view (trimmed surface; OCC's `occ agents` is the daemon supervisor, a different subsystem). OCC's local worktree mode is unaffected. |
| Bundled-skill alias shadow fix | bundled skills no longer shadow user skills of the same name | OCC ships zero bundled skill aliases that collide (`BUNDLED_SKILLS` trim); there is no emitting surface for the shadow. Hardening sites staged (§4) for when OCC re-introduces bundled aliases. |
| GitHub App setup tip | tip-suppression for gitlab/bitbucket remotes | The tip lives in the official setup-flow telemetry surface that OCC stubs; OCC has no equivalent tip to gate. |

### STAGED with rationale (§4) — 3 entries

See §4 for per-item detail: the `TOOL_MEMORY_LIMIT` cgroup enforcement (blocked
on an unreleased Bun runtime feature), the idle-Linux-CPU sandbox fix (fix site
not byte-isolable), and the screen-reader `/effort` selector (no selector
surface in OCC's render).

## 3. Landed ports (byte-verified)

### 3.A Argument-substitution `sCt` security rework — `src/utils/argumentSubstitution.ts`

The official 2.1.233 `sCt` replaces the pre-233 string-equality append gate
with sentinel-shielded multi-pass substitution. Verified semantics (each
probed against the byte-faithful reconstruction before porting):

- **Sentinel shielding**: every substituted value has its `$` replaced with
  `SHIELDED_DOLLAR` (U+FFFF, binary `vLr`) and is wrapped in `VALUE_BOUNDARY`
  (U+FFFE, binary `Ckn`) — later passes cannot re-expand `$0` / `$ARGUMENTS` /
  `$name` markers inside substituted values; both sentinels are stripped in the
  final restore.
- **Sentinel-forgery sanitization**: U+FFFF/U+FFFE in user-supplied template or
  args are replaced with U+FFFD before any pass — forged sentinels cannot
  smuggle a fake shielded `$` or fake value boundary through.
- **Scoped `\$` escape**: runtime regex
  `/(?<!\\)\\\$(?=\d|ARGUMENTS|names…)/g` (lookbehind for backslash, literal
  backslash+dollar, marker lookahead) shields `\$` before markers only; `\\$0`
  keeps the marker live.
- **Named args**: regex-escaped names (`escapeRegExp`, binary `Mz`), substituted
  longest-name-first so `$a` cannot swallow `$ab`.
- **Miss preservation**: `$ARGUMENTS[n]` miss → `SHIELDED_DOLLAR + match.slice(1)`
  (placeholder kept verbatim, protected from the `$ARGUMENTS` replaceAll); `$n`
  miss → match preserved.
- **Append gate = substitution flag**: `if (!didSubstitute && appendIfNoPlaceholder && args)`
  appends `\nARGUMENTS: <args>` (single `\n`) — an all-miss template now appends
  (this supersedes the pinned pre-233 string-equality expectation; the two
  affected tests updated to official behavior). Empty args never append.

Tests: `argumentSubstitution.test.ts` now 40 tests (14 new in the
`2.1.233 sCt security rework` describe), all green.

### 3.B Permission-prompt Notification hooks — `src/utils/permissionPromptNotify.ts` + `src/cli/structuredIO.ts`

Byte-verbatim from ELF offsets ~312839400:

```js
function pkc(e){if(V.CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS)return()=>{};
let t=setTimeout((r)=>{$V({id:qt(),project:{originalCwd:En(),projectRoot:Va()}},
{message:`Claude needs your permission to use ${r}`,
notificationType:"permission_prompt"}).catch(()=>{})},Qwn,e);
return t.unref(),()=>clearTimeout(t)}   // Qwn=6000
```

- `getToolDisplayName` (binary `vPe`): last `__` segment, underscores → spaces,
  `\b\w` uppercased (never lowercased — `WebFetch` stays `WebFetch`,
  `mcp__server__tool_name` → `Tool Name`).
- Env gate is a raw truthy check — ANY non-empty value (including `"0"`)
  disables, byte-equivalent to `if(V.X)`.
- Call sites in `structuredIO.ts`: can_use_tool schedules
  `schedulePermissionPromptNotifyHook(getToolDisplayName(tool.name))` after the
  permission prompt is sent and cancels via
  `sdkPromise.then(cancel, cancel)` (binary `R.then(k, k)`); the
  SandboxNetworkAccess ask path wraps the send in try/finally with the cancel
  in `finally`.
- Tests: `permissionPromptNotify233.test.ts` (9 tests) — vPe outputs, exact
  payload, cancel, env gate incl. `"0"`/`"false"`, fires-at-most-once.

### 3.C Unrecognized-model diagnostics — `src/utils/model/unrecognizedModelSignal.ts`

Binary `$xi` port (see file header for the verbatim source): one-time per-model
`[claude-code:unrecognized_model]` line — stderr in print mode, debug log
otherwise — plus the `tengu_api_unrecognized_model` event. OCC's recognition
set is pattern-derived from `firstPartyNameToCanonical` (OCC has no bundled
model catalog) + `claude-mythos-preview`; `modelOverrides` values silence the
signal exactly like the official; inference-profile models are skipped entirely
(OCC's backing-model lookup is async-only — documented divergence, never
false-flags). Wired at the two query emission sites: `claude.ts` and
`sideQuery.ts`. Tests: `unrecognizedModelSignal233.test.ts` (11 tests).

### 3.D WebFetch cache-TTL env — `src/tools/WebFetchTool/cacheTtl.ts`

`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` overrides the WebFetch response-cache TTL
(binary parse + clamp recovered verbatim); the tool prompt description gains
the matching suffix when the env is set. Tests: `cacheTtl233.test.ts` (10).

### 3.E Todo/task model gating — `src/utils/todoToolsAvailability.ts`

TodoWrite + Task* tools are disabled on Opus 4.8, Sonnet 5, Fable 5 and newer
models (binary `Mwd` set); `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` force-enables
(binary `WJ_`). Wired into all 5 tools' `isEnabled`. Tests:
`todoToolsAvailability233.test.ts` (6).

### 3.F Input-redirect revert — `src/tools/BashTool/pathValidation.ts`

2.1.233 reverts the 2.1.232 Windows/Cygwin input-redirect behavior only; OCC
ships the linux/darwin AST path, which stays as OCC-94 landed it. New
`inputRedirectRevert233.test.ts` (6 tests) locks the boundary; the obsolete
`inputRedirectPermission232.test.ts` (pinned the pre-revert Windows-side
expectations) is deleted.

## 4. Staged items (with per-site rationale)

| Item | Rationale |
|------|-----------|
| **`TOOL_MEMORY_LIMIT` cgroup enforcement** | The official enforcement spawns the tool process with Bun's `cgroup` spawn option. That option landed upstream in oven-sh/bun PR #37466 (merged 2026-08-11) and is **not in any released Bun** — Bun 1.3.14 (OCC's runtime) silently ignores the option. Porting now would be dead code with a false sense of enforcement. Port plan is ready: read the limit from `TOOL_MEMORY_LIMIT`, pass `{ cgroup }` at the spawn site once a Bun release ships the option. Revisit the round after Bun releases it. |
| **Idle-Linux-CPU sandbox fix** | The fix lives inside the `@anthropic-ai/sandbox-runtime` package internals (idle-CPU accounting); OCC pins 0.0.44. The change is not byte-isolable against OCC's pinned version without a dedicated sandbox-runtime decompilation/bisect (STOP per `aligning-with-official-binary`). Candidate for the next sandbox-runtime bump round. |
| **Screen-reader `/effort` selector fix** | The fix targets the `/effort` effort-selector surface's screen-reader announcements. OCC does not render that selector surface; porting announcement fixes without a surface to attach them to would be an invented/partial implementation (STOP per skill). |

**Latent gap found during the sCt port (follow-up recommended):** OCC's
`substituteArguments` pre-233 lacked the official `B9`/`Q9` shell-marker escape
callback; an argument-injected `` !`cmd` `` form could reach a shell on some
paths. The 2.1.233 sCt port closes the re-expansion vector, but the marker
escape callback itself remains unported — tracked for the next round.

**Staged hardening sites** (for the bundled-skill alias shadow N/A entry): if
OCC ever re-introduces bundled skill aliases, apply the official
user-over-bundled precedence at `src/utils/print.ts:2217-2221`,
`src/tools/SkillTool/SkillTool.ts:100-110`, `src/main.tsx:2703,3006`.

## 5. Verification (this round)

| Gate | Result |
|------|--------|
| Full src suite | **1979 pass / 0 fail / 4602 expect() / 210 files** (baseline pre-round: 1930 / 0 / 4524 / 206) |
| Curated e2e subset | **69 pass / 0 fail / 216 expect() across 11 files** (occ-versioning, commands-alignment, version-2.1.219-* ×5, resume-interrupted-turn-221, version-2.1.163-skill-dollar-escape, version-hooks-exec) |
| Build | `dist/cli.js` 28.90 MB, green |
| Lint (Biome) | 0 new errors in touched files (repo pre-existing errors 41→37 after a `biome-ignore` on the intentional control-char regex, matching the `src/main.tsx:1721` precedent) |
| Empirical pre-port verification | 16/16 probes against the byte-faithful sCt reconstruction (`/tmp/occ95/scratch/sct2.mjs`) |
