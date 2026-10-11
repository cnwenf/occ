import { isEnvTruthy } from '../envUtils.js'
import { getSettingsForSource } from '../settings/settings.js'

/**
 * CC 2.1.296 (OCC-154 P2 #003): CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL —
 * workflow-scoped subagent model override. Port of the official getter
 * module `QTe` (raw JS text recovered verbatim from the 2.1.296 linux-x64
 * ELF @215582922):
 *
 *   function QTe(){let e=a.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL;
 *     if(!e||e.toLowerCase()==="inherit")return;
 *     if(a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE&&
 *        XFe("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL")?.trim()!==e)return;
 *     return e}
 *
 * Semantics: unset/empty/'inherit' (case-insensitive) → undefined. Under
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE the override is honored ONLY when the
 * policy env composition carries the same value (trimmed) — i.e. the model
 * must be policy-provided; a self-set env does not survive FORCE.
 *
 * OCC adaptations (documented, not invented):
 * - Official `XFe(e)=Iko(M(),e)` reads the key from `M()` =
 *   `ji().lastPolicyEnvComposition` (@209449416). OCC keeps no separate
 *   composition cache; the policySettings env block is the source OCC's
 *   managedEnv applies to process.env last, so it is read directly. The
 *   raw-vs-composed difference only surfaces for ${VAR}-expanded policy
 *   values (an edge the trim-equality guard treats as a mismatch → override
 *   dropped under FORCE — fail-closed, same direction as the official).
 * - The FORCE check uses isEnvTruthy, consistent with OCC's Gap-113b FORCE
 *   handling (the official uses raw env-string truthiness).
 */
const WORKFLOW_SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL'

export function getWorkflowSubagentModel(): string | undefined {
  const value = process.env[WORKFLOW_SUBAGENT_MODEL_ENV]
  if (!value || value.toLowerCase() === 'inherit') {
    return undefined
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) {
    const policyRaw = getSettingsForSource('policySettings')?.env?.[
      WORKFLOW_SUBAGENT_MODEL_ENV
    ]
    if (policyRaw?.trim() !== value) {
      return undefined
    }
  }
  return value
}

/**
 * Official `jte` @216345215 region:
 *   function jte(){let e=a.CLAUDE_CODE_SUBAGENT_MODEL;
 *     return e&&e!=="inherit"?e:"inherit"}
 * OCC shape: returns undefined instead of the 'inherit' sentinel so callers
 * can chain with ?? (the 'inherit' fallback is applied at each call site,
 * exactly as the official does with G!=="inherit").
 */
function getGeneralSubagentEnvModel(): string | undefined {
  const value = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  return value && value !== 'inherit' ? value : undefined
}

/**
 * Effective model for a workflow-spawned agent — port of the official
 * workflow-runner resolver `Bt` @228307864:
 *
 *   function Bt(R){if(R)return R;let j=QTe();if(j!==void 0)return j;
 *     let G=jte();return G!=="inherit"?G:U.options.mainLoopModel}
 *
 * Precedence: explicit per-agent model > workflow env > general subagent
 * env (≠'inherit') > main loop model. Used by WorkflowTool/primitives.ts
 * for the prompt-prefix stagger key and the started-event telemetry, so
 * both reflect the model the agent actually runs on.
 */
export function resolveWorkflowSubagentEffectiveModel(
  explicitModel: string | undefined,
  mainLoopModel: string,
): string {
  if (explicitModel) {
    return explicitModel
  }
  const workflowModel = getWorkflowSubagentModel()
  if (workflowModel !== undefined) {
    return workflowModel
  }
  const generalModel = getGeneralSubagentEnvModel()
  if (generalModel !== undefined) {
    return generalModel
  }
  return mainLoopModel
}
