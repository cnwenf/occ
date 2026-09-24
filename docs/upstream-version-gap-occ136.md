# Upstream Version Gap — OCC-136 round (occ136)

Round: **2.1.280 → 2.1.281 alignment** (2026-09-25). Ledger: this file. Prior-round
pre-triage source: `docs/upstream-version-gap-occ135.md` §5/§5b (S1–S6 + "35 new env
markers" — both re-verified from scratch this round; the env-marker count did **not**
survive exact re-verification, see §7).

Branch: `agent/occ/136-align-2.1.281` (base `62252aa`, the 2.1.351 merge).
Commits: `d9eb7ac` (S1 port) + `16a19c4` (P2 NUL-byte rule guard).

## §1 Version facts (three-way verified, 2026-09-25)

| Fact | Value | Verification |
|------|-------|--------------|
| npm dist-tags | `stable`=2.1.273, **`latest`=2.1.281**, `next`=2.1.282 | `npm view @anthropic-ai/claude-code dist-tags` |
| Publish times (UTC) | 280: 2026-09-22T15:44Z · 281: 2026-09-23T17:01Z · 282: 2026-09-24T15:56Z | `npm view ... time --json` |
| v2.1.281 linux-x64 md5 | `d00df59384be94d0b5cac74849540075` (237,375,560 B) | **matches taskbook** ✓ |
| v2.1.280 linux-x64 | 233,709,640 B | fresh `npm pack` + extract |
| v2.1.282 linux-x64 md5 | `54435b7ed06ae1ef9417edda38256c15` (238,767,288 B) | fresh `npm pack` + extract |
| 2.1.281 changelog | 176 bullets under `## 2.1.281` | GitHub raw CHANGELOG.md |
| v2.1.281 GitHub release | exists, full notes | `gh release view` |
| v2.1.282 GitHub release | **now exists** (2026-09-24T18:38:05Z, marked Latest, ~90-bullet notes) | `gh release view v2.1.282` |
| String diff 280→281 | +19,520 new / −15,537 removed (sorted-unique, `strings -n 8`) | `comm` on s280/s281 |
| String diff 281→282 | +19,850 new | `comm` on s281/s282 |

**Fact change vs. the taskbook:** the taskbook said 2.1.282 had "no GitHub release".
It now does (published ~2.7 h after the npm publish, marked Latest on the repo).
npm `latest` nonetheless remains **2.1.281**, so per the stable/latest channel-tracking
rule this round's alignment target stays 2.1.281 and 2.1.282 remains **triage + STAGE
only, 0 PORTS** (§9) — promoted to the port target next round when `latest` moves.

**Promotion condition for porting S1:** satisfied — 2.1.281 is `latest` **with**
published changelog entries (the occ135 rule: never port from a `next`-only version).

## §2 Method

1. Fresh `npm pack` of `@anthropic-ai/claude-code-linux-x64` 280/281/282; md5 + size
   checked against the taskbook value before any diffing.
2. `strings -n 8 | sort -u` per binary; `comm -13/-23` for new/removed sets;
   `grep -aboF "$S" binary | wc -l` for exact occurrence counts (marker stability
   checks); `dd bs=1 skip=OFFSET count=N` for byte-level context extraction.
3. S1 recovered as pretty-printed decompilation of the whole dangerous-rm region
   from both v280 and v281 (`s1_full_280.pretty.js` / `s1_full_281.pretty.js`), then
   identifier-by-identifier mapping to the OCC port (`gFt`/`jy`/`Rp`/`aFt`/`uEo`/
   `FMe`/`nTo`/`oTo`/`Zw`/`Zvo`).
4. Env-marker claims from occ135 §5b re-verified with **exact-name occurrence counts**
   in all three sorted-strings dumps (strings extraction carries suffix noise — every
   candidate was counted 280→281→282 before being called "new").
5. All 176 changelog bullets read and triaged (§8); all ~90 v2.1.282 release-note
   bullets read and triaged (§9).
6. Forensic artifacts kept in a scratch dir during the round and deleted at task end
   (skill resource-safety rule).

## §3 S1 — dangerous-rm substitution-target guard: **PORTED** (commit `d9eb7ac`)

The 2.1.281 flagship security fix: *"Fixed a recursive `rm` whose target is only
command-substitution output, such as `rm -rf "$(pwd)"`, running unprompted in auto and
`--dangerously-skip-permissions` mode; it now asks even with a Bash allow rule, unless
run with `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT=1`."*

### §3.1 Official forensics (v2.1.281 ELF, byte-verified)

- Pipeline `gFt`: normalize substitutions → walk argv per command segment → classify.
  - Normalization: backticks → `$(…)` (one pass); `/\$\([^()]*\)/g` → `__CMDSUB__`
    fixpoint ≤16; `${VAR:-…}` default-value collapse fixpoint ≤16.
  - argv chain (NEW in 281): basename strip (`/^.*[\\/]/`) → `$e = aFt(Rp(De))`
    (safe-wrapper strip `Rp`: time/nohup/timeout/nice/stdbuf/env/command/builtin/
    noglob; then privilege/env-assignment strip `aFt` via `fEo`/`pEo`/`mEo` maps incl.
    `sudo -u root --`, `doas`, `pkexec`, `setsid`, `taskset`, `chrt`, `ionice`,
    `strace/ltrace -o`, `watch -n`, `unshare`, `nsenter -t`, `exec -a`, `flock --`,
    `env -S/--split-string` with cmdString recursion) → verb via `Zw` (`Zvo` =
    Set["rm","rmdir","tee"]).
  - Verdict kinds: `wholeSubstitution` (recursive flag before first `--` via
    `/^--r/` or `/^-[a-zA-Z]*[rR]/`, target matches `/^(?:__CMDSUB__[/*.]*)+$/`),
    `literalTarget`, `emptyExpansion` (tail regex
    `/.(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+(?:\/\.\.)*\/*$/` stripped, residual checked
    via tilde-expanded `isDangerousRemovalPath`), `emptyVariable`,
    `tooManySubstitutions`.
  - Gates on wholeSubstitution only: `!env.CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT`
    (bare truthiness) **and** GrowthBook `tengu_iridescent_boot` (default **true**;
    official condition `!(value===false && source==="payload")`).
  - Ask builder `jy`: `classifierApprovable:!1, circuitBreaker:"dangerousRemoval"`.
  - Telemetry: `tengu_bash_dangerous_rm_too_complex` {category,kind,mode} +
    conditional `tengu_bash_dangerous_rm_shape` {shape}.
  - Deny/ask message + reason strings extracted byte-exact (see §3.2).

### §3.2 OCC implementation

