/**
 * claude-code 2.1.310 PORT #12 — MCP tool-call timeout error arms while the
 * server's elicitation is unanswered (non-interactive).
 *
 * Official sources (2.1.310 linux ELF, byte-verified, never executed):
 *  - Constants region @243058412 (verbatim):
 *      BJn="mcp_call_unanswered",
 *      o8s="The server asked the user a question, and no answer came before
 *           the time limit. Do not call this tool again in this turn. Tell the
 *           user that the server's question got no answer, and wait for their
 *           reply.",
 *      s8s="mcp_question_unanswered",
 *      cWr="The outcome is unknown: the call may have finished, may still be
 *           running, or may never have started. Check what it did before you
 *           repeat it."
 *    (`cWr`/`BJn` are the pre-existing 309-baseline arm; `o8s`/`s8s` are new
 *    in 310 — grep -aboF counts: o8s 2/0, s8s 2/0, cWr 2/2, BJn 2/2.)
 *  - Timeout handler @278877100+2400:
 *      let At=`MCP server "${Tt}" tool "${lt}" timed out after
 *              ${Math.floor(Ut/1000)}s`,
 *          Bt=$t.size>0,                        // in-flight sends
 *          dt=(rt.openQuestions??0)>0,          // open elicitation question
 *          zt=[...dt?[o8s]:[],...Bt?[cWr]:[]];
 *      ft(Object.assign(new R(zt.length>0?`${At}. ${zt.join(" ")}`:At,
 *          "MCP tool timeout",Bt?BJn:dt?s8s:void 0),
 *          {mcpErrorSource:"downstream_unreachable"}))
 *    R = TelemetrySafeError; its 3rd ctor arg is stored as `this.errorClass`.
 *  - Elicitation handler counter @275511304:
 *      $n.forEach((Zn)=>Zn.questionOpened?.());
 *      let tn=$n.length===1?$n[0]:void 0;
 *      if(tn!==void 0)tn.openQuestions=(tn.openQuestions??0)+1;
 *      try{lr=await e.handleElicitation(...)}
 *      finally{if(tn!==void 0)tn.openQuestions=(tn.openQuestions??1)-1;
 *              $n.forEach((Zn)=>Zn.questionClosed?.())}
 *    — the counter is attributed ONLY when exactly one watchdog is active.
 *
 * OCC mapping notes (deviations documented in the WP report):
 *  - OCC has no per-watchdog in-flight-sends map (`Fe`, fed by
 *    requestSent/requestTaken/requestAnswered/requestNotRun — the unported
 *    309-era answer-tracking subsystem). The faithful analog from OCC's
 *    2.1.307 B3 send tracking is `ownSends.started > ownSends.ranNothing`
 *    (sends that were not definitively ran-nothing are still "in flight").
 *  - OCC has no idle-timeout rejection site, so the idle-timeout sibling arm
 *    has nothing to attach to.
 *  - `questionOpened?/questionClosed?` fan-out is 309-era telemetry OCC never
 *    ported; per the WP minimum-viable instruction only `openQuestions` is
 *    added to the watchdog shape.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../../state/AppState.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../utils/errors.js'
import type {
  McpConnectionState,
  ToolCallWatchdog,
} from '../sendTracking.js'

// Keep the hook layer out of the way (same convention as
// elicitationUserConfirmsCompletion288.test.ts).
// Eager spread copy BEFORE mocking (OCC-97/132): bun patches the captured
// namespace IN PLACE, so a lazy `...actualHooks` spread inside the afterAll
// restore factory would re-pin the MOCK hooks and leak no-op
// executeElicitationHooks/executeNotificationHooks into every later file.
const actualHooks = { ...(await import('../../../utils/hooks.js')) }
mock.module('../../../utils/hooks.js', () => ({
  ...actualHooks,
  executeElicitationHooks: async () => ({}),
  executeElicitationResultHooks: async () => ({}),
  executeNotificationHooks: async () => undefined,
}))

const { registerElicitationHandler } = await import('../elicitationHandler.js')
const {
  buildMcpToolTimeoutRejection,
  MCP_QUESTION_UNANSWERED_MSG,
  MCP_OUTCOME_UNKNOWN_MSG,
} = await import('../client.js')
type ElicitationRequestEvent =
  import('../elicitationHandler.js').ElicitationRequestEvent

afterAll(() => {
  mock.module('../../../utils/hooks.js', () => ({ ...actualHooks }))
})

// ---------------------------------------------------------------------------
// Byte-verbatim constants (hardcoded here on purpose — importing them from
// the source would make a typo in the source invisible to this test).
// ---------------------------------------------------------------------------

const QUESTION_UNANSWERED_MSG =
  "The server asked the user a question, and no answer came before the time limit. Do not call this tool again in this turn. Tell the user that the server's question got no answer, and wait for their reply."
const OUTCOME_UNKNOWN_MSG =
  'The outcome is unknown: the call may have finished, may still be running, or may never have started. Check what it did before you repeat it.'
const BASE_MSG = 'MCP server "srv" tool "do_thing" timed out after 60s'

function makeWatchdog(
  overrides: Partial<ToolCallWatchdog> = {},
): ToolCallWatchdog {
  return {
    armedAt: 0,
    offCriticalPath: false,
    toolUseId: 'toolu_1',
    ownSends: { started: 0, ranNothing: 0 },
    ...overrides,
  }
}

function errorClassOf(error: unknown): string | undefined {
  return (error as { errorClass?: string }).errorClass
}

function mcpErrorSourceOf(error: unknown): string | undefined {
  return (error as { mcpErrorSource?: string }).mcpErrorSource
}

describe('2.1.310 #12: verbatim message constants', () => {
  test('exported constants are byte-identical to the official o8s / cWr', () => {
    expect(MCP_QUESTION_UNANSWERED_MSG).toBe(QUESTION_UNANSWERED_MSG)
    expect(MCP_OUTCOME_UNKNOWN_MSG).toBe(OUTCOME_UNKNOWN_MSG)
  })
})

// ---------------------------------------------------------------------------
// Timeout rejection composition (official setTimeout callback @278877100+2400)
// ---------------------------------------------------------------------------

describe('2.1.310 #12: buildMcpToolTimeoutRejection composition', () => {
  test('question-only timeout → base + ". " + question msg, errorClass mcp_question_unanswered', () => {
    // Arrange — open question, no in-flight sends (nothing started).
    const watchdog = makeWatchdog({ openQuestions: 1 })

    // Act
    const error = buildMcpToolTimeoutRejection('srv', 'do_thing', 60000, watchdog)

    // Assert
    expect(error.message).toBe(`${BASE_MSG}. ${QUESTION_UNANSWERED_MSG}`)
    expect(errorClassOf(error)).toBe('mcp_question_unanswered')
    expect(mcpErrorSourceOf(error)).toBe('downstream_unreachable')
  })

  test('both arms → question msg first then outcome msg, errorClass mcp_call_unanswered wins', () => {
    // Arrange — open question AND a send whose outcome is unknown.
    const watchdog = makeWatchdog({
      openQuestions: 1,
      ownSends: { started: 2, ranNothing: 1 },
    })

    // Act
    const error = buildMcpToolTimeoutRejection('srv', 'do_thing', 60000, watchdog)

    // Assert — official `zt=[...dt?[o8s]:[],...Bt?[cWr]:[]]` (question first),
    // code `Bt?BJn:dt?s8s` (in-flight wins).
    expect(error.message).toBe(
      `${BASE_MSG}. ${QUESTION_UNANSWERED_MSG} ${OUTCOME_UNKNOWN_MSG}`,
    )
    expect(errorClassOf(error)).toBe('mcp_call_unanswered')
    expect(mcpErrorSourceOf(error)).toBe('downstream_unreachable')
  })

  test('neither arm → plain base message, errorClass undefined, mcpErrorSource still attached', () => {
    // Arrange — fresh watchdog: no sends, no questions.
    const watchdog = makeWatchdog()

    // Act
    const error = buildMcpToolTimeoutRejection('srv', 'do_thing', 60000, watchdog)

    // Assert
    expect(error.message).toBe(BASE_MSG)
    expect(errorClassOf(error)).toBeUndefined()
    expect(mcpErrorSourceOf(error)).toBe('downstream_unreachable')
  })

  test('in-flight-only (no question) → 309-baseline arm: base + ". " + outcome msg, errorClass mcp_call_unanswered', () => {
    // Arrange — one send started, definitively not ran-nothing.
    const watchdog = makeWatchdog({ ownSends: { started: 1, ranNothing: 0 } })

    // Act
    const error = buildMcpToolTimeoutRejection('srv', 'do_thing', 60000, watchdog)

    // Assert
    expect(error.message).toBe(`${BASE_MSG}. ${OUTCOME_UNKNOWN_MSG}`)
    expect(errorClassOf(error)).toBe('mcp_call_unanswered')
  })

  test('every send definitively ran nothing → NO in-flight arm (ranNothing cancels started)', () => {
    // Arrange — official `requestNotRun` removes the send from the in-flight
    // map; OCC's analog is started === ranNothing.
    const watchdog = makeWatchdog({ ownSends: { started: 2, ranNothing: 2 } })

    // Act
    const error = buildMcpToolTimeoutRejection('srv', 'do_thing', 60000, watchdog)

    // Assert
    expect(error.message).toBe(BASE_MSG)
    expect(errorClassOf(error)).toBeUndefined()
  })

  test('is a TelemetrySafeError with telemetryMessage "MCP tool timeout"', () => {
    // Arrange / Act
    const error = buildMcpToolTimeoutRejection(
      'srv',
      'do_thing',
      60000,
      makeWatchdog({ openQuestions: 1 }),
    )

    // Assert
    expect(error).toBeInstanceOf(
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    )
    expect(error.name).toBe('TelemetrySafeError')
    expect(
      (error as { telemetryMessage?: string }).telemetryMessage,
    ).toBe('MCP tool timeout')
  })
})

// ---------------------------------------------------------------------------
// Elicitation handler openQuestions counter (official @275511304)
// ---------------------------------------------------------------------------

type RequestHandler = (
  request: { params: ElicitRequestParams },
  extra: { signal: AbortSignal; requestId: string | number },
) => Promise<unknown>

function makeFakeClient() {
  let requestHandler: RequestHandler | undefined
  const client = {
    setRequestHandler: (_schema: unknown, handler: RequestHandler) => {
      requestHandler = handler
    },
    setNotificationHandler: () => {},
  } as unknown as Client
  return {
    client,
    handler: () => {
      if (!requestHandler) throw new Error('request handler not registered')
      return requestHandler
    },
  }
}

/** setAppState stand-in that mirrors the real reducer over a local state ref. */
function makeStateSetter(initial: ElicitationRequestEvent[] = []) {
  let state = { elicitation: { queue: initial } } as unknown as AppState
  return {
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
    queue: () => state.elicitation.queue as ElicitationRequestEvent[],
  }
}

