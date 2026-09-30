import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { realpathSync } from 'fs'
import { join } from 'path'
import type { SettingSource } from '../../settings/constants.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * CC 2.1.285 security fix — sandbox filesystem/network grants restricted to
 * trusted settings tiers.
 *
 * Byte evidence (official linux-x64 ELFs; v284 has ZERO hits for any of these
 * strings — the whole subsystem is new in v285):
 *  - jm builder setup @200623566: `_=Ua()` (admin sandbox mandate),
 *    `T=zm()` (strictAllowlist), `A=_||T` (network allowedDomains gate),
 *    `N=_||FB()` (fs read-deny gate), `D=N?MB():nS()` (deny baseline),
 *    `Be=Hm(X)` (project/local untrusted), `et=_&&Be` (mandate wholesale
 *    drop), `ct=Re||et`.
 *  - jm fs loop @200632000+: `if(et) Ic+=ar.length+(fs.allowWrite?.length??0)`
 *    else per-candidate `if(Be&&Gm(D,qt)){Rc++;continue}` (writes) /
 *    `{Nc++;continue}` (reads); deny rules always honored; one-shot log
 *    `[sandbox] filesystem grants restricted to trusted settings tiers:
 *    ignoring ${Ic/Rc/Nc parts joined " and "} from project/local (or
 *    HKCU-backfilled policy) settings` with label
 *    `_?"admin sandbox mandate":N?"managed or --settings read deny":
 *    "Claude Code's own read-deny paths"`.
 *  - jm network else-branch: `A?Uf((ne)=>ne.network?.allowedDomains):merged`
 *    + `A?OO():n.allow` WebFetch `domain:` legs + one-shot
 *    `droppedRepoAllowedDomainsLogged` log
 *    `[sandbox] ${_?"admin sandbox mandate":"network.strictAllowlist"}:
 *    ignoring ${X} sandbox.network.allowedDomains / WebFetch(domain:…)
 *    allow entries from project/local settings`; deniedDomains always merged.
 *  - dB network allowances @200608500+ (verbatim in
 *    /tmp/cc-diff-285/dB-region285.txt): `ate(){if(Ua()||zm())return!0;
 *    return[_c(),ge("flagSettings")].some(deniedDomains>0 || WebFetch
 *    domain: deny)}`; passthrough when no gate; `_ee`/`zO` field lists;
 *    `h=n?kO:wE` (managedOnly -> policy-only proxy ports); `Km(e,r)=
 *    e===!1?!1:wE(r)` false-sticky booleans; three verbatim log templates.
 *  - Getters @200583000+: `Am()=[_c(),...Lf()]`, `Uf(e)=U(Am().flatMap(...))`,
 *    `OO()=U(Am().flatMap(permissions.allow))`, `MB()`/`nS()`/`Gm()`/`VB()`/
 *    `rte()`/`bB()`/`Vo()`/`S5e()`/`jat()`/`VE()`/`Go()`/`$Le()`/`Mo()`/
 *    `Tu()`/`Wm()` baseline+matcher chain — ported 1:1 in
 *    ../trustedTierGrants.ts (symbol map in that file's header).
 *
 * Harness: per-source settings are seeded through the settings cache test
 * hook (setCachedSettingsForSource — the sandboxRipgrepScope232 pattern, no
 * disk reads); ONLY debug.js is mock.module'd (for log capture), with the
 * snapshot/restore hygiene mandated by OCC-97 (excludedCommandsScoping282
 * pattern). Latches are reset through the adapter's exported
 * _reset*ForTesting hooks in beforeEach.
 */

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// Snapshot the REAL debug namespace BEFORE any mock.module registration
// (spreading the live namespace after mocking would capture the mock itself).
const actualDebugModule = await import('../../debug.js')
const actualDebugExports = { ...actualDebugModule }

const debugLines: string[] = []

mock.module('../../debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: (message: string) => {
    debugLines.push(message)
  },
}))

afterAll(() => {
  mock.module('../../debug.js', () => ({ ...actualDebugExports }))
})

