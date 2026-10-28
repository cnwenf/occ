# Upstream version gap — OCC-136 round (official claude-code 2.1.311 → 2.1.312 alignment)

Date: 2026-10-29 · Trigger: OCC Leader patrol order (comment `b16b0426`) · Issue: OCC-136
Research artifacts: `docs/gap-research-312/` (README + `triage-port.md` + `triage-na-staged.md`)

## §1 Version facts (three-way verified, 2026-10-29)

| Source | Value |
|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.312** (published 2026-10-27T18:36:10Z); `stable` = 2.1.308 |
| Official CHANGELOG 2.1.312 | **39 items** (25 unbracketed + 14 bracketed surface-specific) |
| v312 linux-x64 ELF | 293,592,432 B, md5 `be77f401c2b9c1c79c98f828abe8a6e7` |
| v311 linux-x64 ELF | 293,776,752 B, md5 `e41a6ebc58e3e5ccf4d4544d910d0bdb` (matches occ135 ledger ✓) |
| OCC pre-round | package.json 2.1.405, tracks **2.1.311** |
| String diff v311→v312 | 16,605 new / 16,871 removed unique strings |

## §2 Method

Read-only byte forensics on the official Bun-compiled ELFs (`npm pack` both versions; binaries
NEVER executed): `strings -n 8 | sort -u` + `comm` for the delta set; `grep -boF` byte offsets +
seek-based python context windows (`fx.py`; `dd bs=1` too slow on 293 MB); `grep -oE '.{80}….{80}'`
bounded-context extraction for huge minified lines. Every string ported was re-verified verbatim
at its pinned offset before landing (per `aligning-with-official-binary`: don't trust subagent
summaries — the orchestrator re-checked all byte claims used in direct ports).

## §3 Triage tally (39 changelog items + env sweep)

| Verdict | Count | Items |
|---|---|---|
| **PORT** | **11** | 2, 4, 5, 8, 9, 14, 15, 16, 20, 22, 23 (9+16 folded: one `sentEffort` change) |
| **STAGED** | **1** | 18 (simple-system-prompt for unrecognized provider model names — contested per Leader order) + item 4's `tengu_velvet_possum` top-level-cut sub-part (gate default false upstream) |
| **N-A** | **27** | 1, 3, 6, 7, 10, 11, 12, 13, 17, 19, 21, 24, 25 + all 14 bracketed [VSCode]/[Cloud sessions]/[Remote Control]/[Claude Tag]/[Code Review] + 2 new env names |

Per-item byte evidence: `docs/gap-research-312/triage-port.md` (PORT) and
`docs/gap-research-312/triage-na-staged.md` (N-A/STAGED, incl. honesty notes — items 6/10/11
official deltas NOT isolable by string diff; verdicts rest on OCC-side conclusiveness).

Env sweep: `+CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP` (@239090454), `+CLAUDE_CODE_REMOTE_TOOLS_HOST_IDLE_RELEASE_MINUTES` (@239092149) — both N-A (artifacts-MCP host guard / remote-tools host idle release; surfaces absent). `-CLAUDE_CODE_MCP_HANDED_LISTINGS` — never ported (occ135 STAGED) → no-op.

## §4 Work packages → features (agent → WP → landing commit)

Parallel file-disjoint work packages on the shared tree; subagents forbidden from all git ops
(orchestrator checkpoint-commits). Base: main @6860986a (2.1.405).

