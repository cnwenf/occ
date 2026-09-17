# Upstream Version Gap — OCC-89 (2026-09-18 daily round: no upstream gap; strict self-acceptance found 3 real gaps incl. a P0 feature-dead bug)

**Round:** OCC-89, 2026-09-18 (autopilot daily)
**OCC entering state:** `2.1.339` (npm `@cnwenf/occ` latest; aligned to official **2.1.274** by the OCC-127 catch-up, `bc8b6cc`/`4442cc5`)
**Official target this round:** re-verify latest — **2.1.274** (npm `latest` == `next` == 2.1.274; GitHub `CHANGELOG.md` top entry 2.1.274; both re-checked at round start). **No version gap** → per the issue's 自验收 instruction this round is strict self-acceptance: run OCC like a human user, A/B against official `claude` 2.1.274 in the identical environment, and treat every inconsistency as a gap.

## 1. Self-acceptance — green items

| Check | Result |
|---|---|
| Build | green — `dist/cli.js` 29.07 MB, `MACRO.VERSION=2.1.339`, runs under `bun dist/cli.js` |
| `-p` headless smoke | `echo "say PONG" \| occ -p` → PONG, exit 0 |
| REPL boot | tmux banner + trust dialog path clean |
| `/status` | Version 2.1.339, model glm-5.2 via custom base URL |
| Model round-trip | REPL-ROUNDTRIP-OK (53,633 tokens) |
| Recent-feature suites | 2.1.273/274 unit suites 79 + 67 pass; full BashTool + modeSwitch273 489 pass / 0 fail / 987 expect |

## 2. A/B vs official 2.1.274 — Gap-89a (P0, FIXED): bash mode `!cmd` silently dead

**Symptom.** In OCC's REPL, typing `!touch /tmp/x` + Enter clears the input and resets the mode but **executes nothing** — no transcript entry, no file, no error anywhere in the UI. Official `claude` 2.1.274 (fresh npm install at `/tmp/occ89-official`, run in the *identical* tmux environment) executes the same command, renders `! touch …` + `⎿ (Bash completed with no output)` in the transcript, and starts the respond-turn. The previous round (OCC-88) misdiagnosed this as a pre-existing environment artifact based on OCC-vs-OCC comparison only; the official-vs-OCC A/B in the same env disproves that.

**Root cause (bundle-level, deterministic).** `src/utils/processUserInput/processBashCommand.tsx` declared `let jsx: React.ReactNode;` (present since the initial commit). With the automatic JSX runtime, `<BashModeProgress … />` transpiles to a bare `jsx(…)` identifier that Bun's bundler resolves to the **innermost user binding of the same name** — the local and the runtime import silently merge into one renamed slot in the bundle:

```js
let jsx434;                                   // the local, still undefined
setToolJSX({ jsx: /* @__PURE__ */ jsx434(BashModeProgress, { … }) });   // TypeError
```

Every bash-mode submit therefore throws `TypeError: jsx434 is not a function` at the first `setToolJSX`. The submit path is fire-and-forget (`void onSubmit(input)`), so the rejection only reaches the global `unhandledRejection` handler (`gracefulShutdown.ts` → `logError`) — debug-log-only, zero UI signal. Repro with `--debug --debug-file=…` captured:

```
[ERROR] TypeError: TypeError: jsx434 is not a function. (In 'jsx434(BashModeProgress, {
    at processBashCommand (…/dist/cli.js:792724:26)
```

Bundle-wide scan: **exactly 2** bare `@__PURE__ */ jsxNNN(` call sites in the 29 MB bundle (792724, 792742) — both in `processBashCommand` (initial progress UI + `onProgress`). Every other JSX site uses the safe `jsx_runtimeNNN.jsx(…)` namespace form. Bash mode was dead in every shipped bundle carrying this shape.

**Fix.**
- `processBashCommand.tsx`: local renamed `jsx` → `backgroundJsx` (with a note documenting the hazard).
- Class-wide hardening: the other four exact-`jsx` bindings in `.tsx` sources renamed (each currently bundles correctly via the namespace form, but is one bundler-version away from the same silent merge): `PromptInput.tsx` option-meta hint → `hintJsx`; `REPL.tsx` immediate-command result → `commandJsx`; `processSlashCommand.tsx` `.then(jsx =>` → `commandJsx`; `rate-limit-options.tsx` `.then(jsx =>` → `upgradeJsx`.
- **Regression guard:** new `test/jsxRuntimeShadowing.test.ts` — source-scans every non-test `src/**.tsx|.jsx` for bindings named exactly `jsx`/`jsxs`/`jsxDEV` (let/const/var declarations, destructuring, arrow + function params; type-only signature params excluded — erased at compile time) and self-checks its patterns against the historical positive/negative shapes.

