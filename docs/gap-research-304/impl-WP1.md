# impl-WP1 — BashTool permissions cluster (items #10, #9, #35)

Agent: WP1. Source of truth: `docs/gap-research-304/research-R2-bash-perms.md` §#10/§#9/§#35 (byte-verified official 2.1.304 forensics). Branch: `agent/occ-leader/3bdf2d90`. No git commands were run; files only.

---

## Item #10 — mounted-drive `rm -r` safety prompt (PORT M) — DONE

### Files changed
- `src/tools/BashTool/pathValidation.ts` — new arm + helpers, wired into `checkDangerousRemovalPaths`
- `src/utils/managedEnv.ts` — kill-switch env var added to `PROJECT_SCOPE_BLOCKED_ENV_KEYS`
- `src/utils/__tests__/projectScopeEnvBlocklist251.test.ts` — count pin 118→119 + new-key assertion (see Deviations)
- NEW `src/tools/BashTool/__tests__/mountedDriveRm304.test.ts` — 20 tests

### What was done
New deferred mounted-drive arm in the dangerous-rm pipeline, faithful to the official `XG` analyzer shape:

- **`MOUNTED_DRIVE_PATH_RE`** — the official `G$o` regex, byte-verbatim:
  `/^\/(?:system\/)?volumes(?:\/[^/]+){0,2}$|^\/mnt\/(?:[^/]+|[a-z]\/[^/]+)$|^\/(?:run\/)?media(?:\/[^/]+){0,3}$/i` (pinned by a source-string test).
- **`hasRecursiveRmFlagV304`** — the official `_e` detector: flags before the first `--` only; static regex `/^--r|^-[a-zA-Z]*[rR]/` verbatim; dynamic form = no `/` + placeholder/flag lead `/^(?:-|__(?:CMDSUB(?:_OUTPUT)?|TRACKED_VAR)__)/` + expansion-bearing (see Adaptations).
- **`checkMountedDriveRemoval`** — rm only (never rmdir); kill-switch raw truthiness; candidates = literal cleaned path + cwd-resolved absolute + `realpathSync` variant; each candidate posix-normalized, trailing slash stripped (`replace(/(.)\/$/,'$1')` — official `L$o.normalize(Ve)` step), then tested against `G$o`. Fires an **ask** with:
  - the official 3-paragraph message, byte-verbatim (`Dangerous rm operation detected: '<display>'\n\nThis command would remove a mounted drive, …\n\nIf you meant something deeper inside, name it by its full path.`);
  - `decisionReason = {type:'safetyCheck', reason:`Dangerous rm operation on mounted drive path: ${display}`, classifierApprovable:false, circuitBreaker:'dangerousRemoval'}` (official `jb` builder + `YWt="on mounted drive path: "`);
  - `suggestions: []`;
  - telemetry `logEvent('tengu_bash_dangerous_rm_shape', { shape: 'mounted_drive_path' })` (official `yze` third value).
- **Deferred priority** (official `ke===void 0` / `return ke??passthrough`): the arm runs in `checkDangerousRemovalPaths` AFTER the critical-path loop (which returns immediately when it fires) and BEFORE the passthrough return — so critical-path results always win.
- **Gate `GX()`/`tengu_bright_lake`** — default-on in the official binary → always-on in OCC per the `destructiveCommandWarning.ts:1416` tengu_* porting convention (documented in the code comment; GrowthBook is stubbed).
- **Kill-switch** `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` — raw truthiness (any non-empty value disables, even `"0"`), mirroring the `dangerousRmAutoDeny.ts:171` convention; added to `managedEnv.ts` `PROJECT_SCOPE_BLOCKED_ENV_KEYS` next to `CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT` (official settings-env allowlist @240663587 member — project scope must not toggle a security kill-switch).

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| `G$o` regex, recursive-flag regex, dynamic-lead regex, ask message, decisionReason strings, env var name, telemetry names/values | **Verbatim** |
| Dynamic-flag inclusion test (`__CMDSUB__`/`wi(be)`) | **Adapted (fail-safe)**: OCC args at this site are untokenized shell-quote fragments, so the test also accepts raw `$`/backtick markers, keeping the official 3-part shape (no `/`, expansion-bearing, flag/placeholder lead). Also lists `__CMDSUB_OUTPUT__` explicitly (the official `includes("__CMDSUB__")` literal does not cover it — binary-ambiguous whether `wi` does; over-detection only enables the ask, never an auto-allow). |
| Glob-collapsed flag (`_e||Ie`) | **Omitted**: OCC has no `Ie` (glob-fold) analog at this site; documented in code. |
| realpath candidate | **OCC addition (fail-safe)**: symlink inside the workdir pointing at a mounted drive also fires; can only over-prompt. |
| `display` | OCC args are untokenized so `cleanPath` IS the user-visible target; the official `replaceAll("__CMDSUB__","$(…)")` is kept for parity. |

