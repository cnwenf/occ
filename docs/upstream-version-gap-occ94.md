# Upstream version gap — OCC-94 (2026-08-15)

> Carryover from `docs/upstream-version-gap-occ93.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry, the official GitHub releases, AND fresh downloads of the official
> native ELFs (`@anthropic-ai/claude-code-linux-x64@2.1.231` and
> `@2.1.232`). Behavioral truth cross-checked by driving OCC's LIVE
> permission paths (`checkPathConstraints`, `isPathTrusted`,
> `convertToSandboxRuntimeConfig`, `scanForSecrets`) side by side with the
> decompiled 2.1.231/2.1.232 binaries.

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.300` (OCC-93, PR #278) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.231` (full portable subset) | OCC-93 ledger |
| Official latest Claude Code | **`2.1.232`** — npm `latest`/`next` agree; GitHub release `v2.1.232` | `npm view`, `gh api` |
| Version gap | **REAL GAP: one release since OCC-93 — `2.1.232` (49 changelog entries)** | this doc §2 |
| Binary markers (fresh downloads) | 2.1.231 + 2.1.232 ELFs diffed via windowed `strings` extraction; port sites recovered verbatim (`X1e` GitLab body, `YEo`/`uXc` trust walk, `Dxr` redirect check, `rTt` ripgrep scope) | `/tmp/occ94` research dir |
| Landed this round | **4 byte-verified security/permission ports** (§3): ① GitLab token-family redaction, ② nested-git-repo trust boundary, ③ Bash `< file` input-redirect permission checks, ④ `sandbox.ripgrep` source-scope restriction | this doc §3 |

**Conclusion: official advanced once since OCC-93 (`2.1.232`, a large release
— 49 changelog entries, security-leaning). Full triage in §2: 4 items are
portable and byte-verified in the linux-x64 ELF — all 4 LANDED this round
(§3). The remaining entries are either platform-trimmed surfaces (Remote
Control ×8, gateway ×3, plugin/marketplace ×5, voice, Cowork), dormant
flag-gated surfaces (cross-session messaging ×4 — `KAIROS`/`UDS_INBOX` off),
Windows-only, net-zero (removed startup tip OCC never had), or staged with
per-site rationale (§4) because the fix site is not byte-isolable in the ELF
without dedicated decompilation (STOP per `aligning-with-official-binary`).**

## 1. Version truth (三方 — npm + GitHub + binary)

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.232` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.232`, `next=2.1.232` | `npm view … dist-tags --json` |
| Official GitHub releases | **`v2.1.232`** | `gh api repos/anthropics/claude-code/releases` |
| Fresh ELFs downloaded | 2.1.231 and 2.1.232 linux-x64 (`npm pack @anthropic-ai/claude-code-linux-x64@…`) | `/tmp/occ94/v231`, `/tmp/occ94/v232` |
| OCC aligned (start of round) | `2.1.231` full portable subset | OCC-93 ledger |

## 2. Changelog triage (`2.1.232`, 49 entries)

Bucket assignments below; "portable" = no Anthropic-backend dependency,
verifiable in the linux-x64 ELF, and OCC has the surface.

### LANDED this round (§3)

| # | Item | Why portable |
|---|------|--------------|
| A | **"Added secret redaction for GitLab token families (`glrt-`, `gloas-`, `glptt-`, `glagent-`, `glimt-`, `glsoat-`, `glcbt-`, `glft-`, `glffct-`) and full redaction of routable `glpat-`/`gldt-` tokens"** (redaction half) | The official scrubber's shared body constant `X1e` (`[\w=-]{20,}(?:\.[0-9a-z]{9})?`) and all 11 `gl<Prefix>-` rules are byte-verbatim in the ELF. Ported to `secretScanner.ts`. (The same entry's second half — `glab` CLI credential-path protection — is STAGED, §4.) |
| B | **"Fixed nested git repositories inheriting trust from a parent directory; each repository now requires its own trust confirmation"** | Official fix functions (`xx_`/`bed`/`ved`/`v8e` + uncached git-root probe `YEo`/`uXc`) recovered from the ELF. The bounded ancestor walk is fully visible. Ported to `git.ts` + `config.ts`. |
| C | **"Bash input redirections (`< file`) are now permission-checked like their argument spellings on all platforms"** | The official input-redirect loop (`if(o)for(let h of o){if(h.op!=="<"\|\|h.target==="/dev/null")continue;…Dxr(h.target,t,r,"read")…}`) is byte-visible; message strings recovered verbatim. Ported to `pathValidation.ts` (AST path — the same path OCC's production gate `bashToolHasPermission` uses). |
| D | **"Changed `sandbox.ripgrep` to be honored only from user, managed, and `--settings` settings; project settings can no longer override the sandbox's ripgrep binary"** | Official scope helper `rTt()` (`[...r7(),fn("flagSettings"),Wg("userSettings")?fn("userSettings"):null]`) is byte-visible: policy > flag > user, project/local excluded. Ported to `sandbox-adapter.ts`. Security-positive. |

### N/A — trimmed / dormant / platform-specific surfaces (26 entries)

| Bucket | Entries | Why N/A in OCC |
|--------|---------|----------------|
| Cross-session messaging | `@`-mention another session by name; `SendMessage` bare-name delivery; unique interactive session names; `/config` rows "Dialog expiry" / "Messages from your other sessions" | `KAIROS` / `UDS_INBOX` flags are OFF in OCC's `FEATURE_ALLOWLIST` (re-enabling hangs the query path — documented in `featureFlags.ts`). The whole cross-session surface is dead code in the shipped build. |
| Plugin / marketplace | GitLab marketplace bare-URL cloning; `additionalMarketplaces`/`allowedMarketplaces` aliases; url-typed `blockedMarketplaces` policy; `known_marketplaces.json` startup-race fix; `/plugin install` marketplace refresh | Plugins/marketplace are trimmed from OCC (`BUNDLED_WORKFLOWS`-style intentional trim; no marketplace surface exists to patch). |
| Gateway | `desktop:` overlay boot validation; `managed.policies` group/email_domain boot validation; Cloud gateway `/login` error surfacing | Gateway surface is trimmed from OCC. |
| Remote Control | bridge transcript/credential inheritance fix; Desktop/IDE session reattach; idle-unreachable fix; worker-restart history restore; deleted-session replacement resume; 30-min reconnect window; resume-takeover silence fix; takeover terminal messaging | Remote Control is trimmed from OCC. |
| Voice | "listening…" stuck fix | Voice mode removed from OCC. |
| `/code-review` background agent at high/xhigh/max | The background-agent level runs via bundled workflows; OCC ships zero bundled workflows (intentional trim). OCC's `/code-review` is implemented separately. |
| Cowork @-imports | Cowork sessions no longer inline external @-imports from user-scope memory | Desktop/Cowork surface absent from OCC. |
| Cross-session socket dir hardening | Pre-planted symlink / other-user dir refusal on shared `/tmp` | The socket directory serves cross-session messaging (`UDS_INBOX`) — dormant in OCC. |
| Windows Git Bash Cygwin symlinks | Writes through Cygwin-style symlinks now require approval | Windows-only; OCC ships the linux/darwin path. |
| Removed startup tip | "Removed the startup tip suggesting you create custom subagents" | OCC has no such tip — net-zero. |

### STAGED with rationale (§4) — 19 entries

See §4 for per-item detail. Highlights: the `glab` CLI credential-path
protection (no host machinery in OCC), the Linux sandbox protected-path
bypass (fix lives in the `@anthropic-ai/sandbox-runtime` package — OCC pins
0.0.44; the bump to 0.0.73 is staged), subagent forking default-on (behind
the off-allowlist `FORK_SUBAGENT` flag), and a set of UI/transport fixes
whose fix sites are not byte-isolable without dedicated per-site
decompilation.

## 3. Landed ports (byte-verified)

### 3.A GitLab token-family redaction — `src/services/teamMemorySync/secretScanner.ts`

- New shared body constant `GITLAB_TOKEN_BODY = '[\\w=-]{20,}(?:\\.[0-9a-z]{9})?'`
  — byte-identical to the official scrubber's `X1e`.
- The old `gitlab-pat` (`glpat-[\w-]{20}`) and `gitlab-deploy-token`
  (`gldt-[0-9a-zA-Z_\-]{20}`) rules are replaced by 11 rules sharing the new
  body: `gitlab-pat` (glpat-), `gitlab-deploy-token` (gldt-),
  `gitlab-runner-authentication-token` (glrt-), `gitlab-oauth-app-secret`
  (gloas-), `gitlab-pipeline-trigger-token` (glptt-),
  `gitlab-kubernetes-agent-token` (glagent-), `gitlab-incoming-mail-token`
  (glimt-), `gitlab-scim-oauth-token` (glsoat-), `gitlab-ci-build-token`
  (glcbt-), `gitlab-feed-token` (glft-), `gitlab-feature-flag-client-token`
  (glffct-).
- `ruleIdToLabel` specialCase additions: `ci → 'CI'`, `scim → 'SCIM'`.
- Tests: `secretScannerGitlab232.test.ts` (15 tests: all 11 prefixes, the
  rotation-suffix body form, sub-20-char rejection, labels, redaction).

### 3.B Nested-git-repo trust boundary — `src/utils/git.ts` + `src/utils/config.ts`

- New `findGitRootUncached(startPath)` (port of official `YEo`/`uXc`):
  uncached upward walk probing `<dir>/.git` via `isGitRootForTrust`
  (directory or file accepted; **symlinked `.git` rejected outright** —
  documented stricter subset of the official `nXc`, which validates symlink
  targets before following; a rejected symlink only means "no boundary at
  this level", it can never place a misplaced boundary).
- `computeTrustDialogAccepted`: after the existing fast paths (sandboxed /
  non-interactive / session trust / persisted project-path entry), the
  previously UNBOUNDED ancestor walk is now bounded by the enclosing git
  repo root: `walkAncestorsForTrust(config, resolvedCwd, boundary)` returns
  false the moment the walk steps outside the repo root, and stops AT the
  root — trust accepted for a parent directory no longer leaks into a
  nested repository.
- `isPathTrusted(dir, opts)`: canonical persist-key fast path via
  `findCanonicalGitRoot`, then the same bounded walk; new
  `advisoryNoFsProbe` option performs the walk with NO filesystem probe and
  no boundary (advisory availability checks, port of official `v8e`'s
  dual mode).
- Tests: `nestedRepoTrust232.test.ts` (6 tests against REAL tmpdir `.git`
  dirs: nested repo does not inherit; same-repo child still does; nested
  repo's own trust entry works; non-git keeps the unbounded walk; symlinked
  `.git` is not a boundary; advisory no-fs-probe ignores boundaries) +
  existing `trust.test.ts` stays green.

### 3.C Bash `< file` input-redirect permission checks — `src/tools/BashTool/pathValidation.ts`

- `checkPathConstraints` now validates input redirections when AST redirects
  are available (the production path — `bashToolHasPermission` passes
  `astCommand?.redirects` at all three call sites), mirroring the official
  loop: skip non-`<` ops and `< /dev/null`; every other `< target` goes
  through `validatePath(target, cwd, ctx, 'read')`.
- Deny-rule decisions surface as `deny` ("Input redirection from '<path>'
  was blocked by a deny rule."); scope failures surface as `ask` with the
  official message ("…may only read files in the allowed working
  directories for this session.") and a Read-rule suggestion, matching the
  output-redirect builder's structure.
- Output-redirect behavior is untouched (still create-mode).
- Tests: `inputRedirectPermission232.test.ts` (7 tests: inside-workdir
  passthrough, outside ask, deny-rule deny, `/dev/null` passthrough,
  `<<`/`<<<`/`<&` passthrough, output redirects unaffected, suggestion
  shape).

### 3.D `sandbox.ripgrep` source-scope restriction — `src/utils/sandbox/sandbox-adapter.ts`

- `convertToSandboxRuntimeConfig` no longer reads `sandbox.ripgrep` from the
  merged settings (which include project/local). It now consults
  `getSettingsForSource` for `policySettings` → `flagSettings` →
  `userSettings` in order (first defined wins), falling back to the bundled
  `ripgrepCommand()` — byte-equivalent to the official `rTt` scope. A
  malicious project's `.claude/settings.json` can no longer point the
  sandbox's search binary at an arbitrary executable. Security-positive.
- Tests: `sandboxRipgrepScope232.test.ts` (4 tests: project/local override
  ignored → bundled fallback; user honored; flag beats user; policy beats
  both).

## 4. Staged items (per-item rationale)

| # | Entry | Rationale |
|---|-------|-----------|
| 1 | `glab` CLI config store gets `gh`-style sandbox + credential-path protection | OCC has no host machinery for per-CLI credential-path protection (the `gh` host surface itself is absent); porting would mean inventing the host layer — forbidden. |
| 2 | Subagent forking default-on (`subagent_type: "fork"`, background non-teammate spawns) | Behind `FORK_SUBAGENT`, not in OCC's 6-flag allowlist. Enabling needs the full hang-smoke cycle (`aligning-with-official-binary` lesson: flag-enable without `occ -p` hang test is how the KAIROS 5-min loop shipped). Staged until a dedicated flag-enable round. |
| 3 | PowerShell `$PSDefaultParameterValues` permission bypass | Fix site not byte-isolated in the ELF (PowerShell AST rewriting surface); OCC targets the bash path. Needs dedicated decompilation. |
| 4 | MCP 30s probe-timeout hang fix | Fix site not string-identifiable in the ELF; OCC's MCP connect path would need per-site decompilation before porting. |
| 5 | mTLS client-cert rotation auto-reload | Transport-layer fix; site not byte-isolated. Staged (lineage carried with the transport items). |
| 6 | Malformed AWS/Vertex region fallback | Provider-edge fix; OCC's Bedrock/Vertex surface is minimal and the fix site is not byte-isolated. |
| 7 | Stream idle-timeout recovery (Bedrock/Vertex/gateway) | Staged since OCC-46 (same lineage): recovery interacts with provider stream internals not byte-isolated in the ELF. |
| 8 | Overlay truncated-text render fix (one column too wide / start-truncated ellipsis) | Ink render internals; fix site not byte-isolated. Cosmetic; staged. |
| 9 | Mid-emoji garbled char in truncated previews | Same class as #8 — render truncation internals. Staged. |
| 10 | Fullscreen streaming normalization (no whole-conversation re-normalize) | Performance rework of the streaming render path; not byte-isolated. Staged. |
| 11 | Agent panel updates (completed subagents hide, overflow indicator) | UI polish; not byte-isolated. Staged. |
| 12 | Usage-limit guidance in SDK/remote sessions | Suggests commands OCC trims; the guidance source is not byte-isolated. Staged. |
| 13 | Managed-settings approval dialog improvements (endpoint URLs, telemetry wording, sandbox binary override approvals) | The `sandbox.ripgrep` SECURITY half is covered by port 3.D (source-scope); the approval-dialog UI half is a managed-settings surface OCC trims. Staged. |
| 14 | `/feedback` / `/bug` open immediately mid-response | Command-launch timing fix; site not byte-isolated. Staged. |
| 15 | Clipboard images read without blocking the event loop | OCC's clipboard path differs (trimmed paste surface); site not byte-isolated. Staged. |
| 16 | Shortened resume message for completed background agents | OCC background-agent resume messaging is daemon-supervisor specific; the official string change does not map 1:1. Staged. |
| 17 | `/update` / `/tui` restart refusal while relaunch-surviving work runs | Restart-guard fix site not byte-isolated. Staged. |
| 18 | Fable 5 advisor offering + `--advisor fable` consent message | Advisor offering list tied to org/Fable access and the `/advisor` model table; needs dedicated per-site decompilation. Staged. |
| 19 | Hardened Linux filesystem sandbox against a protected-path bypass | The fix lives in the `@anthropic-ai/sandbox-runtime` package (0.0.44 → 0.0.73), not in CLI source. OCC pins 0.0.44; the dependency bump is staged pending a sandbox-runtime compatibility round (the package's config schema changed between versions — e.g. fields OCC's adapter must adopt atomically). |

## 5. Verification

- New unit tests: 32 (7 input-redirect + 15 GitLab scanner + 6 nested-trust
  + 4 ripgrep scope) — all green.
- Touched-area regression: `trust.test.ts` + `bashSecurityCatchup.test.ts`
  green after the changes.
- Full src suite: `bun test src` — **1930 pass / 0 fail / 4524 expect() /
  206 files** (baseline entering the round: 1898 pass / 0 fail / 4480
  expect / 202 files).
- Curated e2e subset (house gate): occ-versioning + commands-alignment +
  five `version-2.1.219-*` + resume-interrupted-turn-221 — **56 pass / 0
  fail / 194 expect()**.
- Build green (`dist/cli.js` 28.89 MB via `bun run build`); Biome check on
  the 9 touched/new files: 0 findings.
- Live smoke: `timeout 30 bun dist/cli.js -p "say hi"` → exit 0 with model
  reply; tmux REPL boot → model round-trip ("say PONG exactly once" →
  `PONG`) → `/status` shows `Version: 2.1.300` → clean `/exit`.

## 6. Tracked-upstream pointer

OCC is fully caught up through **2.1.231** plus the portable byte-verified
subset of **2.1.232** (ports A–D above). The staged set (§4) remains
backlog for future rounds, each gated on per-site decompilation per the
`aligning-with-official-binary` skill.
