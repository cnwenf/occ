# Upstream Version Gap — OCC-65 (2.1.223 → 2.1.224)

**Round:** OCC-65, 2026-08-08
**OCC entering state:** `2.1.296` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.223** per OCC-58, PR #265)
**Official target:** `2.1.224` — verified three ways: npm `@anthropic-ai/claude-code` latest = 2.1.224, GitHub release `v2.1.224`, fresh linux-x64 ELF download (295,676,936 bytes; strings dump shows `2.1.224` markers, zero `2.1.225+`).

Method per `aligning-with-official-binary`: `npm pack @anthropic-ai/claude-code-linux-x64@2.1.224` + `@2.1.223`, full `strings` dumps (`/tmp/s224.txt`, `/tmp/s223.txt`), sorted set-diffs (`comm`), targeted `grep -aoP` PCRE extraction of the minified functions named below. Every "LANDED" claim below carries the binary function it was recovered from.

---

## 1. Landed this round (binary-verified ports)

### Gap-65-A — Removal of the 200-subagent total-spawn cap

2.1.224 changelog: *"Removed the 200-subagent-per-session spawn cap; long-running sessions no longer refuse new agents (concurrency and depth limits still apply)"*.

**Binary evidence (2.1.224 ELF):**
- The 2.1.212-era getter `function getMaxSubagentsPerSession(){return env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION ?? 200 }` and its spawn-site assert are **gone** from the 224 binary (no `MAX_SUBAGENTS_PER_SESSION` getter remains; the name survives only in the env-var allowlist arrays).
- The **concurrency** cap remains: `function j6u(){return ee.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? t6y}` with `t6y=20` (byte-identical to 2.1.223).
- The **depth** cap (default 3) and the **WebSearch** cap (`200`) remain unchanged in 224.

**OCC port:** `assertSubagentCapAndIncrement()` and `getMaxSubagentsPerSession()` in `src/utils/sessionLimits.ts` removed along with all three spawn-site call sites (`src/tools/AgentTool/runAgent.ts`, `src/tools/shared/spawnMultiAgent.ts`, `src/tasks/LocalMainSessionTask.ts`). `claimConcurrentSubagentSlot` (concurrency 20), `getMaxSubagentSpawnDepth` (depth 3) and the WebSearch cap are untouched — verified still present in the 224 binary. The `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` env var becomes a no-op (official parity: name still in the env allowlist, no getter consumes it). Tests updated to assert the cap is gone and the concurrency cap still throws.

### Gap-65-B — Cross-project session-directory verification (`gar` port)

2.1.224 changelog: *"Fixed long (>200 char) project paths resolving to another project's session directory under a shared sanitized prefix; session list, rename, fork, delete and `/resume` no longer cross projects"*.

**Binary evidence (2.1.224 ELF) — recovered verbatim:**
- `fXi(name)` = `name.replace(/[^a-zA-Z0-9]/g,"-")` (sanitizer; unchanged), `EJ = 200` (max sanitized length; unchanged).
- New in 224: `truncatedPrefix` in the listing loop: `a=o.map(d=>{let p=Gw(d),f=...;return{path:d,exactName:f,truncatedPrefix:p.length>EJ?f.slice(0,EJ):void 0}})` sorted longest-first.
- Match condition is now content-verified: `p===m || (h!==void 0 && p.startsWith(h+"-") && await gar(join(i,d.name),f,s))`, and the second loop `(k!==void 0 ? T.startsWith(k+"-") && await gar(...) : x.length<EJ && T.startsWith(x+"-"))`. 2.1.223 matched prefix-only with **no** verification (confirmed absent from the 223 dump).
- `gar(dir, cwd, caseInsensitive)` — reads every `*.jsonl` in the candidate dir (`har` = first-N + last-N bytes head/tail reader), extracts the `relocated`/`relocatedCwd` tail marker or the `"cwd":` head value (`ndt`/`loo` scanners), sanitizes it (`fXi`), and returns true only if it equals the requested cwd's sanitized form. `bp` = identity.
- Hash suffix: official 224 **always** uses djb2 — `hut`: `t=(t<<5)-t+charCode|0`, suffix `Math.abs(hut(e)).toString(36)`.

