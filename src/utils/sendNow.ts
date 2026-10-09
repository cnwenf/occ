/**
 * CC 2.1.275 (ITEM O): "send-now key" — pure core.
 *
 * Added a send-now key (ctrl+enter, or ctrl+x ctrl+s) that interrupts the
 * current turn and sends all queued messages at once; a ctrl+x enter
 * queue-submit binding, an empty-Enter flush gesture, and a dimmed footer
 * hint round it out.
 *
 * Byte-faithful port of the official v2.1.276 binary logic (all offsets into
 * /tmp/cc-diff-276/v276/package/claude):
 *   - F$t flush core            @217111100  ("nothing_to_send" |
 *                               "no_live_controller" | "cancelled")
 *   - O$t sendQueuedNow         @217111400  (input_send_now_key event)
 *   - L$t submitEmpty           @217111250  (input_send_queued_now event,
 *                               gated by tengu_jiggly_mochi @216671717)
 *   - Gln/lu/qm queue filters   @196637403/@195480108/@196622091
 *   - zvt hint predicate        @216606400
 *   - WOe/kvo/vvo chord pick    @216602629
 *
 * CC 2.1.293 (L28 Phase 1) updates the KEY gesture to the official
 * Cst/Tst/_st shape (v2.1.293 binary, Cst @234772005, NSn flag @214600349 —
 * `tengu_velvet_panda`, default true): when the gate is on and an optional
 * `deliverWithoutCancel` dep succeeds, the queued messages are delivered
 * WITHOUT interrupting the live turn; otherwise the pre-existing flush core
 * runs as the `_st` fallback and a successful cancel logs the
 * `fell_back_to_cancel` reason. The empty-Enter gesture (vst) is UNCHANGED in
 * 293 (byte-verified). Low-latency engine phases 2-4 stay staged — see the
 * ledger in docs/gap-research-293/cluster-c-h-carryover.md §L28.
 *
 * The flush does NOT dispatch the queue itself: interrupting the running turn
 * (abort with reason 'user-cancel') ends it, queryGuard goes idle, and the
 * existing useQueueProcessor drains the queue automatically — exactly the
 * official control flow.
 *
 * Kept as a standalone pure module (no React, no heavy imports) so it is
 * unit-testable in isolation, matching the resumeFailureGate.ts /
 * escEscGate.ts convention.
 */

import type { QueuedCommand } from '../types/textInputTypes.js'
import { chordToDisplayString } from '../keybindings/parser.js'
import { supportsExtendedKeys } from '../ink/terminal.js'
import { getPlatform } from './platform.js'
import { isQueuedCommandEditable } from './messageQueueManager.js'

// ---------------------------------------------------------------------------
// Byte-exact strings extracted from the official binary (never invented).
// ---------------------------------------------------------------------------

/** Analytics event fired when the send-now KEY flush succeeds (O$t @217111400). */
export const SEND_NOW_KEY_EVENT = 'input_send_now_key'
/** Analytics event fired when the empty-Enter flush succeeds (L$t @217111250). */
export const SEND_QUEUED_NOW_EVENT = 'input_send_queued_now'
/** Reason string for the no-interruptible-controller failure (string pool @92583600). */
export const NO_LIVE_CONTROLLER_REASON = 'no_live_controller'
/** tengu_cancel source for the send-now interrupt (F$t @217111100). */
export const QUEUED_SEND_NOW_SOURCE = 'queued_send_now'
/** Keybinding action name (allowlist Lme @195284784). */
export const SEND_NOW_ACTION = 'chat:sendNow'
/** Keybinding context the send-now action lives in. */
export const SEND_NOW_CONTEXT = 'Chat'
/** Hint label (XOe @216607150: action:"send now"). */
export const SEND_NOW_HINT_ACTION = 'send now'
/** Hint box paddingLeft (XOe @216607150: paddingLeft:2). */
export const SEND_NOW_HINT_PADDING_LEFT = 2
/** GrowthBook gate for the empty-Enter flush only (Oae @216671717). */
export const SEND_NOW_EMPTY_ENTER_GATE = 'tengu_jiggly_mochi'
/**
 * CC 2.1.293 L28 Phase 1 — GrowthBook gate for the deliver-without-cancel
 * send-now flush (official NSn @214600349: `T("tengu_velvet_panda",!0)`,
 * default TRUE).
 */
export const SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE = 'tengu_velvet_panda'
/**
 * CC 2.1.293 L28 Phase 1 — telemetry reason when the gated flush could not
 * deliver without cancelling and fell back to the interrupt core (official
 * Cst @234772005: `p("input_send_now_key","fell_back_to_cancel")`).
 */
export const FELL_BACK_TO_CANCEL_REASON = 'fell_back_to_cancel'
/** Interrupt reason — official interruptForSubmit aborts with oc("user-cancel") @217190800. */
export const SEND_NOW_ABORT_REASON = 'user-cancel'

