import { beforeAll, describe, expect, test } from 'bun:test'
import type { PermissionRule } from '../../../types/permissions.js'
import { permissionRuleValueFromString } from '../../permissions/permissionRuleParser.js'
import { validatePermissionRule } from '../permissionValidation.js'

// permissionSetup.js pulls a heavy transitive graph (analytics, model,
// gracefulShutdown, settings). A TOP-LEVEL import here is preloaded by
// `bun test` before any file runs and perturbs the shared settings.js module
// registry — enough to hang attributionBoolean281.test.ts's delicate
// `mock.module('../settings.js')` setup when the directory runs in one
// process. Load it lazily in beforeAll instead (verified: the lazy form does
// not contaminate sibling files).
type PermissionSetupModule = typeof import('../../permissions/permissionSetup.js')
let collectPermissionRuleStartupWarnings: PermissionSetupModule['collectPermissionRuleStartupWarnings']
let formatPermissionRuleWarningLabel: PermissionSetupModule['formatPermissionRuleWarningLabel']
let shouldSkipPermissionRuleStartupWarning: PermissionSetupModule['shouldSkipPermissionRuleStartupWarning']

beforeAll(async () => {
  const setup = await import('../../permissions/permissionSetup.js')
  collectPermissionRuleStartupWarnings = setup.collectPermissionRuleStartupWarnings
  formatPermissionRuleWarningLabel = setup.formatPermissionRuleWarningLabel
  shouldSkipPermissionRuleStartupWarning = setup.shouldSkipPermissionRuleStartupWarning
})

/**
 * 2.1.282 — startup warning loop for permission rules (byte-identical in
 * the 2.1.281 and 2.1.282 official binaries). The loop skips:
 *   - rules from the `session` / `toolsNarrowing` sources,
 *   - cliArg allow rules for the Read tool,
 *   - identifier-colon param rules (`git:*push`, `run_in_background:true`)
 *     — but NOT Windows drive paths (`C:/...`, `C:\...`),
 * and calls the validator WITH the rule's behavior, printing
 * `Permission <behavior> rule (<label>): <warning>` lines.
 *
 * Label note: the official binary's source formatter (`j`) renders settings
 * sources as the relative settings-file path (e.g. `.claude/settings.json`)
 * or the raw source name — it never emits "project settings" (verified 0x in
 * the 2.1.282 binary). These tests pin the label via the exported formatter
 * so the full line stays byte-stable against whatever the source resolves to.
 */

const MID_PATTERN_WARNING_ALLOW =
  'Bash(npm run:*build) has a :* that is not at the end, so it is matched as a * wildcard (the : is literal), not as the trailing :* prefix syntax. Replace that :* with the exact value you mean.'
const MID_PATTERN_WARNING_DENY =
  'Bash(npm run:*build) has a :* that is not at the end, so it is matched as a * wildcard (the : is literal), not as the trailing :* prefix syntax. It already matches as a * wildcard; moving :* to the end would make it a literal prefix and change which commands match.'

function rule(
  source: PermissionRule['source'],
  behavior: PermissionRule['ruleBehavior'],
  toolName: string,
  ruleContent?: string,
): PermissionRule {
  return {
    source,
    ruleBehavior: behavior,
    ruleValue:
      ruleContent === undefined ? { toolName } : { toolName, ruleContent },
  }
}

describe('2.1.282 startup loop — identifier-colon skip', () => {
  test('Bash(git:*push) is skipped even though the validator would warn', () => {
    const candidate = rule('projectSettings', 'allow', 'Bash', 'git:*push')
    // Sanity: the string-level validator DOES warn about this rule, so the
    // skip is what keeps it out of the startup output.
    expect(validatePermissionRule('Bash(git:*push)', 'allow').warning).toBeDefined()
    expect(shouldSkipPermissionRuleStartupWarning(candidate)).toBe(true)
    expect(collectPermissionRuleStartupWarnings([candidate])).toEqual([])
  })

  test('Bash(npm run:*build) is NOT skipped and produces the exact warning line', () => {
    const candidate = rule('projectSettings', 'allow', 'Bash', 'npm run:*build')
    expect(shouldSkipPermissionRuleStartupWarning(candidate)).toBe(false)
    const label = formatPermissionRuleWarningLabel('projectSettings', 'allow')
    expect(collectPermissionRuleStartupWarnings([candidate])).toEqual([
      `Permission allow rule (${label}): ${MID_PATTERN_WARNING_ALLOW}`,
    ])
  })

  test('project settings label resolves to the settings file path', () => {
    // The official `j(source)` renders settings sources as the settings-file
    // path (relative to cwd when shorter); the exact value depends on where
    // the git root resolves to, so pin the stable suffix, not the full path.
    const label = formatPermissionRuleWarningLabel('projectSettings', 'allow')
    expect(label.endsWith('.claude/settings.json')).toBe(true)
  })

  test('deny behavior gets the behavior-correct advice in the line', () => {
    const candidate = rule('projectSettings', 'deny', 'Bash', 'npm run:*build')
    const label = formatPermissionRuleWarningLabel('projectSettings', 'deny')
    expect(collectPermissionRuleStartupWarnings([candidate])).toEqual([
      `Permission deny rule (${label}): ${MID_PATTERN_WARNING_DENY}`,
    ])
  })

  test('Windows drive content is not mis-skipped by the identifier heuristic', () => {
    const forward = rule('projectSettings', 'allow', 'Bash', 'C:/proj:*build')
    const backward = rule('projectSettings', 'allow', 'Bash', 'C:\\proj:*build')
    expect(shouldSkipPermissionRuleStartupWarning(forward)).toBe(false)
    expect(shouldSkipPermissionRuleStartupWarning(backward)).toBe(false)
    const lines = collectPermissionRuleStartupWarnings([forward, backward])
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).toContain('has a :* that is not at the end')
    }
  })

  test('param-rule contents are skipped by the predicate', () => {
    const skipped = [
      'run_in_background:true',
      'domain:*.google.com',
      '_private:x',
      'git:*push',
    ]
    for (const ruleContent of skipped) {
      expect(
        shouldSkipPermissionRuleStartupWarning(
          rule('projectSettings', 'allow', 'Bash', ruleContent),
        ),
      ).toBe(true)
    }
    const notSkipped = ['npm run:*build', '9lives:x', 'npm install']
    for (const ruleContent of notSkipped) {
      expect(
        shouldSkipPermissionRuleStartupWarning(
          rule('projectSettings', 'allow', 'Bash', ruleContent),
        ),
      ).toBe(false)
    }
  })
})

