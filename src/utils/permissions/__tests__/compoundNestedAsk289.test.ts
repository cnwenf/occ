import { describe, expect, mock, test } from 'bun:test'
import type { AssistantMessage, Tool, ToolUseContext } from '../../../Tool.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../../types/permissions.js'
import type { PermissionDecision } from '../PermissionResult.js'
import { checkRuleBasedPermissions } from '../permissions.js'

// The permission path reads MACRO.VERSION (via getBundledSkillsRoot) at runtime.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.289 changelog #1 (security):
 *   "Fixed a deny or ask rule on a nested part of a compound shell command not
 *    holding over a user-installed mod's approval on managed machines."
 *
 * Official mechanism (byte-verified v288→v289 ELF diff): the rule extractor
 * `Krt`→`kTe` became RECURSIVE — `S = g?.type==="rule" ? g.rule : kTe(g,n)` —
 * so a deny/ask rule matching a *nested* part of a compound command is found
 * and holds over the mod's approval. Official's hook / classifier / bypass
 * override paths are all gated on `!cY(result)` where `cY = G5e(decisionReason)
 * || matchedAskRule?.ruleBehavior==="ask"`, and `G5e` is the recursive ask
 * predicate over subcommandResults.
 *
 * OCC mapping: OCC has no `kTe`/`xst`; the equivalent gate is
 * checkRuleBasedPermissions (step 1f), which resolveHookPermissionDecision
 * consults before letting a PreToolUse-hook allow (the OCC analog of a
 * user-installed mod's approval) stand. Pre-fix, 1f inspected only the
 * top-level `decisionReason.type === 'rule'`, so a compound command whose
 * merged decision is {behavior:'ask', decisionReason:{type:'subcommandResults'}}
 * (≥2 non-allow parts) fell through to null → the hook allow bypassed the
 * nested ask rule. The fix ports G5e as `isRuleAskDecisionReason` (recursive).
 * The deny half was already covered (step 1d returns any deny, incl. wrapped).
 */

// ── helpers ──

function ruleAskReason(): PermissionDecisionReason {
  return {
    type: 'rule',
    rule: {
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'Bash', ruleContent: 'rm:*' },
      source: 'userSettings',
    } as never,
  }
}

function ruleAllowReason(): PermissionDecisionReason {
  return {
    type: 'rule',
    rule: {
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'ls:*' },
      source: 'userSettings',
    } as never,
  }
}

/** A compound merged ask: reasons map with one nested rule-ask part. */
function compoundAskWithNestedRuleAsk(): PermissionResult {
  const reasons = new Map<string, PermissionResult>([
    ['ls', { behavior: 'passthrough', message: '' } as PermissionResult],
    [
      'rm x',
      {
        behavior: 'ask',
        message: 'rm requires approval',
        decisionReason: ruleAskReason(),
      } as PermissionResult,
    ],
  ])
  return {
    behavior: 'ask',
    message: 'Compound command requires approval',
    decisionReason: { type: 'subcommandResults', reasons },
  } as PermissionResult
}

/** Deeply nested compound: a && (b && rm x) — rule-ask two levels down. */
function deeplyNestedCompoundAsk(): PermissionResult {
  const inner = new Map<string, PermissionResult>([
    ['b', { behavior: 'passthrough', message: '' } as PermissionResult],
    [
      'rm x',
      {
        behavior: 'ask',
        message: 'rm requires approval',
        decisionReason: ruleAskReason(),
      } as PermissionResult,
    ],
  ])
  const outer = new Map<string, PermissionResult>([
    ['a', { behavior: 'passthrough', message: '' } as PermissionResult],
    [
      'b && rm x',
      {
        behavior: 'ask',
        message: 'inner compound',
        decisionReason: { type: 'subcommandResults', reasons: inner },
      } as PermissionResult,
    ],
  ])
  return {
    behavior: 'ask',
    message: 'Compound command requires approval',
    decisionReason: { type: 'subcommandResults', reasons: outer },
  } as PermissionResult
}

/** Compound where every part is allow/passthrough — no rule-ask anywhere. */
function compoundAllAllow(): PermissionResult {
  const reasons = new Map<string, PermissionResult>([
    [
      'ls',
      {
        behavior: 'allow',
        message: '',
        decisionReason: ruleAllowReason(),
      } as PermissionResult,
    ],
    ['pwd', { behavior: 'passthrough', message: '' } as PermissionResult],
  ])
  return {
    behavior: 'ask',
    message: 'Compound command',
    decisionReason: { type: 'subcommandResults', reasons },
  } as PermissionResult
}

function makeTool(checkPermissionsResult: PermissionResult): Tool {
  return {
    name: 'Bash',
    userFacingName: () => 'Bash',
    inputSchema: {
      parse: (input: unknown) => input,
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    checkPermissions: async () => checkPermissionsResult,
    description: async () => 'Bash',
    requiresUserInteraction: undefined,
    isMcp: false,
  } as unknown as Tool
}

function makeContext(mode = 'default'): ToolUseContext {
  return {
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        shouldAvoidPermissionPrompts: false,
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
      },
    }),
    options: { isNonInteractiveSession: false, tools: [] },
  } as unknown as ToolUseContext
}

