# OCC Versioning & Update — Design

> **Status:** Approved (notice-only, no auto-install — per user decision 2026-07-10)

## Goal

Re-brand OCC's version surfaces to its own identity and re-point the update/auto-update machinery at the `@cnwenf/occ` npm package. The REPL shows a non-intrusive "new version available" notice on startup; **OCC never auto-installs** — the user runs `occ update` manually.

## Background

OCC tracks Claude Code `2.1.204`. Its `MACRO` polyfill (`src/entrypoints/cli.tsx:13-23`) currently leaves `PACKAGE_URL: ""`, which breaks the entire npm updater chain (`autoUpdater.ts` runs `npm view @<empty>@latest version` → malformed). The `occ update` command hardcodes `@anthropic-ai/claude-code`. The `--version` flag prints `${MACRO.VERSION} (Claude Code)`. The `AutoUpdater.tsx` component auto-installs by default (line 81). All four need correction.

## Architecture

One knob — `MACRO.PACKAGE_URL = '@cnwenf/occ'` — re-points the npm identity. Four surfaces consume it:

1. **Version string** (`main.tsx` `--version`): rebrand to `OCC ${MACRO.VERSION}`.
2. **`occ update`** (`src/commands/update/update.ts`): consume `MACRO.PACKAGE_URL` instead of the hardcoded `@anthropic-ai/claude-code`; fix the bun branch to install globally (currently runs bare `install` in cwd).
3. **Auto-updater** (`src/utils/autoUpdater.ts`): already keyed on `MACRO.PACKAGE_URL` — setting the knob makes `getLatestVersion` / `getNpmDistTags` / `installGlobalPackage` target `@cnwenf/occ`.
4. **REPL notice** (`src/components/AutoUpdater.tsx`): keep the version-check + notice-render path; **gate off the auto-install branch** (line 81) so OCC only shows a notice and never installs. Adjust the hint text to read `occ update` (the user-facing command) instead of raw `npm i -g`.

## Components

### 1. `src/entrypoints/cli.tsx` — MACRO polyfill

**Change:** `PACKAGE_URL: ""` → `PACKAGE_URL: "@cnwenf/occ"` (line ~20).

This is the single source of truth. Every downstream consumer reads `MACRO.PACKAGE_URL`.

**Guard for the bypass case:** If a user runs the unbundled dev entrypoint without the polyfill, `MACRO.PACKAGE_URL` is `undefined`. `update.ts` and the notice path must no-op with a clear "package URL not configured" message rather than running `npm install -g @` (malformed). Both surfaces already handle falsy PACKAGE_URL via explicit guards added in tasks 2 and 4.

### 2. `src/main.tsx` — `--version` branding

**Change:** line 3895, `${MACRO.VERSION} (Claude Code)` → `OCC ${MACRO.VERSION}`.

**Audit (no change):** line 2570 (`version: MACRO.VERSION` for telemetry) and line 3310 (`localVersion: MACRO.VERSION` for SSH) stay as bare version strings — they are internal, not user-facing branding.

### 3. `src/commands/update/update.ts` — `occ update`

**Current state:**
- `PACKAGE_NAME = '@anthropic-ai/claude-code'` (constant, wrong package).
- `detectPackageManager()`: checks for bun.lockb/lock → `'bun'`, else `'npm'`.
- `runUpdate(pm)`: bun → `['install']` in cwd (wrong for a global CLI); npm → `['install', '-g', PACKAGE_NAME@latest]`.
- `latestVersion()`: `spawnSync('npm', ['view', PACKAGE_NAME, 'version'])`.

