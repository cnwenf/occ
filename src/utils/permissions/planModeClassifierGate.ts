/**
 * CC 2.1.290 (cluster-d Item 1 / D#1) — plan-mode structural gate on the
 * auto-mode classifier's allow.
 *
 * Official 290 `_rn` (@213320210, the 5-param successor to 289 `Q3t`) decides
 * whether a classifier "allow" is HONORED, switched on the permission mode:
 *
 *   function _rn(e,n,r,s,g){ ... case"plan":{
 *     if(!Uf())return!1;
 *     let h=r.inputSchema.safeParse(s);
 *     return h.success===!0 && r.isReadOnly(h.data,g)
 *       && !(r.ignoresWholeToolAllowRule?.(h.data)??!1)
 *       || vye(Sf(r), h.success?h.data:s)
 *   } ... }
 *
 * (e=mode, r=tool, s=input, g=toolUseContext). Semantics: in plan mode the
 * classifier may only auto-approve a tool call that is STRUCTURALLY read-only;
 * a non-read-only call must fall back to prompting the user (plan_mode_floor)
 * even though the classifier said allow. `case"auto":return!0` — auto mode
 * honors the classifier allow unconditionally.
 *
 * OCC mapping (docs/gap-research-291/cluster-d-classifier-network.md line 77;
 * allowRuleHint.ts precedent — "where OCC lacks a hook, treat as false; do not
 * invent"):
 *   - `Uf()` (plan-mode-auto-active precondition) is guaranteed by the enclosing
 *     classifier gate (permissions.ts:601-607 enters plan-mode classification
 *     only when isAutoModeActive()||isPlanModeAutoBashActive()), so it is not
 *     re-checked here.
 *   - `r.isReadOnly(h.data,g)` — ported; Tool.isReadOnly gains an OPTIONAL 2nd
 *     `context` param (Tool.ts:449). Default impl unchanged; tools that need the
 *     context align later (no behavior invented now).
 *   - `r.ignoresWholeToolAllowRule?.(...)??!1` — NOT on OCC's Tool interface →
 *     treated as false, so `!(false)`=true (conjunct inert). No new tool-interface
 *     method invented (same treatment as allowRuleHint.ts:30).
 *   - `|| vye(Sf(r),…)` (whole-tool-allow-rule-ignored OR-branch) — no OCC
 *     surface (cluster-d line 72: mcpServerPolicy / whole-tool-ignore absent,
 *     grep-confirmed) → omitted. It could only ADD allows, so omitting it fails
 *     safe toward ask in plan mode.
 *
 * Net gate: plan mode honors the classifier allow iff the input parses AND the
 * tool is read-only for that input; every other mode honors it unconditionally.
 */

import type { Tool, ToolUseContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'

/**
 * decisionReason.reason string for the plan-mode fallback to ask. Official
 * binary literal `"plan_mode_floor"` (2/2 occurrences in both 289 and 290).
 */
export const PLAN_MODE_FLOOR_REASON = 'plan_mode_floor'

/**
 * Whether a classifier "allow" should be honored for `tool`/`input` under
 * `mode`. Pure — no side effects, no I/O. See the module header for the
 * official `_rn` derivation and the OCC conjunct mapping.
 */
export function shouldHonorClassifierAllow(
  mode: PermissionMode,
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
): boolean {
  switch (mode) {
    case 'auto':
      // Official `case"auto":return!0` — auto mode honors the classifier allow
      // unconditionally (no read-only floor).
      return true
    case 'plan': {
      // Official 290 plan branch: the parse must succeed AND the tool must be
      // structurally read-only for this input. (ignoresWholeToolAllowRule is
      // inert and the vye OR-branch is absent in OCC — see module header.)
      const parsed = tool.inputSchema.safeParse(input)
      return parsed.success === true && tool.isReadOnly(parsed.data, context)
    }
    default:
      // acceptEdits / bypassPermissions / default / dontAsk / bubble: the
      // classifier-allow landing is only reached in auto/plan mode
      // (permissions.ts:601-607). Any other mode is treated as an unconditional
      // allow, matching `_rn`'s default-open behavior for non-plan modes.
      return true
  }
}
