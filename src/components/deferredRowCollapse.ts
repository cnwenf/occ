/**
 * Deferred row-collapse coordinator (official v299 #031).
 *
 * Double-click word-select inside an EXPANDED fullscreen row must not
 * collapse the row: the first click of the double-click lands on the row's
 * onClick and would immediately toggle it closed, yanking the text the user
 * is selecting out from under the mouse.
 *
 * Official mechanics (recovered from the v299 binary, `Jb=250` + pending
 * Map `$t` keyed by itemKey):
 *  - click on a row with a PENDING collapse (i.e. the second click of a
 *    double-click) → commit the collapse immediately;
 *  - click on a COLLAPSED row → expand immediately (unchanged behavior);
 *  - click on an EXPANDED row → defer the collapse by DEFERRED_COLLAPSE_MS,
 *    subscribing to selection changes — if a text selection appears (the
 *    double-click word-select), cancel the collapse; when the defer timer
 *    fires, re-arm it while a mouse drag is still in progress, otherwise
 *    commit. Commit only fires when the row is still expanded.
 *  - unmount cancels all pending collapses.
 *
 * Extracted as a pure(ish) state machine with injected timer + selection
 * dependencies so it is unit-testable without Ink.
 */

/** Official `Jb=250` — defer window before an expanded row collapses. */
export const DEFERRED_COLLAPSE_MS = 250;

/** Minimal view of the Ink text-selection API this coordinator needs. */
export type SelectionSignal = {
  hasTextSelection: () => boolean;
  isDragging: () => boolean;
  subscribeToSelectionChange: (cb: () => void) => () => void;
};

export type DeferredCollapseDeps<TMsg> = {
  /** Live selection bridge; undefined when no Ink instance is attached. */
  getSelectionSignal: () => SelectionSignal | undefined;
  /** Re-checked at commit time — commit only if the row is STILL expanded. */
  isStillExpanded: (itemKey: string, msg: TMsg) => boolean;
  /** Performs the actual expand/collapse toggle for the row. */
  commitToggle: (itemKey: string, msg: TMsg) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

export type DeferredCollapseCoordinator<TMsg> = {
  /**
   * Row click entry point. `wasExpanded` is the row's expanded state at
   * click time (official 4th VirtualItem onClick argument).
   */
  handleClick: (itemKey: string, msg: TMsg, wasExpanded: boolean | undefined) => void;
  /** Unmount cleanup — cancels every pending collapse without committing. */
  cancelAll: () => void;
  /** Test/inspection helper. */
  hasPending: (itemKey: string) => boolean;
};

export function createDeferredCollapseCoordinator<TMsg>(
  deps: DeferredCollapseDeps<TMsg>,
): DeferredCollapseCoordinator<TMsg> {
  const pending = new Map<string, (commit: boolean) => void>();
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  const resolve = (itemKey: string, commit: boolean): void => {
    pending.get(itemKey)?.(commit);
  };

  const deferCollapse = (itemKey: string, msg: TMsg): void => {
    const signal = deps.getSelectionSignal();
    // Double-click word-select: as soon as a text selection exists, the
    // click was a selection gesture — cancel the pending collapse.
    const unsubscribe = signal?.subscribeToSelectionChange(() => {
      if (signal.hasTextSelection()) resolve(itemKey, false);
    });
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      // Mouse drag still in progress — re-arm the defer window.
      if (signal?.isDragging()) {
        timer = setTimeoutFn(tick, DEFERRED_COLLAPSE_MS);
        return;
      }
      resolve(itemKey, true);
    };
    timer = setTimeoutFn(tick, DEFERRED_COLLAPSE_MS);
    pending.set(itemKey, (commit: boolean) => {
      pending.delete(itemKey);
      unsubscribe?.();
      clearTimeoutFn(timer);
      if (commit && deps.isStillExpanded(itemKey, msg)) {
        deps.commitToggle(itemKey, msg);
      }
    });
  };

  const handleClick = (itemKey: string, msg: TMsg, wasExpanded: boolean | undefined): void => {
    // Second click of a double-click while a collapse is pending → commit now.
    if (pending.has(itemKey)) {
      resolve(itemKey, true);
      return;
    }
    // Collapsed row → expand immediately (unchanged behavior).
    if (!wasExpanded) {
      deps.commitToggle(itemKey, msg);
      return;
    }
    // Expanded row → defer the collapse so a word-select can cancel it.
    deferCollapse(itemKey, msg);
  };

  const cancelAll = (): void => {
    for (const itemKey of [...pending.keys()]) resolve(itemKey, false);
  };

  return { handleClick, cancelAll, hasPending: (itemKey: string) => pending.has(itemKey) };
}
