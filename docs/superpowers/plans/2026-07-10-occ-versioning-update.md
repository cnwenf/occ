# OCC Versioning & Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-brand OCC's version surfaces and re-point the update machinery at `@cnwenf/occ`; the REPL shows a notice-only "new version available" message and never auto-installs.

**Architecture:** One knob — `MACRO.PACKAGE_URL = '@cnwenf/occ'` — re-points the npm identity consumed by `occ update`, the auto-updater's version check, and the notice hint text. `AutoUpdater.tsx` gets a notice-only gate for OCC that reuses the existing `notifications[]` plumbing and a new `'notice'` install-status render branch instead of calling `installGlobalPackage`.

**Tech Stack:** Bun, TypeScript, React/Ink (REPL), Commander.js (`--version`), `child_process.spawnSync` (`occ update`).

## Global Constraints

- OCC tracks Claude Code `2.1.204`; `MACRO.VERSION` stays `"2.1.204"`.
- `MACRO.PACKAGE_URL` is the single source of truth for the npm package name; every downstream surface reads it — no hardcoded `@anthropic-ai/claude-code` strings may remain in `update.ts`.
- Notice-only: OCC **never** calls `installGlobalPackage` / `installOrUpdateClaudePackage` from the REPL. The user runs `occ update` manually.
- Do not touch telemetry version fields (`main.tsx` line ~2570 `version: MACRO.VERSION`) — those are internal and stay bare.
- ~1341 tsc type errors are pre-existing and do not block Bun runtime; do not attempt to fix them. Biome lint is the gate.
- No `Co-Authored-By` trailer in any commit (standing user constraint).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/entrypoints/cli.tsx` | Runtime MACRO polyfill (single source of `PACKAGE_URL`) | Modify: `PACKAGE_URL: ""` → `"@cnwenf/occ"` |
| `src/main.tsx` | Commander `--version` flag output | Modify: `${MACRO.VERSION} (Claude Code)` → `OCC ${MACRO.VERSION}` |
| `src/commands/update/update.ts` | `occ update` command (resolve latest, install globally) | Modify: read `MACRO.PACKAGE_URL`; fix bun global install; add falsy guard |
| `src/utils/autoUpdater.ts` | `InstallStatus` union type | Modify: add `'notice'` member |
| `src/components/AutoUpdater.tsx` | REPL auto-updater React component | Modify: gate auto-install for OCC; render notice branch |
| `test/e2e/occ-versioning.e2e.test.ts` | Behavioral tests for `--version` + `occ update` argv | Create |

---

### Task 1: Set `MACRO.PACKAGE_URL` to `@cnwenf/occ`

**Files:**
- Modify: `src/entrypoints/cli.tsx:20`

**Interfaces:**
- Produces: `globalThis.MACRO.PACKAGE_URL === '@cnwenf/occ'` at runtime (consumed by `update.ts` Task 3, `autoUpdater.ts` existing `getLatestVersion`/`installGlobalPackage`, and `AutoUpdater.tsx` notice gate in Task 4).

- [ ] **Step 1: Edit the MACRO polyfill**

In `src/entrypoints/cli.tsx`, change line 20 inside the `(globalThis as any).MACRO = { ... }` block:

```tsx
        PACKAGE_URL: "@cnwenf/occ",
```

(was `PACKAGE_URL: "",`)

- [ ] **Step 2: Verify the build still succeeds**

Run: `bun build src/entrypoints/cli.tsx --outdir dist --target bun`
Expected: "Bundled N modules" with no errors.

- [ ] **Step 3: Verify the value is visible at runtime**

Run: `bun run dev -- --version` and confirm it does not crash (the version string itself is fixed in Task 2).
Expected: no crash; `@cnwenf/occ` is now the resolved package URL.

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/cli.tsx
git commit -m "feat(versioning): set MACRO.PACKAGE_URL to @cnwenf/occ"
```

---

### Task 2: Rebrand `occ --version` output

**Files:**
- Modify: `src/main.tsx:3895`

