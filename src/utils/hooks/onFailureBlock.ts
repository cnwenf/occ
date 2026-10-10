/**
 * CC 2.1.295 (#001): `onFailure: "block"` for command and HTTP hooks.
 *
 * A hook that can't start (missing script or plugin directory), times out,
 * exits with a code other than 0 or 2, or prints JSON that is invalid or
 * fails validation now counts as exit code 2 when `onFailure: "block"` is
 * set — the action the event guards (tool call, permission request, prompt)
 * is blocked instead of proceeding.
 *
 * Official mechanism (v295 ELF, all offsets verified against
 * /tmp/cc-153/v295/package/claude; v294 has none of it):
 *   - schema field `ni` @208157433 — `onFailure:ni()` on the command hook
 *     schema @208158815 (between timeout and statusMessage) and the http
 *     hook schema @208162216 (between timeout and headers). prompt/agent/
 *     mcp_tool schemas have NO onFailure.
 *   - `jIe` (isOnFailureBlock), `W_t` (source), `fXn` (reason), `G_t`
 *     (ignored events), `Zre` (block && !ignored), `z_t`/`jEt` (JSON already
 *     blocks), `q_t` (must-succeed), `K_t` (REPL transform), `V_t`
 *     (outside-REPL transform) @215472126-215474117.
 *   - K_t applied in the REPL aggregation loop @217875152 BEFORE the
 *     outcome tally; V_t applied per outside-REPL promise @217891418.
 *   - per-hook command branch `il`/`Il`/`jl` @217868823: when the hook must
 *     succeed and exited with a code other than 0/2, its parsed JSON output
 *     is DISCARDED (it cannot turn a failure into an approve/allow) unless
 *     the JSON already blocks; `continue:false` survives as
 *     preventContinuation/stopReason on the non_blocking_error result.
 *   - runner forceSyncExecution `Tt.type==="script"||Zre(Tt,he)` @217889674:
 *     an onFailure:"block" hook cannot escape into the background via a
 *     runtime `{"async":true}` announcement.
 *   - outside-REPL aborted results carry `...S?.aborted&&{cancelled:!0}`
 *     @217887827/217889674 so V_t can tell a user interrupt (skip) from a
 *     timeout (block).
 *
 * STAGED (not ported, flagged in the gap report):
 *   - the "personal" source path (`W_t` returning "personal") requires
 *     CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG, which OCC's `--restricted` mode
 *     has not landed yet — `RESTRICTED_PERSONAL_CONFIG` stays false and the
 *     structure is ported verbatim so the flag can flip later. Official
 *     `uXn` also contains "PreModelSwitch", an event OCC does not have.
 *   - the remoteCall/served-call path (`Et` at the official call site,
 *     feeding `fXn`'s second argument, the `Nmr`/`Fmr` relabel transforms
 *     and the `hC`/`jy` redaction of personal http hook labels) — OCC has
 *     no remoteCall surface.
 */
import type {
  HookEvent,
  HookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { HookResultMessage } from 'src/types/message.js'
import type {
  HookBlockingError,
  PermissionRequestResult,
} from '../../types/hooks.js'
import type { HookNonBlockingErrorAttachment } from '../attachments.js'
import { logForDebugging } from '../debug.js'

/**
 * Official `Jre` @215472126 — prefix the per-hook generator puts on the
 * attachment stderr for unexpected exit codes; K_t strips it back off so the
 * blocking message shows the hook's own stderr.
 */
const NON_BLOCKING_STATUS_PREFIX = 'Failed with non-blocking status code: '

/** Official `UIe` @215472126 — Gap-108d missing-script suffix; stripped. */
const TREATING_AS_NON_BLOCKING = 'Treating as non-blocking. '

/**
 * Official `G_t` @215472959 — events where onFailure:"block" is ignored
 * (the failure is reported but never blocks).
 */
export const ON_FAILURE_IGNORED_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'Stop',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
])

