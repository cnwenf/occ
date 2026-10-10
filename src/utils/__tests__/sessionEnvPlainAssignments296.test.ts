/**
 * CC 2.1.296 #036 — plain-assignment parser for the session environment
 * (official `A_t` map builder + `K8n` line regex + `V8n` quote unwrap,
 * ev-envfile296.txt; new in 2.1.296, verified 0 hits in 2.1.295).
 *
 * Contract under test (all official-verbatim):
 *  - every line must be a comment/blank or a plain assignment (optionally
 *    `export ` / `declare -x ` prefixed);
 *  - ANY non-matching line → debug log "Session environment is not all plain
 *    assignments" and an EMPTY Map — no partial application;
 *  - single-quoted values unwrap literally; double-quoted values unwrap with
 *    `\\([$\`"\\])` unescaping;
 *  - `$` and backtick are excluded from value character classes, so command
 *    substitutions / variable expansions make the whole script rejected.
 *
 * DEVIATION NOTE: the official has a Windows-only branch (value containing
 * `/` or `\` deletes the key). OCC's getSessionEnvironmentScript() already
 * returns null on Windows, so the branch is dead here and omitted.
 *
 * DEDICATED mock.module FILE (debug.js capture) — re-pinned in afterAll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Capture seam: logForDebugging (assert the official debug string) -------
const actualDebugModule = await import('../debug.js')
const capturedLogs: string[] = []
mock.module('../debug.js', () => ({
  ...(actualDebugModule as object),
  logForDebugging: (message: string) => {
    capturedLogs.push(message)
  },
}))

const {
  PLAIN_ASSIGNMENT_LINE_REGEX,
  getSessionEnvironmentMap,
  invalidateSessionEnvCache,
} = await import('../sessionEnvironment.js')

const configDir = await mkdtemp(join(tmpdir(), 'occ-session-env-296-'))
process.env.CLAUDE_CONFIG_DIR = configDir
const envFilePath = join(configDir, 'claude-env-file.sh')

afterAll(async () => {
  mock.module('../debug.js', () => actualDebugModule as object)
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  capturedLogs.length = 0
  delete process.env.CLAUDE_ENV_FILE
  invalidateSessionEnvCache()
})

afterEach(() => {
  delete process.env.CLAUDE_ENV_FILE
  invalidateSessionEnvCache()
})

/** Point CLAUDE_ENV_FILE at a temp file with the given script content. */
async function withEnvScript(content: string): Promise<void> {
  await writeFile(envFilePath, content, 'utf8')
  process.env.CLAUDE_ENV_FILE = envFilePath
  invalidateSessionEnvCache()
}

