import { beforeAll, describe, expect, test } from 'bun:test'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../../Tool.js'
import type { PermissionRule } from '../../../types/permissions.js'

// MACRO polyfill (permissionSetup import graph reads MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// permissionSetup.js pulls a heavy transitive graph — load lazily in
// beforeAll per the startupRuleWarnings282.test.ts convention (a top-level
// import perturbs the shared settings.js module registry for sibling tests).
type PermissionSetupModule = typeof import('../permissionSetup.js')
let collectPermissionRuleSecurityWarnings: PermissionSetupModule['collectPermissionRuleSecurityWarnings']
let collectPermissionRuleSecurityNotices: PermissionSetupModule['collectPermissionRuleSecurityNotices']

beforeAll(async () => {
  const setup = await import('../permissionSetup.js')
  collectPermissionRuleSecurityWarnings = setup.collectPermissionRuleSecurityWarnings
  collectPermissionRuleSecurityNotices = setup.collectPermissionRuleSecurityNotices
})

/**
 * CC 2.1.305 — the official permission-setup FIRST loop (v306 binary
 * @255200695, byte-verified). Iterates [...getDenyRules, ...getAskRules] of
 * the built context and flags rules that restrict nothing:
 *   - removed-upstream-tool names → debug-log note only, no rows,
 *   - content targeting the tool's rule-content field as a raw string
 *     (`Glob(path:…)`, `Bash(command:…)`) → "never matches" A+S rows,
 *   - unknown tool names → "matches no tool" A+S rows.
 * Allow rules are never iterated; session/toolsNarrowing sources are skipped.
 */

