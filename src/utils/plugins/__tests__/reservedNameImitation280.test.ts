import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  assertMarketplaceNameNotReservedImitation,
  COMMUNITY_RESERVED_MARKETPLACE_NAMES,
  findImitatedReservedName,
  isAnotherSpellingOfReservedName,
  isBlockedOfficialName,
  isMarketplaceAutoUpdate,
  isPluginDirectoryNameImitation,
  isSafeMarketplaceCommandArg,
  knownMarketplacesImitationMessage,
  PLUGIN_DIRECTORY_RESERVED_NAMES,
  PRIMARY_PLUGIN_DIRECTORY_NAME,
  RESERVED_MARKETPLACE_NAMES,
  reservedMarketplaceNameMessage,
  reservedNameRefusalMessage,
  slugifyMarketplaceName,
  validateOfficialNameSource,
} from '../schemas.js'
import type { ReconcileProgressEvent } from '../reconciler.js'

/**
 * CC 2.1.280 changelog item #084 (marketplace reserved-name imitation
 * defense) — spelling-imitation layer ported byte-verified from the official
 * v280 binary:
 *
 *   f1  @193905957  safe-command-arg test /^\w[\w.@-]*$/
 *   o   @193905993  slug: replace(/[^a-zA-Z0-9\-_]/g,"-").toLowerCase()
 *   _fr @193906057  another-spelling: raw slug | NFKC slug | NFKC with
 *                   invisible chars (U+200C-U+200F, U+202A-U+202E, U+206A-U+206F, U+FEFF)
 *                   stripped, case-folded, trailing [. ]+ removed
 *   $be/VBe         plugin-directory imitation / first imitated reserved name
 *   det/Voo/irr     refusal messages (byte-exact assertions below)
 *   g/sl/bfr/Hse    known_marketplaces.json ignore messages @193906821
 *   wNe             add-time assert (claude.ai-prefix branch N/A in OCC)
 *   qte/Jjt         registry-entry trust gate (getMarketplace/refresh)
 *   reconciler @212480446: refusal BEFORE skip checks, failed[] + onProgress
 *
 * v278→v280 delta proof: v278 has 0 marketplace 'another spelling of' hits;
 * reserved-name SETS are byte-identical between versions (v278 NPe@192477411
 * = v280 dOe@191097494, re-verified this round).
 */

// ---------------------------------------------------------------------------
// Module-boundary mock for the reconciler scenario (registered BEFORE the
// reconciler import so its cross-module bindings resolve to the mock).
// Real function references are captured first — Bun patches live ESM
// namespaces, so accessing them off the namespace object after mock.module
// would recurse (npmPluginFetch275.test.ts convention).
// ---------------------------------------------------------------------------
const realMm = await import('../marketplaceManager.js')
const realLoadKnownMarketplacesConfig = realMm.loadKnownMarketplacesConfig
const realRefreshMarketplace = realMm.refreshMarketplace
const realAddMarketplaceSource = realMm.addMarketplaceSource

let reconcileMode = false
let declaredOverride: Record<
  string,
  { source: Record<string, unknown> }
> = {}
const addSourceCalls: unknown[] = []

mock.module('../marketplaceManager.js', () => ({
  ...realMm,
  getDeclaredMarketplaces: () =>
    reconcileMode ? declaredOverride : realMm.getDeclaredMarketplaces(),
  loadKnownMarketplacesConfig: async () =>
    reconcileMode ? {} : realLoadKnownMarketplacesConfig(),
  addMarketplaceSource: async (source: never) => {
    if (reconcileMode) {
      addSourceCalls.push(source)
      return {
        name: 'my-legit-marketplace',
        alreadyMaterialized: false,
        resolvedSource: source,
      }
    }
    return realAddMarketplaceSource(source)
  },
}))

const { reconcileMarketplaces } = await import('../reconciler.js')

afterAll(() => {
  reconcileMode = false
  mock.restore()
  // Bun's mock.restore() does not undo mock.module registry patches —
  // re-register the real marketplaceManager so sibling test files batched
  // after this one are unaffected.
  mock.module('../marketplaceManager.js', () => realMm)
})

