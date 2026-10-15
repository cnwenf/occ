import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileSuffixForOauthConfig } from '../../constants/oauth.js'
import {
  _getConfigForTesting,
  _setGlobalConfigCacheForTesting,
  _wouldLoseAuthStateForTesting,
} from '../config.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { cleanupZeroByteConfigResidue } from '../Shell.js'

/**
 * PORT (CC 2.1.299, gap entry #039): empty config-dir `.config.json` residue
 * must not wipe sign-in / MCP / trust state.
 *
 * Mechanism: on Linux the bwrap sandbox deny-write list includes every
 * settings/config path; for paths that do not exist on the host,
 * sandbox-runtime mounts /dev/null over them, which pre-creates a 0-byte
 * stub file that survives the command. A 0-byte `<configDir>/.config.json`
 * stub then (pre-fix) made getGlobalClaudeFile pick the stub over the legacy
 * `.claude.json`, and getConfig parsed '' as corrupted JSON → defaults →
 * the next save wrote defaults over the real auth state.
 *
 * Official v299 byte-exact references (linux-x64 ELF):
 *   - prompt text @107002052: "0-byte placeholder files, such as `.mcp.json`
 *     and `.claude/settings.json` ... A 0-byte one belongs to the sandbox:
 *     do not stage, commit, move or delete it. ... One with content is the
 *     user's file."
 *   - doctor diagnostic @228225896: "0-byte read-only file where a settings
 *     file belongs makes \"Yes, and don't ask again\" fail to save, and the
 *     sandbox binds it read-only again on every start" (fix = `rm <path>`).
 *
 * Fix under test:
 *   (a) env.ts getGlobalClaudeFile — a 0-byte `.config.json` counts as
 *       ABSENT: falls through to the legacy `.claude${suffix}.json` path;
 *   (b) config.ts getConfig — a 0-byte file returns createDefault() with NO
 *       corrupted-file machinery (no stderr warning, no .corrupted backup,
 *       no tengu_config_parse_error); non-empty corrupt content is unchanged;
 *   (c) Shell.ts cleanupZeroByteConfigResidue — post-sandbox-command removal
 *       of 0-byte stubs at the config-dir bind points; files with content
 *       are never touched.
 *
 * wouldLoseAuthState contract: unchanged — a 0-byte file yields the exact
 * same defaults an absent (ENOENT) file yields, so the save-side guard sees
 * the same `fresh` input as the pre-existing missing-file path.
 *
 * Test architecture follows managedReadDenial285.test.ts: zero mock.module,
 * zero top-level env mutation; CLAUDE_CONFIG_DIR window per test; lodash
 * memoize caches cleared around every test. NODE_ENV stays 'test' (bun
 * default) so the configReadingAllowed guard is bypassed.
 */

const ENV_KEYS = ['CLAUDE_CONFIG_DIR'] as const

let savedEnv: Record<string, string | undefined> = {}
let testRoot = ''
let configDir = ''

const legacyName = `.claude${fileSuffixForOauthConfig()}.json`

const clearPathCaches = (): void => {
  ;(getGlobalClaudeFile as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    getClaudeConfigHomeDir as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

const originalStderrWrite = process.stderr.write
let stderrChunks: string[] = []

const installStderrSpy = (): void => {
  stderrChunks = []
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
}

const restoreStderr = (): void => {
  process.stderr.write = originalStderrWrite
}

const stderrText = (): string => stderrChunks.join('')

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-zerobyte-299-'))
})

