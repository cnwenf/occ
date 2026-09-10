import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSecurityAllowlists } from '../sanitizeAllowlists'
import { parseSettingsFile } from '../settings'

/**
 * CC 2.1.267 security fix (changelog #12, Gap-121a): managed-policy security
 * allowlists fail CLOSED on invalid input.
 *
 * Red-test: before the fix, a managed-settings.json with an invalid
 * `allowedHttpHookUrls` entry failed whole-file SettingsSchema validation →
 * settings dropped → allowlist undefined → "all URLs allowed" (fail-OPEN).
 * Official fix (v267 binary fn `xn`): per-entry validation, invalid entries
 * dropped with `Invalid entry was ignored: …` warnings; present-but-invalid
 * or all-invalid keys become `[]` (deny-all) with the exact `enforcing an
 * empty allowlist (…)` copies. `allowedChannelPlugins` also accepts the
 * legacy "plugin@marketplace" string form (official `Ac`).
 */

function tmpFile(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-121a-'))
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(contents), 'utf8')
  return file
}

describe('2.1.267: sanitizeSecurityAllowlists (unit, Gap-121a)', () => {
  test('drops an invalid entry and keeps valid ones with a per-entry warning', () => {
    // Arrange
    const data: Record<string, unknown> = {
      allowedHttpHookUrls: ['https://hooks.example.com/*', 42, null],
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.allowedHttpHookUrls).toEqual(['https://hooks.example.com/*'])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]?.path).toBe('allowedHttpHookUrls[1]')
    expect(warnings[0]?.message).toMatch(/^Invalid entry was ignored: /)
    expect(warnings[0]?.invalidValue).toBe(42)
    expect(warnings[1]?.path).toBe('allowedHttpHookUrls[2]')
  })

  test('present-but-invalid key becomes an empty (deny-all) allowlist', () => {
    // Arrange — the official .catch() branch: not an array at all.
    const data: Record<string, unknown> = {
      allowedHttpHookUrls: 'https://hooks.example.com/*',
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert — fail CLOSED: [] means "no HTTP hooks may run", never undefined.
    expect(data.allowedHttpHookUrls).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      '"allowedHttpHookUrls" was present but invalid; enforcing an empty allowlist (no HTTP hooks may run) until it is fixed.',
    )
  })

  test('all-invalid entries enforce the empty allowlist with the official copy', () => {
    // Arrange
    const data: Record<string, unknown> = {
      httpHookAllowedEnvVars: [{ not: 'a string' }, 7],
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.httpHookAllowedEnvVars).toEqual([])
    const everyEntry = warnings.filter(w =>
      w.message.startsWith('Every entry of'),
    )
    expect(everyEntry).toHaveLength(1)
    expect(everyEntry[0]?.message).toBe(
      'Every entry of "httpHookAllowedEnvVars" was invalid; enforcing an empty allowlist (no environment variables may be interpolated into HTTP hook headers) until it is fixed.',
    )
    // Plus one per-entry warning for each dropped entry.
    expect(
      warnings.filter(w => w.message.startsWith('Invalid entry was ignored')),
    ).toHaveLength(2)
  })

  test('an explicitly empty array stays empty and warns nothing', () => {
    // Arrange — [] is the documented deny-all; not an error condition.
    const data: Record<string, unknown> = { allowedHttpHookUrls: [] }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.allowedHttpHookUrls).toEqual([])
    expect(warnings).toHaveLength(0)
  })

  test('absent keys stay absent (undefined = unrestricted semantics unchanged)', () => {
    // Arrange
    const data: Record<string, unknown> = { theme: 'dark' }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect('allowedHttpHookUrls' in data).toBe(false)
    expect('httpHookAllowedEnvVars' in data).toBe(false)
    expect('allowedChannelPlugins' in data).toBe(false)
    expect(warnings).toHaveLength(0)
  })

  test('allowedChannelPlugins accepts the documented object form unchanged', () => {
    // Arrange
    const entry = { marketplace: 'acme-market', plugin: 'notifier' }
    const data: Record<string, unknown> = { allowedChannelPlugins: [entry] }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.allowedChannelPlugins).toEqual([entry])
    expect(warnings).toHaveLength(0)
  })

  test('allowedChannelPlugins converts the legacy "plugin@marketplace" string form', () => {
    // Arrange — official `Ac`: split at the FIRST '@'.
    const data: Record<string, unknown> = {
      allowedChannelPlugins: ['notifier@acme-market'],
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.allowedChannelPlugins).toEqual([
      { marketplace: 'acme-market', plugin: 'notifier' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      '"allowedChannelPlugins" entry "notifier@acme-market" was accepted; prefer the documented object form {"plugin": "notifier", "marketplace": "acme-market"}.',
    )
  })

  test('allowedChannelPlugins drops invalid object entries with path-qualified detail', () => {
    // Arrange — marketplace has the wrong type; zod issue path qualifies the
    // message per official `${path.join(".")}: ${message}` formatting.
    const data: Record<string, unknown> = {
      allowedChannelPlugins: [{ marketplace: 5, plugin: 'notifier' }],
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert — fail CLOSED (all entries invalid → []).
    expect(data.allowedChannelPlugins).toEqual([])
    expect(warnings.some(w => w.message.startsWith('Every entry of'))).toBe(
      true,
    )
    const ignored = warnings.find(w =>
      w.message.startsWith('Invalid entry was ignored'),
    )
    expect(ignored?.message).toContain('marketplace')
  })

  test('a bare string without @ in allowedChannelPlugins is dropped, not converted', () => {
    // Arrange — VT() rejects → the string fails the object schema.
    const data: Record<string, unknown> = {
      allowedChannelPlugins: ['just-a-name'],
    }

    // Act
    sanitizeSecurityAllowlists(data, 'managed-settings.json')

    // Assert
    expect(data.allowedChannelPlugins).toEqual([])
  })

  test('non-object data is a no-op', () => {
    expect(sanitizeSecurityAllowlists(null, 'f.json')).toEqual([])
    expect(sanitizeSecurityAllowlists('str', 'f.json')).toEqual([])
  })
})

describe('2.1.267: managed allowlist fail-closed (behavioral, Gap-121a)', () => {
  test('a settings file with one invalid allowlist entry parses: entry dropped, rest honored', () => {
    // Arrange — before the fix this WHOLE file was rejected (settings null),
    // which for managed policy meant the allowlist silently became
    // unrestricted (fail-OPEN).
    const file = tmpFile('managed-settings.json', {
      allowedHttpHookUrls: ['https://hooks.example.com/*', { bad: true }],
      channelsEnabled: true,
    })

    // Act
    const { settings, errors } = parseSettingsFile(file)

    // Assert — file survives; allowlist holds only the valid entry.
    expect(settings).not.toBeNull()
    expect(settings?.allowedHttpHookUrls).toEqual([
      'https://hooks.example.com/*',
    ])
    expect(settings?.channelsEnabled).toBe(true)
    expect(
      errors.some(e => e.message.startsWith('Invalid entry was ignored')),
    ).toBe(true)
  })

  test('a settings file whose allowlist key is entirely invalid parses with deny-all []', () => {
    // Arrange
    const file = tmpFile('managed-settings.json', {
      allowedHttpHookUrls: 'not-an-array',
    })

    // Act
    const { settings, errors } = parseSettingsFile(file)

    // Assert — [] (deny-all), NOT undefined (allow-all): fail CLOSED.
    expect(settings).not.toBeNull()
    expect(settings?.allowedHttpHookUrls).toEqual([])
    expect(
      errors.some(e => e.message.includes('enforcing an empty allowlist')),
    ).toBe(true)
  })

  test('a fully valid allowlist file parses with zero warnings (no regression)', () => {
    // Arrange
    const file = tmpFile('managed-settings.json', {
      allowedHttpHookUrls: ['https://a.example.com/*'],
      httpHookAllowedEnvVars: ['CI'],
      allowedChannelPlugins: [{ marketplace: 'm', plugin: 'p' }],
    })

    // Act
    const { settings, errors } = parseSettingsFile(file)

    // Assert
    expect(settings?.allowedHttpHookUrls).toEqual(['https://a.example.com/*'])
    expect(settings?.httpHookAllowedEnvVars).toEqual(['CI'])
    expect(settings?.allowedChannelPlugins).toEqual([
      { marketplace: 'm', plugin: 'p' },
    ])
    expect(errors).toEqual([])
  })
})