function contextWith(opts: {
  deny?: string[]
  ask?: string[]
  allow?: string[]
  denySource?: keyof ToolPermissionContext['alwaysDenyRules']
}): ToolPermissionContext {
  const source = opts.denySource ?? 'userSettings'
  return {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: opts.allow ? { [source]: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { [source]: opts.deny } : {},
    alwaysAskRules: opts.ask ? { [source]: opts.ask } : {},
  }
}

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

describe('CC 2.1.305 first loop — raw rule-content-field string rows', () => {
  test('Glob(path:src/**) deny → Read advice A-row + S-row', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Glob(path:src/**)'] }),
    )
    expect(result.warnings).toEqual([
      'Permission deny rule "Glob(path:src/**)" targets path as a raw string and will not match — use Read(…) to match file-read paths.',
    ])
    expect(result.securityWarnings).toEqual([
      'Deny rule Glob(path:src/**) never matches · use Read(…)',
    ])
  })

  test('Grep(path:src) deny → period suffix A-row, no · use tail on S-row', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Grep(path:src)'] }),
    )
    expect(result.warnings).toEqual([
      'Permission deny rule "Grep(path:src)" targets path as a raw string and will not match.',
    ])
    expect(result.securityWarnings).toEqual([
      'Deny rule Grep(path:src) never matches',
    ])
  })

  test('Write(file_path:foo.ts) ask → Edit advice + Ask capitalization', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ ask: ['Write(file_path:foo.ts)'] }),
    )
    expect(result.warnings).toEqual([
      'Permission ask rule "Write(file_path:foo.ts)" targets file_path as a raw string and will not match — use Edit(…) to match file-write paths.',
    ])
    expect(result.securityWarnings).toEqual([
      'Ask rule Write(file_path:foo.ts) never matches · use Edit(…)',
    ])
  })

  test("Bash(command:rm -rf) deny → the tool's own matcher advice", () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Bash(command:rm -rf)'] }),
    )
    expect(result.warnings).toEqual([
      "Permission deny rule \"Bash(command:rm -rf)\" targets command as a raw string and will not match — use Bash(…) for Bash's own matcher.",
    ])
    expect(result.securityWarnings).toEqual([
      'Deny rule Bash(command:rm -rf) never matches · use Bash(…)',
    ])
  })

  test('content colon that is NOT the rule-content field is not flagged', () => {
    // 'pattern' !== Grep's field ('path'); 'npm run test' has no colon at all.
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Grep(pattern:foo)', 'Bash(npm run test)'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('deny and ask rows are both collected, deny first', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({
        deny: ['Glob(path:src/**)'],
        ask: ['Bash(command:git push)'],
      }),
    )
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('deny rule')
    expect(result.warnings[1]).toContain('ask rule')
    expect(result.securityWarnings).toEqual([
      'Deny rule Glob(path:src/**) never matches · use Read(…)',
      'Ask rule Bash(command:git push) never matches · use Bash(…)',
    ])
  })
})

describe('CC 2.1.305 first loop — matches-no-tool rows', () => {
  test('unknown tool deny → typo A-row + S-row', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Frobnicate(x)'] }),
    )
    expect(result.warnings).toEqual([
      'Permission deny rule "Frobnicate(x)" matches no known tool — check for typos.',
    ])
    expect(result.securityWarnings).toEqual([
      'Deny rule Frobnicate(x) matches no tool · check for typos',
    ])
  })

  test('unknown tool ask → Ask capitalization', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ ask: ['Frobnicate'] }),
    )
    expect(result.securityWarnings).toEqual([
      'Ask rule Frobnicate matches no tool · check for typos',
    ])
  })
})

describe('CC 2.1.305 first loop — skips', () => {
  test('allow rules are never iterated', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ allow: ['Glob(path:src/**)', 'Frobnicate(x)'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('session-source deny rules are skipped', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Glob(path:src/**)'], denySource: 'session' }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('removed-upstream-tool names produce no rows (debug-log note only)', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['Frame(x)', 'TeamCreate'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('TaskOutput is NOT treated as removed (live OCC tool divergence)', () => {
    // The official CPe set includes 'TaskOutput'; OCC keeps it out because
    // TaskOutputTool ships in getAllBaseTools — a TaskOutput deny rule must
    // be treated as a known tool (no rows), not as a removed-tool note.
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['TaskOutput'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('known tools with clean rules produce no rows', () => {
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({
        deny: [
          'Bash(rm *)',
          'WebFetch(domain:example.com)',
          'Edit(src/**)',
          'mcp__server__tool',
        ],
      }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })

  test('wildcard tool names pass the known gate and produce no rows', () => {
    // Official gate `Sk(P)` = P.includes('*') — wildcard tool patterns are
    // treated as known, never as typos.
    const result = collectPermissionRuleSecurityWarnings(
      contextWith({ deny: ['mcp__server__*'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.securityWarnings).toEqual([])
  })
})

describe('CC 2.1.305 — collectPermissionRuleSecurityNotices rows', () => {
  test('deny Write(src/**) → capitalized "Deny rule <notice>" row', () => {
    const rows = collectPermissionRuleSecurityNotices([
      rule('projectSettings', 'deny', 'Write', 'src/**'),
    ])
    expect(rows).toEqual([
      'Deny rule Write(src/**) never matches · use Edit(src/**)',
    ])
  })

  test('allow Bash(git * main) → "Allow rule <notice>" row', () => {
    const rows = collectPermissionRuleSecurityNotices([
      rule('projectSettings', 'allow', 'Bash', 'git * main'),
    ])
    expect(rows).toEqual([
      'Allow rule Bash(git * main) allows any option at its * · use an exact value',
    ])
  })

  test('ask Bash(npm * run:*) → "Ask rule <notice>" row', () => {
    const rows = collectPermissionRuleSecurityNotices([
      rule('userSettings', 'ask', 'Bash', 'npm * run:*'),
    ])
    expect(rows).toEqual([
      'Ask rule Bash(npm * run:*) reads its * literally · use Bash(npm * run*)',
    ])
  })

  test('gating mirrors the validator: deny gets no allow-only notice', () => {
    expect(
      collectPermissionRuleSecurityNotices([
        rule('projectSettings', 'deny', 'Bash', 'git * main'),
      ]),
    ).toEqual([])
    expect(
      collectPermissionRuleSecurityNotices([
        rule('projectSettings', 'deny', 'Bash', 'npm run:*build'),
      ]),
    ).toEqual([])
  })

  test('session-source rules are skipped (parity with the 282 warning loop)', () => {
    expect(
      collectPermissionRuleSecurityNotices([
        rule('session', 'deny', 'Write', 'src/**'),
      ]),
    ).toEqual([])
  })

  test('clean rules produce no rows', () => {
    expect(
      collectPermissionRuleSecurityNotices([
        rule('projectSettings', 'deny', 'Bash', 'npm run test'),
        rule('projectSettings', 'allow', 'Edit', 'src/**'),
      ]),
    ).toEqual([])
  })
})
