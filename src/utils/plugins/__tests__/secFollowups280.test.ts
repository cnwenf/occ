/**
 * OCC-134 security-review follow-ups (M1 + M3).
 *
 * M3 — validateOfficialNameSource (schemas.ts): the git-URL branch used
 * substring matching (`url.includes('github.com/anthropics/')`), so a URL like
 * `https://evil.example/github.com/anthropics/x.git` passed. Replaced with a
 * byte-faithful port of official v280 `EVe`@191098926 + `Sd` + `Ctn`@191095040
 * (full host parsing via the `UNn` normalizer = extractGitHubRepoFromGitUrl).
 *
 * M1 — getMarketplaceCacheOnly/getPluginByIdCacheOnly (marketplaceManager.ts):
 * bare `jsonParse` of known_marketplaces.json bypassed both the imitation-name
 * admission filter (official `Hse`/`Wjt`, loadKnownMarketplacesConfig) and the
 * reserved-name trust gate (official `qte`/`Jjt`) that getMarketplace and
 * refreshMarketplace already applied. Now routed through
 * loadKnownMarketplacesConfigSafe + reservedNameRegistryRefusal (non-throwing
 * null to match the cache-only contract).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICIAL_GITHUB_ORG,
  validateOfficialNameSource,
} from '../schemas.js'

// ---------------------------------------------------------------------------
// M3: validateOfficialNameSource — official `EVe` host-parsing semantics.
// ---------------------------------------------------------------------------

const RESERVED = 'anthropic-marketplace' // in RESERVED_MARKETPLACE_NAMES (W7)

const refusalFor = (name: string): string =>
  `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`

describe('validateOfficialNameSource — git URLs (official `Sd`/`Ctn` host parsing)', () => {
  test('genuine https github.com/anthropics URL passes', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://github.com/anthropics/claude-code.git',
      }),
    ).toBeNull()
  })

  test('genuine scp-form git@github.com:anthropics URL passes', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'git@github.com:anthropics/claude-code.git',
      }),
    ).toBeNull()
  })

  test('ssh://git@ssh.github.com/anthropics passes (official `qs` accepts ssh.github.com)', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'ssh://git@ssh.github.com/anthropics/claude-code.git',
      }),
    ).toBeNull()
  })

  test('host casing is normalized (official `UNn` lowercases)', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://GitHub.com/Anthropics/claude-code.git',
      }),
    ).toBeNull()
  })

  test('REGRESSION M3: substring smuggling via attacker path is refused', () => {
    // Old substring check `includes('github.com/anthropics/')` accepted this.
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://evil.example/github.com/anthropics/x.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('REGRESSION M3: scp-form with slash before the colon is refused', () => {
    // Official UNn: the segment before the first ':' must not contain '/'.
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'evil.example/github.com:anthropics/x.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('lookalike host github.com.evil.example is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://github.com.evil.example/anthropics/x.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('userinfo smuggling https://github.com@evil.example/ is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://github.com@evil.example/anthropics/x.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('path traversal out of the org (anthropics/../evil) is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://github.com/anthropics/../evil/x.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('non-github host with the org path is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'git',
        url: 'https://gitlab.com/anthropics/claude-code.git',
      }),
    ).toBe(refusalFor(RESERVED))
  })
})

describe('validateOfficialNameSource — github source (official `EVe` github branch)', () => {
  test('anthropics repo shorthand passes (Ctn normalizes owner/repo)', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'anthropics/claude-code',
      }),
    ).toBeNull()
  })

  test('mixed-case repo shorthand passes (UNn lowercases)', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'Anthropics/claude-code',
      }),
    ).toBeNull()
  })

  test('other org is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'evil/anthropics-clone',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('repo containing a colon is refused (official `r.includes(":")`)', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'anthropics/x:evil',
      }),
    ).toBe(refusalFor(RESERVED))
  })

  test('missing repo is refused', () => {
    expect(
      validateOfficialNameSource(RESERVED, { source: 'github' }),
    ).toBe(refusalFor(RESERVED))
  })
})

describe('validateOfficialNameSource — scope', () => {
  test('non-reserved names are never validated', () => {
    expect(
      validateOfficialNameSource('my-company-plugins', {
        source: 'git',
        url: 'https://evil.example/github.com/anthropics/x.git',
      }),
    ).toBeNull()
  })

  test('other source types on reserved names get the organization refusal', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'url',
        url: 'https://github.com/anthropics/x/raw/main/marketplace.json',
      }),
    ).toBe(
      `The name '${RESERVED}' is reserved for official Anthropic marketplaces and can only be used with GitHub sources from the '${OFFICIAL_GITHUB_ORG}' organization.`,
    )
  })
})

// ---------------------------------------------------------------------------
// M1: cache-only readers must apply the same admission gates as the
// throwing paths. CLAUDE_CONFIG_DIR is redirected BEFORE the module graph
// loads (getClaudeConfigHomeDir memoizes off it — installFromNpm275 pattern).
// ---------------------------------------------------------------------------

const tempRoots: string[] = []
function makeTempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = makeTempDirSync('occ-sec-followups-')
process.env.CLAUDE_CONFIG_DIR = configDir

const { getMarketplaceCacheOnly, getPluginByIdCacheOnly } = await import(
  '../marketplaceManager.js'
)
const { getPluginsDirectory } = await import('../pluginDirectories.js')

const pluginsDir = getPluginsDirectory()
const knownFile = join(pluginsDir, 'known_marketplaces.json')

function writeKnownMarketplaces(config: Record<string, unknown>): void {
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(knownFile, JSON.stringify(config), 'utf-8')
}

function writeMarketplaceCache(
  installLocation: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(join(installLocation, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(installLocation, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(manifest),
    'utf-8',
  )
}

const lastUpdated = '2026-09-23T00:00:00.000Z'

afterAll(() => {
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('getMarketplaceCacheOnly — trusted-entry admission (official `qte` gate)', () => {
  test('legitimate non-reserved entry resolves from cache', async () => {
    const install = join(pluginsDir, 'marketplaces', 'my-plugins')
    writeMarketplaceCache(install, {
      name: 'my-plugins',
      owner: { name: 't' },
      plugins: [{ name: 'hello', source: './hello', strict: false }],
    })
    writeKnownMarketplaces({
      'my-plugins': {
        source: { source: 'github', repo: 'someorg/my-plugins' },
        installLocation: install,
        lastUpdated,
      },
    })
    const marketplace = await getMarketplaceCacheOnly('my-plugins')
    expect(marketplace).not.toBeNull()
    expect(marketplace?.name).toBe('my-plugins')
  })

  test('REGRESSION M1: reserved name registered from an untrusted git URL is refused (was served by bare jsonParse)', async () => {
    const install = join(pluginsDir, 'marketplaces', 'evil-anthropic')
    writeMarketplaceCache(install, {
      name: 'anthropic-marketplace',
      owner: { name: 't' },
      plugins: [{ name: 'backdoor', source: './backdoor', strict: false }],
    })
    writeKnownMarketplaces({
      'anthropic-marketplace': {
        // Substring-smuggled URL — exactly the M3 bypass, planted on disk.
        source: {
          source: 'git',
          url: 'https://evil.example/github.com/anthropics/x.git',
        },
        installLocation: install,
        lastUpdated,
      },
    })
    expect(await getMarketplaceCacheOnly('anthropic-marketplace')).toBeNull()
  })

  test('REGRESSION M1: imitation reserved-name entry is filtered out by the loader', async () => {
    const install = join(pluginsDir, 'marketplaces', 'imitation')
    writeMarketplaceCache(install, {
      name: 'my-plugins',
      owner: { name: 't' },
      plugins: [],
    })
    writeKnownMarketplaces({
      // 'agent.skills' slugifies to the reserved name 'agent-skills' —
      // loadKnownMarketplacesConfig drops it (official `Hse`/`Wjt`).
      'agent.skills': {
        source: { source: 'github', repo: 'evil/agent-skills' },
        installLocation: install,
        lastUpdated,
      },
    })
    expect(await getMarketplaceCacheOnly('agent.skills')).toBeNull()
  })

  test('reserved name from the official org passes the gate', async () => {
    const install = join(pluginsDir, 'marketplaces', 'official')
    writeMarketplaceCache(install, {
      name: 'anthropic-marketplace',
      owner: { name: 'Anthropic' },
      plugins: [],
    })
    writeKnownMarketplaces({
      'anthropic-marketplace': {
        source: { source: 'github', repo: 'anthropics/claude-code' },
        installLocation: install,
        lastUpdated,
      },
    })
    const marketplace = await getMarketplaceCacheOnly('anthropic-marketplace')
    expect(marketplace).not.toBeNull()
    expect(marketplace?.name).toBe('anthropic-marketplace')
  })

  test('corrupted config degrades to null without throwing', async () => {
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(knownFile, '{not json', 'utf-8')
    expect(await getMarketplaceCacheOnly('my-plugins')).toBeNull()
  })
})

describe('getPluginByIdCacheOnly — same gates on the plugin fast path', () => {
  test('legitimate plugin resolves through the gated marketplace read', async () => {
    const install = join(pluginsDir, 'marketplaces', 'my-plugins')
    writeMarketplaceCache(install, {
      name: 'my-plugins',
      owner: { name: 't' },
      plugins: [{ name: 'hello', source: './hello', strict: false }],
    })
    writeKnownMarketplaces({
      'my-plugins': {
        source: { source: 'github', repo: 'someorg/my-plugins' },
        installLocation: install,
        lastUpdated,
      },
    })
    const result = await getPluginByIdCacheOnly('hello@my-plugins')
    expect(result).not.toBeNull()
    expect(result?.entry.name).toBe('hello')
    expect(result?.marketplaceInstallLocation).toBe(install)
  })

  test('REGRESSION M1: plugin under an untrusted reserved-name marketplace is refused', async () => {
    const install = join(pluginsDir, 'marketplaces', 'evil-anthropic2')
    writeMarketplaceCache(install, {
      name: 'claude-plugins-official',
      owner: { name: 't' },
      plugins: [{ name: 'backdoor', source: './backdoor', strict: false }],
    })
    writeKnownMarketplaces({
      'claude-plugins-official': {
        source: { source: 'git', url: 'https://evil.example/x.git' },
        installLocation: install,
        lastUpdated,
      },
    })
    expect(
      await getPluginByIdCacheOnly('backdoor@claude-plugins-official'),
    ).toBeNull()
  })
})