// ---------------------------------------------------------------------------
// K8n line regex — verbatim from the official binary
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #036: PLAIN_ASSIGNMENT_LINE_REGEX (official K8n)', () => {
  test('is the verbatim official regex', () => {
    // Assert — byte-identical to K8n in ev-envfile296.txt
    expect(PLAIN_ASSIGNMENT_LINE_REGEX.source).toBe(
      '^(?:\\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\\w*)=((?:[\\w@%+=:,./-]|\'[^\'\\0]*\'|"(?:[^"\\\\$`\\0]|\\\\[^\\0])*")*))$',
    )
  })

  test('matches comments and blank/whitespace-only lines without groups', () => {
    // Act
    const comment = PLAIN_ASSIGNMENT_LINE_REGEX.exec('# FOO=bar')
    const indented = PLAIN_ASSIGNMENT_LINE_REGEX.exec('   # c')
    const blank = PLAIN_ASSIGNMENT_LINE_REGEX.exec('   ')
    const empty = PLAIN_ASSIGNMENT_LINE_REGEX.exec('')

    // Assert — matched (not rejected) but key/value groups undefined → skipped
    for (const m of [comment, indented, blank, empty]) {
      expect(m).not.toBeNull()
      expect(m?.[1]).toBeUndefined()
      expect(m?.[2]).toBeUndefined()
    }
  })

  test('rejects shell constructs that are not plain assignments', () => {
    // Assert
    for (const line of [
      'source ./activate.sh',
      'FOO=$(whoami)',
      'FOO=`whoami`',
      'FOO="$HOME/bin"',
      'if [ -x /bin/true ]; then',
      'foo() { :; }',
      'FOO=bar baz',
      'eval "echo hi"',
      'export PATH=$PATH:/opt/bin',
    ]) {
      expect(PLAIN_ASSIGNMENT_LINE_REGEX.exec(line)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// A_t map builder — accepted forms
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #036: getSessionEnvironmentMap accepted lines', () => {
  test('parses plain assignments, export and declare -x prefixes', async () => {
    // Arrange
    await withEnvScript(
      [
        'FOO=bar',
        'export BAZ=qux',
        'export  MULTI_SPACE=ok',
        'declare -x DECLARED=yes',
        'EMPTY=',
      ].join('\n'),
    )

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('FOO')).toBe('bar')
    expect(map.get('BAZ')).toBe('qux')
    expect(map.get('MULTI_SPACE')).toBe('ok')
    expect(map.get('DECLARED')).toBe('yes')
    expect(map.get('EMPTY')).toBe('')
    expect(map.size).toBe(5)
  })

  test('skips comment and blank lines', async () => {
    // Arrange
    await withEnvScript(
      ['# leading comment', '', '   ', '\t# indented comment', 'FOO=bar'].join(
        '\n',
      ),
    )

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.size).toBe(1)
    expect(map.get('FOO')).toBe('bar')
  })

  test('tolerates trailing whitespace (per-line trimEnd)', async () => {
    // Arrange
    await withEnvScript('FOO=bar   \nBAZ=qux\t')

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('FOO')).toBe('bar')
    expect(map.get('BAZ')).toBe('qux')
  })

  test('accepts the unquoted value character class (paths, URLs, @%+=:,./-)', async () => {
    // Arrange
    await withEnvScript(
      [
        'PATH_LIKE=/usr/bin:/usr/local/bin',
        'URL=https://example.com/a.b-c/',
        'ODD=a@b%c+d=e,f.g/h-0_1',
      ].join('\n'),
    )

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('PATH_LIKE')).toBe('/usr/bin:/usr/local/bin')
    expect(map.get('URL')).toBe('https://example.com/a.b-c/')
    expect(map.get('ODD')).toBe('a@b%c+d=e,f.g/h-0_1')
  })

  test('unwraps single quotes literally (no unescaping inside)', async () => {
    // Arrange — single-quoted content is taken verbatim (backslash stays)
    await withEnvScript(
      ["SQ='hello world'", String.raw`LIT='a\"b$c'`].join('\n'),
    )

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('SQ')).toBe('hello world')
    expect(map.get('LIT')).toBe(String.raw`a\"b$c`)
  })

  test('unwraps double quotes with official unescape (\\$ \\` \\" \\\\)', async () => {
    // Arrange — official inner unescape: /\\([$\`"\\])/g → $1
    await withEnvScript(
      [
        String.raw`DQ="a\"b"`,
        String.raw`BS="a\\b"`,
        String.raw`DOLLAR="cost\$5"`,
        String.raw`TICK="a\`b"`,
      ].join('\n'),
    )

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('DQ')).toBe('a"b')
    expect(map.get('BS')).toBe('a\\b')
    expect(map.get('DOLLAR')).toBe('cost$5')
    expect(map.get('TICK')).toBe('a`b')
  })

  test('later assignments win (Map.set order)', async () => {
    // Arrange
    await withEnvScript('FOO=first\nexport FOO=second')

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.get('FOO')).toBe('second')
    expect(map.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// A_t map builder — all-or-nothing rejection
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #036: getSessionEnvironmentMap rejects non-plain scripts', () => {
  const badLines = [
    'source ./activate.sh',
    'FOO=$(whoami)',
    'FOO="$HOME/bin"',
    'if [ -x /bin/true ]; then',
    'foo() { :; }',
    'FOO=bar baz',
  ]

  for (const badLine of badLines) {
    test(`one bad line empties the whole map (no partial application): ${badLine}`, async () => {
      // Arrange — valid assignments BEFORE the bad line must not survive
      await withEnvScript(`GOOD=yes\nALSO_GOOD=1\n${badLine}\nAFTER=no`)

      // Act
      const map = await getSessionEnvironmentMap()

      // Assert — official debug string, verbatim
      expect(map.size).toBe(0)
      expect(capturedLogs).toContain(
        'Session environment is not all plain assignments',
      )
    })
  }

  test('an all-plain script logs nothing and applies everything', async () => {
    // Arrange
    await withEnvScript('GOOD=yes\n# c\nexport ALSO_GOOD=1')

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.size).toBe(2)
    expect(capturedLogs).not.toContain(
      'Session environment is not all plain assignments',
    )
  })

  test('no session env at all yields an empty map without the rejection log', async () => {
    // Arrange — no CLAUDE_ENV_FILE, empty session dir

    // Act
    const map = await getSessionEnvironmentMap()

    // Assert
    expect(map.size).toBe(0)
    expect(capturedLogs).not.toContain(
      'Session environment is not all plain assignments',
    )
  })
})
