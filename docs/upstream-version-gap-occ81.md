# OCC-81 Upstream Version Gap — official Claude Code 2.1.263 → 2.1.266

- **Round**: OCC-81 (autopilot, 2026-09-10)
- **OCC aligned-at (entry)**: official 2.1.263 (OCC release 2.1.325, OCC-119 round)
- **Official latest**: 2.1.266 (stable channel: 2.1.236). 2.1.264 was never published.
- **Method**: `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.263,2.1.266}` → `strings -n 8 | sort -u` → `comm` on sorted identifier sets (env vars, command `type/name` patterns, `value:"yes-*"` option patterns) + byte-level `grep -boF`/`dd` context extraction. Raw line diff was ~14.4k lines of minification noise; identifier-set diffing cancels it.

## 1. Changelog triage

### 2.1.266 (hotfix)
Single entry: fix `CLAUDE_CODE_USE_GATEWAY` regression from 2.1.265. **No-op for OCC** — OCC does not implement `CLAUDE_CODE_USE_GATEWAY` (grep: 0 hits); the gateway surface is Anthropic-backend-only.

### 2.1.265 (~55 entries)

**Landed this round (1):**

| # | Entry | OCC surface | Disposition |
|---|-------|-------------|-------------|
| 43 | Permission dialog: the `.claude`-folder accept option now says which folder it covers (project vs global `~/.claude`) instead of the generic "edit its own settings" copy | `src/components/permissions/FilePermissionDialog/permissionOptions.tsx` | **Ported** — see §3 |

**Staged (forensicated, deferred with reason):**

| Item | Evidence | Why staged |
|------|----------|-----------|
| #7 `opusplan[1m]` handling fix | Alias array identical in 263↔266 binaries (`["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]`); the fix site is inside command validation, minified-name collisions (`function Bt(` matches multiple modules) blocked a confident trace | STOP per never-invent discipline; needs deeper trace next round |
| `fable[1m]` alias | OCC `MODEL_ALIASES` (src/utils/model/aliases.ts) lacks `fable[1m]` which official has in both 263 and 266 | Downstream resolution of `fable[1m]` (1M-access checks, picker rows) unverified — adding the bare alias without the resolution path risks a half-working alias |
| #25 `/model` save-failure feedback | Official 266 awaits the settings save (`wMe`) and appends failure text (`vMe`): `· couldn't save it as your default: <path> can't be written (<reason>)` / `isn't valid JSON` / `· couldn't confirm it was saved as your default (<path> is still being written)`, holding feedback without timeout on failure. OCC `handleSelect` is fire-and-forget `updateSettingsForSource(...)` + unconditional success message | Larger async rework of `src/commands/model/model.tsx` — full forensics captured here for the next round |

**Not portable (backend / trimmed surfaces):** the remaining ~50 entries touch plugin marketplace/artifacts (4 new env vars below), gateway, remote control (phone push), VSCode/JetBrains extensions, Windows-specific fixes, cloud/teleport sessions, and Anthropic-account billing — all surfaces OCC has deliberately trimmed or that require Anthropic backend.

**Carried forward from OCC-119 (still staged):**
- **Gap-119b**: startup banner/notification subsystem rework — brand conflict, deferred by decision.
- **Gap-119c**: `/status` panel rows + theme persistence location (`~/.claude/settings.json` vs `~/.claude.json`) — cross-cutting, deferred.

## 2. Binary identifier-set diff (263 → 266)

- **Env vars**: 596 → 600. New: `CLAUDE_CODE_ARTIFACT_DB_STR_REPLACE`, `CLAUDE_CODE_ARTIFACT_FIVE_CLASS_ASKS`, `CLAUDE_CODE_DISABLE_AWAITING_USER_IDLE`, `CLAUDE_CODE_TETHER_LIVE` — all artifact-DB/tether backend (not portable). Removed: none.
- **Slash commands**: `/design` removed upstream — no-op (OCC never shipped it).
- **Hooks**: hook-event identifier sets identical 263↔266 — no hook changes.

## 3. Landed fix: `.claude`-folder permission option label (official #43)

Byte-level forensics on the 2.1.266 linux-x64 ELF (function `rBo`, renderLabel region):

```js
function rBo(w,P,ee){let ce=eBo(w),ge=tBo(w);if((ce||ge)&&P!=="read"){let Xe=ge?gRt:mRt,
...return ge?"Yes, and allow Claude to edit files in its ~/.claude folder for this session":"Yes, and allow Claude to edit files in this project's .claude folder for this session"}});
return st===null?null:{row:st,value:"yes-claude-folder"}}
```

- `ge` = global-folder detector, `ce` = project-folder detector; paired rule patterns `gRt="~/.claude/**"` / `mRt="/.claude/**"` (OCC's `GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN` / `CLAUDE_FOLDER_PERMISSION_PATTERN` already match).
- String counts: stale label `Yes, and allow Claude to edit its own settings for this session` 263=2 / 266=0; new labels 263=0 / 266=3; `value:"yes-claude-folder"` identical in both versions.

**OCC change** (`permissionOptions.tsx`): replaced the single stale 263 label with the official two-branch ternary on `inGlobalClaudeFolder`, mirroring the existing `scope: inGlobalClaudeFolder ? 'global-claude-folder' : 'claude-folder'` ternary. Stale comment quoting the old label in `src/utils/permissions/filesystem.ts` updated.

**Tests (TDD, RED→GREEN):**
- Behavioral: `src/components/permissions/FilePermissionDialog/__tests__/claudeFolderLabel266.test.ts` — drives real `getFilePermissionOptions()`; asserts exact labels + scopes for project/global branches, create-op inclusion, read-op gate (`P!=="read"`), and stale-label-never-returned across paths/ops.
- Parity pin: `test/e2e/version-2.1.266-claude-folder-label-parity.e2e.test.ts` — source-grep convention (cf. version-2.1.263-security-notes-parity).

## 4. Next-round candidates (priority order)

1. `/model` save-failure feedback machinery (#25) — forensics ready in §1.
2. `fable[1m]` alias + resolution path.
3. `opusplan[1m]` command-validation fix (#7) — needs cleaner trace.
4. Gap-119b / Gap-119c if brand/cross-cutting decisions unblock.
