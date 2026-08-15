/**
 * 2.1.233 alignment (OCC-95): permission-prompt Notification hooks.
 *
 * When the CLI waits on a permission prompt over the structured-IO
 * (can_use_tool) path, the official binary schedules a Notification hook —
 * message `Claude needs your permission to use <tool>`, notification type
 * `permission_prompt` — that fires once the prompt has gone unanswered for
 * 6 seconds, so hook-driven hosts can react (page the user, ping a channel).
 * The returned closure cancels the timer and is invoked on every settle path
 * of the permission request (binary: `R.then(k, k)` on the can_use_tool
 * site, try/finally on the SandboxNetworkAccess site).
 *
 * Ported from the official 2.1.233 linux-x64 ELF (byte-verified):
 *
 *   function pkc(e){
 *     if(V.CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS)return()=>{};
 *     let t=setTimeout((r)=>{
 *       $V({id:qt(),project:{originalCwd:En(),projectRoot:Va()}},
 *          {message:`Claude needs your permission to use ${r}`,
 *           notificationType:"permission_prompt"}).catch(()=>{})
 *     },Qwn,e);
 *     return t.unref(),()=>clearTimeout(t)
 *   }
 *
 * with `Qwn=6000` and the display-name helper
 *
 *   function vPe(e){return(e.split("__").pop()||e).replace(/_/g," ")
 *     .replace(/\b\w/g,(r)=>r.toUpperCase())}
 *
 * Mapping: `$V` ≡ executeNotificationHooks (OCC builds the hook base input
 * internally; the official's first-arg context `{id, project}` is not part
 * of OCC's notification hook payload surface); `V` ≡ process.env (raw
 * truthy check — the binary uses no bool() parser here, so ANY non-empty
 * value, including "0"/"false", disables); `setTimeout(cb, Qwn, e)` passes
 * the tool display name through as the timer argument; `t.unref()` keeps
 * the timer from holding the process open.
 *
 * `delayMs` is a defaulted final parameter (production callers never pass it)
 * so tests can exercise the timer without waiting 6 seconds.
 */

import { executeNotificationHooks } from './hooks.js'

// binary Qwn — prompt-unanswered threshold before hooks are notified
const PERMISSION_PROMPT_NOTIFY_DELAY_MS = 6000

/**
 * Binary `vPe` — human-readable tool name for notification text: last
 * `__`-separated segment, underscores to spaces, each word's first char
 * uppercased (never lowercased — interior capitals survive):
 * `mcp__server__tool_name` → `Tool Name`, `WebFetch` → `WebFetch`.
 */
export function getToolDisplayName(toolName: string): string {
  return (toolName.split('__').pop() || toolName)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

/**
 * Binary `pkc`. The caller passes the ALREADY-FORMATTED display name —
 * both official call sites are `pkc(vPe(toolName))`. Schedules the
 * Notification hook and returns a cancel closure. Never throws; the hook
 * itself is fire-and-forget (official `.catch(() => {})`).
 */
export function schedulePermissionPromptNotifyHook(
  toolDisplayName: string,
  delayMs: number = PERMISSION_PROMPT_NOTIFY_DELAY_MS,
): () => void {
  // Raw truthy env check — byte-equivalent to the binary's `if(V.X)`.
  if (process.env.CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS) {
    return () => {}
  }
  const timer = setTimeout((displayName: string) => {
    executeNotificationHooks({
      message: `Claude needs your permission to use ${displayName}`,
      notificationType: 'permission_prompt',
    }).catch(() => {})
  }, delayMs, toolDisplayName)
  timer.unref()
  return () => clearTimeout(timer)
}
