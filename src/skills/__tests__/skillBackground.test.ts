import { expect, test, describe } from 'bun:test'
import { parseSkillFrontmatterFields } from '../loadSkillsDir.js'
import { shouldForkedSkillRunAsync } from '../../utils/forkedAgent.js'

/**
 * CC 2.1.218 #35: skills with `context: fork` run in the background by
 * default; opt out per skill with `background: false`. The `background`
 * frontmatter field is a boolean, only meaningful when `context: fork`.
 *
 * Binary-verified describes (s21218.txt):
 *   - "If true, the agent runs in the background by default."
 *   - "Agents run in the background by default; you will be notified when
 *      one completes. Set to background: false..."
 *   - "Only for `context: fork`. Forks run as background agents that report
 *      back as a task"
 *   - zod: `background` boolean frontmatter, `.optional().describe("Only for
 *      `context: fork`...")`
 */
describe('CC 2.1.218 #35 — skill `background` frontmatter', () => {
  describe('parseSkillFrontmatterFields', () => {
    test('fork skill with NO background field → background undefined (default background)', () => {
      const parsed = parseSkillFrontmatterFields(
        { context: 'fork' },
        'body',
        'my-skill',
      )
      expect(parsed.executionContext).toBe('fork')
      // background absent → undefined; downstream default-background logic
      // treats undefined as "run in background".
      expect(parsed.background).toBeUndefined()
    })

    test('background: false → parsed as boolean false (opt out of background)', () => {
      const parsed = parseSkillFrontmatterFields(
        { context: 'fork', background: false },
        'body',
        'my-skill',
      )
      expect(parsed.executionContext).toBe('fork')
      expect(parsed.background).toBe(false)
    })

    test('background: true → parsed as boolean true (explicit background)', () => {
      const parsed = parseSkillFrontmatterFields(
        { context: 'fork', background: true },
        'body',
        'my-skill',
      )
      expect(parsed.background).toBe(true)
    })

    test('background accepts YAML string "false" / "true" forms', () => {
      const falsy = parseSkillFrontmatterFields(
        { context: 'fork', background: 'false' },
        'body',
        'my-skill',
      )
      expect(falsy.background).toBe(false)

      const truthy = parseSkillFrontmatterFields(
        { context: 'fork', background: 'true' },
        'body',
        'my-skill',
      )
      expect(truthy.background).toBe(true)
    })

    test('invalid background value → undefined (degrades, does not throw)', () => {
      const parsed = parseSkillFrontmatterFields(
        // 'maybe' is genuinely invalid (not a #36 boolean token), so it
        // degrades to undefined. Note: 'yes'/'no'/'on'/'off'/'1'/'0' are now
        // VALID booleans per CC 2.1.218 #36 and must NOT be used here.
        { context: 'fork', background: 'maybe' },
        'body',
        'my-skill',
      )
      // Invalid values degrade to undefined (matching effort/shell patterns).
      expect(parsed.background).toBeUndefined()
    })

    test('background on a non-fork skill is still parsed (official: only meaningful when context: fork)', () => {
      // The field parses regardless; the dispatch helper ignores it when
      // context !== 'fork'. This matches the official describe "Only for
      // `context: fork`" — the schema accepts the field but it has no effect.
      const parsed = parseSkillFrontmatterFields(
        { background: true },
        'body',
        'my-skill',
      )
      expect(parsed.executionContext).toBeUndefined()
      expect(parsed.background).toBe(true)
    })
  })

  describe('shouldForkedSkillRunAsync — dispatch decision', () => {
    test('(a) fork + no background field → background by default (true)', () => {
      expect(
        shouldForkedSkillRunAsync({ context: 'fork', background: undefined }),
      ).toBe(true)
    })

    test('(b) fork + background: false → inline (false)', () => {
      expect(
        shouldForkedSkillRunAsync({ context: 'fork', background: false }),
      ).toBe(false)
    })

    test('fork + background: true → background (true)', () => {
      expect(
        shouldForkedSkillRunAsync({ context: 'fork', background: true }),
      ).toBe(true)
    })

    test('(c) non-fork skill + background: true → ignored (false)', () => {
      // background only applies when context: fork; on an inline skill it
      // has no effect — the skill expands inline.
      expect(
        shouldForkedSkillRunAsync({ context: 'inline', background: true }),
      ).toBe(false)
    })

    test('non-fork skill + no context + background: false → ignored (false)', () => {
      expect(
        shouldForkedSkillRunAsync({ context: undefined, background: false }),
      ).toBe(false)
    })
  })
})
