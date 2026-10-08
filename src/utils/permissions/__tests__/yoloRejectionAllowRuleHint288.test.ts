/**
 * CC 2.1.288 #15 — auto-mode denial hint names the actual tool.
 *
 * Official binary evidence (docs/gap-research-288/cluster-a-permission-sandbox.md §#15):
 *   - v288 hint builder `bKn` @211301793 appends the rule hint ONLY when
 *     `n.allowRuleToolName !== undefined`, with the verbatim sentence:
 *     `To allow this type of action in the future, the user can add a
 *      permission rule for ${allowRuleToolName} to their settings.`
 *   - v288 caller `dXo` @209972359 computes the `S` predicate (tool can carry
 *     an allow rule): not a sandboxOverride decisionReason, no user-interaction
 *     requirement, not `suppressAlwaysAllowRule`, and the tool does not suppress
 *     always-allow rules / all permission updates / whole-tool allow rules for
 *     the input. `allowRuleToolName = S ? displayName(tool) : undefined`.
 *   - `"Bash(prompt"` has 0 hits in BOTH v287 and v288 binaries — OCC's
 *     previous `Bash(prompt: <description …>)` phrasing was OCC-original and
 *     is removed here.
 */

import { describe, expect, test } from 'bun:test'
import type { Tool } from 'src/Tool.js'
import type { PermissionDecision } from 'src/types/permissions.js'
import { buildYoloRejectionMessage } from '../../messages.js'
import { computeAutoModeAllowRuleToolName } from '../allowRuleHint.js'

// Official v288 `bKn` hint sentence — verbatim, with the tool name substituted.
const officialHint = (toolName: string): string =>
  `To allow this type of action in the future, the user can add a permission rule for ${toolName} to their settings.`

// CC 2.1.293 #38: the official `fnr` revert deleted the 281 outcome-scope
// guidance — the base message now ends at the auto-mode stop suffix (vver
// `UUr` tail), with no trailing space.
const AUTO_MODE_STOP_SUFFIX_END = 'Let the user decide how to proceed.'

function makeTool(partial: Partial<Tool> & { name: string }): Tool {
  return partial as Tool
}

const askResult = (
  extra: Partial<PermissionDecision> = {},
): PermissionDecision =>
  ({
    behavior: 'ask',
    message: 'permission needed',
    ...extra,
  }) as PermissionDecision

describe('CC 2.1.288 #15: buildYoloRejectionMessage hint parameterization (official bKn)', () => {
  test('non-Bash tool denial hint names that tool with the official v288 sentence', () => {
    // Arrange / Act
    const message = buildYoloRejectionMessage('network exfiltration risk', {
      allowRuleToolName: 'WebFetch',
    })

    // Assert
    expect(message).toContain(officialHint('WebFetch'))
    expect(message.endsWith(officialHint('WebFetch'))).toBe(true)
    expect(message).not.toContain('Bash permission rule')
    expect(message).not.toContain('Bash(prompt')
  })

  test('Bash denial hint still names Bash via the parameter (official sentence)', () => {
    const message = buildYoloRejectionMessage('destructive shell pipeline', {
      allowRuleToolName: 'Bash',
    })
    expect(message).toContain(officialHint('Bash'))
  })

  test('no hint is appended when allowRuleToolName is undefined (suppressed tool)', () => {
    const message = buildYoloRejectionMessage('suppressed tool action')
    expect(message).not.toContain('To allow this type of action in the future')
    expect(message).not.toContain('permission rule')
    // Official `bKn`/`fnr` returns the base message `g` unchanged when the
    // hint is gated off — post-2.1.293 #38 the base ends at the stop suffix.
    expect(message.endsWith(AUTO_MODE_STOP_SUFFIX_END)).toBe(true)
  })

  test('explicitly passing allowRuleToolName: undefined behaves like no options', () => {
    const withUndefined = buildYoloRejectionMessage('reason', {
      allowRuleToolName: undefined,
    })
    const withoutOptions = buildYoloRejectionMessage('reason')
    expect(withUndefined).toBe(withoutOptions)
  })

  test('base message (prefix, reason, continuation, guidance) is unchanged by the hint work', () => {
    const message = buildYoloRejectionMessage('test reason', {
      allowRuleToolName: 'Read',
    })
    expect(
      message.startsWith(
        'Permission for this action was denied by the Claude Code auto mode classifier. Reason: test reason. ',
      ),
    ).toBe(true)
    expect(message).toContain(
      "If you have other tasks that don't depend on this action, continue working on those. ",
    )
    expect(message).toContain('first try a safer method')
    expect(message.endsWith(officialHint('Read'))).toBe(true)
    // CC 2.1.293 #38: hint is joined with a single space after the stop
    // suffix (the 281 outcome-scope guidance was reverted out of `fnr`).
    expect(message).toContain(
      `${AUTO_MODE_STOP_SUFFIX_END} ${officialHint('Read')}`,
    )
  })
})

describe('CC 2.1.288 #15: S predicate — computeAutoModeAllowRuleToolName (official dXo)', () => {
  test('plain tool with a plain ask result carries its own display name', () => {
    // Arrange
    const tool = makeTool({ name: 'WebFetch' })
    const result = askResult()

    // Act / Assert — a non-Bash tool is named, not hardcoded Bash.
    expect(computeAutoModeAllowRuleToolName(tool, result)).toBe('WebFetch')
  })

  test('Bash tool carries Bash (parity with the pre-288 hardcoded case)', () => {
    const tool = makeTool({ name: 'Bash' })
    expect(computeAutoModeAllowRuleToolName(tool, askResult())).toBe('Bash')
  })

  test('sandboxOverride decisionReason suppresses the hint', () => {
    const tool = makeTool({ name: 'Bash' })
    const result = askResult({
      decisionReason: {
        type: 'sandboxOverride',
        reason: 'dangerouslyDisableSandbox',
      },
    } as Partial<PermissionDecision>)
    expect(computeAutoModeAllowRuleToolName(tool, result)).toBeUndefined()
  })

  test('tool requiring user interaction suppresses the hint', () => {
    const tool = makeTool({
      name: 'AskUserQuestion',
      requiresUserInteraction: () => true,
    })
    expect(computeAutoModeAllowRuleToolName(tool, askResult())).toBeUndefined()
  })

  test('requiresUserInteraction() === false does not suppress the hint', () => {
    const tool = makeTool({
      name: 'Read',
      requiresUserInteraction: () => false,
    })
    expect(computeAutoModeAllowRuleToolName(tool, askResult())).toBe('Read')
  })

  test('suppressAlwaysAllowRule on the ask result suppresses the hint', () => {
    const tool = makeTool({ name: 'Skill' })
    const result = askResult({
      suppressAlwaysAllowRule: true,
    } as Partial<PermissionDecision>)
    expect(computeAutoModeAllowRuleToolName(tool, result)).toBeUndefined()
  })

  test('suppressAlwaysAllowRule: false does not suppress the hint', () => {
    const tool = makeTool({ name: 'Skill' })
    const result = askResult({
      suppressAlwaysAllowRule: false,
    } as Partial<PermissionDecision>)
    expect(computeAutoModeAllowRuleToolName(tool, result)).toBe('Skill')
  })
})
