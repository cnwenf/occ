/**
 * Official Claude Code 2.1.285 (OCC-102 #85): background shell deadline reap.
 * Byte-faithful port of the v285 linux-x64 ELF constants, gates, calculator
 * and stop-cause message tables. Evidence offsets (v285 binary):
 *
 * ```js
 * // constants (@201231000):
 * var Me=120000,Ne=600000;
 * function the(e=process.env){...BASH_DEFAULT_TIMEOUT_MS...return Me}   // getDefaultBashTimeoutMs
 * function nhe(e=process.env){...BASH_MAX_TIMEOUT_MS...}                // getMaxBashTimeoutMs
 * var d5e=1800000;
 * function Zee(){return Math.min(Math.max(7200000,nhe()),2147483647)}
 * function VTo(e){return Math.max(d5e,the(e))}
 *
 * // gates + calculator (@202100341):
 * function Nan(){return!LH().backgroundDeadlineDisabled}
 * function gHr(){return Nan()&&x("tengu_cosmic_shore",!0)}
 * function c2n(e){if(!gHr())return;return Math.min(e??VTo(),Zee())}
 *
 * // stop-cause message tables (@203048512):
 * var X9={memory_pressure:"stopped because the system is running low on memory",
 *         deadline:"stopped after reaching its background time limit"}
 * var Q9={memory_pressure:"This is not a failure of the command. ...",
 *         deadline:"If the work in progress still needs it, start it again with
 *           `run_in_background` and a longer `timeout`. ..."}
 *
 * // schema description functions (@202100341 region):
 * function $an(){return Nan()?`Set to true to run this command in the background.
 *   With it, \`timeout\` limits how long the command may run in the background
 *   before it is stopped (default ${d5e} ms, max ${Zee()} ms).`
 *   :"Set to true to run this command in the background."}
 * function Fan(){return Nan()?` With \`run_in_background\` the timeout is instead
 *   how long the command may run in the background (default ${d5e}ms /
 *   ${d5e/60000} minutes, max ${Zee()}ms / ${Zee()/3600000} hours); at that
 *   limit it is stopped and you are notified.`:""}
 * ```
 *
 * OCC divergences (documented, not guessed):
 * - `LH().backgroundDeadlineDisabled` is a session capability on the official
 *   ALS host-context class (ZKn @199796627), set by SDK/Cloud hosts. OCC has
 *   no ALS host context — the capability is a module-level flag defaulting to
 *   enabled (deadline active), with a setter for host/embedder use.
 * - `x("tengu_cosmic_shore",!0)` is a GrowthBook gate defaulting TRUE; OCC's
 *   GrowthBook is stubbed (empty implementation), so the gate folds to its
 *   default and `isBackgroundDeadlineEnabled()` === the capability check.
 * - The X9/Q9 `memory_pressure` entries have NO OCC producer (the official
 *   pressure-reap subsystem gated on `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`
 *   + `process.on("memoryPressure")` stays staged per the 2.1.280 #042 ledger
 *   note). They are ported verbatim so the tables are byte-complete and the
 *   producer can land without touching this file. Only `deadline` is produced.
 */

import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'

/** Official `d5e` (@201231346) — 30 minutes. */
export const BACKGROUND_DEADLINE_DEFAULT_MS = 1_800_000

/** Official `Zee()` hard ceiling constant — largest setTimeout delay (2^31-1). */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Official `Zee()` floor — 2 hours, or BASH_MAX_TIMEOUT_MS when larger. */
const BACKGROUND_DEADLINE_CAP_FLOOR_MS = 7_200_000

/** Stop causes with official X9/Q9 message-table entries. */
export type ShellStopCause = 'memory_pressure' | 'deadline'

/**
 * Official `X9` (@203048512) — killed-summary fragments. Rendered by the
 * official `e2e` killed branch: `` `${Obe}"${n}" was ${S?X9[S]:"stopped"}` ``.
 */
export const BACKGROUND_STOP_CAUSE_SUMMARY: Record<ShellStopCause, string> = {
  memory_pressure: 'stopped because the system is running low on memory',
  deadline: 'stopped after reaching its background time limit',
}

/**
 * Official `Q9` (@203049400) — guidance notes appended to the task
 * notification body inside `<note>` (official `xj="note"` @195567729,
 * rendered by `tIt`: ``body:`${w?`\n<${xj}>${Wt(Q9[w])}</${xj}>`:""}...` ``).
 */
