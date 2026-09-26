import { describe, expect, test } from 'bun:test'

/**
 * CC 2.1.283 — managed `sandbox` partial-invalid fail-closed (changelog:
 * "Fixed an issue where managed sandbox settings with a partially invalid
 * block were discarded wholesale"; RT③d flip) + the 283 strict-schema
 * machinery upgrades that route sandbox through the per-block salvage rebuild.
 *
 * Byte-exact ports from the official 2.1.283 ELF (forensics/v283/claude,
 * md5 b5afa8208e39db13e13e89449b1825f2; strings/byte reads only — never
 * executed):
 * - `Sn` (isRebuiltBlock) @196668238: `e!=="sandbox.credentials"&&!e.startsWith("sandbox.credentials.")&&gn(e)`
 *   — 282's `mn` excluded ALL sandbox paths; 283 excludes only
 *   sandbox.credentials, so sandbox joins the rebuild machinery.
 * - `Ho` (leaf coercion pre-wrapper) @196669558: boolean-restrictive leaves
 *   get string→boolean coercion (`Bx`) with a statusOnly warning;
 *   "disable"-restrictive leaves read false/"false" as absent with
 *   `removal:!0`.
 * - `fg` (wrapLeafField) @196670068: 7th param `c` (neverSubstitute) —
 *   `h=c?void 0:g` suppresses restrictive substitution and the ignored
 *   message gains the "not treated as X" variant.
 * - `jo` (rebuildBlockSchema) @196671300: skeleton excludes merge
 *   `new Set([...skeletonExclude,...neverSubstitute])`; empty check is
 *   shape-aware (`Object.hasOwn(n.shape,F)`); synthesized-adopt gains
 *   `||Lt(W)` (`Lt` @196663983 = recursive empty-plain-object).
 * - `Ni` (null-removal issue) @196668878: gains `removal:!0`.
 * - `eg` (BLOCK_GRANTS) @196666922: sandbox.network + sandbox.filesystem
 *   rows gain `withholdOnEntryDrop:!0` (282 @194780770 lacked it).
 * - `os` tail @196694745: dedicated
 *   `r.sandbox=jo("sandbox",pmn(),e,{override:{"sandbox.credentials":te},skeletonExclude:new Set(["sandbox.enabled"]),neverSubstitute:new Set(["sandbox.failIfUnavailable"]),synthesized:y})`;
 *   tail transform @196695417 filters onlySubstitutes candidates with
 *   `&&!Lt(_[M])`.
 *
 * STAGED (documented, not ported): the `te` credentials override — the
 * official's fail-closed credentials skeleton (`{allowPlaintextInject:!1,
 * awsPairs:w,sigv4:{streaming:"deny",presigned:"deny",sigv4a:"deny"}}`)
 * covers awsPairs/sigv4/plaintext-inject surfaces OCC's sandbox.credentials
 * block does not have (OCC: `{enabled}` only). Without the override,
 * sandbox.credentials falls to the `fg` leaf catch (generic per-field
 * ignore) — the OCC-97 STAGE note stays true for credentials only.
 */

const {
  buildStrictPolicySchema,
  createPolicyIssueSink,
} = await import('../policyStrictSchema.js')