function makeConnectionState(
  watchdogs: ToolCallWatchdog[],
): McpConnectionState {
  return { activeCallWatchdogs: new Set(watchdogs) }
}

const FORM_REQUEST = {
  params: {
    message: 'Approve this action?',
    requestedSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    },
  } as unknown as ElicitRequestParams,
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('2.1.310 #12: elicitation handler openQuestions counter', () => {
  test('exactly one active watchdog → incremented while awaiting the answer, decremented after respond', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    const watchdog = makeWatchdog()
    const connectionState = makeConnectionState([watchdog])
    registerElicitationHandler(client, 'srv', setAppState, connectionState)

    // Act — question arrives, no answer yet.
    const pending = handler()(FORM_REQUEST, {
      signal: new AbortController().signal,
      requestId: 1,
    })
    await settle()

    // Assert — counter up while the question is open…
    expect(queue()).toHaveLength(1)
    expect(watchdog.openQuestions).toBe(1)

    // Act — the user answers.
    queue()[0]!.respond({ action: 'accept' })
    await expect(pending).resolves.toEqual({ action: 'accept' })

    // Assert — …and back down once answered.
    expect(watchdog.openQuestions).toBe(0)
  })

  test('decrements openQuestions in finally even when the responder path throws', async () => {
    // Arrange — setAppState throws inside the queued-promise executor, so the
    // awaited response promise rejects (official: handleElicitation throws →
    // the finally still runs `(tn.openQuestions??1)-1`).
    const { client, handler } = makeFakeClient()
    const throwingSetter = () => {
      throw new Error('state exploded')
    }
    const watchdog = makeWatchdog()
    const connectionState = makeConnectionState([watchdog])
    registerElicitationHandler(client, 'srv', throwingSetter, connectionState)

    // Act
    const result = await handler()(FORM_REQUEST, {
      signal: new AbortController().signal,
      requestId: 2,
    })

    // Assert — outer catch returns cancel; the counter was still decremented.
    expect(result).toEqual({ action: 'cancel' })
    expect(watchdog.openQuestions).toBe(0)
  })

  test('two active watchdogs → no attribution (official $n.length===1 guard)', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    const first = makeWatchdog({ toolUseId: 'toolu_a' })
    const second = makeWatchdog({ toolUseId: 'toolu_b' })
    const connectionState = makeConnectionState([first, second])
    registerElicitationHandler(client, 'srv', setAppState, connectionState)

    // Act
    const pending = handler()(FORM_REQUEST, {
      signal: new AbortController().signal,
      requestId: 3,
    })
    await settle()

    // Assert — neither watchdog gets the counter (ambiguous attribution).
    expect(first.openQuestions).toBeUndefined()
    expect(second.openQuestions).toBeUndefined()

    queue()[0]!.respond({ action: 'decline' })
    await expect(pending).resolves.toEqual({ action: 'decline' })
    expect(first.openQuestions).toBeUndefined()
    expect(second.openQuestions).toBeUndefined()
  })

  test('no connectionState threaded (legacy 3-arg call) → handler works unchanged', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    registerElicitationHandler(client, 'srv', setAppState)

    // Act
    const pending = handler()(FORM_REQUEST, {
      signal: new AbortController().signal,
      requestId: 4,
    })
    await settle()

    // Assert
    expect(queue()).toHaveLength(1)
    queue()[0]!.respond({ action: 'accept' })
    await expect(pending).resolves.toEqual({ action: 'accept' })
  })

  test('timeout composition reads the live counter: question open at timeout → question arm fires', async () => {
    // Arrange — single watchdog, question queued but unanswered.
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    const watchdog = makeWatchdog({ ownSends: { started: 1, ranNothing: 0 } })
    const connectionState = makeConnectionState([watchdog])
    registerElicitationHandler(client, 'srv', setAppState, connectionState)
    const pending = handler()(FORM_REQUEST, {
      signal: new AbortController().signal,
      requestId: 5,
    })
    await settle()

    // Act — the tool-call timeout fires while the question is still open.
    const error = buildMcpToolTimeoutRejection(
      'srv',
      'do_thing',
      60000,
      watchdog,
    )

    // Assert — BOTH arms: the open question and the in-flight send.
    expect(error.message).toBe(
      `${BASE_MSG}. ${QUESTION_UNANSWERED_MSG} ${OUTCOME_UNKNOWN_MSG}`,
    )
    expect(errorClassOf(error)).toBe('mcp_call_unanswered')

    // Cleanup — answer the question so the handler promise settles.
    queue()[0]!.respond({ action: 'accept' })
    await expect(pending).resolves.toEqual({ action: 'accept' })
  })
})
