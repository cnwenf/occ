import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.282 managed-settings fail-closed validation (settings-trust cluster).
 *
 * Bullet (a): mistyped boolean/"disable" lock values in a policy source apply
 * the lock fail-closed (string coercion, restrictive substitution) and the
 * record names the key. Bullet (b): managed permissions/autoMode/worktree/
 * attribution blocks are salvaged per-field — one invalid nested value no
 * longer discards the whole block (or the whole document).
 *
 * All message strings are byte-exact ports from the official 2.1.282 binary
 * (`Ko`/`Ni`/`Ki`/`tg`/`zo`/`zi`/`Oi`/`Mi`/`pd`/`jdn` — see policyLocks.ts /
 * policyStrictSchema.ts headers for offsets). Documented deviation from the
 * task bullet: the "set to false → absent" reading only exists in the
 * top-level lock loop (`Ni`); a nested `permissions.disableBypassPermissionsMode:
 * false` goes through the per-field salvage (`tg`) and substitutes the
 * restrictive value `"disable"` — binary behavior is asserted here.
 */

const {
  buildStrictPolicySchema,
  createPolicyIssueSink,
  managedDocNotObjectRecord,
} = await import('../policyStrictSchema.js')
const { coerceStringBoolean } = await import('../policyLocks.js')
const { parseSettingsFile } = await import('../settings.js')
const { resetSettingsCache } = await import('../settingsCache.js')
const { parseCommandOutputAsSettings } = await import('../mdm/settings.js')

type PolicyRecord = {
  file?: string
  path: string
  message: string
  severity?: 'error' | 'warning'
  statusOnly?: boolean
  startupFatal?: boolean
  substituted?: boolean
  onlySubstitutes?: boolean
  userWritable?: boolean
}

function parseStrict(doc: unknown): {
  success: boolean
  data: Record<string, unknown>
  errors: PolicyRecord[]
} {
  const errors: PolicyRecord[] = []
  const result = buildStrictPolicySchema(
    createPolicyIssueSink('managed-settings.json', errors),
  ).safeParse(doc)
  return {
    success: result.success,
    data: result.success ? (result.data as Record<string, unknown>) : {},
    errors,
  }
}

const tmpDirs: string[] = []
function fixture(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-282-'))
  tmpDirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, contents, 'utf8')
  return file
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

beforeEach(() => {
  resetSettingsCache()
})

// ---------------------------------------------------------------------------
// (a) lock fields — 2.1.282 bullet a
// ---------------------------------------------------------------------------

