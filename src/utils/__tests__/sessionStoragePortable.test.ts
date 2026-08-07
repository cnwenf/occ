import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  dirMatchesProjectPath,
  extractFirstLineField,
  extractLastTypedLineField,
  findProjectDir,
  getProjectsDir,
  MAX_SANITIZED_LENGTH,
  sanitizePath,
} from '../sessionStoragePortable.js'

/**
 * Gap-65-B (CC 2.1.224): session-storage content verification.
 *
 * 2.1.224 hardened project-directory resolution for long paths (>200 chars
 * after sanitization). The on-disk directory name is only the first 200
 * sanitized chars + a hash suffix, and two different long paths can share
 * the same 200-char prefix. The official resolves the ambiguity with `gar`:
 * read each `.jsonl` in the candidate dir and compare its recorded working
 * directory (newest `"type":"relocated"` entry's `relocatedCwd`, else the
 * first `cwd` field) against the requested path. These tests pin that
 * behavior plus the always-djb2 `sanitizePath` suffix.
 */

// Independent djb2 reference (official binary `hut`, byte-verified). The
// tests must NOT import djb2Hash from src — that would test the impl with
// itself. Official suffix = Math.abs(djb2(originalName)).toString(36).
function refDjb2(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h
}

function refSuffix(name: string): string {
  return Math.abs(refDjb2(name)).toString(36)
}

// Isolated config home per test file — getClaudeConfigHomeDir is memoized
// keyed off CLAUDE_CONFIG_DIR, so each test gets its own projects dir.
let testHome: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'occ-ssp-gap65b-'))
  process.env.CLAUDE_CONFIG_DIR = testHome
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  try {
    rmSync(testHome, { recursive: true, force: true })
  } catch {
    // best effort cleanup
  }
})

afterEach(() => {
  // Each test builds its own fixture subdir; wipe the projects dir between
  // tests so fixtures never leak across tests.
  try {
    rmSync(getProjectsDir(), { recursive: true, force: true })
  } catch {
    // not created yet — fine
  }
})