// ---------------------------------------------------------------------------
// (a) schemas primitives — sets, slugifier, another-spelling, messages
// ---------------------------------------------------------------------------
describe('reserved-name sets match official v280 membership', () => {
  test('dOe: 14 official names', () => {
    expect(ALLOWED_OFFICIAL_MARKETPLACE_NAMES.size).toBe(14)
    expect([...ALLOWED_OFFICIAL_MARKETPLACE_NAMES].sort()).toEqual(
      [
        'agent-skills',
        'anthropic-agent-skills',
        'anthropic-marketplace',
        'anthropic-plugins',
        'claude-code-marketplace',
        'claude-code-plugins',
        'claude-for-financial-services',
        'claude-for-legal',
        'claude-plugins-official',
        'claude-tag-plugins',
        'financial-services-plugins',
        'first-party-plugins',
        'knowledge-work-plugins',
        'life-sciences',
      ].sort(),
    )
  })

  test('CIt: 3 community-reserved names; xtn: 2 plugin-directory names', () => {
    expect([...COMMUNITY_RESERVED_MARKETPLACE_NAMES]).toEqual([
      'claude-community',
      'claude-plugins-community',
      'healthcare',
    ])
    expect(PRIMARY_PLUGIN_DIRECTORY_NAME).toBe('anthropic-plugin-directory')
    expect([...PLUGIN_DIRECTORY_RESERVED_NAMES]).toEqual([
      'anthropic-plugin-directory',
      'claude-plugin-directory',
    ])
  })

  test('W7: 19 reserved names, insertion order dOe → CIt → xtn', () => {
    expect(RESERVED_MARKETPLACE_NAMES.size).toBe(19)
    expect([...RESERVED_MARKETPLACE_NAMES]).toEqual([
      ...ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
      ...COMMUNITY_RESERVED_MARKETPLACE_NAMES,
      ...PLUGIN_DIRECTORY_RESERVED_NAMES,
    ])
  })

  test('fd: auto-update opt-outs (knowledge-work-plugins, first-party-plugins)', () => {
    expect(isMarketplaceAutoUpdate('first-party-plugins', {})).toBe(false)
    expect(isMarketplaceAutoUpdate('knowledge-work-plugins', {})).toBe(false)
    expect(isMarketplaceAutoUpdate('claude-for-legal', {})).toBe(true)
    expect(isMarketplaceAutoUpdate('claude-plugins-official', {})).toBe(true)
    // reserved-but-not-official → no auto-update default
    expect(isMarketplaceAutoUpdate('healthcare', {})).toBe(false)
    expect(isMarketplaceAutoUpdate('my-marketplace', {})).toBe(false)
    // explicit stored value always wins
    expect(isMarketplaceAutoUpdate('healthcare', { autoUpdate: true })).toBe(
      true,
    )
    expect(
      isMarketplaceAutoUpdate('claude-for-legal', { autoUpdate: false }),
    ).toBe(false)
  })
})

describe('slugifier and safe-command-arg (official o / f1)', () => {
  test('slugifyMarketplaceName: non [a-zA-Z0-9-_] → "-", lowercased', () => {
    expect(slugifyMarketplaceName('Agent.Skills')).toBe('agent-skills')
    expect(slugifyMarketplaceName('claude plugins official')).toBe(
      'claude-plugins-official',
    )
    // underscore IS a slug char (byte-faithful to official o())
    expect(slugifyMarketplaceName('life_sciences')).toBe('life_sciences')
  })

  test('isSafeMarketplaceCommandArg: /^\\w[\\w.@-]*$/', () => {
    expect(isSafeMarketplaceCommandArg('agent.skills')).toBe(true)
    expect(isSafeMarketplaceCommandArg('claude-plugins-official.')).toBe(true)
    expect(isSafeMarketplaceCommandArg('first-party plugins')).toBe(false)
    expect(isSafeMarketplaceCommandArg('-leading-dash')).toBe(false)
    expect(isSafeMarketplaceCommandArg('name;rm -rf /')).toBe(false)
    expect(isSafeMarketplaceCommandArg('')).toBe(false)
  })
})