beforeEach(() => {
  configDir = mkdtempSync(join(testRoot, 'config-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  clearPathCaches()
  installStderrSpy()
})

afterEach(() => {
  restoreStderr()
  clearPathCaches()
  _setGlobalConfigCacheForTesting(null)
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  clearPathCaches()
  rmSync(testRoot, { recursive: true, force: true })
})

describe('getGlobalClaudeFile — 0-byte .config.json counts as absent', () => {
  test('0-byte .config.json + valid legacy file → legacy path wins (sign-in state preserved)', () => {
    writeFileSync(join(configDir, '.config.json'), '', 'utf8')
    const legacyPath = join(configDir, legacyName)
    writeFileSync(legacyPath, '{"oauthAccount":{"emailAddress":"a@b.c"}}', 'utf8')
    expect(getGlobalClaudeFile()).toBe(legacyPath)
  })

  test('non-empty .config.json still wins (unchanged behavior)', () => {
    writeFileSync(join(configDir, '.config.json'), '{"a":1}', 'utf8')
    expect(getGlobalClaudeFile()).toBe(join(configDir, '.config.json'))
  })

  test('0-byte .config.json with no legacy file → legacy path returned (stub treated as absent)', () => {
    writeFileSync(join(configDir, '.config.json'), '', 'utf8')
    expect(getGlobalClaudeFile()).toBe(join(configDir, legacyName))
  })
})

describe('getConfig — 0-byte file is absent, not corrupt', () => {
  const makeDefault = (): { sentinel: string } => ({ sentinel: 'default' })

  test('0-byte file → defaults with NO corrupted-file machinery (no stderr, no .corrupted backup)', () => {
    const file = join(configDir, 'zero.json')
    writeFileSync(file, '', 'utf8')
    const result = _getConfigForTesting(file, makeDefault)
    expect(result).toEqual({ sentinel: 'default' })
    expect(stderrText()).not.toContain('is corrupted')
    const backupsDir = join(configDir, 'backups')
    const corruptedBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter(name => name.includes('.corrupted.'))
      : []
    expect(corruptedBackups).toEqual([])
  })

  test('non-empty corrupt content still goes through the corrupted path (unchanged)', () => {
    const file = join(configDir, 'bad.json')
    writeFileSync(file, '{not valid json', 'utf8')
    const result = _getConfigForTesting(file, makeDefault)
    expect(result).toEqual({ sentinel: 'default' })
    expect(stderrText()).toContain('is corrupted')
  })

  test('0-byte and absent (ENOENT) files yield identical defaults — wouldLoseAuthState input contract unchanged', () => {
    const zeroFile = join(configDir, 'zero.json')
    writeFileSync(zeroFile, '', 'utf8')
    const zeroResult = _getConfigForTesting(zeroFile, makeDefault)
    const missingResult = _getConfigForTesting(
      join(configDir, 'missing.json'),
      makeDefault,
    )
    expect(zeroResult).toEqual(missingResult)
  })
})

describe('wouldLoseAuthState — unchanged contract', () => {
  test('cached oauthAccount + fresh defaults → true (the GH #3117 guard still fires)', () => {
    _setGlobalConfigCacheForTesting({
      oauthAccount: { emailAddress: 'a@b.c' },
      hasCompletedOnboarding: true,
    } as never)
    expect(_wouldLoseAuthStateForTesting({})).toBe(true)
  })

  test('fresh config retaining oauthAccount → false', () => {
    _setGlobalConfigCacheForTesting({
      oauthAccount: { emailAddress: 'a@b.c' },
    } as never)
    expect(
      _wouldLoseAuthStateForTesting({
        oauthAccount: { emailAddress: 'a@b.c' },
        hasCompletedOnboarding: true,
      }),
    ).toBe(false)
  })

  test('empty cache → false', () => {
    _setGlobalConfigCacheForTesting(null)
    expect(_wouldLoseAuthStateForTesting({})).toBe(false)
  })
})

describe('cleanupZeroByteConfigResidue — post-command stub removal (Shell.ts)', () => {
  test('removes 0-byte stubs at both config-dir bind points', () => {
    const stub = join(configDir, '.config.json')
    const legacyStub = join(configDir, legacyName)
    writeFileSync(stub, '', 'utf8')
    writeFileSync(legacyStub, '', 'utf8')
    cleanupZeroByteConfigResidue()
    expect(existsSync(stub)).toBe(false)
    expect(existsSync(legacyStub)).toBe(false)
  })

  test('files with content are the user’s files — never touched', () => {
    const real = join(configDir, '.config.json')
    const legacyReal = join(configDir, legacyName)
    writeFileSync(real, '{"a":1}', 'utf8')
    writeFileSync(legacyReal, '{"oauthAccount":{}}', 'utf8')
    cleanupZeroByteConfigResidue()
    expect(existsSync(real)).toBe(true)
    expect(existsSync(legacyReal)).toBe(true)
  })

  test('mixed: 0-byte stub removed, real legacy file kept; absent paths are a no-op', () => {
    const stub = join(configDir, '.config.json')
    const legacyReal = join(configDir, legacyName)
    writeFileSync(stub, '', 'utf8')
    writeFileSync(legacyReal, '{"oauthAccount":{}}', 'utf8')
    cleanupZeroByteConfigResidue()
    expect(existsSync(stub)).toBe(false)
    expect(existsSync(legacyReal)).toBe(true)
    // Second call with nothing present must not throw.
    expect(() => cleanupZeroByteConfigResidue()).not.toThrow()
  })
})
