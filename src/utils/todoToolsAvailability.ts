import { isEnvTruthy } from './envUtils.js'
import { getMainLoopModel } from './model/model.js'

/**
 * 2.1.268 alignment: Todo/task-tracking tools (TaskCreate/Get/Update/List,
 * TodoWrite) are now gated by a model ALLOWLIST. This allowlist supersedes
 * the 2.1.233 denylist port (the `[["opus",[4,8]],["sonnet",[5]],["fable",
 * [5]],["mythos",[5]]]` family+version threshold table that previously
 * lived here): models NOT in the set — including former denylist entries
 * (Opus 4.8+, Sonnet 5+, Fable 5+, Mythos 5+) and any newer/unknown id —
 * hide the tools unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is truthy.
 *
 * Ported from the official 2.1.268 linux-x64 ELF (byte-verified):
 *
 *   var JAo=new Set(["claude-3-opus","claude-3-sonnet","claude-3-haiku",
 *     "claude-3-5-sonnet","claude-3-5-haiku","claude-3-7-sonnet",
 *     "claude-opus-4-0","claude-opus-4-1","claude-opus-4-5",
 *     "claude-opus-4-6","claude-opus-4-7","claude-sonnet-4-0",
 *     "claude-sonnet-4-5","claude-sonnet-4-6","claude-haiku-4-5"])
 *   function eRo(e){return JAo.has(e)}
 *   function tRo(e){return e.includes("application-inference-profile")}
 *   function dD(){if(pl()||Ozn())return!0;
 *     let e=Kze();if(e===void 0||tRo(e)||eRo(e))return!0;
 *     return a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}
 *
 * Official overrides NOT ported (surfaces trimmed from OCC — same two the
 * 2.1.233 header documented):
 * - `pl()` = background session / bg-takeover keep todo tools — OCC's
 *   shipped build has no bg session kind (BG_SESSIONS flag off, `--bg`
 *   redirects to the daemon subcommands).
 * - `Ozn()` = SDK `launchOptions.todoToolsOptIn()` — OCC has no SDK
 *   launchOptions surface.
 * The official `a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0` reads the env object
 * with boolean coercion; OCC mirrors that with `isEnvTruthy`, the same
 * helper used for `CLAUDE_CODE_ENABLE_TASKS` in src/utils/tasks.ts.
 */

/**
 * Canonical model ids that keep todo/task tools — byte-identical to the
 * official `JAo` set (15 ids).
 */
export const TODO_TOOL_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
])

/**
 * Whether Todo/task tools should be offered for the current main-loop
 * model. Mirrors the official `dD()` (minus the trimmed-surface overrides
 * documented above): no resolved model keeps the tools (official
 * `e===void 0` fallthrough); Bedrock-style application inference profiles
 * keep the tools; allowlisted canonical ids keep the tools; everything else
 * consults `CLAUDE_CODE_ENABLE_TODO_TOOLS`.
 */
export function areTodoToolsAvailable(): boolean {
  const model = getMainLoopModel() as string | undefined
  if (model === undefined) {
    return true
  }
  if (model.includes('application-inference-profile')) {
    return true
  }
  if (TODO_TOOL_ALLOWED_MODELS.has(model)) {
    return true
  }
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS)
}
