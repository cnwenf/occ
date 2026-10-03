import { describe, test, expect } from 'bun:test'
import { mapPermissionDecisionToTelemetry } from '../permissionDecisionMapper.js'
import type { PermissionDecisionReason } from '../../../types/permissions.js'

/**
 * CC 2.1.288 #31/#32 — the `Aho` wrapper port (permissionDecisionMapper).
 *
 * Official v288 `Aho(e,n)` (byte-verified @208819059 in the 2.1.288 linux-x64
 * ELF; `n` = `s.abortController.signal.aborted`, read ONCE right after the
 * permission decision resolves):
 *
 *   function Aho(e,n){switch(e.behavior){
 *     case"allow":return{decision:"accept",source:MIt(e.decisionReason,"allow")};
 *     case"deny" :return{decision:"reject",source:MIt(e.decisionReason,"deny")};
 *     case"ask"  :return{decision:"reject",source:n?"user_abort":"config"}}}
 *
 * `MIt` (@208818518) == OCC's `decisionReasonToOTelSource`; `xho` (@208818313)
 * == OCC's `ruleSourceToOTelSource`. The single documented OCC divergence is
 * CC 2.1.216 #29: a FAILED / INTERRUPTED SDK permission-prompt request is
 * labelled decision `abort` (official literal is `reject`) and source
 * `user_abort`. That is preserved here by routing the deny decision through
 * `sdkPermissionDecisionLabel`. OCC never emits the official `_Kt`
 * ("tool permission request aborted" @199852507) `other`-branch reason, so the
 * source path is behaviourally equivalent to `MIt`.
 */

function permissionPromptReason(toolResult: unknown): PermissionDecisionReason {
  return {
    type: 'permissionPromptTool',
    permissionPromptToolName: 'mcp__host__approve',
    toolResult,
  } as unknown as PermissionDecisionReason
}

function ruleReason(source: string): PermissionDecisionReason {
  return {
    type: 'rule',
    rule: { source },
  } as unknown as PermissionDecisionReason
}

describe('CC 2.1.288 Aho — allow behavior', () => {
  test('allow → decision "accept", source MIt(reason,"allow")', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'allow', decisionReason: permissionPromptReason({ behavior: 'allow', updatedInput: {} }) },
      false,
    )
    expect(mapped.decision).toBe('accept')
    expect(mapped.source).toBe('user_temporary')
  })

  test('allow with a session rule → user_temporary (xho allow/session)', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'allow', decisionReason: ruleReason('session') },
      false,
    )
    expect(mapped).toEqual({ decision: 'accept', source: 'user_temporary' })
  })

  test('allow with a localSettings rule → user_permanent (xho allow/localSettings)', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'allow', decisionReason: ruleReason('localSettings') },
      false,
    )
    expect(mapped).toEqual({ decision: 'accept', source: 'user_permanent' })
  })

  test('allow with no decisionReason → source "config" (MIt !e branch)', () => {
    const mapped = mapPermissionDecisionToTelemetry({ behavior: 'allow' }, false)
    expect(mapped).toEqual({ decision: 'accept', source: 'config' })
  })
})

describe('CC 2.1.288 Aho — deny behavior', () => {
  test('genuine host deny → decision "reject", source "user_reject"', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      {
        behavior: 'deny',
        decisionReason: permissionPromptReason({ behavior: 'deny', message: 'no' }),
      },
      false,
    )
    expect(mapped).toEqual({ decision: 'reject', source: 'user_reject' })
  })

  test('CC 2.1.216 #29 preserved: FAILED prompt request (toolResult undefined) → decision "abort", source "user_abort"', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'deny', decisionReason: permissionPromptReason(undefined) },
      false,
    )
    // Official Aho literal would be "reject"; OCC #29 labels an interrupted /
    // failed SDK prompt request "abort" — do not regress this.
    expect(mapped).toEqual({ decision: 'abort', source: 'user_abort' })
  })

  test('CC 2.1.216 #29 preserved: host-flagged interrupt → decision "abort", source "user_abort"', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      {
        behavior: 'deny',
        decisionReason: permissionPromptReason({ behavior: 'deny', message: 'aborted', interrupt: true }),
      },
      false,
    )
    expect(mapped).toEqual({ decision: 'abort', source: 'user_abort' })
  })

  test('deny with a session rule → decision "reject", source "user_reject" (xho deny/session)', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'deny', decisionReason: ruleReason('session') },
      false,
    )
    expect(mapped).toEqual({ decision: 'reject', source: 'user_reject' })
  })

  test('the `aborted` flag does NOT alter the deny branch (official Aho reads n only for ask)', () => {
    const reason = permissionPromptReason({ behavior: 'deny', message: 'no' })
    const notAborted = mapPermissionDecisionToTelemetry({ behavior: 'deny', decisionReason: reason }, false)
    const aborted = mapPermissionDecisionToTelemetry({ behavior: 'deny', decisionReason: reason }, true)
    expect(aborted).toEqual(notAborted)
    expect(aborted).toEqual({ decision: 'reject', source: 'user_reject' })
  })
})

describe('CC 2.1.288 Aho — ask behavior (the NEW #32 emit path)', () => {
  test('ask, not aborted → decision "reject", source "config" (official Aho ask branch verbatim)', () => {
    const mapped = mapPermissionDecisionToTelemetry({ behavior: 'ask' }, false)
    expect(mapped).toEqual({ decision: 'reject', source: 'config' })
  })

  test('ask, aborted → decision "reject", source "user_abort" (official Aho ask branch verbatim)', () => {
    const mapped = mapPermissionDecisionToTelemetry({ behavior: 'ask' }, true)
    expect(mapped).toEqual({ decision: 'reject', source: 'user_abort' })
  })

  test('ask source ignores decisionReason (official Aho ask reads only `n`)', () => {
    const mapped = mapPermissionDecisionToTelemetry(
      { behavior: 'ask', decisionReason: ruleReason('session') },
      false,
    )
    expect(mapped).toEqual({ decision: 'reject', source: 'config' })
  })
})
