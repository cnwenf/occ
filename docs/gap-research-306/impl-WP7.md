# impl-WP7 — Screen-reader fixes + workflow journal warn + spawn-mode saved-folder messages

**WP:** 7 (implementation)
**Official baseline:** Claude Code 2.1.305 (v306 reference binary at `/tmp/cc-diff-306/v306/package/claude`, read-only, never executed)
**Research inputs:** `docs/gap-research-306/research-R5-ui-consent-workflow.md` (Items 1, 3), `docs/gap-research-306/research-R6-skip-triage.md` (item 7)
**Date:** 2026-10-22

## TASK A — Screen reader mode fixes (R5 Item 1, PORTED)

### A.1 SearchBox SR prefix swap — `src/components/SearchBox.tsx`

Official v305 (binary `claude` @258374354, byte-verified):

```
ce = L && V===A2o ? (d ? "Search:" : null) : V     // L=ot()=isScreenReaderEnabled, A2o="⌕", V=prefix, d=query
Oe = ce===null ? d : `${ce} ${d}`                   // rendered text
Ye = ce===null ? 0 : ce.length+1                    // caret column offset
```

v304 rendered `⌕` unconditionally; VoiceOver read it as "telephone recorder".

OCC port:

- `effectivePrefix = srEnabled && prefix === "⌕" ? (query ? "Search:" : null) : prefix`
- Caret column: `effectivePrefix === null ? stringWidth(query.slice(0, offset)) : stringWidth(effectivePrefix) + 1 + stringWidth(query.slice(0, offset))` — stringWidth keeps OCC's display-cell convention ("Search:" is ASCII so cell width === official `.length`).
- Render (t10 memo, dep key updated `$[6] !== effectivePrefix`): null prefix drops both symbol and separator space, matching official `Oe`.
- A caller-supplied non-`⌕` prefix is kept verbatim under SR (official `:V` arm).

### A.2 PromptInput SR gate on the segmented highlight renderer — `src/components/PromptInput/PromptInput.tsx`

Official v305 (binary `o4t` @257777212, byte-verified): adds `!ne` (`ne = ot() = isScreenReaderEnabled`) to the highlight-render switch — `if(V&&V.length>0&&!W&&!ne)` — and the SR fallthrough renders the plain full input value in a single Text: `Re=W?...:e(n,{"aria-preserve-whitespace":!0,children:e(Xo,{children:u})})`. Also `hidePlaceholderText:m||ne` (m = isVoiceRecording). The per-char shimmer segmentation made screen readers announce "spaces inside words".

OCC port — **gate applied at the highlights source in PromptInput baseProps** (~:2497):

```ts
const srEnabled = isScreenReaderEnabled();
...
highlights: srEnabled ? undefined : combinedHighlights,
...(srEnabled ? { hidePlaceholderText: true } : {}),
```

**Placement deviation (documented):** the actual `hasHighlights` switch lives in `src/components/BaseTextInput.tsx:105-107`, which is NOT in this WP's allowed touch list. Gating at the source produces identical observable behavior: `highlights: undefined` makes BaseTextInput fall through to its plain `<Ansi>{renderedValue}</Ansi>` single-Text path — structurally the official SR fallthrough — for both the TextInput and VimTextInput routes (both spread `{...props}` into BaseTextInput).

**Attribute deviation (documented):** `aria-preserve-whitespace` is unsupported in OCC's ink fork (0 hits across `src/ink/`, `packages/@ant/`, `src/ink/components/Text.tsx` props). Per task instruction, that attribute alone is skipped; the plain full-value Text render is kept.

`hidePlaceholderText` is threaded via a conditional spread because `BaseTextInputProps` doesn't declare the key (TS excess-property checks don't flag spread-introduced keys; at runtime `TextInput.tsx:124` spreads `{...props}` last so the parent value wins over the default `hidePlaceholderText={isVoiceRecording}`).

### A.3 Tests

- `src/components/__tests__/searchBoxScreenReader287.test.tsx` (extended): existing SR caret tests updated to the v305 columns ("Search:" = 7 cells + 1 space → offsets 10/8/9/10 incl. CJK display-cell case); SR flat-render test now asserts `Search:` present / `⌕` absent. New describe block (4 tests): SR-on empty query → no prefix at all + caret column 0 (official null arm + `Ye=0`); SR-off → `⌕` unchanged; SR-on custom prefix (`>`) kept verbatim. **13 pass / 0 fail, 49 expect().**
- `src/components/PromptInput/__tests__/promptInputScreenReader305.test.tsx` (new): full PromptInput render is infeasible (~40 props, 26 context hooks), so two-layer strategy — (1) source-wiring pin on PromptInput.tsx (4 tests: import, `srEnabled` computation, highlights gate, hidePlaceholderText spread; repo precedent `remoteControlHelp302.test.ts` etc.); (2) downstream-contract behavior through the REAL BaseTextInput with a `mock.module` spy on `HighlightedInput` (ShimmeredInput.tsx): SR-off shape → segmented renderer called with highlights; SR-on shape (`highlights: undefined` + `hidePlaceholderText: true`, computed from the real `isScreenReaderEnabled()` via `CLAUDE_AX_SCREEN_READER` + `screenReader.reset()`) → spy never called, plain value rendered, placeholder hidden; SR-off placeholder still renders. **8 pass / 0 fail, 16 expect().**

## TASK B — Workflow journal save-failure warning (R5 Item 3, DONE)