// Import AFTER the debug mock so the adapter captures the spy.
const { setCachedSettingsForSource, resetSettingsCache } = await import(
  '../../settings/settingsCache.js'
)
const {
  convertToSandboxRuntimeConfig,
  _resetAllowedDomainsWarningForTesting,
  _resetFilesystemGrantsWarningForTesting,
  _resetNetworkAllowancesWarningForTesting,
} = await import('../sandbox-adapter.js')
const {
  isGlobPattern,
  foldCase,
  pathUnderOrEqual,
  literalUnderOrEqual,
  globBase,
  globAncestorMatch,
  matchDenyToCandidate,
  realpathExistingPrefix,
  realpathVariants,
  resolveDenyPath,
  candidateUnderDeniedRead,
  isUntrustedSource,
  getTrustedSettingsSources,
  hasTrustedReadDenyList,
  hasTrustedNetworkDenyList,
  getClaudeOwnReadDenyBaseline,
  getTrustedReadDenyBaseline,
  getTrustedAllowedDomains,
  getTrustedWebFetchAllowRules,
} = await import('../trustedTierGrants.js')
const { getClaudeConfigHomeDir } = await import('../../envUtils.js')
const { getGlobalClaudeFile } = await import('../../env.js')

/** Seed every source through the settings cache (null = no settings). */
function seed(bySource: Partial<Record<SettingSource, SettingsJson>>): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, bySource[source] ?? null)
  }
}

const identityResolvers = {
  resolveReadDenyRule: (ruleContent: string) => ruleContent,
  resolveFilesystemPath: (p: string) => p,
}

/** The adapter's one-shot [sandbox] logs captured for the current test. */
function sandboxLogs(): string[] {
  return debugLines.filter((line) => line.startsWith('[sandbox]'))
}

beforeEach(() => {
  resetSettingsCache()
  seed({})
  debugLines.length = 0
  _resetAllowedDomainsWarningForTesting()
  _resetFilesystemGrantsWarningForTesting()
  _resetNetworkAllowancesWarningForTesting()
})

// ---------------------------------------------------------------------------
// Part 1 — matcher chain (official Tu/Mo/Go/$Le/Wm/jat/S5e/VB/rte/bB/Vo/Gm)
// ---------------------------------------------------------------------------