| WP | Item(s) | Feature | Landing commit |
|---|---|---|---|
| WP-A (agent) | 9 + 16 | `sentEffort` in-force effort state: new slot (`src/utils/effort/sentEffort.ts`), wire capture (`claude.ts` message_start/assistant), REPL population + reset, 4-param `getEffortSuffix` (≡ `Sbn` @243469955), Spinner, `isEffortChangePending` (≡ `uT` @276688231) + `may wait for your next message` note | `b2910dc5` |
| WP-A (agent) | 2 | click-to-send-now: `src/utils/sendNow.ts` resolvers, pressable fullscreen `SendNowHint`, literal `click to send now`, telemetry `input_send_now_click`/`no_handler_took_it` | `b2910dc5` |
| WP-B (agent) | 14 | vim `gj`/`gk` `rowsRunOut` move-only guard in `executeOperatorMotion` (≡ `q` @259579735 / `le` @259587549, strict `<`) | `b2910dc5` |
| WP-E (agent) | 22 | two-tier hook session slots: 24/session + 12 overdue + 1 s timeout floor + 10 s keepalive grace (`hookSessionSlots312.ts`, constants @251761428; semaphore ≡ `byt` @250558442; ALS reentrancy guard); 302-era single-tier cap superseded | `b2910dc5` |
| orchestrator-direct | 15 | `/verify` short `menuDescription` "Try your change and report if it works" (@258727734) | `fadf32e7` |
| orchestrator-direct | 20 | "session limit" → "5-hour limit" (`Hce` @246569205) + `clampSurpassedThreshold`/Over% early-warning branch (`Ke`/`$t` @246573773/@246574430) | `fadf32e7` |
| orchestrator-direct | 23 | subagent `autoCompactWindow` caps the env window (v312 `VS` @249961062 — env exemption deleted) | `fadf32e7` |
| WP-F (agent) | 4 | eviction-proof `startOnly` Write guard: `FileStateCache.markStartOnly/holdsOnlyStartOf` (≡ `Sa` @244819043), verbatim `e7o` guidance (@241153419, `allow_large` resolved @240867722), errorCode 19 before not-read branch (@249830441), call-path throw (@249832895), nested head-cut marking (@251721817), watcher reseed (@251734727) | `2518f3bb` |
| WP-G (agent) | 5 | skills discovery survives `cd`: stable base + worktree ctx (≡ `Sq` @251527988), `deferredSkillDirs` three-state confirm/skip/defer (≡ `eNo` @251524152), verbatim `[skills] Skipped …` logs, stale-base eviction | `2518f3bb` |
| WP-H (agent) | 8 + 22-follow-up | cleanup rmdir race guard (≡ @259860697: leftovers OR mtime < cutoff; `getMtimeMs` ≡ `Q` @259855632); `execPromptHook`/`execAgentHook` inner timeout via `BM` (@251763592 default 30000 / @251774554 default 60000) | `2518f3bb` |

Documented deviations per WP (full list in `triage-port.md` per-item "Deviation/Honest notes"):
item 9/16 OTel span-attr leg identical 311/312 (pre-existing OCC OTel stub, untouched) + official
10 s transient notification deliberately not adopted (steady borderText kept); item 14 `le`
wantedColumn walk not ported (OCC `resolveMotion` preserves display column); item 22 waitLimitMs =
session ctx limitMs, floor prompt/agent only, single module singleton (not host-keyed); item 8
outer session/project rmdirs left unguarded (not pinned in official delta).

## §5 Test + e2e evidence

Unit/component (TDD RED→GREEN per WP, bun 1.3.14):

- WP-A: `effortSuffix312` 7, `sendNowHintClick312` 8, extended `effortIndicator304`; regression 338 pass (effort/sendNow/Spinner/PromptInput) + 746 pass (`services/api`) + 76 pass (REPL tests)
- WP-B: `gjGkRowsRunOut312` 9; `bun test src/vim` 127 pass
- WP-E: `hookSessionSlots312` 15; `bun test src/utils/hooks` 309 pass
- WP-F: `startOnlyGuard312` 24; FileWriteTool dir 72 pass; attachments/fileStateCache/guard consumers 103 pass
- WP-G: `skillCdRediscovery312` 9; `bun test src/skills` 109 pass
- WP-H: `cleanupFreshToolResults312` 6 + existing cleanup suites 12 pass; `hookTimeoutFloor312` 11 + hook-executor regression 65 pass
- orchestrator items 15/20/23: `verifyMenuDescription312` 3; `rateLimitMessages312` 15 + 299-suite 19 combined; autoCompactWindow suites 43 pass

