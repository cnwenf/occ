import { describe, expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings, parseChord } from '../../keybindings/parser.js'
import { supportsExtendedKeys } from '../../ink/terminal.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  flushQueuedMessagesCore,
  getSendNowChordDisplay,
  hasExtendedKeyboardSupport,
  hasSendNowEligibleCommands,
  isEnterSendChord,
  isSendNowEligible,
  NO_LIVE_CONTROLLER_REASON,
  QUEUED_SEND_NOW_SOURCE,
  resolveSendNowKeyAction,
  SEND_NOW_EMPTY_ENTER_GATE,
  SEND_QUEUED_NOW_EVENT,
  SEND_NOW_KEY_EVENT,
  sendQueuedNow,
  sendQueuedNowOnEmptyEnter,
  type SendNowFlushDeps,
  shouldAttemptEmptyEnterFlush,
  shouldFlushAfterSendNowSubmit,
  shouldPreferEnterChord,
  shouldShowSendNowHint,
  selectSendNowChord,
} from '../sendNow.js'

/**
 * CC 2.1.275 (ITEM O): send-now flush core + hint/chord selection.
 *
 * Byte-faithful port verified against the official 2.1.276 binary:
 *   F$t/O$t/L$t @217111100-217111700, Gln/lu/qm @196637403/@195480108/
 *   @196622091, zvt @216606400, WOe/kvo/vvo @216602629.
 */

// ---------------------------------------------------------------------------
// Fixtures (AAA — Arrange helpers)
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

interface FlushRecorder {
  readonly deps: SendNowFlushDeps
  readonly interrupts: number[]
  readonly cancelTelemetry: number[]
  readonly events: { event: string; reason?: string }[]
  interruptResult: boolean
}

function makeFlushDeps(
  overrides: Partial<SendNowFlushDeps> = {},
): FlushRecorder {
  const recorder: FlushRecorder = {
    interrupts: [],
    cancelTelemetry: [],
    events: [],
    interruptResult: true,
    deps: {
      mode: 'prompt',
      isQueryActive: true,
      queue: [makeQueuedCommand()],
      interruptRunningTurn: () => {
        recorder.interrupts.push(Date.now())
        return recorder.interruptResult
      },
      onCancelTelemetry: () => {
        recorder.cancelTelemetry.push(Date.now())
      },
      logFlushEvent: (event, reason) => {
        recorder.events.push({ event, reason })
      },
      ...overrides,
    },
  }
  return recorder
}

// ---------------------------------------------------------------------------
// Constants (byte-exact strings from the official binary)
// ---------------------------------------------------------------------------

describe('send-now telemetry/event names', () => {
  test('event and source strings match the official binary extraction', () => {
    // String pool @92583600 + allowlist @192517288 (v276).
    expect(SEND_NOW_KEY_EVENT).toBe('input_send_now_key')
    expect(SEND_QUEUED_NOW_EVENT).toBe('input_send_queued_now')
    expect(NO_LIVE_CONTROLLER_REASON).toBe('no_live_controller')
    expect(QUEUED_SEND_NOW_SOURCE).toBe('queued_send_now')
    // Oae @216671717: I("tengu_jiggly_mochi",!1)
    expect(SEND_NOW_EMPTY_ENTER_GATE).toBe('tengu_jiggly_mochi')
  })
})

// ---------------------------------------------------------------------------
// Queue eligibility (Gln/lu/qm)
// ---------------------------------------------------------------------------

describe('isSendNowEligible (lu&&qm)', () => {
  test('main-thread prompt command is eligible', () => {
    expect(isSendNowEligible(makeQueuedCommand())).toBe(true)
  })

  test('main-thread bash command is eligible', () => {
    expect(isSendNowEligible(makeQueuedCommand({ mode: 'bash' }))).toBe(true)
  })

  test('agent-owned command (agentId set) is NOT eligible (lu @195480108)', () => {
    expect(isSendNowEligible(makeQueuedCommand({ agentId: 'agent-1' }))).toBe(
      false,
    )
  })

  test('meta command is NOT eligible (qm !e.isMeta @196622091)', () => {
    expect(isSendNowEligible(makeQueuedCommand({ isMeta: true }))).toBe(false)
  })

  test('task-notification command is NOT eligible (non-editable mode)', () => {
    expect(
      isSendNowEligible(makeQueuedCommand({ mode: 'task-notification' })),
    ).toBe(false)
  })
})