**Changes:**
- Replace `PACKAGE_NAME` constant with a read of `MACRO.PACKAGE_URL`.
- `runUpdate('bun')`: `['install', '-g', `${MACRO.PACKAGE_URL}@latest`]` (global, not bare cwd install).
- `runUpdate('npm')`: `['install', '-g', `${MACRO.PACKAGE_URL}@latest`]`.
- `latestVersion()`: `spawnSync('npm', ['view', MACRO.PACKAGE_URL, 'version'])`.
- Add a falsy guard at the top of `runUpdate`: if `!MACRO.PACKAGE_URL`, log "OCC package URL not configured; cannot update" and return without spawning.

### 4. `src/components/AutoUpdater.tsx` — notice-only gate

**Current state:**
- Line 58: calls `getLatestVersion(channel)`.
- Line 81: if `currentVersion < latestVersion` and not disabled → triggers `installGlobalPackage` (AUTO-INSTALL).
- Lines 170-179: renders version notice.
- Line 193: hint text shows `npm i -g ${MACRO.PACKAGE_URL}`.

**Changes:**
- Gate the auto-install branch (line 81): when `MACRO.PACKAGE_URL === '@cnwenf/occ'`, skip `installGlobalPackage` entirely. Keep the version-check + comparison; render the notice instead.
- Adjust the hint text (line 193) to read `run \`occ update\`` instead of the raw `npm i -g ${MACRO.PACKAGE_URL}` command, since `occ update` is the user-facing entry point and handles the package-manager detection internally.

## Data Flow

```
REPL startup
  → AutoUpdater.tsx mounts
  → getLatestVersion(channel) → npm view @cnwenf/occ@latest version
  → compare vs MACRO.VERSION
  → if behind AND package configured: render notice "New version X available — run `occ update`"
  → does NOT call installGlobalPackage (gated off for @cnwenf/occ)
  → user runs `occ update`
  → update.ts: detectPackageManager() → npm install -g @cnwenf/occ@latest (or bun equiv)
```

## Error Handling

- **npm registry unreachable / offline:** `getLatestVersion` throws → caught by AutoUpdater's existing try/catch → no notice rendered (silent, as today). No crash.
- **`occ update` failure (permissions, no npm/bun):** existing `runUpdate` error surfacing. Ensure the error message names `@cnwenf/occ`, not the old `@anthropic-ai/claude-code` (it will, once PACKAGE_NAME is replaced).
- **`MACRO.PACKAGE_URL` falsy (polyfill bypassed):** `update.ts` no-ops with "OCC package URL not configured; cannot update"; the notice path no-ops silently. Neither runs a malformed `npm install -g @`.

## Testing

### Unit (TDD — write test first, then implement)

- **`update.ts`:**
  - `runUpdate('npm')` produces argv `['install', '-g', '@cnwenf/occ@latest']`.
  - `runUpdate('bun')` produces argv `['install', '-g', '@cnwenf/occ@latest']`.
  - `latestVersion()` spawns `npm view @cnwenf/occ version`.
  - `runUpdate` with falsy `MACRO.PACKAGE_URL` no-ops (no spawn) and logs the not-configured message.
- **version comparison / notice:**
  - behind → notice shown.
  - ahead/equal → no notice.
  - offline (getLatestVersion throws) → no notice, no crash.
  - `MACRO.PACKAGE_URL === '@cnwenf/occ'` → auto-install branch never called (assert `installGlobalPackage` is not invoked).

### E2E / Behavioral

- `occ --version` prints `OCC 2.1.204` (not `2.1.204 (Claude Code)`).
- `occ update` with a stubbed `npm view` returns the latest version and the install argv targets `@cnwenf/occ`.

### Manual smoke

- REPL startup with a stubbed-lower `MACRO.VERSION` (e.g., `0.0.1`) shows the "New version X available — run `occ update`" notice and does not auto-install.

## Scope (Out of scope)

- NOT changing telemetry version fields (line 2570) — internal, keep bare.
- NOT touching the SDK entrypoints.
- The `assertMinVersion` path in `autoUpdater.ts` (line 70, uses stubbed Statsig/GrowthBook) is already dead — leave it.
- NOT adding a changelog or release-notes surface.
