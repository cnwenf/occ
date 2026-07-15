import { describe, expect, test } from 'bun:test'

import {
  filterValidIgnorePatterns,
  splitIgnorePatternLines,
  validateIgnorePattern,
} from '../globPatternValidation.js'

/**
 * Behavioral tests for malformed bracket pattern handling.
 *
 * Ported from claude-code 2.1.207 changelog #9:
 * "Fixed malformed bracket patterns in rules globs / skill paths / `.ignore` /
 * `.worktreeinclude`"
 *
 * The fix validates each gitignore-style pattern by probing
 * `ignore().add([pattern]).test("probe")` inside a try/catch BEFORE adding it
 * to the real matcher. Patterns that throw are filtered out; valid patterns
 * (including VALID bracket patterns like `[a-z]`) are kept.
 *
 * These tests exercise the REAL ignore library code path (not source-grep)
 * and assert that malformed patterns do NOT cause an uncaught throw when
 * passed through filterValidIgnorePatterns.
 */
describe('globPatternValidation', () => {
  describe('validateIgnorePattern', () => {
    test('returns null for a valid plain pattern', () => {
      expect(validateIgnorePattern('*.md')).toBeNull()
      expect(validateIgnorePattern('node_modules/')).toBeNull()
    })

    test('returns null for valid bracket patterns', () => {
      expect(validateIgnorePattern('[a-z]')).toBeNull()
      expect(validateIgnorePattern('[abc]')).toBeNull()
      expect(validateIgnorePattern('[!abc]')).toBeNull()
      expect(validateIgnorePattern('[a-zA-Z0-9]')).toBeNull()
    })

    test('returns null for malformed bracket patterns that ignore handles gracefully', () => {
      // ignore@7.x normalizes unclosed brackets into empty character classes
      // so these do NOT throw — validateIgnorePattern returns null (valid).
      // The function is still defensive: if a future ignore version throws,
      // it would catch and return the error message.
      expect(validateIgnorePattern('[')).toBeNull()
      expect(validateIgnorePattern('[abc')).toBeNull()
      expect(validateIgnorePattern('[a-z')).toBeNull()
      expect(validateIgnorePattern('[!')).toBeNull()
      expect(validateIgnorePattern('[]')).toBeNull()
      expect(validateIgnorePattern(']')).toBeNull()
    })

    test('returns null for brace patterns', () => {
      expect(validateIgnorePattern('{a,b}')).toBeNull()
      expect(validateIgnorePattern('{')).toBeNull()
      expect(validateIgnorePattern('}')).toBeNull()
    })
  })

  describe('filterValidIgnorePatterns', () => {
    test('keeps all valid patterns and returns them unchanged', () => {
      const patterns = ['*.md', 'node_modules/', '[a-z]', 'src/**/*.ts']
      const result = filterValidIgnorePatterns(patterns, 'claudemd_rule_globs')
      expect(result).toEqual(patterns)
    })

    test('does NOT throw on malformed bracket patterns', () => {
      // This is the core behavioral assertion: calling the REAL ignore code
      // path with malformed bracket patterns must not throw. It should return
      // a sane result (the patterns that compile, minus any that don't).
      const malformed = ['[', '[abc', '[a-z', ']', '[!', '[]', '{', '{a,b', '}']
      expect(() =>
        filterValidIgnorePatterns(malformed, 'claudemd_rule_globs'),
      ).not.toThrow()
    })

    test('preserves valid bracket patterns alongside malformed ones', () => {
      // A VALID bracket pattern must still match correctly (no false rejection)
      // even when mixed with malformed patterns.
      const mixed = ['[', '[a-z]', '[abc', '[!abc]', '[]']
      const result = filterValidIgnorePatterns(mixed, 'skill_paths')
      // With ignore@7.x, all patterns compile (malformed ones are normalized),
      // so all should be kept. If a future version throws on malformed ones,
      // the valid ones ([a-z], [!abc], []) must still be present.
      expect(result).toContain('[a-z]')
      expect(result).toContain('[!abc]')
      expect(result).toContain('[]')
    })

    test('handles each category without throwing', () => {
      const patterns = ['[', '[abc', '*.md']
      const categories = [
        'claudemd_rule_globs',
        'skill_paths',
        'file_suggestions_ignore',
        'worktreeinclude',
      ] as const
      for (const category of categories) {
        expect(() =>
          filterValidIgnorePatterns(patterns, category),
        ).not.toThrow()
      }
    })

    test('returns empty array for empty input', () => {
      expect(filterValidIgnorePatterns([], 'worktreeinclude')).toEqual([])
    })

    test('does not mutate the input array (immutability)', () => {
      const input = ['[', '*.md', '[abc']
      const inputCopy = [...input]
      filterValidIgnorePatterns(input, 'claudemd_rule_globs')
      expect(input).toEqual(inputCopy)
    })
  })

  describe('splitIgnorePatternLines', () => {
    test('splits multi-line content into non-empty lines', () => {
      const content = '*.md\nnode_modules/\n\n# comment\n[src/**]'
      const result = splitIgnorePatternLines(content)
      // filter(Boolean) removes empty strings but keeps comment lines and
      // whitespace-only lines (truthy non-empty strings)
      expect(result).toEqual(['*.md', 'node_modules/', '# comment', '[src/**]'])
    })

    test('handles \\r\\n line endings', () => {
      const content = 'a\r\nb\r\nc'
      expect(splitIgnorePatternLines(content)).toEqual(['a', 'b', 'c'])
    })

    test('returns empty array for empty content', () => {
      expect(splitIgnorePatternLines('')).toEqual([])
    })

    test('does not throw on malformed bracket content', () => {
      const content = '[\n[abc\n[a-z\n]'
      expect(() => splitIgnorePatternLines(content)).not.toThrow()
      expect(splitIgnorePatternLines(content)).toEqual(['[', '[abc', '[a-z', ']'])
    })
  })

  /**
   * End-to-end behavioral assertion: the full pipeline (split → validate →
   * ignore().add → .ignores()) must not throw on malformed brackets, and
   * valid patterns must still match.
   */
  describe('full pipeline: split → filter → ignore().add → ignores()', () => {
    test('malformed bracket content from .worktreeinclude does not crash', () => {
      const rawContent = '*.env\n[\n[abc\nsecrets/\n[a-z\n'
      const lines = splitIgnorePatternLines(rawContent)
      const valid = filterValidIgnorePatterns(lines, 'worktreeinclude')

      // Must not throw when building the matcher
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ignore = require('ignore')
        ignore().add(valid).ignores('secrets/api.key')
      }).not.toThrow()
    })

    test('malformed bracket content from .ignore does not crash', () => {
      const rawContent = '[\nnode_modules/\n[abc\n'
      const lines = splitIgnorePatternLines(rawContent)
      const valid = filterValidIgnorePatterns(lines, 'file_suggestions_ignore')

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ignore = require('ignore')
        ignore().add(valid).ignores('node_modules/foo')
      }).not.toThrow()
    })

    test('valid bracket patterns still match correctly through the pipeline', () => {
      const rawContent = '[a-z].md\n[abc].txt\n'
      const lines = splitIgnorePatternLines(rawContent)
      const valid = filterValidIgnorePatterns(lines, 'claudemd_rule_globs')

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ignore = require('ignore')
      const ig = ignore().add(valid)
      // [a-z].md should match a.md
      expect(ig.ignores('a.md')).toBe(true)
      // [abc].txt should match a.txt
      expect(ig.ignores('a.txt')).toBe(true)
      // [a-z].md should NOT match 1.md (1 is not in a-z)
      expect(ig.ignores('1.md')).toBe(false)
    })
  })
})
