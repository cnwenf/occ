import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SettingsJson } from '../types.js'

/**
 * OCC-132 P3-6 (CC 2.1.278): C9 marketplace / Gap-121a allowlist
 * sanitization must cover EVERY policy source, not just the file path.
 *
 * Official binary evidence (2.1.278 ELF): the generic policy-source parse
 * `If(e,n)` runs `D2e(r,n,{skipMcpServerEntryFilter:!0,policySource:!0})`
 * then `Qn(nl(n,i),n).safeParse(s)` — `Qn` wraps every field in a per-field
 * `.catch()` and gives strictKnownMarketplaces/blockedMarketplaces the
 * per-entry fail-closed treatment (`Or`). The file parse `XPe(e,n,s)` uses
 * the same `Qn` schema when `s` (policySource) is truthy. So remote, MDM
 * (HKLM/plist), managed-settings.json, and HKCU all get identical
 * fail-closed sanitization; one malformed entry never rejects the whole
 * policy source (which would fail restrictions OPEN).
 *
 * Pre-fix, OCC sanitized only parseSettingsFile (the file path); the remote
 * cache parse and the MDM/HKCU `parseCommandOutputAsSettings` used raw
 * `SettingsSchema().safeParse(data)` → a malformed marketplace entry
 * rejected the entire source → policySettings undefined → fail-OPEN.
 */

// -- Remote managed-settings cache injection via the REAL state API
// (setEligibility + setSessionCache) — NOT mock.module. OCC-132 P3-6/E-9:
// a module-level mock of syncCacheState proved fragile in the shared-process
// combined run (bun live-binding patching doesn't reliably reach a settings.ts
// instance another test file already loaded). The real module exposes state
// setters, so injecting the cache is a plain function call: order-independent,
// nothing to leak, nothing to restore beyond resetSyncCache(). --
const { setEligibility, setSessionCache, resetSyncCache } = await import(
  '../../../services/remoteManagedSettings/syncCacheState.js'
)
const { sanitizePolicySourceData } = await import(
  '../policySourceSanitizer.js'
)
const { parseCommandOutputAsSettings } = await import('../mdm/settings.js')
const { resetSettingsCache } = await import('../settingsCache.js')

const ACME_GITHUB = { source: 'github', repo: 'acme/marketplace' } as const
const OTHER_GITHUB = { source: 'github', repo: 'other/marketplace' } as const

/** Inject (or clear, with null) the remote managed-settings cache. */
function setRemoteCacheOverride(value: Record<string, unknown> | null): void {
  setEligibility(value !== null)
  setSessionCache(value as unknown as SettingsJson | null)
}

beforeEach(() => {
  setRemoteCacheOverride(null)
  resetSettingsCache()
})

describe('2.1.278: sanitizePolicySourceData (shared policy pre-parse)', () => {
  test('runs all three sanitizers and merges warnings in file-path order', () => {
    // Arrange — one malformed entry per covered family.
    const data: Record<string, unknown> = {
      permissions: { allow: ['Bash(git status)', 42] },
      allowedHttpHookUrls: ['https://ok.example.com', 42],
      blockedMarketplaces: [ACME_GITHUB, 'garbage'],
    }

    // Act
    const warnings = sanitizePolicySourceData(data, 'test policy source')

    // Assert — permission rule filtered, allowlist entry dropped, bad
    // marketplace entry dropped; the valid siblings all survive.
    expect((data.permissions as { allow: unknown[] }).allow).toEqual([
      'Bash(git status)',
    ])
    expect(data.allowedHttpHookUrls).toEqual(['https://ok.example.com'])
    expect(data.blockedMarketplaces).toEqual([ACME_GITHUB])
    expect(warnings.length).toBe(3)
    expect(warnings.every(w => w.file === 'test policy source')).toBe(true)
  })

  test('present-but-invalid strictKnownMarketplaces collapses to [] (fail CLOSED)', () => {
    // Arrange
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: 'acme/marketplace',
    }

    // Act
    const warnings = sanitizePolicySourceData(data, 'test policy source')

    // Assert — byte-exact official message.
    expect(data.strictKnownMarketplaces).toEqual([])
    expect(warnings[0]?.message).toBe(
      '"strictKnownMarketplaces" was present but invalid; enforcing an empty allowlist (no marketplaces admitted) until it is fixed.',
    )
  })
})

