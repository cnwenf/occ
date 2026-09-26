import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.282/283 managed-settings fail-closed validation (settings-trust cluster).
 *
 * Bullet (a): mistyped boolean/"disable" lock values in a policy source apply
 * the lock fail-closed (string coercion, restrictive substitution) and the
 * record names the key. Bullet (b): managed permissions/autoMode/worktree/
 * attribution blocks are salvaged per-field — one invalid nested value no
 * longer discards the whole block (or the whole document).
 *
 * 2.1.283 deltas pinned here (OCC-138 P1a):
 * - "set to false → absent" records now carry `removal: true` (official `Od`
 *   sink passthrough of the new `Ni` flag) — top-level AND nested via the
 *   shared `Ho` coercion (leafCoercionPreWrap);
 * - a nested `permissions.disableBypassPermissionsMode: false` reads as
 *   ABSENT with a removal record (282 substituted "disable" via the `tg`
 *   catch — the 283 `Ho` pre-wrap intercepts false BEFORE the enum parse);
 * - `sandbox` joined the per-block salvage rebuild (`Sn` no longer excludes
 *   it; the official Ko step-8 loop skips it in favor of a bespoke `jo` call
 *   with skeletonExclude/neverSubstitute) — RT③d's whole-block fail-open
 *   discard is CLOSED and re-pinned to the per-field salvage behavior.
 *
 * All message strings are byte-exact ports from the official v2.1.283 binary
 * (`Ko`/`Zo`/`jo`/`fg`/`Ho`/`Qo`/`ea`/`Ni`/`Mi`/`Od`/`jdn` — see
 * policyLocks.ts / policyStrictSchema.ts headers for offsets and the full
 * 282→283 symbol map).
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
  removal?: boolean
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
    // 283: the removal flag rides through the `Od` sink onto the record.
    expect(errors[0]?.removal).toBe(true)
  })

  test('string "false" on a "disable"-only lock also reads as absent', () => {
    const { data, errors } = parseStrict({ disableAutoMode: 'false' })

    expect('disableAutoMode' in data).toBe(false)
    expect(errors[0]?.message).toBe(
      '"disableAutoMode" was set to false; reading it as absent (the key\'s only value is "disable"). Remove the key instead.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.removal).toBe(true)
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

  test('nested disableBypassPermissionsMode:false reads as absent with a removal record (283 `Ho` shared coercion)', () => {
    // 283 CHANGE (was a documented 282 deviation): the "set to false →
    // absent" reading now lives in the shared `Ho` coercion
    // (leafCoercionPreWrap), which `fg` applies to EVERY rebuilt-block leaf —
    // so the nested key behaves like the top-level lock loop: false is
    // intercepted BEFORE the enum parse (no catch, no substitution), the
    // field reads as absent, and the record carries removal:true. With the
    // only field removed, the `jo` empty-tail check (base has a defined
    // schema key) reads the whole permissions block as absent.
    const { data, errors } = parseStrict({
      permissions: { disableBypassPermissionsMode: false },
    })

    expect('permissions' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('permissions.disableBypassPermissionsMode')
    expect(errors[0]?.message).toBe(
      '"disableBypassPermissionsMode" was set to false; reading it as absent (the key\'s only value is "disable"). Remove the key instead.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.removal).toBe(true)
    expect(errors[0]?.substituted).toBeUndefined()
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

  test('RT③b: top-level lock key null is silently dropped — asymmetric with block-path null (which records Ni)', () => {
    // The lock-field wrapper (policyStrictSchema.ts step 6) is
    // `z.union([z.null().transform(() => undefined), coerced])` — the null
    // branch resolves to undefined with NO onIssue call, so the key vanishes
    // without a "read as key removal" record. A BLOCK-path null (e.g.
    // `permissions: null`) goes through `Ni` (282 `Oi`, nullRemovalIssue) and
    // DOES record — with removal:true since 283. Pinning both sides of the
    // asymmetry.
    const lockNull = parseStrict({ disableAgentView: null })
    expect(lockNull.success).toBe(true)
    expect('disableAgentView' in lockNull.data).toBe(false)
    expect(lockNull.errors).toHaveLength(0)

    // Contrast (existing Ni behavior — see the block-salvage suite above):
    const blockNull = parseStrict({ permissions: null })
    expect('permissions' in blockNull.data).toBe(false)
    expect(blockNull.errors).toHaveLength(1)
    expect(blockNull.errors[0]?.message).toBe(
      '"permissions" was null, which is read as key removal; this source does not set it.',
    )
    expect(blockNull.errors[0]?.statusOnly).toBe(true)
    // 283: null-removal records carry the removal flag through the sink.
    expect(blockNull.errors[0]?.removal).toBe(true)
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

  test('RT③d RE-PINNED (283 closes the 282 fail-open): one invalid nested sandbox value no longer discards the sandbox block — per-field salvage applies', () => {
    // 283 CHANGE: official `Sn` (282 `mn`, isRebuiltBlock) no longer excludes
    // sandbox — the Ko step-8 loop skips it (`_==="sandbox"||!Sn(_)`) only to
    // route it into a bespoke `jo` call with skeletonExclude(enabled) +
    // neverSubstitute(failIfUnavailable). The sandbox block now gets the same
    // per-field salvage as permissions: the invalid entry is dropped with a
    // record, and every valid restriction SURVIVES (fail-closed).
    //
    // The 282 pin here asserted whole-block discard (fail-open) — that gap
    // (security-review M1 / occ97 §5.1 RT③d) is CLOSED by this round; the
    // old assertion is re-pinned to the official 283 behavior, per the
    // OCC-138 task book ("旧钉桩断言整块丢弃——预期翻红，按官方 283 语义改写").
    const badNested = parseStrict({
      sandbox: {
        network: { deniedDomains: ['ok.com', 42] },
        filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
      },
    })
    // the block SURVIVES; the valid entries keep enforcing
    expect(badNested.data.sandbox).toEqual({
      network: { deniedDomains: ['ok.com'] },
      filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
    })
    // exactly one per-entry salvage record naming the dropped index
    expect(badNested.errors).toHaveLength(1)
    expect(badNested.errors[0]?.path).toBe('sandbox.network.deniedDomains[1]')
    expect(badNested.errors[0]?.message).toBe(
      'Invalid entry was ignored (expected string); it cannot take effect until it is fixed.',
    )
    // the trimmed deniedDomains does NOT withhold sibling grants: the
    // withholdOnEntryDrop escalation is autoMode-only (`Qo` parity) —
    // sandbox.network has no GRANT_FLOORS entry and allowedDomains is absent
    // here, so no withholding record fires.

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

    // Unreadable restriction withholds the paired grant (`Qo` over the
    // now-LIVE BLOCK_GRANTS sandbox entries): every denyWrite entry invalid →
    // the field is ignored (no salvage possible) → allowWrite in the same
    // block is withheld. The empty-tail then reads filesystem (and with it
    // sandbox) as absent — the source's sandbox overrides do not apply, but
    // the records name both the unreadable restriction and the withheld grant.
    const withheld = parseStrict({
      sandbox: { filesystem: { allowWrite: ['/tmp'], denyWrite: [42] } },
    })
    expect('sandbox' in withheld.data).toBe(false)
    expect(
      withheld.errors.some(
        e =>
          e.path === 'sandbox.filesystem.allowWrite' &&
          e.message.includes('was withheld because "denyWrite"'),
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2.1.283 sandbox per-field fail-closed (OCC-138 P1a) — the bespoke `jo` call
// ---------------------------------------------------------------------------

describe('2.1.283 sandbox per-field fail-closed (bespoke jo rebuild)', () => {
  test('non-object sandbox synthesizes the restrictive skeleton WITHOUT enabled/failIfUnavailable', () => {
    const { data, errors } = parseStrict({ sandbox: 'yes' })
    // skeletonExclude(enabled) + neverSubstitute(failIfUnavailable) merge into
    // the skeleton exclusion set — the block must not auto-ARM the sandbox,
    // and failIfUnavailable must not auto-substitute true (hard startup
    // failure when the sandbox cannot start).
    expect(data.sandbox).toEqual({
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: {
        allowManagedDomainsOnly: true,
        strictAllowlist: true,
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        disabled: false,
        allowManagedReadPathsOnly: true,
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    })
    const sandbox = data.sandbox as Record<string, unknown>
    expect('enabled' in sandbox).toBe(false)
    expect('failIfUnavailable' in sandbox).toBe(false)
    expect(errors[0]?.message).toBe(
      '"sandbox" was present but not an object; treating its locks as their restrictive values (autoAllowBashIfSandboxed, allowUnsandboxedCommands, network, filesystem, enableWeakerNestedSandbox, enableWeakerNetworkIsolation, allowAppleEvents) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    // onlySubstitutes tail: the skeleton is this source's only policy content.
    expect(errors[1]?.onlySubstitutes).toBe(true)
    expect(errors[1]?.statusOnly).toBe(true)
  })

  test('invalid sandbox.enabled substitutes true (restrictive) and flags the tail record', () => {
    const { data, errors } = parseStrict({ sandbox: { enabled: 'yes' } })
    expect((data.sandbox as Record<string, unknown>).enabled).toBe(true)
    expect(errors[0]?.path).toBe('sandbox.enabled')
    expect(errors[0]?.message).toBe(
      '"enabled" was present but invalid (expected boolean); treating it as true, its restrictive value, until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    expect(errors[1]?.onlySubstitutes).toBe(true)
  })

  test('invalid sandbox.failIfUnavailable is ignored, NOT substituted true (neverSubstitute)', () => {
    const { data, errors } = parseStrict({ sandbox: { failIfUnavailable: 'yes' } })
    // the field is dropped; with nothing defined left the block reads absent
    expect('sandbox' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('sandbox.failIfUnavailable')
    // 283's new `fg` final-record variant: the restrictive value EXISTS but
    // was suppressed, so the record names what it was not treated as.
    expect(errors[0]?.message).toBe(
      '"failIfUnavailable" was present but invalid (expected boolean) and was ignored, not treated as true; it cannot take effect until it is fixed.',
    )
    expect(errors[0]?.substituted).toBeUndefined()
  })

  test('string "true" on sandbox.enabled coerces with the shared Ho record', () => {
    const { data, errors } = parseStrict({ sandbox: { enabled: 'true' } })
    expect((data.sandbox as Record<string, unknown>).enabled).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(
      '"enabled" holds the string "true" where a boolean belongs; reading it as true. Write it without quotes.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.substituted).toBeUndefined()
  })

  test('invalid sandbox.credentials drops the whole field (official `te` override STAGED)', () => {
    // The official 283 routes sandbox.credentials through the bespoke `te`
    // override (per-entry credential salvage + sigv4 deny degradation, ~4.4KB).
    // STAGED in OCC — see the policyStrictSchema.ts header: OCC's credentials
    // schema is only {enabled?: boolean}, so the plain `fg` leaf path applies:
    // invalid value → one record, WHOLE credentials field dropped.
    const { data, errors } = parseStrict({
      sandbox: { credentials: { enabled: 'yes' } },
    })
    expect('sandbox' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('sandbox.credentials')
    expect(errors[0]?.message).toBe(
      '"credentials" was present but invalid (nested value: expected boolean) and was ignored; it cannot take effect until it is fixed.',
    )
  })

  test('all-invalid deniedDomains is unreadable → paired allowedDomains grant is withheld (LIVE BLOCK_GRANTS)', () => {
    // 283: the BLOCK_GRANTS sandbox.network entry is now consulted by `Qo`
    // (the sandbox block is rebuilt). A wholly invalid restriction list
    // cannot be salvaged → 'unreadable' → the paired grant is withheld
    // (deleted — GRANT_FLOORS has no sandbox floor). Empty-tail then reads
    // network, and with it sandbox, as absent.
    const { data, errors } = parseStrict({
      sandbox: { network: { allowedDomains: ['a.com'], deniedDomains: [42] } },
    })
    expect('sandbox' in data).toBe(false)
    expect(errors).toHaveLength(2)
    expect(errors[0]?.path).toBe('sandbox.network.deniedDomains')
    expect(errors[1]?.path).toBe('sandbox.network.allowedDomains')
    expect(errors[1]?.message).toBe(
      '"allowedDomains" was withheld because "deniedDomains" in the same block could not be read; it takes effect again once that is fixed.',
    )
  })

  test('non-restrictive sandbox leaves keep per-field salvage; passthrough keys survive the rebuild', () => {
    // excludedCommands has no restrictive entry → plain leaf; an invalid
    // sibling (httpProxyPort) is ignored individually while the rest of the
    // block survives. Unknown keys ride through the schema's passthrough
    // (`.extend()` preserves it — zod v4 runtime-verified).
    const { data, errors } = parseStrict({
      sandbox: {
        excludedCommands: ['git'],
        futureKey: 1,
        network: { httpProxyPort: 'bogus' },
      },
    })
    expect(data.sandbox).toEqual({
      excludedCommands: ['git'],
      futureKey: 1,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('sandbox.network.httpProxyPort')
    expect(errors[0]?.message).toBe(
      '"httpProxyPort" was present but invalid (expected number) and was ignored; it cannot take effect until it is fixed.',
    )
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