**Interfaces:**
- Consumes: `MACRO.VERSION` (Task 1's polyfill already sets `"2.1.204"`).
- Produces: `occ --version` prints `OCC 2.1.204` instead of `2.1.204 (Claude Code)`.

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e/occ-versioning.e2e.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { REPO_ROOT } from './helpers'

const OCC_BIN = 'src/entrypoints/cli.tsx'

describe('occ --version', () => {
  test('prints OCC branding, not Claude Code', () => {
    const res = spawnSync('bun', ['run', OCC_BIN, '--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    })
    const out = (res.stdout ?? '') + (res.stderr ?? '')
    expect(out).toContain('OCC')
    expect(out).not.toContain('Claude Code')
    expect(out).toContain('2.1.204')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/occ-versioning.e2e.test.ts`
Expected: FAIL — output still contains `Claude Code` and not `OCC` branding.

- [ ] **Step 3: Edit `main.tsx` `--version`**

In `src/main.tsx`, change line 3895:

```tsx
  }).version(`OCC ${MACRO.VERSION}`, '-v, --version', 'Output the version number');
```

(was `` `${MACRO.VERSION} (Claude Code)` ``)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/occ-versioning.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.tsx test/e2e/occ-versioning.e2e.test.ts
git commit -m "feat(versioning): rebrand occ --version to 'OCC <version>'"
```

---

### Task 3: Re-point `occ update` at `@cnwenf/occ` and fix bun global install

**Files:**
- Modify: `src/commands/update/update.ts` (lines 5, 22-36, 38-56, 58-64)

**Interfaces:**
- Consumes: `MACRO.PACKAGE_URL` (Task 1).
- Produces: `runUpdate('npm')` and `runUpdate('bun')` both produce argv `['install', '-g', '@cnwenf/occ@latest']`; `latestVersion()` calls `npm view @cnwenf/occ version`; falsy `PACKAGE_URL` no-ops with a clear message.

- [ ] **Step 1: Write the failing unit test**

Add to `test/e2e/occ-versioning.e2e.test.ts` a new describe block. Since `update.ts` uses `spawnSync` directly with `MACRO.PACKAGE_URL` read at call time, test the package-name resolution by stubbing `MACRO` and intercepting `spawnSync`.

```ts
import { mockSpawnSync, withMacros } from './helpers/update-stub'

describe('occ update argv', () => {
  test('npm branch installs @cnwenf/occ globally', () => {
    const calls = mockSpawnSync()
    withMacros({ PACKAGE_URL: '@cnwenf/occ', VERSION: '2.1.204' }, () => {
      // Re-import update.ts after MACRO is set so it reads the stubbed value.
      return import('../../src/commands/update/update.ts').then(async (mod) => {
        // call() resolves latest as null (no network) → still triggers runUpdate
        await mod.call()
      })
    })
    const installCall = calls.find(c => c.args.includes('@cnwenf/occ@latest'))
    expect(installCall).toBeDefined()
    expect(installCall!.args).toContain('-g')
    expect(installCall!.args).toContain('install')
  })

  test('falsy PACKAGE_URL no-ops without spawning install', () => {
    const calls = mockSpawnSync()
    withMacros({ PACKAGE_URL: '', VERSION: '2.1.204' }, () => {
      return import('../../src/commands/update/update.ts').then(async (mod) => {
        await mod.call()
      })
    })
    const installCall = calls.find(c => c.args.includes('@latest'))
    expect(installCall).toBeUndefined()
  })
})
```

Create `test/e2e/helpers/update-stub.ts`:

```ts
type Call = { cmd: string; args: string[] }

const recorded: Call[] = []

// Replace child_process.spawnSync with a recorder that returns "no network" for npm view.
export function mockSpawnSync(): Call[] {
  recorded.length = 0
  const mod = require('child_process')
  mod.spawnSync = (cmd: string, args: string[], opts?: any) => {
    recorded.push({ cmd, args })
    // Simulate "npm view ... version" returning empty (offline) so latestVersion() = null.
    if (args.includes('view')) return { status: 1, stdout: '', stderr: '' }
    return { status: 0, stdout: 'stubbed', stderr: '' }
  }
  return recorded
}

export function withMacros(macros: Record<string, string>, fn: () => Promise<unknown>): Promise<unknown> {
  const prev = (globalThis as any).MACRO
  ;(globalThis as any).MACRO = { ...(prev ?? {}), ...macros }
  // Clear module cache so update.ts re-evaluates and reads the new MACRO.
  delete require.cache[require.resolve('../../src/commands/update/update.ts')]
  return fn().finally(() => { ;(globalThis as any).MACRO = prev })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/occ-versioning.e2e.test.ts`
Expected: FAIL — `update.ts` still uses the hardcoded `@anthropic-ai/claude-code` constant, so no `@cnwenf/occ@latest` call is recorded.

- [ ] **Step 3: Rewrite `update.ts`**

Replace the full file content of `src/commands/update/update.ts`:

```ts
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { LocalCommandCall } from '../../types/command.js'

const INSTALL_TIMEOUT_MS = 180_000

/** The npm package name for OCC, injected at build time via MACRO.PACKAGE_URL. */
function packageName(): string {
  return (globalThis as { MACRO?: { PACKAGE_URL?: string } }).MACRO?.PACKAGE_URL ?? ''
}

/** Current OCC version from the build-time MACRO.VERSION global. */
function currentVersion(): string {
  return (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ?? 'unknown'
}

/**
 * Detect the package manager: bun if a bun lockfile is present, else npm.
 */
function detectPackageManager(): 'bun' | 'npm' {
  if (existsSync('bun.lockb') || existsSync('bun.lock')) return 'bun'
  return 'npm'
}

/** Latest published version of the package, or null if it can't be resolved. */
function latestVersion(): string | null {
  const pkg = packageName()
  if (!pkg) return null
  try {
    const res = spawnSync(
      'npm',
      ['view', pkg, 'version'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    )
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim() || null
    }
  } catch {
    /* ignore — network/npm may be unavailable */
  }
  return null
}

function runUpdate(pm: 'bun' | 'npm'): string {
  const pkg = packageName()
  if (!pkg) {
    return 'OCC package URL not configured; cannot update.'
  }
  const args = ['install', '-g', `${pkg}@latest`]
  try {
    const res = spawnSync(pm, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INSTALL_TIMEOUT_MS,
    })
    const out = (res.stdout ?? '').trim()
    const err = (res.stderr ?? '').trim()
    if (res.status === 0) {
      return out || 'done.'
    }
    return `exit ${res.status}\n${out}\n${err}`.trim()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `failed: ${msg}`
  }
}

/**
 * /update — update OCC to the latest version.
 *
 * Shows current vs latest version, then installs globally:
 *   bun → `bun install -g @cnwenf/occ@latest`
 *   npm → `npm install -g @cnwenf/occ@latest`
 *
 * The package name is read from MACRO.PACKAGE_URL; if it is unset (e.g. the
 * polyfill was bypassed), the command reports that the URL is not configured
 * and does not spawn an install.
 */
export const call: LocalCommandCall = async () => {
  const cur = currentVersion()
  const pm = detectPackageManager()
  const latest = latestVersion()
  const lines: string[] = ['OCC update', `  current: ${cur}`, `  latest:  ${latest ?? 'unknown'}`]

  if (latest && cur !== 'unknown' && cur === latest) {
    lines.push('Already up to date.')
    return { type: 'text', value: lines.join('\n') }
  }

  lines.push(`Updating via ${pm}...`)
  lines.push(runUpdate(pm))
  return { type: 'text', value: lines.join('\n') }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/occ-versioning.e2e.test.ts`
Expected: PASS — the npm branch records an `install -g @cnwenf/occ@latest` call; the falsy-PACKAGE_URL case records no `@latest` install.

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no new errors in `update.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/update/update.ts test/e2e/occ-versioning.e2e.test.ts test/e2e/helpers/update-stub.ts
git commit -m "feat(update): point occ update at @cnwenf/occ and fix bun global install"
```

---

### Task 4: Gate `AutoUpdater.tsx` to notice-only for OCC

**Files:**
- Modify: `src/utils/autoUpdater.ts:35-40` (extend `InstallStatus`)
- Modify: `src/components/AutoUpdater.tsx:81` (notice-only gate) and `:187-195` (notice render branch)

**Interfaces:**
- Consumes: `MACRO.PACKAGE_URL` (Task 1), `getLatestVersion` from `autoUpdater.ts` (existing).
- Produces: when behind and `MACRO.PACKAGE_URL === '@cnwenf/occ'`, `AutoUpdater` calls `onAutoUpdaterResult({ version: latestVersion, status: 'notice', notifications: [...'New version X available — run `occ update`'] })` and **does not** call `installGlobalPackage` / `installOrUpdateClaudePackage`. The render block shows a non-intrusive notice.

- [ ] **Step 1: Extend `InstallStatus` with `'notice'`**

In `src/utils/autoUpdater.ts`, lines 35-40:

```ts
export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'
  | 'notice'
```

- [ ] **Step 2: Add the notice-only gate in `AutoUpdater.tsx`**

In `src/components/AutoUpdater.tsx`, insert a notice-only early branch **before** the existing `!isDisabled && ...` condition at line 81:

```tsx
    // OCC notice-only: never auto-install; surface a non-intrusive notice instead.
    if (MACRO.PACKAGE_URL === '@cnwenf/occ' && currentVersion && latestVersion && !gte(currentVersion, latestVersion) && !shouldSkipVersion(latestVersion)) {
      onAutoUpdaterResult({
        version: latestVersion,
        status: 'notice',
        notifications: [
          `New version ${latestVersion} available — run \`occ update\``,
        ],
      });
      return;
    }

    // Check if update needed and perform update
    if (!isDisabled && currentVersion && latestVersion && !gte(currentVersion, latestVersion) && !shouldSkipVersion(latestVersion)) {
```

- [ ] **Step 3: Add the notice render branch**

In the same file, extend the render block (around lines 187-195). Add a notice branch before the success/failure branches:

```tsx
      {autoUpdaterResult?.status === 'notice' && <Text color="warning" wrap="truncate">
          New version {autoUpdaterResult.version} available — run <Text bold>occ update</Text>
        </Text>}
      {isUpdating ? <>
```

- [ ] **Step 4: Verify the build succeeds**

Run: `bun build src/entrypoints/cli.tsx --outdir dist --target bun`
Expected: "Bundled N modules", no errors.

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/autoUpdater.ts src/components/AutoUpdater.tsx
git commit -m "feat(auto-updater): notice-only gate for OCC, never auto-install"
```

---

### Task 5: Full build + targeted test verification

**Files:**
- Verify only.

- [ ] **Step 1: Full build**

Run: `bun build src/entrypoints/cli.tsx --outdir dist --target bun`
Expected: success, no errors.

- [ ] **Step 2: Run the versioning e2e tests**

Run: `bun test test/e2e/occ-versioning.e2e.test.ts`
Expected: all PASS.

- [ ] **Step 3: Run the full e2e suite with a timeout guard**

Run: `timeout 180 bun test test/e2e`
Expected: no regressions in pre-existing tests (the versioning tests pass; others either pass or are pre-existing skips/failures unrelated to this change).

- [ ] **Step 4: Manual smoke — REPL notice**

Run (with a stubbed-lower version to force the notice):
```bash
bun -e "
(globalThis as any).MACRO = { ...(globalThis as any).MACRO ?? {}, VERSION: '0.0.1', PACKAGE_URL: '@cnwenf/occ' };
import('./src/entrypoints/cli.tsx');
"
```
Expected: the REPL starts; on the next npm registry check it shows "New version 2.1.204 available — run `occ update`" and does **not** auto-install. (If the npm registry is unreachable, no notice appears and no crash occurs.)

- [ ] **Step 5: No final commit unless the build/tests surfaced a fix**

If Steps 1-3 are green, the feature is complete. If a fix was needed, commit it:
```bash
git add -A
git commit -m "fix(versioning): address build/test regressions from Tasks 1-4"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = MACRO.PACKAGE_URL (spec §1). Task 2 = `--version` branding (spec §2). Task 3 = `occ update` rewrite + falsy guard (spec §3). Task 4 = notice-only gate + render branch (spec §4). Error handling (offline → no notice/no crash; falsy PACKAGE_URL → no-op) is covered in Tasks 3 and 4. ✓
- **Type consistency:** `InstallStatus` extended with `'notice'` in Task 4 Step 1; `AutoUpdaterResult` already carries `notifications?: string[]` and `status: InstallStatus`, so the `{ version, status: 'notice', notifications: [...] }` payload is type-safe. ✓
- **No placeholders:** every code step contains the actual code to write. ✓
- The `notifications[]` array is already plumbed into REPL.tsx (existing code: `autoUpdaterResult.notifications` → REPL notifications), so the notice surfaces both as an in-component banner (Task 4 Step 3) and via the REPL notification system.
