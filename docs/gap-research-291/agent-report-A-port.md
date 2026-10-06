All four STAGED upstream-parity security ports from `docs/gap-research-291/cluster-a-bash-permissions.md` are implemented, TDD-driven (RED→GREEN), and regression-clean. Deliverables are code + tests on disk (per coordinator override — no multica comment posted).

## FINAL REPORT

### Files changed
| File | Items | Change |
|---|---|---|
| `src/utils/bash/ast.ts` | #2, #5 | #2: zsh non-ASCII differential escalation (`We`/`Ue` port). #5: `ParseForSecurityOptions`/`declarationPrefixes` field, `DECLARATION_BUILTINS`, per-parse `DeclPrefixCtx` module state, `enumerateDeclarationPrefixReadings` (`Ior` port), `finalizeDeclarationPrefix`, walkCommand prefix-persistence block, branch/loop `inBranch` tracking in for/if/while handlers. |
| `src/tools/BashTool/bashPermissions.ts` | #5 | New exported `resolveDeclarationPrefixDecision` (per-reading deny/ask fold); wired into the dormant AST `simple` branch (guarded on `astRoot`). |
| `src/tools/BashTool/readOnlyValidation.ts` | #3, #4 | #3 `ps` four-condition callback + `respectsDoubleDash:!1` (byte-exact, prior). #4 pyright de-listed + corrected forensic comment. |
| `src/utils/shell/readOnlyCommandValidation.ts` | #4 | `PYRIGHT_READ_ONLY_COMMANDS` removed + corrected-facts comment. |

### Files created (tests)
- `src/utils/bash/__tests__/zshDifferentialVar290.test.ts` — #2, 13 tests
- `src/tools/BashTool/__tests__/psFlags290.test.ts` — #3, 15 tests
- `src/tools/BashTool/__tests__/pyrightNotReadOnly290.test.ts` — #4, 7 tests
- `src/tools/BashTool/__tests__/declarationPrefix290.test.ts` — #5, 18 tests

`src/utils/bash/specs/pyright.ts` **KEPT** (doc: only the read-only auto-allow entry is deleted, not the completion spec).

### Test summaries (bun output)
- 4 deliverable files: **53 pass / 0 fail / 107 expect()**
- Full bash-permission suite (`bun test src/utils/bash src/tools/BashTool`): **963 pass / 0 fail / 2275 expect() / 48 files** — no regressions (was 945 before #5's +18).
- Biome lint clean on `ast.ts` + `bashPermissions.ts`. New code adds no tsc errors (the `bashPermissions.ts` errors at lines 400/2912–3096 are pre-existing `logEvent`-metadata/redirect-comparison noise, outside my ranges).

### Deviations + justification
1. **#2 reason string** — used the forensically-confirmed official string ("A $ followed by non-ASCII text…") over the doc point-3 OCC-specific suggestion, per the aligning-with-official-binary "same prompt text" mandate.
2. **#2 node matcher** — official `Be` fires on ERROR nodes; OCC's pure-TS parser emits `concatenation`/`simple_expansion` (never ERROR) for `$=vær`-class tokens, so `hasZshDifferentialVarNode` matches the anchored token on any node (retaining the ERROR+`${` branch for parity). Empirically verified via AST probe.
3. **#5 result field** — carried `declarationPrefixes: string[]` (names) instead of official's separate count + `declarationPrefixBashKeeps`; count = `.length` and base-parse keeps === names, so one field suffices (KISS/DRY, documented in-code).
4. **#5 state model** — used per-parse module state (reset + save/restore) mirroring official `Az`'s `Zt`/`Gt`/`B`, rather than threading a context param through every recursive walker (large invasive signature churn). Safe: `parseForSecurityFromAst` is synchronous and non-reentrant.
5. **#5 test case 5** (`X=/etc/passwd export X && cat $X` + Read deny) pinned at the resolution seam (base parse yields subcommand text `cat /etc/passwd`, which the existing downstream path validator denies) rather than a full integrated Read-deny, since Read-deny path validation is a separate subsystem downstream of the AST result.
6. **`local`** included in `DECLARATION_BUILTINS` for list parity though OCC doesn't model function scope.

### Out-of-scope observations
- The AST path is **fully dormant** in the shipped build (`feature('TREE_SITTER_BASH_SHADOW')` forces `parse-unavailable`; the non-shadow gate also yields null root). So #2 and #5 are defense-in-depth / future-parity for a `TREE_SITTER_BASH` flag-flip; the LIVE legacy path already fail-safes (asks) on all these forms. This matches the doc's "STAGED, 非 P0 安全洞" judgment — #5's real value is rule *precision* (deny where OCC previously only asked).
- `resolveDeclarationPrefixDecision` is unit-tested directly (the same seam the flag-flip will use); its bashPermissions wiring is guarded and inert until the AST path goes live.
- Pre-existing tsc noise in `bashPermissions.ts` (analytics-metadata `number|boolean` constraint, `<>` redirect comparison) is unrelated to these ports.

Note: the still-running background agents (Cluster B/G research; ports B/C1/E/F/G) are separate work streams outside this 4-port Cluster A assignment — not spawned/duplicated here.