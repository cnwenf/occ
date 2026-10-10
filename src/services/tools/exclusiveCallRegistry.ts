import { logForDebugging } from '../../utils/debug.js';

/**
 * Official 2.1.295 (#026): `exclusiveCallQueuedBehind` — global registry
 * (binary: `Gn().exclusiveCallQueuedBehind=new Map`) keyed by tool-use id,
 * populated by the streaming tool executor for every executing tool call
 * (binary `executeTool`: `T.set(e.id,C)` with a `using`-disposal that only
 * deletes when the entry is still the same object).
 *
 * An entry describes whether a tool call that must run alone (an edit or a
 * shell command — anything non-concurrency-safe) is queued behind this call
 * in the same executor, or may yet be queued because the model response is
 * still streaming. The automatic move-to-background of a subagent consults
 * it so the subagent is NOT backgrounded while such a call waits behind its
 * Agent call (which would start that call before the subagent finished).
 */
export type ExclusiveCallHold = {
  /** True when a queued, non-concurrency-safe call sits behind this call. */
  isQueued(): boolean;
  /** True while the response is still open and more exclusive calls may arrive. */
  mayYetBeQueued(): boolean;
  /** One-shot latch for the "stays in the foreground" debug log (binary: `holdLogged`). */
  holdLogged: boolean;
};

const exclusiveCallQueuedBehind = new Map<string, ExclusiveCallHold>();

export function setExclusiveCallQueuedBehind(
  toolUseId: string,
  hold: ExclusiveCallHold,
): void {
  exclusiveCallQueuedBehind.set(toolUseId, hold);
}

export function clearExclusiveCallQueuedBehind(
  toolUseId: string,
  hold: ExclusiveCallHold,
): void {
  // Binary disposal guard: `if(T.get(e.id)===C)T.delete(e.id)` — never clobber
  // a newer entry registered for the same tool-use id.
  if (exclusiveCallQueuedBehind.get(toolUseId) === hold) {
    exclusiveCallQueuedBehind.delete(toolUseId);
  }
}

export function getExclusiveCallQueuedBehind(
  toolUseId: string,
): ExclusiveCallHold | undefined {
  return exclusiveCallQueuedBehind.get(toolUseId);
}

/**
 * Why an automatic move-to-background is on hold for a local-agent task.
 * Binary: `Awn` returns "call_queued_behind" | "response_streaming" | undefined.
 */
export type AutoBackgroundHoldReason =
  | 'call_queued_behind'
  | 'response_streaming';

/** The task fields the binary `Awn` reads off a local-agent task. */
export type AutoBackgroundHoldTaskView = {
  id: string;
  status: string;
  isBackgrounded: boolean;
  toolUseId?: string;
};

/**
 * Binary (verbatim semantics):
 *   function Awn(e){
 *     if(e.status!=="running"||e.isBackgrounded||e.toolUseId===void 0)return;
 *     let n=Gn().exclusiveCallQueuedBehind.get(e.toolUseId);
 *     if(n===void 0)return;
 *     if(!n.isQueued())return n.mayYetBeQueued()?"response_streaming":void 0;
 *     if(!n.holdLogged)n.holdLogged=!0,t(`[local-agent] subagent ${e.id} stays
 *       in the foreground: no automatic move to the background while a tool
 *       call that must run alone is queued behind its Agent call ${e.toolUseId}`),
 *       f("task_local_agent_auto_background","call_queued_behind");
 *     return"call_queued_behind"}
 *
 * The binary's `f(...)` analytics counter is dropped (OCC analytics are
 * empty-impl and this path logs no events today); the one-shot debug log is
 * kept byte-identical.
 */
export function getAutoBackgroundHoldReason(
  task: AutoBackgroundHoldTaskView,
): AutoBackgroundHoldReason | undefined {
  if (
    task.status !== 'running' ||
    task.isBackgrounded ||
    task.toolUseId === undefined
  ) {
    return undefined;
  }
  const hold = exclusiveCallQueuedBehind.get(task.toolUseId);
  if (hold === undefined) {
    return undefined;
  }
  if (!hold.isQueued()) {
    return hold.mayYetBeQueued() ? 'response_streaming' : undefined;
  }
  if (!hold.holdLogged) {
    hold.holdLogged = true;
    logForDebugging(
      `[local-agent] subagent ${task.id} stays in the foreground: no automatic move to the background while a tool call that must run alone is queued behind its Agent call ${task.toolUseId}`,
    );
  }
  return 'call_queued_behind';
}

/** Binary: `a9r(e){return Awn(e)!==void 0}`. */
export function hasAutoBackgroundHold(
  task: AutoBackgroundHoldTaskView,
): boolean {
  return getAutoBackgroundHoldReason(task) !== undefined;
}

/** Test helper — drop all registry entries. */
export function _resetExclusiveCallRegistryForTesting(): void {
  exclusiveCallQueuedBehind.clear();
}