/**
 * Official `uXn` @215472444 — events whose personal hooks must succeed under
 * CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG. "PreModelSwitch" exists in the
 * official set but not in OCC's HookEvent union (omitted).
 */
const PERSONAL_MUST_SUCCEED_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'UserPromptExpansion',
])

/**
 * STAGED: official reads CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG here; OCC's
 * restricted-personal-config mode has not landed, so the "personal" source
 * path is dormant (see file header).
 */
const RESTRICTED_PERSONAL_CONFIG = false

/**
 * STAGED: official `Et` (remoteCall/served-call mode) at the K_t call site
 * @217875152; OCC has no remoteCall surface, so this stays false. It only
 * feeds `fXn`'s second argument and the stderr-extraction skip, both of
 * which are no-ops for the "setting" source.
 */
const REMOTE_CALL = false

/**
 * Structural shape covering every hook union member the transforms accept
 * (HookCommand | HookCallback | FunctionHook), so this module stays free of
 * an import cycle with utils/hooks.ts.
 */
export type OnFailureHookShape = {
  type: string
  onFailure?: 'continue' | 'block'
  async?: boolean
  asyncRewake?: boolean
  command?: string
  args?: string[]
  prompt?: string
  url?: string
  server?: string
  tool?: string
}

/** Official `W_t` return — why a hook failure blocks. */
export type HookFailureBlockSource = 'personal' | 'setting'

/**
 * Official `jIe` @215472126 verbatim:
 *   switch(e.type){case"command":return e.onFailure==="block"&&
 *     e.async!==!0&&e.asyncRewake!==!0;case"http":return e.onFailure===
 *     "block";default:return!1}
 * Async command hooks are excluded — onFailure is "ignored for async hooks".
 */
