import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join, resolve } from 'path'

/**
 * CC 2.1.304 #9 — sandbox denyRead glob crash backport.
 *
 * Official changelog 304 #9: "Fixed sandbox setup failing when a denyRead
 * path contains brackets that spell no set of characters (e.g. `[user-id]`)".
 * The vendored sandbox-runtime@0.0.44 glob engine (`globToRegex` replace-chain
 * + an UNGUARDED `new RegExp(...)` in `expandGlobPattern`) turns `[user-id]`
 * into a regex with the backwards range `r-i` → `new RegExp` throws
 * "Range out of order in character class" → the whole Linux sandbox startup
 * aborts. Official sandbox-runtime 0.0.80 replaced the engine with an AST
 * tokenizer whose `setRanges` validation demotes any bracket group that
 * spells no set of characters (empty, or backwards range) to LITERAL TEXT and
 * warns: `[Sandbox] The brackets in ${...} spell no set of characters, so
 * they are read as text: ${pattern}`.
 *
 * OCC backports the 0.0.80 semantics into 0.0.44 via the existing bun patch
 * (patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch): a
 * `spellsCharacterSet` validator + placeholder-based demotion in
 * `globToRegex`, and the `new RegExp` construction moved inside
 * `expandGlobPattern`'s try/catch (invalid pattern → skip + warn, never a
 * throw). These tests import the REAL patched file from node_modules and
 * guard against a dependency bump (or `bun install` without
 * patchedDependencies) silently reverting the fix.
 */

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const DEP_FILE = join(
  REPO_ROOT,
  'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js',
)
const PATCH_FILE = join(
  REPO_ROOT,
  'patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch',
)

const { globToRegex, expandGlobPattern } = (await import(
  DEP_FILE
)) as typeof import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js')

describe('2.1.304 #9 — patched dependency + patch-file guards (anti-revert)', () => {
  test('installed dependency contains the backported validator and demotion', () => {
    // Arrange
    const source = readFileSync(DEP_FILE, 'utf8')

    // Act & Assert: both halves of the backport are present in node_modules
    expect(source).toContain('function spellsCharacterSet(body)')
    expect(source).toContain('__LITERAL_SET_')
    // Official 0.0.80 warn text (adapted to the 0.0.44 single-body shape)
    expect(source).toContain(
      'spell no set of characters, so they are read as text',
    )
  })

  test('installed dependency constructs the glob regex INSIDE the try/catch', () => {
    // Arrange
    const source = readFileSync(DEP_FILE, 'utf8')

    // Act
    const tryIndex = source.indexOf('const results = [];')
    const regexIndex = source.indexOf(
      'const regex = new RegExp(globToRegex(normalizedPattern));',
    )
    const readdirIndex = source.indexOf('fs.readdirSync(baseDir', regexIndex)

    // Assert: `new RegExp` sits after `const results = []` (the try-block
    // opener in expandGlobPattern) and before the readdir it guards
    expect(tryIndex).toBeGreaterThan(-1)
    expect(regexIndex).toBeGreaterThan(tryIndex)
    expect(readdirIndex).toBeGreaterThan(regexIndex)
  })

  test('patch file carries BOTH the glob fix and the pre-existing zsh socat trap fix', () => {
    // Arrange
    const patch = readFileSync(PATCH_FILE, 'utf8')

    // Act & Assert
    expect(patch).toContain('spellsCharacterSet')
    expect(patch).toContain('spell no set of characters, so they are read as text')
    expect(patch).toContain('dist/sandbox/sandbox-utils.js')
    // 2.1.276 ITEM K hunk must not be clobbered by the regeneration
    expect(patch).toContain("rc=$?; kill %1 %2 2>/dev/null; exit $rc")
    expect(patch).toContain('dist/sandbox/linux-sandbox-utils.js')
  })

  test('patch is still registered in package.json', () => {
    // Arrange
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { patchedDependencies?: Record<string, string> }

    // Act
    const entry = pkg.patchedDependencies?.['@anthropic-ai/sandbox-runtime@0.0.44']

    // Assert
    expect(entry).toBeDefined()
    expect(existsSync(join(REPO_ROOT, entry ?? ''))).toBe(true)
  })
})

