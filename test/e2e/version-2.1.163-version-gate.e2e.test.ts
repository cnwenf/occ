import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * F1 (2.1.163): requiredMinimumVersion / requiredMaximumVersion startup
 * version gate. The schema fields existed but were schema-only — the gate
 * must refuse to start (stderr + exit 1) when the OCC version is outside the
 * managed range, except for update/install/doctor (remediation commands).
 *
 * Source-grep e2e: verifies the gate function + wording + skip set match the
 * official 2.1.200 binary's `xwc`/`Rwc`/`Lwc`.
 */

describe('requiredMinimumVersion/requiredMaximumVersion startup gate (2.1.163)', () => {
  test('getRequiredVersionError reads policy constraints + applies the skip set', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/settings/settings.ts`).text()
    // Reads the managed (policy) constraints.
    expect(src).toContain('requiredMinimumVersion')
    expect(src).toContain('requiredMaximumVersion')
    expect(src).toContain("getSettingsForSource('policySettings')")
    // update/install/doctor are exempt so users can remediate (official Dxm).
    expect(src).toContain("new Set(['update', 'install', 'doctor'])")
    // Exports the gate function consumed by the entrypoint.
    expect(src).toMatch(/export function getRequiredVersionError/)
  })

  test('gate messages keep the official semantics with OCC command names', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/settings/settings.ts`).text()
    // Min: "older than the minimum version required by your organization".
    expect(src).toContain('is older than the minimum version required by your organization')
    expect(src).toContain("Update OCC using your organization's approved method, then try again.")
    expect(src).toContain('If automatic updates are available')
    expect(src).toContain('occ update')
    // Max: "newer than the maximum version allowed by your organization".
    expect(src).toContain('is newer than the maximum version allowed by your organization')
    expect(src).toContain('Your organization requires version')
    expect(src).toContain('or older. Install an approved version using your organization')
    expect(src).toContain('occ install')
    // Invalid semver constraint is logged and ignored (official hyr.parse guard).
    expect(src).toContain('is not a valid semver version — ignoring')
    // Comparison helpers (gte = current>=min ok; lte = current<=max ok).
    expect(src).toMatch(/from '\.\.\/semver\.js'/)
    expect(src).toContain('gte(')
    expect(src).toContain('lte(')
  })

  test('semver.ts exposes parseVersion for constraint validation', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/semver.ts`).text()
    expect(src).toMatch(/export function parseVersion/)
    // Uses the npm semver package (the official binary uses hyr = semver for parse).
    expect(src).toContain('.parse(v, { loose: true })')
  })

  test('cli.tsx wires the gate before loading the full CLI (stderr + exit 1)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/entrypoints/cli.tsx`).text()
    // Gate runs after fast-paths, before main.jsx import (mirrors Lwc timing).
    const gateIdx = src.indexOf('getRequiredVersionError')
    const mainImportIdx = src.indexOf('import("../main.jsx")')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(mainImportIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(mainImportIdx)
    // Derives the top-level command from the first positional arg.
    expect(src).toContain("args.find(a => !a.startsWith('-'))")
    // Writes the error + newline to stderr and exits non-zero (official Lwc).
    expect(src).toContain('process.stderr.write(`${versionError}\\n`)')
    expect(src).toContain('process.exit(1)')
  })
})