describe('2.1.282 policy locks: string coercion + statusOnly', () => {
  test('boolean lock written as "true" coerces and names the key', () => {
    const { success, data, errors } = parseStrict({ disableAgentView: 'true' })

    expect(success).toBe(true)
    expect(data.disableAgentView).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('disableAgentView')
    expect(errors[0]?.message).toBe(
      '"disableAgentView" holds the string "true" where a boolean belongs; reading it as true. Write it without quotes.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.severity).toBe('warning')
    expect(errors[0]?.substituted).toBeUndefined()
  })

  test('"disable"-only lock written as "false" reads as absent', () => {
    const { data, errors } = parseStrict({ disableAutoMode: false })

    expect('disableAutoMode' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(
      '"disableAutoMode" was set to false; reading it as absent (the key\'s only value is "disable"). Remove the key instead.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
  })

  test('string "false" on a "disable"-only lock also reads as absent', () => {
    const { data, errors } = parseStrict({ disableAutoMode: 'false' })

    expect('disableAutoMode' in data).toBe(false)
    expect(errors[0]?.message).toBe(
      '"disableAutoMode" was set to false; reading it as absent (the key\'s only value is "disable"). Remove the key instead.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
  })
})

describe('2.1.282 policy locks: restrictive substitution', () => {
  test('invalid boolean lock substitutes true and flags the tail record', () => {
    const { data, errors } = parseStrict({
      disableSkillShellExecution: 'yes',
    })

    expect(data.disableSkillShellExecution).toBe(true)
    expect(errors[0]?.message).toBe(
      '"disableSkillShellExecution" was present but invalid; treating it as true (its restrictive value) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    // onlySubstitutes tail: the lock is this source's only policy content.
    expect(errors[1]?.onlySubstitutes).toBe(true)
    expect(errors[1]?.statusOnly).toBe(true)
    expect(errors[1]?.message).toBe(
      '"disableSkillShellExecution" holds nothing that could be applied as written and is this source\'s only policy content; its fail-closed reading binds (beside a lower managed settings source\'s policy, when one supplies it) until it is fixed.',
    )
  })

  test('restrictive-false lock substitutes false', () => {
    const { data, errors } = parseStrict({ channelsEnabled: 'bogus' })

    expect(data.channelsEnabled).toBe(false)
    expect(errors[0]?.message).toBe(
      '"channelsEnabled" was present but invalid; treating it as false (its restrictive value) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
  })

  test('nested disableBypassPermissionsMode:false substitutes "disable" (binary behavior)', () => {
    // Deviation note: the task bullet suggested absent+statusOnly here, but
    // the official defines the nested key plainly (wi()) and the "set to
    // false" reading exists only in the top-level Ni loop — the nested field
    // goes through tg strategy 1 (restrictive substitution).
    const { data, errors } = parseStrict({
      permissions: { disableBypassPermissionsMode: false },
    })

    const permissions = data.permissions as Record<string, unknown>
    expect(permissions.disableBypassPermissionsMode).toBe('disable')
    const record = errors.find(
      e => e.path === 'permissions.disableBypassPermissionsMode',
    )
    expect(record?.message).toBe(
      '"disableBypassPermissionsMode" was present but invalid (expected "disable"); treating it as "disable", its restrictive value, until it is fixed.',
    )
    expect(record?.substituted).toBe(true)
  })

  test('invalid strictPluginOnlyCustomization locks everything (true)', () => {
    const { data, errors } = parseStrict({
      strictPluginOnlyCustomization: 'bogus',
    })

    expect(data.strictPluginOnlyCustomization).toBe(true)
    expect(errors[0]?.message).toBe(
      '"strictPluginOnlyCustomization" was present but invalid; treating it as true (skills, agents, hooks and MCP servers load from managed settings and plugins only) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
  })

  test('unknown surface entries are filtered with a statusOnly typo warning', () => {
    const { data, errors } = parseStrict({
      strictPluginOnlyCustomization: ['skills', 'bogus'],
    })

    expect(data.strictPluginOnlyCustomization).toEqual(['skills'])
    expect(errors[0]?.message).toBe(
      '"strictPluginOnlyCustomization" lists 1 entry this version does not recognize as a surface (known: skills, agents, hooks, mcp); an unrecognized entry locks nothing, so check it for a typo.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
  })

  test('rest of the document survives a substituted lock (no tail record)', () => {
    const { data, errors } = parseStrict({
      disableAgentView: 'yes',
      theme: 'dark',
    })

    expect(data.disableAgentView).toBe(true)
    expect(data.theme).toBe('dark')
    expect(errors.some(e => e.onlySubstitutes)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) block salvage — 2.1.282 bullet b
// ---------------------------------------------------------------------------

describe('2.1.282 block salvage: permissions', () => {
  test('one invalid deny entry is dropped; deny/ask/allow survivors keep enforcing', () => {
    const { data, errors } = parseStrict({
      permissions: {
        deny: ['Read(/a)', 42],
        ask: ['Bash(git:*)'],
        allow: ['Bash(ls:*)'],
      },
    })

    const permissions = data.permissions as Record<string, unknown>
    expect(permissions.deny).toEqual(['Read(/a)'])
    expect(permissions.ask).toEqual(['Bash(git:*)'])
    expect(permissions.allow).toEqual(['Bash(ls:*)'])
    const salvage = errors.find(e => e.path === 'permissions.deny[1]')
    expect(salvage?.message).toBe(
      'Invalid entry was ignored (expected string); it cannot take effect until it is fixed.',
    )
    // A trimmed restriction does NOT withhold grants in permissions
    // (withholdOnEntryDrop is autoMode-only).
    expect(errors.some(e => e.message.includes('was withheld'))).toBe(false)
  })

  test('allow/additionalDirectories withheld iff deny/ask unreadable (exact zo text)', () => {
    const { data, errors } = parseStrict({
      permissions: {
        deny: 'str',
        ask: 5,
        allow: ['Bash(ls:*)'],
        additionalDirectories: ['/x'],
      },
    })

    const permissions = (data.permissions ?? {}) as Record<string, unknown>
    expect('allow' in permissions).toBe(false)
    expect('additionalDirectories' in permissions).toBe(false)
    const denyRecord = errors.find(e => e.path === 'permissions.deny')
    expect(denyRecord?.message).toBe(
      '"deny" was present but invalid (expected array) and was ignored; it cannot take effect until it is fixed.',
    )
    const withheld = errors.filter(e => e.message.includes('was withheld'))
    expect(withheld.map(e => e.path)).toEqual([
      'permissions.allow',
      'permissions.additionalDirectories',
    ])
    expect(withheld[0]?.message).toBe(
      '"allow" was withheld because "deny" and "ask" in the same block could not be read; it takes effect again once that is fixed.',
    )
    expect(withheld[1]?.message).toBe(
      '"additionalDirectories" was withheld because "deny" and "ask" in the same block could not be read; it takes effect again once that is fixed.',
    )
  })

  test('defaultMode grant is floored to "default" when deny unreadable', () => {
    const { data, errors } = parseStrict({
      permissions: { deny: 'str', defaultMode: 'acceptEdits' },
    })

    const permissions = data.permissions as Record<string, unknown>
    expect(permissions.defaultMode).toBe('default')
    const record = errors.find(e => e.path === 'permissions.defaultMode')
    expect(record?.message).toBe(
      '"defaultMode" was withheld because "deny" in the same block could not be read; treating it as "default" until that is fixed.',
    )
    expect(record?.substituted).toBe(true)
  })

  test('non-object permissions falls back to the lock skeleton', () => {
    const { data, errors } = parseStrict({ permissions: 'str' })

    expect(data.permissions).toEqual({
      disableBypassPermissionsMode: 'disable',
      disableAutoMode: 'disable',
    })
    expect(errors[0]?.message).toBe(
      '"permissions" was present but not an object; treating its locks as their restrictive values (disableBypassPermissionsMode, disableAutoMode) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    expect(errors[1]?.onlySubstitutes).toBe(true)
  })

  test('null permissions reads as key removal', () => {
    const { data, errors } = parseStrict({ permissions: null })

    expect('permissions' in data).toBe(false)
    expect(errors[0]?.message).toBe(
      '"permissions" was null, which is read as key removal; this source does not set it.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
  })
})

describe('2.1.282 block salvage: autoMode / worktree / attribution', () => {
  test('autoMode trims the invalid entry and withholds allow (withholdOnEntryDrop)', () => {
    const { data, errors } = parseStrict({
      autoMode: { soft_deny: ['x', 42], allow: ['y'] },
    })

    const autoMode = data.autoMode as Record<string, unknown>
    expect(autoMode.soft_deny).toEqual(['x'])
    expect('allow' in autoMode).toBe(false)
    const salvage = errors.find(e => e.path === 'autoMode.soft_deny[1]')
    expect(salvage?.message).toBe(
      'Invalid entry was ignored (expected string); it cannot take effect until it is fixed.',
    )
    const withheld = errors.find(e => e.path === 'autoMode.allow')
    expect(withheld?.message).toBe(
      '"allow" was withheld because an entry of "soft_deny" in the same block could not be read; it takes effect again once that is fixed.',
    )
  })

  test('worktree.bgIsolation invalid substitutes restrictive "worktree"', () => {
    const { data, errors } = parseStrict({ worktree: { bgIsolation: 'bogus' } })

    expect((data.worktree as Record<string, unknown>).bgIsolation).toBe(
      'worktree',
    )
    expect(errors[0]?.path).toBe('worktree.bgIsolation')
    expect(errors[0]?.message).toBe(
      '"bgIsolation" was present but invalid (expected "worktree" or "none"); treating it as "worktree", its restrictive value, until it is fixed.',
    )
  })

  test('attribution.sessionUrl invalid substitutes restrictive false', () => {
    const { data, errors } = parseStrict({ attribution: { sessionUrl: 'no' } })

    expect((data.attribution as Record<string, unknown>).sessionUrl).toBe(
      false,
    )
    expect(errors[0]?.path).toBe('attribution.sessionUrl')
    expect(errors[0]?.message).toBe(
      '"sessionUrl" was present but invalid (expected boolean); treating it as false, its restrictive value, until it is fixed.',
    )
  })
})

describe('2.1.282 generic per-field catch', () => {
  test('invalid plain field is ignored and the document still parses', () => {
    const { success, data, errors } = parseStrict({ model: 42, theme: 'dark' })

    expect(success).toBe(true)
    expect(data).toEqual({ theme: 'dark' })
    expect(errors[0]?.path).toBe('model')
    expect(errors[0]?.message).toBe(
      'Invalid input: expected string, received number. This field was ignored.',
    )
  })

  test('availableModels drops non-string entries and fails closed when wholly invalid', () => {
    const mixed = parseStrict({ availableModels: ['opus', 42] })
    expect(mixed.data.availableModels).toEqual(['opus'])
    expect(mixed.errors[0]?.message).toBe(
      '"availableModels" contained a non-string entry (42); the entry was ignored.',
    )

    const invalid = parseStrict({ availableModels: 'opus' })
    expect(invalid.data.availableModels).toEqual([])
    expect(invalid.errors[0]?.message).toBe(
      '"availableModels" was present but invalid; enforcing an empty allowlist (only the default model is available) until it is fixed.',
    )
  })

  test('allowedMcpServers salvages entries and fails closed as a whole', () => {
    const mixed = parseStrict({
      allowedMcpServers: [{ serverName: 'ok' }, { serverName: 42 }],
    })
    expect(mixed.data.allowedMcpServers).toEqual([{ serverName: 'ok' }])
    expect(mixed.errors[0]?.path).toBe('allowedMcpServers[]')
    expect(mixed.errors[0]?.message).toBe(
      'Invalid entry was ignored: Invalid input: expected string, received number',
    )

    const invalid = parseStrict({ allowedMcpServers: 'str' })
    expect(invalid.data.allowedMcpServers).toEqual([])
    expect(invalid.errors[0]?.message).toBe(
      '"allowedMcpServers" was present but invalid; enforcing an empty allowlist (no MCP servers admitted) until it is fixed.',
    )
  })
})

// ---------------------------------------------------------------------------
// RT③ fail-open disclosure pinning (acceptance review of main 9b36b4d).
//
// These tests pin three SILENT / fail-open paths that the Cluster B port
// carries — official-parity quirks the review asked us to disclose, NOT to
// fix (勿改行为). Each pins the current behavior so any future change (ours
// or a re-port) flips a test deliberately instead of silently shifting the
// fail-open surface. Full disclosure: docs/upstream-version-gap-occ97-2026-09.md §5 B.
// ---------------------------------------------------------------------------

describe('2.1.282 RT③ fail-open disclosure pinning (official-parity, do not "fix" silently)', () => {
  test('RT③a: maxEffortLevel mistype is swallowed with ZERO diagnostics (inline .catch(undefined) short-circuits the generic catch)', () => {
    // Root cause: src/utils/settings/types.ts — maxEffortLevel carries its own
    // `.catch(undefined)` in the base schema, so an invalid value never
    // produces a Zod issue for the policy schema's generic per-field catch to
    // record. Result: the effort cap silently does not apply (fail-open) and
    // `policyDiagnostics` shows nothing — unlike every other mistyped field,
    // which at least gets a "This field was ignored." record.
    const stringMistype = parseStrict({ maxEffortLevel: 'bogus' })
    expect(stringMistype.success).toBe(true)
    expect(stringMistype.data).toEqual({})
    expect(stringMistype.errors).toHaveLength(0)

    const numberMistype = parseStrict({ maxEffortLevel: 42 })
    expect(numberMistype.success).toBe(true)
    expect(numberMistype.data).toEqual({})
    expect(numberMistype.errors).toHaveLength(0)

    // Control: a valid value passes through, so the silence above is the
    // catch swallowing the mistype, not the key being unknown.
    const valid = parseStrict({ maxEffortLevel: 'high' })
    expect(valid.data).toEqual({ maxEffortLevel: 'high' })
    expect(valid.errors).toHaveLength(0)
  })

  test('RT③b: top-level lock key null is silently dropped — asymmetric with block-path null (which records Oi)', () => {
    // The lock-field wrapper (policyStrictSchema.ts step 6) is
    // `z.union([z.null().transform(() => undefined), coerced])` — the null
    // branch resolves to undefined with NO onIssue call, so the key vanishes
    // without a "read as key removal" record. A BLOCK-path null (e.g.
    // `permissions: null`) goes through Oi and DOES record. Pinning both
    // sides of the asymmetry.
    const lockNull = parseStrict({ disableAgentView: null })
    expect(lockNull.success).toBe(true)
    expect('disableAgentView' in lockNull.data).toBe(false)
    expect(lockNull.errors).toHaveLength(0)

    // Contrast (existing Oi behavior — see the block-salvage suite above):
    const blockNull = parseStrict({ permissions: null })
    expect('permissions' in blockNull.data).toBe(false)
    expect(blockNull.errors).toHaveLength(1)
    expect(blockNull.errors[0]?.message).toBe(
      '"permissions" was null, which is read as key removal; this source does not set it.',
    )
    expect(blockNull.errors[0]?.statusOnly).toBe(true)
  })

  test('RT③c: disableAllHooks mistype falls to the generic catch — no coercion, no restrictive substitution, hooks stay enabled (fail-open)', () => {
    // collectLockFields (policyLocks.ts, official Ni port) SKIPS
    // disableAllHooks, so it never gets the lock wrapper's string-boolean
    // coercion (nx) or restrictive substitution. A mistyped value lands in
    // the generic per-field catch: one "This field was ignored." record, key
    // dropped — meaning an admin who wrote `disableAllHooks: "true"` gets
    // hooks STAYING ENABLED (fail-open), while the same mistype on any other
    // lock key coerces fail-closed. Pinning the asymmetry both ways.
    const stringTrue = parseStrict({ disableAllHooks: 'true' })
    expect(stringTrue.success).toBe(true)
    expect('disableAllHooks' in stringTrue.data).toBe(false)
    expect(stringTrue.errors).toHaveLength(1)
    expect(stringTrue.errors[0]?.path).toBe('disableAllHooks')
    expect(stringTrue.errors[0]?.message).toBe(
      'Invalid input: expected boolean, received string. This field was ignored.',
    )
    // NOT the coercion record other locks get:
    expect(stringTrue.errors[0]?.statusOnly).toBeUndefined()
    expect(stringTrue.errors[0]?.substituted).toBeUndefined()

    const otherString = parseStrict({ disableAllHooks: 'yes' })
    expect('disableAllHooks' in otherString.data).toBe(false)
    expect(otherString.errors[0]?.message).toBe(
      'Invalid input: expected boolean, received string. This field was ignored.',
    )

    // Contrast: disableAgentView (IN collectLockFields) coerces the identical
    // mistype fail-closed.
    const coerced = parseStrict({ disableAgentView: 'true' })
    expect(coerced.data.disableAgentView).toBe(true)
    expect(coerced.errors[0]?.statusOnly).toBe(true)

    // Control: a valid boolean still applies.
    const valid = parseStrict({ disableAllHooks: true })
    expect(valid.data).toEqual({ disableAllHooks: true })
    expect(valid.errors).toHaveLength(0)
  })

  test('RT③d (security-review M1): one invalid nested sandbox value silently discards the ENTIRE sandbox block (fail-open)', () => {
    // `isRebuiltBlock` (official `mn`) excludes sandbox/sandbox.* — the block
    // never gets the per-block salvage rebuild (`Ki`), only the generic
    // per-field catch (step 1). So ANY invalid nested value (here: a number
    // inside `sandbox.network.deniedDomains`) drops the whole sandbox field
    // with a single "This field was ignored." record — denyWrite / denyRead /
    // deniedDomains restrictions all silently stop applying (fail-open).
    //
    // Official-parity framing: the official binary's `mn` also excludes
    // sandbox (policyLocks.ts STAGED note), so OCC keeps the same whole-block
    // catch rather than inventing a bespoke per-field sieve — the official's
    // bespoke fail-closed skeleton is scoped to `sandbox.credentials` (STAGE).
    // Pinning the current behavior so any future change flips this test.
    const badNested = parseStrict({
      sandbox: {
        network: { deniedDomains: ['ok.com', 42] },
        filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
      },
    })
    // runtime-verified: whole block dropped
    expect('sandbox' in badNested.data).toBe(false)
    // exactly one generic per-field-catch record naming the top-level key
    expect(badNested.errors).toHaveLength(1)
    expect(badNested.errors[0]?.path).toBe('sandbox')
    expect(badNested.errors[0]?.message).toBe(
      'Invalid input: expected string, received number. This field was ignored.',
    )
    // denyWrite/denyRead/deniedDomains were silently discarded along with the block
    expect(badNested.errors[0]?.statusOnly).toBeUndefined()

    // Control: an entirely valid sandbox block passes through intact.
    const valid = parseStrict({
      sandbox: {
        network: { deniedDomains: ['evil.com'] },
        filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
      },
    })
    expect(valid.data.sandbox).toEqual({
      network: { deniedDomains: ['evil.com'] },
      filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
    })
    expect(valid.errors).toHaveLength(0)

    // Contrast: permissions (a REBUILT block) is NOT dropped whole — the invalid
    // entry is salvaged and the valid restriction survives.
    const contrast = parseStrict({
      permissions: { deny: ['Bash(git *)', 42], defaultMode: 'default' },
    })
    expect(contrast.data.permissions).toEqual({
      deny: ['Bash(git *)'],
      defaultMode: 'default',
    })
  })
})

// ---------------------------------------------------------------------------
// (c) wiring: parseSettingsFile / MDM parse
// ---------------------------------------------------------------------------

describe('2.1.282 wiring: policy vs non-policy parseSettingsFile', () => {
  test('policy fixture with a mistyped lock applies it and names the key', () => {
    const file = fixture(
      'managed-settings.json',
      JSON.stringify({ disableAgentView: 'true', theme: 'dark' }),
    )

    const { settings, errors } = parseSettingsFile(file, {
      policySource: true,
    })

    expect(settings?.disableAgentView).toBe(true)
    expect(settings?.theme).toBe('dark')
    const record = errors.find(e => e.path === 'disableAgentView')
    expect(record?.file).toBe(file)
    expect(record?.severity).toBe('warning')
    expect(record?.statusOnly).toBe(true)
    expect(record?.message).toContain(
      '"disableAgentView" holds the string "true"',
    )
  })

  test('non-policy file with an invalid field still whole-rejects (regression)', () => {
    const file = fixture(
      'settings.json',
      JSON.stringify({ model: 42, theme: 'dark' }),
    )

    const { settings, errors } = parseSettingsFile(file)

    expect(settings).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  test('policy file that is not a JSON object gets the startup-fatal record', () => {
    const file = fixture('managed-settings.json', '[1,2]')

    const { settings, errors } = parseSettingsFile(file, {
      policySource: true,
    })

    expect(settings).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(
      'Managed settings document could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.',
    )
    expect(errors[0]?.startupFatal).toBe(true)
  })

  test('empty policy file loads as empty settings with no errors', () => {
    const file = fixture('managed-settings.json', '   ')

    const { settings, errors } = parseSettingsFile(file, {
      policySource: true,
    })

    expect(settings).toEqual({})
    expect(errors).toEqual([])
  })
})

describe('2.1.282 wiring: MDM/HKCU parseCommandOutputAsSettings', () => {
  test('empty stdout stays a silent no-op', () => {
    const { settings, errors } = parseCommandOutputAsSettings('', 'plist')

    expect(settings).toEqual({})
    expect(errors).toEqual([])
  })

  test('non-object admin payload gets the startup-fatal jdn record', () => {
    const { settings, errors } = parseCommandOutputAsSettings(
      '[1,2]',
      'Registry: HKLM\\SOFTWARE\\Policies\\ClaudeCode\\Settings',
    )

    expect(settings).toEqual({})
    expect(errors).toHaveLength(1)
    expect(errors[0]?.startupFatal).toBe(true)
    expect(errors[0]?.statusOnly).toBeUndefined()
  })

  test('non-object HKCU payload gets the user-writable status-only record', () => {
    const label = 'Registry: HKCU\\SOFTWARE\\Policies\\ClaudeCode\\Settings'
    const { settings, errors } = parseCommandOutputAsSettings(
      '"str"',
      label,
      { userWritable: true },
    )

    expect(settings).toEqual({})
    expect(errors).toHaveLength(1)
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.userWritable).toBe(true)
    expect(errors[0]?.message).toBe(
      `Managed settings document (${label}) could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.`,
    )
  })

  test('mistyped lock in a registry payload applies fail-closed', () => {
    const { settings, errors } = parseCommandOutputAsSettings(
      JSON.stringify({ disableAgentView: 'true' }),
      'plist',
    )

    expect(settings.disableAgentView).toBe(true)
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.message).toContain(
      '"disableAgentView" holds the string "true"',
    )
  })
})

// ---------------------------------------------------------------------------
// unit: helpers
// ---------------------------------------------------------------------------

describe('2.1.282 helper units', () => {
  test('coerceStringBoolean (nx) maps only the two literal strings', () => {
    expect(coerceStringBoolean('true')).toBe(true)
    expect(coerceStringBoolean('false')).toBe(false)
    expect(coerceStringBoolean('yes')).toBe('yes')
    expect(coerceStringBoolean(true)).toBe(true)
    expect(coerceStringBoolean(1)).toBe(1)
  })

  test('managedDocNotObjectRecord (jdn) has both official variants', () => {
    const admin = managedDocNotObjectRecord('f')
    expect(admin.startupFatal).toBe(true)
    expect(admin.message).toBe(
      'Managed settings document could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.',
    )

    const user = managedDocNotObjectRecord('f', { userWritable: true })
    expect(user.startupFatal).toBeUndefined()
    expect(user.statusOnly).toBe(true)
    expect(user.severity).toBe('warning')
    expect(user.message).toBe(
      'Managed settings document (f) could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.',
    )
  })
})