describe('2.1.304 #9 — globToRegex bracket demotion (official 0.0.80 setRanges semantics)', () => {
  test('the field-report crash case `[user-id]` no longer throws and matches literally', () => {
    // Arrange — pre-patch this construction threw
    // "Invalid regular expression: Range out of order in character class"
    // Act
    const build = () => new RegExp(globToRegex('/data/[user-id]/.env'))

    // Assert
    expect(build).not.toThrow()
    const re = build()
    expect(re.test('/data/[user-id]/.env')).toBe(true)
    // The demoted group is literal text, NOT a character class
    expect(re.test('/data/u/.env')).toBe(false)
    expect(re.test('/data/user-id/.env')).toBe(false)
  })

  test('valid character sets still compile to real classes', () => {
    // Arrange & Act
    const re = new RegExp(globToRegex('/data/[0-9]/x.txt'))

    // Assert
    expect(re.source).toContain('[0-9]')
    expect(re.test('/data/3/x.txt')).toBe(true)
    expect(re.test('/data/a/x.txt')).toBe(false)
  })

  test('empty bracket group `[]` is demoted to literal text', () => {
    // Arrange & Act
    const re = new RegExp(globToRegex('/x/[]/y'))

    // Assert
    expect(re.test('/x/[]/y')).toBe(true)
  })

  test('glob meta inside a demoted group stays literal (no [^/]* rewrite)', () => {
    // Arrange — `[a-*]` is a backwards-range-free but invalid set shape
    // (`*` after `-` with nothing following is parsed as literal `*` in
    // regex classes, but the official tokenizer treats star-in-set as no
    // set); either way the demoted rendering must not gain a wildcard.
    // Act
    const re = new RegExp(globToRegex('/x/[a-*]/y'))

    // Assert
    expect(re.test('/x/[a-*]/y')).toBe(true)
    expect(re.test('/x/azz/y')).toBe(false)
  })

  test('forward ranges and multi-member sets are untouched', () => {
    // Arrange & Act
    const range = new RegExp(globToRegex('/x/[a-z]/y'))
    const multi = new RegExp(globToRegex('/x/[abc]/y'))

    // Assert
    expect(range.test('/x/q/y')).toBe(true)
    expect(range.test('/x/Q/y')).toBe(false)
    expect(multi.test('/x/b/y')).toBe(true)
    expect(multi.test('/x/d/y')).toBe(false)
  })

  test('trailing-hyphen set `[a-]` stays a valid class (hyphen is literal)', () => {
    // Arrange & Act
    const re = new RegExp(globToRegex('/x/[a-]/y'))

    // Assert: regex treats a trailing `-` inside a class as literal
    expect(re.test('/x/a/y')).toBe(true)
    expect(re.test('/x/-/y')).toBe(true)
  })

  test('unclosed bracket still gets escaped (pre-existing behavior preserved)', () => {
    // Arrange & Act
    const build = () => new RegExp(globToRegex('/x/[abc'))

    // Assert
    expect(build).not.toThrow()
    expect(build().test('/x/[abc')).toBe(true)
  })

  test('globstar and star semantics are unaffected by the patch', () => {
    // Arrange & Act
    const globstar = new RegExp(globToRegex('/home/u/**/.env'))
    const star = new RegExp(globToRegex('/home/u/*.txt'))

    // Assert
    expect(globstar.test('/home/u/a/b/.env')).toBe(true)
    expect(globstar.test('/home/u/.env')).toBe(true)
    expect(star.test('/home/u/x.txt')).toBe(true)
    expect(star.test('/home/u/a/x.txt')).toBe(false)
  })
})

describe('2.1.304 #9 — expandGlobPattern degrades to skip, never throws', () => {
  test('nonexistent base dir with a bracket pattern returns [] (no throw)', () => {
    // Arrange & Act
    const act = () =>
      expandGlobPattern('/nonexistent-occ-fixture-dir/[user-id]/*.txt')

    // Assert
    expect(act).not.toThrow()
    expect(act()).toEqual([])
  })

  test('literal-bracketed directory under a real base dir expands to its files', () => {
    // Arrange — a temp dir literally named `[user-id]` (the official 0.0.80
    // outcome: the brackets-as-text rule MATCHES the literal directory)
    const tmpRoot = join(
      Bun.env.TMPDIR ?? '/tmp',
      `occ-glob-304-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    const bracketDir = join(tmpRoot, '[user-id]')
    mkdirSync(bracketDir, { recursive: true })
    writeFileSync(join(bracketDir, 'secret.txt'), 'x', 'utf8')
    writeFileSync(join(bracketDir, 'notes.md'), 'x', 'utf8')

    try {
      // Act
      const matched = expandGlobPattern(join(tmpRoot, '[user-id]/*.txt'))

      // Assert — no throw, and the literal-bracket dir's .txt file matched
      expect(matched).toEqual([join(bracketDir, 'secret.txt')])
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
