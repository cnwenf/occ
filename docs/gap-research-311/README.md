# Gap Research — official claude-code 2.1.310 → 2.1.311 (OCC-135 round)

Date: 2026-10-28 · Round ledger: `docs/upstream-version-gap-occ135-2026-10.md`

## Version facts (three-way verified)

| Source | Official | OCC (pre-round) |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.311** (published 2026-10-26T19:47:57Z) | `@cnwenf/occ` latest = 2.1.367 (npm publish blocked — NPM_TOKEN expired, OCC-127/129 debt) |
| CHANGELOG | 2.1.311 section = **92 items** (96 lines) | tracked **2.1.310** |
| linux-x64 native ELF | v311 = 293,776,752 B, md5 `e41a6ebc58e3e5ccf4d4544d910d0bdb` | v310 = 291,638,640 B, md5 `3dccf6b9559010b289974593943ce748` |

String-level diff v310→v311: **18,925 new / 16,131 removed** unique strings (`comm -13`/`comm -23`
on `strings -n 8 | sort -u`). New env-var surface: **18 names** (`env_new.txt`, reproduced below).

Method: read-only forensics on the official Bun-compiled ELFs — `strings`, `grep -aboF` byte
offsets + `dd`/python-seek context windows, normalized-window difflib. Binaries NEVER executed.

## Triage tally (92 changelog items + env sweep)

| Verdict | Items | Notes |
|---|---|---|
| **PORT** | **33** — items 2, 5, 9, 11, 12, 14, 15, 26, 31, 33, 35, 38, 39, 41, 42, 44, 46, 47, 49, 56, 57, 60, 61, 62, 64, 65, 66, 68, 69, 70, 71, 72, 76 | landed via 26 work packages (WP-A…WP-AC) across 9 parallel implementation agents |
| **STAGED** | **6** — items 3, 4, 6, 7, 25, 27 (+2 env: `INCREMENTAL_REQUEST_BODY`, `SDK_HAS_SESSIONS_OAUTH_REFRESH`) | not byte-pinnable or subsystem-absent; revisit triggers recorded per item |
| **N-A** | **53** — remaining items (+15 env + `EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` security-relevant, analyzed in T4) | official-cloud/VSCode/bg-sessions-only surfaces, or logic-only fixes with no string evidence |

Note: commit messages cite WP-prompt item numbers, which differ from changelog numbers in two
cases (WP-K "item 34"/WP-AA "item 78" implement triage item **72** DISABLE_COMPACT one-way-off +
the REPL summarize gate). The triage tables below are the authoritative numbering.

## Documents

| File | Coverage |
|---|---|
| `triage-T1.md` | changelog items 1–19 (per-item byte evidence + verdict) |
| `triage-T2.md` | items 20–42 |
| `triage-T3.md` | items 43–64 |
| `triage-T4-sweep.md` | items 65–92 + env/settings/hook/command surface sweep (18 new env names) |

## New env names in v311 (`env_new.txt`)

```
CLAUDE_CODE_AGENTS_MD_ROWS_EVERY_PROCESS
CLAUDE_CODE_CHROME_LATE_MCP_SERVER
CLAUDE_CODE_COUNT_GARBAGE_COLLECTIONS
CLAUDE_CODE_DISABLE_EMPTY_CLASSIC_DISPATCH_SKIP
CLAUDE_CODE_DISABLE_LONE_SEC_DEFAULT_SHORTCUT
CLAUDE_CODE_DISABLE_OTEL_EVENT_SKIP
CLAUDE_CODE_DISABLE_QUIET_BACKGROUND_WAIT
CLAUDE_CODE_DISABLE_WORKING_SYNC_WATCH
CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS
CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS
CLAUDE_CODE_INCREMENTAL_REQUEST_BODY
CLAUDE_CODE_MCP_HANDED_LISTINGS
CLAUDE_CODE_MCP_REGISTRY_FETCH_AT_STARTUP
CLAUDE_CODE_PLAIN_DELTA_FAST_PATH
CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH
CLAUDE_CODE_SESSIONS_OAUTH_TOKEN
CLAUDE_CODE_SKIP_MCP_DEBUG_LOG_FILES
CLAUDE_CODE_UNWATCHED_REPLY_HOLD_MS
```

PORTED of these: `CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS` (one-shot startup flag,
`applyHookEventsEnvFlags` — official `uFs()` @249402502). The rest are STAGED/N-A per T4.