Full CI suite (`scripts/ci-test.sh`, per-file process isolation): first pass 14,832 pass / 15 skip
with 128 fails across 36 files — 35 of them were missing-`dist/cli.js` artifacts (`test/e2e/*`,
`launcher.test.ts`, `forwardSubagentText.test.ts` all spawn the built entrypoint; `Module not
found "…/dist/cli.js"`); after `bun run build`, every one of the 35 passes on individual re-run.
Sole remaining failure: `argumentSubstitutionCaps301.test.ts` (1 test — "budget covers named-arg
values too"), a documented local-bun-1.3.14 environment artifact (CI pins bun 1.4.2); unrelated to
this round's surfaces.

Known pre-existing harness artifact (NOT introduced this round; verified by A/B with all round
changes stashed): running `memoryFileHeadCut309.test.ts` + `readTool281.test.ts` in the SAME bun
process fails 6 (mock.module leak class documented in `scripts/ci-test.sh` header). CI's per-file
isolation is unaffected.

Build (`bun run build`): GREEN — `dist/cli.js` 30.58 MB, `MACRO.VERSION` 2.1.405 (pre-bump),
`bun dist/cli.js --version` → `OCC 2.1.405`.

Real e2e (per Leader order — tmux real REPL round-trip + headless `-p` real-model round-trip), both
GREEN against the live glm-5.2 endpoint (`ANTHROPIC_BASE_URL` proxy; `[claude-code:unrecognized_model]`
warning expected and benign):

- Headless `-p`: `echo "Reply with exactly one word: PONG" | bun dist/cli.js -p` → `PONG`, exit 0.
- tmux real REPL (200×50 detached session, built `dist/cli.js`, poll-until-text): boot → ready in
  3 s (`⏵⏵ bypass permissions on (shift+tab to cycle)`); sent the same prompt → real-model
  `● PONG` round-trip (28,837 tokens counted); `/ver` menu live-verified — `/verify` row shows the
  ported item-15 short `menuDescription` "Try your change and report if it works (bundled)";
  effort indicator border (`● high · /effort`) renders the in-force level per item 9/16 semantics;
  clean exit (Esc → Ctrl-C ×2), session killed, no leaks.

Prior-round accepted LOWs (tombstone uuid validation, MCP reconnect error redact,
startupSecurityWarnings seen timing): not hardened this round (Leader: optional, not mandatory).

## §6 STAGED follow-ups (next rounds)

1. **Item 18** — shorter system prompt for unrecognized Bedrock/Vertex/Foundry/Mantle model names
   (`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` opt-out). Contested per Leader order; needs a dedicated
   prompt-builder forensics round. Trigger: prompt-leg round in scope, or user report of broken
   custom deployment names/inference-profile ARNs.
2. **Item 4 velvet_possum sub-part** — top-level CLAUDE.md head cut (@257559298, gate
   `tengu_velvet_possum` default false upstream) + `announced_file_cut` telemetry. Trigger: gate
   flips default-true in a later ELF.
3. Carried from prior rounds (unchanged): `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`
   and the occ135 §6 backlog.

## §7 Release

- OCC version 2.1.405 → **2.1.406**; CHANGELOG `## 2.1.406 - 2026-10-29` section added; README
  Tracks 2.1.311 → **2.1.312** (4 spots: badge, intro, capability-parity row, tracking list —
  OCC-135 history retained verbatim in-line); merged to `main` (`--no-ff`); tag `v2.1.406` pushed
  → `publish.yml` triggered. npm publish expected to fail on the expired NPM_TOKEN (OCC-127/129
  debt — GitHub Release + tag parity complete the releasable parts; npm `@cnwenf/occ` stays at
  2.1.367 until token rotation). Release verification recorded in the OCC-136 result comment.
