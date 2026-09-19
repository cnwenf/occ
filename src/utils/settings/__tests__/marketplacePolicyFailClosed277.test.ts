import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeMarketplacePolicy } from '../marketplacePolicySanitizer'
import { parseSettingsFile } from '../settings'

/**
 * CC 2.1.277 security fix (report_C C9): managed-policy marketplace arrays
 * fail CLOSED per entry, never OPEN per file.
 *
 * Red-test: before the fix, a managed-settings.json with one malformed
 * `strictKnownMarketplaces` / `blockedMarketplaces` entry failed whole-file
 * SettingsSchema validation → the policy file was dropped → both arrays
 * became undefined → NO marketplace restrictions (fail-OPEN). Official v277
 * mechanism (byte-verified): per-entry validation (`Or`/`Ht`/`Hr` + `yf`/`hf`
 * raw filter) — malformed entries are dropped with `Invalid entry was
 * ignored: …`, unenforceable blocked entries are KEPT with `Unenforceable
 * entry was kept: …`, and a present-but-invalid `strictKnownMarketplaces`
 * collapses to `[]` (empty allowlist = nothing installable, fail-CLOSED).
 */

// Mutable policy override consumed by the mocked settings module (same
// spread-real pattern as githubRepoExtraction276.test.ts).
let policySettingsOverride: Record<string, unknown> | null = null

const realSettingsPath = new URL('../settings.js', import.meta.url).pathname
const realSettings = await import(realSettingsPath)
const realGetSettingsForSource = realSettings.getSettingsForSource
const realSettingsSnapshot = { ...realSettings }
mock.module(realSettingsPath, () => ({
  ...realSettingsSnapshot,
  getSettingsForSource: (source: string) => {
    if (source === 'policySettings' && policySettingsOverride) {
      return {
        ...(realGetSettingsForSource(source) ?? {}),
        ...policySettingsOverride,
      }
    }
    return realGetSettingsForSource(source)
  },
}))

const {
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
} = await import('../../plugins/marketplaceHelpers.js')

const ACME_GITHUB = { source: 'github', repo: 'acme/marketplace' } as const
const OTHER_GITHUB = { source: 'github', repo: 'other/marketplace' } as const

function tmpFile(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-c9-'))
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(contents), 'utf8')
  return file
}

describe('2.1.277: sanitizeMarketplacePolicy (unit, C9)', () => {
  test('drops a malformed entry and keeps valid ones with a per-entry warning', () => {
    // Arrange
    const data: Record<string, unknown> = {
      blockedMarketplaces: [ACME_GITHUB, { source: 'nope' }, 'garbage'],
    }

    // Act
    const warnings = sanitizeMarketplacePolicy(data, 'managed-settings.json')

    // Assert — the valid entry survives; each malformed one gets the official
    // per-entry message (byte-verified `Invalid entry was ignored: …`).
    expect(data.blockedMarketplaces).toEqual([ACME_GITHUB])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]?.path).toBe('blockedMarketplaces[1]')
    expect(warnings[0]?.message).toMatch(/^Invalid entry was ignored: .+/)
    expect(warnings[1]?.path).toBe('blockedMarketplaces[2]')
    expect(warnings[1]?.message).toMatch(/^Invalid entry was ignored: .+/)
  })

  test('strictKnownMarketplaces present-but-invalid becomes [] (fail CLOSED)', () => {
    // Arrange — official `.catch()` branch: not an array at all.
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: 'acme/marketplace',
    }

    // Act
    const warnings = sanitizeMarketplacePolicy(data, 'managed-settings.json')

    // Assert — byte-exact official message; [] = no marketplaces admitted.
    expect(data.strictKnownMarketplaces).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      '"strictKnownMarketplaces" was present but invalid; enforcing an empty allowlist (no marketplaces admitted) until it is fixed.',
    )
  })

  test('blockedMarketplaces present-but-invalid is dropped (byte-exact message)', () => {
    // Arrange
    const data: Record<string, unknown> = { blockedMarketplaces: 42 }

    // Act
    const warnings = sanitizeMarketplacePolicy(data, 'managed-settings.json')

    // Assert
    expect('blockedMarketplaces' in data).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      '"blockedMarketplaces" was present but invalid and was dropped; its entries cannot be enforced until it is fixed.',
    )
  })

  test('explicit null is treated as unset (official `hf`) without warnings', () => {
    // Arrange
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: null,
      blockedMarketplaces: null,
    }

    // Act
    const warnings = sanitizeMarketplacePolicy(data, 'managed-settings.json')

    // Assert
    expect('strictKnownMarketplaces' in data).toBe(false)
    expect('blockedMarketplaces' in data).toBe(false)
    expect(warnings).toEqual([])
  })

  test('unenforceable entries: kept in blocked, dropped in strict (official asymmetry)', () => {
    // Arrange — `Ht` reasons: owner wildcard not exactly "<owner>/*", regex
    // that does not compile, git-URL wildcard, ref containing "*".
    const badWildcard = { source: 'github', repo: 'ac*me/x' }
    const badRegex = { source: 'hostPattern', hostPattern: '([' }
    const gitWildcard = { source: 'git', url: 'https://github.com/acme/*' }
    const badRef = { source: 'github', repo: 'acme/x', ref: 'v*' }
    const blocked: Record<string, unknown> = {
      blockedMarketplaces: [badWildcard, badRegex, gitWildcard, badRef],
    }
    const strict: Record<string, unknown> = {
      strictKnownMarketplaces: [badWildcard, badRegex, gitWildcard, badRef],
    }

    // Act
    const blockedWarnings = sanitizeMarketplacePolicy(
      blocked,
      'managed-settings.json',
    )
    const strictWarnings = sanitizeMarketplacePolicy(
      strict,
      'managed-settings.json',
    )

    // Assert — blocked KEEPS every unenforceable entry with the official
    // "kept" warning; strict DROPS every one with the official "ignored" copy.
    expect(blocked.blockedMarketplaces).toEqual([
      badWildcard,
      badRegex,
      gitWildcard,
      badRef,
    ])
    expect(blockedWarnings.map(w => w.message)).toEqual([
      'Unenforceable entry was kept: github: an owner wildcard must be exactly "<owner>/*"; the entry cannot be enforced; it can never match a marketplace source, but marketplace restrictions stay active',
      'Unenforceable entry was kept: hostPattern: regex does not compile; the entry cannot be enforced; it can never match a marketplace source, but marketplace restrictions stay active',
      'Unenforceable entry was kept: git: wildcards are only supported in github-form entries, as "<owner>/*"; the entry cannot be enforced; it can never match a marketplace source, but marketplace restrictions stay active',
      'Unenforceable entry was kept: github: ref contains "*", which git does not allow in ref names; the entry cannot be enforced; it can never match a marketplace source, but marketplace restrictions stay active',
    ])
    expect(strict.strictKnownMarketplaces).toEqual([])
    expect(strictWarnings.map(w => w.message)).toEqual([
      'Invalid entry was ignored: github: an owner wildcard must be exactly "<owner>/*"; the entry cannot be enforced',
      'Invalid entry was ignored: hostPattern: regex does not compile; the entry cannot be enforced',
      'Invalid entry was ignored: git: wildcards are only supported in github-form entries, as "<owner>/*"; the entry cannot be enforced',
      'Invalid entry was ignored: github: ref contains "*", which git does not allow in ref names; the entry cannot be enforced',
    ])
  })

  test('well-formed "<owner>/*" github wildcard is enforceable and kept', () => {
    // Arrange
    const ownerWildcard = { source: 'github', repo: 'acme/*' }
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: [ownerWildcard],
    }

    // Act
    const warnings = sanitizeMarketplacePolicy(data, 'managed-settings.json')

    // Assert
    expect(data.strictKnownMarketplaces).toEqual([ownerWildcard])
    expect(warnings).toEqual([])
  })
})

