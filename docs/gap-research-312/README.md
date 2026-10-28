# Gap Research — official claude-code 2.1.311 → 2.1.312 (OCC-136 round)

Date: 2026-10-29 · Round ledger: `docs/upstream-version-gap-occ136-2026-10.md`

## Version facts (three-way verified)

| Source | Official | OCC (pre-round) |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.312** (published 2026-10-27T18:36:10Z); `stable` = 2.1.308 | `@cnwenf/occ` latest = 2.1.367 (npm publish blocked — NPM_TOKEN expired, OCC-127/129 debt) |
| CHANGELOG | 2.1.312 section = **39 items** (25 unbracketed + 14 bracketed surface-specific) | tracked **2.1.311** |
| linux-x64 native ELF | v312 = 293,592,432 B, md5 `be77f401c2b9c1c79c98f828abe8a6e7` | v311 = 293,776,752 B, md5 `e41a6ebc58e3e5ccf4d4544d910d0bdb` (matches the occ135 ledger ✓) |

String-level diff v311→v312: **16,605 new / 16,871 removed** unique strings (`comm -13`/`comm -23`
on `strings -n 8 | sort -u`).

Method: read-only forensics on the official Bun-compiled ELFs — `strings`, `grep -aboF` byte
offsets + seek-based python context windows (`fx.py`; `dd bs=1` is too slow on 293 MB files).
Binaries NEVER executed.

## Triage tally (39 changelog items + env sweep)

| Verdict | Items | Notes |
|---|---|---|
| **PORT** | **11** — items 2, 4, 5, 8, 9, 14, 15, 16, 20, 22, 23 (9+16 folded: one `sentEffort` change) | landed via 6 work packages (WP-A/B/E/F/G/H) + 3 orchestrator-direct ports (15/20/23) |
| **STAGED** | **1** — item 18 (+ item 4's `tengu_velvet_possum` top-level-cut sub-part) | not ported this round; revisit triggers recorded per item |
| **N-A** | **27** — items 1, 3, 6, 7, 10, 11, 12, 13, 17, 19, 21, 24, 25 + all 14 bracketed [VSCode]/[Cloud sessions]/[Remote Control]/[Claude Tag]/[Code Review] items (+2 new env) | official-cloud / VSCode / OTel-stubbed / structurally-absent surfaces, or unpinnable logic-only deltas with no OCC surface |

## Documents

| File | Coverage |
|---|---|
| `triage-port.md` | per-item byte evidence for the 11 PORT items (offsets in the v311/v312 ELFs) |
| `triage-na-staged.md` | N-A + STAGED rationales, incl. env sweep and the unpinnable-item honesty notes |

## New env names in v312 (2; 1 removed)

```
+ CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP                 (registry @239090454)
+ CLAUDE_CODE_REMOTE_TOOLS_HOST_IDLE_RELEASE_MINUTES    (registry @239092149)
- CLAUDE_CODE_MCP_HANDED_LISTINGS                       (present in v311, removed in v312)
```

Both new names are **N-A**: they gate the artifacts-MCP host guard and the remote-tools host
idle-release — surfaces OCC does not ship (same conclusion as the item-17 cloud-host family).
The removed `CLAUDE_CODE_MCP_HANDED_LISTINGS` was never ported to OCC (occ135 STAGED), so its
removal is a no-op here.