export const BACKGROUND_STOP_CAUSE_NOTE: Record<ShellStopCause, string> = {
  memory_pressure:
    'This is not a failure of the command. Claude Code stopped it because the system was critically low on memory while the session was idle, which says nothing about the command or its own memory use, so there is nothing in it to debug. Do not start it again on your own, even if the work seems to need it: memory may still be short. Report what was stopped and why, and start it again only when asked. The user can turn this behavior off by starting Claude Code with CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1 in its environment; setting it from a shell command has no effect.',
  deadline:
    'If the work in progress still needs it, start it again with `run_in_background` and a longer `timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report that it was stopped.',
}

// Official `LH().backgroundDeadlineDisabled` — session capability, host-set.
// OCC module-level equivalent (see header divergence note). Default: enabled.
let backgroundDeadlineDisabled = false

/**
 * Host/embedder switch for the official `backgroundDeadlineDisabled` session
 * capability (ZKn @199796627). SDK/Cloud hosts set this to exempt managed
 * sessions from the reap.
 */
export function setBackgroundDeadlineDisabled(disabled: boolean): void {
  backgroundDeadlineDisabled = disabled
}

/** Official `Nan()` — capability check. */
export function isBackgroundDeadlineCapable(): boolean {
  return !backgroundDeadlineDisabled
}

/**
 * Official `gHr()` = `Nan() && x("tengu_cosmic_shore", !0)`. The GrowthBook
 * gate defaults TRUE and OCC's GrowthBook is stubbed, so this folds to the
 * capability check (documented divergence).
 */
export function isBackgroundDeadlineEnabled(): boolean {
  return isBackgroundDeadlineCapable()
}

/**
 * Official `Zee()` — deadline cap: min(max(2h, BASH_MAX_TIMEOUT_MS), 2^31-1).
 */
export function backgroundDeadlineCapMs(): number {
  return Math.min(
    Math.max(BACKGROUND_DEADLINE_CAP_FLOOR_MS, getMaxBashTimeoutMs()),
    MAX_TIMER_DELAY_MS,
  )
}

/**
 * Official `VTo()` (no-arg form used by `c2n`) — deadline floor:
 * max(30min, BASH_DEFAULT_TIMEOUT_MS).
 */
export function backgroundDeadlineFloorMs(): number {
  return Math.max(BACKGROUND_DEADLINE_DEFAULT_MS, getDefaultBashTimeoutMs())
}

/**
 * Official `c2n(e)` — the deadline for a backgrounded shell:
 * `if(!gHr())return;return Math.min(e??VTo(),Zee())`.
 *
 * `requestedTimeoutMs` is the Bash tool's raw `timeout` input when the command
 * was spawned with `run_in_background` (official `mke` passes it through to
 * `mrn` → `c2n(S)`); foreground→background transitions pass `undefined`
 * (official `Utn`: `mrn(e,r,s,g,void 0,w)`), yielding the 30-minute default.
 * Returns `undefined` when the subsystem is disabled (no timer is armed).
 */
export function computeBackgroundDeadlineMs(
  requestedTimeoutMs?: number,
): number | undefined {
  if (!isBackgroundDeadlineEnabled()) {
    return undefined
  }
  return Math.min(
    requestedTimeoutMs ?? backgroundDeadlineFloorMs(),
    backgroundDeadlineCapMs(),
  )
}

/**
 * Official `$an()` — `run_in_background` schema description. The disabled
 * branch keeps OCC's existing sentence ("Use Read to read the output later.")
 * instead of the official bare text — a pre-existing OCC surface difference
 * preserved deliberately; the enabled branch is official-verbatim with the
 * computed values inlined.
 */
export function runInBackgroundDescription(): string {
  return isBackgroundDeadlineCapable()
    ? `Set to true to run this command in the background. With it, \`timeout\` limits how long the command may run in the background before it is stopped (default ${BACKGROUND_DEADLINE_DEFAULT_MS} ms, max ${backgroundDeadlineCapMs()} ms).`
    : 'Set to true to run this command in the background. Use Read to read the output later.'
}

/**
 * Official `Fan()` — sentence appended to the run_in_background prompt usage
 * note (official `smt()` @203853400 ends with `${Fan()}`). Empty string when
 * the capability is off.
 */
export function backgroundTimeoutUsageNote(): string {
  return isBackgroundDeadlineCapable()
    ? ` With \`run_in_background\` the timeout is instead how long the command may run in the background (default ${BACKGROUND_DEADLINE_DEFAULT_MS}ms / ${BACKGROUND_DEADLINE_DEFAULT_MS / 60000} minutes, max ${backgroundDeadlineCapMs()}ms / ${backgroundDeadlineCapMs() / 3600000} hours); at that limit it is stopped and you are notified.`
    : ''
}
