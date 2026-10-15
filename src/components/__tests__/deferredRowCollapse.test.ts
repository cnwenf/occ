import { describe, expect, test } from 'bun:test'
import {
  DEFERRED_COLLAPSE_MS,
  createDeferredCollapseCoordinator,
  type SelectionSignal,
} from '../deferredRowCollapse.js'

// ---------------------------------------------------------------------------
// #031 — deferred row-collapse state machine (official v299 `Jb=250`)
// ---------------------------------------------------------------------------

type Msg = { uuid: string };

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimeoutFn: ((fn: () => void, ms?: number) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + (ms ?? 0) });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let pick: number | null = null;
        let pickAt = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < pickAt) {
            pick = id;
            pickAt = t.at;
          }
        }
        if (pick === null) break;
        const t = timers.get(pick)!;
        timers.delete(pick);
        now = t.at;
        t.fn();
      }
      now = target;
    },
    pendingCount: () => timers.size,
  };
}

function createSelectionFake() {
  const listeners = new Set<() => void>();
  let hasSelection = false;
  let dragging = false;
  let unsubscribeCalls = 0;
  const signal: SelectionSignal = {
    hasTextSelection: () => hasSelection,
    isDragging: () => dragging,
    subscribeToSelectionChange: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribeCalls++;
      };
    },
  };
  return {
    signal,
    /** Sets the flag and notifies listeners like Ink does. */
    setHasSelection(v: boolean): void {
      hasSelection = v;
      for (const l of [...listeners]) l();
    },
    setDragging(v: boolean): void {
      dragging = v;
    },
    listenerCount: () => listeners.size,
    getUnsubscribeCalls: () => unsubscribeCalls,
  };
}

function setup(opts?: { expanded?: boolean; selection?: boolean }) {
  const clock = createFakeClock();
  const selection = opts?.selection === false ? undefined : createSelectionFake();
  const commits: string[] = [];
  let stillExpanded = opts?.expanded ?? true;
  const coordinator = createDeferredCollapseCoordinator<Msg>({
    getSelectionSignal: () => selection?.signal,
    isStillExpanded: () => stillExpanded,
    commitToggle: itemKey => {
      commits.push(itemKey);
      stillExpanded = !stillExpanded;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const msg: Msg = { uuid: 'msg-1' };
  return {
    clock,
    selection,
    commits,
    coordinator,
    msg,
    setStillExpanded: (v: boolean) => {
      stillExpanded = v;
    },
  };
}

describe('deferredRowCollapse (#031)', () => {
  test('defer window constant matches official Jb=250', () => {
    expect(DEFERRED_COLLAPSE_MS).toBe(250);
  });

  test('click on a collapsed row expands immediately (no defer)', () => {
    const s = setup();
    s.coordinator.handleClick('k1', s.msg, false);
    expect(s.commits).toEqual(['k1']);
    expect(s.coordinator.hasPending('k1')).toBe(false);
  });

  test('click on an expanded row defers the collapse by 250ms', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    expect(s.commits).toEqual([]); // not yet — deferred
    expect(s.coordinator.hasPending('k1')).toBe(true);
    s.clock.advance(DEFERRED_COLLAPSE_MS - 1);
    expect(s.commits).toEqual([]);
    s.clock.advance(1);
    expect(s.commits).toEqual(['k1']);
    expect(s.coordinator.hasPending('k1')).toBe(false);
  });

  test('second click while pending (double-click) commits immediately', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.clock.advance(100);
    s.coordinator.handleClick('k1', s.msg, true); // 2nd click of double-click
    expect(s.commits).toEqual(['k1']);
    expect(s.coordinator.hasPending('k1')).toBe(false);
    // The original timer must not double-commit when it later fires.
    s.clock.advance(DEFERRED_COLLAPSE_MS * 2);
    expect(s.commits).toEqual(['k1']);
  });

  test('word-select during the defer window cancels the collapse', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.selection!.setHasSelection(true); // double-click selected a word
    expect(s.coordinator.hasPending('k1')).toBe(false);
    s.clock.advance(DEFERRED_COLLAPSE_MS * 3);
    expect(s.commits).toEqual([]); // row stays expanded
    expect(s.selection!.getUnsubscribeCalls()).toBe(1);
  });

  test('selection made after the defer window cannot cancel a committed collapse', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual(['k1']);
    s.selection!.setHasSelection(true);
    expect(s.commits).toEqual(['k1']);
  });

  test('dragging selection re-arms the 250ms timer until the drag ends', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.selection!.setDragging(true);
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual([]); // still dragging → re-armed, not committed
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual([]);
    s.selection!.setDragging(false);
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual(['k1']);
  });

  test('commit only fires when the row is still expanded', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.setStillExpanded(false); // collapsed elsewhere while pending
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual([]);
    expect(s.coordinator.hasPending('k1')).toBe(false);
    expect(s.selection!.getUnsubscribeCalls()).toBe(1);
  });

  test('cancelAll (unmount) cancels every pending collapse without committing', () => {
    const s = setup({ expanded: true });
    s.coordinator.handleClick('k1', s.msg, true);
    s.coordinator.handleClick('k2', { uuid: 'msg-2' }, true);
    s.coordinator.cancelAll();
    expect(s.commits).toEqual([]);
    expect(s.clock.pendingCount()).toBe(0);
    s.clock.advance(DEFERRED_COLLAPSE_MS * 3);
    expect(s.commits).toEqual([]);
  });

  test('works without an attached Ink instance (no selection bridge)', () => {
    const s = setup({ selection: false });
    s.coordinator.handleClick('k1', s.msg, true);
    s.clock.advance(DEFERRED_COLLAPSE_MS);
    expect(s.commits).toEqual(['k1']);
  });
});
