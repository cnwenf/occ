# Upstream version gap — OCC-135 round (official claude-code 2.1.310 → 2.1.311 alignment)

Round date: 2026-10-28 (OCC-135 巡检轮: gap调研→对齐→e2e验收→合main→发版).
Predecessor: `docs/upstream-version-gap-occ134-2026-10.md` (2.1.310 held, zero-gap self-acceptance).
Gap research record: `docs/gap-research-311/` (README + triage T1–T4, per-item byte evidence).
Branch: `agent/occ/c7d7631d` (base `d2ba57a5`, v2.1.404) → main; release **v2.1.405**.

## §1 Version facts (three-way verified, 2026-10-28)

| Source | Official Claude Code | OCC |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.311** (published 2026-10-26T19:47:57Z) | `@cnwenf/occ` latest = 2.1.367 (npm publish blocked — NPM_TOKEN expired, OCC-127/129 debt carried) |
| CHANGELOG | 2.1.311 = **92 items** | tracked **2.1.310** pre-round (README badge, 4 spots) |
| linux-x64 native ELF | v311 = 293,776,752 B, md5 `e41a6ebc58e3e5ccf4d4544d910d0bdb` | v310 = 291,638,640 B, md5 `3dccf6b9559010b289974593943ce748` |

String diff v310→v311: 18,925 new / 16,131 removed unique strings; 18 new env names
(list in `docs/gap-research-311/README.md`).

## §2 Method

- Read-only binary forensics on both official ELFs (`strings -n 8 | sort -u` + `comm`, `grep -aboF`
  byte offsets + `dd`/python-seek context windows, normalized-window difflib). Binaries never executed.
- 4 parallel triage tracks (T1: items 1–19, T2: 20–42, T3: 43–64, T4: 65–92 + env/settings/hook/
  command sweep) → `docs/gap-research-311/triage-T*.md`.
- 9 parallel implementation agents over file-disjoint work packages (WP-A…WP-AC), TDD (RED→GREEN),
  differential proofs by reconstructing official functions from binary bytes and comparing behavior.
- Shared-working-tree protection: 3 checkpoint commits (`805b6805`, `ecaea2d5`, `f00d8019`) against
  sibling `git reset --hard`. Two lost WPs (WP-W/X by A3, WP-K/AA by A2 — A3 additionally died
  mid-run on "Prompt is too long") recovered by the orchestrator via transcript replay of the
  authoring agents' Write/Edit ops; all recovered files test-green (197/197 WP-X set, 33+15 WP-K/AA).

## §3 Triage tally

**PORT 33 items** (2, 5, 9, 11, 12, 14, 15, 26, 31, 33, 35, 38, 39, 41, 42, 44, 46, 47, 49, 56, 57,
60, 61, 62, 64, 65, 66, 68, 69, 70, 71, 72, 76) via 26 work packages · **STAGED 6 items + 2 env**
(3, 4, 6, 7, 25, 27; env `INCREMENTAL_REQUEST_BODY`, `SDK_HAS_SESSIONS_OAUTH_REFRESH`) ·
**N-A 53 items + 15 env** (official-cloud / VSCode-extension / bg-sessions-only surfaces, or
logic-only fixes with no string-level evidence). Per-item byte evidence in `docs/gap-research-311/`.

New env ported (1 of 18): `CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS` — one-shot startup flag
(official `uFs()` @249402502; call site @258725286 `if(et||i.CLAUDE_CODE_REMOTE)cFs(!0);if(uFs(),we){…}`),
wired in `src/main.tsx` unconditionally after the `setAllHookEventsEnabled` gate (`9f6192fb`); the env
var is always deleted after read so child processes don't inherit it.
`CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` analyzed in T4 — N-A (OCC does not ship the
official sandbox-escape ladder).

## §4 Work packages → features (agent → WP → landing commit)