type PolicyRecord = {
  file?: string
  path: string
  message: string
  severity?: 'error' | 'warning'
  statusOnly?: boolean
  startupFatal?: boolean
  substituted?: boolean
  onlySubstitutes?: boolean
  removal?: boolean
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

describe('2.1.283 managed sandbox: partial-invalid fail-closed (RT③d flip)', () => {
  test('one invalid deniedDomains entry no longer discards the whole sandbox block', () => {
    // 282 (RT③d, fail-open): the entire sandbox field was dropped with a
    // single generic "This field was ignored." record. 283 routes sandbox
    // through jo: the bad entry is trimmed, every valid restriction survives.
    const { data, errors } = parseStrict({
      sandbox: {
        network: { deniedDomains: ['ok.com', 42] },
        filesystem: { denyWrite: ['/root/secrets'], denyRead: ['*.secret'] },
      },
    })
    const sandbox = data.sandbox as Record<string, Record<string, unknown>>
    expect(sandbox).toBeDefined()
    expect(sandbox.network?.deniedDomains).toEqual(['ok.com'])
    expect(sandbox.filesystem).toEqual({
      denyWrite: ['/root/secrets'],
      denyRead: ['*.secret'],
    })
    const trimmed = errors.find(e => e.path === 'sandbox.network.deniedDomains[1]')
    expect(trimmed?.message).toBe(
      'Invalid entry was ignored (expected string); it cannot take effect until it is fixed.',
    )
    // No whole-block generic catch record.
    expect(
      errors.some(e => e.path === 'sandbox' && e.message.endsWith('This field was ignored.')),
    ).toBe(false)
  })

  test('trimmed deniedDomains entry WITHHOLDS allowedDomains (283 withholdOnEntryDrop)', () => {
    // 282: withholdOnEntryDrop was autoMode-only. 283 adds it to the
    // sandbox.network / sandbox.filesystem grant rows (@196666922): a
    // partially-read restriction now withholds the block's grants too.
    const { data, errors } = parseStrict({
      sandbox: {
        network: {
          allowedDomains: ['a.example'],
          deniedDomains: ['ok.com', 42],
        },
      },
    })
    const network = (data.sandbox as Record<string, Record<string, unknown>>)
      ?.network as Record<string, unknown>
    expect('allowedDomains' in network).toBe(false)
    expect(network.deniedDomains).toEqual(['ok.com'])
    const withheld = errors.find(e => e.path === 'sandbox.network.allowedDomains')
    expect(withheld?.message).toBe(
      '"allowedDomains" was withheld because an entry of "deniedDomains" in the same block could not be read; it takes effect again once that is fixed.',
    )
    expect(withheld?.substituted).toBeUndefined()
  })

  test('unreadable deniedDomains withholds allowedDomains (exact zo text)', () => {
    const { data, errors } = parseStrict({
      sandbox: {
        network: { allowedDomains: ['a.example'], deniedDomains: 'nope' },
      },
    })
    // deniedDomains: not an array → fg ignore; allowedDomains: withheld.
    const ignored = errors.find(e => e.path === 'sandbox.network.deniedDomains')
    expect(ignored?.message).toBe(
      '"deniedDomains" was present but invalid (expected array) and was ignored; it cannot take effect until it is fixed.',
    )
    const withheld = errors.find(e => e.path === 'sandbox.network.allowedDomains')
    expect(withheld?.message).toBe(
      '"allowedDomains" was withheld because "deniedDomains" in the same block could not be read; it takes effect again once that is fixed.',
    )
    // Both network keys gone → network empty → cascade drops sandbox itself
    // (jo empty check: base held defined shape keys, so the block reads as
    // "present but nothing applicable" → undefined).
    expect('sandbox' in data).toBe(false)
  })

  test('valid sandbox block passes through with zero records', () => {
    const doc = {
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        network: { allowManagedDomainsOnly: true, deniedDomains: ['evil.com'] },
        filesystem: { denyWrite: ['/root/secrets'] },
      },
    }
    const { data, errors } = parseStrict(doc)
    expect(data.sandbox).toEqual(doc.sandbox)
    expect(errors).toHaveLength(0)
  })
})

