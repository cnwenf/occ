import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePluginManifest } from '../validatePlugin.js'

/**
 * CC 2.1.281 (#059): `claude plugin validate` stops flagging recognized
 * listing-metadata keys (icon, screenshots, classification, privacyPolicyUrl,
 * privacy_policy, privacyPolicy, supportUrl, support, bugs, termsOfServiceUrl,
 * terms_of_service, documentationUrl, docs) as unknown fields.
 *
 * These are valid plugin.json listing metadata that the typed
 * `PluginManifestSchema` does not model, so the `.strict()` pass in
 * validatePluginManifest used to report each as an `unrecognized_keys` error.
 * The official unknown-field checker keeps a known-keys set (binary `Me`
 * @228859849, consumed as `if(n.has(c)||i?.has(c))continue` @228864006) and
 * skips them outright — not an error, not a warning. OCC mirrors this with the
 * `LISTING_METADATA_MANIFEST_FIELDS` allowlist: the keys are stripped silently
 * before the `.strict()` validation, never added as typed schema fields.
 *
 * v280 has ZERO hits for the allowlist and for `privacyPolicyUrl`, so this is a
 * genuine 2.1.281 delta.
 */

// The 13 keys, verbatim from the official set (order/spelling match the binary).
const LISTING_METADATA_KEYS = [
  'icon',
  'screenshots',
  'classification',
  'privacyPolicyUrl',
  'privacy_policy',
  'privacyPolicy',
  'supportUrl',
  'support',
  'bugs',
  'termsOfServiceUrl',
  'terms_of_service',
  'documentationUrl',
  'docs',
] as const

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

async function writePluginJson(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'listing-meta-281-'))
  tempRoots.push(root)
  const pluginDir = join(root, '.claude-plugin')
  await mkdir(pluginDir, { recursive: true })
  const filePath = join(pluginDir, 'plugin.json')
  await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
  return filePath
}

describe('validatePluginManifest: listing-metadata allowlist (CC 2.1.281 #059)', () => {
  test('a manifest carrying ALL 13 listing-metadata keys validates clean (no errors)', async () => {
    const manifest = {
      name: 'test-plugin',
      ...Object.fromEntries(LISTING_METADATA_KEYS.map(key => [key, 'x'])),
    }
    const result = await validatePluginManifest(await writePluginJson(manifest))

    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test.each([...LISTING_METADATA_KEYS])(
    'listing-metadata key %j is not reported as an unknown field',
    async key => {
      const result = await validatePluginManifest(
        await writePluginJson({ name: 'test-plugin', [key]: 'value' }),
      )

      expect(result.success).toBe(true)
      // Suppressed silently: the key appears in neither errors nor warnings.
      const mentioned = [...result.errors, ...result.warnings].some(
        issue => issue.path === key || issue.message.includes(key),
      )
      expect(mentioned).toBe(false)
    },
  )

  test('listing-metadata keys are suppressed silently — a fully-valid manifest plus those keys yields zero warnings and zero errors', async () => {
    const manifest = {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'a plugin',
      author: { name: 'Test Author' },
      privacyPolicyUrl: 'https://example.com/privacy',
      supportUrl: 'https://example.com/support',
      icon: 'icon.png',
    }
    const result = await validatePluginManifest(await writePluginJson(manifest))

    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  test('a genuinely unknown key is STILL flagged (allowlist is targeted, not a blanket suppression)', async () => {
    const result = await validatePluginManifest(
      await writePluginJson({ name: 'test-plugin', nonsenseFieldXYZ: 'bad' }),
    )

    expect(result.success).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('an unknown key alongside listing-metadata keys is still flagged (only the allowlisted keys are dropped)', async () => {
    const result = await validatePluginManifest(
      await writePluginJson({
        name: 'test-plugin',
        privacyPolicyUrl: 'https://example.com/privacy',
        nonsenseFieldXYZ: 'bad',
      }),
    )

    expect(result.success).toBe(false)
    // The bogus key is reported; the listing-metadata key is not.
    const messages = result.errors.map(e => e.message).join(' ')
    expect(messages).toContain('nonsenseFieldXYZ')
    expect(messages).not.toContain('privacyPolicyUrl')
  })

  test('marketplace-only fields still surface as warnings (regression guard for the neighbouring allowlist)', async () => {
    const result = await validatePluginManifest(
      await writePluginJson({ name: 'test-plugin', category: 'productivity' }),
    )

    // marketplace-only key → warning (not error), and validation still succeeds.
    expect(result.success).toBe(true)
    expect(result.warnings.some(w => w.path === 'category')).toBe(true)
  })
})
