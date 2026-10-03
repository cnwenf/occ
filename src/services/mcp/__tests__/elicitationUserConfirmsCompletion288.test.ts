/**
 * v2.1.288 PORT #80 — the handler half of "Changed MCP URL prompts from
 * servers that can't report when you're done to wait for 'I'm done, continue'
 * before the tool call continues".
 *
 * Official 2.1.288 linux-x64 ELF, elicitation manager `ask` @234154439:
 *
 *   async ask(e,t,o,r,s){ …
 *     let c=await l(RJ,{serverName:a,params:e,
 *       ...e.mode==="url"&&r===void 0&&{userConfirmsCompletion:!0}},
 *       {place:"under",signal:t});
 *     …
 *     if(e.mode==="url"&&c.action==="accept"&&n)
 *       if(n.completed) this.forget(r,n); else this.showWaiting(e,r,n,t,s);
 *     else this.forget(r,n);
 *     return {result:c,flow:n}}
 *
 * `r` is the elicitationId, and `n` (the url-flow record) is only created when
 * `r!==void 0`. `notifications/elicitation/complete` is correlated by
 * elicitationId, so a URL elicitation WITHOUT one gives the server no way to
 * report "I'm done" — that is exactly when the official sets
 * `userConfirmsCompletion:true`. OCC already computed the elicitationId here
 * (it keys `waitingState` off it), so the flag is a one-line faithful addition;
 * no capability name is invented.
 *
 * The dialog half (verbatim " I'm done, continue  " label, open-browser button,
 * no auto-continue) is covered by
 * src/components/mcp/__tests__/elicitationDoneButton288.test.tsx.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../../state/AppState.js'

// Keep the hook layer out of the way: no configured hooks in the test env, and
// the real executor would touch settings/session state.
const actualHooks = await import('../../../utils/hooks.js')
mock.module('../../../utils/hooks.js', () => ({
  ...actualHooks,
  executeElicitationHooks: async () => ({}),
  executeElicitationResultHooks: async () => ({}),
  executeNotificationHooks: async () => undefined,
}))

const { registerElicitationHandler } = await import('../elicitationHandler.js')
type ElicitationRequestEvent = import('../elicitationHandler.js').ElicitationRequestEvent

afterAll(() => {
  mock.module('../../../utils/hooks.js', () => ({ ...actualHooks }))
})

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

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('2.1.288 #80: userConfirmsCompletion derivation', () => {
  test('url elicitation with NO elicitationId → userConfirmsCompletion true (server cannot report completion)', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    registerElicitationHandler(client, 'srv', setAppState)

    // Act
    const pending = handler()(
      {
        params: {
          mode: 'url',
          url: 'https://srv.test/authorize',
          message: 'Finish in the browser',
        } as unknown as ElicitRequestParams,
      },
      { signal: new AbortController().signal, requestId: 7 },
    )
    await settle()

    // Assert
    expect(queue()).toHaveLength(1)
    expect(queue()[0]!.userConfirmsCompletion).toBe(true)
    // No waiting phase is offered — nothing can ever complete it.
    expect(queue()[0]!.waitingState).toBeUndefined()

    // The explicit press is what resolves the tool call.
    queue()[0]!.respond({ action: 'accept' })
    await expect(pending).resolves.toEqual({ action: 'accept' })
  })

  test('url elicitation WITH elicitationId → flag absent, waiting state kept (server CAN report completion)', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    registerElicitationHandler(client, 'srv', setAppState)

    // Act
    const pending = handler()(
      {
        params: {
          mode: 'url',
          url: 'https://srv.test/authorize',
          message: 'Finish in the browser',
          elicitationId: 'el-42',
        } as unknown as ElicitRequestParams,
      },
      { signal: new AbortController().signal, requestId: 8 },
    )
    await settle()

    // Assert
    expect(queue()).toHaveLength(1)
    expect(queue()[0]!.userConfirmsCompletion).toBeUndefined()
    expect(queue()[0]!.waitingState).toEqual({
      actionLabel: 'Skip confirmation',
    })

    queue()[0]!.respond({ action: 'decline' })
    await expect(pending).resolves.toEqual({ action: 'decline' })
  })

  test('form elicitation → flag absent (the official gate requires mode==="url")', async () => {
    // Arrange
    const { client, handler } = makeFakeClient()
    const { setAppState, queue } = makeStateSetter()
    registerElicitationHandler(client, 'srv', setAppState)

    // Act
    const pending = handler()(
      {
        params: {
          message: 'Pick one',
          requestedSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean', title: 'OK' } },
          },
        } as unknown as ElicitRequestParams,
      },
      { signal: new AbortController().signal, requestId: 9 },
    )
    await settle()

    // Assert
    expect(queue()).toHaveLength(1)
    expect(queue()[0]!.userConfirmsCompletion).toBeUndefined()
    expect(queue()[0]!.waitingState).toBeUndefined()

    queue()[0]!.respond({ action: 'cancel' })
    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })
})