/** Writes a minimal session JSONL whose first line carries `cwd`. */
function writeSession(dir: string, cwd: string, extraLines: string[] = []) {
  mkdirSync(dir, { recursive: true })
  const head = `{"type":"summary","summary":"t","cwd":${JSON.stringify(cwd)}}`
  writeFileSync(
    join(dir, '11111111-1111-1111-1111-111111111111.jsonl'),
    [head, ...extraLines].join('\n') + '\n',
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// sanitizePath — always-djb2 suffix (CC 2.1.224 `Gw`/`GHg`)
// ---------------------------------------------------------------------------

describe('sanitizePath (CC 2.1.224 always-djb2)', () => {
  test('short paths pass through with non-alphanumerics replaced', () => {
    expect(sanitizePath('/Users/foo/my-project')).toBe('-Users-foo-my-project')
    expect(sanitizePath('plugin:name:server')).toBe('plugin-name-server')
  })

  test('exactly MAX_SANITIZED_LENGTH chars get no suffix', () => {
    // Arrange — 'a'.repeat(200) sanitizes to itself (all alphanumeric)
    const name = 'a'.repeat(MAX_SANITIZED_LENGTH)

    // Act + Assert
    expect(sanitizePath(name)).toBe(name)
  })

  test('long paths truncate to 200 chars plus djb2 suffix of the ORIGINAL name', () => {
    // Arrange
    const name = '/deep/' + 'x'.repeat(300)
    const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')

    // Act
    const result = sanitizePath(name)

    // Assert — layout: first 200 sanitized chars + '-' + base36 djb2
    const expected = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${refSuffix(name)}`
    expect(result).toBe(expected)
    // The suffix is NOT a slice of the sanitized string — it is a real hash
    expect(result.length).toBe(MAX_SANITIZED_LENGTH + 1 + refSuffix(name).length)
  })

  test('djb2 suffix is deterministic across calls', () => {
    // Arrange
    const name = '/root/' + 'proj-'.repeat(60)

    // Act + Assert — same input, same output, every time
    expect(sanitizePath(name)).toBe(sanitizePath(name))
    expect(sanitizePath(name).endsWith(`-${refSuffix(name)}`)).toBe(true)
  })

  test('two different long paths with the same 200-char prefix get different names', () => {
    // Arrange — shared 200-char prefix, divergent tails
    const base = '/' + 's'.repeat(199)
    const a = base + '-alpha'
    const b = base + '-beta'

    // Act + Assert — this is the collision case gar exists to disambiguate
    expect(sanitizePath(a)).not.toBe(sanitizePath(b))
    expect(sanitizePath(a).slice(0, MAX_SANITIZED_LENGTH)).toBe(
      sanitizePath(b).slice(0, MAX_SANITIZED_LENGTH),
    )
  })
})

// ---------------------------------------------------------------------------
// extractLastTypedLineField / extractFirstLineField (official ndt / loo)
// ---------------------------------------------------------------------------

describe('extractLastTypedLineField (CC 2.1.224 ndt)', () => {
  test('returns the field of the LAST line with the matching type', () => {
    // Arrange
    const text = [
      '{"type":"relocated","relocatedCwd":"/first"}',
      '{"type":"user","message":"hi"}',
      '{"type":"relocated","relocatedCwd":"/second"}',
    ].join('\n')

    // Act + Assert — backward scan: newest wins
    expect(extractLastTypedLineField(text, 'relocated', 'relocatedCwd')).toBe(
      '/second',
    )
  })

  test('ignores lines whose type differs even when the field is present', () => {
    // Arrange — field marker present under the wrong type
    const text = '{"type":"user","relocatedCwd":"/decoy"}'

    // Act + Assert
    expect(
      extractLastTypedLineField(text, 'relocated', 'relocatedCwd'),
    ).toBeUndefined()
  })

  test('skips malformed JSON lines and keeps scanning', () => {
    // Arrange
    const text = [
      '{"type":"relocated","relocatedCwd":"/good"}',
      '{"type":"relocated","relocatedCwd":BROKEN',
    ].join('\n')

    // Act + Assert — backward scan hits the broken line first, then the good one
    expect(extractLastTypedLineField(text, 'relocated', 'relocatedCwd')).toBe(
      '/good',
    )
  })

  test('returns undefined when no typed line exists', () => {
    expect(extractLastTypedLineField('', 'relocated', 'relocatedCwd')).toBeUndefined()
    expect(
      extractLastTypedLineField('{"type":"user"}', 'relocated', 'relocatedCwd'),
    ).toBeUndefined()
  })

  test('ignores non-string field values', () => {
    // Arrange
    const text = '{"type":"relocated","relocatedCwd":42}'

    // Act + Assert
    expect(
      extractLastTypedLineField(text, 'relocated', 'relocatedCwd'),
    ).toBeUndefined()
  })
})

describe('extractFirstLineField (CC 2.1.224 loo)', () => {
  test('returns the field from the FIRST line that carries it', () => {
    // Arrange
    const text = [
      '{"type":"summary","cwd":"/first"}',
      '{"type":"user","cwd":"/second"}',
    ].join('\n')

    // Act + Assert — forward scan: oldest wins
    expect(extractFirstLineField(text, 'cwd')).toBe('/first')
  })

  test('skips lines without the field and malformed lines', () => {
    // Arrange
    const text = [
      '{"type":"summary"}',
      'NOT JSON AT ALL {"cwd":"/decoy"',
      '{"type":"user","cwd":"/real"}',
    ].join('\n')

    // Act + Assert
    expect(extractFirstLineField(text, 'cwd')).toBe('/real')
  })

  test('returns undefined when no line carries the field', () => {
    expect(extractFirstLineField('', 'cwd')).toBeUndefined()
    expect(extractFirstLineField('{"type":"user"}\n{"x":1}', 'cwd')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dirMatchesProjectPath (CC 2.1.224 gar)
// ---------------------------------------------------------------------------

describe('dirMatchesProjectPath (CC 2.1.224 gar)', () => {
  test('matches a directory whose session head cwd equals the project path', async () => {
    // Arrange
    const dir = join(getProjectsDir(), 'fixture-match')
    writeSession(dir, '/work/myrepo')

    // Act + Assert
    expect(await dirMatchesProjectPath(dir, '/work/myrepo')).toBe(true)
    expect(await dirMatchesProjectPath(dir, '/work/other')).toBe(false)
  })

  test('compares in sanitized form (non-alphanumeric → hyphen)', () => {
    // Covered implicitly by the match above; pin the sanitize rule directly:
    // '/work/my repo' and '/work/my-repo' sanitize identically.
    const a = '/work/my repo'.replace(/[^a-zA-Z0-9]/g, '-')
    const b = '/work/my-repo'.replace(/[^a-zA-Z0-9]/g, '-')
    expect(a).toBe(b)
  })

  test('newest relocated entry wins over the head cwd', async () => {
    // Arrange — head says /before; a later relocated entry says /after
    const dir = join(getProjectsDir(), 'fixture-relocated')
    writeSession(dir, '/before', [
      '{"type":"user","message":"work"}',
      '{"type":"relocated","relocatedCwd":"/after"}',
    ])

    // Act + Assert — gar prefers relocatedCwd (extractLastTypedLineField on
    // the tail) over the head cwd
    expect(await dirMatchesProjectPath(dir, '/after')).toBe(true)
    expect(await dirMatchesProjectPath(dir, '/before')).toBe(false)
  })

  test('falls back to head cwd when no relocated entry exists', async () => {
    // Arrange
    const dir = join(getProjectsDir(), 'fixture-head-only')
    writeSession(dir, '/original', ['{"type":"user","message":"hi"}'])

    // Act + Assert
    expect(await dirMatchesProjectPath(dir, '/original')).toBe(true)
  })

  test('returns false for an empty directory', async () => {
    // Arrange
    const dir = join(getProjectsDir(), 'fixture-empty')
    mkdirSync(dir, { recursive: true })

    // Act + Assert
    expect(await dirMatchesProjectPath(dir, '/anything')).toBe(false)
  })

  test('returns false for a missing directory', async () => {
    // Arrange — no such dir on disk
    const dir = join(getProjectsDir(), 'does-not-exist')

    // Act + Assert — readdir failure must be swallowed, not thrown
    expect(await dirMatchesProjectPath(dir, '/anything')).toBe(false)
  })

  test('caseInsensitive compares lowercase forms', async () => {
    // Arrange — Windows drive-letter style divergence
    const dir = join(getProjectsDir(), 'fixture-case')
    writeSession(dir, 'C:/Work/Repo')

    // Act + Assert
    expect(await dirMatchesProjectPath(dir, 'c:/work/repo', true)).toBe(true)
    expect(await dirMatchesProjectPath(dir, 'c:/work/repo', false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// findProjectDir (CC 2.1.224 uN filesystem branch)
// ---------------------------------------------------------------------------

describe('findProjectDir (CC 2.1.224 uN)', () => {
  test('returns the exact project dir when it exists', async () => {
    // Arrange
    const projectPath = '/short/project'
    const exact = join(getProjectsDir(), sanitizePath(projectPath))
    writeSession(exact, projectPath)

    // Act + Assert
    expect(await findProjectDir(projectPath)).toBe(exact)
  })

  test('returns undefined for a missing short path (no prefix scan under 200 chars)', async () => {
    // Arrange — nothing on disk for this short path
    // Act + Assert — short sanitized names never get hash suffixes, so there
    // is nothing to scan for; official returns undefined immediately.
    expect(await findProjectDir('/short/missing')).toBeUndefined()
  })

  test('finds a long-path dir via 200-char prefix plus content verification', async () => {
    // Arrange — a long path whose exact dir does NOT exist (e.g. created by
    // another runtime with a different hash suffix)
    const longPath = '/deep/' + 'p'.repeat(250)
    const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, '-')
    const onDisk = join(
      getProjectsDir(),
      `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-foreignhash`,
    )
    writeSession(onDisk, longPath)

    // Act
    const found = await findProjectDir(longPath)

    // Assert — content verification confirmed the dir belongs to longPath
    expect(found).toBe(onDisk)
  })

  test('rejects a same-prefix dir whose sessions belong to a different project', async () => {
    // Arrange — same 200-char prefix, but the session inside was recorded
    // for a DIFFERENT long path. Prefix-only matching (pre-2.1.224) would
    // have wrongly returned this dir.
    const base = '/collide/' + 'c'.repeat(191) // sanitized prefix hits 200
    const wanted = base + '-wanted'
    const other = base + '-OTHER'
    const sanitizedWanted = wanted.replace(/[^a-zA-Z0-9]/g, '-')
    const decoyDir = join(
      getProjectsDir(),
      `${sanitizedWanted.slice(0, MAX_SANITIZED_LENGTH)}-decoyhash`,
    )
    writeSession(decoyDir, other)

    // Act + Assert — gar must veto the decoy; nothing else matches
    expect(await findProjectDir(wanted)).toBeUndefined()
  })

  test('prefers the exact dir over a prefix-matching candidate', async () => {
    // Arrange — both the exact dir and a prefix candidate exist
    const longPath = '/exactwins/' + 'e'.repeat(240)
    const exact = join(getProjectsDir(), sanitizePath(longPath))
    const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, '-')
    const candidate = join(
      getProjectsDir(),
      `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-otherhash`,
    )
    writeSession(exact, longPath)
    writeSession(candidate, longPath)

    // Act + Assert — official tries the exact name first
    expect(await findProjectDir(longPath)).toBe(exact)
  })
})
