/**
 * CC 2.1.288 #15 — allow-rule tool name for auto-mode classifier denials.
 *
 * Official `dXo` @209972359 (v288) computes the `S` predicate — whether the
 * blocked tool can carry a permission allow rule — and passes
 * `allowRuleToolName = S ? v2o(Qf(tool)) : undefined` into the rejection
 * message builder `bKn`, which appends the settings-rule hint ONLY when the
 * name is defined (verbatim official predicate):
 *
 *   S = !eY(result)
 *     && result.decisionReason?.type !== "sandboxOverride"
 *     && mu(result.decisionReason) === void 0
 *     && tool.requiresUserInteraction?.() !== true
 *     && result.suppressAlwaysAllowRule !== true
 *     && tool.suppressesAlwaysAllowRule?.(input) !== true
 *     && tool.suppressesAllPermissionUpdates?.(input) !== true
 *     && tool.ignoresWholeToolAllowRule?.(input) !== true
 *
 * OCC mapping (per docs/gap-research-288/cluster-a-permission-sandbox.md
 * cross-entry note: "where OCC lacks a hook, treat as false — do not invent
 * suppressions"):
 *   - `result.decisionReason?.type !== 'sandboxOverride'` — ported.
 *   - `tool.requiresUserInteraction?.() !== true` — ported (Tool.ts:480).
 *   - `result.suppressAlwaysAllowRule !== true` — ported (ask variant,
 *     types/permissions.ts:250; the classifier-denial site is inside the
 *     `behavior === 'ask'` narrowing, so the field is reachable).
 *   - `eY` / `mu` (user-interaction requirement predicates over the result /
 *     decisionReason) — NO OCC equivalent; treated as not-suppressing.
 *   - `tool.suppressesAlwaysAllowRule` / `suppressesAllPermissionUpdates` /
 *     `ignoresWholeToolAllowRule` — NOT on OCC's Tool interface; treated as
 *     not-suppressing (no new tool-interface methods invented).
 *   - `v2o(Qf(tool))` display name — OCC uses `tool.name`: it is the exact
 *     name permission rules target (MCP tools carry the `mcp__server__tool`
 *     rule-form name), so the hint points at a rule that actually works.
 */

import type { Tool } from '../../Tool.js'
import type { PermissionDecision } from './PermissionResult.js'

/**
 * Compute the tool name an auto-mode denial hint should point at, or
 * `undefined` when no allow rule can express this tool/input combination
 * (hint suppressed — official `S === false` case).
 */
export function computeAutoModeAllowRuleToolName(
  tool: Tool,
  result: PermissionDecision,
): string | undefined {
  const isSandboxOverride = result.decisionReason?.type === 'sandboxOverride'
  const suppressesAlwaysAllowRule =
    result.behavior === 'ask' && result.suppressAlwaysAllowRule === true
  const requiresUserInteraction = tool.requiresUserInteraction?.() === true
  if (isSandboxOverride || suppressesAlwaysAllowRule || requiresUserInteraction) {
    return undefined
  }
  return tool.name
}