| Agent | WP | Feature (triage item) | Landing |
|---|---|---|---|
| A1 | WP-A | Explanatory-output-style tip + detector (2) — 97 tests | checkpoints |
| A1 | WP-V | ultrathink → xhigh turn-effort boost + rainbow gating (65, 66) — 53 tests | checkpoints |
| A2 | WP-K/WP-AA | DISABLE_COMPACT gates REPL summarize + managed-env one-way compact drop (72) | `f2ee65b6` (replayed) |
| A3 | WP-J | marked wrappedBackslash inline extension — orphan `\` before closer preserved (33) | `2b1c1379` |
| A3 | WP-AB | purge plan appends data-locality disclaimer (76) | `f08f9484` |
| A3 | WP-W | ndjsonSafeStringify — json/stream-json `\uXXXX` escapes for DEL/C1/U+2028/U+2029/Cf (68) | `f73a1c97` + print.ts wiring `3143d62b` (replayed) |
| A3 | WP-X | native-1M display: `[1m]` suffix + "(1M context)" label drop (69) | `3143d62b` (replayed) |
| A4 | WP-D | file-suggestion `.ignore` re-include (5) — 14+10 tests | `f00d8019` |
| A4 | WP-I | paste per-line validation (11) — 6+4 tests | `f00d8019` |
| A5 | WP-B | 1M-credits withhold + compact + continue (26/31 family) — 32 tests | checkpoints |
| A5 | WP-R | compact-summary re-ask (44 family) — 19 tests | checkpoints |
| A6 | WP-P | shouldRetryHeaderGate (46/47 family) — 8 tests | checkpoints |
| A6 | WP-S | connectionDroppedAdvice (49 family) — 28 tests | checkpoints |
| A7 | WP-E | worktree registry occupants + cleanup keep/re-arm (12) — 56 tests | `f00d8019` |
| A7 | WP-C | transcript tombstone persisted removal + inCallOrder write serialization (9) | `f00d8019` + isolation fix `17edc513` |
| A7 | WP-O | rewind wording "This message and everything after it will be removed" (35/39 family) — 8 tests | `f00d8019` |
| A8 | WP-H | /ide awaited install flow + pure mappers (38) — 21 tests | checkpoints |
| A8 | WP-M | MCP remote-server three-state auth row + clear-auth reconnect (41, 42) — 29 tests | `d317b86e` |
| A8 | WP-U | oauth AuthCodeRefusedError (62) — 18 tests | checkpoints |
| A9 | WP-T | screen-reader delete announcements + question listing (61, 64) | `ecaea2d5` |
| A9 | WP-Q | bash timeout output-so-far + still-running message (56) | `ecaea2d5` |
| A9 | WP-Y | startup permission warnings once per user — persisted seenKey dedup, cap 256 (70) | `ecaea2d5` |
| A9 | WP-N/WP-AC | remaining PORT surface (57/60/71 family) | checkpoints |
| orch | — | applyHookEventsEnvFlags startup wiring (env sweep PORT) | `9f6192fb` |
| orch | — | opus5 e2e assertion aligned to native-1M label drop | `e271cc66` |

Commit-message item numbers cite WP-prompt numbering; the triage tables are authoritative
(WP-K/WP-AA "items 34/78" = triage item 72). New `*311*` test files: **30** (29 in `src/` +
`test/engine/tombstonePersistedRemoval311.test.ts`).

## §5 Test + e2e evidence

Runtime note: CI pins bun **1.4.2** (OCC-129 acceptance baseline); local system bun is 1.3.14.

- Full suite via `scripts/ci-test.sh` (per-file process isolation, bun 1.3.14): **14,858 pass /
  2 fail / 12 skip across 1,280 files**. Both failures reproduced **green on bun 1.4.2**:
  - `argumentSubstitutionCaps301` — shell-quote@1.8.3 `parse()` returns 0 tokens for ~1.1M-char
    single tokens under bun 1.3.14's regex runtime (12/12 pass under 1.4.2). Environment artifact:
    also fails at round-base `2b1c1379` (bisect-verified) — not a 311 regression.
  - `commands-behavior` `/feedback` GitHub-issue e2e — live-API flake (47s timeout; 16/16 under 1.4.2).
- GitHub CI on the branch (run 40600865387, bun 1.4.2): 14,750 pass / **1 fail** — the opus5
  pre-311 display-name assertion, fixed in `e271cc66`; everything else green.
- Build: `bun run build` green — `dist/cli.js` 30.56 MB, `MACRO.VERSION` injected.
- Real e2e on fresh dist:
  - REPL suites `repl-interactive` / `repl-welcome-visual` / `repl-image-paste`: **12/12 pass**.
  - Headless `-p` real-model round-trip: `--output-format json` → result `OCC311OK`, `is_error:false`.
  - Live tmux REPL: banner renders (v2.1.404 + model/proj rows), interactive prompt → `● REPL311OK`,
    `/exit` clean. Startup permission warnings routed per item-70 channel logic (observed live).
    The OCC-11 sandbox blank-pane stall did NOT reproduce this round.

## §6 STAGED follow-ups (next rounds)

1. **seenKey object plumbing** (item 70 depth): `collectPermissionRuleSecurityWarnings` emits plain
   strings; official builds `{text, seenKey:sha256(source,settingsPath,text)}` rows. OCC lacks a
   `un(source)`→settings-path resolver; the router already accepts object inputs
   (`SecurityWarningInput` in `startupSecurityWarnings.ts`), so only the producer side + path
   resolver remain. Persisted dedup engages today only for object inputs; string rows still surface
   every startup (pre-311 behavior, fail-open).
2. **MCPConnectionManager service-layer reconnect throw** (A8 WP-M follow-up): reconnect error
   propagation lives outside the component boundary; needs a service-layer change with own tests.
3. STAGED items 3, 4, 6, 7, 25, 27 + env `INCREMENTAL_REQUEST_BODY`, `SDK_HAS_SESSIONS_OAUTH_REFRESH`
   — revisit triggers recorded per item in `docs/gap-research-311/`.
4. WP-V note: the ultrathink xhigh-boost flag stays dormant until `ULTRATHINK` joins
   FEATURE_ALLOWLIST (official gates it behind the same flag family).

## §7 Release

- OCC version 2.1.404 → **2.1.405**; README Tracks 2.1.310 → **2.1.311** (4 spots); merged to
  `main` (`--no-ff`); tag `v2.1.405` pushed → `publish.yml` triggered. npm publish expected to fail
  on the expired NPM_TOKEN (OCC-127/129 debt — GitHub Release + tag parity complete the releasable
  parts; npm `@cnwenf/occ` stays at 2.1.367 until token rotation).
