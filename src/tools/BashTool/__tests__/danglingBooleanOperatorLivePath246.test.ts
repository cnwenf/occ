import { describe, expect, test } from 'bun:test'
import {
  bashToolHasPermission,
  hasDanglingBooleanOperator,
} from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

/**
 * 2.1.246 — LIVE-path pin for "Fixed Bash permission checks to always
 * require approval for malformed commands with a dangling `&&` or `||`
 * operator".
 *
 * In the official build the fix rides the AST path (tree-sitter is live
 * there; a trailing boolean operator is a parse error → always ask). OCC's
 * tree-sitter path is dormant (TREE_SITTER_BASH is not in the feature
 * allowlist), and the LIVE legacy splitter silently drops a trailing
 * `&&`/`||` — `splitCommand('ls &&')` → ['ls'] — so before this round a
 * `Bash(ls:*)` / `Bash(ls *)` / even exact `Bash(ls)` rule auto-approved
 * `ls &&`. The new live-path compensation guard hasDanglingBooleanOperator
 * makes the legacy path fail closed the same way as the official.
 *
 * Method (same as zshRegexConditionalLivePath221 / quotedBracketCloserLive
 * Path223): drive the real production gate bashToolHasPermission with
 * permissive allow rules; every dangling form must stay out of `allow`.
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

// Dangling forms: a trailing `&&` / `||` with no right-hand side.
const DANGLING_FORMS: Array<[string, string[]]> = [
  ['ls &&', ['Bash(ls:*)']], // prefix rule
  ['ls &&', ['Bash(ls *)']], // wildcard rule
  ['ls &&', ['Bash(ls)']], // exact rule — was also auto-allowed before
  ['ls ||', ['Bash(ls:*)']],
  ['ls ||', ['Bash(ls *)']],
  ['ls&&', ['Bash(ls:*)']], // no space before the operator
  ['ls && ', ['Bash(ls:*)']], // trailing whitespace after the operator
  ['ls &&\n', ['Bash(ls:*)']], // trailing newline after the operator
  ['git status &&', ['Bash(git status:*)']],
  ['git status &&', ['Bash(git *)']], // shorter prefix rule
  ['npm run build &&', ['Bash(npm run build:*)']],
  ['echo hi ||', ['Bash(echo:*)']],
  ['ls && &&', ['Bash(ls:*)']], // doubled dangling operator
]

describe('2.1.246 — LIVE legacy path fails closed for dangling && / ||', () => {
  test('permissive rules still auto-allow benign commands (control)', async () => {
    // Proves the allow rules are actually active, so any dangling form
    // reaching `allow` below is a genuine bypass, not a missing rule.
    for (const [cmd, rules] of [
      ['ls', ['Bash(ls:*)']],
      ['ls -la', ['Bash(ls:*)']],
      ['git status', ['Bash(git status:*)']],
      ['npm run build', ['Bash(npm run build:*)']],
      ['echo hi', ['Bash(echo:*)']],
    ] as const) {
      const r = await permitFor(cmd, rules as string[])
      expect(r.behavior).toBe('allow')
    }
  })

  for (const [cmd, rules] of DANGLING_FORMS) {
    test(`dangling ${JSON.stringify(cmd)} is NOT auto-allowed despite ${JSON.stringify(rules)}`, async () => {
      const r = await permitFor(cmd, rules)
      // Fail-closed: must prompt (ask) or deny — never auto-allow.
      expect(r.behavior).not.toBe('allow')
      expect(['ask', 'deny']).toContain(r.behavior)
    })
  }

  test('quoted/escaped && is not dangling (no false positives)', async () => {
    // The && inside quotes / escapes is not an operator; shell-quote's
    // tokenizer folds it into a word, so the guard must not fire.
    for (const [cmd, rules] of [
      ['echo "a &&"', ['Bash(echo:*)']],
      ["echo 'a ||'", ['Bash(echo:*)']],
    ] as const) {
      const r = await permitFor(cmd, rules as string[])
      expect(r.behavior).toBe('allow')
    }
  })

  test('well-formed compounds are unaffected by the guard', async () => {
    // `ls && id` is a WELL-FORMED compound: both subcommands are checked
    // independently and both are read-only auto-allows. The guard only
    // fires when the LAST token is a boolean operator.
    const r = await permitFor('ls && id', ['Bash(ls:*)'])
    expect(r.behavior).toBe('allow')
  })
})

describe('hasDanglingBooleanOperator detector', () => {
  test('flags trailing && / || forms', () => {
    expect(hasDanglingBooleanOperator('ls &&')).toBe(true)
    expect(hasDanglingBooleanOperator('ls ||')).toBe(true)
    expect(hasDanglingBooleanOperator('ls&&')).toBe(true)
    expect(hasDanglingBooleanOperator('ls && ')).toBe(true)
    expect(hasDanglingBooleanOperator('ls &&\n')).toBe(true)
    expect(hasDanglingBooleanOperator('git status &&')).toBe(true)
    expect(hasDanglingBooleanOperator('ls && &&')).toBe(true)
    expect(hasDanglingBooleanOperator('&&')).toBe(true)
  })

  test('does not flag well-formed or quoted forms', () => {
    expect(hasDanglingBooleanOperator('ls')).toBe(false)
    expect(hasDanglingBooleanOperator('ls && id')).toBe(false)
    expect(hasDanglingBooleanOperator('ls && id ||')).toBe(true)
    expect(hasDanglingBooleanOperator('ls || id && echo hi')).toBe(false)
    expect(hasDanglingBooleanOperator('echo "a &&"')).toBe(false)
    expect(hasDanglingBooleanOperator("echo 'a ||'")).toBe(false)
    expect(hasDanglingBooleanOperator('ls \\&\\&')).toBe(false)
    expect(hasDanglingBooleanOperator('')).toBe(false)
  })
})