**Verification.** Fresh bundle: 0 bare `jsxNNN(` sites; `processBashCommand` region shows `jsx_runtime442.jsx(BashModeProgress, …)` + separate `backgroundJsx`. Live tmux on the rebuilt CLI: `!touch /tmp/occ89-bang4` → file created, transcript renders `! touch …` + `⎿ (Bash completed with no output)`, respond-turn starts (matches official `respondToBashCommands` default); `!echo BANG89-STDOUT-$(date +%s)` → output `BANG89-STDOUT-1789667224` rendered.

## 3. Gap-89b (P1, FIXED): `CLAUDE_CODE_DEBUG_LOGS_DIR` pointing at a directory hard-crashed the app

While instrumenting Gap-89a, `CLAUDE_CODE_DEBUG_LOGS_DIR=/tmp/occ89-debug bun dist/cli.js --debug` **killed the whole process** on the first debug write: OCC's `getDebugLogPath()` returned the raw env value as the *file* path → `appendFileSync` on a directory → unhandled `EISDIR`.

**Official 2.1.274 semantics (byte-verified in the ELF):** the env var is a **directory** — the debug-log manager resolves it with `resolveDirToFile(dir)` = `join(dir, \`${sessionId}.txt\`)`, `logPath()` prefers the learned `overrideDirectory` join, and a failed raw append recovers to `<dir>/<sessionId>.txt`.

**Fix (minimal faithful port).** `src/utils/debug.ts`: the sync writer's append now goes through `appendFileSyncWithDirFallback` — on `EISDIR` it resolves to `join(path, \`${sessionId}.txt\`)` (official `resolveDirToFile` semantics), memoizes the result (`dirFallbackLogPath`) so every subsequent write *and* the `latest` symlink follow the real file, and re-throws all non-EISDIR errors. The official's full rotation/storageV5 manager was **not** ported (much larger subsystem; no other observable divergence on this path). Tests: `src/utils/__tests__/debugLogsDirEisdir274.test.ts` (dir recovery + append continuation, plain-file passthrough, non-EISDIR propagation). Live: the exact previously-crashing invocation now boots and writes `/tmp/occ89-debug2/<sessionId>.txt` + `latest` symlink.

## 4. Gap-89c (P2 cosmetic, FIXED): bash-mode footer hint text

OCC rendered `! for bash mode` (`PromptInputFooterLeftSide.tsx:318`). Official 2.1.274 ELF: **5** hits of `! for shell mode` (incl. `e(n,{color:"bashBorder",children:"! for shell mode"})` for the `mode==="bash"` branch), **zero** hits of `! for bash mode`. OCC-110 byte-aligned `PromptInputHelpMenu.tsx` but missed this footer site. Fixed to `! for shell mode`; bundle now 2 hits new / 0 old; live footer confirmed.

**Noted, not ported:** the official footer also surfaces a `← for agents` hint — that belongs to the trimmed agents surface (documented by-design trim), not alignment debt.

## 5. Verdict + release

- Upstream gap: **none** (official latest 2.1.274 == OCC's tracked upstream). Self-acceptance found 3 real gaps — 1 P0 (bash mode dead in every bundle), 1 P1 (env-dir debug crash), 1 P2 (footer text) — **all fixed, tested, live-verified** this round.
- New/changed: `processBashCommand.tsx`, `PromptInput.tsx`, `REPL.tsx`, `processSlashCommand.tsx`, `rate-limit-options.tsx`, `PromptInputFooterLeftSide.tsx`, `debug.ts`, + `test/jsxRuntimeShadowing.test.ts`, `src/utils/__tests__/debugLogsDirEisdir274.test.ts`.
- Test gates: every diff-relevant suite green standalone + combined (61 + 21 + 38 + 18 + 15 + 19 + 6 + 3 + 2 pass / 0 fail); biome lint clean; build green; live tmux REPL e2e (bash-mode execute + stdout render + footer + debug-dir boot). NOTE: the single-process `bun test src` monolith run carries a PRE-EXISTING order-dependent mock leak (minimal repro on files unmodified vs origin/main: `permissionDenialMisreport.test.ts` mocks `SandboxManager` → leaks into `unknownCommandParity251.test.ts` → `isSupportedPlatform is not a function`; every failing file passes standalone) — not caused by and not related to this round's diff; test-isolation cleanup is a candidate follow-up.
- Release: **2.1.340** (bash-mode P0 fix warrants a patch release), tag `v2.1.340` → `publish.yml`.