// ---------------------------------------------------------------------------
// Structural types (src/keybindings/types.ts is an all-`any` generated stub,
// so the shapes actually consumed here are declared locally).
// ---------------------------------------------------------------------------

/** One keystroke of a parsed chord — mirrors keybindings ParsedKeystroke shape. */
export interface SendNowKeystroke {
  readonly key: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
  readonly meta?: boolean
  readonly super?: boolean
}

/** One parsed keybinding — mirrors keybindings ParsedBinding shape. */
export interface SendNowBinding {
  readonly chord: readonly SendNowKeystroke[]
  readonly action: string
  readonly context: string
}

/** Outcome of the flush core (F$t @217111100). */
export type SendNowFlushOutcome =
  | 'nothing_to_send'
  | 'no_live_controller'
  | 'cancelled'

/** Injected dependencies for the flush core — keeps the module pure/testable. */
export interface SendNowFlushDeps {
  /** Current prompt input mode; only 'prompt' may flush (official h.mode??"prompt"). */
  readonly mode: string | undefined
  /** Whether the main query loop is running (official h.turn.guard.isActive). */
  readonly isQueryActive: boolean
  /** Current command queue snapshot (official h.queue). */
  readonly queue: readonly QueuedCommand[]
  /** Aborts the live turn with 'user-cancel'; false if no live controller. */
  readonly interruptRunningTurn: () => boolean
  /** tengu_cancel telemetry with source 'queued_send_now' (C2o @217111200). */
  readonly onCancelTelemetry: () => void
  /** Flush-event telemetry; reason set for no_live_controller / fell_back_to_cancel. */
  readonly logFlushEvent: (event: string, reason?: string) => void
  /**
   * CC 2.1.293 L28 Phase 1 — optional low-latency delivery (official
   * `h.deliverWithoutCancel()`, Cst @234772005; upstream wires it to the
   * lowLatency engine `EIt.sendQueuedNow`). Returns true when the eligible
   * queued messages were delivered WITHOUT interrupting the running turn.
   * OCC Phase 1 ships no low-latency engine yet, so the REPL leaves this
   * undefined and every flush lands on the Drt/_st fallback core below.
   *
   * Phases 2-4 stay STAGED — ledger:
   * docs/gap-research-293/cluster-c-h-carryover.md §L28 "Verdict + phased
   * port plan" (Phase 2: queue promoteToNow/demoteFromNow + 'now' priority +
   * Fo head-state machine; Phase 3: tool-detach registry backgroundNow +
   * task backgrounding; Phase 4: CCR control-request send_now — blocked on
   * the frame-intake subsystem).
   */
  readonly deliverWithoutCancel?: () => boolean
}

// ---------------------------------------------------------------------------
// Queue eligibility (official Gln/lu/qm @196637403/@195480108/@196622091)
// ---------------------------------------------------------------------------

/**
 * lu&&qm: a queued command counts toward send-now only when it belongs to the
 * main thread (agentId undefined) and is editable (not task-notification mode,
 * not isMeta). Official also filters origin/screening-gated commands; OCC's
 * isQueuedCommandEditable is the established equivalent (see deviation notes).
 */
export function isSendNowEligible(cmd: QueuedCommand): boolean {
  return cmd.agentId === undefined && isQueuedCommandEditable(cmd)
}

/** Gln: does the queue hold at least one send-now-eligible command? */
export function hasSendNowEligibleCommands(
  queue: readonly QueuedCommand[],
): boolean {
  return queue.some(isSendNowEligible)
}

// ---------------------------------------------------------------------------
// Flush core (F$t/O$t/L$t @217111100-217111700; 293 Cst/Tst/_st @234772005)
// ---------------------------------------------------------------------------

/**
 * Tst (2.1.293) ≡ Ert: the send-now flush guard — prompt mode, a live turn,
 * and at least one eligible queued command. Official verbatim:
 *   `function Tst(h){return(h.mode??"prompt")==="prompt"&&h.turn.guard.isActive&&vnr(h.queue)}`
 * (h.turn.guard.isActive ≡ deps.isQueryActive; vnr ≡ hasSendNowEligibleCommands.)
 */
export function isSendNowFlushable(deps: SendNowFlushDeps): boolean {
  return (
    (deps.mode ?? 'prompt') === 'prompt' &&
    deps.isQueryActive &&
    hasSendNowEligibleCommands(deps.queue)
  )
}

/**
 * _st (2.1.293) ≡ Drt ≡ F$t: guard → interrupt → cancel telemetry. Pure;
 * side effects only through injected deps, in official order (interrupt
 * BEFORE tengu_cancel). Kept as the fallback core of the 293 key handler —
 * the official kept this exact function as the `Drt` fallback of `Cst`.
 */