describe('isAnotherSpellingOfReservedName (official _fr)', () => {
  const CPO = 'claude-plugins-official'

  test('punctuation slug collision (dot → hyphen)', () => {
    expect(
      isAnotherSpellingOfReservedName('agent.skills', 'agent-skills'),
    ).toBe(true)
    expect(
      isAnotherSpellingOfReservedName('claude.plugins.official', CPO),
    ).toBe(true)
  })

  test('NFKC fullwidth homoglyphs', () => {
    expect(
      isAnotherSpellingOfReservedName(
        'ｃｌａｕｄｅ－ｐｌｕｇｉｎｓ－ｏｆｆｉｃｉａｌ',
        CPO,
      ),
    ).toBe(true)
  })

  test('zero-width / bidi invisible character insertion', () => {
    // ZWNJ between the words
    expect(
      isAnotherSpellingOfReservedName(
        'knowledge-work\u200c-plugins',
        'knowledge-work-plugins',
      ),
    ).toBe(true)
    // LRM inside the name
    expect(
      isAnotherSpellingOfReservedName(
        'anthropic\u200eplugins',
        'anthropic-plugins',
      ),
    ).toBe(true)
    // BOM prefix
    expect(
      isAnotherSpellingOfReservedName(`\ufeff${CPO}`, CPO),
    ).toBe(true)
  })

  test('case variants', () => {
    expect(isAnotherSpellingOfReservedName('CLAUDE-PLUGINS-OFFICIAL', CPO)).toBe(
      true,
    )
  })

  test('trailing dots and spaces', () => {
    expect(isAnotherSpellingOfReservedName('claude-plugins-official.', CPO)).toBe(
      true,
    )
    expect(isAnotherSpellingOfReservedName('claude-plugins-official ', CPO)).toBe(
      true,
    )
  })

  test('spaces → hyphens', () => {
    expect(isAnotherSpellingOfReservedName('claude plugins official', CPO)).toBe(
      true,
    )
  })

  test('negative: underscore is NOT a spelling of hyphen (official o() keeps "_")', () => {
    expect(
      isAnotherSpellingOfReservedName('life_sciences', 'life-sciences'),
    ).toBe(false)
    expect(isAnotherSpellingOfReservedName('my-marketplace', CPO)).toBe(false)
    expect(
      isAnotherSpellingOfReservedName('claude-plugins-unofficial', CPO),
    ).toBe(false)
  })
})

describe('findImitatedReservedName / isPluginDirectoryNameImitation (official VBe / $be)', () => {
  test('returns the imitated reserved name', () => {
    expect(findImitatedReservedName('agent.skills')).toBe('agent-skills')
    expect(findImitatedReservedName('CLAUDE-PLUGINS-OFFICIAL.')).toBe(
      'claude-plugins-official',
    )
    expect(
      findImitatedReservedName('ｃｌａｕｄｅ－ｐｌｕｇｉｎｓ－ｏｆｆｉｃｉａｌ'),
    ).toBe('claude-plugins-official')
    // xtn sibling (not the primary) is reported as the target
    expect(findImitatedReservedName('claude.plugin.directory')).toBe(
      'claude-plugin-directory',
    )
  })

  test('undefined for exact case-insensitive matches (handled by the exact-name path)', () => {
    expect(findImitatedReservedName('claude-plugins-official')).toBeUndefined()
    expect(findImitatedReservedName('CLAUDE-PLUGINS-OFFICIAL')).toBeUndefined()
    expect(findImitatedReservedName('healthcare')).toBeUndefined()
  })

  test('skips the primary plugin-directory name (covered by $be)', () => {
    expect(
      findImitatedReservedName('anthropic.plugin.directory'),
    ).toBeUndefined()
    expect(isPluginDirectoryNameImitation('anthropic.plugin.directory')).toBe(
      true,
    )
    expect(isPluginDirectoryNameImitation('anthropic-plugin-directory')).toBe(
      true,
    )
    expect(isPluginDirectoryNameImitation('ANTHROPIC.PLUGIN.DIRECTORY.')).toBe(
      true,
    )
    // underscore is a slug char in official o() — never becomes '-'
    expect(isPluginDirectoryNameImitation('ANTHROPIC_PLUGIN_DIRECTORY.')).toBe(
      false,
    )
    expect(isPluginDirectoryNameImitation('claude-plugin-directory')).toBe(false)
    expect(isPluginDirectoryNameImitation('my-plugins')).toBe(false)
  })

  test('benign names are not imitations', () => {
    expect(findImitatedReservedName('my-cool-marketplace')).toBeUndefined()
    expect(findImitatedReservedName('life_sciences')).toBeUndefined()
  })
})

