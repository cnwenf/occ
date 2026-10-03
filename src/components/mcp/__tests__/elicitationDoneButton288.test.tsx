/**
 * v2.1.288 PORT #80 — "Changed MCP URL prompts from servers that can't report
 * when you're done to wait for 'I'm done, continue' before the tool call
 * continues, so you can finish in the browser first".
 *
 * Byte-level forensics on the official 2.1.288 linux-x64 ELF
 * (/tmp/cc-diff-288/v288/package/claude, 245,734,584 bytes):
 *
 * - Accept-button label @229244616 (`Dpe` = the URL elicitation dialog):
 *     children: Pe ? " I'm done, continue  " : " Accept  "
 *   `Pe` is the `userConfirmsCompletion` PROP — verified at the dialog wrapper
 *   `OB` @229223775: `const ht=Pe??!1;` then
 *     e(Dpe,{serverName:E,params:N,onResponse:bt,waitingState:X,
 *            initialPhase:Ge,onWaitingDismiss:Se,userConfirmsCompletion:ht,
 *            wouldTakeAnswer:Oe})
 *   Straight ASCII apostrophe (U+0027), ONE leading space, TWO trailing spaces.
 * - Open button is rendered ONLY when `Pe` (@229244616 region):
 *     bs = bo && Pe && r(K,{children:[pointer,
 *            <Text bold…>{sr ? " Open again  " : " Open in browser  "}</Text>]})
 * - Initial focus @229235276 region:
 *     Ac(he==="waiting" ? "open" : bo&&!qo ? (Pe ? "open" : "accept") : "decline")
 * - Accept handler `Un`:
 *     ()=>{if(!bo||dn.current){return} if(H("accept")===!1){return}
 *          if(dn.current=!0,Pe){return}                 // ← answers, then RETURNS
 *          So.current=Date.now(),os(yt),un("waiting"),Xo("open")}
 *   i.e. with `Pe` the press answers the elicitation and never enters the
 *   waiting phase / never re-opens the browser: the SERVER cannot send
 *   `notifications/elicitation/complete`, so the user's press is the only
 *   resume signal.
 * - Where `Pe` comes from @234154439 (elicitation manager `ask`):
 *     let c=await l(RJ,{serverName:a,params:e,
 *       ...e.mode==="url"&&r===void 0&&{userConfirmsCompletion:!0}},…)
 *   `r` is the `elicitationId`. So `userConfirmsCompletion === true` exactly
 *   when mode==="url" AND no elicitationId was supplied — the completion
 *   notification is correlated by elicitationId, so without one the server has
 *   no way to report "done".
 *
 * OCC mapping: `ElicitationRequestEvent.userConfirmsCompletion` (set in
 * src/services/mcp/elicitationHandler.ts) drives this dialog. OCC has no
 * `bo`/`qo` (url-openable / url-overflows) equivalent — the URL dialog always
 * offers the browser path — so `bo && !qo` is treated as true.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js'
import { render, ThemeProvider } from '../../../ink.js'
import type { ElicitationRequestEvent } from '../../../services/mcp/elicitationHandler.js'

// openBrowser must not spawn a real browser in tests; record calls instead.
const actualBrowser = await import('../../../utils/browser.js')
const browserCalls: string[] = []
mock.module('../../../utils/browser.js', () => ({
  ...actualBrowser,
  openBrowser: async (url: string) => {
    browserCalls.push(url)
  },
}))

const { ElicitationDialog } = await import('../ElicitationDialog.js')

const RIGHT_ARROW = '\u001B[C'
const ENTER = '\r'

const TEST_URL = 'https://srv.test/authorize?code=abc'

afterEach(() => {
  browserCalls.length = 0
})

// Bun's mock.module leaks across test files in the same worker — restore.
afterAll(() => {
  mock.module('../../../utils/browser.js', () => ({ ...actualBrowser }))
})

function urlEvent(overrides: {
  elicitationId?: string
  userConfirmsCompletion?: boolean
}): ElicitationRequestEvent {
  const params = {
    mode: 'url',
    url: TEST_URL,
    message: 'Finish signing in, then continue.',
    ...(overrides.elicitationId === undefined
      ? {}
      : { elicitationId: overrides.elicitationId }),
  } as unknown as ElicitRequestParams
  return {
    serverName: 'srv',
    requestId: 1,
    params,
    signal: new AbortController().signal,
    respond: () => {},
    ...(overrides.elicitationId === undefined
      ? {}
      : { waitingState: { actionLabel: 'Skip confirmation' } }),
    ...(overrides.userConfirmsCompletion === undefined
      ? {}
      : { userConfirmsCompletion: overrides.userConfirmsCompletion }),
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

/**
 * Interactive render: same fake-TTY PassThrough trick as
 * src/components/CustomSelect/__tests__/renderIsolated280.tsx, but keeps the
 * instance mounted so `write()` can drive useInput and `rerender()` can push a
 * new event (the completion-notification auto-dismiss case).
 */
async function renderInteractive(node: React.ReactNode) {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  if (typeof stdin.ref !== 'function') stdin.ref = () => {}
  if (typeof stdin.unref !== 'function') stdin.unref = () => {}

  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  await tick()
  return {
    text: () => stripAnsi(output),
    async write(input: string) {
      stdin.write(input)
      await tick()
      await tick()
    },
    async rerender(next: React.ReactNode) {
      // ink.js `render` wraps the node in ThemeProvider; the raw
      // instance.rerender does not, so wrap again to keep the tree identical.
      instance.rerender(<ThemeProvider>{next}</ThemeProvider>)
      await tick()
      await tick()
    },
    async close() {
      instance.unmount()
      instance.cleanup()
      await tick()
    },
  }
}

