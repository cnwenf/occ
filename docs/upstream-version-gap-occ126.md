# Upstream Version Gap — OCC-126 (official 2.1.270 → 2.1.272 gap; strict self-acceptance lands 3 corroborated security/crash fixes)

- **Round:** OCC-126 (autopilot 版本追齐, 2026-09-16 — Multica issue **OCC-87**)
- **OCC aligned-at (round start):** official Claude Code `2.1.270` — OCC release `2.1.335` (tags == releases)
- **Official latest (round check, live npm re-verify):** `@anthropic-ai/claude-code` dist-tags → `latest: 2.1.272`, `next: 2.1.273`, `stable: 2.1.236`. Publish times: `2.1.270` 2026-09-12, `2.1.271` 2026-09-14T19:45Z, `2.1.272` 2026-09-14T23:34Z, `2.1.273` 2026-09-15T18:06Z (`next`-channel prerelease, **not** `latest`). So OCC is **2 releases behind `latest`** (2.1.270 → 2.1.271 → 2.1.272), with a 2.1.273 prerelease on `next`.
- **Acceptance environment:** dashscope gateway (`ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`, model `qwen3.8-max`); OCC build `dist/cli.js`, `occ --version` → `OCC 2.1.335` at round start (→ `2.1.336` after this round's bump). Live e2e driven through a real tmux REPL (TTY preserved) + headless `-p`.

**Verdict summary:** Official advanced to `2.1.272`, but the official linux-x64 ELF **cannot be downloaded/decompiled in this environment**, so a byte-verified port of the 2.1.271/2.1.272 surface is impossible here — per the `aligning-with-official-binary` discipline ("Never invent", "STOP when ambiguous in the binary") **no invented/partial official port was landed** and the README "Tracks" badge stays at `2.1.270`. The round therefore took the issue's **"无 gap 可验证 → 严格自验收"** branch: a strict self-acceptance pass over OCC's own source + live REPL on real tasks, prioritizing recently-added features. That pass **independently discovered and fixed 3 genuine security/crash bugs in OCC source** — and all 3 map *exactly* onto official **2.1.271** changelog entries (independent corroboration that these are real parity fixes, not inventions). 3 LAND (ITEM 17 / 45 / 35), the rest of the 2.1.271 security set STAGED for occ127 pending binary verification, `2.1.272` is a no-op ("Bug fixes and reliability improvements" — no portable surface), `2.1.273` is a `next` prerelease (out of scope). Release `2.1.336` cut (3 real fixes — unlike OCC-40's no-op, this warrants a patch release).

---

## 1. Version gap triage — official 2.1.270 → 2.1.271 → 2.1.272 (→ 2.1.273 next)

| Release | Date | Surface | This-round disposition |
|---|---|---|---|
| `2.1.271` | 2026-09-14 | ~85 changelog entries (substantive; security-heavy) | **Researched at changelog level; byte-verified port STAGED** (no ELF access here). 3 entries independently landed via self-acceptance (§2–§4); the remaining security set staged for occ127 (§5). |
| `2.1.272` | 2026-09-14 | "Bug fixes and reliability improvements" (no itemized entries) | **NO-OP** — no portable named surface to triage; nothing to port without the binary. |
| `2.1.273` | 2026-09-15 | `next`-channel prerelease (not `latest`) | **Out of scope** — OCC tracks `latest`, not `next`. Recorded for awareness only. |

**Why no byte-verified port this round.** Every prior catch-up round (OCC-122/123/124/125) recovered landed strings/constants verbatim from the official linux-x64 ELF (e.g. "byte-verified from the official 2.1.270 ELF"). This environment cannot download/decompile the 2.1.271/2.1.272 ELF, so the per-site forensics those ports require are unavailable. Landing changelog-prose-only re-implementations would violate the repo's "Never invent / no invented/partial" discipline (the same rule that made OCC-40 refuse a no-op release). The honest outcome: document the gap, land only what is verifiable from OCC's own source, and stage the rest.

## 2. ITEM 17 — read-only text-util path-validation bypass (LAND)

**Official 2.1.271 corroboration:** *"Permission review includes files read by formatting/column utilities after unrecognized options"* — **security fix, Bash/permissions.** Discovered independently from OCC source during self-acceptance; the official shipped the same class of fix in 2.1.271.

**The bug (OCC source).** Ten read-only text utilities — `tac, rev, fold, expand, unexpand, fmt, comm, cmp, pr, tsort` — were listed in `READONLY_COMMANDS` (`src/tools/BashTool/readOnlyValidation.ts`, so `BashTool.isReadOnly()` returns true) but were **absent** from `PATH_EXTRACTORS` / `COMMAND_OPERATION_TYPE` / `ACTION_VERBS` / the `PathCommand` union in `src/tools/BashTool/pathValidation.ts`. The permission pipeline `bashToolCheckPermission` (`src/tools/BashTool/bashPermissions.ts`) runs `checkPathConstraints` at **step 3** (which only validates commands in `SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS)`) and the read-only auto-allow at **step 7** (`if (BashTool.isReadOnly(input)) return allow`). An unrecognized command therefore fell *through* step 3 to `passthrough`, then step 7 **auto-allowed it with no prompt** — even when the file argument pointed **outside** the session's working directories. Concrete pre-fix bypass: `fmt /etc/passwd` (or any of the ten on an outside path) silently exfiltrated a file the user never approved a read for — the exact guarantee `cat`/`head`/`tail` already enforce.

**The fix** (`src/tools/BashTool/pathValidation.ts`, +58 lines, all four maps):
- `PathCommand` union — added the 10 names (line ~65-66, after `| 'tee'`).
- `PATH_EXTRACTORS` — added `tac/rev/fold/expand/unexpand/fmt/comm/cmp/pr/tsort: filterOutFlags` (lines ~375-384, after `md5sum`), mirroring `cat`/`head`/`tail`. A long SECURITY comment (line ~361) documents the `fmt /etc/passwd` exfil vector and the deliberate exclusions.
- `ACTION_VERBS` — per-command prompt verbs (lines ~645-654, e.g. `fmt: 'format text from files in'`).
- `COMMAND_OPERATION_TYPE` — all 10 → `'read'` (lines ~696-705).
- `COMMAND_VALIDATOR` is `Partial<Record<…>>` — intentionally **not** edited (no exhaustiveness requirement; none of the ten has a `--target-directory`-class flag needing a custom validator).

**Deliberate exclusions** (`numfmt`/`readlink`/`realpath`/`basename`/`dirname`): kept read-only-auto-allow only. Their primary arguments are numbers or command names, not file paths, so path-extracting them would false-positive (e.g. `readlink -f /usr/bin/python` prompting on a binary that is not a document read). The security reviewer confirmed none can read arbitrary file **contents** (`numfmt` parses operands as numbers; `basename`/`dirname` are pure string ops; `readlink`/`realpath` emit resolved paths/symlink targets — metadata, not contents). See the SECURITY note in `pathValidation.ts`.

**Tests** — `src/tools/BashTool/__tests__/readonlyTextutilPathValidation.test.ts` (6 tests, mirrors `teeWritePath269.test.ts`): all 10 in `PATH_EXTRACTORS` (typeof function) + all 10 `'read'` in `COMMAND_OPERATION_TYPE`; `filterOutFlags` behavior (`fmt(['-s','/x/file.txt'])` → `['/x/file.txt']`, `pr(['--','-weird'])` → `['-weird']`); `checkPathConstraints({command:'<cmd> <outside>/secret.txt'})` → `'ask'` with message containing "was blocked" + "the allowed working directories" for all 10; in-workdir → `'passthrough'`; `/usr/bin/fmt <outside>` → `'passthrough'` (documents the pre-existing canonicalization boundary — `canonicalizePathCommandName` only basenames `tee`/`rm`/`rmdir`; the path-prefixed form is gated by the step-8 prompt since the READONLY regexes are `^cmd`-anchored, fail-closed and identical to `/usr/bin/cat`).

## 3. ITEM 45 — hook-matcher prototype-key crash (LAND)

**Official 2.1.271 corroboration:** *"Hooks menu no longer crashes when matcher names resemble built-in object properties"* — **bug fix, hooks/UI.** Discovered independently from OCC source; the official shipped the same fix in 2.1.271.

**The bug (OCC source).** A hook config's `matcher` is an unvalidated `z.string()` (`src/schemas/hooks.ts`), so a malicious settings/session hook can set `matcher: "__proto__"` (or `"constructor"`/`"prototype"`). `groupHooksByEventAndMatcher` (`src/utils/hooks/hooksConfigManager.ts`) built plain `{}` inner buckets keyed by that matcher:

```ts
if (!eventGroup[matcherKey]) eventGroup[matcherKey] = []
eventGroup[matcherKey].push(hook)
```

For `matcherKey === "__proto__"`, `eventGroup["__proto__"]` reads through `Object.prototype` (it *is* `Object.prototype`, truthy), so the `= []` init is **skipped** and `.push(hook)` runs on a non-array → "push is not a function", **crashing the `/hooks` menu** and all hook grouping. (`matcherKey = "__proto__"` on the assignment path would instead re-point the bucket's prototype.)

**The fix** (`src/utils/hooks/hooksConfigManager.ts`, +18 lines): after the `grouped` literal, re-create every inner bucket with a null prototype so attacker-chosen keys become inert own properties:

```ts
for (const event of Object.keys(grouped) as HookEvent[]) {
  grouped[event] = Object.create(null) as Record<string, IndividualHookConfig[]>
}
```

(comment at line ~344, loop at line ~356). The **outer** `grouped` object stays a normal literal — `event` is `z.enum(HOOK_EVENTS)`-validated, so the outer keys are not attacker-controlled (the security reviewer verified all three event-key sources are enum-bounded: settings files via `z.partialRecord(z.enum(HOOK_EVENTS),…)` — a `__proto__` event key is silently stripped, `constructor` fails the whole file → fail-closed; session hooks via `for (const event of HOOK_EVENTS)`; plugin hooks via `PluginHooksSchema`→`HooksSchema`).

**Tests** — `src/utils/hooks/__tests__/hooksMatcherPrototypeKey.test.ts` (5 tests): (1) vulnerability characterization — a plain `{}` bucket crashes on a `__proto__` matcher (reproduces the exact pre-fix bug), a null-proto bucket defuses `__proto__`/`constructor`/`prototype`; (2) the real `groupHooksByEventAndMatcher` returns null-proto buckets (`Object.getPrototypeOf(grouped[event]) === null`), attack keys inert; (3) end-to-end — a session hook with `matcher:'__proto__'` under `PreToolUse` keyed by `getSessionId()` flows through grouping without throwing, asserted via `Object.hasOwn(bucket, '__proto__')`. The security reviewer exhaustively grepped all bucket consumers (`getHooksForMatcher`, `getSortedMatchersForEvent`, `sortMatchersByPriority`, `HooksConfigMenu.tsx`, `SelectMatcherMode.tsx`) — all use index-access/`Object.keys`/`entries`/`values`; **zero** `hasOwnProperty`/`toString`/`valueOf`/`isPrototypeOf` calls on buckets; buckets are UI-transient (never `JSON.stringify`'d/persisted/spread). No consumer breaks.

## 4. ITEM 35 — in-session `/resume` read-tracking leak (LAND)

**Official 2.1.271 corroboration:** *"Resume/teleport no longer keeps old file-read tracking that could allow edits not read in the resumed chat"* — **security fix, resume/file tracking.** Discovered independently from OCC source; the official shipped the same fix in 2.1.271.

**The bug (OCC source).** `restoreReadFileState` (`src/screens/REPL.tsx`) rebuilds the read-before-edit tracking cache from a transcript and runs on **two** paths — the mount path (CLI `--resume-session`, fresh process, empty cache) and the **in-session `/resume`** path (switching conversations mid-process). It did:

```ts
readFileState.current = mergeFileStateCaches(readFileState.current, extracted)
```

`mergeFileStateCaches(first, second)` (`src/utils/fileStateCache.ts`) **clones `first`** then overlays `second`. On the in-session path `first` still holds the **previous (abandoned) conversation's reads**, so a merge-only restore leaked them into the resumed session: the read-before-edit guard would then accept an edit to a file the model only read in the abandoned conversation, never in the one it resumed into. (The `resume` callback does **not** run `clearConversation` before `restoreReadFileState`, so the stale cache survives.)

**The fix** (`src/screens/REPL.tsx`, +10 lines): clear before merging, matching the `/clear` (`src/commands/clear/conversation.ts`) and compact (`src/services/compact/compact.ts`) idiom:

```ts
readFileState.current.clear();
readFileState.current = mergeFileStateCaches(readFileState.current, extracted);
```

(comment at line ~2077, `clear()` at line ~2086, merge at line ~2087). On the mount path the cache is freshly created (empty), so `clear()` is a provable no-op (also idempotent under effect re-runs / StrictMode double-effect). The LRU is **not** reallocated (avoids the ~170 ms constructor cost). `bashTools.current` is intentionally **not** cleared — its only consumer is `tipRegistry.ts` (tip suppression), zero permission/security role; `/clear` clears it separately, so leaving it on resume is at most a cosmetic tip inconsistency, not a vulnerability.

**Tests** — `src/utils/__tests__/resumeReadFileStateClear.test.ts` (4 tests, pins the invariant at the unit-testable seam — the real `FileStateCache` + `mergeFileStateCaches`): merge-only (pre-fix) LEAKS a prior read; clear-then-merge (post-fix) restores exactly the resumed transcript; clear preserves a file the resumed transcript also read (newer timestamp wins); mount-path empty-cache clear+merge is a correct no-op (`merged.size === 1`).

## 5. STAGED — remaining official 2.1.271 security set (occ127 candidates, pending binary verification)

The 2.1.271 changelog carries several more security fixes in the same hardening theme. Each needs per-site ELF decompilation to port faithfully (unavailable here), so all are STAGED — **not** guessed. OCC exposure must be audited per-site before any port:

| Official 2.1.271 entry | Subsystem | OCC note |
|---|---|---|
| "Files produced by **wildcard expansion** are included in shell permission checks" | Bash/permissions | Audit OCC's glob-expansion path against `checkPathConstraints`. |
| "**Variable-declaration flags** can no longer hide the actual command during permission checks" | Bash/permissions | Audit `var x=1; cmd` / `env`-prefix forms in the legacy + AST paths. |
| "Certain **directory-change/subshell/git chains** no longer bypass the outside-workdir read prompt" | Bash/sandbox | Audit `cd /outside && git …` / `( … )` chains. |
| "**Auto-mode inline shell actions** from skills/commands follow default-mode permission rules" | auto mode/permissions | `BASH_CLASSIFIER` is in OCC's FEATURE_ALLOWLIST → likely live; audit. |
| "**Subagent completion** now uses a classifier-reviewed hand-back call" | auto mode/subagents | `TRANSCRIPT_CLASSIFIER` is live; audit `runAgent.ts` hand-back. |
| "**MCP OAuth** client registration handles consent denial, redirect mismatches, concurrent writes" | MCP/OAuth | OCC's MCP OAuth is "simplified" (CLAUDE.md) — verify the registration path exists before porting. |
| "**Org policy** no longer stays cached after credential changes" | org policy/auth | Verify OCC's policy-cache invalidation. |
| "**Signed-out synced skills** are cleaned up instead of persisting indefinitely" | skills/data retention | Audit OCC skill-sync retention. |
| "Unreadable enterprise **managed MCP** config still enforces exclusive MCP control" | MCP/enterprise | OCC trims enterprise/managed surface — likely no-op; verify. |
| "Gateway/Bedrock/Vertex/Foundry sessions no longer refresh unused leftover web logins" | auth/gateway | OCC trims much of this — likely no-op; verify. |

The bulk of the remaining ~75 entries touch subsystems OCC trims by design (cloud/Remote-Control sessions, Claude Tag, VS Code, artifacts publishing, self-hosted runner, mobile QR, Code Review cloud, Windows/PowerShell) → **no-op for OCC**; a few UI/spinner/workflow items may be portable and are left for occ127 triage against the binary.

## 6. Strict self-acceptance results (the issue's "无 gap → 严格自验收" branch)

The self-acceptance pass used OCC's **own REPL on real tasks**, prioritizing recently-added features, focused on consistency with the official. It surfaced the 3 bugs above (each then verified from OCC source alone). Live e2e (all green, against the round's built `dist/cli.js`):

| Surface | Method | Result |
|---|---|---|
| Headless `-p` | `echo "say PONG" \| bun dist/cli.js -p` | PASS — `PONG`, exit 0 (live API key) |
| REPL boot | bare `bun dist/cli.js` in tmux (TTY preserved) | PASS — banner "OCC v2.1.335 · Open C Code" |
| `/hooks` menu (ITEM 45 surface) | tmux REPL `/hooks` | PASS — renders "28 hooks configured" (exercises the fixed `groupHooksByEventAndMatcher` live; no crash) |
| Live model round-trip | tmux REPL "reply with exactly: REPL_OK" | PASS — "● REPL_OK" (57436 tokens) |
| Non-PTY e2e suite | `bun test test/e2e` (non-PTY) | PASS — 10 pass |

**Note on the PTY e2e:** `resume-command-name.e2e` (a PTY test) stalls at its 20 s timeout — git-stash A/B-verified to fail **identically on clean HEAD** (same line, same 20010 ms). This is the documented OCC-11 sandbox constraint ("Live TUI/REPL acceptance e2e is deferred to a non-sandbox environment"), **not** a regression from this round. The live REPL acceptance above was therefore driven through a real tmux session rather than the PTY harness.

## 7. Unit + regression gates

- **New unit tests:** 15 total — ITEM 17 (6) + ITEM 45 (5) + ITEM 35 (4) — **15 pass / 0 fail / 128 expect()**.
- **Regression sweeps (zero new failures):**
  - `src/tools/BashTool/` — **406 pass / 0 fail**.
  - `src/utils/hooks/` — **96 pass / 0 fail**.
  - `src/utils/__tests__/` — **814 pass / 12 fail**; the 12 (`mcpNeedsAuthNotice.test.ts`) are **pre-existing cross-file suite pollution** — git-stash A/B-verified byte-identical (clean HEAD = 810/12, with this diff = 814/12; the +4 pass are my new test, +0 fail), and the file passes 19/19 standalone.
  - permissions **163/163**, compact **21/21** (security reviewer's independent re-run).
  - e2e — **10 pass / 1 fail** (the 1 = the pre-existing PTY stall, §6).
- **Lint:** `biome lint` on the 3 changed source files + 3 new test files — **0 new warnings**. (One `noPrototypeBuiltins` warning my test initially triggered was fixed to `Object.hasOwn`; the 8 remaining repo-wide warnings are pre-existing REPL.tsx "unused biome-ignore suppression" noise — identical count on `git show HEAD:src/screens/REPL.tsx`, my edit added 0 biome-ignore lines.)
- **Build:** `bun run build` green (`dist/cli.js` ~29 MB); rebuilt after the version bump to confirm `2.1.336` compiles clean.

## 8. Security review (ecc:security-reviewer, run synchronously on the diff)

**Verdict: all three fixes CONFIRMED-SOUND. No CRITICAL/HIGH/MEDIUM. "Ship it."** The reviewer traced each fix end-to-end (live permission-pipeline probes for ITEM 17, exhaustive consumer grep for ITEM 45, merge-semantics proof for ITEM 35) and A/B-verified the regression baseline. **No new vulnerability introduced; no remaining bypass in the landed scope; no regression.** Four LOW findings:

1. **LOW (pre-existing, next-round):** `du` (and secondarily `readlink`/`realpath`) remain in `READONLY_COMMANDS` without `PATH_EXTRACTORS` → unprompted outside-workdir **metadata** disclosure (dir names/sizes, symlink targets — not file contents). Same class as ITEM 17; **staged for occ127** (§5 theme). Not introduced by this diff.
2. **LOW (fixed this round):** the ITEM 17 test comment misattributed the `/usr/bin/fmt` gate to "read-only auto-allow"; it is actually the **step-8 prompt** (READONLY regexes are `^cmd`-anchored, so `/usr/bin/fmt` does not match `isReadOnly`). Comment corrected; behavior is fail-closed and at parity with `/usr/bin/cat`.
3. **LOW (style, not a defect):** ITEM 45 re-creates buckets in place after the literal rather than building them null-proto initially. Object-literal syntax can't express null-proto buckets directly; the in-place loop is clear and documented. No change.
4. **LOW (pre-existing, fail-closed):** ITEM 35 — resume clears `readFileState` but not `loadedNestedMemoryPathsRef`/`discoveredSkillNamesRef` the way compact/`/clear` do. Fail-closed direction only (the model must `Read` before editing a nested CLAUDE.md). Not changed by this diff; recorded as an observation.

## 9. Release

3 genuine security/crash fixes landed (corroborated by the official 2.1.271 changelog) → a real patch release is warranted (unlike OCC-40's no-op, which correctly refused to bump). Flow per the issue body + CLAUDE.md "Release Workflow":

1. `CHANGELOG.md` — add `## 2.1.336 - 2026-09-16 (OCC-126)` section (this round's 3 fixes + the staged 2.1.271 set).
2. `package.json` — bump `2.1.335` → `2.1.336` (monotonic; OCC's own counter, independent of the upstream "Tracks" badge).
3. README "Tracks: Claude Code **2.1.270**" badge — **unchanged** (no full byte-verified catch-up to 2.1.271/2.1.272 this round; landing 3 corroborated parity fixes does not warrant claiming 2.1.272 alignment).
4. Commit → merge to `main` → `git tag v2.1.336` → push tag → `.github/workflows/publish.yml` (build → set version → npm publish → Create GitHub Release).
5. Acceptance: `gh api repos/cnwenf/occ/releases` count == `/tags` count, `comm -23 <(tags) <(releases)` empty; report the Release link back to the issue.

## 10. Round mapping note

Multica daily-issue numbers (OCC-84/85/87) and repo-internal round numbers (OCC-122…126) are **two interleaved sequences**. This Multica issue **OCC-87** maps to repo round **occ126** (this ledger). README cross-references both.
