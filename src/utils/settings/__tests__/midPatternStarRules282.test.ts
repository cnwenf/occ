import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionBehavior } from '../../../types/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
} from '../../permissions/shellRuleMatching.js'
import { validatePermissionRuleValue } from '../../permissions/permissionRuleParser.js'
import { filterInvalidPermissionRules } from '../validation.js'
import { validatePermissionRule } from '../permissionValidation.js'

/**
 * 2.1.282 — "Fixed Bash permission rules with a mid-pattern `:*` being
 * skipped in settings files while `--allowedTools` honored them; they now
 * work from every source, with a startup warning on how they match."
 *
 * Ported from the official 2.1.282 rule validator (binary `$ge`, helpers
 * `Nge`/`eVn`/`wo`): the old 2.1.281 rejection ("The :* pattern must be at
 * the end") is GONE from the official binary (string occurs 0x in 2.1.282).
 * Mid-pattern `:*` rules are valid and only warn; trailing-`:*` rules whose
 * prefix itself contains an unescaped `*` take the "mixes" branch. All
 * warning/error strings below are byte-matched to the 2.1.282 binary.
 */

/** Repo root — src/utils/settings/__tests__ is four levels below it. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const MID_PATTERN_LEAD =
  'Bash(npm run:*build) has a :* that is not at the end, so it is matched as a * wildcard (the : is literal), not as the trailing :* prefix syntax.'
const MID_ALLOW_ADVICE = 'Replace that :* with the exact value you mean.'
const MID_OTHER_ADVICE =
  'It already matches as a * wildcard; moving :* to the end would make it a literal prefix and change which commands match.'
const MIXES_LEAD =
  'mixes * with the trailing :* prefix syntax, so it is matched as a literal prefix (the * is not expanded)'

const REMOVED_REJECTION = 'The :* pattern must be at the end'

describe('2.1.282 — mid-pattern :* is valid with a startup warning', () => {
  test('allow rule warns with the byte-exact "replace the :*" advice', () => {
    const result = validatePermissionRule('Bash(npm run:*build)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `${MID_PATTERN_LEAD} ${MID_ALLOW_ADVICE}`,
    )
  })

  test('deny/ask/undefined behaviors warn with the byte-exact "already matches" advice', () => {
    const behaviors: (PermissionBehavior | undefined)[] = [
      'deny',
      'ask',
      undefined,
    ]
    for (const behavior of behaviors) {
      const result = validatePermissionRule('Bash(npm run:*build)', behavior)
      expect(result.valid).toBe(true)
      expect(result.warning).toBe(`${MID_PATTERN_LEAD} ${MID_OTHER_ADVICE}`)
    }
  })

  test('multiple mid colons (Bash(npm:*:install)) warn the same way', () => {
    const result = validatePermissionRule('Bash(npm:*:install)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.warning).toBe(
      'Bash(npm:*:install) has a :* that is not at the end, so it is matched as a * wildcard (the : is literal), not as the trailing :* prefix syntax. Replace that :* with the exact value you mean.',
    )
  })

  test('parameter rules like Bash(git:*push) are valid + warned (skipped at startup, not rejected)', () => {
    const result = validatePermissionRule('Bash(git:*push)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      'Bash(git:*push) has a :* that is not at the end, so it is matched as a * wildcard (the : is literal), not as the trailing :* prefix syntax. It already matches as a * wildcard; moving :* to the end would make it a literal prefix and change which commands match.',
    )
  })
})

describe('2.1.282 — mixes * with the trailing :* prefix syntax', () => {
  test('Bash(npm *:*) allow: literal * advice, byte-exact', () => {
    const result = validatePermissionRule('Bash(npm *:*)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `Bash(npm *:*) ${MIXES_LEAD} and matches only commands containing a literal * at that position. Replace that * with the exact value you mean.`,
    )
  })

  test('Bash(npm *:*) deny: suggests Bash(npm *), byte-exact', () => {
    const result = validatePermissionRule('Bash(npm *:*)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `Bash(npm *:*) ${MIXES_LEAD} and matches only commands containing a literal * at that position. Use Bash(npm *) for wildcard matching.`,
    )
  })

  test('Bash(npm *run:*) deny: "will likely never match" + suggestion, byte-exact', () => {
    const result = validatePermissionRule('Bash(npm *run:*)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `Bash(npm *run:*) ${MIXES_LEAD} and will likely never match. Use Bash(npm *run*) for wildcard matching.`,
    )
  })

  test('Bash(npm *run:*) allow: no suggestion clause (allow advice only)', () => {
    const result = validatePermissionRule('Bash(npm *run:*)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `Bash(npm *run:*) ${MIXES_LEAD} and will likely never match. Replace that * with the exact value you mean.`,
    )
  })

  test('mixes branch fires for every behavior (only the advice differs)', () => {
    for (const behavior of ['allow', 'deny', 'ask', undefined]) {
      const result = validatePermissionRule(
        'Bash(npm *:*)',
        behavior as PermissionBehavior | undefined,
      )
      expect(result.valid).toBe(true)
      expect(result.warning).toContain(MIXES_LEAD)
    }
  })

  test('trailing :* suppresses the mid-pattern branch (Bash(npm *run:*))', () => {
    // Ends with :* -> prefix branch, never the mid-pattern warning.
    const result = validatePermissionRule('Bash(npm *run:*)')
    expect(result.warning).not.toContain('has a :* that is not at the end')
  })
})

describe('2.1.282 — other Bash :* placements', () => {
  test('Bash(:*) stays invalid with the space-star examples', () => {
    const result = validatePermissionRule('Bash(:*)', 'allow')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Prefix cannot be empty before :*')
    expect(result.suggestion).toBe('Specify a command prefix before :*')
    expect(result.examples).toEqual(['Bash(npm *)', 'Bash(git *)'])
  })

  test('Bash(npm run:*) (trailing :*) is valid with no warning', () => {
    const result = validatePermissionRule('Bash(npm run:*)', 'allow')
    expect(result).toEqual({ valid: true })
    expect(result.warning).toBeUndefined()
  })

  test('escaped star in the prefix does not trigger the mixes warning', () => {
    const result = validatePermissionRule('Bash(npm \\*run:*)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('order: wildcard-before-subcommand allow warning wins over mid/mixes for Bash(npm * install:x)', () => {
    const result = validatePermissionRule('Bash(npm * install:x)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      'Bash(npm * install:x) has a wildcard before the rest of the command, so it also matches any options inserted at that position and approves them without a prompt. Replace that * with the exact value you mean, or only use * after the subcommand.',
    )
  })

  test('order: mixes branch precedes mid-pattern for Bash(npm * install:*)', () => {
    const result = validatePermissionRule('Bash(npm * install:*)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      `Bash(npm * install:*) ${MIXES_LEAD} and will likely never match. Replace that * with the exact value you mean.`,
    )
  })
})

describe('2.1.282 — "The :* pattern must be at the end" is produced nowhere', () => {
  const rules = [
    'Bash(npm:*:install)',
    'Bash(npm run:*build)',
    'Bash(git:*push)',
    'Bash(:*)',
    'Bash(npm *:*)',
    'Bash(npm *run:*)',
    'Bash(npm run:*)',
  ]
  const behaviors: (PermissionBehavior | undefined)[] = [
    undefined,
    'allow',
    'deny',
    'ask',
  ]

  test('no validator output contains the removed 2.1.281 rejection', () => {
    for (const rule of rules) {
      for (const behavior of behaviors) {
        const result = validatePermissionRule(rule, behavior)
        const haystack = [
          result.error,
          result.suggestion,
          result.warning,
          ...(result.examples ?? []),
        ]
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
        expect(haystack).not.toContain(REMOVED_REJECTION)
      }
    }
  })

  test('validatePermissionRuleValue no longer rejects mid-pattern :*', () => {
    const result = validatePermissionRuleValue({
      toolName: 'Bash',
      ruleContent: 'npm run:*build',
    })
    expect(result).toEqual({ valid: true })
  })

  test('source-grep: the removed rejection string is absent from both sources', () => {
    const validationSrc = readFileSync(
      `${REPO_ROOT}/src/utils/settings/permissionValidation.ts`,
      'utf8',
    )
    const parserSrc = readFileSync(
      `${REPO_ROOT}/src/utils/permissions/permissionRuleParser.ts`,
      'utf8',
    )
    expect(validationSrc).not.toContain(REMOVED_REJECTION)
    expect(parserSrc).not.toContain(REMOVED_REJECTION)
  })
})

describe('2.1.282 — filterInvalidPermissionRules keeps mid-pattern :*, drops Bash(:*)', () => {
  test('allow:["Bash(npm run:*build)","Bash(:*)"] keeps the first and skips the second', () => {
    const data = {
      permissions: {
        allow: ['Bash(npm run:*build)', 'Bash(:*)'],
      },
    }
    const warnings = filterInvalidPermissionRules(data, 'settings.json')
    expect(data.permissions.allow).toEqual(['Bash(npm run:*build)'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].file).toBe('settings.json')
    expect(warnings[0].path).toBe('permissions.allow')
    expect(warnings[0].invalidValue).toBe('Bash(:*)')
    expect(warnings[0].message).toBe(
      'Invalid permission rule "Bash(:*)" was skipped: Prefix cannot be empty before :*. Specify a command prefix before :*',
    )
  })
})

describe('2.1.282 — runtime matching for mid-pattern :* is unchanged (read-only)', () => {
  test('parsePermissionRule("npm run:*build") is a wildcard rule', () => {
    expect(parsePermissionRule('npm run:*build')).toEqual({
      type: 'wildcard',
      pattern: 'npm run:*build',
    })
  })

  test('the wildcard rule matches commands with the literal colon', () => {
    expect(matchWildcardPattern('npm run:*build', 'npm run:xbuild')).toBe(true)
    expect(matchWildcardPattern('npm run:*build', 'npm run:build')).toBe(true)
    // ':' is literal in wildcard patterns — the space form does NOT match.
    expect(matchWildcardPattern('npm run:*build', 'npm run build')).toBe(false)
  })

  test('trailing :* still parses as the legacy prefix rule', () => {
    expect(parsePermissionRule('npm run:*')).toEqual({
      type: 'prefix',
      prefix: 'npm run',
    })
  })
})