describe('2.1.288 #80: URL elicitation from a server that cannot report completion', () => {
  test("renders the official \" I'm done, continue  \" label plus the open-browser button", async () => {
    // Arrange
    const responses: string[] = []
    const dismissals: string[] = []
    const view = await renderInteractive(
      <ElicitationDialog
        event={urlEvent({ userConfirmsCompletion: true })}
        onResponse={action => {
          responses.push(action)
        }}
        onWaitingDismiss={action => {
          dismissals.push(action)
        }}
      />,
    )

    try {
      // Act — first frame only
      const plain = view.text()

      // Assert — verbatim official strings
      expect(plain).toContain("I'm done, continue")
      expect(plain).toContain('Open in browser')
      expect(plain).not.toContain('Accept')
      // No resolution before an explicit press.
      expect(responses).toEqual([])
      expect(dismissals).toEqual([])
      // The accept press is NOT what opens the browser here; focus starts on
      // "Open in browser" (official `Ac(…Pe?"open":"accept"…)`) so a reflexive
      // Enter opens the page rather than resuming the tool call.
      expect(browserCalls).toEqual([])
    } finally {
      await view.close()
    }
  })

  test('resumes the tool call only on an explicit "I\'m done, continue" press', async () => {
    // Arrange
    const responses: string[] = []
    const dismissals: string[] = []
    const view = await renderInteractive(
      <ElicitationDialog
        event={urlEvent({ userConfirmsCompletion: true })}
        onResponse={action => {
          responses.push(action)
        }}
        onWaitingDismiss={action => {
          dismissals.push(action)
        }}
      />,
    )

    try {
      // Act — move focus open → accept, then press Enter
      await view.write(RIGHT_ARROW)
      expect(responses).toEqual([])
      await view.write(ENTER)

      // Assert
      expect(responses).toEqual(['accept'])
      // OCC: the REPL keeps a URL 'accept' queued for phase 2, so the dialog
      // dismisses itself — there is no waiting phase when the server cannot
      // report completion.
      expect(dismissals).toEqual(['dismiss'])
      expect(view.text()).not.toContain('Waiting for the server to confirm completion')
      // Official `Un` returns before `os(yt)` (open browser) when Pe is set.
      expect(browserCalls).toEqual([])
    } finally {
      await view.close()
    }
  })

  test('the open button launches the browser and relabels to " Open again  " without resolving', async () => {
    // Arrange
    const responses: string[] = []
    const view = await renderInteractive(
      <ElicitationDialog
        event={urlEvent({ userConfirmsCompletion: true })}
        onResponse={action => {
          responses.push(action)
        }}
      />,
    )

    try {
      // Act — focus starts on 'open'
      await view.write(ENTER)

      // Assert
      expect(browserCalls).toEqual([TEST_URL])
      expect(view.text()).toContain('Open again')
      expect(responses).toEqual([])
    } finally {
      await view.close()
    }
  })

  test('decline still declines', async () => {
    // Arrange
    const responses: string[] = []
    const view = await renderInteractive(
      <ElicitationDialog
        event={urlEvent({ userConfirmsCompletion: true })}
        onResponse={action => {
          responses.push(action)
        }}
      />,
    )

    try {
      // Act — open → accept → decline
      await view.write(RIGHT_ARROW)
      await view.write(RIGHT_ARROW)
      await view.write(ENTER)

      // Assert
      expect(responses).toEqual(['decline'])
      expect(browserCalls).toEqual([])
    } finally {
      await view.close()
    }
  })
})

describe('2.1.288 #80: URL elicitation from a server that CAN report completion', () => {
  test('keeps the " Accept  " label and the two-phase auto-continue flow', async () => {
    // Arrange
    const responses: string[] = []
    const dismissals: string[] = []
    const event = urlEvent({ elicitationId: 'el-1' })
    const view = await renderInteractive(
      <ElicitationDialog
        event={event}
        onResponse={action => {
          responses.push(action)
        }}
        onWaitingDismiss={action => {
          dismissals.push(action)
        }}
      />,
    )

    try {
      // Act — focus starts on 'accept', press Enter
      const prompt = view.text()
      await view.write(ENTER)

      // Assert — unchanged v287 behaviour
      expect(prompt).toContain('Accept')
      expect(prompt).not.toContain("I'm done, continue")
      expect(prompt).not.toContain('Open in browser')
      expect(responses).toEqual(['accept'])
      expect(browserCalls).toEqual([TEST_URL])
      expect(dismissals).toEqual([])
      expect(view.text()).toContain('Waiting for the server to confirm completion')
      expect(view.text()).toContain('Skip confirmation')

      // The server's completion notification (event.completed) auto-dismisses.
      await view.rerender(
        <ElicitationDialog
          event={{ ...event, completed: true }}
          onResponse={action => {
            responses.push(action)
          }}
          onWaitingDismiss={action => {
            dismissals.push(action)
          }}
        />,
      )
      expect(dismissals).toEqual(['dismiss'])
    } finally {
      await view.close()
    }
  })
})