### Tests (all green)
`src/tools/BashTool/__tests__/mountedDriveRm304.test.ts` — 20 tests: regex source/flags verbatim pin; coverage table (13 matching / 7 non-matching paths); `hasRecursiveRmFlagV304` static/`--`-cutoff/dynamic/negative cases; integration via `bashToolHasPermission`: verbatim message + exact decisionReason `toEqual`, `/mnt/data`, WSL `/mnt/c/Users`, trailing slash, case-insensitivity, too-deep path NOT breaker-ask, non-recursive rm and rmdir never fire, bypassPermissions survival, critical-path priority (`rm -rf /` deny, `rm -rf /usr` critical-path message), kill-switch raw-truthiness disable + re-fire, shape-telemetry spy (mock.module analytics) asserting `{name:'tengu_bash_dangerous_rm_shape', metadata:{shape:'mounted_drive_path'}}`.

```
bun test src/tools/BashTool/__tests__/mountedDriveRm304.test.ts
 20 pass  0 fail  69 expect() calls
```

---

## Item #9 — sandbox denyRead glob crash (PORT via patch backport) — DONE

### Files changed
- `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` — regenerated via the `bun patch` workflow; now carries BOTH the pre-existing 2.1.276-K zsh socat-trap hunk AND the new glob hunks in `dist/sandbox/sandbox-utils.js`
- NEW `src/utils/sandbox/__tests__/sandboxGlobBracketsPatch304.test.ts` — 14 tests (imports the REAL patched file from node_modules)

### What was done (no version bump — `@anthropic-ai/sandbox-runtime@0.0.44` stays)
Backport of the official 0.0.80 `setRanges` semantics into the 0.0.44 replace-chain engine:

1. **`spellsCharacterSet(body)` validator** (new function): empty body → invalid; escape-aware (`\X`) member parsing; `a-z` ranges with charCodeAt comparison — backwards range (`[user-id]`: `r-i`) → invalid; trailing `-` treated as a literal member (regex-class semantics); trailing backslash → invalid.
2. **`globToRegex` demotion pre-pass**: closed bracket groups that fail the validator are replaced by inert `__LITERAL_SET_<n>__` placeholders (storing a fully regex-escaped literal rendering `\[…\]`, so glob-meta `*`/`?` inside a demoted group stays literal), the existing replace-chain runs untouched, and a restore pass reinserts the literals after the `$` anchor. Warn via the file's existing `logForDebugging`, adapted official text: `[Sandbox] The brackets in ${body} spell no set of characters, so they are read as text: ${globPattern}`.
3. **`expandGlobPattern`**: the previously UNGUARDED `const regex = new RegExp(globToRegex(normalizedPattern));` moved INSIDE the existing try/catch — an invalid pattern now degrades to skip+warn (`[Sandbox] Error expanding glob pattern …`) instead of throwing out of Linux sandbox startup.

Workflow: `bun patch @anthropic-ai/sandbox-runtime@0.0.44` (edit dir seeded WITH the existing socat patch — verified line 437) → edited `dist/sandbox/sandbox-utils.js` in place → `bun patch --commit 'node_modules/@anthropic-ai/sandbox-runtime'` → stripped two bun-internal artifacts from the regenerated patch (an empty `.bun-tag-*` file hunk and a `dist/cli.js` mode-only hunk — neither is a real change; the original patch had neither) → verified `rm -rf node_modules/@anthropic-ai/sandbox-runtime && bun install` re-applies cleanly (both hunks present, behavior smoke-tested post-reinstall).

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| Demotion semantics (empty / backwards range → literal text), skip-don't-throw degradation | **Verbatim semantics** (0.0.80 `setRanges`) |
| Warn text | **Adapted shape**: official joins a list of demoted groups (`a.join(", ")`); 0.0.44's per-group replace callback warns per group with the same sentence — the sentence itself is byte-identical |
| Implementation vehicle | **Adapted**: 0.0.80's AST tokenizer was NOT ported wholesale; validator + placeholder demotion wraps the existing replace-chain (minimal-diff patch, KISS) |

### Tests (all green)
`src/utils/sandbox/__tests__/sandboxGlobBracketsPatch304.test.ts` — 14 tests: anti-revert source guards (validator/demotion/warn text present in node_modules; `new RegExp` inside try; patch file carries glob + socat hunks; package.json registration); the field-report crash case `/data/[user-id]/.env` compiles and matches literally (not as a class); valid `[0-9]`/`[a-z]`/`[abc]`/`[a-]` sets untouched; `[]` and `[a-*]` demoted with meta staying literal; unclosed-bracket escape preserved; globstar/star unaffected; `expandGlobPattern` never throws and a real temp-dir fixture with a literal `[user-id]` directory expands correctly.

```
bun test src/utils/sandbox/__tests__/sandboxGlobBracketsPatch304.test.ts
 14 pass  0 fail  38 expect() calls
```

Regression pin (existing): `sandboxRuntimeZshTrapPatch.test.ts` still green — combined run:
```
bun test …/mountedDriveRm304.test.ts …/sandboxGlobBracketsPatch304.test.ts …/sandboxRuntimeZshTrapPatch.test.ts
 39 pass  0 fail  116 expect() calls
```