- `src/tools/BashTool/destructiveCommandWarning.ts` (+627): `normalizeCommandSubstitutions`,
  `findSubstitutionTargetBlock` (the `gFt` walker: quote-aware tokenizer with
  backslash escapes and unbalanced-quote fail-closed consumption; `skipTimeoutArgs`/
  `skipStdbufArgsLocal`/`skipEnvArgsLocal` = `FMe`/`nTo`/`oTo`; `stripSafeWrapperArgv`
  = `Rp`; `stripTimeFamilyArgv` = `uEo`; `stripPrivilegeWrapperArgv` = `aFt` incl.
  `--`+positional, separate/`=`/glued command-flag forms and `env -S "<cmd>"`
  recursion; `resolveDestructiveVerb` = `Zw`; `DESTRUCTIVE_VERB_SET` = `Zvo`),
  kind taxonomy wired into `findCatastrophicSubstitutionBlock`
  (`tooManySubstitutions`, `emptyVariable`+shape `var_root_child`, `literalTarget`),
  and byte-exact official strings:
  - `WHOLE_SUBSTITUTION_MESSAGE` = "Dangerous rm operation detected: the target is the
    output of a command substitution (`$(...)` or backticks) and cannot be checked
    before the command runs. This requires explicit approval and cannot be
    auto-allowed by permission rules.\n\nRun the substitution on its own first, then
    remove the literal paths it prints."
  - `WHOLE_SUBSTITUTION_REASON` = "Dangerous rm operation on statically-unresolvable
    target: command substitution output"
- `src/tools/BashTool/bashPermissions.ts` (+16/−2): guard call after
  `analyzeText`; telemetry `tengu_bash_dangerous_rm_too_complex` +
  `tengu_bash_dangerous_rm_shape`; deny with the official message (no
  `Destructive command blocked:` envelope for the new verdicts; pre-existing verdicts
  keep theirs).
- Env gate: `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` read as
  `Boolean(process.env.X)` — OCC's standard truthiness convention ("0" disables the
  guard; "" does not). Feature gate: `getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_iridescent_boot', true)`.

### §3.3 Deliberate divergences (documented, security-positive or platform-forced)

1. **Deny-in-all-modes instead of ask+circuitBreaker.** Official asks (with
   `classifierApprovable:!1` + `dangerousRemoval` circuit breaker); OCC denies
   outright in every mode including `bypassPermissions`. OCC has no persistent
   approval dialog for headless/deny paths; deny is strictly stronger. The official
   message text is preserved verbatim so users get the same rewrite hint.
2. **String-level tokenizer instead of tree-sitter WASM.** OCC's runtime has no
   tree-sitter WASM available (`parseCommandRaw` → null; the same constraint
   documented in occ46 §A). The quote-aware tokenizer compensates and fails closed
   on unbalanced quotes. **Honest scope of "fails closed" (per acceptance finding
   F-3):** that phrase covers the unbalanced-quote case ONLY — as originally
   ported, the AST-less compensation had two fail-OPEN blind spots (brace-group
   compounds and quote-concatenated verbs) that the doc did not disclose. Both
   were found by acceptance e2e probing, are fixed, and are fully documented in
   §3.6.
3. **Leading shell-syntax skip** — control-flow keywords (`then`/`do`/`else`/`elif`/
   `!`/`if`/`while`/`until`/`for`/`select`/`case`) AND standalone structural group
   tokens (`{`/`(`/`}`/`)`) are stripped from token 0 both before AND after wrapper
   resolution — the AST-less compensation for brace groups, subshells, and control
   flow (`{ rm -rf $(pwd); }`, `if { rm …; }; then …` must all still hit the guard).
   Glued openers (`{rm`) are NOT stripped: bash requires whitespace after the `{`
   reserved word, and the official AST likewise treats `{rm` as a plain command name.
   See §3.6 for the acceptance-round fix that added the structural-token half.
4. **Quote-aware verb word gate** (`passesRmVerbGate`) — the `/\brm(?:dir)?\b/`
   prefilter tests both the raw text and a quote/backslash-stripped projection, so
   bash quote-concatenated verbs (`r'm'`/`r"m"`/`r\m` → `rm`) reach the tokenizer
   instead of false-negativing on the raw text. The official has no raw-text prefilter
   (tree-sitter parses every command), so this restores official reach; it is strictly
   stronger than a raw-text gate and cannot create false denies (the per-segment
   resolved-verb check stays authoritative). See §3.6.
5. **No GrowthBook `source` discrimination.** OCC's cached feature-value API exposes
   no `source` field, so an explicit `false` from ANY override layer disables the
   wholeSub verdict (official: only `source==="payload"`). Fail-open only under an
   explicit operator opt-out — same escape-hatch semantics as the env gate.
6. **Backslash-escaped `\$(pwd)` blocks (fail-closed false positive).** Bash would
   treat `\$(pwd)` as literal text; OCC's normalization produces `\__CMDSUB__` and
   the tokenizer's escape consumption leaves a `__CMDSUB__` token → wholeSubstitution
   deny. Accepted: deny-posture over precision, covered by an explicit test.
7. **`tengu_bash_dangerous_rm_shape` emits only `var_root_child`** from OCC's
   pre-existing regex detector (`CATASTROPHIC_VAR_PATH_TARGET_RE`); the official
   shape vocabulary from the full variable-dataflow classifier is not ported (see
   §3.5).

### §3.4 Tests + coverage

- New: `substitutionTargetGuard281.test.ts` (519 lines) + `substitutionTargetGuard281.gateoff.test.ts`.
- 154 tests across the S1 surface (incl. the pre-existing `subshellRm273` suite):
  normalization (5), wholeSubstitution 33 positives (incl. the taskbook attack
  `rm -rf "$(pwd)"`, wrapper chains, quotes, keyword prefixes, and `;`/`&&`
  concatenation) + 13 negatives, wrapper-strip/tokenizer branches (27 positives incl. `timeout -- 5`,
  `nice -5`, `builtin --`, `noglob`, `doas`, `pkexec`, `setsid`, `taskset -c 0`,
  `chrt -f 10`, `ionice -c3`, `strace -o`, `watch -n 1`, `unshare`, `nsenter -t 1`,
  `exec -a name`, `command -p`, `flock -- /tmp/l`, `sudo nice -n 5`, `sudo nohup --`,
  `env -S ""`, `env --split-string=`, `env -S" "`, `env -S "sudo rm -rf $(pwd)"`,
  `sudo -u root --`; 7 negatives incl. `timeout -- rm` fail-closed, `command -v`
  bail, `env -Srm $(pwd)`), emptyExpansion (6), env gate (3), kind taxonomy (3),
  `bashToolHasPermission` integration (5: byte-exact deny message in default mode,
  deny under bypassPermissions, emptyExpansion deny in bypass, old verdicts keep the
  envelope, `Bash(rm:*)` allow-rule cannot auto-allow), gate-off (2), **plus the
  acceptance-round F-1/F-2 regression suite (§3.6): 25 unit positives/negatives +
  8 integration (4 attack forms × default/bypassPermissions)**.
- **Honest correction (acceptance round, per F-4):** the ORIGINAL §3.4 wording
  claimed the "33 positives" covered "compound commands." That was overstated. The
  33 wholeSubstitution positives exercised `;`/`&&` concatenation and keyword
  prefixes only — they had **ZERO** brace-group (`{ rm …; }`), **ZERO** brace-in-
  control-flow (`if { rm …; }; then`), and **ZERO** quote-split-verb (`r'm'`) cases.
  Those two shapes were genuine open bypasses (F-1/F-2), not covered until §3.6.
