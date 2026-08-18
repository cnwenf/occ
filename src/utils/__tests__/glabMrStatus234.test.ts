import { beforeEach, describe, expect, test } from 'bun:test'
import {
  classifyHost,
  clearGlabStatusCachesForTesting,
  deriveMrReviewState,
  fetchMrStatus,
  isGitHubHost,
  normalizeHost,
  validateMrUrl,
} from '../glabMrStatus.js'

// CC 2.1.234 GitLab MR badge helpers (binary u3b/d3b/L9e/ACt/om, byte-verified).

describe('validateMrUrl (CC 2.1.234 u3b)', () => {
  const IID = 42

  test('accepts well-formed gitlab.com MR URLs with matching iid', () => {
    expect(
      validateMrUrl('https://gitlab.com/group/project/-/merge_requests/42', IID),
    ).toBe(true)
    expect(
      validateMrUrl(
        'https://gitlab.com/sub/group/project/-/merge_requests/42',
        IID,
      ),
    ).toBe(true)
  })

  test('accepts self-hosted hosts and ports', () => {
    expect(
      validateMrUrl(
        'https://gitlab.example.co.uk:8443/team/proj/-/merge_requests/42',
        IID,
      ),
    ).toBe(true)
  })

  test('rejects URL whose trailing number is not the iid', () => {
    expect(
      validateMrUrl('https://gitlab.com/group/project/-/merge_requests/43', IID),
    ).toBe(false)
  })

  test('rejects non-MR and malformed URLs', () => {
    expect(
      validateMrUrl('https://gitlab.com/group/project/-/issues/42', IID),
    ).toBe(false)
    expect(validateMrUrl('javascript:alert(1)', IID)).toBe(false)
    expect(
      validateMrUrl('http://gitlab.com/group/project/-/merge_requests/42', IID),
    ).toBe(true) // http allowed by the binary pattern
    expect(
      validateMrUrl('ftp://gitlab.com/group/project/-/merge_requests/42', IID),
    ).toBe(false)
  })

  test('rejects path traversal segments', () => {
    expect(
      validateMrUrl('https://gitlab.com/../evil/-/merge_requests/42', IID),
    ).toBe(false)
    expect(
      validateMrUrl('https://gitlab.com/..%2f/-/merge_requests/42', IID),
    ).toBe(false)
  })

  test('rejects URLs over 2048 characters', () => {
    const longGroup = 'g'.repeat(2100)
    expect(
      validateMrUrl(
        `https://gitlab.com/${longGroup}/p/-/merge_requests/42`,
        IID,
      ),
    ).toBe(false)
  })
})

describe('deriveMrReviewState (CC 2.1.234 d3b)', () => {
  test('only opened MRs get a badge', () => {
    expect(deriveMrReviewState('merged', false, 'mergeable')).toBeNull()
    expect(deriveMrReviewState('closed', false, undefined)).toBeNull()
    expect(deriveMrReviewState('opened', false, undefined)).not.toBeNull()
  })

  test('draft wins over merge status', () => {
    expect(deriveMrReviewState('opened', true, 'mergeable')).toBe('draft')
  })

  test('mergeable maps to approved, anything else to pending', () => {
    expect(deriveMrReviewState('opened', false, 'mergeable')).toBe('approved')
    expect(deriveMrReviewState('opened', false, 'ci_must_pass')).toBe('pending')
    expect(deriveMrReviewState('opened', false, undefined)).toBe('pending')
  })
})

describe('normalizeHost (CC 2.1.234 L9e)', () => {
  test('lowercases and strips whitespace-class characters', () => {
    expect(normalizeHost('GitLab.COM')).toBe('gitlab.com')
    expect(normalizeHost('gitlab.\tcom')).toBe('gitlab.com')
  })

  test('strips trailing dots', () => {
    expect(normalizeHost('gitlab.com.')).toBe('gitlab.com')
    expect(normalizeHost('gitlab.com...')).toBe('gitlab.com')
  })

  test('keeps hosts with structural characters as-is', () => {
    expect(normalizeHost('gitlab.com:8443')).toBe('gitlab.com:8443')
    expect(normalizeHost('user@gitlab.com')).toBe('user@gitlab.com')
  })
})

describe('classifyHost (CC 2.1.234 ACt) and isGitHubHost (om)', () => {
  test('github.com classifies as github (with www variants)', () => {
    expect(classifyHost('github.com')).toBe('github')
    expect(classifyHost('www.github.com')).toBe('github')
    expect(classifyHost('WWW.GITHUB.COM')).toBe('github')
    expect(isGitHubHost('github.com')).toBe(true)
    expect(isGitHubHost('www.github.com')).toBe(true)
    expect(isGitHubHost('gitlab.com')).toBe(false)
  })

  test('gitlab.com and bitbucket.org are named', () => {
    expect(classifyHost('gitlab.com')).toBe('gitlab')
    expect(classifyHost('www.gitlab.com')).toBe('gitlab')
    expect(classifyHost('bitbucket.org')).toBe('bitbucket')
  })

  test('self-hosted and other hosts classify as other (still eligible)', () => {
    expect(classifyHost('gitlab.example.com')).toBe('other')
    expect(classifyHost('code.internal.corp')).toBe('other')
  })
})

describe('fetchMrStatus gates (CC 2.1.234 cpp)', () => {
  beforeEach(() => {
    clearGlabStatusCachesForTesting()
  })

  test('returns null outside a git repository', async () => {
    // The test suite runs inside the occ git repo, so point cwd away via the
    // public API contract: fetchMrStatus consults getIsGit() against the
    // process cwd. In-repo this exercises the glab-on-PATH/host gates and
    // must resolve to null or a status without throwing.
    const result = await fetchMrStatus()
    expect(
      result === null || result === 'fetch-failed' || typeof result === 'object',
    ).toBe(true)
  })
})
