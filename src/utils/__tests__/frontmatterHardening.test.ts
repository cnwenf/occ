import { describe, expect, test } from 'bun:test'
import {
  parseBooleanFrontmatter,
  splitPathInFrontmatter,
} from '../frontmatterParser'
import {
  getParseError,
  parseAgentFromMarkdown,
} from '../../tools/AgentTool/loadAgentsDir'

/**
 * CC 2.1.218 #34 / #36 / 2.1.217 #13 — frontmatter hardening alignment slice.
 * Strings reverse-engineered from the official 2.1.217/2.1.218 ELF.
 *
 *   #34 — agent `name` containing `:` (reserved for plugin namespacing) is
 *          rejected with: Invalid "name": names must not contain ":" (reserved
 *          for plugin namespacing)
 *   #36 — skill/plugin frontmatter booleans accept yes/no/on/off/1/0
 *          (case-insensitive) in addition to true/false; invalid →
 *          "<value>" must be a boolean
 *   217#13 — a CLAUDE.md/SKILL.md `paths` frontmatter value with many brace
 *          groups is budget-bounded; exceeding 65536 expansions throws:
 *          Too many brace expansions (<count> > 65536)
 */

describe('CC 2.1.218 #34: agent name must not contain ":"', () => {
  const verbatim =
    'Invalid "name": names must not contain ":" (reserved for plugin namespacing)'

  test('an agent whose frontmatter name is "foo:bar" fails to load', () => {
    const agent = parseAgentFromMarkdown(
      '/agents/foo.md',
      '/agents',
      { name: 'foo:bar', description: 'd' },
      'body',
      'userSettings',
    )
    expect(agent).toBeNull()
  })

  test('getParseError returns the verbatim message for a colon name', () => {
    const msg = getParseError({ name: 'foo:bar', description: 'd' })
    expect(msg).toBe(verbatim)
  })

  test('a name without ":" loads fine', () => {
    const agent = parseAgentFromMarkdown(
      '/agents/researcher.md',
      '/agents',
      { name: 'researcher', description: 'does research' },
      'system prompt body',
      'userSettings',
    )
    expect(agent).not.toBeNull()
    expect(agent?.agentType).toBe('researcher')
  })

  test('NFKC-normalized colon (fullwidth ":") is also rejected', () => {
    // U+FF1A FULLWIDTH COLON normalizes (NFKC) to ASCII ':'
    const agent = parseAgentFromMarkdown(
      '/agents/foo.md',
      '/agents',
      { name: 'foo：bar', description: 'd' },
      'body',
      'userSettings',
    )
    expect(agent).toBeNull()
  })
})

describe('CC 2.1.218 #36: frontmatter booleans accept yes/no/on/off/1/0', () => {
  test.each([
    ['yes', true],
    ['YES', true],
    ['Yes', true],
    ['on', true],
    ['ON', true],
    ['1', true],
    ['true', true],
    ['True', true],
    [true, true],
    ['no', false],
    ['NO', false],
    ['off', false],
    ['OFF', false],
    ['0', false],
    ['false', false],
    ['False', false],
    [false, false],
  ])('parseBooleanFrontmatter(%j) === %s', (input, expected) => {
    expect(parseBooleanFrontmatter(input)).toBe(expected)
  })

  test('absent (undefined) is false, not an error', () => {
    expect(parseBooleanFrontmatter(undefined)).toBe(false)
  })

  test('an invalid value errors with a "must be a boolean" message', () => {
    expect(() => parseBooleanFrontmatter('maybe')).toThrow(/must be a boolean/)
  })

  test('a non-string non-boolean value errors', () => {
    expect(() => parseBooleanFrontmatter(42)).toThrow(/must be a boolean/)
  })
})

describe('CC 2.1.217 #13: brace expansion budget-bound', () => {
  test('a paths value with >65536 expansions throws the cap', () => {
    // 17 groups of {a,b} → 2^17 = 131072 > 65536 expansions.
    const pattern = Array.from({ length: 17 }, () => '{a,b}').join('/')
    expect(() => splitPathInFrontmatter(pattern)).toThrow(
      /Too many brace expansions \(.*> 65536\)/,
    )
  })

  test('a single brace group with >65536 alternatives throws the cap', () => {
    const alts = Array.from({ length: 65537 }, () => 'a').join(',')
    expect(() => splitPathInFrontmatter(`{${alts}}`)).toThrow(
      /Too many brace expansions \(.*> 65536\)/,
    )
  })

  test('does not hang on a pathological nested pattern', () => {
    // 30 groups would be 2^30 ≈ 1B expansions unbounded; the cap must abort.
    const pattern = Array.from({ length: 30 }, () => '{a,b}').join('/')
    const start = Date.now()
    expect(() => splitPathInFrontmatter(pattern)).toThrow()
    const elapsed = Date.now() - start
    // Must complete near-instantly, not stall/OOM.
    expect(elapsed).toBeLessThan(5000)
  })

  test('a normal brace pattern still expands', () => {
    expect(splitPathInFrontmatter('src/*.{ts,tsx}')).toEqual([
      'src/*.ts',
      'src/*.tsx',
    ])
  })

  test('exactly 65536 expansions does not throw', () => {
    // 65536 alternatives → exactly the cap (>, not >=).
    const alts = Array.from({ length: 65536 }, (_, i) => `a${i}`).join(',')
    const result = splitPathInFrontmatter(`{${alts}}`)
    expect(result).toHaveLength(65536)
  })
})
