import { describe, expect, test } from 'bun:test'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  FELL_BACK_TO_CANCEL_REASON,
  flushQueuedMessagesCore,
  isSendNowFlushable,
  NO_LIVE_CONTROLLER_REASON,
  QUEUED_SEND_NOW_SOURCE,
  SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE,
  SEND_NOW_KEY_EVENT,
  sendQueuedNow,
  type SendNowFlushDeps,
} from '../sendNow.js'

/**
 * CC 2.1.293 L28 Phase 1 — send-now flush guard ("don't end the waited-on
 * thing"). Byte-faithful port of the official v2.1.293 binary (all offsets
 * into /tmp/cc-diff-293/vver/package/claude, verified with grep -aboF + dd,
 * NEVER executed):
 *
 *   Cst key handler @234772005 (≡ 292 Irt @233601200):
 *     function Cst(h){let k=NSn();
 *      if(k&&Tst(h)&&h.deliverWithoutCancel())return y("input_send_now_key"),!0;
 *      switch(_st(h)){case"cancelled":if(k)p("input_send_now_key","fell_back_to_cancel");
 *       else y("input_send_now_key");return!0;
 *       case"no_live_controller":return p("input_send_now_key","no_live_controller"),!1;
 *       case"nothing_to_send":return!1}}
 *   Tst guard @234772005 (≡ Ert):
 *     (h.mode??"prompt")==="prompt"&&h.turn.guard.isActive&&vnr(h.queue)
 *   _st fallback @234772005 (≡ Drt ≡ OCC flushQueuedMessagesCore)
 *   NSn flag @214600349: T("tengu_velvet_panda",!0) — default TRUE.
 *
 * The flag is injected as a parameter (OCC pure-module convention — same as
 * sendQueuedNowOnEmptyEnter/tengu_jiggly_mochi); the REPL reads it from
 * getFeatureValue_CACHED_MAY_BE_STALE at call time. Phases 2-4 (queue
 * promoteToNow/'now' priority + Fo head-state, tool-detach registry + task
 * backgrounding, CCR send_now) stay staged per
 * docs/gap-research-293/cluster-c-h-carryover.md §L28.
 */

// ---------------------------------------------------------------------------
// Fixtures (AAA — Arrange helpers, mirroring sendNow275.test.ts)
// ---------------------------------------------------------------------------

function makeQueuedCommand(
  overrides: Partial<QueuedCommand> = {},
): QueuedCommand {
  return {
    value: 'queued message',
    mode: 'prompt',
    uuid: 'test-uuid',
    ...overrides,
  } as QueuedCommand
}

interface DeliverRecorder {
  readonly deps: SendNowFlushDeps
  readonly interrupts: number[]
  readonly cancelTelemetry: number[]
  readonly deliverCalls: number[]
  readonly events: { event: string; reason?: string }[]
  interruptResult: boolean
  deliverResult: boolean
}

function makeDeps(
  overrides: Partial<SendNowFlushDeps> = {},
  opts: { withDeliver?: boolean } = {},
): DeliverRecorder {
  const { withDeliver = true } = opts
  // Same shape as sendNow275.test.ts makeFlushDeps: `deps` lives INSIDE the
  // recorder so test-time mutations (rec.deliverResult = false) are visible
  // to the closures below.
  const recorder: DeliverRecorder = {
    interrupts: [],
    cancelTelemetry: [],
    deliverCalls: [],
    events: [],
    interruptResult: true,
    deliverResult: true,
    deps: {
      mode: 'prompt',
      isQueryActive: true,
      queue: [makeQueuedCommand()],
      interruptRunningTurn: () => {
        recorder.interrupts.push(1)
        return recorder.interruptResult
      },
      onCancelTelemetry: () => {
        recorder.cancelTelemetry.push(1)
      },
      logFlushEvent: (event, reason) => {
        recorder.events.push({ event, reason })
      },
      ...(withDeliver
        ? {
            deliverWithoutCancel: () => {
              recorder.deliverCalls.push(1)
              return recorder.deliverResult
            },
          }
        : {}),
      ...overrides,
    },
  }
  return recorder
}

// ---------------------------------------------------------------------------
// Constants (byte-exact strings from the official 2.1.293 binary)
// ---------------------------------------------------------------------------

describe('293 L28 telemetry/gate strings', () => {
  test('gate + fallback reason match the binary extraction', () => {
    // NSn @214600349: T("tengu_velvet_panda",!0)
    expect(SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE).toBe('tengu_velvet_panda')
    // Cst @234772005: p("input_send_now_key","fell_back_to_cancel")
    expect(FELL_BACK_TO_CANCEL_REASON).toBe('fell_back_to_cancel')
    expect(SEND_NOW_KEY_EVENT).toBe('input_send_now_key')
    expect(NO_LIVE_CONTROLLER_REASON).toBe('no_live_controller')
    expect(QUEUED_SEND_NOW_SOURCE).toBe('queued_send_now')
  })
})

// ---------------------------------------------------------------------------
// Tst/Ert guard predicate
// ---------------------------------------------------------------------------