- **Coverage caveat (honest, per F-4):** the previously-quoted **98.2% S1 line
  coverage did NOT protect against F-1/F-2.** Line coverage counts a line as hit if
  ANY input reaches it; the verb-resolution loop body was fully "covered" by the
  flat `rm -rf $(pwd)` positives while the brace-group and quote-split inputs took
  the same lines and silently returned null. Adversarial path coverage (does a
  hostile shape actually DENY?) is orthogonal to line coverage and is what §3.6 adds.
  A green 98.2% was necessary but not sufficient — the acceptance e2e probe, not the
  coverage number, is what caught the bypasses.
- Full BashTool suite at acceptance-fix time: **666 pass / 0 fail (35 files)**; build passes.
- Test-isolation note (cost a debug cycle, recorded for future rounds): **bun test
  runs all files in ONE process** — the gateoff file's `USER_TYPE=ant` +
  `CLAUDE_INTERNAL_FC_OVERRIDES` env pair must be set in `beforeAll` (never module
  top level, which leaks into sibling files) and `resetGrowthBook()` must run both
  before and after (clears the `envOverridesParsed` latch).

### §3.5 Known approximation gaps (staged, not silently diverged)

- `rm -rf $HOME$(x)` → null in OCC: the official walks variable dataflow
  (`tIe`/`Joe`) to combine a variable prefix with substitution output; OCC has no
  variable-value tracking. STAGE.
- The full official `literalTarget` shape classifier (x$ forms etc.) is not ported;
  OCC keeps its pre-existing regex detector for that kind. STAGE.
- occ135 §5b guessed the codename `bright_lake` gated the dangerous-rm dialog; this
  round's byte-level forensics established the wholeSubstitution gate is
  **`tengu_iridescent_boot`** (default true). `bright_lake` remains an unlinked
  codename-experiment marker (S5 churn) — corrected here per the taskbook's
  "re-verify precisely" instruction.
