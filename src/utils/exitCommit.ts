/**
 * Process exit-commit flag.
 *
 * Official 2.1.285 (#54): the binary grows a dedicated exit-commit module
 * (chunk-anfpa5zs @201263005, "// Version: 2.1.285"):
 *
 *   class t{committed=!1}var e=new t;
 *   function eo(){return e.committed}   // isExitCommitted
 *   function ane(){e.committed=!0}      // commitExit
 *   var n=new Promise(()=>{});function a_(){return n}
 *   export{eo,ane,a_};
 *
 * `commitExit()` (official `ane`) is called from the shutdown manager's
 * `shutdown()`/`shutdownSync()` (@202994960/@202997754 — `this.shutdownInProgress=!0,ane()`),
 * the SDK SIGTERM handler (@221387265), the managed-settings dialog rejection
 * path (@211315169) and the settings-helper refuse path (@212422543). OCC's
 * equivalent commit points are `gracefulShutdown()`/`gracefulShutdownSync()`;
 * the managed-settings/settings-helper/SDK-SIGTERM call sites have no OCC
 * surface (no managed-settings security dialog, no SDK bridge parking) — see
 * docs/upstream-version-gap-occ102-2026-10.md §4 (#54).
 *
 * `a_()` (never-resolving promise used by the official to park the SDK
 * bridge after commit) is NOT ported: OCC has no SDK-bridge parking call
 * site, so there is nothing to wire it into (NO-OP by surface absence).
 *
 * The flag is consumed by the max_turns_reached persistence stamp
 * (`QueryEngine` attachment record path, official `GP` @221287457) and —
 * on resume — by the conversationRecovery classifier (official `V4o`).
 */

class ExitCommitState {
  committed = false
}

const exitCommitState = new ExitCommitState()

/** Official `eo()` — whether the process has committed to exiting. */
export function isExitCommitted(): boolean {
  return exitCommitState.committed
}

/** Official `ane()` — mark the process as committed to exiting. */
export function commitExit(): void {
  exitCommitState.committed = true
}

/** Test-only reset (mirrors resetShutdownState in gracefulShutdown.ts). */
export function resetExitCommitForTesting(): void {
  exitCommitState.committed = false
}