describe('refusal messages are byte-exact (official det / Voo / irr / bfr+Hse)', () => {
  test('det: plain reserved-name message', () => {
    expect(reservedMarketplaceNameMessage('anthropic.plugin.directory')).toBe(
      '"anthropic.plugin.directory" is a reserved marketplace name.',
    )
  })

  test('Voo: another-spelling message, both f1 branches', () => {
    expect(reservedNameRefusalMessage('agent.skills', 'agent-skills')).toBe(
      '"agent.skills" is another spelling of "agent-skills", a reserved marketplace name.',
    )
    expect(
      reservedNameRefusalMessage('first-party plugins', 'first-party-plugins'),
    ).toBe(
      `This marketplace's name is another spelling of "first-party-plugins", a reserved marketplace name. It is not exactly the reserved name it appears to be.`,
    )
  })

  test('irr: plugin-directory targets get the plain det message', () => {
    expect(
      reservedNameRefusalMessage(
        'claude.plugin.directory',
        'claude-plugin-directory',
      ),
    ).toBe('"claude.plugin.directory" is a reserved marketplace name.')
  })

  test('Hse: known_marketplaces.json ignore messages (all 3 variants)', () => {
    // f1-safe name → remove-command variant (OCC brands the CLI as `occ`)
    expect(knownMarketplacesImitationMessage('agent.skills')).toBe(
      'known_marketplaces.json has an entry named "agent.skills", another spelling of the reserved marketplace name "agent-skills", so it is ignored. Remove it with: occ plugin marketplace remove agent.skills',
    )
    // non-f1 name (space) → "under another spelling" variant
    expect(knownMarketplacesImitationMessage('first-party plugins')).toBe(
      'known_marketplaces.json has an entry under another spelling of "first-party-plugins", a reserved marketplace name, so it is ignored. Remove that entry from known_marketplaces.json; its name is not exactly the reserved name it appears to be.',
    )
    // official g(): name ending in '.' → no remove command → same variant
    expect(knownMarketplacesImitationMessage('claude-plugins-official.')).toBe(
      'known_marketplaces.json has an entry under another spelling of "claude-plugins-official", a reserved marketplace name, so it is ignored. Remove that entry from known_marketplaces.json; its name is not exactly the reserved name it appears to be.',
    )
    // $be / xtn branches → det message
    expect(
      knownMarketplacesImitationMessage('anthropic.plugin.directory'),
    ).toBe('"anthropic.plugin.directory" is a reserved marketplace name.')
    expect(knownMarketplacesImitationMessage('claude.plugin.directory')).toBe(
      '"claude.plugin.directory" is a reserved marketplace name.',
    )
    // not an imitation → undefined (exact reserved names are NOT filtered at
    // load time; they go through the use-time trust gate instead)
    expect(knownMarketplacesImitationMessage('my-marketplace')).toBeUndefined()
    expect(
      knownMarketplacesImitationMessage('claude-plugins-official'),
    ).toBeUndefined()
  })

  test('wNe: add-time assert throws the refusal, benign names pass', () => {
    expect(() =>
      assertMarketplaceNameNotReservedImitation('anthropic.plugin.directory'),
    ).toThrow('"anthropic.plugin.directory" is a reserved marketplace name.')
    expect(() =>
      assertMarketplaceNameNotReservedImitation('agent.skills'),
    ).toThrow(
      '"agent.skills" is another spelling of "agent-skills", a reserved marketplace name.',
    )
    // exact reserved names pass wNe (handled by validateOfficialNameSource)
    expect(() =>
      assertMarketplaceNameNotReservedImitation('claude-plugins-official'),
    ).not.toThrow()
    expect(() =>
      assertMarketplaceNameNotReservedImitation('my-marketplace'),
    ).not.toThrow()
  })
})