describe('2.1.277: whole-file integration via parseSettingsFile (C9)', () => {
  test('one malformed entry no longer rejects the whole policy file (was fail-OPEN)', () => {
    // Arrange — pre-fix, the 'garbage' entry + bad strict entry failed the
    // whole-file SettingsSchema parse → settings dropped → no restrictions.
    const file = tmpFile('managed-settings.json', {
      strictKnownMarketplaces: [ACME_GITHUB, { source: 'github' }],
      blockedMarketplaces: ['garbage', OTHER_GITHUB],
    })

    // Act
    const { settings, errors } = parseSettingsFile(file)

    // Assert — file SURVIVES; valid entries keep enforcing; warnings surface.
    expect(settings).not.toBeNull()
    expect(settings?.strictKnownMarketplaces).toEqual([ACME_GITHUB])
    expect(settings?.blockedMarketplaces).toEqual([OTHER_GITHUB])
    expect(errors.map(e => e.message)).toEqual([
      expect.stringMatching(/^Invalid entry was ignored: /),
      expect.stringMatching(/^Invalid entry was ignored: /),
    ])
  })
})

describe('2.1.277: enforcement after sanitization (C9)', () => {
  test('blocked entry stays blocked while malformed siblings are dropped', () => {
    // Arrange
    const data: Record<string, unknown> = {
      blockedMarketplaces: ['garbage', ACME_GITHUB],
    }
    sanitizeMarketplacePolicy(data, 'managed-settings.json')
    policySettingsOverride = data

    // Act / Assert — the valid blocklist entry still blocks; others pass.
    expect(isSourceAllowedByPolicy({ ...ACME_GITHUB })).toBe(false)
    expect(isSourceAllowedByPolicy({ ...OTHER_GITHUB })).toBe(true)

    policySettingsOverride = null
  })

  test('strict allowlist still restricts after a malformed entry is dropped', () => {
    // Arrange
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: [{ source: 'github' }, ACME_GITHUB],
    }
    sanitizeMarketplacePolicy(data, 'managed-settings.json')
    policySettingsOverride = data

    // Act / Assert
    expect(isSourceAllowedByPolicy({ ...ACME_GITHUB })).toBe(true)
    expect(isSourceAllowedByPolicy({ ...OTHER_GITHUB })).toBe(false)

    policySettingsOverride = null
  })

  test('all-malformed strictKnownMarketplaces fails CLOSED (nothing installable)', () => {
    // Arrange — every entry invalid → [] (truthy → restrictions ACTIVE).
    const data: Record<string, unknown> = {
      strictKnownMarketplaces: ['garbage', { source: 'nope' }, 42],
    }
    sanitizeMarketplacePolicy(data, 'managed-settings.json')
    policySettingsOverride = data

    // Act / Assert — [] not null: getStrictKnownMarketplaces returns the
    // empty allowlist and EVERY source is denied.
    expect(getStrictKnownMarketplaces()).toEqual([])
    expect(isSourceAllowedByPolicy({ ...ACME_GITHUB })).toBe(false)
    expect(isSourceAllowedByPolicy({ ...OTHER_GITHUB })).toBe(false)

    policySettingsOverride = null
  })
})