describe('2.1.283 Ho leaf coercion inside rebuilt blocks', () => {
  test('sandbox.enabled written as "true" coerces with the statusOnly warning', () => {
    const { data, errors } = parseStrict({ sandbox: { enabled: 'true' } })
    expect((data.sandbox as Record<string, unknown>).enabled).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('sandbox.enabled')
    expect(errors[0]?.message).toBe(
      '"enabled" holds the string "true" where a boolean belongs; reading it as true. Write it without quotes.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
  })

  test('invalid sandbox.enabled substitutes the restrictive value true (fail-closed)', () => {
    const { data, errors } = parseStrict({ sandbox: { enabled: 42 } })
    expect((data.sandbox as Record<string, unknown>).enabled).toBe(true)
    // TWO records, derived from the official bytes (this test originally
    // expected 1 before the tail machinery was traced end-to-end):
    // 1. fg leaf substitute record at sandbox.enabled (substituted:!0);
    // 2. jo adopt branch: defined={enabled:true} passes every() via
    //    d.substituted.has("enabled") → synthesized.add(defined); the os tail
    //    Qi(y,_[M]) then fires the onlySubstitutes record at "sandbox"
    //    (same two-record pattern as the 282 remoteTools:"garbage" pin).
    expect(errors).toHaveLength(2)
    expect(errors[0]?.path).toBe('sandbox.enabled')
    expect(errors[0]?.message).toBe(
      '"enabled" was present but invalid (expected boolean); treating it as true, its restrictive value, until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    expect(errors[1]?.path).toBe('sandbox')
    expect(errors[1]?.onlySubstitutes).toBe(true)
  })

  test('sandbox.failIfUnavailable is neverSubstitute: invalid reads as ignored, NOT as true', () => {
    // Official fg @196670068: neverSubstitute suppresses the restrictive
    // substitution (h=void 0) and the ignored message names what it was NOT
    // treated as. Substituting true on an unreadable managed value would
    // hard-fail startup (failIfUnavailable's restrictive reading) — 283
    // deliberately excludes it from substitution.
    const { data, errors } = parseStrict({
      sandbox: { failIfUnavailable: 'garbage' },
    })
    expect('sandbox' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('sandbox.failIfUnavailable')
    expect(errors[0]?.message).toBe(
      '"failIfUnavailable" was present but invalid (expected boolean) and was ignored, not treated as true; it cannot take effect until it is fixed.',
    )
    expect(errors[0]?.substituted).toBeUndefined()
  })

  test('failIfUnavailable string coercion still applies (Ho precedes neverSubstitute)', () => {
    const { data, errors } = parseStrict({
      sandbox: { failIfUnavailable: 'true' },
    })
    expect((data.sandbox as Record<string, unknown>).failIfUnavailable).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(
      '"failIfUnavailable" holds the string "true" where a boolean belongs; reading it as true. Write it without quotes.',
    )
  })

  test('nested disableBypassPermissionsMode:false reads as absent with removal:true (283 flip of the 282 tg pin)', () => {
    // 282 tg had no Ho: false hit the catch and substituted "disable".
    // 283 Ho disable-branch (@196669558) pre-empts the parse: ta(false) →
    // absent + statusOnly + removal:!0.
    for (const value of [false, 'false']) {
      const { data, errors } = parseStrict({
        permissions: { disableBypassPermissionsMode: value },
      })
      expect('permissions' in data).toBe(false)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.path).toBe('permissions.disableBypassPermissionsMode')
      expect(errors[0]?.message).toBe(
        '"disableBypassPermissionsMode" was set to false; reading it as absent (the key\'s only value is "disable"). Remove the key instead.',
      )
      expect(errors[0]?.statusOnly).toBe(true)
      expect(errors[0]?.removal).toBe(true)
    }
  })

  test('nested disableBypassPermissionsMode with a NON-false invalid value still substitutes "disable"', () => {
    // Ho's ta() only catches false/"false"; anything else falls to the fg
    // catch and substitutes the restrictive value (282 behavior retained).
    const { data, errors } = parseStrict({
      permissions: { disableBypassPermissionsMode: 42, deny: ['Read(/a)'] },
    })
    const permissions = data.permissions as Record<string, unknown>
    expect(permissions.disableBypassPermissionsMode).toBe('disable')
    expect(permissions.deny).toEqual(['Read(/a)'])
    const substituted = errors.find(
      e => e.path === 'permissions.disableBypassPermissionsMode',
    )
    expect(substituted?.message).toBe(
      '"disableBypassPermissionsMode" was present but invalid (expected "disable"); treating it as "disable", its restrictive value, until it is fixed.',
    )
    expect(substituted?.substituted).toBe(true)
  })
})

describe('2.1.283 sandbox skeleton + null-removal + tail', () => {
  test('non-object sandbox synthesizes the restrictive skeleton EXCLUDING enabled and failIfUnavailable', () => {
    // Official os tail @196694745: skeletonExclude ["sandbox.enabled"] +
    // neverSubstitute ["sandbox.failIfUnavailable"] merge into the skeleton
    // exclusion set (jo: h=new Set([...r.skeletonExclude,...r.neverSubstitute])).
    // An unreadable managed sandbox must NOT force enabled:true (could brick
    // startup where sandbox cannot run) nor failIfUnavailable:true.
    const { data, errors } = parseStrict({ sandbox: 'yes' })
    // TWO records, derived from the official bytes (originally expected 1
    // before the tail machinery was traced): jo adds the skeleton to the
    // synthesized WeakSet (`Li.has(e)||L.add(m)`), so the os tail Qi check
    // fires the onlySubstitutes record on top of the skeleton record — the
    // same two-record pattern the 282 suite pins for remoteTools:"garbage".
    expect(errors).toHaveLength(2)
    expect(errors[0]?.path).toBe('sandbox')
    expect(errors[0]?.message).toBe(
      '"sandbox" was present but not an object; treating its locks as their restrictive values (autoAllowBashIfSandboxed, allowUnsandboxedCommands, network, filesystem, enableWeakerNestedSandbox, enableWeakerNetworkIsolation, allowAppleEvents) until it is fixed.',
    )
    expect(errors[0]?.substituted).toBe(true)
    expect(errors[1]?.path).toBe('sandbox')
    expect(errors[1]?.onlySubstitutes).toBe(true)
    const sandbox = data.sandbox as Record<string, unknown>
    expect(sandbox).toEqual({
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
    expect('enabled' in sandbox).toBe(false)
    expect('failIfUnavailable' in sandbox).toBe(false)
  })

  test('sandbox:null records the removal issue with removal:true (283 Ni)', () => {
    const { data, errors } = parseStrict({ sandbox: null })
    expect('sandbox' in data).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(
      '"sandbox" was null, which is read as key removal; this source does not set it.',
    )
    expect(errors[0]?.statusOnly).toBe(true)
    expect(errors[0]?.removal).toBe(true)
  })

  test('nested sandbox.enabled:null records the per-field removal issue', () => {
    const { data, errors } = parseStrict({ sandbox: { enabled: null } })
    expect('sandbox' in data).toBe(false)
    const removal = errors.find(e => e.path === 'sandbox.enabled')
    expect(removal?.message).toBe(
      '"enabled" was null, which is read as key removal; this source does not set it.',
    )
    expect(removal?.removal).toBe(true)
  })

  test('tail onlySubstitutes skips recursive-empty values (283 Lt filter)', () => {
    // 282: applicable=['sandbox','disableAgentView'] — sandbox:{} counted
    // (synthesized-adopt) and BOTH keys got the onlySubstitutes record.
    // 283 @196695417: the filter drops Lt values — only the substituted key
    // is named.
    const { data, errors } = parseStrict({
      sandbox: {},
      disableAgentView: 'garbage',
    })
    expect((data as Record<string, unknown>).disableAgentView).toBe(true)
    const flagged = errors.filter(e => e.onlySubstitutes === true)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.path).toBe('disableAgentView')
    expect(flagged[0]?.message).toBe(
      '"disableAgentView" holds nothing that could be applied as written and is this source\'s only policy content; its fail-closed reading binds (beside a lower managed settings source\'s policy, when one supplies it) until it is fixed.',
    )
  })
})