- **Quoted-verb forms of the OLD (#41) variable-path guard remain literal-text
  based.** `findCatastrophicRmInCommand` (the `$UNSET/*` var-path shape) keeps its
  raw-text `/\brm(?:dir)?\b/` gate and its `CATASTROPHIC_RM_COMMAND_RE` verb anchor,
  so `r'm' -rf "$UNSET/*"` (quote-split verb + variable-path target, NO command
  substitution) still passes that specific detector. This matches the official
  raw-text detector's own limitation (byte-exact port fidelity), and the S1
  substitution pipeline — the attack surface probed in acceptance — is closed for
  quoted verbs (§3.6). Closing the var-path×quoted-verb combination would require
  reworking the byte-exact #41 port around the tokenizer; deliberately NOT done
  this round to avoid regressing its single-quoted-literal-target semantics
  (`'$UNSET/*'` must stay skipped as a literal). Disclosed, staged.

### §3.6 Acceptance-round security fix — F-1 brace groups, F-2 quote-split verbs

E2E acceptance (OCC 验收员, `hasPermissionsToUseTool` probe on the built dist)
found **two P1 bypasses of the S1 guard as originally ported** — both fail-OPEN
(default mode → ask, `bypassPermissions` → auto-allow, i.e. unattended execution),
contradicting §3.3 item 1's "denies in ALL modes … bypass-immune" promise. Both are
fixed on this branch; the original port shipped them silently, and the original
§3.3/§3.4 did not disclose them (corrected above per F-3/F-4).

- **F-1 — brace-group compound `{ rm -rf "$(pwd)"; }`.** Root cause: the
  shell-quote-based splitter emits `(` as its own segment (so `(rm …)` worked) but
  glues `{` into the inner segment's head (`["{ rm -rf __CMDSUB__", "}"]`); the
  verb-resolution skip set contained only `then/do/else/elif/!`, so token 0 stayed
  `{`, the resolved verb was `{`, and both guards returned null. The official
  tree-sitter AST nests brace groups structurally and analyzes the inner `simple`
  command — a real parity gap, not a documentation difference. **Fix:**
  `stripLeadingShellSyntax` drops standalone structural tokens (`{`/`(`/`}`/`)`)
  and the full control-keyword set (`if`/`while`/`until`/`for`/`select`/`case`
  added) in a fixpoint loop, applied BOTH before and after wrapper stripping (so
  `sudo { rm …; }` and `{ sudo rm …; }` both resolve). Glued `{rm` is deliberately
  NOT stripped — bash requires whitespace after the `{` reserved word, and the
  official AST agrees `{rm` is a plain (nonexistent) command name, so stripping it
  would invent a false positive.
- **F-2 — quote-split verb `r'm' -rf "$(pwd)"`.** Root cause: the
  `/\brm(?:dir)?\b/` word gate ran on untokenized raw text; bash concatenates
  `r'm'`/`r"m"`/`r\m` to `rm` at execution (verified: `r'm' --version` → GNU rm),
  but the regex sees no literal `rm` → early null in every mode. **Fix:**
  `passesRmVerbGate` additionally tests a quote/backslash-stripped projection of
  the text. The projection is monotonic (removal can only fuse characters into
  new matches, never destroy one) so the gate can no longer false-negative;
  over-approximation is harmless because the quote-aware tokenizer's
  resolved-verb check remains the source of truth. Applied at BOTH raw-text gates
  on the substitution path: `findSubstitutionTargetBlock`'s entry gate and the
  `tooManySubstitutions` early-return gate (>64 substitutions), which would
  otherwise skip the whole analysis for a quoted verb. The old #41 detector's gate
  is intentionally unchanged (see §3.5 residual).
- **Regression tests (reviewer-specified forms + extensions):** unit level — all
  20 positives assert `wholeSubstitution` via both `findCatastrophicSubstitutionBlock`
  and `findSubstitutionTargetBlock` (`{ rm -rf $(pwd); }`, `{ rm -rf "$(pwd)"; }`,
  `{ rm -rf $(pwd) }`, `if { rm …; }; then …`, `if true; then { rm …; }; fi`,
  `while … do { rm …; }; done`, `for … do { rm …; }; done`, `else { rm …; }`,
  `case … { rm …; } … esac`, `sudo { rm …; }`, `{ sudo rm …; }`,
  `{ env FOO=1 rm …; }`, `{ /usr/bin/rm …; }`, `( { rm …; } )`, `r'm' -rf "$(pwd)"`,
  `r"m" -rf $(pwd)`, `r\m -rf $(pwd)`, `'rm' -rf $(pwd)`, `"rm" -rf $(pwd)`,
  `{ r"m" -rf $(pwd); }`); 5 false-positive negatives (`echo { rm -rf $(pwd); }`
  — brace not in command position —, `{ echo $(pwd); }`, `{ ls -la $(pwd); }`,
  `{ cat $(pwd); }`, `echo r'm' $(pwd)`). Integration level — the reviewer's 4
  required forms × {`default`, `bypassPermissions`} assert `behavior: 'deny'` +
  the byte-exact official message (bypass-immune, per the reviewer's demand that
  BOTH modes deny).
- **Verification:** `bun test src/tools/BashTool/__tests__` → 666 pass / 0 fail
  (35 files); `bun run build` → passes; pre-fix RED evidence reproduced at unit
  level first (both forms returned null through both guards), post-fix GREEN
  across all 20 attack forms with 0/10 false positives on the safe-form control set.

## §4 P2 — NUL-byte permission rule guard: **PORTED** (commit `16a19c4`)

Changelog: *"Fixed a permission rule containing a NUL byte being expanded into a
wildcard match; such a rule now matches nothing."*

- Official exposure: NUL in a rule expanded into a wildcard match. OCC exposure
  differs but is real: `matchWildcardPattern` (`src/utils/permissions/shellRuleMatching.ts`)
  uses NUL-delimited sentinels (`\x00ESCAPED_STAR\x00`, `\x00ESCAPED_BACKSLASH\x00`)
  to protect `\*`/`\\` escapes. A rule smuggling a raw sentinel survived the escape
  passes and was reinterpreted during placeholder restoration — `Bash(make\x00ESCAPED_STAR\x00 *)`
  compiled to regex `^make\* .*$` and matched `make* deploy` (a wildcard expansion
  the rule text never expressed).
- Port: fail-closed guard at the top of the shared matcher — any pattern containing
  `\x00` matches nothing. One choke point covers all seven consumers (Bash,
  PowerShell, FileEdit/Read/Write, Grep, Glob). Exact/prefix rules are structurally
  immune (plain string equality/`startsWith` cannot expand a NUL into a wildcard).
- Tests: `nulByteRuleGuard281.test.ts` — 8 tests (baseline non-NUL matching intact,
  raw-NUL rules dead in both case modes, smuggled STAR/BACKSLASH sentinels dead,
  NUL at start/middle/end, plus a `bashToolHasPermission` integration pair: smuggled
  allow rule cannot auto-allow; honest `Bash(make *)` still allows).
- Suite status after the port: 932 pass / 1 skip / 2 fail across 61 files — the 2
  fails are the timing-sensitive `shellWiring042` foreground-task tests, A/B-verified
  as parallel-load flakiness unrelated to this change (they pass 3/3 standalone both
  with and without the change; the stashed baseline batch fails even more, 6).
- Also in this commit: `biome-ignore lint/complexity/useRegexLiterals` on
  `CATASTROPHIC_VAR_PATH_TARGET_RE` — the autofix was observed corrupting the
  `new RegExp` form into a broken regex literal this round (the `\\/` hazard from
  occ136 forensics); the suppression prevents a recurrence.

## §5 P3 — null-byte file paths in Read/Write/Edit/NotebookEdit: **NO-OP (structural parity)**

Changelog: *"a file path containing a null byte now fails that tool call with a clear
error instead of ending the whole turn."*

OCC already satisfies the contract structurally: `runToolUse`
(`src/services/tools/toolExecution.ts:400`) catches every tool-call exception and
converts it to an `is_error: true` `<tool_use_error>` tool_result — the turn never
ends. Bun/Node `fs` throws `ERR_INVALID_ARG_VALUE` on NUL-bearing paths, so the
official failure mode ("ending the whole turn") does not exist in OCC; only the
error-message polish ("a clear error") differs. NO-OP with this rationale; no code
change.

## §6 S2–S6 verdicts (occ135 §5b ledger, re-verified this round)

| Item | Verdict | Reason |
|------|---------|--------|
| **S2** auto-mode safety-dialog auto-deny/cap (`autoDenyWindow` 0→20 hits, `maxDialogTimeouts`, `tengu_safety_check_dialog_capped`/`_auto_denied`, `denialLimitFallback` 23→25) | **STAGE** | Confirmed 0 OCC surface hits: OCC's auto-mode safety path has no persistent dialog to cap; the associated `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT` (official: 2-min ask-dialog wait, then auto-deny with rewrite hint, config `gee={enabled:!0,showDialog:!0,timeoutMs:120000,maxDialogTimeouts:3}`, bounds 5000/3600000/100) is meaningless against OCC's deny-without-dialog posture (§3.3.1). Env name documented for parity; behavior not wired. |
| **S3** MCP Apps host (`CLAUDE_CODE_MCP_APPS_HOST===!0` 0→10 hits, `offer:io.modelcontextprotocol/ui`, `text/html;profile=mcp-app`) | **STAGE** | New official subsystem (host-rendered MCP UI resources). No OCC surface; adopting it is a feature decision, not a catch-up. Related 281 changelog items (resource lists skipping Apps UI, elicitation URL-mode) inherit this verdict. |
| **S4** "14 genuinely-new env vars" | **CORRECTED → 13** | Exact-name recount (§7): `CLAUDE_CODE_MCP_QUESTION_GRACE_MS` is a false positive (0→0→0). The 13 real ones are individually dispositioned in §7. |
| **S5** telemetry churn (~60 events, ~20 codename experiments incl. `bright_lake`, `iridescent_boot`, `velvet_panda`) | **NO-OP** (except `tengu_iridescent_boot`, ported inside S1) | OCC's analytics layer is an intentional stub; event names are emitted for parity where a ported feature needs them (S1's two events) and ignored otherwise. `bright_lake` decoupled from S1 — see §3.5 correction. |
| **S6** stable-marker registry drift (slash-command registry byte-identical 100→100; only genuine reduction `CLAUDE_CODE_REPL\b` 4→1) | **NO-OP** | Re-verified: no command-surface change to track; the REPL marker reduction is internal string churn with no behavioral reading. |

## §7 Env-marker re-verification: "35 new" dissolved → **13 genuine-new in v281**

Every occ135 §5b candidate was recounted with exact full names in the sorted-strings
dumps of all three binaries. 22 of the 35 dissolved: strings-extraction noise suffixes
(e.g. `…TASKSG`, `…EFFORTE`, `…MCPH`) and pre-existing vars whose counts never moved
(`INLINE_TOOLS` 4→4, `EXPERIMENTAL_OBSERVER_AGENTS` 3→3, `MARKETPLACE_NAME` 2→2,
`PLUGIN_USE_ZIP_CACHE` 3→3, `SUBAGENT_CACHE_EVICT` 3→3, `MAX_TOOL_USE_CONCURRENCY`
4→4, `TOTAL_TOKENS_REMINDER_BUDGET` 5→5, …). One candidate was a pure false positive:
`CLAUDE_CODE_MCP_QUESTION_GRACE_MS` = **0→0→0** (absent from all three binaries).

Genuine-new v281 (occurrence counts 280→281→282):

