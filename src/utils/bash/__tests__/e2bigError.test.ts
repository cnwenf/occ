import { describe, expect, test } from 'bun:test'
import { sep } from 'path'
import {
  formatE2BigError,
  isE2BIG,
  isWorktreeDenyPath,
} from '../e2bigError.js'

describe('isE2BIG', () => {
  test('returns true for an error with code E2BIG', () => {
    const error = Object.assign(new Error('argument list too long'), {
      code: 'E2BIG',
    })
    expect(isE2BIG(error)).toBe(true)
  })

  test('returns false for other error codes', () => {
    expect(
      isE2BIG(Object.assign(new Error('enoent'), { code: 'ENOENT' })),
    ).toBe(false)
  })

  test('returns false for non-objects and errors without a code', () => {
    expect(isE2BIG(null)).toBe(false)
    expect(isE2BIG('E2BIG')).toBe(false)
    expect(isE2BIG(new Error('no code'))).toBe(false)
  })
})

describe('isWorktreeDenyPath', () => {
  const wt = (file: string) =>
    `/repo/.git${sep}worktrees${sep}feature${sep}${file}`

  test('matches per-worktree git internal files', () => {
    expect(isWorktreeDenyPath(wt('config.worktree'))).toBe(true)
    expect(isWorktreeDenyPath(wt('config.worktree.lock'))).toBe(true)
    expect(isWorktreeDenyPath(wt('commondir'))).toBe(true)
  })

  test('rejects paths outside the worktrees segment', () => {
    // Same suffix but not under .../.git/worktrees/<name>/
    expect(isWorktreeDenyPath(`/repo/.git${sep}config.worktree`)).toBe(false)
    expect(isWorktreeDenyPath(`/repo/.git${sep}commondir`)).toBe(false)
  })

  test('rejects unrelated worktree paths', () => {
    expect(isWorktreeDenyPath(wt('HEAD'))).toBe(false)
    expect(isWorktreeDenyPath(wt('index'))).toBe(false)
    expect(isWorktreeDenyPath('/repo/.git/worktree-checkout/HEAD')).toBe(false)
  })
})

describe('formatE2BigError', () => {
  test('reports binary, arg count, and byte sizes', () => {
    const message = formatE2BigError({
      binary: '/bin/bash',
      argv: ['-c', 'echo hi'],
      env: { PATH: '/usr/bin' },
      sandboxDenyPaths: [],
    })
    expect(message).toContain('Could not start /bin/bash')
    expect(message).toContain('E2BIG')
    expect(message).toContain('across 3 args')
    expect(message).toContain('largest single arg')
    expect(message).toContain('environment')
    expect(message).toContain('vars')
    // No sandbox hint when there are no deny paths.
    expect(message).not.toContain('Bash sandbox profile')
  })

  test('appends the worktree remediation hint when deny paths include worktree files', () => {
    const denyPaths = [
      `/repo/.git${sep}worktrees${sep}a${sep}config.worktree`,
      `/repo/.git${sep}worktrees${sep}b${sep}commondir`,
      '/etc/some-other-deny',
    ]
    const message = formatE2BigError({
      binary: '/bin/bash',
      argv: ['-c', 'echo hi'],
      env: {},
      sandboxDenyPaths: denyPaths,
    })
    expect(message).toContain('adds 3 filesystem deny paths')
    expect(message).toContain('2 of them for registered git worktrees')
    expect(message).toContain('git worktree remove')
    expect(message).toContain('git worktree prune')
    expect(message).toContain('/sandbox')
  })

  test('appends a trailing period when deny paths have no worktree files', () => {
    const message = formatE2BigError({
      binary: '/bin/bash',
      argv: ['-c', 'x'],
      env: {},
      sandboxDenyPaths: ['/etc/deny1', '/etc/deny2'],
    })
    expect(message).toContain('adds 2 filesystem deny paths to every command.')
    expect(message).not.toContain('git worktree')
  })

  test('includes the largest env var when env is non-empty', () => {
    const huge = 'v'.repeat(4096)
    const message = formatE2BigError({
      binary: '/bin/bash',
      argv: ['-c', 'x'],
      env: { HUGE_VAR: huge, SMALL: 's' },
      sandboxDenyPaths: [],
    })
    expect(message).toContain('largest: HUGE_VAR at')
  })
})