describe('gate swaps to the 19-name W7 set', () => {
  test('isBlockedOfficialName: exact reserved names are source-gated, not pattern-blocked', () => {
    expect(isBlockedOfficialName('claude-plugins-community')).toBe(false)
    expect(isBlockedOfficialName('healthcare')).toBe(false)
    expect(isBlockedOfficialName('anthropic-plugin-directory')).toBe(false)
    // impersonation patterns still blocked
    expect(isBlockedOfficialName('official-claude-plugins')).toBe(true)
    expect(isBlockedOfficialName('anthropic-marketplace-new')).toBe(true)
    // homoglyph (Cyrillic а) blocked as non-ASCII
    expect(isBlockedOfficialName('аnthropic-plugins')).toBe(true)
    expect(isBlockedOfficialName('my-marketplace')).toBe(false)
  })

  test('validateOfficialNameSource gates on W7 (newly-reserved names included)', () => {
    expect(
      validateOfficialNameSource('healthcare', {
        source: 'github',
        repo: 'anthropics/healthcare',
      }),
    ).toBeNull()
    expect(
      validateOfficialNameSource('healthcare', {
        source: 'github',
        repo: 'evil/healthcare',
      }),
    ).toContain(
      "The name 'healthcare' is reserved for official Anthropic marketplaces",
    )
    expect(
      validateOfficialNameSource('claude-plugins-community', {
        source: 'github',
        repo: 'evil/claude-plugins-community',
      }),
    ).toContain('reserved for official Anthropic marketplaces')
    expect(
      validateOfficialNameSource('anthropic-plugin-directory', {
        source: 'github',
        repo: 'evil/anthropic-plugin-directory',
      }),
    ).toContain('reserved for official Anthropic marketplaces')
    // unreserved names are not source-gated
    expect(
      validateOfficialNameSource('my-marketplace', {
        source: 'github',
        repo: 'evil/my-marketplace',
      }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (b)(d)(e) filesystem-sandboxed integration tests
// ---------------------------------------------------------------------------
let sandbox: string
let savedCacheDir: string | undefined
let savedSeedDir: string | undefined

function knownMarketplacesPath(): string {
  return join(sandbox, 'known_marketplaces.json')
}

function writeKnownMarketplaces(entries: Record<string, unknown>): void {
  writeFileSync(knownMarketplacesPath(), JSON.stringify(entries, null, 2))
}

function githubEntry(repo: string): Record<string, unknown> {
  return {
    source: { source: 'github', repo },
    installLocation: join(sandbox, 'marketplaces', repo.replace('/', '-')),
    lastUpdated: '2026-09-01T00:00:00.000Z',
  }
}

describe('filesystem-sandboxed refusal paths', () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'rni280-'))
    mkdirSync(join(sandbox, 'marketplaces'), { recursive: true })
    savedCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    savedSeedDir = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = sandbox
    reconcileMode = false
    addSourceCalls.length = 0
  })

  afterEach(() => {
    if (savedCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = savedCacheDir
    }
    if (savedSeedDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = savedSeedDir
    }
    rmSync(sandbox, { recursive: true, force: true })
  })

  test('(b) loadKnownMarketplacesConfig drops imitation entries, keeps legit + exact-reserved', async () => {
    writeKnownMarketplaces({
      'legit-marketplace': githubEntry('someone/legit-marketplace'),
      'claude-plugins-official': githubEntry(
        'anthropics/claude-plugins-official',
      ),
      'agent.skills': githubEntry('evil/agent-skills'),
      'anthropic.plugin.directory': githubEntry('evil/dir'),
      'first-party plugins': githubEntry('evil/first-party-plugins'),
    })

    const config = await realLoadKnownMarketplacesConfig()
    expect(Object.keys(config).sort()).toEqual([
      'claude-plugins-official',
      'legit-marketplace',
    ])
  })

  test('(d) refreshMarketplace refuses an exact reserved name registered from an untrusted source (official Jjt)', async () => {
    writeKnownMarketplaces({
      'claude-plugins-official': githubEntry('evil/claude-plugins-official'),
    })

    let message = ''
    try {
      await realRefreshMarketplace('claude-plugins-official')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain(
      'Marketplace "claude-plugins-official" is registered from an untrusted source:',
    )
    expect(message).toContain(
      "The name 'claude-plugins-official' is reserved for official Anthropic marketplaces.",
    )
    expect(message).toContain(
      'To fix it, remove the marketplace and re-add it from the official source.',
    )
  })

  test('(d) refreshMarketplace trusts a seed-managed reserved-name entry (official Yy arm — no refusal)', async () => {
    // Seed-managed entries are admin-controlled → qte returns null even for
    // a non-anthropics source. The refresh then stops at the seed-managed
    // guidance error (before any git/network I/O) — proving Jjt passed.
    const seedDir = join(sandbox, 'seed')
    mkdirSync(join(seedDir, 'marketplaces'), { recursive: true })
    process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir
    writeKnownMarketplaces({
      healthcare: {
        source: { source: 'github', repo: 'internal-mirror/healthcare' },
        installLocation: join(seedDir, 'marketplaces', 'healthcare'),
        lastUpdated: '2026-09-01T00:00:00.000Z',
      },
    })

    let message = ''
    try {
      await realRefreshMarketplace('healthcare')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('seed-managed')
    expect(message).not.toContain('untrusted source')
    expect(message).not.toContain('reserved marketplace name')
  })

  test('(e) addMarketplaceSource refuses a manifest name that imitates a reserved name (official wNe)', async () => {
    writeKnownMarketplaces({})
    const marketplaceDir = join(sandbox, 'imitation-marketplace')
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'agent.skills',
        owner: { name: 'imitator' },
        plugins: [],
      }),
    )

    let message = ''
    try {
      await realAddMarketplaceSource({
        source: 'directory',
        path: marketplaceDir,
      })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toBe(
      '"agent.skills" is another spelling of "agent-skills", a reserved marketplace name.',
    )
  })
})

// ---------------------------------------------------------------------------
// (c) reconciler refusal for extraKnownMarketplaces imitations
// ---------------------------------------------------------------------------
describe('reconcileMarketplaces refuses reserved-name imitations (official @212480446)', () => {
  beforeEach(() => {
    reconcileMode = true
    declaredOverride = {}
    addSourceCalls.length = 0
  })

  test('imitation declared names fail before any install; legit names still process', async () => {
    declaredOverride = {
      'agent.skills': {
        source: { source: 'github', repo: 'evil/agent-skills' },
      },
      'anthropic.plugin.directory': {
        source: { source: 'github', repo: 'evil/dir' },
      },
      'my-legit-marketplace': {
        source: { source: 'github', repo: 'someone/my-legit-marketplace' },
      },
    }

    const events: ReconcileProgressEvent[] = []
    const result = await reconcileMarketplaces({
      onProgress: event => events.push(event),
    })

    // Both imitations refused with the exact official composite message
    expect(result.failed).toEqual([
      {
        name: 'agent.skills',
        error:
          '"agent.skills" is another spelling of "agent-skills", a reserved marketplace name. This marketplace was not added. Remove it from extraKnownMarketplaces in settings.',
      },
      {
        name: 'anthropic.plugin.directory',
        error:
          '"anthropic.plugin.directory" is a reserved marketplace name. This marketplace was not added. Remove it from extraKnownMarketplaces in settings.',
      },
    ])

    // addMarketplaceSource never runs for refused names — only the legit one
    expect(addSourceCalls).toEqual([
      { source: 'github', repo: 'someone/my-legit-marketplace' },
    ])
    expect(result.installed).toEqual(['my-legit-marketplace'])

    // onProgress mirrors the failures
    const failedEvents = events.filter(e => e.type === 'failed')
    expect(failedEvents).toEqual([
      {
        type: 'failed',
        name: 'agent.skills',
        error: result.failed[0]!.error,
      },
      {
        type: 'failed',
        name: 'anthropic.plugin.directory',
        error: result.failed[1]!.error,
      },
    ])
  })

  test('all-imitation declaration still reports failed via the early return', async () => {
    declaredOverride = {
      'claude-plugins-official.': {
        source: { source: 'github', repo: 'evil/cpo' },
      },
    }

    const result = await reconcileMarketplaces()

    expect(result.installed).toEqual([])
    expect(result.failed).toEqual([
      {
        name: 'claude-plugins-official.',
        error:
          '"claude-plugins-official." is another spelling of "claude-plugins-official", a reserved marketplace name. This marketplace was not added. Remove it from extraKnownMarketplaces in settings.',
      },
    ])
    expect(addSourceCalls).toEqual([])
  })
})
