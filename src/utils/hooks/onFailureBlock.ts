/**
 * CC 2.1.295 — `onFailure: "block"` for command and HTTP hooks.
 *
 * Official binary evidence (2.1.295 linux-x64 ELF, verbatim):
 *
 *   function jIe(e){switch(e.type){
 *     case"command":return e.onFailure==="block"&&e.async!==!0&&e.asyncRewake!==!0;
 *     case"http":return e.onFailure==="block";
 *     default:return!1}}
 *
 *   var G_t=new Set(["Stop","SubagentStop","TaskCompleted","TeammateIdle"]);
 *
 * Outcome-level conversion (official K_t, applied in the REPL executeHooks
 * consumer loop BEFORE the outcome tally):
 *
 *   function K_t(e,n,r,s,h=!1){let y=W_t(e.hook,n,h);if(y===void 0)return e;
 *     let S=e.outcome==="cancelled"&&r?.aborted!==!0?"timed out"
 *          :e.outcome==="non_blocking_error"?"failed":void 0;
 *     if(S===void 0)return e;
 *     if(G_t.has(n))return t(`Hooks: ${n} ${e.hook.type} hook ${S}; not
 *       blocking (onFailure: "block" is ignored on ${n})`,{level:"warn"}),e;
 *     ... ke=`[${G}]: ${S}; ${fXn(y,s)}${_e===""?"":`\n${_e}`}` ...
 *     return {...e,message:void 0,blockingError:{blockingError:ke,command:G},
 *       ...n==="PermissionRequest"&&{permissionRequestResult:{behavior:"deny",
 *       message:ke}},suppressOriginalPrompt:!0,outcome:"blocking"}}
 *
 * Raw-result-level conversion (official V_t, applied in the outside-REPL
 * Promise.all executor via `.then(Gt => V_t(hook, {...Gt}))`):
 *
 *   function V_t(e,n){if(!jIe(e)||n.succeeded||n.blocked||n.cancelled===!0)return n;
 *     let r=n.output==="Hook cancelled",s=r?"":n.output.trim();
 *     return{...n,blocked:!0,output:`${r?"timed out":"failed"}; blocking
 *       because onFailure is "block"${s===""?"":`\n${s}`}`}}
 *
 * Porting notes:
 * - `r` (K_t's 3rd arg) is the PARENT abort signal — proven by the official
 *   http-cancelled attachment's `timedOut:!y?.aborted`. A cancelled outcome
 *   with the parent signal NOT aborted means the hook's own timeout fired.
 * - The official `s` (script-hook flag, gates the Nmr/Fmr wrappers) and `h`
 *   (personal-hook flag, O4e + CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG) are
 *   always false in OCC: OCC has no script hooks and no
 *   CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG surface. W_t therefore collapses to
 *   `jIe(hook) ? 'setting' : undefined` and fXn('setting', ·) is always
 *   `blocking because onFailure is "block"` — the personal-hook branch (URL
 *   redaction jy/hC, personal texts) is intentionally NOT ported.
 * - Jre = "Failed with non-blocking status code: " (leading strip),
 *   UIe = "Treating as non-blocking. " (first-occurrence replace) — applied
 *   to the hook_non_blocking_error attachment stderr, verbatim.
 */

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookCommand } from '../../schemas/hooks.js'
import type { HookCallback } from '../../types/hooks.js'
import { logForDebugging } from '../debug.js'
import type { HookOutsideReplResult, HookResult } from '../hooks.js'
import type { FunctionHook } from './sessionHooks.js'

type AnyHook = HookCommand | HookCallback | FunctionHook

/** Official Jre — leading prefix on non-blocking-status stderr. */
const NON_BLOCKING_STATUS_PREFIX = 'Failed with non-blocking status code: '
/** Official UIe — removed (first occurrence) from the extracted stderr. */
const TREATING_AS_NON_BLOCKING = 'Treating as non-blocking. '
/** Official fXn('setting', ·) — the only branch reachable in OCC. */
const SETTING_BLOCK_REASON = 'blocking because onFailure is "block"'

/**
 * Official G_t — events where onFailure:"block" is ignored (warn + pass
 * through unchanged).
 */
export const ON_FAILURE_BLOCK_IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'Stop',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
])

/**
 * Official jIe — the blocking predicate. Command hooks only when NOT
 * async/asyncRewake (async hooks ignore onFailure); http hooks always;
 * prompt/agent/mcp_tool/callback/function hooks never.
 */
export function isOnFailureBlockHook(hook: AnyHook): boolean {
  switch (hook.type) {
    case 'command':
      return (
        hook.onFailure === 'block' &&
        hook.async !== true &&
        hook.asyncRewake !== true
      )
    case 'http':
      return hook.onFailure === 'block'
    default:
      return false
  }
}