describe('trustedTierGrants — matcher chain (binary Tu/Mo/Go/$Le/Wm/jat/S5e)', () => {
  test('isGlobPattern (Tu): glob metacharacters detected', () => {
    expect(isGlobPattern('/a/*')).toBe(true)
    expect(isGlobPattern('/a/?')).toBe(true)
    expect(isGlobPattern('/a/[x]')).toBe(true)
    expect(isGlobPattern('/a/b')).toBe(false)
  })

  test('foldCase (Mo): strips zero-width/BOM controls, then case folds', () => {
    expect(foldCase('AbC')).toBe('ABC')
    expect(foldCase('a\uFEFFb')).toBe('AB') // BOM
    expect(foldCase('a\u200Eb')).toBe('AB') // LRM
    expect(foldCase('a\u202Eb')).toBe('AB') // RLO
    expect(foldCase('a\u200Bb')).toBe('A\u200BB') // ZWSP is NOT in the class
  })

  test('pathUnderOrEqual (Go): segment-wise prefix, no partial-segment match', () => {
    expect(pathUnderOrEqual('/a/b', '/a/b')).toBe(true)
    expect(pathUnderOrEqual('/a/b', '/a/b/c/d')).toBe(true)
    expect(pathUnderOrEqual('/a/b', '/a/bc')).toBe(false)
    expect(pathUnderOrEqual('/a/b', '/a')).toBe(false)
  })

  test('literalUnderOrEqual ($Le): string prefix with / boundary; root special-case', () => {
    expect(literalUnderOrEqual('/a', '/a')).toBe(true)
    expect(literalUnderOrEqual('/a', '/a/b')).toBe(true)
    expect(literalUnderOrEqual('/a', '/ab')).toBe(false)
    expect(literalUnderOrEqual('/', '/x')).toBe(true)
  })

  test('globBase (Wm): non-glob prefix of a pattern', () => {
    expect(globBase('/a/b/*')).toBe('/a/b')
    expect(globBase('/a/b/c*')).toBe('/a/b')
    expect(globBase('/a/b/**/x')).toBe('/a/b')
  })

  test('globAncestorMatch (jat): literal falls back to prefix; glob matches ancestors', () => {
    const cache = new Map<string, (s: string) => boolean>()
    expect(globAncestorMatch('/a/b', '/a/b/c', cache)).toBe(true)
    expect(globAncestorMatch('/a/b', '/a/bc', cache)).toBe(false)
    expect(globAncestorMatch('/a/*.env', '/a/x.env', cache)).toBe(true)
    // Ancestor leg: the DIRECTORY of the candidate matches the glob.
    expect(globAncestorMatch('/a/*.env', '/a/x.env/deep/file', cache)).toBe(true)
    expect(globAncestorMatch('/a/*.env', '/a/sub/x.env', cache)).toBe(false)
  })

  test('matchDenyToCandidate (S5e): literal deny = segment prefix; glob deny = ancestor match', () => {
    const cache = new Map<string, (s: string) => boolean>()
    expect(matchDenyToCandidate('/a/b', '/a/b/c', cache)).toBe(true)
    expect(matchDenyToCandidate('/a/b', '/a/bc', cache)).toBe(false)
    expect(matchDenyToCandidate('/a/*.env', '/a/x.env', cache)).toBe(true)
    expect(matchDenyToCandidate('/a/*.env', '/a/b/x.env', cache)).toBe(false)
  })

  test('realpathExistingPrefix (rte): resolves the existing ancestor, rejoins the tail', () => {
    const result = realpathExistingPrefix('/tmp/ttg285-missing/sub')
    expect(result).toBe(join(realpathSync('/tmp'), 'ttg285-missing', 'sub'))
    // Fully existing path resolves to itself (via /tmp realpath).
    expect(realpathExistingPrefix('/tmp')).toBe(realpathSync('/tmp'))
  })

  test('realpathVariants (VB): [path, realpath-of-glob-base + tail]', () => {
    const variants = realpathVariants('/tmp/ttg285-missing/*')
    expect(variants).toEqual([
      '/tmp/ttg285-missing/*',
      `${join(realpathSync('/tmp'), 'ttg285-missing')}/*`,
    ])
    // Non-glob path: base === path, so both variants are the same string
    // (official VB does NOT dedupe — MB() applies `U()` at the caller).
    expect(realpathVariants('/tmp/ttg285-missing')).toEqual([
      '/tmp/ttg285-missing',
      '/tmp/ttg285-missing',
    ])
  })

  test('resolveDenyPath (Vo): resolves against cwd and normalizes', () => {
    expect(resolveDenyPath('/a//b', '/tmp')).toBe('/a/b')
    expect(resolveDenyPath('./rel', '/tmp')).toBe('/tmp/rel')
    // normalize() keeps a trailing slash (official Om === path.normalize).
    expect(resolveDenyPath('/a//b/', '/tmp')).toBe('/a/b/')
  })

  test('candidateUnderDeniedRead (Gm): literal + glob baselines, both directions for glob candidates', () => {
    const cache = new Map<string, (s: string) => boolean>()
    const cwd = '/tmp'
    expect(candidateUnderDeniedRead(['/a/b'], '/a/b/c', cwd, cache)).toBe(true)
    expect(candidateUnderDeniedRead(['/a/b'], '/a/bc', cwd, cache)).toBe(false)
    // Empty baseline is never "under" (official `e.length===0` early return).
    expect(candidateUnderDeniedRead([], '/a/b/c', cwd, cache)).toBe(false)
    // Glob baseline vs literal candidate.
    expect(
      candidateUnderDeniedRead(['/a/*.env'], '/a/x.env', cwd, cache),
    ).toBe(true)
    // Glob candidate: its base is compared in BOTH directions (official
    // `S5e(b,S)||S5e(S,b)`), so a candidate glob WIDER than a literal deny
    // entry also counts as under it.
    expect(
      candidateUnderDeniedRead(['/a/b/c'], '/a/b/*', cwd, cache),
    ).toBe(true)
    expect(
      candidateUnderDeniedRead(['/a/b'], '/a/b/*', cwd, cache),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — trusted-tier gates and baselines (official Hm/Am/FB/ate-leg/nS/MB)
// ---------------------------------------------------------------------------

describe('trustedTierGrants — gates and baselines (binary Hm/Am/FB/nS/MB)', () => {
  test('isUntrustedSource (Hm): only project/local are untrusted', () => {
    expect(isUntrustedSource('projectSettings')).toBe(true)
    expect(isUntrustedSource('localSettings')).toBe(true)
    expect(isUntrustedSource('userSettings')).toBe(false)
    expect(isUntrustedSource('flagSettings')).toBe(false)
    expect(isUntrustedSource('policySettings')).toBe(false)
  })

  test('getTrustedSettingsSources (Am): [policy, flag, user-if-enabled]', () => {
    seed({
      policySettings: { sandbox: { enabled: true } } as SettingsJson,
      userSettings: { sandbox: { enabled: false } } as SettingsJson,
      projectSettings: { sandbox: {} } as SettingsJson,
    })
    const sources = getTrustedSettingsSources()
    expect(sources).toEqual([
      { sandbox: { enabled: true } },
      null,
      { sandbox: { enabled: false } },
    ])
  })

  test('hasTrustedReadDenyList (FB): policy/flag denyRead or Read deny-rules only', () => {
    seed({})
    expect(hasTrustedReadDenyList()).toBe(false)

    // Project-only deny list does NOT open the gate (untrusted tier).
    seed({
      projectSettings: {
        sandbox: { filesystem: { denyRead: ['/x'] } },
      } as SettingsJson,
    })
    expect(hasTrustedReadDenyList()).toBe(false)

    // Trusted sandbox.filesystem.denyRead opens it.
    seed({
      policySettings: {
        sandbox: { filesystem: { denyRead: ['/x'] } },
      } as SettingsJson,
    })
    expect(hasTrustedReadDenyList()).toBe(true)

    // Trusted Read(...) permission deny opens it; flagSettings counts too.
    seed({
      flagSettings: {
        permissions: { deny: ['Read(/secret)'] },
      } as SettingsJson,
    })
    expect(hasTrustedReadDenyList()).toBe(true)

    // A non-Read deny rule does not.
    seed({
      policySettings: {
        permissions: { deny: ['Bash(rm:*)'] },
      } as SettingsJson,
    })
    expect(hasTrustedReadDenyList()).toBe(false)
  })

  test('hasTrustedNetworkDenyList (ate deny leg): policy/flag deniedDomains or WebFetch domain: deny', () => {
    seed({})
    expect(hasTrustedNetworkDenyList()).toBe(false)

    seed({
      projectSettings: {
        sandbox: { network: { deniedDomains: ['evil.example'] } },
      } as SettingsJson,
    })
    expect(hasTrustedNetworkDenyList()).toBe(false)

    seed({
      policySettings: {
        sandbox: { network: { deniedDomains: ['evil.example'] } },
      } as SettingsJson,
    })
    expect(hasTrustedNetworkDenyList()).toBe(true)

    seed({
      flagSettings: {
        permissions: { deny: ['WebFetch(domain:evil.example)'] },
      } as SettingsJson,
    })
    expect(hasTrustedNetworkDenyList()).toBe(true)

    // WebFetch deny WITHOUT the domain: prefix does not open the leg.
    seed({
      policySettings: {
        permissions: { deny: ['WebFetch'] },
      } as SettingsJson,
    })
    expect(hasTrustedNetworkDenyList()).toBe(false)
  })

  test('getClaudeOwnReadDenyBaseline (nS): config dir, global config file, ide dir', () => {
    const baseline = getClaudeOwnReadDenyBaseline('/tmp')
    const configDir = getClaudeConfigHomeDir()
    expect(baseline).toContain(configDir)
    expect(baseline).toContain(getGlobalClaudeFile())
    expect(baseline).toContain(join(configDir, 'ide'))
  })

  test('getTrustedReadDenyBaseline (MB): trusted deny entries + nS(), project/local skipped', () => {
    seed({
      policySettings: {
        permissions: { deny: ['Read(/policy-secret/**)'] },
        sandbox: { filesystem: { denyRead: ['/policy-deny-dir'] } },
      } as SettingsJson,
      userSettings: {
        sandbox: { filesystem: { denyRead: ['/user-deny'] } },
      } as SettingsJson,
      projectSettings: {
        permissions: { deny: ['Read(/project-secret/**)'] },
        sandbox: { filesystem: { denyRead: ['/project-deny'] } },
      } as SettingsJson,
    })
    const baseline = getTrustedReadDenyBaseline('/tmp', identityResolvers)
    expect(baseline).toContain('/policy-secret/**')
    expect(baseline).toContain('/policy-deny-dir')
    expect(baseline).toContain('/user-deny')
    expect(baseline).not.toContain('/project-secret/**')
    expect(baseline).not.toContain('/project-deny')
    // nS() leg is always included.
    expect(baseline).toContain(getClaudeConfigHomeDir())
  })

  test('getTrustedAllowedDomains / getTrustedWebFetchAllowRules (Uf/OO legs): trusted tiers only, deduped', () => {
    seed({
      policySettings: {
        sandbox: { network: { allowedDomains: ['policy.example', 'shared.example'] } },
      } as SettingsJson,
      userSettings: {
        sandbox: { network: { allowedDomains: ['shared.example', 'user.example'] } },
        permissions: { allow: ['WebFetch(domain:ok.example)'] },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { allowedDomains: ['evil.example'] } },
        permissions: { allow: ['WebFetch(domain:bad.example)'] },
      } as SettingsJson,
    })
    expect(getTrustedAllowedDomains()).toEqual([
      'policy.example',
      'shared.example',
      'user.example',
    ])
    expect(getTrustedWebFetchAllowRules()).toEqual([
      'WebFetch(domain:ok.example)',
    ])
  })
})

// ---------------------------------------------------------------------------
// Part 3 — adapter: network allowedDomains gate (official jm `A = _ || T`)
// ---------------------------------------------------------------------------

describe('CC 2.1.285 — network allowedDomains restricted to trusted tiers (jm A-gate)', () => {
  test('gate closed: merged allowedDomains + merged WebFetch allow rules pass through', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowedDomains: ['merged.example'] } },
      permissions: { allow: ['WebFetch(domain:fetch.example)'] },
    } as SettingsJson)

    expect(config.network.allowedDomains).toEqual([
      'merged.example',
      'fetch.example',
    ])
    expect(sandboxLogs()).toEqual([])
  })

  test('strictAllowlist gate: project/local domains + WebFetch allows dropped, trusted honored', () => {
    seed({
      flagSettings: {
        sandbox: { network: { strictAllowlist: true } },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { allowedDomains: ['evil.example'] } },
        permissions: { allow: ['WebFetch(domain:bad.example)'] },
      } as SettingsJson,
      userSettings: {
        sandbox: { network: { allowedDomains: ['good.example'] } },
        permissions: { allow: ['WebFetch(domain:ok.example)'] },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: {
        network: {
          allowedDomains: ['good.example', 'evil.example'],
          deniedDomains: ['deny.example'],
        },
      },
      permissions: {
        allow: [
          'WebFetch(domain:ok.example)',
          'WebFetch(domain:bad.example)',
        ],
        deny: ['WebFetch(domain:hard-deny.example)'],
      },
    } as SettingsJson)

    expect(config.network.allowedDomains).toEqual([
      'good.example',
      'ok.example',
    ])
    // Deny lists are ALWAYS merged — never narrowed by this fix.
    expect(config.network.deniedDomains).toEqual([
      'deny.example',
      'hard-deny.example',
    ])
    expect(sandboxLogs()).toEqual([
      '[sandbox] network.strictAllowlist: ignoring 2 sandbox.network.allowedDomains / WebFetch(domain:…) allow entries from project/local settings',
    ])
  })

  test('mandate gate uses the "admin sandbox mandate" label; one-shot latch holds', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { allowedDomains: ['evil.example'] } },
      } as SettingsJson,
    })
    const merged = {
      sandbox: { network: { allowedDomains: ['evil.example'] } },
    } as SettingsJson

    convertToSandboxRuntimeConfig(merged)
    convertToSandboxRuntimeConfig(merged)

    expect(sandboxLogs()).toEqual([
      '[sandbox] admin sandbox mandate: ignoring 1 sandbox.network.allowedDomains / WebFetch(domain:…) allow entries from project/local settings',
    ])

    // Explicit reset re-arms the one-shot log (official latch semantics).
    _resetAllowedDomainsWarningForTesting()
    convertToSandboxRuntimeConfig(merged)
    expect(sandboxLogs().length).toBe(2)
  })

  test('no project/local entries to drop: gate open but silent', () => {
    seed({
      flagSettings: {
        sandbox: { network: { strictAllowlist: true } },
      } as SettingsJson,
    })
    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowedDomains: ['merged.example'] } },
    } as SettingsJson)

    expect(config.network.allowedDomains).toEqual([])
    expect(sandboxLogs()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Part 4 — adapter: filesystem grants screening (official jm fs loop)
// ---------------------------------------------------------------------------

describe('CC 2.1.285 — filesystem grants restricted to trusted tiers (jm fs loop)', () => {
  test('mandate (et): untrusted allowWrite + Edit allow-rules dropped wholesale, counted Ic', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      projectSettings: {
        sandbox: { filesystem: { allowWrite: ['/tmp/ttg285-m/w1'] } },
        permissions: { allow: ['Edit(//tmp/ttg285-m/w2)'] },
      } as SettingsJson,
      localSettings: {
        sandbox: { filesystem: { allowWrite: ['/tmp/ttg285-m/w3'] } },
      } as SettingsJson,
      userSettings: {
        sandbox: { filesystem: { allowWrite: ['/tmp/ttg285-m/user-w'] } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({})

    expect(config.filesystem.allowWrite).not.toContain('/tmp/ttg285-m/w1')
    expect(config.filesystem.allowWrite).not.toContain('/tmp/ttg285-m/w2')
    expect(config.filesystem.allowWrite).not.toContain('/tmp/ttg285-m/w3')
    // Trusted tier grants survive the mandate.
    expect(config.filesystem.allowWrite).toContain('/tmp/ttg285-m/user-w')
    expect(sandboxLogs()).toEqual([
      '[sandbox] filesystem grants restricted to trusted settings tiers: ignoring 3 sandbox.filesystem.allowWrite / Edit allow-rule path(s) (admin sandbox mandate) from project/local (or HKCU-backfilled policy) settings',
    ])
  })

  test('mandate: untrusted allowRead is dropped silently (et skips the read loop — no Nc count)', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      projectSettings: {
        sandbox: {
          filesystem: {
            allowRead: ['/tmp/ttg285-m/r1'],
            allowWrite: ['/tmp/ttg285-m/w1'],
          },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({})

    expect(config.filesystem.allowRead).not.toContain('/tmp/ttg285-m/r1')
    // Only the write leg is counted (Ic=1); no allowRead part in the log.
    expect(sandboxLogs()).toEqual([
      '[sandbox] filesystem grants restricted to trusted settings tiers: ignoring 1 sandbox.filesystem.allowWrite / Edit allow-rule path(s) (admin sandbox mandate) from project/local (or HKCU-backfilled policy) settings',
    ])
  })

  test('trusted Read deny (N gate): untrusted grants under the deny baseline dropped, Rc+Nc logged; trusted grants + deny rules unaffected', () => {
    seed({
      policySettings: {
        permissions: { deny: ['Read(//tmp/ttg285-secret/**)'] },
      } as SettingsJson,
      projectSettings: {
        sandbox: {
          filesystem: {
            allowRead: ['/tmp/ttg285-secret/token.txt'],
            allowWrite: [
              '/tmp/ttg285-secret/out.txt',
              '/tmp/ttg285-ok/write.txt',
            ],
          },
        },
      } as SettingsJson,
      userSettings: {
        sandbox: {
          filesystem: { allowRead: ['/tmp/ttg285-secret/user-note.txt'] },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({})

    // Untrusted grants under the trusted deny baseline are dropped.
    expect(config.filesystem.allowRead).not.toContain(
      '/tmp/ttg285-secret/token.txt',
    )
    expect(config.filesystem.allowWrite).not.toContain(
      '/tmp/ttg285-secret/out.txt',
    )
    // Untrusted grant OUTSIDE the baseline survives.
    expect(config.filesystem.allowWrite).toContain('/tmp/ttg285-ok/write.txt')
    // Trusted-tier grant inside the baseline survives (screening is untrusted-only).
    expect(config.filesystem.allowRead).toContain(
      '/tmp/ttg285-secret/user-note.txt',
    )
    // The deny rule itself is always honored.
    expect(config.filesystem.denyRead).toContain('/tmp/ttg285-secret/**')
    expect(sandboxLogs()).toEqual([
      '[sandbox] filesystem grants restricted to trusted settings tiers: ignoring 1 sandbox.filesystem.allowWrite / Edit allow-rule path(s) under a denied read path (managed or --settings read deny) and 1 sandbox.filesystem.allowRead path(s) inside a denied read path (managed or --settings read deny) from project/local (or HKCU-backfilled policy) settings',
    ])
  })

  test('default case (no mandate, no trusted deny): nS() Claude-own baseline still screens untrusted grants', () => {
    const evilPath = join(getClaudeConfigHomeDir(), 'ttg285-evil-write')
    seed({
      projectSettings: {
        sandbox: {
          filesystem: {
            allowWrite: [evilPath, '/tmp/ttg285-ok/w2.txt'],
          },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({})

    expect(config.filesystem.allowWrite).not.toContain(evilPath)
    expect(config.filesystem.allowWrite).toContain('/tmp/ttg285-ok/w2.txt')
    expect(sandboxLogs()).toEqual([
      "[sandbox] filesystem grants restricted to trusted settings tiers: ignoring 1 sandbox.filesystem.allowWrite / Edit allow-rule path(s) under a denied read path (Claude Code's own read-deny paths) from project/local (or HKCU-backfilled policy) settings",
    ])
  })

  test('deny rules from untrusted sources are ALWAYS honored (a deny is never widened by the fix)', () => {
    seed({
      projectSettings: {
        permissions: { deny: ['Edit(//tmp/ttg285-deny/x)', 'Read(//tmp/ttg285-deny/y)'] },
        sandbox: {
          filesystem: {
            denyWrite: ['/tmp/ttg285-deny/z'],
            denyRead: ['/tmp/ttg285-deny/w'],
          },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({})

    expect(config.filesystem.denyWrite).toContain('/tmp/ttg285-deny/x')
    expect(config.filesystem.denyRead).toContain('/tmp/ttg285-deny/y')
    expect(config.filesystem.denyWrite).toContain('/tmp/ttg285-deny/z')
    expect(config.filesystem.denyRead).toContain('/tmp/ttg285-deny/w')
    expect(sandboxLogs()).toEqual([])
  })

  test('fs log latch is one-shot and re-arms via _resetFilesystemGrantsWarningForTesting', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      projectSettings: {
        sandbox: { filesystem: { allowWrite: ['/tmp/ttg285-l/w'] } },
      } as SettingsJson,
    })

    convertToSandboxRuntimeConfig({})
    convertToSandboxRuntimeConfig({})
    expect(sandboxLogs().length).toBe(1)

    _resetFilesystemGrantsWarningForTesting()
    convertToSandboxRuntimeConfig({})
    expect(sandboxLogs().length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Part 5 — adapter: network allowances (official dB — proxy ports / sockets)
// ---------------------------------------------------------------------------

describe('CC 2.1.285 — network allowances restricted to trusted tiers (binary dB)', () => {
  test('no gate: merged allowances pass through untouched, no log', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: {
        network: {
          allowUnixSockets: ['/tmp/ttg285-p.sock'],
          allowAllUnixSockets: true,
          allowLocalBinding: false,
          httpProxyPort: 8888,
          socksProxyPort: 1080,
        },
      },
    } as SettingsJson)

    expect(config.network.allowUnixSockets).toEqual(['/tmp/ttg285-p.sock'])
    expect(config.network.allowAllUnixSockets).toBe(true)
    expect(config.network.allowLocalBinding).toBe(false)
    expect(config.network.httpProxyPort).toBe(8888)
    expect(config.network.socksProxyPort).toBe(1080)
    expect(sandboxLogs()).toEqual([])
  })

  test('trusted deny list (ate without mandate): proxy ports trusted-only, sockets stay merged', () => {
    seed({
      policySettings: {
        sandbox: { network: { deniedDomains: ['blocked.example'] } },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { httpProxyPort: 9999, socksProxyPort: 9998 } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: {
        network: {
          httpProxyPort: 9999,
          socksProxyPort: 9998,
          allowUnixSockets: ['/tmp/ttg285.sock'],
        },
      },
    } as SettingsJson)

    // zO leg: only the proxy ports are restricted (no mandate).
    expect(config.network.httpProxyPort).toBeUndefined()
    expect(config.network.socksProxyPort).toBeUndefined()
    // !r leg: merged unix sockets are kept when the mandate is off.
    expect(config.network.allowUnixSockets).toEqual(['/tmp/ttg285.sock'])
    expect(sandboxLogs()).toEqual([
      '[sandbox] trusted network deny list or strict allowlist: ignoring sandbox.network.httpProxyPort, socksProxyPort from project/local settings (a project may not replace the filtering proxy)',
    ])
  })

  test('trusted proxy port wins under the ate gate (wE: first trusted tier)', () => {
    seed({
      policySettings: {
        sandbox: { network: { deniedDomains: ['blocked.example'] } },
      } as SettingsJson,
      flagSettings: {
        sandbox: { network: { httpProxyPort: 3128 } },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { httpProxyPort: 9999 } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { httpProxyPort: 9999 } },
    } as SettingsJson)

    expect(config.network.httpProxyPort).toBe(3128)
  })

  test('mandate: every field trusted-only — project sockets dropped, trusted sockets kept (Uf)', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      projectSettings: {
        sandbox: {
          network: {
            allowUnixSockets: ['/tmp/ttg285-evil.sock'],
            allowAllUnixSockets: true,
          },
        },
      } as SettingsJson,
      userSettings: {
        sandbox: { network: { allowUnixSockets: ['/tmp/ttg285-user.sock'] } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: {
        network: {
          allowUnixSockets: ['/tmp/ttg285-evil.sock', '/tmp/ttg285-user.sock'],
          allowAllUnixSockets: true,
        },
      },
    } as SettingsJson)

    expect(config.network.allowUnixSockets).toEqual(['/tmp/ttg285-user.sock'])
    // No trusted tier sets allowAllUnixSockets -> undefined (merged true dropped).
    expect(config.network.allowAllUnixSockets).toBeUndefined()
    expect(sandboxLogs()).toEqual([
      '[sandbox] admin sandbox mandate: ignoring sandbox.network.allowUnixSockets, allowAllUnixSockets from project/local settings',
    ])
  })

  test('Km false-sticky: merged false survives even when a trusted tier says true', () => {
    seed({
      policySettings: {
        sandbox: { allowUnsandboxedCommands: false },
      } as SettingsJson,
      userSettings: {
        sandbox: { network: { allowAllUnixSockets: true } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowAllUnixSockets: false } },
    } as SettingsJson)

    // `Km(e,r) = e===!1 ? !1 : wE(r)` — explicit false is sticky.
    expect(config.network.allowAllUnixSockets).toBe(false)
    // Nothing set in project/local -> no dropped-fields log.
    expect(sandboxLogs()).toEqual([])
  })

  test('allowManagedDomainsOnly (kO leg): proxy ports come from policy only; --settings/user ports dropped with their own log', () => {
    seed({
      policySettings: {
        sandbox: {
          network: { allowManagedDomainsOnly: true, httpProxyPort: 8080 },
        },
      } as SettingsJson,
      userSettings: {
        sandbox: { network: { httpProxyPort: 8081 } },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { httpProxyPort: 8081 } },
    } as SettingsJson)

    expect(config.network.httpProxyPort).toBe(8080)
    expect(sandboxLogs()).toEqual([
      '[sandbox] network.allowManagedDomainsOnly: ignoring sandbox.network.httpProxyPort from --settings/user settings; only managed settings may replace the filtering proxy',
    ])
  })

  test('allowances log latch is one-shot and re-arms via _resetNetworkAllowancesWarningForTesting', () => {
    seed({
      policySettings: {
        sandbox: { network: { deniedDomains: ['blocked.example'] } },
      } as SettingsJson,
      projectSettings: {
        sandbox: { network: { httpProxyPort: 9999 } },
      } as SettingsJson,
    })
    const merged = {
      sandbox: { network: { httpProxyPort: 9999 } },
    } as SettingsJson

    convertToSandboxRuntimeConfig(merged)
    convertToSandboxRuntimeConfig(merged)
    expect(sandboxLogs().length).toBe(1)

    _resetNetworkAllowancesWarningForTesting()
    convertToSandboxRuntimeConfig(merged)
    expect(sandboxLogs().length).toBe(2)
  })

  test('value===false in project/local is not counted as a dropped field (official `!==void 0&&!==!1`)', () => {
    seed({
      policySettings: {
        sandbox: { network: { deniedDomains: ['blocked.example'] } },
      } as SettingsJson,
      projectSettings: {
        sandbox: {
          network: { allowAllUnixSockets: false, allowLocalBinding: false },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowAllUnixSockets: false } },
    } as SettingsJson)

    // Non-mandate ate gate keeps the merged values; false is not "dropped".
    expect(config.network.allowAllUnixSockets).toBe(false)
    expect(sandboxLogs()).toEqual([])
  })
})