describe('hasSendNowEligibleCommands (Gln @196637403)', () => {
  test('empty queue has nothing to send', () => {
    expect(hasSendNowEligibleCommands([])).toBe(false)
  })

  test('queue of only agent/meta commands has nothing to send', () => {
    expect(
      hasSendNowEligibleCommands([
        makeQueuedCommand({ agentId: 'a' }),
        makeQueuedCommand({ isMeta: true }),
      ]),
    ).toBe(false)
  })

  test('one eligible command among ineligible ones is enough (some)', () => {
    expect(
      hasSendNowEligibleCommands([
        makeQueuedCommand({ agentId: 'a' }),
        makeQueuedCommand(),
      ]),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Flush core (F$t @217111100)
// ---------------------------------------------------------------------------

describe('flushQueuedMessagesCore (F$t)', () => {
  test('non-prompt mode → nothing_to_send, no interrupt, no telemetry', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, mode: 'bash' }
    expect(flushQueuedMessagesCore(deps)).toBe('nothing_to_send')
    expect(rec.interrupts).toHaveLength(0)
    expect(rec.cancelTelemetry).toHaveLength(0)
  })

  test('undefined mode is treated as prompt (official h.mode??"prompt")', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, mode: undefined }
    expect(flushQueuedMessagesCore(deps)).toBe('cancelled')
  })

  test('idle query guard → nothing_to_send, no interrupt', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, isQueryActive: false }
    expect(flushQueuedMessagesCore(deps)).toBe('nothing_to_send')
    expect(rec.interrupts).toHaveLength(0)
  })

  test('empty queue → nothing_to_send, no interrupt', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, queue: [] }
    expect(flushQueuedMessagesCore(deps)).toBe('nothing_to_send')
    expect(rec.interrupts).toHaveLength(0)
  })

  test('queue with only ineligible commands → nothing_to_send', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, queue: [makeQueuedCommand({ isMeta: true })] }
    expect(flushQueuedMessagesCore(deps)).toBe('nothing_to_send')
    expect(rec.interrupts).toHaveLength(0)
  })

  test('interrupt failure → no_live_controller, no cancel telemetry', () => {
    const rec = makeFlushDeps()
    rec.interruptResult = false
    expect(flushQueuedMessagesCore(rec.deps)).toBe('no_live_controller')
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.cancelTelemetry).toHaveLength(0)
  })

  test('success → cancelled, interrupt fires BEFORE cancel telemetry', () => {
    const rec = makeFlushDeps()
    expect(flushQueuedMessagesCore(rec.deps)).toBe('cancelled')
    expect(rec.interrupts).toHaveLength(1)
    expect(rec.cancelTelemetry).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Send-now key gesture (O$t @217111400)
// ---------------------------------------------------------------------------

describe('sendQueuedNow (O$t)', () => {
  test('cancelled → true + input_send_now_key event with no reason', () => {
    const rec = makeFlushDeps()
    expect(sendQueuedNow(rec.deps)).toBe(true)
    expect(rec.events).toEqual([{ event: 'input_send_now_key', reason: undefined }])
  })

  test('no_live_controller → false + input_send_now_key with no_live_controller reason', () => {
    const rec = makeFlushDeps()
    rec.interruptResult = false
    expect(sendQueuedNow(rec.deps)).toBe(false)
    expect(rec.events).toEqual([
      { event: 'input_send_now_key', reason: 'no_live_controller' },
    ])
  })

  test('nothing_to_send → false and NO telemetry at all', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, queue: [] }
    expect(sendQueuedNow(deps)).toBe(false)
    expect(rec.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Empty-Enter gesture (L$t @217111250 + Oae gate @216671717)
// ---------------------------------------------------------------------------

describe('sendQueuedNowOnEmptyEnter (L$t)', () => {
  test('gate disabled → false with zero side effects even when flush would succeed', () => {
    const rec = makeFlushDeps()
    expect(sendQueuedNowOnEmptyEnter(rec.deps, false)).toBe(false)
    expect(rec.interrupts).toHaveLength(0)
    expect(rec.cancelTelemetry).toHaveLength(0)
    expect(rec.events).toHaveLength(0)
  })

  test('gate enabled + cancelled → true + input_send_queued_now event', () => {
    const rec = makeFlushDeps()
    expect(sendQueuedNowOnEmptyEnter(rec.deps, true)).toBe(true)
    expect(rec.events).toEqual([
      { event: 'input_send_queued_now', reason: undefined },
    ])
  })

  test('gate enabled + no_live_controller → false + reason telemetry', () => {
    const rec = makeFlushDeps()
    rec.interruptResult = false
    expect(sendQueuedNowOnEmptyEnter(rec.deps, true)).toBe(false)
    expect(rec.events).toEqual([
      { event: 'input_send_queued_now', reason: 'no_live_controller' },
    ])
  })

  test('gate enabled + nothing_to_send → false, no telemetry', () => {
    const rec = makeFlushDeps()
    const deps = { ...rec.deps, isQueryActive: false }
    expect(sendQueuedNowOnEmptyEnter(deps, true)).toBe(false)
    expect(rec.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Handler decisions (Zxt @216697952 / mRo @216688100)
// ---------------------------------------------------------------------------

describe('resolveSendNowKeyAction (Zxt branching)', () => {
  test('draft with content → submit-then-maybe-flush (leader or not)', () => {
    expect(resolveSendNowKeyAction({ hasContent: true, isLeaderSubmit: true })).toBe(
      'submit-then-maybe-flush',
    )
    expect(
      resolveSendNowKeyAction({ hasContent: true, isLeaderSubmit: false }),
    ).toBe('submit-then-maybe-flush')
  })

  test('empty draft at leader → flush directly', () => {
    expect(resolveSendNowKeyAction({ hasContent: false, isLeaderSubmit: true })).toBe(
      'flush',
    )
  })

  test('empty draft at non-leader → noop', () => {
    expect(
      resolveSendNowKeyAction({ hasContent: false, isLeaderSubmit: false }),
    ).toBe('noop')
  })
})

describe('shouldFlushAfterSendNowSubmit (Zxt .then identity guard)', () => {
  test('leader + same non-null controller still live → flush', () => {
    const controller = new AbortController()
    expect(
      shouldFlushAfterSendNowSubmit({
        isLeaderSubmit: true,
        controllerBeforeSubmit: controller,
        controllerAfterSubmit: controller,
      }),
    ).toBe(true)
  })

  test('controller was null before submit → no flush', () => {
    expect(
      shouldFlushAfterSendNowSubmit({
        isLeaderSubmit: true,
        controllerBeforeSubmit: null,
        controllerAfterSubmit: null,
      }),
    ).toBe(false)
  })

  test('controller replaced during submit (turn ended + new one) → no flush', () => {
    expect(
      shouldFlushAfterSendNowSubmit({
        isLeaderSubmit: true,
        controllerBeforeSubmit: new AbortController(),
        controllerAfterSubmit: new AbortController(),
      }),
    ).toBe(false)
  })

  test('controller cleared during submit (draft executed directly) → no flush', () => {
    expect(
      shouldFlushAfterSendNowSubmit({
        isLeaderSubmit: true,
        controllerBeforeSubmit: new AbortController(),
        controllerAfterSubmit: null,
      }),
    ).toBe(false)
  })

  test('non-leader submit → no flush even with identical controller', () => {
    const controller = new AbortController()
    expect(
      shouldFlushAfterSendNowSubmit({
        isLeaderSubmit: false,
        controllerBeforeSubmit: controller,
        controllerAfterSubmit: controller,
      }),
    ).toBe(false)
  })
})

describe('shouldAttemptEmptyEnterFlush (mRo hRo caller condition)', () => {
  test('leader prompt attempts the flush gesture', () => {
    expect(shouldAttemptEmptyEnterFlush({ isLeaderSubmit: true })).toBe(true)
  })

  test('non-leader prompt does not', () => {
    expect(shouldAttemptEmptyEnterFlush({ isLeaderSubmit: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Footer hint (zvt @216606400)
// ---------------------------------------------------------------------------

describe('shouldShowSendNowHint (zvt)', () => {
  test('no controller (idle) → hidden', () => {
    expect(shouldShowSendNowHint([makeQueuedCommand()], null)).toBe(false)
    expect(shouldShowSendNowHint([makeQueuedCommand()], undefined)).toBe(false)
  })

  test('aborted controller → hidden', () => {
    const controller = new AbortController()
    controller.abort('user-cancel')
    expect(shouldShowSendNowHint([makeQueuedCommand()], controller)).toBe(false)
  })

  test('live controller but no eligible queue → hidden', () => {
    const controller = new AbortController()
    expect(shouldShowSendNowHint([], controller)).toBe(false)
    expect(
      shouldShowSendNowHint([makeQueuedCommand({ isMeta: true })], controller),
    ).toBe(false)
  })

  test('live controller + eligible queued messages → shown', () => {
    const controller = new AbortController()
    expect(shouldShowSendNowHint([makeQueuedCommand()], controller)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Chord selection (vvo/kvo/WOe @216602629)
// ---------------------------------------------------------------------------

describe('isEnterSendChord (vvo)', () => {
  test('ctrl+enter and shift+enter are enter-send chords', () => {
    expect(isEnterSendChord(parseChord('ctrl+enter'))).toBe(true)
    expect(isEnterSendChord(parseChord('shift+enter'))).toBe(true)
  })

  test('super-modifier chords count as enter-send (official v.super)', () => {
    expect(isEnterSendChord(parseChord('cmd+enter'))).toBe(true)
  })

  test('ctrl+x ctrl+s and ctrl+x enter are NOT enter-send chords', () => {
    expect(isEnterSendChord(parseChord('ctrl+x ctrl+s'))).toBe(false)
    // Trailing plain enter (no ctrl/shift on the enter keystroke) is typeable
    // everywhere — only the ctrl/shift+enter keystroke needs extended keys.
    expect(isEnterSendChord(parseChord('ctrl+x enter'))).toBe(false)
  })
})

describe('selectSendNowChord (kvo)', () => {
  const sx = parseChord('ctrl+x ctrl+s')
  const enter = parseChord('ctrl+enter')

  test('preferEnterChord → last chord wins (ctrl+enter)', () => {
    expect(selectSendNowChord([sx, enter], true)).toBe(enter)
  })

  test('no extended keys → last non-enter-send chord (ctrl+x ctrl+s)', () => {
    expect(selectSendNowChord([sx, enter], false)).toBe(sx)
  })

  test('all chords are enter-send with no extended keys → fall back to last', () => {
    expect(selectSendNowChord([enter], false)).toBe(enter)
  })

  test('empty binding list → undefined', () => {
    expect(selectSendNowChord([], true)).toBeUndefined()
    expect(selectSendNowChord([], false)).toBeUndefined()
  })
})

describe('getSendNowChordDisplay (WOe body, keyCase:"lower")', () => {
  const parsed = parseBindings(DEFAULT_BINDINGS)

  test('without extended keys → typeable chord ctrl+x ctrl+s', () => {
    expect(getSendNowChordDisplay(parsed, false)).toBe('ctrl+x ctrl+s')
  })

  test('with extended keys → ctrl+enter (lowercased per official format)', () => {
    expect(getSendNowChordDisplay(parsed, true)).toBe('ctrl+enter')
  })

  test('no sendNow bindings → empty string (hint renders nothing)', () => {
    expect(getSendNowChordDisplay([], false)).toBe('')
  })

  test('ignores sendNow bindings from other contexts', () => {
    const other = [
      { chord: parseChord('ctrl+enter'), action: 'chat:sendNow', context: 'Global' },
    ]
    expect(getSendNowChordDisplay(other, true)).toBe('')
  })
})

describe('hasExtendedKeyboardSupport (xHe @202522884)', () => {
  test('delegates to the sync terminal capability gate (supportsExtendedKeys)', () => {
    // 2.1.276 df-03: official reads the terminal's live "extendedKeys"
    // capability (s5().now(...)); OCC's synchronous equivalent is
    // supportsExtendedKeys() — the same allowlist gate (iTerm.app/kitty/
    // WezTerm/ghostty/tmux/windows-terminal) ink.tsx uses to enable the
    // kitty keyboard protocol — so the footer hint always reflects the
    // capability the input layer actually negotiated. Both-branch coverage
    // lives in sendNowExtendedKeys276.test.ts (env.terminal is frozen at
    // module load, so the capability module must be mocked there).
    expect(hasExtendedKeyboardSupport()).toBe(supportsExtendedKeys())
  })
})

describe('shouldPreferEnterChord (WOe tmux/screen rule)', () => {
  test('no extended-key support → never prefer ctrl+enter', () => {
    expect(
      shouldPreferEnterChord({
        extendedKeyboardSupport: false,
        inTmux: false,
        inScreen: false,
      }),
    ).toBe(false)
  })

  test('extended keys outside tmux/screen → prefer ctrl+enter', () => {
    expect(
      shouldPreferEnterChord({
        extendedKeyboardSupport: true,
        inTmux: false,
        inScreen: false,
      }),
    ).toBe(true)
  })

  test('inside tmux → fall back to the chord', () => {
    expect(
      shouldPreferEnterChord({
        extendedKeyboardSupport: true,
        inTmux: true,
        inScreen: false,
      }),
    ).toBe(false)
  })

  test('inside screen (STY) → fall back to the chord', () => {
    expect(
      shouldPreferEnterChord({
        extendedKeyboardSupport: true,
        inTmux: false,
        inScreen: true,
      }),
    ).toBe(false)
  })
})