`src/tools/WorkflowTool/primitives.ts` (~:756): the silent `.catch(() => {})` on `journal.appendResult(...)` replaced with the official warn (binary `claude` @260784887, byte-verified; novel s305 string, 0 hits in s304):

```
workflow journal: did not save an agent() result, so a resumed run will re-run from this call: ${errorMessage(e)}
```

emitted via OCC's `logForDebugging(message, { level: 'warn' })` (`src/utils/debug.js`); `errorMessage` imported from `src/utils/errors.js`. The agent result is still returned either way.

**Deviation (documented):** official additionally detaches the journal writer (`St()`) after a failed save; OCC's `WorkflowJournal` exposes no detach API, so the warn is the portable half of the fix.

Test — `src/tools/WorkflowTool/__tests__/journalSaveWarn305.test.ts` (new): `mock.module` runAgent (async generator yielding one assistant text message) + debug.js spy (spread-real convention per `forkSubagentSourceValidation302.test.ts`, restored in afterAll). 3 tests: rejecting `appendResult` → exact official message + `level:'warn'` + result still returned + agent counted with no failure recorded; healthy journal → silent; no journal → silent. **3 pass / 0 fail, 11 expect().**

## TASK C — Remote-control spawn-mode saved-folder messages (R6 item 7, DONE)

`src/bridge/bridgeMain.ts` (both strings byte-verified via `grep -F 'Saved for this folder' /tmp/cc-diff-306/new305.txt`; binary @131021234 / @131013750):

- **(a) w-toggle handler** (~:2803): both `logStatus` arms now end with `. Saved for this folder; w switches back.`
- **(b) startup announcement** (~:2461, immediately after the spawn-mode precedence block, matching official placement): `if (spawnModeSource === 'saved' && worktreeAvailable)` → `console.log(`Spawn mode: ${spawnMode} (saved for this folder${process.stdin.isTTY === true ? '; press w to change' : ''})`)` (`worktreeAvailable` from the capability probe at :2365 is in scope).

Test — `src/bridge/__tests__/spawnModeSavedFolder305.test.ts` (new): source-pin test (6 tests) — both exact status strings, no pre-v305 suffix-less shape, gate condition, exact console template, and ordering after the `gate_default` precedence arm. **Why not a runtime test:** the surface is dead code in this build (`feature('DAEMON') && feature('BRIDGE_MODE')` — neither flag is in OCC's FEATURE_ALLOWLIST) and the logic sits inside bridgeMain's giant closure with no exported seam; source-string pinning has repo precedent. No existing test covered these strings (nothing to update). **6 pass / 0 fail, 7 expect().**

Note: an initially added `biome-ignore lint/suspicious/noConsole` comment on the new `console.log` was removed — `noConsole` is `"off"` in `biome.json`, so it registered as an unused suppression (warning).

## Verification

| Check | Result |
|---|---|
| `bun test` searchBoxScreenReader287 | 13 pass / 0 fail |
| `bun test` promptInputScreenReader305 | 8 pass / 0 fail |
| `bun test` journalSaveWarn305 | 3 pass / 0 fail |
| `bun test` spawnModeSavedFolder305 | 6 pass / 0 fail |
| `bun test src/components/PromptInput/__tests__/` (full dir) | 70 pass / 0 fail |
| `bun test src/tools/WorkflowTool/__tests__/` (full dir) | 69 pass / 0 fail |
| `bun test src/bridge/__tests__/` (full dir) | 56 pass / 0 fail |
| All 4 WP7 test files together | 30 pass / 0 fail / 83 expect() |
| `bunx biome lint` — 6 clean files (SearchBox.tsx, PromptInput.tsx, all 4 test files) | **0 errors, 0 warnings** |
| `bunx biome lint` — bridgeMain.ts, primitives.ts | 0 errors; warnings are pre-existing only (`suppressions/unused` on untouched biome-ignore comments; `noConfusingVoidType` at primitives.ts:421/973 — both pre-existing code) |

No repo-wide `bun test` run (per task rules). No `⌕` assertions exist anywhere else in the test tree (grep-verified), so the SR prefix swap breaks no other suite. SearchBox consumers (FuzzyPicker, SkillsMenu, Config, plugin menus) render with SR off in tests — that path is byte-identical to before.

## Deviations summary

1. **PromptInput gate placement** — at the baseProps source, not at BaseTextInput's `hasHighlights` switch (file outside allowed touch list). Observably equivalent (plain single-Text fallthrough on both TextInput and VimTextInput routes).
2. **`aria-preserve-whitespace` skipped** — attribute unsupported by OCC's ink fork; documented per task instruction.
3. **Journal-writer detach skipped** — OCC's WorkflowJournal has no detach API; the warn (the portable half) landed.
4. **Bridge runtime test replaced by source pin** — dead-code surface behind two non-allowlisted feature flags, no exported seam; rationale documented in the test header.

## Files touched

- `src/components/SearchBox.tsx`
- `src/components/PromptInput/PromptInput.tsx`
- `src/tools/WorkflowTool/primitives.ts`
- `src/bridge/bridgeMain.ts`
- `src/components/__tests__/searchBoxScreenReader287.test.tsx` (extended)
- `src/components/PromptInput/__tests__/promptInputScreenReader305.test.tsx` (new)
- `src/tools/WorkflowTool/__tests__/journalSaveWarn305.test.ts` (new)
- `src/bridge/__tests__/spawnModeSavedFolder305.test.ts` (new)
- `docs/gap-research-306/impl-WP7.md` (this report)

Not committed (per task rules).
