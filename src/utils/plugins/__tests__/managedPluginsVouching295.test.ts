/**
 * CC 2.1.295 (#073) — managed-plugin provenance vouching gate.
 *
 * Official changelog: "Fixed a tampered cache of server-managed settings
 * making a person's own plugin count as organization-managed on machines
 * whose managed settings list or enable plugins."
 *
 * Official face (binary forensics): s294's `eU()` read
 * `me("policySettings")?.enabledPlugins` directly; s295 gates the managed
 * name set behind the vouched admin tier (`x()`/`L(e)=S(e)||Dvo()`,
 * `Yxt` 0→4 hits, `Dvo` 2→4, NEW const "managed settings this session does
 * not vouch for (such as remote managed settings the server has not
 * confirmed this session, or a document your user account can write)").
 *
 * OCC port: the unvouched policySettings arms are 'remote' (plain-JSON disk
 * cache; OCC never server-confirms) and 'hkcu' (user-writable). Plugin keys
 * from them are not treated as the organization's; the machine's own vouched
 * arms (MDM plist/HKLM, managed-settings.json file) still count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Mocks (OCC-97/OCC-103 delegation pattern — getters fall back to the real
// implementations once `mockActive` flips false in afterAll).
// ---------------------------------------------------------------------------

type PolicyOrigin = 'remote' | 'plist' | 'hklm' | 'file' | 'hkcu' | null

let mockActive = false
let origin: PolicyOrigin = null
let policySettings: Record<string, unknown> | null = null
let mdmSettings: Record<string, unknown> = {}
let fileSettings: Record<string, unknown> | null = null

let actualSettingsMod: Record<string, unknown>
let actualMdmMod: Record<string, unknown>
let realGetPolicySettingsOrigin: () => PolicyOrigin
let realGetSettingsForSource: (source: string) => unknown
let realLoadManagedFileSettings: () => { settings: unknown; errors: unknown[] }
let realGetMdmSettings: () => { settings: Record<string, unknown>; errors: unknown[] }

let mod: typeof import('../managedPlugins.js')

beforeAll(async () => {
  actualSettingsMod = (await import('../../settings/settings.js')) as unknown as Record<string, unknown>
  const actualSettings = actualSettingsMod as never as {
    getPolicySettingsOrigin: () => PolicyOrigin
    getSettingsForSource: (source: string) => unknown
    loadManagedFileSettings: () => { settings: unknown; errors: unknown[] }
  }
  realGetPolicySettingsOrigin = actualSettings.getPolicySettingsOrigin
  realGetSettingsForSource = actualSettings.getSettingsForSource
  realLoadManagedFileSettings = actualSettings.loadManagedFileSettings

  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsMod,
    getPolicySettingsOrigin: () =>
      mockActive ? origin : realGetPolicySettingsOrigin(),
    getSettingsForSource: (source: string) => {
      if (!mockActive) return realGetSettingsForSource(source)
      return source === 'policySettings' ? policySettings : realGetSettingsForSource(source)
    },
    loadManagedFileSettings: () =>
      mockActive
        ? { settings: fileSettings, errors: [] }
        : realLoadManagedFileSettings(),
  }))

  actualMdmMod = (await import('../../settings/mdm/settings.js')) as unknown as Record<string, unknown>
  realGetMdmSettings = (actualMdmMod as never as {
    getMdmSettings: () => { settings: Record<string, unknown>; errors: unknown[] }
  }).getMdmSettings

  mock.module('../../settings/mdm/settings.js', () => ({
    ...actualMdmMod,
    getMdmSettings: () =>
      mockActive ? { settings: mdmSettings, errors: [] } : realGetMdmSettings(),
  }))

  mockActive = true
  mod = await import('../managedPlugins.js')
})

afterAll(() => {
  mockActive = false
})

beforeEach(() => {
  origin = null
  policySettings = null
  mdmSettings = {}
  fileSettings = null
})

describe('CC 2.1.295 #073: managed-plugin provenance vouching gate', () => {
  test('tampered remote cache alone does NOT make a personal plugin org-managed', () => {
    origin = 'remote'
    policySettings = { enabledPlugins: { 'personal-plugin@market': true } }
    expect(mod.getManagedPluginNames()).toBeNull()
  })

  test("machine's own MDM settings still count while the remote arm wins the cascade", () => {
    origin = 'remote'
    policySettings = { enabledPlugins: { 'personal-plugin@market': true } }
    mdmSettings = { enabledPlugins: { 'corp-tool@market': true } }
    const names = mod.getManagedPluginNames()
    expect(names).toEqual(new Set(['corp-tool']))
  })

  test("managed-settings.json counts as vouched fallback when MDM is empty", () => {
    origin = 'remote'
    policySettings = { enabledPlugins: { 'personal-plugin@market': true } }
    fileSettings = { enabledPlugins: { 'corp-file@market': false } }
    const names = mod.getManagedPluginNames()
    expect(names).toEqual(new Set(['corp-file']))
  })

  test('user-writable hkcu arm is not vouched either', () => {
    origin = 'hkcu'
    policySettings = { enabledPlugins: { 'personal-plugin@market': true } }
    expect(mod.getManagedPluginNames()).toBeNull()
  })

  test('vouched origins (plist/hklm/file) behave as before', () => {
    for (const o of ['plist', 'hklm', 'file'] as const) {
      origin = o
      policySettings = {
        enabledPlugins: {
          'corp-tool@market': true,
          'disabled-corp@market': false,
          'legacy/repo': ['owner/repo'],
          'no-at-entry': true,
        },
      }
      const names = mod.getManagedPluginNames()
      expect(names).toEqual(new Set(['corp-tool', 'disabled-corp']))
    }
  })

  test('no policy settings at all → null (unchanged common case)', () => {
    origin = null
    policySettings = null
    expect(mod.getManagedPluginNames()).toBeNull()
  })
})
