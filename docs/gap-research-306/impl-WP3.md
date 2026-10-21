# impl-WP3 — CC 2.1.305 startup warnings → debug log + `securityWarnings` banner rows

Research source: `docs/gap-research-306/research-R3-model-settings-startup.md` **ITEM 2** (only item implemented).
Binary evidence: `/tmp/cc-diff-306/v306/package/claude` (read-only; strings dumps `s304/s305/s306/new305.txt`). Every hardcoded string, regex, and conditional below was byte-verified via `grep -aboF` offsets + `dd` dumps before landing.

## Files changed

| File | Change |
|---|---|
| `src/utils/settings/permissionValidation.ts` | `securityNotice?: string` on `validatePermissionRule` return + 4 notice builders (binary-exact gating, see Deviations #1) |
| `src/utils/permissions/startupSecurityWarnings.ts` | **NEW** — pure routing module: `sanitizeWarningText` (≡ `fd`), `formatSecurityWarningRow` (≡ `Zo`), `writeWarningToStderr` (≡ `UB`), `resolveStartupWarningChannel` (≡ emission gate), `routeStartupPermissionWarnings` (≡ `cz` + emission site) |
| `src/utils/permissions/permissionSetup.ts` | `securityWarnings: string[]` added to `initializeToolPermissionContext` return type/object; `collectPermissionRuleSecurityNotices` (validator-loop `S` rows); `collectPermissionRuleSecurityWarnings` (full port of the official FIRST loop); `REMOVED_UPSTREAM_TOOL_NAMES` (≡ `CPe`); `RULE_CONTENT_FIELDS` (≡ `ve` map); cli rule arrays restructured so all 3 rule groups feed both collectors |
| `src/main.tsx` | import `routeStartupPermissionWarnings`; destructure `securityWarnings` from initResult; replaced the raw `warnings.forEach(console.error)` loop (the v304 above-logo bug) with the official routing; `securityWarnings: securityWarningRows` threaded into **both** `launchRepl` call sites (resumeData path + fresh path) |
| `src/screens/REPL.tsx` | `securityWarnings?: string[]` prop; destructured; messages `useState` lazy initializer prepends `createSystemMessage(warning, 'warning')` rows, gated on `length > 0` (≡ official registry `isActive`) |

`src/replLauncher.tsx` needed no change (`<REPL {...replProps} />` spreads props).

## Byte-verified evidence (v306 offsets)

- **Emission gate** @257152404: `(!_e()||L!=="json"&&L!=="stream-json"&&a.CLAUDE_CODE_SESSION_KIND!=="bg") ? (hs.forEach(s=>cz(s)), rs.push(...D(Lo.securityWarnings.map(Zo)))) : hs.forEach(s=>t(`[permissions] ${fd(s)}`,{level:"warn"}))` (`_e` ≡ non-interactive @237636046; `D` ≡ dedupe; `rs` ≡ banner rows).
- **`cz`/`Zo`** @257109508: `Zo(e)=vn(fd(e)).trim()`; `cz(e,{stderrPrefix:o="",items:n=[]}={})` builds `[Zo(e),...n.map(u=>`  - ${Zo(u)}`)].join(`\n`)` then `if(_e()){UB(o+r);return}t(r,{level:"warn"})`. (The join is `` `\n` `` — verified with `od -c` after a `tr` pipe corrupted an early dump.)
- **`UB`** @242376611: `process.stderr.write(he.yellow(fd(r))+"\n")` (`he` ≡ chalk).
- **`fd`** @238646126: `bE(R_(e)).replace(/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,"")` (`R_`@237506326 ≡ strip-ansi).
- **`vn`** @237692316: `e.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu," ")`.
- **First loop** @255200695: iterates `[...Xd(v),...Fm(v)]` (deny+ask); skips `toolsNarrowing`/`session`; removed-tool (`CPe.has(P)`) → `t(...)` debug note only; known gate `Sk(P)||P.includes("_")||wce(P).length>0||Ce.has(P)` (`Sk`@237826166 ≡ `includes("*")`, `wce` ≡ getLegacyToolNames); raw-string check `F=T.indexOf(":");F>0&&T.slice(0,F).trim()===R`.
  - A-row: `Permission ${behavior} rule "${display}" targets ${field} as a raw string and will not match` + suffix chain `Be`: Grep → `.`; Glob → ` — use Read(…) to match file-read paths.`; Write/NotebookEdit → ` — use Edit(…) to match file-write paths.`; else ` — use ${P}(…) for ${P}'s own matcher.`
  - S-row: `${Da(behavior)} rule ${display} never matches${P===Grep?"":` · use ${Glob?Read:Write||NotebookEdit?Edit:P}(…)`}`
  - Unknown tool: A-row `Permission ${behavior} rule "${display}" matches no known tool — check for typos.`; S-row `${Da(behavior)} rule ${display} matches no tool · check for typos`.
  - `Da(t)=t.charAt(0).toUpperCase()+t.slice(1)` ≡ OCC's existing `capitalize` (`src/utils/stringUtils.ts:20`) — reused, byte-identical.
- **`CPe`** @248253597: `["Frame","FrameRead","TeamCreate","TeamDelete","SuggestBackgroundPR","AutofixPr","TaskOutput","AgentOutputTool","BashOutputTool","AgentOutput","BashOutput"]`.
- **`Pe` padding** @255192932: `[Bash,PowerShell,Glob,Grep]` added to the known-tool set.
- **`ve` ruleContentField owners** (10 binary grep hits, all verified): Write/Read/Edit → `file_path` (@248143924/@250045630/@251477452), NotebookEdit → `notebook_path` (@251492757), Bash → `command` (@251648411), PowerShell → `command` (@263068103), Glob/Grep → `path` (@248173168/@248179495), LSP → `filePath` (@255430788), SendFile → `files` (@272900297). **WebFetch has NO ruleContentField** (an earlier research note claiming `url` was disproven by the grep).
- **Validator `securityNotice`** (`rLe` @238393000) — verbatim strings:
  1. `` `${yn(s)} allows any option at its * · use an exact value` `` (inside the allow-only wildcard-before-subcommand gate; unconditional property of that return)
  2. `` `${yn(s)} reads its * literally${S.endsWith(":*")?"":` · use ${yn({toolName:s.toolName,ruleContent:S})}`}` `` (spread gate `...n!=="allow"&&{...}`)
  3. `` `${yn(s)} reads its :* as a wildcard · use an exact value` `` (spread gate `...n==="allow"&&{...}`)
  4. `` `${yn(s)} never matches · use ${yn({toolName:f,ruleContent:s.ruleContent})}` `` (spread gate `...n!=="allow"&&{...}`)
- Novelty counts s304→s305→s306: `securityWarnings` 0→10→10; `securityNotice` 0→3→3; `"security-warnings"` 0→2→2.

Unicode in row templates: `·` = U+00B7, `…` = U+2026, `—` = U+2014 (all byte-verified against the binary).

## Tests

New files (convention `<name>305.test.ts`; `permissionSetup` lazy-imported in `beforeAll` per the `startupRuleWarnings282` convention; MACRO polyfill where needed):

- `src/utils/settings/__tests__/securityNotice305.test.ts` — 20 tests: all four notices, exact strings, binary-exact mixed gating (allow-only vs non-allow), `suggested.endsWith(':*')` conditional shape, no-notice-without-warning invariants.
- `src/utils/permissions/__tests__/securityWarnings305.test.ts` — 17 tests: first-loop raw-field rows (Glob/Grep/Write/Bash incl. Grep's no-tail S-row and `Ask`/`Deny` capitalization), matches-no-tool rows, skips (allow rules never iterated, session source, removed tools no-rows, `TaskOutput` NOT removed in OCC, wildcard tool names pass the known gate, mcp `_` gate), `collectPermissionRuleSecurityNotices` rows + skip parity.
- `src/utils/permissions/__tests__/startupWarningRouting305.test.ts` — 18 tests: full channel matrix (interactive→debug-log for any format; headless text→stderr; json/stream-json→permissions-debug-log; bg session kind divert; non-bg kind doesn't), `fd`/`Zo` sanitization (ANSI strip, `\t\n` kept by `fd`, control-run collapse, NUL/U+200B/U+2028/U+2029 handling, trim), emission-site behavior (stderr spy: print-text writes yellow rows ending `\n`; interactive & json write nothing to stderr; json returns `[]` banner rows; dedupe + format of banner rows).

### Results (all green)

| Suite | Result |
|---|---|
| 3 new WP3 test files | **55 pass / 0 fail** (103 expect) |
| `src/utils/permissions/__tests__/` (43 files, incl. the 2 new) | **546 pass / 1 skip / 0 fail** (1250 expect) |
| `startupRuleWarnings282` + `midPatternStarRules282` | **36 pass / 0 fail** |
| Validator suites (`permissionRuleWarning`, `wildcardBeforeSubcommand246`, `midPatternStarRules282`, `startupRuleWarnings282`, `securityNotice305`) | **89 pass / 0 fail** (237 expect) |
| Other `permissionSetup` consumers (`antModelGlobalsPolyfill278`, `setModelAutoMode299`, `allowedToolsStripped304`, `exitPlanModeScreenReader288`) | **18 pass / 1 skip / 0 fail** |
| `bunx biome lint` (8 touched files) | **0 errors**; 11 warnings — all `suppressions/unused` pre-existing noise in `main.tsx` (HEAD baseline of the same file: 12 warnings; my change removed one) |

Repo-wide `bun test` NOT run (per instructions). No git commit, no bun install.

## Deviations & observations

1. **Mixed notice gating — binary wins over the research doc.** The doc/task said notices are "deny/ask only, never allow". The v306 binary shows notices 1 & 3 are **allow-only** and 2 & 4 are **non-allow-only** (spread gates verified above). Implemented per binary; tests pin binary-exact gating.
2. **Validator lives outside the stated touch-list.** `validatePermissionRule` is in `src/utils/settings/permissionValidation.ts`, not under `src/utils/permissions/**`. Edited in place (only possible location).
3. **Banner rows via message seeding, not a registry (per task, YAGNI).** Official uses a `{id:"security-warnings",tier:"warning",isActive:m=>m.securityWarnings.length>0}` banner-registry entry rendering `status:"warning"` rows. OCC has no such registry; rows render through the existing `createSystemMessage(text,'warning')` → `SystemTextMessage` surface, prepended in the REPL messages initializer, gated on `length > 0`. Structurally divergent, visually equivalent.
4. **Static `RULE_CONTENT_FIELDS` map vs official dynamic `ve`.** Official builds the map from each base tool's self-defined `ruleContentField` plus explicit Bash/PowerShell/Glob/Grep entries. OCC tools don't expose `ruleContentField`, so the map is static with the 8 binary-verified owners. LSP (`filePath`) and SendFile (`files`) omitted — neither ships in OCC. WebFetch omitted — no official field.
5. **`TaskOutput` excluded from `REMOVED_UPSTREAM_TOOL_NAMES`** despite being in the official `CPe` set: it is a live OCC tool (`getAllBaseTools` ships TaskOutputTool); keeping it would misfire the removed-tool debug note on working rules. `AgentOutputTool`/`BashOutputTool` kept for parity (parse-time normalization means they rarely arrive as-is).
6. **`launchResumeChooser` not threaded.** Its props type (`ResumeConversationProps`) is a different screen; conversations resumed through it relaunch via the patched `launchRepl` resumeData path, which does receive `securityWarnings`. Only the transient chooser screen itself never shows banner rows.
7. **`cz`'s `{stderrPrefix, items}` options not ported** — the permission-warning emission site uses the default `{stderrPrefix:"",items:[]}` shape; only that shape is implemented (documented in the module header).
8. **Headless print-text stderr is now yellow (≡ `UB`)** — an intentional upgrade: OCC previously wrote raw `console.error` in ALL modes; official print-text keeps yellow stderr while interactive moves to the debug log.
9. **Pre-existing divergence observed (untouched, out of scope):** the official SECOND loop's cliArg-allow skip targets **Glob** (`toolName===uo`), while OCC's existing `shouldSkipPermissionRuleStartupWarning` skips cliArg-allow **Read** (`FILE_READ_TOOL_NAME`). Predates 2.1.305; flagged for a future round.
10. **Official `Iri` base-tools `--tools` securityWarnings** (the `--tools` CLI surface feeding extra warning rows) not ported — OCC's `parseBaseToolsFromCLI` path has no counterpart staged; out of ITEM 2 scope.
11. **`capitalize` reused from `src/utils/stringUtils.ts`** (byte-identical to official `Da`) instead of a new local helper.
12. **Validator runs twice** over each rule group (once for `warnings` via `collectPermissionRuleStartupWarnings`, once for `securityWarnings` via `collectPermissionRuleSecurityNotices`) to preserve the existing collector's `string[]` return shape consumed by `startupRuleWarnings282.test.ts`. Rule counts are tiny (≤ dozens); acceptable DRY trade-off.