describe('isSendNowFlushable (Tst/Ert @234772005)', () => {
  test('prompt mode + live turn + eligible queue → true', () => {
    expect(isSendNowFlushable(makeDeps().deps)).toBe(true)
  })

  test('undefined mode defaults to prompt (h.mode??"prompt")', () => {
    expect(isSendNowFlushable(makeDeps({ mode: undefined }).deps)).toBe(true)
  })

  test('non-prompt mode → false', () => {
    expect(isSendNowFlushable(makeDeps({ mode: 'bash' }).deps)).toBe(false)
  })

  test('idle turn (guard not active) → false', () => {
    expect(isSendNowFlushable(makeDeps({ isQueryActive: false }).deps)).toBe(
      false,
    )
  })

  test('no eligible queued commands → false', () => {
    expect(isSendNowFlushable(makeDeps({ queue: [] }).deps)).toBe(false)
    expect(
      isSendNowFlushable(
        makeDeps({ queue: [makeQueuedCommand({ agentId: 'agent-1' })] }).deps,
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cst key handler — flag ON (tengu_velvet_panda default true)
// ---------------------------------------------------------------------------

describe('sendQueuedNow (Cst) with the deliver-without-cancel gate ON', () => {
  test('deliver succeeds → true, plain event, NO interrupt, NO cancel telemetry', () => {
    const rec = makeDeps()
    expect(sendQueuedNow(rec.deps, true)).toBe(true)
    expect(rec.deliverCalls).toHaveLength(1)
    expect(rec.interrupts).toHaveLength(0)
    expect(rec.cancelTelemetry).toHaveLength(0)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: undefined },
    ])
  })

  test('deliver fails → Drt fallback interrupts + fell_back_to_cancel reason', () => {
    const rec = makeDeps()
    rec.deliverResult = false
    expect(sendQueuedNow(rec.deps, true)).toBe(true)
    expect(rec.deliverCalls).toHaveLength(1)
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.cancelTelemetry).toHaveLength(1)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: 'fell_back_to_cancel' },
    ])
  })

  test('deliverWithoutCancel absent (OCC Phase-1 REPL) → Drt fallback + fell_back_to_cancel', () => {
    const rec = makeDeps({}, { withDeliver: false })
    expect(sendQueuedNow(rec.deps, true)).toBe(true)
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: 'fell_back_to_cancel' },
    ])
  })

  test('guard false (empty queue) → deliver NOT attempted, nothing_to_send, no telemetry', () => {
    const rec = makeDeps({ queue: [] })
    expect(sendQueuedNow(rec.deps, true)).toBe(false)
    expect(rec.deliverCalls).toHaveLength(0)
    expect(rec.interrupts).toHaveLength(0)
    expect(rec.events).toHaveLength(0)
  })

  test('guard false (idle turn) → deliver NOT attempted', () => {
    const rec = makeDeps({ isQueryActive: false })
    expect(sendQueuedNow(rec.deps, true)).toBe(false)
    expect(rec.deliverCalls).toHaveLength(0)
  })

  test('no_live_controller path keeps its verbatim reason', () => {
    const rec = makeDeps()
    rec.deliverResult = false
    rec.interruptResult = false
    expect(sendQueuedNow(rec.deps, true)).toBe(false)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: 'no_live_controller' },
    ])
  })

  test('default gate argument is ON (official NSn default true)', () => {
    const rec = makeDeps()
    rec.deliverResult = true
    expect(sendQueuedNow(rec.deps)).toBe(true)
    expect(rec.deliverCalls).toHaveLength(1)
    expect(rec.interrupts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Cst key handler — flag OFF (legacy 292 O$t path)
// ---------------------------------------------------------------------------

describe('sendQueuedNow (Cst) with the deliver-without-cancel gate OFF', () => {
  test('deliver is never attempted; cancelled → plain event (legacy path)', () => {
    const rec = makeDeps()
    expect(sendQueuedNow(rec.deps, false)).toBe(true)
    expect(rec.deliverCalls).toHaveLength(0)
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.cancelTelemetry).toHaveLength(1)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: undefined },
    ])
  })

  test('no_live_controller + nothing_to_send unchanged from legacy', () => {
    const noController = makeDeps()
    noController.interruptResult = false
    expect(sendQueuedNow(noController.deps, false)).toBe(false)
    expect(noController.events).toEqual([
      { event: 'input_send_now_key', reason: 'no_live_controller' },
    ])

    const empty = makeDeps({ queue: [] })
    expect(sendQueuedNow(empty.deps, false)).toBe(false)
    expect(empty.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Drt/_st fallback core — unchanged semantics (regression guard)
// ---------------------------------------------------------------------------

describe('flushQueuedMessagesCore (_st/Drt) is untouched by Phase 1', () => {
  test('guard → interrupt → cancel telemetry order preserved', () => {
    const rec = makeDeps()
    expect(flushQueuedMessagesCore(rec.deps)).toBe('cancelled')
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.cancelTelemetry).toHaveLength(1)
    // The core never fires the flush event itself (Cst does).
    expect(rec.events).toHaveLength(0)
  })

  test('deliverWithoutCancel is NOT consulted by the fallback core', () => {
    const rec = makeDeps()
    expect(flushQueuedMessagesCore(rec.deps)).toBe('cancelled')
    expect(rec.deliverCalls).toHaveLength(0)
  })
})
