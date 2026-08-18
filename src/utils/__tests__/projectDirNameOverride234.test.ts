import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearProjectDirNameOverrideCacheForTesting,
  getProjectDirName,
  getProjectDirNameOverride,
  sanitizePath,
  validateProjectDirName,
} from '../sessionStoragePortable.js'

// CC 2.1.234 CLAUDE_CODE_PROJECT_DIR_NAME override (binary yws/w8c/sN,
// byte-verified).

describe('validateProjectDirName (CC 2.1.234 yws)', () => {
  test('returns valid names unchanged', () => {
    expect(validateProjectDirName('my-project')).toBe('my-project')
    expect(validateProjectDirName('Project_123')).toBe('Project_123')
    expect(validateProjectDirName('a')).toBe('a')
    expect(validateProjectDirName('x'.repeat(64))).toBe('x'.repeat(64))
  })

  test('rejects undefined and empty', () => {
    expect(validateProjectDirName(undefined)).toBeUndefined()
    expect(validateProjectDirName('')).toBeUndefined()
  })

  test('rejects names outside the [A-Za-z0-9_-]{1,64} pattern', () => {
    expect(validateProjectDirName('has space')).toBeUndefined()
    expect(validateProjectDirName('has/slash')).toBeUndefined()
    expect(validateProjectDirName('has.dot')).toBeUndefined()
    expect(validateProjectDirName('has..dots')).toBeUndefined()
    expect(validateProjectDirName('../escape')).toBeUndefined()
    expect(validateProjectDirName('emoji-😀')).toBeUndefined()
    expect(validateProjectDirName('x'.repeat(65))).toBeUndefined()
  })

  test('rejects Windows reserved device names case-insensitively', () => {
    for (const name of [
      'con',
      'CON',
      'prn',
      'aux',
      'nul',
      'com1',
      'COM9',
      'lpt0',
      'LPT3',
    ]) {
      expect(validateProjectDirName(name)).toBeUndefined()
    }
  })

  test('accepts reserved-name lookalikes with extra characters', () => {
    expect(validateProjectDirName('con1')).toBe('con1')
    expect(validateProjectDirName('console')).toBe('console')
    expect(validateProjectDirName('my-con')).toBe('my-con')
    expect(validateProjectDirName('com10')).toBe('com10')
  })
})

describe('getProjectDirNameOverride (CC 2.1.234 w8c)', () => {
  beforeEach(() => {
    clearProjectDirNameOverrideCacheForTesting()
  })

  test('returns undefined when CLAUDE_CONFIG_DIR is not set', () => {
    expect(
      getProjectDirNameOverride({
        CLAUDE_CODE_PROJECT_DIR_NAME: 'my-project',
      }),
    ).toBeUndefined()
  })

  test('returns the override when CLAUDE_CONFIG_DIR is set and name is valid', () => {
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/custom-config',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'my-project',
      }),
    ).toBe('my-project')
  })

  test('returns undefined for an invalid override name even with CLAUDE_CONFIG_DIR', () => {
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/custom-config',
        CLAUDE_CODE_PROJECT_DIR_NAME: '../bad',
      }),
    ).toBeUndefined()
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/custom-config',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'con',
      }),
    ).toBeUndefined()
  })

  test('re-evaluates when the env values change (cache key includes both)', () => {
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/a',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'first',
      }),
    ).toBe('first')
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/a',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'second',
      }),
    ).toBe('second')
    expect(
      getProjectDirNameOverride({
        CLAUDE_CONFIG_DIR: '/tmp/b',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'first',
      }),
    ).toBe('first')
  })

  test('caches results per key (repeated call returns the same value)', () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/tmp/a',
      CLAUDE_CODE_PROJECT_DIR_NAME: 'cached',
    }
    expect(getProjectDirNameOverride(env)).toBe('cached')
    expect(getProjectDirNameOverride(env)).toBe('cached')
  })
})

describe('getProjectDirName (CC 2.1.234 sN)', () => {
  beforeEach(() => {
    clearProjectDirNameOverrideCacheForTesting()
  })

  test('falls back to sanitizePath when no override is active', () => {
    const dir = '/home/user/my project'
    expect(getProjectDirName(dir, {})).toBe(sanitizePath(dir))
    expect(getProjectDirName(dir, { CLAUDE_CODE_PROJECT_DIR_NAME: 'x' })).toBe(
      sanitizePath(dir),
    )
  })

  test('uses the override when active', () => {
    expect(
      getProjectDirName('/home/user/my project', {
        CLAUDE_CONFIG_DIR: '/tmp/cfg',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'pinned-name',
      }),
    ).toBe('pinned-name')
  })
})
