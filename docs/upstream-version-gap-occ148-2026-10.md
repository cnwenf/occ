# Upstream Version Gap — OCC-148 (2026-10-07 round)

**Round:** OCC-148 · **Date:** 2026-10-07
**Tracked official before round:** Claude Code `2.1.289` (OCC release `2.1.370`)
**Official latest this round:** Claude Code `2.1.291` (npm `latest`, published 2026-10-06T03:32Z); `next` = `2.1.292` (published 2026-10-06T17:10Z — next-channel staging, triaged for the NEXT round, not ported here)
**OCC release target:** `2.1.372`

Verification method: `npm view @anthropic-ai/claude-code` dist-tags + GitHub
releases + fresh official linux-x64 ELF/JS payloads for `2.1.290`/`2.1.291`
(`/root/cc-diff-291/scratch-session/js29{0,1}.bin`, 42,532,864 bytes each) and
the `2.1.289` ELF (`/root/cc-diff-291/x2.1.289/package/claude`, 246,107,320
bytes). **No official binary was ever executed** — byte-read only, per the
`aligning-with-official-binary` skill. Changelog source: the package's own
`CHANGELOG.md` (`docs/gap-research-291/changelog-entries-290.txt`, 191 entries).

---

## §0 — Parallel-round reconciliation (READ FIRST)

Mid-session, `origin/main` advanced `5ab0d1e → 21d0477`: the **OCC-109 round**
merged its own 2.1.290+2.1.291 alignment (`5801585`, 92 files / +14,546 lines;
release record `f2f7bf6` bumped package.json to `2.1.371` — **untagged**,
"release gated on acceptance"; `21d0477` test fixup) plus its ledger
`docs/upstream-version-gap-occ109-2026-10.md` and cluster docs
`docs/gap-research-291/cluster-{a..h}-*.md`.

This round therefore reconciled instead of double-landing:

1. **Dropped as duplicates** (independently implemented here first, then found
   landed on main — main's versions verified byte-faithful before dropping):
   - **#145 pyright read-only-registry removal** — main's
     `pyrightNotReadOnly290.test.ts` + registry comment carry the same
     forensics (incl. the "copyright contains the substring pyright" grep
     false-positive correction). This round's copy: 11 tests, discarded.
   - **#150 `ps` flag-safety rewrite** — main's ps entry
     (`respectsDoubleDash:!1` + the four-condition
     `additionalCommandIsDangerousCallback`) is logically identical to this
     round's port (its module-level `isWellFormedFlagToken` ≡ official `Cze`
     ≡ OCC's exported `FLAG_PATTERN` `/^-[a-zA-Z0-9_-]/`; official safeFlags
     byte-identical 289↔290). Both rounds independently found the same
     pre-existing OCC defense making `ps --sort=-pcpu` false regardless
     (validateFlags string-value dash rejection, git `--sort` exception only).
2. **Kept as this round's unique landings** — the two gaps OCC-109 explicitly
   left open (§1, §2 below).