export function flushQueuedMessagesCore(
  deps: SendNowFlushDeps,
): SendNowFlushOutcome {
  if (!isSendNowFlushable(deps)) {
    return 'nothing_to_send'
  }
  if (!deps.interruptRunningTurn()) {
    return 'no_live_controller'
  }
  deps.onCancelTelemetry()
  return 'cancelled'
}

/**
 * Cst (2.1.293, ≡ Irt) — send-now KEY gesture. Official verbatim @234772005:
 *
 *   function Cst(h){let k=NSn();
 *    if(k&&Tst(h)&&h.deliverWithoutCancel())return y("input_send_now_key"),!0;
 *    switch(_st(h)){
 *     case"cancelled":if(k)p("input_send_now_key","fell_back_to_cancel");
 *      else y("input_send_now_key");return!0;
 *     case"no_live_controller":return p("input_send_now_key","no_live_controller"),!1;
 *     case"nothing_to_send":return!1}}
 *   NSn(){return T("tengu_velvet_panda",!0)}   // @214600349, default TRUE
 *
 * OCC deviations (documented):
 *   - `k` is injected as `deliverWithoutCancelGateEnabled` (default true,
 *     matching the official NSn default) instead of read inside the function —
 *     same pure-module convention as sendQueuedNowOnEmptyEnter/`gateEnabled`;
 *     the REPL reads SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE from
 *     getFeatureValue_CACHED_MAY_BE_STALE at call time.
 *   - `h.deliverWithoutCancel` is OPTIONAL (official always wires it to the
 *     lowLatency engine `EIt`, which OCC lacks until Phases 2-4 — staged per
 *     docs/gap-research-293/cluster-c-h-carryover.md §L28); when absent, the
 *     guarded deliver arm is skipped and the flush always takes the _st
 *     fallback, so a successful cancel logs `fell_back_to_cancel`.
 *
 * This REPLACES the 2.1.276 O$t handler (`flushQueuedMessagesCore` +
 * unconditional no-reason event).
 */
export function sendQueuedNow(
  deps: SendNowFlushDeps,
  deliverWithoutCancelGateEnabled = true,
): boolean {
  if (
    deliverWithoutCancelGateEnabled &&
    isSendNowFlushable(deps) &&
    deps.deliverWithoutCancel !== undefined &&
    deps.deliverWithoutCancel()
  ) {
    deps.logFlushEvent(SEND_NOW_KEY_EVENT)
    return true
  }
  const outcome = flushQueuedMessagesCore(deps)
  if (outcome === 'cancelled') {
    if (deliverWithoutCancelGateEnabled) {
      deps.logFlushEvent(SEND_NOW_KEY_EVENT, FELL_BACK_TO_CANCEL_REASON)
    } else {
      deps.logFlushEvent(SEND_NOW_KEY_EVENT)
    }
    return true
  }
  if (outcome === 'no_live_controller') {
    deps.logFlushEvent(SEND_NOW_KEY_EVENT, NO_LIVE_CONTROLLER_REASON)
    return false
  }
  return false
}

/**
 * L$t: empty-Enter gesture — same core, but gated by tengu_jiggly_mochi and
 * emitting 'input_send_queued_now'. The gate is read at call time (official
 * Oae() checks GrowthBook inside L$t).
 */
export function sendQueuedNowOnEmptyEnter(
  deps: SendNowFlushDeps,
  gateEnabled: boolean,
): boolean {
  if (!gateEnabled) {
    return false
  }
  const outcome = flushQueuedMessagesCore(deps)
  if (outcome === 'cancelled') {
    deps.logFlushEvent(SEND_QUEUED_NOW_EVENT)
    return true
  }
  if (outcome === 'no_live_controller') {
    deps.logFlushEvent(SEND_QUEUED_NOW_EVENT, NO_LIVE_CONTROLLER_REASON)
    return false
  }
  return false
}

// ---------------------------------------------------------------------------
// Handler decision helpers (official Zxt @216697952 / mRo @216688100 caller
// conditions), extracted pure so PromptInput wiring stays thin and testable.
// ---------------------------------------------------------------------------

/** What the send-now key handler should do, per official Zxt branching. */
export type SendNowKeyAction = 'noop' | 'flush' | 'submit-then-maybe-flush'

/**
 * Zxt decision: with draft content the handler submits (queue path) and then
 * conditionally flushes; with an empty draft it flushes only for a leader
 * prompt; otherwise it is a no-op. OCC has no queueEditIndex state, so that
 * official clause drops out (documented deviation).
 */
export function resolveSendNowKeyAction(args: {
  readonly hasContent: boolean
  readonly isLeaderSubmit: boolean
}): SendNowKeyAction {
  if (args.hasContent) {
    return 'submit-then-maybe-flush'
  }
  return args.isLeaderSubmit ? 'flush' : 'noop'
}