function makeMsg(): AssistantMessage {
  return { message: { id: 'm', content: [] } } as unknown as AssistantMessage
}

// ── 1. checkRuleBasedPermissions unit behavior ──

describe('2.1.289 #1 — checkRuleBasedPermissions holds nested compound rule-ask', () => {
  test('compound ask wrapping a nested rule-ask → returns ask (not null)', async () => {
    const tool = makeTool(compoundAskWithNestedRuleAsk())
    const result = await checkRuleBasedPermissions(
      tool,
      { command: 'ls && rm x' },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result?.behavior).toBe('ask')
  })

  test('DEEPLY nested compound rule-ask (two levels) → returns ask', async () => {
    const tool = makeTool(deeplyNestedCompoundAsk())
    const result = await checkRuleBasedPermissions(
      tool,
      { command: 'a && (b && rm x)' },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result?.behavior).toBe('ask')
  })

  test('compound with only allow/passthrough parts → null (no false positive)', async () => {
    const tool = makeTool(compoundAllAllow())
    const result = await checkRuleBasedPermissions(
      tool,
      { command: 'ls && pwd' },
      makeContext(),
    )
    expect(result).toBeNull()
  })

  test('top-level rule-ask still returns ask (1f regression guard)', async () => {
    const tool = makeTool({
      behavior: 'ask',
      message: 'npm publish requires approval',
      decisionReason: ruleAskReason(),
    } as PermissionResult)
    const result = await checkRuleBasedPermissions(
      tool,
      { command: 'npm publish' },
      makeContext(),
    )
    expect(result?.behavior).toBe('ask')
  })

  test('passthrough tool result → null (no objection)', async () => {
    const tool = makeTool({
      behavior: 'passthrough',
      message: '',
    } as PermissionResult)
    const result = await checkRuleBasedPermissions(
      tool,
      { command: 'echo hi' },
      makeContext(),
    )
    expect(result).toBeNull()
  })
})

// ── 2. End-to-end: hook (mod) allow cannot bypass the nested ask ──

describe('2.1.289 #1 — mod/hook allow does not bypass nested compound ask', () => {
  function makeCanUseToolMock(): ReturnType<typeof mock<CanUseToolFn>> {
    return mock<CanUseToolFn>(
      async (
        _tool: Tool,
        _input: Record<string, unknown>,
        _ctx: ToolUseContext,
        _msg: AssistantMessage,
        _id: string,
        forceDecision?: PermissionDecision,
      ): Promise<PermissionDecision> => {
        // Mirror hasPermissionsToUseTool in default mode: a rule-ask that
        // reaches the full pipeline prompts the user (returns ask).
        if (forceDecision) return forceDecision
        return { behavior: 'ask' as const, message: 'prompt the user' }
      },
    )
  }

  test('hook allow + nested compound rule-ask (default mode) → routes to prompt, NOT silent allow', async () => {
    const { resolveHookPermissionDecision } = await import(
      '../../../services/tools/toolHooks.js'
    )
    const canUseToolMock = makeCanUseToolMock()
    const tool = makeTool(compoundAskWithNestedRuleAsk())
    const input = { command: 'ls && rm x' }
    const hookAllow: PermissionResult = {
      behavior: 'allow',
      updatedInput: input,
    } as PermissionResult

    const { decision } = await resolveHookPermissionDecision(
      hookAllow,
      tool,
      input,
      makeContext('default'),
      canUseToolMock,
      makeMsg(),
      'tool-use-1',
    )

    // Pre-fix: checkRuleBasedPermissions returned null → hook allow stood →
    // decision.behavior === 'allow' and canUseTool was NEVER called.
    // Post-fix: the nested ask holds → canUseTool runs → prompt (ask).
    expect(canUseToolMock).toHaveBeenCalledTimes(1)
    expect(decision.behavior).toBe('ask')
    expect(decision.behavior).not.toBe('allow')
  })

  test('hook allow + all-allow compound (default mode) → hook allow stands (no prompt)', async () => {
    const { resolveHookPermissionDecision } = await import(
      '../../../services/tools/toolHooks.js'
    )
    const canUseToolMock = makeCanUseToolMock()
    const tool = makeTool(compoundAllAllow())
    const input = { command: 'ls && pwd' }
    const hookAllow: PermissionResult = {
      behavior: 'allow',
      updatedInput: input,
    } as PermissionResult

    const { decision } = await resolveHookPermissionDecision(
      hookAllow,
      tool,
      input,
      makeContext('default'),
      canUseToolMock,
      makeMsg(),
      'tool-use-2',
    )

    // No rule objection → hook allow stands, canUseTool not consulted.
    expect(canUseToolMock).toHaveBeenCalledTimes(0)
    expect(decision.behavior).toBe('allow')
  })
})