---

## Item #35 — copy-failure logging (optional diagnostics, S) — DONE

### Files changed
- `src/tools/BashTool/BashTool.tsx` (~:951) — silent `catch {}` → `logForDebugging` debug line
- `src/tools/PowerShellTool/PowerShellTool.tsx` (~:654) — same

### What was done
Both copy-to-tool-results failure paths now emit the official diagnostic text via OCC's `logForDebugging` (debug-level, no user-visible output):

`Could not copy ${file} to the session's tool-results folder (${err}). Keeping it.`

with `${err}` rendered through the existing `errorMessage as getErrorMessage` import. Byte-verbatim official sentence, minus the ENOSPC/EDQUOT branch: OCC always KEEPS the temp output file (no dispose-time deletion exists — `ShellCommand.ts` only deletes the output-file-redundant case inline), so the official "Deleting it because the disk or quota is full." carve-out cannot apply. A comment at both sites instructs that if a temp-file disposal is ever added, the full official `Cwr` semantics must be ported (ENOSPC/EDQUOT → still delete, otherwise keep).

### Tests
No UT — diagnostics-only change inside the full `call()` streaming path; a unit test would require mocking the whole tool-call + fs layer for a debug log line. Recorded as a deviation. Behavior is covered indirectly: the full BashTool e2e suite (`shellWiring042`, `bashReadCommands293.integration`) exercises the surrounding code and is green.

---

## Full verification sweep

```
bun test src/tools/BashTool/__tests__/          → 1118 pass  0 fail  2694 expect()  (56 files, incl. dangerousRm281/296)
bun test src/tools/PowerShellTool/__tests__/    →   13 pass  0 fail    37 expect()
bun test <managedEnv+sandbox batch, 7 suites>   →  246 pass  0 fail   923 expect()  (incl. projectScopeEnvBlocklist251 after the 119 pin update)
bunx biome lint <all 7 changed/new src files>   → Checked 7 files. No fixes applied. (clean)
bunx tsc --noEmit (ran twice, ~3min each)       → my files: 0 errors except pathValidation.ts(288) TS2322
```

The single remaining tsc error is `logEvent('tengu_bash_dangerous_rm_shape', { shape: 'mounted_drive_path' })` — string metadata vs `LogEventMetadata`'s `boolean|number` value type. This is **identical to the pre-existing neighborhood precedent** `bashPermissions.ts(2934)` (the official shape-telemetry call, same TS2322 in the baseline) plus ~20 other pre-existing `logEvent` string-metadata sites; tsc is not a CI gate and the official telemetry contract requires the string value. Left as-is for consistency.

## Deviations (with justification)
1. **Edited `src/utils/__tests__/projectScopeEnvBlocklist251.test.ts`** (outside the strict cluster): it pins `_getProjectScopeBlockedEnvKeysForTesting().size === 118`; the mandated managedEnv.ts allowlist addition makes it 119. Minimal update (count + rationale comment + new-key assertion). Leaving it failing was not an option ("run existing tests of changed files until green").
2. **Item #35 has no dedicated UT** — diagnostics-only, see above.
3. **`Ie` (glob-collapsed flag) omitted** from the `(_e||Ie)` condition — no OCC analog at this call site; documented in code.
4. **Dynamic-flag inclusion widened** (raw `$`/backtick, explicit `__CMDSUB_OUTPUT__`) — untokenized-args adaptation, fail-safe direction only (over-prompt, never auto-allow); documented in code.
5. **Patch-file artifact strip** — removed bun's empty `.bun-tag-*` hunk and `dist/cli.js` mode-only hunk from the regenerated patch (bun patch internals, not real changes); `bun install` re-application verified after the strip.

## Integration notes for the Leader
- **Cross-directory test pollution is PRE-EXISTING, not from WP1**: running `bun test src/tools/BashTool/__tests__/ src/tools/PowerShellTool/__tests__/` in ONE invocation yields 6 failures (BashTool e2e `waitFor timed out`) because PowerShellTool's `shellWiring042.test.ts` deliberately mocks `utils/Shell.js` process-globally (its own header says so). Each directory alone is 0-fail, and the combined run fails identically WITHOUT my new test file. CI runs `bun test` per-directory or splits — no action needed, but don't be alarmed by the combined-run failures.
- `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` grew from 13 lines to the glob+socat combined patch; `package.json` patchedDependencies mapping is unchanged (no package.json edits by WP1).
- The kill-switch `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` is now project-scope-blocked (managedEnv) — same policy class as the other rm kill-switches.
- If any later WP touches `pathValidation.ts` `checkDangerousRemovalPaths`, keep the mounted-drive arm AFTER the critical-path loop (deferred-priority contract).
- tsc error-count baseline moved 1930 → 1922 lines across the two runs (WP1 contributed net 0 new errors; other concurrent WPs may account for drift).
