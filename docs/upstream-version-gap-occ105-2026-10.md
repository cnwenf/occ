# OCC-105 Upstream Version Gap Ledger — Claude Code 2.1.286 → 2.1.287 (2026-10)

**Round**: OCC-105 (issue `9ef285dc-c433-461e-b25f-5b3f160fe631`), executed 2026-10-03 by OCC 程序员.
**Tracked-upstream pointer**: 2.1.286 → **2.1.287** (this round). OCC release: **2.1.366** (tag/publish after 验收 acceptance — not this round).
**Official channel state at round time** (npm `dist-tags`, fact-checked 2026-10-03): `stable=2.1.285`, `latest=next=2.1.287`. Publish times (npm `time`): 2.1.286 → 2026-09-30T17:14:38Z, 2.1.287 → 2026-10-01T16:59:25Z.

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.286` (241,667,256 B, md5 `7a1a1bf1223b8dc705fec6124dd82df1`) and `@2.1.287` (244,317,368 B, md5 `e2cb95e3d249d216b0d533b798ba70f3`), unpacked to `/tmp/cc-diff-287/{v286,v287}/package/claude`. **Never executed** — analysis used only `strings -n 8` dumps (`s286.txt` 452,805 lines / `s287.txt` 457,521 lines), sorted-unique `comm` diff (`new287.txt` **19,730 new unique strings** / `del287.txt` 15,962 removed), `rg -aobF` offsets + `dd`/python byte-window extraction. Version-marker check: v287 ELF contains `2.1.287` ×2,306, zero `2.1.288`. Temp artifacts removed after the round (`rm -rf /tmp/cc-diff-287`).
- Changelog: **106 bullets** for 2.1.287 (numbered **#1–#106** below in changelog order). Research reports committed under `docs/gap-research-287/`: `cluster-a-permission-integrity.md`, `cluster-b-protocol-auth-security.md`, `cluster-c-features.md`, `cluster-d1-api-session.md`, `cluster-d2-misc.md`, `cluster-e-screenreader-platform.md`.
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure. Security ports additionally verified by A/B needle harnesses where a harness is feasible.
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** (core landed; named sub-pieces STAGED) · **STAGED** (real surface or real gap, but needs decompilation/decision/subsystem OCC lacks — recovered code recorded, nothing invented) · **NO-OP** (PLATFORM = other-product surface; NO-SURFACE = feature absent from OCC; ALREADY-ALIGNED).

## Summary counts (106 entries)

_(filled at round end)_

## 1. Per-entry ledger (#1–#106)

_(filled from cluster reports)_

## 2. Security disposition summary (kickoff priority list)

_(filled at round end)_

## 3. Verification

_(filled at round end)_

## 4. STAGED backlog carried to future rounds

_(filled at round end)_

## 5. Version bumps (this round)

_(filled at round end)_

## 6. Files touched (this round)

_(filled at round end)_