describe('2.1.278: MDM/HKCU parse point is sanitized (P3-6)', () => {
  test('one malformed marketplace entry no longer rejects the whole MDM source', () => {
    // Arrange — plutil/registry JSON stdout with a mixed strict array.
    const stdout = JSON.stringify({
      strictKnownMarketplaces: [ACME_GITHUB, { source: 'github' }],
      blockedMarketplaces: ['garbage', OTHER_GITHUB],
    })

    // Act
    const { settings, errors } = parseCommandOutputAsSettings(stdout, 'plist')

    // Assert — source SURVIVES (pre-fix: settings {} = whole source dropped
    // = fail-OPEN); valid entries keep enforcing; warnings surface.
    expect(Object.keys(settings).length).toBeGreaterThan(0)
    expect(settings.strictKnownMarketplaces).toEqual([ACME_GITHUB])
    expect(settings.blockedMarketplaces).toEqual([OTHER_GITHUB])
    expect(
      errors.filter(e => /^Invalid entry was ignored: /.test(e.message)),
    ).toHaveLength(2)
  })

  test('re-parsing identical output re-emits warnings (no shared-cache mutation)', () => {
    // Arrange — safeParseJSON memoizes parse results keyed by the raw
    // string and returns the shared cached object on a hit; the sanitizers
    // mutate in place, so without clone-before-sanitize the second parse of
    // the same string would find the cache entry already clean and silently
    // drop its warnings.
    const stdout = JSON.stringify({
      blockedMarketplaces: ['garbage-entry', OTHER_GITHUB],
    })

    // Act
    const first = parseCommandOutputAsSettings(stdout, 'plist')
    const second = parseCommandOutputAsSettings(stdout, 'plist')

    // Assert — both parses report the same warning and sanitized settings.
    expect(first.errors).toHaveLength(1)
    expect(second.errors).toHaveLength(1)
    expect(second.settings.blockedMarketplaces).toEqual([OTHER_GITHUB])
  })

  test('invalid permission rule in MDM output is filtered without dropping the source', () => {
    // Arrange
    const stdout = JSON.stringify({
      permissions: { deny: ['Bash(rm -rf *)', 123] },
    })

    // Act
    const { settings, errors } = parseCommandOutputAsSettings(
      stdout,
      'Registry: HKLM',
    )

    // Assert
    expect(settings.permissions?.deny).toEqual(['Bash(rm -rf *)'])
    expect(errors.length).toBe(1)
  })
})

describe('2.1.278: remote policy cache is sanitized on read (P3-6)', () => {
  // E-9/OCC-132: import settings.js via a `?unmocked` cache-bust inside each
  // test. A sibling file (projectScopeEnvBlocklist251) installs a top-level
  // `mock.module('../settings/settings.js')` stub whose getSettingsForSource
  // returns `settingsBySource[source] ?? null` — it never reads syncCacheState.
  // bun collects ALL files' top-level mock.module installs before running any
  // test, and the sibling's afterAll restore has not landed when these run, so
  // a plain import (top-level OR in-test) resolves to the stub → policy null →
  // the assertions read `undefined`. The `?unmocked` query makes bun evaluate a
  // fresh, guaranteed-unmocked settings.js instance; it still imports
  // syncCacheState WITHOUT a query, so it shares the same singleton we inject
  // into via setRemoteCacheOverride below. This keeps the test hermetic against
  // cross-file mock leakage without touching the sibling's (correct) discipline.
  test('getSettingsForSource(policySettings) returns the sanitized remote view', async () => {
    const { getSettingsForSource } = await import('../settings.js?unmocked')
    // Arrange — remote cache holds a present-but-invalid strict array and a
    // mixed blocklist.
    const rawRemote = {
      strictKnownMarketplaces: 'acme/marketplace',
      blockedMarketplaces: ['garbage', OTHER_GITHUB],
    }
    setRemoteCacheOverride(rawRemote)

    // Act
    const policy = getSettingsForSource('policySettings')

    // Assert — enforcement readers see the fail-CLOSED [] and the surviving
    // valid blocklist entry, never the raw malformed values.
    expect(policy?.strictKnownMarketplaces).toEqual([])
    expect(policy?.blockedMarketplaces).toEqual([OTHER_GITHUB])
  })

  test('sanitizing the remote view does not mutate the shared cache object', async () => {
    const { getSettingsForSource } = await import('../settings.js?unmocked')
    // Arrange
    const rawRemote = {
      blockedMarketplaces: ['garbage', OTHER_GITHUB],
    }
    setRemoteCacheOverride(rawRemote)

    // Act
    getSettingsForSource('policySettings')

    // Assert — clone-before-sanitize: the cached object is untouched, so
    // other consumers (and the next cache generation) see pristine data.
    expect(rawRemote.blockedMarketplaces).toEqual(['garbage', OTHER_GITHUB])
  })
})

// E-9/P2: leave the real sync-cache state pristine so the shared-process run
// doesn't see an injected remote cache in later test files.
afterAll(() => {
  resetSyncCache()
  resetSettingsCache()
})
