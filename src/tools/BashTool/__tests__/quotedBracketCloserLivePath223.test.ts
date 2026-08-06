import { describe, expect, test } from 'bun:test'
import { bashToolHasPermission } from '../bashPermissions.js'
import { hasQuotedBracketCloserInConditional } from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

/**
 * 2.1.223 P0 — LIVE-path pin for the quoted `]]` conditional-closer smuggling
 * class ("Fixed a Bash permission bypass where a crafted command could hide
 * part of itself from permission checks").
 *
 * The AST-path guards landed this round (walkTestExpr default-case `]]`
 * desync / standalone-closer checks + the unparsed-bytes gap walker) sit
 * behind TREE_SITTER_BASH*, which is NOT in the OCC feature allowlist and
 * whose WASM is unavailable at runtime — i.e. dormant in the shipped build
 * (parseCommandRaw returns null; the live decision goes through the legacy
 * path). This test commits to the suite that the LIVE legacy path fails
 * closed for the smuggled forms, via the new live-path compensation guard
 * hasQuotedBracketCloserInConditional (mirrors the M4/M5 guard pattern).
 *
 * Method (same as zshRegexConditionalLivePath221.test.ts): drive the real
 * production gate bashToolHasPermission with a PERMISSIVE `Bash([[ *)` allow
 * rule so a benign `[[ … ]]` command is auto-allowed. Any smuggled form that
 * is wrongly treated as a single benign `[[ ` command would match the rule
 * and be auto-ALLOWED — a bypass. Every smuggled form must stay out of
 * `allow`.
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

// Permissive rule that auto-allows any command beginning with `[[ `.
const PERMISSIVE = ['Bash([[ *)']

// Quoted-`]]` smuggled forms: the quotes protect the `]]` from the legacy
// splitter, so the whole thing looks like one benign `[[ ` command and a
// `Bash([[ *)` rule would auto-allow it — but zsh can close the conditional
// at the hidden `]]` and run the tail. These must never be auto-allowed.
const SMUGGLED_FORMS = [
  '[[ abc == "a]]&&id" ]]', // quoted ]] closer + && tail
  '[[ abc == "a]];id" ]]', // quoted ]] closer + ; tail
  '[[ abc == "x]]" ]]', // standalone quoted ]] closer at operand end
  "[[ abc == 'a]]'&&id ]]", // single-quoted variant
  '[[ abc == "a\\]]&&id" ]]', // backslash-escaped ]] (backslash literal for ] in dquotes)
]

describe('2.1.223 P0 — LIVE legacy path fails closed for quoted-]] smuggling', () => {
  test('permissive Bash([[ *) rule auto-allows a benign conditional', async () => {
    // Control: proves the allow rule is actually active, so any smuggled form
    // reaching `allow` below is a genuine bypass, not a missing rule.
    const r = await permitFor('[[ -f /tmp/x ]]', PERMISSIVE)
    expect(r.behavior).toBe('allow')
  })

  for (const cmd of SMUGGLED_FORMS) {
    test(`smuggled ${JSON.stringify(cmd)} is NOT auto-allowed despite the permissive rule`, async () => {
      const r = await permitFor(cmd, PERMISSIVE)
      // Fail-closed: must prompt (ask) or deny — never auto-allow.
      expect(r.behavior).not.toBe('allow')
      expect(['ask', 'deny']).toContain(r.behavior)
    })
  }

  test('benign quoted operands without a ]] closer still auto-allow', async () => {
    // No false positives: ordinary quoted patterns stay allowed.
    for (const cmd of [
      '[[ abc == "hello world" ]]',
      '[[ abc == "a]b" ]]', // single ] in quotes is fine
      '[[ abc =~ foo ]]',
    ]) {
      const r = await permitFor(cmd, PERMISSIVE)
      expect(r.behavior).toBe('allow')
    }
  })
})

describe('hasQuotedBracketCloserInConditional detector', () => {
  test('flags a standalone ]] inside quotes', () => {
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a]]&&id" ]]')).toBe(true)
    expect(hasQuotedBracketCloserInConditional('[[ abc == "x]]" ]]')).toBe(true)
    expect(hasQuotedBracketCloserInConditional("[[ abc == 'a]]' ]]")).toBe(true)
  })

  test('flags a backslash-escaped ]] inside double quotes (backslash is literal for ])', () => {
    // Security-review finding (b5ba924 MEDIUM): inside double quotes a
    // backslash only escapes $ ` " \ and newline, so `\]` is a literal
    // backslash + a real `]` — the escape-skip must NOT swallow it.
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a\\]]&&id" ]]')).toBe(true)
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a\\]]" ]]')).toBe(true)
    expect(hasQuotedBracketCloserInConditional('[[ abc == "\\]]" ]]')).toBe(true)
  })

  test('still honors real double-quote escapes (does not misread them)', () => {
    // \" inside double quotes is an escaped quote (does not close the quoted
    // region); the trailing `]]` before the real closer is still flagged.
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a\\"b]]" ]]')).toBe(true)
  })

  test('does not flag a ]] embedded in a word (word chars both sides)', () => {
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a]]b" ]]')).toBe(false)
  })

  test('does not flag an unquoted closer or commands without [[', () => {
    expect(hasQuotedBracketCloserInConditional('[[ abc == def ]]')).toBe(false)
    expect(hasQuotedBracketCloserInConditional('echo "a]]b"')).toBe(false)
    expect(hasQuotedBracketCloserInConditional('ls -la')).toBe(false)
  })

  test('does not flag a quoted single ]', () => {
    expect(hasQuotedBracketCloserInConditional('[[ abc == "a]b" ]]')).toBe(false)
  })
})