**OCC port:**
1. `findProjectDir()` prefix fallback in `src/utils/sessionStoragePortable.ts` now content-verifies candidate directories with an exact `gar` port (`dirMatchesProjectPath`: scans `*.jsonl` head/tail via `extractLastTypedLineField` (`ndt` port) / `extractFirstLineField` (`loo` port`) for `relocated`/`relocatedCwd`/`cwd`, sanitizes, compares; case-insensitive flag carried through like the official `s` flag). The listing path (`listSessionsImpl` + both worktree-scan sites in `sessionStorage.ts`) applies the official `truncatedPrefix` longest-first matching with the same content verification and the >200-char truncation guard.
2. `sanitizePath()` hash aligned to the official always-djb2 suffix (`Math.abs(djb2(name)).toString(36)`) — OCC previously used `Bun.hash` (wyhash) on Bun, which produces different directory names than the official for >200-char paths. Paths ≤200 chars are unaffected (no suffix). Existing >200-char session dirs with the old suffix remain discoverable: they share the 200-char prefix and pass the new content verification.

### Gap-65-C — `ANTHROPIC_BEDROCK_REGION_PREFIX` + region-derived prefix + prefix-preferred profile selection (+ `jp`/`au`/`us-gov` prefix carryover)

2.1.224 changelog: *"Added `ANTHROPIC_BEDROCK_REGION_PREFIX` env var for Bedrock to prefer a specific cross-region inference profile over the `AWS_REGION`-derived one"*.

**Binary evidence (2.1.224 ELF) — recovered verbatim:**
```js
hsr=["us","eu","apac","jp","au","us-gov","global"]          // recognition list
function Upt(e){let t=e??"";if(t.startsWith("us-gov-"))return"us-gov";
  if(t.startsWith("us-"))return"us";if(t.startsWith("eu-"))return"eu";
  if(t.startsWith("ap-"))return"apac";return"global"}       // region → derived prefix
function eur(e){if(e?.startsWith("us-gov-"))return"us-gov";
  return ee.ANTHROPIC_BEDROCK_REGION_PREFIX??Upt(e)}        // env override wins (us-gov forced)
function Fpt(e,t,r){if(r){let n=e.find(o=>o.startsWith(`${r}.`)&&o.includes(t));
  if(n)return n}return e.find(n=>n.includes(t))??null}      // prefix-preferred profile pick
function Lnp(e,t,r){let n=Hc[e],o=Fpt(t,n.firstParty,r);
  if(o)return o;if(!n.bedrock)return null;return Bpt(n.bedrock,r)}  // fallback: prefix hardcoded ID
// Koy(): warns when env≠derived and discovery unavailable, and when
// models resolved to a different prefix ("This is a preference, not a residency guarantee.")
```
`Bpt` = prefix apply (byte-equivalent to OCC's existing `applyBedrockRegionPrefix`); `ypo` = prefix recognition (byte-equivalent to OCC's `getBedrockRegionPrefix` but over the 7-entry `hsr` list).

**Carryover discovered:** the 7-entry list (`jp`, `au`, `us-gov` added) is already present in the **2.1.223** binary — OCC's 4-entry `BEDROCK_REGION_PREFIXES` (`['us','eu','apac','global']`) lagged. Closed here together with the 224 env var. The `cdc=["us","eu","apac","jp","au","global"]` list (no `us-gov`) is the recognition-minus-gov variant.

**OCC port:** `src/utils/model/bedrock.ts`:
- `BEDROCK_REGION_PREFIXES` extended to the 7-entry `hsr` list (`jp`, `au`, `us-gov` added); new `BEDROCK_REGION_PREFIX_ENV_VALUES` = the 6-entry `cdc` list (no `us-gov`) used to validate the env var — an invalid value (incl. `us-gov`) is treated as unset, matching the official zod env layer.
- `deriveBedrockRegionPrefixFromRegion()` = `Upt` port (us-gov- checked before us-).
- `getEffectiveBedrockRegionPrefix()` = `eur` port — us-gov region forces `us-gov` **before** the env var is consulted; otherwise validated `ANTHROPIC_BEDROCK_REGION_PREFIX` wins over the derived prefix.
- `findFirstMatch()` upgraded to the `Fpt` port (optional `preferredPrefix` arg: prefer `<prefix>.<needle>` profiles, fall back to any substring match).

`src/utils/model/modelStrings.ts`:
- `getBedrockModelStrings()` rewritten as the `Koy` port: effective vs derived prefix, prefix applied to hardcoded fallback strings (`applyRegionPrefixToModelStrings` = per-entry `Bpt`, `KZr`-style), the two official warnings byte-verbatim (`logForDebugging` warn level): (1) env≠derived + discovery unavailable → "applied without an availability check … fall back to <derived>.*", (2) models resolving to a different prefix → "This is a preference, not a residency guarantee."
- `getModelStrings()` interim (Bedrock fetch in flight) now also applies the effective prefix to the builtin defaults — `TUe`/`KZr` parity (verified in the 224 binary: `TUe()` returns `KZr(provider)` on the interim path).
- `Lnp` (fallback resolver for `[bedrock-fallback]` unpinned tiers) determined **N/A**: its only caller is the unpinned-tiers subsystem, which OCC does not have (zero grep hits).

---

## 2. Verified N/A for OCC (no portable surface / already-parity)

| # | 2.1.224 item | Verdict |
|---|---|---|
| Bash description unconditional line | OCC ships the "given/simple" Bash prompt builder (`getSimplePrompt`), which is **byte-identical 223↔224** in the binary and never carried that line; the changed builder is the full variant OCC does not use | N/A (verified) |
| Sandbox trailing-slash deny bypass | OCC's config pipeline normalizes every entry: `resolveSandboxFilesystemPath → expandPath → path.normalize()` strips trailing slashes, so the bypassable config shape (`denyRead: "~/.aws/"`) cannot reach enforcement; runtime matching lives in the pinned `@anthropic-ai/sandbox-runtime@0.0.44`. Fix site not localizable in the binary | Mitigated at config layer; runtime parity rides on the pinned dependency |
| Managed-settings approval prompt no longer re-appears | OCC has no managed-settings **approval-prompt** flow (grep: only unrelated "approved" strings in version-gate/MCP-autoserve contexts) | N/A (surface absent) |
| Feedback survey transcript-share fixes (2 items) | OCC's feedback survey has no transcript-share upload path (analytics trimmed to empty implementations) | N/A |
| Plugin install-record corruption fix | OCC plugin surface trimmed (no install records across projects) | N/A |
| [VSCode] ×2 | OCC ships no VS Code extension | N/A |

## 3. Staged (need per-site decompilation, dormant subsystems, or dependency bumps — not guessed per `aligning-with-official-binary`)

| # | 2.1.224 item | Reason |
|---|---|---|
| `claude self-hosted-runner` (self-hosted environments) | New 49-hit subsystem (runner registration/tunneling for Team/Enterprise); needs dedicated decompilation round |
| `archive` plugin source | OCC plugin surface trimmed; `--plugin-url` already does zip-over-HTTPS (SHA-256 pinning would be an addition without the surrounding record machinery) |
| Paste cancel-and-confirm, paste-recall fix, placeholder renumber (3 items) | Paste subsystem; per-site decompilation |
| Sandbox credential-masking options (`extract`/`jwt`/`maskClaims`/`awsPairs`/`sigv4`) | Requires `network.tlsTerminate` proxy subsystem; deep port |
| Cross-session SendMessage/ListAgents + `crossSessionInbound`/`dialogExpiry` + send-failure reporting | `KAIROS`-flagged (dormant in OCC build; re-enabling hangs — documented) |
| Sandbox violation details in Bash results | OCC already wires `annotateStderrWithSandboxFailures` into BashTool results; detail level is whatever pinned `sandbox-runtime@0.0.44` emits. Full parity = dependency bump (0.0.44 → 0.0.70 class), separate round |
| MCP tools connected mid-turn not announced | Tool-search announcement site not localized; decompilation |
| Wayland copy-on-select race | OCC has `useCopyOnSelect`; the two-write race fix needs per-site decompilation |
| Remote Control items (cold-start creds, blank `(no content)` after `/clear`, history re-upload, compaction progress visibility, persistent failure indicator, stale-session archive, resume re-connect) | OCC bridge/Remote-Control surface exists but each fix is a distinct decompilation site |
| Fullscreen pre-compaction scrollback across repeated compactions | Fullscreen/scrollback UI subsystem; decompilation |

## 4. Self-acceptance (verification record)

Per `behavior-driven-done` (behavioral e2e, not source-grep; full `bun test` green before tag):

- **Unit tests:** 3 new/updated suites — Gap-65-A (`sessionLimits`/`taskRegistry`/`subagentCap`/`ctxOverflowRetry` updates, 53 pass), Gap-65-B (`sessionStoragePortable.test.ts`, 25 tests / 34 expect), Gap-65-C (`bedrockRegionPrefix.test.ts`, 20 tests / 34 expect, incl. the `Koy` flow with a mocked inference-profile fetch). Full src suite: **1844 pass / 0 fail / 4357 expect() across 198 files**; model dir 46 pass / 96 expect.
- **Lint:** `biome lint` exit 0 (one pre-existing info-level finding untouched).
- **Build + smoke:** `bun run build` green (`dist/cli.js` 28.87 MB, `OCC 2.1.296`); `occ -p "say PONG"` → `PONG`.
- **E2e (chunked, real model endpoint where applicable):** version/command-alignment chunk 61 pass; model chunk (`version-2.1.94-bedrock-mantle-flags`, `version-2.1.197-models`, `version-2.1.200-model`, `version-2.1.160-fast-mode-default`) 37 pass / 0 fail; session chunk (`real-coding`, `cleanupPeriodDays-zero`, `disk-error-log`) green.
- **REPL (tmux):** boot + logo/What's-new render + model round-trip (`say REPLPONG` → `REPLPONG`) + `/exit` all green in this sandbox.
- **Environmental, not regressions (git-stash A/B verified — identical failures with and without this round's changes):**
  - `version-2.1.221-autocompact.e2e.test.ts` 3 real-model fails: bun-test 5000ms timeout vs ~9.2s real round-trip latency in this sandbox right now (manual `--autocompact 500k -p` returns `OCC_OK`); OCC-58 doc has precedent ("环境性偶发…不阻塞").
  - `resume-command-name.e2e.test.ts` PTY stall: `script`-based interactive PTY times out at boot on baseline too (OCC-11 sandbox-stall class); replaced by the tmux REPL round-trip above.
- One deliberate mock-semantics fix in the Gap-65-C suite: `model-defaults-207.test.ts` fires `void updateBedrockModelStrings()` (real ~2s AWS fetch) into the shared sequential queue; the Gap-65-C flow describe drains it (`await ensureModelStringsInitialized()` + `resetStateForTests()`) in `beforeEach` so cross-file state can't pollute assertions.
