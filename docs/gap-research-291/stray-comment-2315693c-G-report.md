## OCC-109 developer report — scoped 5-item subset (clusters G + D)

My assigned items are **complete & verified**. Sibling cluster agents (A/B/C/E + G/B research) are coordinator-owned and still landing — out of scope for this report.

### Item status
| Item | State |
|------|-------|
| **G#5** binary-file message | DONE |
| **G#7** essential-traffic preconnect gate | DONE |
| **G#9** line-break filename escaping (file-tool errors + permission prompts) | DONE |
| **D#1** plan-mode classifier structural gate | DONE |
| **G#8** WebSearch hourly refill budget | **SKIPPED** (was optional — see below) |

### Files created (9)
1. `src/utils/displayEscape.ts` — verbatim port of the official 2.1.291 escaper (`&#NN;` for control chars incl. U+2028/U+2029, `<>` escape, plain-path test)
2. `src/utils/__tests__/displayEscape.test.ts` — 8 tests
3. `src/tools/FileReadTool/__tests__/binaryFileMessage291.test.ts` — 3 tests (G#5)
4. `src/tools/FileWriteTool/__tests__/dirPathEscape291.test.ts` — 2 tests (real temp dir named `evil\napproved`)
5. `src/tools/FileEditTool/__tests__/fileNotFoundEscape291.test.ts` — 1 test
6. `src/utils/__tests__/apiPreconnectEssentialTraffic.test.ts` — 2 tests (G#7)
7. `src/utils/permissions/planModeClassifierGate.ts` — D#1 pure helper (`shouldHonorClassifierAllow` + `PLAN_MODE_FLOOR_REASON`)
8. `src/utils/permissions/__tests__/planModeClassifierGate.test.ts` — 8 tests
9. `src/components/permissions/__tests__/displayEscapeWiring291.test.ts` — 4 tests (component-load smoke)

### Files modified (10)
1. `src/tools/FileReadTool/FileReadTool.ts` — G#5 message (:633) + G#9 escaping (device-file, file-not-found)
2. `src/tools/FileEditTool/FileEditTool.ts` — G#9 file-not-found escaping
3. `src/tools/FileWriteTool/FileWriteTool.ts` — G#9 isDirectory/non-regular errorCode escaping
4. `src/utils/apiPreconnect.ts` — G#7 gate (`isEssentialTrafficOnly()` → return, :51)
5. `src/utils/permissions/permissions.ts` — D#1 wiring (import :58-60, guard :1129, floor reason :1143)
6. `src/Tool.ts` — D#1 `isReadOnly(input, context?)` optional 2nd param (:453, backward-compatible)
7. `src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx` — G#9 title+subtitle escape
8. `src/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx` — G#9
9. `src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx` — G#9
10. `src/components/ShowInIDEPrompt.tsx` — G#9 (escape displayed `symlinkTarget` + title; keep `.startsWith("..")` logic on the raw value)

### Tests
- Consolidated affected-suite run (my scope): **393 pass / 1 skip / 0 fail, 1022 expect() across 41 files** (`bun test src/tools/FileReadTool src/tools/FileEditTool src/tools/FileWriteTool src/utils/permissions src/tools/WebSearchTool` + new tests).
- Per item: G#7 2 pass; D#1 helper 8 pass + 296-test permissions-suite regression green; G#9 component smoke 4 pass; escaper unit 8 pass.
- Biome lint on all changed files: clean.
- Not re-run after this point to avoid racing sibling agents' in-flight edits to shared files (see collision note below).

### G#8 — SKIPPED (optional item, "only if time remains")
Two independent blockers:
1. **File-scope conflict** — the doc's 移植方案 requires edits to `sessionLimits.ts` + `taskRegistry.ts`, outside my declared `src/tools/WebSearchTool/*` scope and likely owned by concurrent agents (78-file session scope warning). Editing them risks collision.
2. **Elided internals** — the official `u()` refresh body and the `f`/`s` in `msUntilNextCall()`'s `(f+1)*ne-s` are `…`-elided in the doc → a verbatim port is impossible, and "never invent semantics" forbids guessing.

Recommend a follow-up agent that owns `sessionLimits.ts` / `taskRegistry.ts`.

### Deviations + justification
- **G#9 file-not-found**: whole-message `escapeControlCharsAsEntities(message)` wrap (binary-faithful to official `ad(Wt)`/`ad(ot)`) — a superset of the doc's per-interpolation instruction; safer and matches the decompile.
- **D#1 `_rn` reduction**: reduced the official plan-branch to `parseOk && tool.isReadOnly(parsedInput, context)`. `ignoresWholeToolAllowRule` is not on OCC's Tool interface → treated false/inert (allowRuleHint.ts precedent); the `|| vye(...)` whole-tool-ignore OR-branch has no OCC surface → omitted (fails safe toward ask). mcpServerPolicy branch N-A per doc — not added.

### Out-of-scope observations
- **apiPreconnect URL divergence** (pre-existing, NOT changed): OCC fetches `baseUrl` directly; official fetches `${baseUrl}/api/hello`. G#7 is only the gate — flagged for a future round.
- **Permission-component display assertion** is the doc's e2e/tmux capture case (cluster-g line 281), deferred per the OCC-11 sandbox constraint; the escaper is unit-proven and wired through a real code path in `dirPathEscape291.test.ts`.
- **Shared-file collision point**: `src/utils/permissions/permissions.ts` is edited by my D#1 **and** likely by Port-A (bash permissions) / Port-B (read-deny guards). My D#1 wiring is intact on disk as of this report. Coordinator should re-run the full permissions suite after all cluster edits land to confirm no clobber.

No commits/builds made (per task constraints). Downstream handoff (security review → acceptance) left to the coordinator once all clusters integrate — no @mention here to avoid triggering review on incomplete work.