/**
 * Zxt .then guard: flush after the queue-submit only when the SAME non-null
 * abort controller is still live (i.e. the draft was enqueued into a running
 * turn rather than executed directly, which ends with the controller cleared).
 */
export function shouldFlushAfterSendNowSubmit(args: {
  readonly isLeaderSubmit: boolean
  readonly controllerBeforeSubmit: AbortController | null
  readonly controllerAfterSubmit: AbortController | null
}): boolean {
  return (
    args.isLeaderSubmit &&
    args.controllerBeforeSubmit !== null &&
    args.controllerAfterSubmit === args.controllerBeforeSubmit
  )
}

/**
 * mRo caller condition for the empty-Enter flush: only a leader prompt in
 * 'prompt' mode attempts it (`hRo` @216688100); emptiness and the wait-flag
 * suppression are guaranteed by the call site's early-return placement.
 */
export function shouldAttemptEmptyEnterFlush(args: {
  readonly isLeaderSubmit: boolean
}): boolean {
  return args.isLeaderSubmit
}

// ---------------------------------------------------------------------------
// Footer hint (zvt @216606400, WOe/kvo/vvo @216602629)
// ---------------------------------------------------------------------------

/**
 * zvt: show the hint only while a turn is live (controller present and not
 * aborted) AND eligible queued messages exist. Official also hides it while a
 * screening is pending; OCC's QueuedCommand has no screeningPending field
 * (documented deviation).
 */
export function shouldShowSendNowHint(
  queue: readonly QueuedCommand[],
  abortController: AbortController | null | undefined,
): boolean {
  if (abortController === null || abortController === undefined) {
    return false
  }
  if (abortController.signal.aborted) {
    return false
  }
  return hasSendNowEligibleCommands(queue)
}

/**
 * vvo: an "enter-send" chord is one that sends on enter-family keys
 * (ctrl/shift+enter, or any super-modifier chord) — these need extended-key
 * terminal support to be distinguishable.
 */
export function isEnterSendChord(chord: readonly SendNowKeystroke[]): boolean {
  return chord.some(
    ks => ks.super === true || (ks.key === 'enter' && (ks.ctrl === true || ks.shift === true)),
  )
}

/**
 * kvo: pick the chord to display. With extended-key support the LAST binding
 * wins (ctrl+enter); without it, prefer the last non-enter-send chord
 * (ctrl+x ctrl+s) so the hint is actually typeable, falling back to the last
 * binding.
 */
export function selectSendNowChord(
  chords: readonly (readonly SendNowKeystroke[])[],
  preferEnterChord: boolean,
): readonly SendNowKeystroke[] | undefined {
  const selected = preferEnterChord
    ? undefined
    : chords.findLast(chord => !isEnterSendChord(chord))
  return selected ?? chords.at(-1)
}

/**
 * WOe body: resolve the send-now chord display string from parsed bindings.
 * Returns '' when unbound (official XOe renders nothing in that case).
 * The result is lowercased to mirror the official ShortcutLabel
 * `format:{keyCase:"lower"}` (@216607150) — e.g. "ctrl+enter", not
 * OCC's canonical "ctrl+Enter".
 */
export function getSendNowChordDisplay(
  bindings: readonly SendNowBinding[],
  preferEnterChord: boolean,
): string {
  const chords = bindings
    .filter(b => b.action === SEND_NOW_ACTION && b.context === SEND_NOW_CONTEXT)
    .map(b => b.chord)
  const chord = selectSendNowChord(chords, preferEnterChord)
  if (!chord) {
    return ''
  }
  return chordToDisplayString(chord, getPlatform()).toLowerCase()
}

/**
 * xHe() @202522884 reads the terminal's live "extendedKeys" capability
 * (s5().now(...)). OCC's synchronous equivalent is `supportsExtendedKeys()`
 * (src/ink/terminal.ts) — the same allowlist gate (iTerm.app/kitty/WezTerm/
 * ghostty/tmux/windows-terminal) that ink.tsx uses to enable the kitty
 * keyboard protocol — so the footer hint always reflects the capability the
 * input layer actually negotiated: ctrl+enter where extended keys work,
 * ctrl+x ctrl+s elsewhere.
 */
export function hasExtendedKeyboardSupport(): boolean {
  return supportsExtendedKeys()
}

/**
 * WOe chord-preference rule: extended keys are preferred unless running
 * inside tmux/screen (`Boolean(a.TMUX || a.STY)` @216602629), which mangle
 * extended-key reporting.
 */
export function shouldPreferEnterChord(args: {
  readonly extendedKeyboardSupport: boolean
  readonly inTmux: boolean
  readonly inScreen: boolean
}): boolean {
  return args.extendedKeyboardSupport && !(args.inTmux || args.inScreen)
}