| Env var | 280→281→282 | Disposition |
|---------|-------------|-------------|
| `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` | 0→5→6 | **PORTED** (S1 gate, §3) |
| `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT` | 0→5→6 | **STAGE** (S2 dialog-timeout; no OCC surface — §6 S2) |
| `CLAUDE_CODE_MCP_APPS_HOST` | 0→10→? | **STAGE** (S3 MCP Apps host) |
| `CLAUDE_CODE_HOST_GATEWAY_LINEAGE` | 0→14→? | **NO-OP** (Claude apps gateway lineage; OCC ships no gateway) |
| `CLAUDE_BG_WORKSPACE_TRUSTED` | 0→12→? | **STAGE** (bg-session workspace trust; OCC `--bg` redirects to the daemon supervisor — the trust-first-launch fix has no direct OCC path, but the marker belongs to a trust surface OCC may grow) |
| `CLAUDE_RELAUNCH_SESSION_ADD_DIRS` | 0→8→? | **STAGE** (relaunch flow carrying `--add-dir`; OCC relaunch paths differ — verify before porting) |
| `CLAUDE_CODE_DISABLE_STARTUP_WORK_GATE` | 0→3→? | **STAGE** (internal startup work-gate kill switch; no behavior to port without the gate) |
| `CLAUDE_CODE_COMMIT_BETWEEN_KEYS` | 0→4→? | **STAGE** (commit UX debounce knob; cosmetic) |
| `CLAUDE_CODE_CCR_EARLY_REMOTE_CONNECT` | 0→5→? | **NO-OP** (Claude Code Remote early-connect; no OCC surface) |
| `CLAUDE_CODE_ARTIFACT_INHERITED_TYPE_GRANT` | 0→2→? | **NO-OP** (Artifact tool; no OCC surface) |
| `CLAUDE_CODE_ARTIFACT_TEXT_VARIANT` | 0→3→? | **NO-OP** (Artifact tool) |
| `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS` | 0→3→? | **STAGE** (Agent SDK surface; OCC's SDK entrypoints exist but manifest handling differs — verify) |
| `CLAUDE_CODE_COORDINATOR_SKILL_GUIDANCE` | 0→3→? | **NO-OP** (`COORDINATOR_MODE` flag is off in OCC's build — dead surface) |

## §8 Changelog triage — all 176 bullets of 2.1.281

Verdicts: **PORT** (landed this round) / **PARTIAL** (landed inside another port) /
**STAGE** (real OCC surface or plausible one; needs per-site forensics — deferred
with reason) / **NO-OP** (no OCC surface by design). Groups keep bullet order; each
bullet carries its verdict.

### §8.1 Gateway / Desktop / cloud / RC / Slack product surfaces — NO-OP (26)

All Claude-apps-gateway items (desktop policy blocks `blockReadsOutsideWorkingDirectories`/
`disableBypassPermissionsMode`; Bedrock `assume_role` via STS; Bedrock `guardrail:{id,version}`;
`telemetry.resource_attributes`; `envHelper` `\??\`/`/??/` start refusal), all
`[VSCode]` ×6, all `[Claude Code on the web]` ×6, all `[Claude Tag]` ×13 (Slack
product), `[Code Review]` ×1 (cloud review product), Remote-Control items (stale
overlapped prompt; org-policy "disabled" retry wording; Artifact tool in RC
sessions; attachment download reuse), cloud-session items (bg agents before worker
restart; scheduled routine/notification turn-start notices; scheduled-task & `/loop`
delivery-failure refire; self-hosted-runner `--system-prompt-file`), Artifact items
(footer pill; unpkg.com script allowlist; artifact-design skill prose), `/deep-research`
scope-step reliability (OCC ships zero bundled workflows by design — CLAUDE.md
OCC-31), macOS credential-write keychain-locked drop (OCC's MCP OAuth is simplified;
no keychain write path of this shape): **NO-OP** — subsystems OCC does not ship.

### §8.2 Security & permissions cluster

| Bullet | Verdict | Reason |
|--------|---------|--------|
| Recursive rm on substitution output runs unprompted (`rm -rf "$(pwd)"`) | **PORT** ✓ | S1, §3 |
| Permission rule with NUL byte expanded into wildcard | **PORT** ✓ | P2, §4 |
| Read/Write/Edit/NotebookEdit null-byte path ends the turn | **NO-OP** | P3 structural parity, §5 |
| Dangerous-rm check also flags variable+top-level-dir / cwd-derived variable / backslash-only target | **PARTIAL** | The variable-root case is covered by S1's `emptyVariable` kind (`var_root_child` shape); the full dataflow classifier (`tIe`/`Joe`) and backslash-only-target form stay STAGE (§3.5) |
| Dangerous-rm prompt waits 2 min in bypass/auto then denies with rewrite hint (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT=1`) | **STAGE** | OCC denies without a dialog (§3.3.1) — timeout has no surface; name documented (§6 S2) |
| Permission dialogs / attachment checks reading macOS `/.vol`/`/.nofollow`/`/.resolve` before approval | **STAGE** | macOS-specific pre-approval path-read; OCC permission path does not pre-read target paths for dialogs — verify per-site before deciding NO-OP |
| Sandbox `excludedCommands` not matching `git rev-parse --git-dir`, builtin-named programs, `[WIP]`/`#` commit messages | **STAGE** | OCC has the sandbox settings surface; matcher fix needs the official exclusion-matcher forensics |
| Sandboxed Bash can't write `$TMPDIR` when `CLAUDE_CODE_TMPDIR` set | **STAGE** | OCC has `CLAUDE_CODE_TMPDIR` (tmpDirBackstop/managedEnv); sandbox-runtime interaction to verify |
| `claude --bg` starts bg session + project hooks before workspace trust | **NO-OP** | OCC `--bg` prints a redirect to the daemon supervisor and exits (CLAUDE.md OCC-21) — no pre-trust launch path |
| `--setting-sources` not forwarded to spawned sessions (teammates, `/bg`, agents sessions, `--worktree --tmux`) | **STAGE** | OCC has the flag (`main.tsx:507`); forwarding to spawned contexts needs per-spawn-site verification |
| Write refusing duplicate-parameter-name calls with identical values | **STAGE** | Small input-validation improvement; candidate next round |
| CLAUDE.md + rules from `--add-dir` inside cwd sent twice (headless/SDK) | **STAGE** | OCC headless context assembly differs; dedup check needed |
| `/permissions` `1` answering Yes while pointer on No (held-key workspace-dir removal) | **STAGE** | Real dialog-safety hazard; OCC's `/permissions` confirm key handling to verify per-site |
| `/plugin` held `y` adding marketplace before the question can be read | **STAGE** | Same held-key class; OCC plugin dialogs to verify |
| Auto mode: server-side classifier now also reviews read-only/sandboxed shell | **NO-OP** | OCC has no server-side classifier (local-only auto mode) |
| `CLAUDE_CODE_AUTO_MODE_SERVER` applies to direct API connection | **NO-OP** | Same |
| Auto-mode denial message reads as covering the outcome, not the exact command | **STAGE** | Classifier prompt/UX wording; OCC auto-mode denial text to compare |
| Auto-mode classifier reuses earlier prompt cache after resume | **STAGE** | Perf; OCC classifier caching to verify |
| `mcp_tool` hooks on blocking events wait for a connecting server (up to MCP connect timeout) | **STAGE** | OCC hook+MCP surfaces exist; wait semantics to verify |
| Same MCP server connected twice on URL spelling differences (case/port/trailing slash) | **STAGE** | OCC has connector+configured-server coexistence; URL canonicalization dedup is a portable candidate |
| `MCP_CONNECTION_NONBLOCKING=0` honors `MCP_CONNECT_TIMEOUT_MS` instead of 1s | **STAGE** | Small timeout-plumbing fix; verify OCC's nonblocking-connect path |
| `claude plugin validate` MCP checks (dropped `.mcp.json` entries, undeclared `${user_config.*}`, insecure URLs) | **STAGE** | Portable validation addition; OCC plugin surface is live (marketplaceManager) — candidate next round |
| `--channels` entry must match installed plugin's name too | **STAGE** | Plugin channel matching; per-site |
| `known_marketplaces.json` false "refreshed" on unreachable remote + keep-on-failure | **STAGE** | Marketplace manager bookkeeping; per-site |

### §8.3 Session / stream / transport reliability cluster — STAGE (17)

Each is a real reliability fix with plausible OCC applicability, but every one needs
dedicated binary forensics against OCC's `claude.ts`/`query.ts`/resume paths — too
large in aggregate for this round, and none is security-gated. Deferred as a ranked
set (next-round P1 candidates marked ★):

- ★ turn retrying indefinitely ignoring `--max-turns` (unparseable tool calls × output-limit alternation)
- ★ tool calls running twice on duplicated stream events + proxy-cut responses shown complete with no warning
- ★ `CLAUDE_CODE_RETRY_WATCHDOG` failing on first 5xx after 429/529 waits; uncapped silent `Retry-After` sleep
- ★ `--input-format stream-json` sessions failing every turn after a plain-string-content assistant message
- ★ crash ("unrecoverable interface error") ending a session during API retry
- stop reason lost on trailing usage-only proxy frame
- "Content block not found" on proxy-dropped mid-response event (partial kept; web-search results kept)
- empty completed response requested twice on pre-final-event disconnect
- fast mode back-to-back retries on `Retry-After: 0`
- resumed sessions re-sending earlier turns changed (parallel tool-call turn / MCP input / tool-search result) → API drops prior reasoning
- very large session resume restoring only last few messages
- resume after restart during pending permission prompt → different history → broken prompt cache
- resume ending during a tool call → Claude sees the call, outcome unknown; no hidden "Continue"
- advisor-result history repair (once) for sessions the API can no longer read
- prompt cache lost on mid-conversation MCP disconnect / reconnecting server with tool search off
- oversized-image tool result leaving siblings unanswered / turn ending with no final message
- conversation stuck on `tool_use.name` >200 chars; "Failed to get memory usage" fd-exhaustion false failures; non-interactive session surviving cwd deletion; SDK-MCP handshake stall (few-seconds cap)

### §8.4 Startup / performance cluster — STAGE (7)

Interactive startup not waiting on managed-settings fetch (~80 ms; 17 s unreachable);
git reads/startup telemetry/Bedrock-Vertex upgrade checks moved after first frame;
managed-settings/policy no-retry-on-never-succeed; resume-long-sessions file-cache
fidelity; resume-compacted-session speed; "Prompt is too long" single-large-first-
prompt summarization; PDF >3 MB two-minute read delay + interrupted page-render
leak. All plausible OCC wins, each needs its own site work.

### §8.5 UI / dialog / input / lists cluster — STAGE (≈45)

Alt+T thinking-toggle on incapable models; `/context` total drift; `/model` raw API
error JSON; HTML-error-page markup/status rendering; feedback/bug/share cancel-still-
sends ×2; `/ide` false "none detected"; `/setup-bedrock|vertex` restart terminal
state; `/config` crash on `null` values; `/rename` name during multiple-choice;
one-line paste rendering; queued-message IDE selection; Shift+Tab double-press wrong
mode; Ctrl+C/D double-press quitting in remaining dialogs; burst-input stale
selection (effort/model picker/skills/bg rows/MCP prompts/install-github-app);
`/install-github-app` ×3; accent-key cursor off-by-one; screen-reader blank line;
numeric-bullet list rendering; agent-panel footer hints/rebinds/stray `·`; agent
panel "Enter to view"/"x to stop" on the viewed agent; mouse-click cursor desync; Esc
interrupt-vs-deselect; PgUp/PgDn in fullscreen dialog lists; `/heapdump` summary
wording; `/workflows` pointer move + `x` stop on new run; `NO_COLOR` tab highlight;
`/plugin` wheel scroll-through; lingering hover highlight; long-row `…` truncation;
`/hooks`+`/mcp` detail overflow; screen-reader number answers; queued messages above
spinner; fullscreen hover tint; `/mcp` row layout; `/workflows` row layout;
`uninstall --json` data-kept wording; `/tasks` `x` confirm on `/ultrareview`;
leftover "(removed)" `/agents` entry; tabbed-dialog ↑/↓ focus; `/help`+`/sandbox`
←/→/Tab; standard dialog frames + double-press cancel ×4 prompts; `/workflows`+`/mcp`
paging/j/k/mouse; `/plugin`+`/remote-control` Home/End/click; bg workflow row
progress; `/plugin` Installed columns; `/skills` row layout; narrow-list 20-col rule;
`/diff` scrollbar; `/hooks` detail kind/source wording; `/mcp` screen-reader "off";
`/insights` auto-mode recommendation; fullscreen scrollbars on `/skills`/`/mcp`/
`/plugin`; send-now (ctrl+enter) moving running tools to background; `--agents` JSON
file path + empty prompt; `/batch` under WorktreeCreate hooks; claude.ai-synced skill
short names ×1; large-CLAUDE.md notice counting instruction files together; debug-log
naming for ignored settings `env` vars.
Reason (uniform): OCC's Ink UI shares the component families but every fix is
render/interaction-site-specific; batch-verified UI triage is a dedicated round.
Two hygiene items singled out as next-round candidates: **Bash edit-diff snapshot
temp-dir pileup cleanup** (abandoned dirs deleted immediately + on exit — real disk
hygiene, likely directly applicable) and **send-now backgrounding semantics**.

### §8.6 Windows — STAGE (2)

`$TMPDIR` write "Permission denied"; concurrent-update `claude.exe` backup-deletion
race. Per occ44/occ46 precedent Windows-only items stage rather than NO-OP (OCC does
run on Windows via WSL); both need a Windows verification rig OCC CI lacks.

### §8.7 vim mode — STAGE (2 bullets, ~12 distinct fixes)

`dj`/`dk`/`dG`/`dgg` + `c`/`y` forms acting on part of a line; `1G` going to last
line; `d0`/`c0`/`y0` no-ops; cursor off-by-one after `.` insert-repeat; `o`/`p` on
`!`-prefixed line switching to shell mode; `cw` on space/empty line/last letter/
one-letter word eating the next word; word motions stopping inside Indic-script
words; `.`/`p`/`P` inserting `!`-leading text switching to shell mode.
OCC has a **real vim engine** (`src/vim/` + `VimTextInput` + editorMode config +
undo/yank/visual/search/substitute), so these are applicable in principle — staged
per the occ44 §3d precedent: each fix needs per-site decompilation **and** behavior
verification against OCC's engine before porting (a batch vim round is the natural
next-next-round candidate; 2.1.282 adds more vim fixes, §9).

### §8.8 Misc — STAGE/NO-OP (4)

- MCP URL-mode elicitation (2026-07-28 protocol) → **STAGE** (OCP MCP surface simplified; elicitation support to verify).
- MCP resource lists skipping MCP Apps UI resources → **NO-OP** (no MCP Apps surface; §6 S3).
- `/plugin` Errors-tab confirmation + double-Enter uninstall/update guard → **STAGE** (plugin UI per-site).
- `claude plugin uninstall` project-scope-enabled wording; `plugin update --scope` resolution; `validate` listing-metadata keys → **STAGE** (plugin CLI per-site; small portable fixes).

**Tally:** PORT 2 · PARTIAL 1 · NO-OP ~45 · STAGE ~128 (176 total).

## §9 2.1.282 (`next`) — triage only, **STAGE, 0 PORTS** (per taskbook)

Facts: npm 2.1.282 published 2026-09-24T15:56Z; GitHub release 2026-09-24T18:38:05Z
(now marked Latest — taskbook fact changed, §1); md5 `54435b7ed06ae1ef9417edda38256c15`,
238,767,288 B; no `## 2.1.282` section in the raw CHANGELOG yet (release notes only).
`latest` remains 2.1.281 → **no ports this round**; everything below is STAGE
material for the next round.

**S1 stability check (281→282 occurrence counts):** deny text 2→2, `__CMDSUB__`
11→11, `wholeSubstitution` 3→3, `tengu_iridescent_boot` 2→2,
`tooManySubstitutions` 2→2, `emptyExpansion` 2→2 — the S1 subsystem is **unchanged**;
this round's port needs no 282 follow-up.

Genuine-new 2.1.282 env vars (12, exact-name verified; all STAGE):

| Env var | Count (282) | Note |
|---------|-------------|------|
| `CLAUDE_CODE_DISABLE_ATTRIBUTION_BASELINE_REUSE` | 2 | attribution baseline caching knob |
| `CLAUDE_CODE_DISABLE_REFUSAL_RETRY` | 3 | pairs with the compaction-refusal fallback-model fix |
| `CLAUDE_CODE_ELEGANT_MEADOW` | 3 | codename experiment — unlinked |
| `CLAUDE_CODE_GZIP_REQUEST_BODY_LEVEL` | 3 | request-body compression level |
| `CLAUDE_CODE_PARKED_RUN_BEFORE_CLEAR` | 3 | /clear-vs-running-turn interplay |
| `CLAUDE_CODE_PROJECTS_SESSION` | 3 | projects surface |
| `CLAUDE_CODE_REMOTE_TOOLS_SPECULATIVE_CLASSIFIER` | 2 | remote-tools classifier speculation |
| `CLAUDE_CODE_SQUISHY_NEWT` | 3 | codename experiment — unlinked |
| `CLAUDE_CODE_WEBSEARCH_CCR_PROXY_FAST` | 3 | web-search CCR proxy fast path |
| `CLAUDE_CODE_WEB_SEARCH_FAST_ARG` | 4 | web-search fast arg |
| `CLAUDE_IN_CHROME_MANAGED_MCP_REFUSAL` | 2 | pairs with `allowClaudeInChromeWithManagedMcp` |
| `CLAUDE_TEST_NO_OPEN` | 2 | test knob |

Release-note triage (~90 bullets; groups):

- **Security/permissions — next-round P1 candidates (STAGE):**
  - mid-pattern `:*` Bash rules skipped in settings files but honored from
    `--allowedTools` → now work from every source **with a startup warning on how
    they match** (OCC has the legacy `:*` syntax via `permissionRuleExtractPrefix`,
    anchored `/^(.+):\*$/` — the mid-pattern semantics + warning need byte-level
    comparison; directly in OCC's rule-matcher neighborhood, same file P2 touched);
  - repository/user/`--add-dir` skills+commands+plugin manifests self-pre-approving
    tools via `allowed-tools` under managed `allowManagedPermissionRulesOnly`;
  - `sandbox.excludedCommands` ignoring project/local entries when managed
    `allowUnsandboxedCommands:false` or `allowManagedDomainsOnly:true`;
  - project/local settings ignoring OpenTelemetry export-enabling variables
    (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOG_*`);
  - managed settings: mistyped boolean lock values now lock + name the key; one
    invalid nested value no longer discards the whole `permissions`/`autoMode`/
    `worktree`/`attribution` block;
  - Windows/WSL: invalid/unreadable admin policy blocks user-writable HKCU +
    `/etc/claude-code`;
  - `Skill(anthropic-skills:*)`/`Skill(claude-ai:*)` narrowed to synced skills;
    `anthropic-skills`/`claude-ai` namespaces no longer load from folders/commands/
    workflows; MCP servers under those names list no skills/prompts (namespace-
    squatting hardening — check OCC's skill/plugin namespace gates);
  - CLAUDE.md/rules read through a repo symlink reaching macOS `/Network` via `..`
    or `/.vol`-style kernel paths (companion to the 281 `/.vol` STAGE item).
- **Session/transport (STAGE):** web-search-decrypt 400 loop fix; resumed-session
  changed-form re-sends (more cases); thinking dropped on immediate slash commands /
  `--tools`-list relaunch; `redacted_thinking` invalid-data drop+retry-once;
  compaction refusal → fallback model; effort-vs-thinking failed turn after safety
  model switch; login-refresh "another process" minute-long failure; org-policy
  fetch retry after sign-in refresh; restored-prompt approval double-run on worker
  restart; large-session resume speed; Windows EBADF resume error text.
- **UI/UX (STAGE):** `maxProseWidth` setting; telemetry-vars startup notice +
  `/status`+`doctor` entries; `/feedback` drafts scrollbar; bracketed-paste reset
  line-by-line submit; SessionStart-hook example-text flash; fullscreen blank-flash;
  non-fullscreen renderer row garbling; CJK/emoji diff stale column; history-recall
  tab cursor; ctrl+enter hint on old Windows Terminal; `remote-control --debug`;
  install-github-app cancel-still-pushes; feedback save-after-cancel on 3P
  providers; plugin uninstall ×2 (settings-still-enabled; unreadable list keeps
  options); `/skills` key-routing ×2; scrollbar column width; agent-panel footer
  wrap + rebind hint; `/tasks` doubled `·`; artifact 60-char label; screen-reader
  code-block blank lines; PDF error-message readability (accents; "password"/
  "invalid" folder names); vim ×3 bullets (count-before-`.`; whole-line ops on
  wrapped lines; history-recall cursor past EOL; `>>` empty lines; `r` with count;
  `2J`; last-line counts) — joins §8.7's staged vim batch; `/artifacts` layout;
  Clawd banner feet; ultracode plain styling.
- **NO-OP:** `allowClaudeInChromeWithManagedMcp` (no managed-MCP Chrome gate in
  OCC); gateway `store.readiness_grace_seconds`; Bedrock/Mantle safeguard request-ID
  (OCC Bedrock path is minimal); Vertex unrecognized-model web search; Claude
  Desktop unknown-model error; Fable usage-credits ×2 (no Fable credits surface);
  `claude-api` skill updates ×2 (OCC skill .md files are intentional stubs);
  [VSCode] ×4; [Cloud sessions] ×5; [Claude Tag] ×10; auto-mode server-side
  classifier default-on with telemetry off (no server classifier).

## §10 Disposition

**Landed this round (2 commits, pushed):**
1. `d9eb7ac` — S1 dangerous-rm substitution-target guard (flagship security port;
   byte-exact messages; 123 tests; coverage 98.2% region / 95.9% file).
2. `16a19c4` — P2 NUL-byte permission rule guard (official contract "matches
   nothing"; shared-matcher choke point; 8 tests) + biome-ignore protecting the
   `new RegExp` form from the regex-literal autofix.

**Explicitly not landed, with reasons:** S2 (no dialog surface), S3 (new subsystem,
feature decision), P3 (structural parity already), S5 (analytics stub by design),
S6 (no behavioral reading), 10 of 13 genuine-new env markers (NO-OP/STAGE per §7),
~128 changelog bullets STAGE (§8), all of 2.1.282 STAGE (§9, per taskbook 0-PORTS
rule while `latest`=2.1.281).

**Next-round priority candidates (ranked):**
1. When npm `latest` moves to 2.1.282: the mid-pattern `:*` rule fix + startup
   warning (same code neighborhood as P2), and the 282 settings-trust security
   cluster (managed partial blocks, telemetry-var ignore, excludedCommands scoping,
   skill-namespace squatting).
2. Session/transport reliability ★-subset (§8.3): `--max-turns` infinite retry,
   duplicated-stream-event double tool execution, RETRY_WATCHDOG caps, stream-json
   plain-string content.
3. Bash edit-diff snapshot temp-dir cleanup (disk hygiene, likely directly applicable).
4. Vim-mode batch round (§8.7 + §9 vim items together).
5. S1 approximation gaps (§3.5): variable-dataflow classifier, full `literalTarget`
   shape vocabulary.

**Forensic artifact cleanup:** the round's scratch directory (downloaded tarballs,
extracted binaries, strings dumps, decompiled regions) is deleted at task end per
the upstream-tracking skill's resource-safety rule.

## §11 e2e / A-B evidence appendix (post-triage verification, 2026-09-25)

All runs used the occ135 §2 harness recipe: tmux 200×50, isolated `HOME`
(onboarded through the full official dialog chain), dashscope gateway env
(`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL=qwen3.8-max`),
API-key suffix pre-approved via `customApiKeyResponses.approved` in each
isolated `~/.claude.json`. Harness root lived **outside the Multica workdir**
(after the stray-comment incident below) so no sub-instance could pick up the
workdir `CLAUDE.md` or inherit platform credentials.

### §11.1 Full CI suite

`bash test/e2e/ci-test.sh` → **5887 pass / 0 fail / 115 skip, 600 files,
CI_EXIT=0**. (Known pre-existing flake: `shellWiring042` timing, documented in
the occ134 ledger; not triggered in this run.)

### §11.2 Headless S1 attack on the fresh dist (OCC 2.1.351, guard string ×1)

- **Build provenance**: `bun run build` → `dist/cli.js` 30,759,794 B,
  `--version` → `OCC 2.1.351`, S1 guard message present exactly once. The
  npm-installed `/usr/bin/occ` (2.1.300) contains **zero** copies of the guard
  string and was never used for evidence runs.
- **`rm -rf "$(mktemp -d)"` variant** (same whole-substitution attack class):
  guard fires in headless `-p` mode under auto-allow settings; tool result is
  the byte-exact official message ("Dangerous rm operation detected: the target
  is the output of a command substitution…"); victim fixture intact.
- **`rm -rf "$(pwd)"` variant**: the gateway model (qwen3.8-max) refused at the
  **model layer** before emitting a tool call (injection-probe judgment —
  nondeterministic across runs); victim intact, no guard evidence from this
  variant. The mktemp variant is the definitive e2e guard-fire record.
- **Env gate**: `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT=1` → guard message
  count 0, rm executed ("Bash completed with no output", exit 0), throwaway
  fixture deleted — gate honored per official truthiness semantics.

### §11.3 OCC live REPL e2e (tmux, bypass mode)

`HOME=home-occ`, cwd = victim fixture, `bun dist/cli.js
--dangerously-skip-permissions`. Onboarding dialogs traversed: theme (Enter) →
security notes (Enter) → trust dialog (**Down+Enter**) → bypass dialog
(**Down+Enter**). All four steps PASS:

1. BOOT — `OCC v2.1.351` banner, `⏵⏵ bypass permissions on`.
2. SENTINEL — Read tool on fixture AGENTS.md → `● ACCEPT136-SENTINEL-OK`.
3. PONG — model round-trip → `● PONG`; `/status` shows Version 2.1.351 +
   dashscope base URL + Session ID.
4. ATTACK — `● Bash(rm -rf "$(mktemp -d)")` → `⎿ Error: Dangerous rm operation
   detected…` **while bypass permissions is on** — deny-in-all-modes confirmed
   live. Victim fixture intact.

### §11.4 Official v2.1.281 REPL A/B

Same harness, `HOME=home-off`, official linux-x64 binary (md5
`d00df59384be94d0b5cac74849540075` verified against npm tarball).
- Onboarding dialog chain **byte-identical** to OCC's (theme → security notes →
  trust → bypass; same wording, same defaults on the negative option).
- BOOT (`Claude Code v2.1.281` header), SENTINEL, PONG, `/status` (Version
  2.1.281) all PASS.
- ATTACK: model deliberated (~47×3 s waits), then the guard denied with
  "What was flagged: Dangerous rm operation detected: …" — the **same flag text
  as OCC**, wrapped in the official's richer deny-guidance envelope ("The
  command was NOT run… Do not work around the check…"), after which the
  official model followed its own safe-rewrite guidance. Victim intact.

**A/B verdict**: identical guard semantics (deny in all modes incl. bypass) and
identical flagged-message core text; the official wraps it in additional
model-facing guidance — a presentation-layer divergence, documented here, not a
behavioral gap in the ported rule.

### §11.5 Incident note (transparency)

One earlier A/B probe ran the official binary **inside** the Multica workdir;
that sub-instance picked up the workdir `CLAUDE.md` and inherited platform
credentials, posting a stray comment (`4f727f50-…`) to this issue under this
agent's identity. The comment was deleted and all subsequent harness runs were
moved outside the workdir. No data was exfiltrated; the fixture-only prompts
contained no secrets.

### §11.6 Coverage

Unit coverage on the touched permission surface: **98.2% statements / 95.9%
branches** (target ≥95%). S1 suite + P2 `nulByteRuleGuard281.test.ts` (8 tests
incl. smuggled-sentinel integration via `bashToolHasPermission`).

### §11.7 Round hygiene

README Tracks badge + parity table + Tracks bullet + dev-polyfill notes and the
`cli.tsx` dev polyfill `VERSION` marker bumped 2.1.280 → 2.1.281 in this
round's final commit. `package.json` stays 2.1.351 — the release bump/tag is a
separate `chore(release)` step **after** 验收 acceptance, per the established
release workflow. Forensic scratch dirs (`/tmp/occ136*`, the 237 MB official
binary copy) deleted at task end per the upstream-tracking resource-safety
rule; the durable record is this document.
