import { afterAll, describe, expect, test } from 'bun:test'

/**
 * claude-code 2.1.276 ITEM 4: `extractGitHubRepoFromGitUrl` is a port of the
 * official protocol-allowlist parser `yAn`@191030323. Every recognized git
 * address form for github.com / ssh.github.com must yield lowercased
 * `owner/repo`; `..` segments, non-GitHub hosts, non-allowlisted protocols and
 * smuggling tricks must yield null. The blocklist must catch the
 * `ssh://git@ssh.github.com/...` bypass that the old parser missed.
 *
 * Settings are mocked at the module boundary (spread-real) so the blocklist
 * can be pinned deterministically.
 */

// Mutable policy override consumed by the mocked settings module.
let policySettingsOverride: { blockedMarketplaces?: unknown[] } | null = null

const realSettingsPath = new URL(
  '../../../utils/settings/settings.js',
  import.meta.url,
).pathname
const realSettings = await import(realSettingsPath)
// Capture the original function VALUE and a snapshot of the namespace before
// mock.module patches live ESM bindings — otherwise the mock recurses into itself.
const realGetSettingsForSource = realSettings.getSettingsForSource
const realSettingsSnapshot = { ...realSettings }
const { mock } = await import('bun:test')
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

// Import AFTER the settings mock so marketplaceHelpers picks it up.
const {
  extractGitHubRepoFromGitUrl,
  normalizeSourceForComparison,
  areSourcesEquivalent,
  findMarketplaceNameForSource,
  isSourceInBlocklist,
} = await import('../marketplaceHelpers.js')

afterAll(() => {
  policySettingsOverride = null
})

describe('extractGitHubRepoFromGitUrl (official yAn@191030323 port)', () => {
  test('accepts every recognized git address form → owner/repo', () => {
    const accepted: Array<[string, string]> = [
      ['git@github.com:owner/repo.git', 'owner/repo'],
      ['git@github.com:owner/repo', 'owner/repo'],
      ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
      ['ssh://git@ssh.github.com/owner/repo.git', 'owner/repo'],
      ['ssh://git@ssh.github.com:443/owner/repo.git', 'owner/repo'],
      ['git+ssh://git@github.com/owner/repo.git', 'owner/repo'],
      ['git://github.com/owner/repo.git', 'owner/repo'],
      ['https://github.com/owner/repo.git', 'owner/repo'],
      ['http://github.com/owner/repo', 'owner/repo'],
      ['https://github.com/owner/repo/', 'owner/repo'],
      ['https://GitHub.com/Owner/Repo.git', 'owner/repo'],
      ['https://github.com/owner/repo.git?query=1', 'owner/repo'],
      ['https://github.com/owner/repo.git#frag', 'owner/repo'],
      ['git@ssh.github.com:owner/repo.git', 'owner/repo'],
    ]
    for (const [url, expected] of accepted) {
      expect(extractGitHubRepoFromGitUrl(url)).toBe(expected)
    }
  })

  test('rejects `..` and `.` path segments', () => {
    expect(extractGitHubRepoFromGitUrl('https://github.com/owner/../evil.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('git@github.com:owner/..')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('https://github.com/owner/repo/..')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('https://github.com/owner/.')).toBeNull()
  })

  test('returns null for non-GitHub hosts', () => {
    expect(extractGitHubRepoFromGitUrl('git@gitlab.com:owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('https://evil.com/owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('ssh://git@github.com.evil.com/owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('ssh://git@evilssh.github.com/owner/repo.git')).toBeNull()
  })

  test('returns null for non-allowlisted protocols and smuggling tricks', () => {
    expect(extractGitHubRepoFromGitUrl('ftp://github.com/owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('https://github.com\\@evil.com/owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('https://github.com%00.evil.com/owner/repo.git')).toBeNull()
    expect(extractGitHubRepoFromGitUrl('git@github.com:owner/repo.git:extra')).toBeNull()
  })

  test('normalizes ssh:// git sources to the github form (Uer@200224732)', () => {
    expect(
      normalizeSourceForComparison({
        source: 'git',
        url: 'ssh://git@ssh.github.com/owner/repo.git',
      }),
    ).toEqual({ source: 'github', repo: 'owner/repo' })
    expect(
      areSourcesEquivalent(
        { source: 'git', url: 'ssh://git@ssh.github.com/owner/repo.git' },
        { source: 'github', repo: 'owner/repo' },
      ),
    ).toBe(true)
  })

  test('findMarketplaceNameForSource matches across address forms (M1r@200224603)', () => {
    const config = {
      'my-market': {
        source: { source: 'github', repo: 'owner/repo' },
      },
    } as never
    expect(
      findMarketplaceNameForSource(config, {
        source: 'git',
        url: 'git@github.com:owner/repo.git',
      }),
    ).toBe('my-market')
  })
})

describe('blocklist catches the ssh:// bypass (2.1.276 ITEM 4)', () => {
  test('github blocklist entry blocks every equivalent git address form', () => {
    policySettingsOverride = {
      blockedMarketplaces: [{ source: 'github', repo: 'owner/repo' }],
    }
    try {
      // The bypass: ssh.github.com was not recognized by the old parser.
      expect(
        isSourceInBlocklist({
          source: 'git',
          url: 'ssh://git@ssh.github.com/owner/repo.git',
        }),
      ).toBe(true)
      expect(
        isSourceInBlocklist({
          source: 'git',
          url: 'git@github.com:owner/repo.git',
        }),
      ).toBe(true)
      expect(
        isSourceInBlocklist({
          source: 'git',
          url: 'https://github.com/owner/repo.git',
        }),
      ).toBe(true)
      expect(
        isSourceInBlocklist({ source: 'github', repo: 'owner/repo' }),
      ).toBe(true)
      // Unrelated repos stay unblocked.
      expect(
        isSourceInBlocklist({
          source: 'git',
          url: 'ssh://git@ssh.github.com/other/repo.git',
        }),
      ).toBe(false)
    } finally {
      policySettingsOverride = null
    }
  })
})
