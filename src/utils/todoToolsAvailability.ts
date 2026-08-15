import { isEnvTruthy } from './envUtils.js'
import { getMainLoopModel } from './model/model.js'

/**
 * 2.1.233 alignment (OCC-95): Todo/task-tracking tools (TaskCreate/Get/
 * Update/List, TodoWrite) are no longer available on Opus 4.8, Sonnet 5,
 * Fable 5, Mythos 5, and newer models; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
 * brings them back.
 *
 * Ported from the official 2.1.233 linux-x64 ELF (byte-verified):
 *
 *   var M_v=[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]]
 *
 *   function uCr(e,t){let r=/^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(e),
 *     n=r?.[1],o=r?.[2];if(!n||!o)return!1;
 *     let i=t.find(([a])=>a===n)?.[1];if(!i)return!1;
 *     let s=o.split("-").map(Number);
 *     for(let a=0;a<Math.max(s.length,i.length);a++){
 *       let l=(s[a]??0)-(i[a]??0);if(l!==0)return l>0}
 *     return!0}
 *
 *   function cX(){if(Jx()||Eds())return!0;
 *     let e=r0r();if(e===void 0||O_v(e))return!0;   // O_v(e)=!uCr(e,M_v)
 *     if(V.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0)return!0;
 *     return rt("tengu_rosy_wren",!1)===!0}
 *
 * Official overrides NOT ported (surfaces trimmed from OCC):
 * - `Jx()` = background session / bg-takeover keep todo tools — OCC's
 *   shipped build has no bg session kind (BG_SESSIONS flag off, `--bg`
 *   redirects to the daemon subcommands).
 * - `Eds()` = SDK `launchOptions.todoToolsOptIn()` — OCC has no SDK
 *   launchOptions surface.
 * The official also consults the GrowthBook flag `tengu_rosy_wren`
 * (default false); OCC stubs analytics, so the flag resolves to its
 * default — omitting it is byte-equivalent.
 */

/** [family, minimum-blocked-version] — byte-identical to the official table. */
const TODO_TOOL_RESTRICTED_MODELS: ReadonlyArray<
  readonly [string, readonly number[]]
> = [
  ['opus', [4, 8]],
  ['sonnet', [5]],
  ['fable', [5]],
  ['mythos', [5]],
]

/**
 * Port of the official `uCr`: true when `modelId` (a canonical
 * `claude-<family>-<version>` id) belongs to `family` and its version is
 * >= the per-family threshold. Version segments compare numerically left
 * to right (`claude-opus-5` ≥ 4.8, `claude-opus-4-7` < 4.8).
 */
function isModelAtOrAboveRestrictedThreshold(
  modelId: string,
  restricted: ReadonlyArray<readonly [string, readonly number[]]>,
): boolean {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(modelId)
  const family = match?.[1]
  const version = match?.[2]
  if (!family || !version) {
    return false
  }
  const threshold = restricted.find(([f]) => f === family)?.[1]
  if (!threshold) {
    return false
  }
  const segments = version.split('-').map(Number)
  for (let i = 0; i < Math.max(segments.length, threshold.length); i++) {
    const diff = (segments[i] ?? 0) - (threshold[i] ?? 0)
    if (diff !== 0) {
      return diff > 0
    }
  }
  return true
}

/**
 * Whether Todo/task tools should be offered for the current main-loop
 * model. Mirrors the official `cX()` (minus the trimmed-surface overrides
 * documented above): restricted models hide the tools unless
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS` is truthy; unrecognized model ids keep
 * the tools (official `e===void 0||O_v(e)` fallthrough).
 */
export function areTodoToolsAvailable(): boolean {
  const model = getMainLoopModel()
  if (!isModelAtOrAboveRestrictedThreshold(model, TODO_TOOL_RESTRICTED_MODELS)) {
    return true
  }
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS)
}