/**
 * Official lM — display text for the blocking-error `[command]` prefix.
 * NOTE: deliberately NOT getHookDisplayText() (which prefers statusMessage);
 * the official K_t uses lM for onFailure blocking errors.
 */
export function getHookFailureCommand(hook: AnyHook): string {
  switch (hook.type) {
    case 'command':
      return hook.args ? [hook.command, ...hook.args].join(' ') : hook.command
    case 'prompt':
      return hook.prompt
    case 'agent':
      return hook.prompt
    case 'http':
      return hook.url
    case 'mcp_tool':
      return `${hook.server}/${hook.tool}`
    case 'callback':
      return 'callback'
    case 'function':
      return 'function'
  }
}

/**
 * Official K_t (setting path only — see porting notes). Converts a failed or
 * timed-out HookResult into a blocking one when the hook has
 * onFailure:"block". Returns a NEW object (immutable); the input is never
 * mutated.
 *
 * @param result       the raw hook result from the per-hook generator
 * @param hookEvent    the event being executed (official `n`)
 * @param parentSignal the parent abort signal (official `r`/`y`) — when the
 *                     parent is NOT aborted, a 'cancelled' outcome means the
 *                     hook's own timeout fired ("timed out")
 */
export function applyOnFailureBlockOutcome(
  result: HookResult,
  hookEvent: HookEvent,
  parentSignal?: AbortSignal,
): HookResult {
  if (!isOnFailureBlockHook(result.hook)) {
    return result
  }
  const failureKind =
    result.outcome === 'cancelled' && parentSignal?.aborted !== true
      ? 'timed out'
      : result.outcome === 'non_blocking_error'
        ? 'failed'
        : undefined
  if (failureKind === undefined) {
    return result
  }
  if (ON_FAILURE_BLOCK_IGNORED_EVENTS.has(hookEvent)) {
    logForDebugging(
      `Hooks: ${hookEvent} ${result.hook.type} hook ${failureKind}; not blocking (onFailure: "block" is ignored on ${hookEvent})`,
      { level: 'warn' },
    )
    return result
  }
  const hook = result.hook
  const command = getHookFailureCommand(hook)
  const attachment =
    result.message?.type === 'attachment'
      ? result.message.attachment
      : undefined
  const rawStderr =
    attachment?.type === 'hook_non_blocking_error' &&
    typeof attachment.stderr === 'string'
      ? attachment.stderr.trim()
      : ''
  const stderrText = (
    rawStderr.startsWith(NON_BLOCKING_STATUS_PREFIX)
      ? rawStderr.slice(NON_BLOCKING_STATUS_PREFIX.length)
      : rawStderr
  ).replace(TREATING_AS_NON_BLOCKING, '')
  const blockingErrorText = `[${command}]: ${failureKind}; ${SETTING_BLOCK_REASON}${
    stderrText === '' ? '' : `\n${stderrText}`
  }`
  logForDebugging(
    `Hooks: ${hookEvent} ${hook.type} hook ${failureKind}; blocking (onFailure: "block")`,
    { level: 'warn' },
  )
  return {
    ...result,
    message: undefined,
    blockingError: { blockingError: blockingErrorText, command },
    ...(hookEvent === 'PermissionRequest' && {
      permissionRequestResult: {
        behavior: 'deny' as const,
        message: blockingErrorText,
      },
    }),
    suppressOriginalPrompt: true,
    outcome: 'blocking',
  }
}

/**
 * Official V_t — raw-result-level conversion for executeHooksOutsideREPL.
 * A failed (not succeeded, not already blocked, not parent-cancelled) raw
 * result becomes blocked with the official output text. `cancelled === true`
 * results pass through unchanged (official `n.cancelled===!0` guard — the
 * parent signal aborted, so the whole run is being torn down anyway).
 *
 * @param hook the hook that produced the result (undefined → unchanged;
 *             defensive only — call sites pair hooks 1:1 with promises)
 */
export function applyOnFailureBlockRaw(
  hook: AnyHook | undefined,
  result: HookOutsideReplResult,
): HookOutsideReplResult {
  if (
    hook === undefined ||
    !isOnFailureBlockHook(hook) ||
    result.succeeded ||
    result.blocked ||
    result.cancelled === true
  ) {
    return result
  }
  const isCancelOutput = result.output === 'Hook cancelled'
  const detail = isCancelOutput ? '' : result.output.trim()
  return {
    ...result,
    blocked: true,
    output: `${isCancelOutput ? 'timed out' : 'failed'}; ${SETTING_BLOCK_REASON}${
      detail === '' ? '' : `\n${detail}`
    }`,
  }
}