export function isOnFailureBlockHook(hook: OnFailureHookShape): boolean {
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
 * Official `W_t` @215472560 — the reason source, or undefined when this
 * hook's failures do not block. The "personal" branch requires the
 * restricted-personal-config mode (STAGED, always false in OCC today).
 */
export function getHookFailureBlockSource(
  hook: OnFailureHookShape,
  hookEvent: HookEvent,
  restrictedPersonalConfig: boolean = RESTRICTED_PERSONAL_CONFIG,
): HookFailureBlockSource | undefined {
  const isEligibleType =
    hook.type === 'http' ||
    (hook.type === 'command' &&
      hook.async !== true &&
      hook.asyncRewake !== true)
  if (
    restrictedPersonalConfig &&
    isEligibleType &&
    PERSONAL_MUST_SUCCEED_EVENTS.has(hookEvent)
  ) {
    return 'personal'
  }
  return isOnFailureBlockHook(hook) ? 'setting' : undefined
}

/**
 * Official `fXn` @215472862 verbatim:
 *   if(e==="setting")return'blocking because onFailure is "block"';
 *   return n?"blocking because this hook is required.":"blocking because it
 *   is one of the user's own hooks, ..."
 */
export function onFailureBlockReason(
  source: HookFailureBlockSource,
  remoteCall: boolean = REMOTE_CALL,
): string {
  if (source === 'setting') {
    return 'blocking because onFailure is "block"'
  }
  return remoteCall
    ? 'blocking because this hook is required.'
    : "blocking because it is one of the user's own hooks, which must succeed in this session (CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG is set). The user needs to fix or remove the hook; Claude should not change it."
}

/** Official `Zre` @215473044 — blocks on failure, and the event honors it. */
export function shouldBlockOnHookFailure(
  hook: OnFailureHookShape,
  hookEvent: HookEvent,
): boolean {
  return isOnFailureBlockHook(hook) && !ON_FAILURE_IGNORED_EVENTS.has(hookEvent)
}

/** Official `jEt` @213811212 — generic "this JSON output already blocks". */
function jsonOutputBlocksGeneric(json: HookJSONOutput): boolean {
  if ('decision' in json && json.decision === 'block') {
    return true
  }
  const specific =
    'hookSpecificOutput' in json
      ? (json.hookSpecificOutput as Record<string, unknown> | undefined)
      : undefined
  return (
    specific !== undefined &&
    typeof specific === 'object' &&
    specific !== null &&
    'permissionDecision' in specific &&
    specific.permissionDecision === 'deny'
  )
}

/**
 * Official `z_t` @215473079 — whether the parsed JSON output already blocks
 * the action itself (then discarding it would lose a legitimate block).
 * PermissionRequest checks hookSpecificOutput.decision.behavior==="deny";
 * every other event checks decision==="block" / permissionDecision==="deny".
 */
export function hookJsonOutputAlreadyBlocks(
  json: HookJSONOutput,
  hookEvent: HookEvent,
): boolean {
  if (hookEvent !== 'PermissionRequest') {
    return jsonOutputBlocksGeneric(json)
  }
  const specific =
    'hookSpecificOutput' in json
      ? (json.hookSpecificOutput as Record<string, unknown> | undefined)
      : undefined
  if (
    specific === undefined ||
    typeof specific !== 'object' ||
    specific === null ||
    !('decision' in specific)
  ) {
    return false
  }
  const decision = specific.decision as Record<string, unknown> | null
  return (
    typeof decision === 'object' &&
    decision !== null &&
    'behavior' in decision &&
    decision.behavior === 'deny'
  )
}

/** Official `q_t` @215472994 — this hook must succeed for the action. */
export function hookMustSucceed(
  hook: OnFailureHookShape,
  hookEvent: HookEvent,
  restrictedPersonalConfig: boolean = RESTRICTED_PERSONAL_CONFIG,
): boolean {
  return (
    shouldBlockOnHookFailure(hook, hookEvent) ||
    getHookFailureBlockSource(hook, hookEvent, restrictedPersonalConfig) ===
      'personal'
  )
}

/**
 * Official `lM` @213830943 — the raw hook label used in blocking messages
 * (deliberately NOT the statusMessage-preferring getHookDisplayText, and
 * command hooks include their exec-form args). 'script' omitted: OCC has no
 * script hook type.
 */
export function getOnFailureHookLabel(hook: OnFailureHookShape): string {
  switch (hook.type) {
    case 'command':
      return hook.args
        ? [hook.command, ...hook.args].join(' ')
        : (hook.command ?? '')
    case 'prompt':
    case 'agent':
      return hook.prompt ?? ''
    case 'http':
      return hook.url ?? ''
    case 'mcp_tool':
      return `${hook.server}/${hook.tool}`
    case 'callback':
      return 'callback'
    case 'function':
      return 'function'
    default:
      return ''
  }
}

/** Minimal per-hook result shape the REPL transform (K_t) operates on. */
export type OnFailureTransformableResult = {
  message?: HookResultMessage
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  permissionRequestResult?: PermissionRequestResult
  suppressOriginalPrompt?: boolean
  hook: OnFailureHookShape
}

/**
 * Official `K_t` @215473113 — REPL-path transform applied to every per-hook
 * result in the aggregation loop BEFORE the outcome tally (@217875152).
 * A cancelled (timed-out) or failed result from an onFailure:"block" hook
 * becomes a blocking result:
 *   `[<label>]: timed out|failed; blocking because onFailure is "block"\n<stderr detail>`
 * where the detail is the hook_non_blocking_error attachment stderr with the
 * "Failed with non-blocking status code: " prefix and the Gap-108d
 * "Treating as non-blocking. " suffix stripped. A user abort (signal already
 * aborted) is NOT a timeout and passes through unchanged. On ignored events
 * (G_t) the result passes through with a warn log.
 */
export function applyOnFailureBlockTransform<
  T extends OnFailureTransformableResult,
>(result: T, hookEvent: HookEvent, signal?: AbortSignal): T {
  const source = getHookFailureBlockSource(result.hook, hookEvent)
  if (source === undefined) {
    return result
  }
  const failureKind =
    result.outcome === 'cancelled' && signal?.aborted !== true
      ? 'timed out'
      : result.outcome === 'non_blocking_error'
        ? 'failed'
        : undefined
  if (failureKind === undefined) {
    return result
  }
  if (ON_FAILURE_IGNORED_EVENTS.has(hookEvent)) {
    logForDebugging(
      `Hooks: ${hookEvent} ${result.hook.type} hook ${failureKind}; not blocking (onFailure: "block" is ignored on ${hookEvent})`,
      { level: 'warn' },
    )
    return result
  }
  // Official: H = personal-http redacted url (jy); STAGED — always undefined
  // in OCC, so G = lM(hook) and the detail is used unredacted (hC skipped).
  const command = getOnFailureHookLabel(result.hook)
  // The Message union types attachment loosely ({type: string; [key: string]:
  // unknown}), so narrow via the concrete attachment type + a runtime guard.
  const attachment =
    result.message?.type === 'attachment'
      ? (result.message.attachment as Partial<HookNonBlockingErrorAttachment> & {
          type: string
        })
      : undefined
  const rawStderr =
    !REMOTE_CALL &&
    attachment?.type === 'hook_non_blocking_error' &&
    typeof attachment.stderr === 'string'
      ? attachment.stderr.trim()
      : ''
  const detail = (
    rawStderr.startsWith(NON_BLOCKING_STATUS_PREFIX)
      ? rawStderr.slice(NON_BLOCKING_STATUS_PREFIX.length)
      : rawStderr
  ).replace(TREATING_AS_NON_BLOCKING, '')
  const blockingError = `[${command}]: ${failureKind}; ${onFailureBlockReason(source)}${detail === '' ? '' : `\n${detail}`}`
  logForDebugging(
    `Hooks: ${hookEvent} ${result.hook.type} hook ${failureKind}; blocking (${
      source === 'personal'
        ? 'personal hook, CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG'
        : 'onFailure: "block"'
    })`,
    { level: 'warn' },
  )
  return {
    ...result,
    message: undefined,
    blockingError: { blockingError, command },
    ...(hookEvent === 'PermissionRequest'
      ? {
          permissionRequestResult: {
            behavior: 'deny',
            message: blockingError,
          } as PermissionRequestResult,
        }
      : {}),
    suppressOriginalPrompt: true,
    outcome: 'blocking' as const,
  } as T
}

/** Minimal outside-REPL result shape the V_t transform operates on. */
export type OnFailureOutsideReplResult = {
  succeeded: boolean
  output: string
  blocked: boolean
  cancelled?: boolean
}

/**
 * Official `V_t` @215473943 verbatim:
 *   if(!jIe(e)||n.succeeded||n.blocked||n.cancelled===!0)return n;
 *   let r=n.output==="Hook cancelled",s=r?"":n.output.trim();
 *   return{...n,blocked:!0,output:`${r?"timed out":"failed"}; blocking
 *   because onFailure is "block"${s===""?"":`\n${s}`}`}
 * `cancelled:true` (user interrupt on the parent signal) skips the block;
 * a timeout ("Hook cancelled" without cancelled) blocks as "timed out".
 */
export function applyOnFailureBlockOutsideRepl<
  T extends OnFailureOutsideReplResult,
>(hook: OnFailureHookShape, result: T): T {
  if (
    !isOnFailureBlockHook(hook) ||
    result.succeeded ||
    result.blocked ||
    result.cancelled === true
  ) {
    return result
  }
  const timedOut = result.output === 'Hook cancelled'
  const detail = timedOut ? '' : result.output.trim()
  return {
    ...result,
    blocked: true,
    output: `${timedOut ? 'timed out' : 'failed'}; blocking because onFailure is "block"${detail === '' ? '' : `\n${detail}`}`,
  }
}