OCC-109's cluster-a doc records the hasUnquotedGlob gap as still STAGED
(`docs/gap-research-291/cluster-a-bash-permissions.md:89/98/343` —
"`hasUnquotedGlob` 字段缺失仍是 v288 #72 的 STAGED 项"), and main's `ast.ts`
carried the matching STAGED notes ("OCC's SimpleCommand has no hasUnquotedGlob
field — porting it needs extractor plumbing beyond #72's message-alignment
scope"). §1 closes exactly that.

---

## §1 — LANDED: awk/find unquoted-glob gates + producer machinery (CC 2.1.289/2.1.290; closes v288 #72 STAGED)

**Files:** `src/utils/bash/ast.ts` (+531 lines merged over OCC-109's own
ast.ts changes — clean auto-merge, both ports coexist),
`src/tools/BashTool/pathValidation.ts` (comment: argvUnquotedGlob
intentionally not threaded into the path validator — matches official, the
record feeds the semantic gates only),
`src/tools/BashTool/__tests__/bashPromptPlainLanguage288.test.ts` (fixture
gains `hasUnquotedGlob: false`), NEW
`src/tools/BashTool/__tests__/unquotedGlobGates290.test.ts`
(**34 tests / 105 expect(), all green** — against the merged tree).

Official mechanisms ported verbatim from the 2.1.290 bash-security module:

| Official | Port | Role |
|---|---|---|
| `T()`/`I()` | `hasUnquotedGlobChars` | quote-aware whole-text unquoted-glob scanner (`*`, `?`, `[`) → `SimpleCommand.hasUnquotedGlob` (2.1.289 producer; set at **every** SimpleCommand construction site: word-command, pipeline element, declaration/test/unset collectCommands sites) |
| `St`/`V()` | `RESOLVED_ARG_GLOB_RE` + `resolvedArgHasGlob` | resolved-arg glob matcher `/[*?]|\[[^\]]*\]/` |
| `me()` | `GLOB_NODE_CHARS` + `nodeMayContainUnquotedGlob` | per-node-type check (word/number raw scan; string/raw_string/simple_expansion/arithmetic_expansion false; concatenation any-child; default true) |
| `Kt` | argv-walk in `walkCommand` | per-arg `argvUnquotedGlob` record: word-like nodes `I(u.text)\|\|me(u)`, bare `$VAR` always true |
| `gt`/`N` | `CMD_SUB_QUOTE_DESYNC_RE` + `quoteScanCarveOuts` counter | cat-heredoc carve-out → `carveOutMayDesyncQuoteScan` when the substitution text contains `"` / backtick / backslash |
| `kAn()` | `commandHasResolvableUnquotedGlob` | consumer combining record + desync flag + `__CMDSUB_OUTPUT__` placeholders |
| `Hor` first branches | awk-family + find gates | `o.hasUnquotedGlob \|\| r && kAn(o)` with byte-identical reason strings |
| find block (NEW in 290) | per-arg glob check + action/version-divergent/runtime-determined branches | the action/version/runtime branches existed in official 2.1.289 but were never ported to OCC (the v288 #72 STAGED note understated the gap); the per-arg resolved-value check is new in 2.1.290 |
| find constants | 11 action flags (`nn`), `an=/^-[dsx]+f$/`, `sn=/^-newer[aBcm][aBcmt]$/`, 44 named value options | byte-verified |
| `tengu_warm_sunrise` | `findFlagIsAction` `-rm` gate via `getFeatureValue_CACHED_MAY_BE_STALE<unknown>('tengu_warm_sunrise', true)` | default-on, remote-disable only — matches official |
| `checkSemantics(e,t?)` | `checkSemantics(commands, options?: { sourceGlobRecord?: boolean })` | official `r=t?.sourceGlobRecord!==!1` honored (synthetic test covers the `false` path) |

Reason strings are byte-identical to the official 2.1.290 binary (em-dash
included), e.g. `awk command contains unquoted glob characters — could
glob-expand to a planted program or flag before awk runs`; `find contains
unquoted glob characters — could glob-expand to a dangerous action before find
runs`; `find with '${f}' executes commands or modifies files — cannot be
auto-allowed by a Bash(find:*) prefix rule`; `find option '${f}' is read
differently by different versions of find — could hide a following action`;
`find argument is runtime-determined — could resolve to a dangerous action`;
`find argument '${f}' contains glob characters — could glob-expand to a
dangerous action`.

Known faithful quirks (documented in the test file, not "fixed" — never
invent): `[ -f file.txt ]` reports `hasUnquotedGlob: true` (the literal `[`
operator is an unquoted glob char to the whole-text scanner `I(e.text)`;
harmless — test_command never reaches the awk/find gates); the
redirects-only SimpleCommand push site intentionally lacks
`carveOutMayDesyncQuoteScan` (matches official @40997/@41886).

**Security posture:** strictly fail-closed additions — previously auto-allowed
`awk`/`find` prefix-rule matches with unquoted globs (plantable program /
smuggled action via glob expansion) now go to ask. No official cap/fallback
invented; no relaxation.

## §2 — LANDED: #161 `CLAUDE_CODE_DISABLE_ATTACHMENTS` project-scope block (CC 2.1.290)

> "Changed CLAUDE_CODE_DISABLE_ATTACHMENTS so a repository's
> .claude/settings.json or .claude/settings.local.json can no longer set it;
> shell, user and managed settings still can."

**Byte-forensics (289 vs 290/291 A/B, sets recovered verbatim):**
- 2.1.289 reserved-env set `sZn` (@205191667 region):
  `...,"CLAUDE_CODE_SYNC_SKILLS","CLAUDE_CODE_SYNC_PLUGINS","CLAUDE_CODE_TRANSCRIPT_LOCAL_GC","CLAUDE_CODE_CCR_SURFACE","CLAUDE_CODE_TETHER_LIVE",...`
  — NO `CLAUDE_CODE_DISABLE_ATTACHMENTS`. All 8 occurrences of the string in
  the 289 ELF are live consumers (env re-export @199874621, deferred-tools
  gate `AN()` @206734244, telemetry @208974391/@209053530, main-loop
  attachment gate @210931211, plugin manifests @233186321/@233193287).
- 2.1.290 set `mir` (@5736663 region) inserts
  `"CLAUDE_CODE_RELAUNCH_PROACTIVITY_{BASELINE,DECIDED,EVER_ON,LEVEL}","CLAUDE_CODE_DISABLE_PROACTIVITY","CLAUDE_CODE_DISABLE_ATTACHMENTS"`
  between `"CLAUDE_CODE_CCR_SURFACE"` and `"CLAUDE_CODE_TETHER_LIVE"` (+
  `"CLAUDE_CODE_REMOTE_TOOLS_HOST_ALLOWS_UNATTENDED"` after
  `..._PIN_STORED_LOGIN`). 2.1.291 identical (@5759460 region).
- The other new members gate official-only dormant surfaces (proactivity /
  remote-tools / tether) OCC does not ship; `DISABLE_ATTACHMENTS` has a live
  OCC consumer (`src/utils/attachments.ts:848`
  `isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS)`), so only it is
  ported (minimal faithful #161).

**Port:** one key added to `PROJECT_SCOPE_BLOCKED_ENV_KEYS`
(`src/utils/managedEnv.ts`) — the existing 2.1.251 blocklist machinery
(`filterProjectScopeBlockedKeys`, once-per-key diagnostic warning, official
keep-condition `if(!j(E)||Vcn(E,e[E],r))continue`) does the rest. Blocklist
115 → **116** keys. NEW `src/utils/__tests__/projectScopeDisableAttachments290.test.ts`
(**6 tests**: blocklist membership; project blocked; local blocked; user
allowed; policy allowed; real shell env untouched by a conflicting project
value). Existing `projectScopeEnvBlocklist251.test.ts` count assertion updated
(12 pass), `projectTelemetryEnv282.test.ts` unaffected (20 pass).

**Security posture:** strictly fail-closed (a repo can no longer silently
disable attachments — context-smuggling defense parity with official).

## §3 — 2.1.290/2.1.291 triage disposition (this round's view)

The 191-entry 2.1.290 changelog was triaged into clusters
(`/root/cc-diff-291/cluster_{S,A,B,C}.txt`; security cluster = 31 items:
#012 #013 #024 #025 #026 #046 #048 #050 #053 #054 #055 #056 #066 #070 #075
#078 #080 #081 #086 #092 #105 #106 #113 #115 #117 #118 #127 #145 #148 #150
#161 #163). Per-item disposition after reconciliation with OCC-109:

- **Landed by OCC-109** (see its ledger + cluster docs): #054 declare-prefix
  (`declarationPrefix290.test.ts`), #145 pyright, #150 ps, the read-deny /
  image / @-mention guard family, plan-mode classifier floor, plan-mode
  resume, chunked normalize, display escaping, markdown stack guard, session
  durability (F-A/C/E/F), queued-rewind, apiPreconnect essential-traffic
  gate, etc.
- **Landed by OCC-148 (this round)**: §1 (awk/find unquoted-glob machinery —
  the STAGED remainder of the v288 #72 / cluster-a plumbing) and §2 (#161).
- **Verified NO-GAP here** (OCC already stricter or structurally immune):
  #148's *prompt-surface* twins (the official 2.1.290 prompt-text changes
  @17349687/@17364731 — OCC has neither prompt surface; N/A), and cluster A
  #1/#6 per OCC-109's triage.

## §4 — STAGED (deferred, with rationale — never invented)

- **#018 WebFetch 100k reader + `offset`** — "Fixed WebFetch silently dropping
  page text past 100,000 characters; it now says how much was unread and takes
  an `offset` to read on." Real OCC gap confirmed this round
  (`src/tools/WebFetchTool/` has no `offset`; silent truncation). Deferred:
  needs a dedicated port of the official reader/normalizer path + tool-schema
  change + prompt-surface text; byte-forensics not completed this round.
  **Top candidate for the next round.**
- **#148 skills/custom-commands `!` raw-control-char refusal** — OCC surface
  exists (`src/utils/promptShellExecution.ts`, BLOCK_PATTERN/INLINE_PATTERN).
  This round's binary hunt located the importer-region sanitizers and the
  cloud-sync control-class `$e=/[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|[^\P{Cc}\t\n\r]|\r(?!\n)/u`
  (@22639641) but did NOT isolate the runtime bang-refusal site/message in
  the 290 bundle; porting without the verbatim message + char-class would be
  inventing → STAGED per skill discipline.
- OCC-109's own STAGED list (its ledger §5) stands unchanged (cluster C
  managed-link-walk, D #2–#7, E #8/#9, F B/K/L, G #8/P2, H 46 NEEDS-REVIEW).

## §5 — 2.1.292 (next channel, published 2026-10-06T17:10Z) — next-round triage

~90 changelog entries captured. Security highlights for the next round's top
priority: PreToolUse hook UNC-path bypass; seed-admin staged copies;
notebook/PDF symlink-swap; `rm -rf` Windows 8.3 short-name evasion; NO_PROXY
ignored; MCP tool name >128 chars truncation collision. Feature surface:
Agent tool `effort` param, `--marketplace`, and others. Full triage deferred
to the next gap round (2.1.292 is `next`-channel, not `latest`).

## §6 — Verification & release

### 6.1 Tests (this round's tree = origin/main 21d0477 + §1/§2 changes)

| Run | Result |
|---|---|
| `unquotedGlobGates290.test.ts` | **34 pass / 105 expect()** |
| `projectScopeDisableAttachments290.test.ts` | **6 pass** |
| `projectScopeEnvBlocklist251.test.ts` (count 115→116) | 12 pass |
| `projectTelemetryEnv282.test.ts` | 20 pass |
| main's 290 suites (`declarationPrefix290` + `psFlags290` + `pyrightNotReadOnly290`) | 40 pass |
| `bashPromptPlainLanguage288.test.ts` | 25 pass / 262 expect() |
| `src/utils/bash/` (incl. main's `zshDifferentialVar290`) | 23 pass |
| all `src/tools/BashTool/` | **974 pass / 0 fail / 47 files** |
| Biome lint (all changed files) | clean |
| `bun run build` | green — `dist/cli.js` 29.89 MB |
| full CI gate (`scripts/ci-test.sh`) + e2e (tmux REPL, `-p` smoke) | see §6.2/§6.3 (appended below) |

### 6.2 E2E

*(filled in after the e2e run — tmux REPL boot, model round-trip, quit
message; `occ -p` headless PONG; version string.)*

### 6.3 Release

- Version: package.json `2.1.371 → 2.1.372` (2.1.371 was consumed by
  OCC-109's untagged release-record commit; this release SHIPS the OCC-109
  content plus §1/§2 — no tag `v2.1.371` will ever exist, and the
  releases↔tags parity check stays clean because parity is over existing
  tags).
- CHANGELOG: new `## 2.1.372 - 2026-10-07` section above OCC-109's
  `## 2.1.371` section.
- **Carry-over (owner action, re-verified today by OCC-109 §6 and still
  open):** repo secret `NPM_TOKEN` is invalid (npm `@cnwenf/occ` latest =
  2.1.367; v2.1.368–370 Publish runs all failed `E404 … PUT
  https://registry.npmjs.org/@cnwenf%2focc`). `publish.yml`'s
  `Create GitHub Release` step is `if: success()` — gated behind npm publish
  — so with the dead token the tag push will NOT auto-create the Release.
  Precedent (v2.1.368–370): the GitHub Release is created manually
  (`gh release create v2.1.372 --generate-notes`) to keep /tags ≡ /releases,
  and the npm publish stays pending until the owner rotates `NPM_TOKEN` and
  re-runs the Publish workflow **for the newest tag only**.