describe('2.1.282 startup loop — source/behavior skips', () => {
  test('session and toolsNarrowing rules never warn', () => {
    const sessionRule = rule('session', 'allow', 'Bash', 'npm run:*build')
    // OCC's PermissionRuleSource union lacks 'toolsNarrowing'; the official
    // loop iterates a context whose union includes it (compared as string).
    const narrowingRule = {
      ...rule('session', 'allow', 'Bash', 'npm run:*build'),
      source: 'toolsNarrowing' as unknown as PermissionRule['source'],
    }
    expect(shouldSkipPermissionRuleStartupWarning(sessionRule)).toBe(true)
    expect(shouldSkipPermissionRuleStartupWarning(narrowingRule)).toBe(true)
    expect(
      collectPermissionRuleStartupWarnings([sessionRule, narrowingRule]),
    ).toEqual([])
  })

  test('cliArg allow Read rules are skipped; cliArg deny Read rules are not', () => {
    const allowRead = rule('cliArg', 'allow', 'Read', 'src/**')
    const denyRead = rule('cliArg', 'deny', 'Read', 'src/**')
    expect(shouldSkipPermissionRuleStartupWarning(allowRead)).toBe(true)
    expect(shouldSkipPermissionRuleStartupWarning(denyRead)).toBe(false)
  })

  test('tool-name-only rules (no content) are never skipped by the heuristic', () => {
    expect(shouldSkipPermissionRuleStartupWarning(rule('cliArg', 'allow', 'Bash'))).toBe(
      false,
    )
  })
})

describe('2.1.282 startup loop — source labels (byte-exact chain)', () => {
  test('cliArg labels name the flag that set the rule', () => {
    expect(formatPermissionRuleWarningLabel('cliArg', 'allow')).toBe(
      '--allowed-tools',
    )
    expect(formatPermissionRuleWarningLabel('cliArg', 'deny')).toBe(
      '--disallowed-tools',
    )
  })

  test('cliArg rules print the flag-labeled line', () => {
    const allowRule = rule('cliArg', 'allow', 'Bash', 'npm run:*build')
    expect(collectPermissionRuleStartupWarnings([allowRule])).toEqual([
      `Permission allow rule (--allowed-tools): ${MID_PATTERN_WARNING_ALLOW}`,
    ])
    const denyRule = rule('cliArg', 'deny', 'Bash', 'npm run:*build')
    expect(collectPermissionRuleStartupWarnings([denyRule])).toEqual([
      `Permission deny rule (--disallowed-tools): ${MID_PATTERN_WARNING_DENY}`,
    ])
  })

  test('policySettings labels as managed policy settings', () => {
    expect(
      formatPermissionRuleWarningLabel('policySettings', 'allow'),
    ).toBe('managed policy settings')
    const policyRule = rule('policySettings', 'allow', 'Bash', 'npm run:*build')
    expect(collectPermissionRuleStartupWarnings([policyRule])).toEqual([
      `Permission allow rule (managed policy settings): ${MID_PATTERN_WARNING_ALLOW}`,
    ])
  })

  test('flagSettings without a settings file path labels as --settings', () => {
    expect(formatPermissionRuleWarningLabel('flagSettings', 'allow')).toBe(
      '--settings',
    )
  })
})

describe('2.1.282 startup loop — mixed batch', () => {
  test('only non-skipped rules with warnings contribute lines, in input order', () => {
    const rules: PermissionRule[] = [
      rule('session', 'allow', 'Bash', 'npm run:*build'), // skipped: session
      rule('projectSettings', 'allow', 'Bash', 'git:*push'), // skipped: identifier-colon
      rule('cliArg', 'allow', 'Read', 'src/**'), // skipped: cliArg allow Read
      rule('projectSettings', 'allow', 'Bash', 'npm run:*build'), // warns
      {
        // mixes-branch rule, parsed from its canonical string form
        source: 'cliArg',
        ruleBehavior: 'deny',
        ruleValue: permissionRuleValueFromString('Bash(npm *:*)'),
      },
      rule('projectSettings', 'allow', 'Bash', 'npm run:*'), // valid, no warning
    ]
    const label = formatPermissionRuleWarningLabel('projectSettings', 'allow')
    expect(collectPermissionRuleStartupWarnings(rules)).toEqual([
      `Permission allow rule (${label}): ${MID_PATTERN_WARNING_ALLOW}`,
      'Permission deny rule (--disallowed-tools): Bash(npm *:*) mixes * with the trailing :* prefix syntax, so it is matched as a literal prefix (the * is not expanded) and matches only commands containing a literal * at that position. Use Bash(npm *) for wildcard matching.',
    ])
  })
})
