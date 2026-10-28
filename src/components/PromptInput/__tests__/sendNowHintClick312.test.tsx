import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLICK_TO_SEND_NOW_LABEL,
  NO_HANDLER_TOOK_IT_REASON,
  resolveSendNowClickHandler,
  resolveSendNowHintUi,
  SEND_NOW_CLICK_EVENT,
} from '../../../utils/sendNow.js'

/**
 * CC 2.1.312 item 2 — "click to send".
 *
 * Changelog: "Added click to send: in fullscreen, clicking the 'to send now'
 * hint under a queued message sends it right away, as its key does."
 *
 * Official v312 byte evidence (new-in-312, 0 hits in v311):
 *   `He=H===null||iH()!=="full"?void 0:()=>{if(H())g("input_send_now_click");
 *     else m("input_send_now_click","no_handler_took_it")}`   (@275853182)
 *   `We=D===""?"click to send now":BT({chord:D,action:"send now",
 *     format:{keyCase:"lower"}})`
 *   `ze=e($Oe,{onPress:He,children:We})` — wrapped `Box paddingLeft:2,marginTop`
 *
 * Semantics: the send-now hint under a queued message becomes pressable; the
 * click handler is ONLY active in fullscreen mode; when there is no keyboard
 * chord the hint text is the literal `click to send now`; clicking invokes the
 * same send-now action as the chord key (official `H()` = the keybinding
 * action invoker — OCC's KeybindingContext.invokeAction('chat:sendNow')).
 *
 * Test strategy: full PromptInput/REPL render-harness click dispatch is
 * impractical (OCC's ink dispatches clicks only inside <AlternateScreen>
 * with mouse tracking; SendNowHint also needs the command-queue + keybinding
 * contexts). Per the WP plan, the pure decision logic (label selection +
 * handler gating) lives in src/utils/sendNow.ts and is tested here directly,
 * plus source-wiring pins on the component (repo precedent:
 * promptInputScreenReader305.test.ts readFileSync pins).
 */

describe('resolveSendNowHintUi — label text selection (official We)', () => {
  test('empty chord → the literal "click to send now"', () => {
    expect(CLICK_TO_SEND_NOW_LABEL).toBe('click to send now')
    expect(
      resolveSendNowHintUi({ isHintVisible: true, chord: '', isFullscreen: true }),
    ).toEqual({ render: true, label: 'click to send now', pressable: true })
    // The label does NOT depend on fullscreen — only the handler does.
    expect(
      resolveSendNowHintUi({ isHintVisible: true, chord: '', isFullscreen: false }),
    ).toEqual({ render: true, label: 'click to send now', pressable: false })
  })

  test('with a chord → the existing "<chord> to send now" hint stays pressable in fullscreen', () => {
    expect(
      resolveSendNowHintUi({
        isHintVisible: true,
        chord: 'ctrl+x ctrl+s',
        isFullscreen: true,
      }),
    ).toEqual({ render: true, label: 'ctrl+x ctrl+s', pressable: true })
    expect(
      resolveSendNowHintUi({
        isHintVisible: true,
        chord: 'ctrl+x ctrl+s',
        isFullscreen: false,
      }),
    ).toEqual({ render: true, label: 'ctrl+x ctrl+s', pressable: false })
  })

  test('hint not visible → nothing renders (official zvt gate unchanged)', () => {
    expect(
      resolveSendNowHintUi({ isHintVisible: false, chord: '', isFullscreen: true }),
    ).toEqual({ render: false, label: null, pressable: false })
  })
})

describe('resolveSendNowClickHandler — fullscreen-only gating (official He)', () => {
  const onSendNow = () => true

  test('no invoker OR non-fullscreen → undefined (inert)', () => {
    // `He=H===null||iH()!=="full"?void 0:...`
    expect(
      resolveSendNowClickHandler({ isFullscreen: false, invokeSendNow: onSendNow }),
    ).toBeUndefined()
    expect(
      resolveSendNowClickHandler({ isFullscreen: true, invokeSendNow: null }),
    ).toBeUndefined()
  })

  test('fullscreen + invoker → clicking invokes send-now once and reports the outcome', () => {
    const outcomes: Array<boolean | string> = []
    const handler = resolveSendNowClickHandler({
      isFullscreen: true,
      invokeSendNow: () => {
        outcomes.push('invoked')
        return true
      },
      onEvent: (event, reason) => outcomes.push(reason ?? event),
    })
    expect(handler).toBeDefined()
    handler?.()
    // exactly one invocation + the success telemetry event name
    expect(outcomes).toEqual(['invoked', SEND_NOW_CLICK_EVENT])
    expect(SEND_NOW_CLICK_EVENT).toBe('input_send_now_click')
  })

  test('no handler took it → the failure reason is reported (official m(...,"no_handler_took_it"))', () => {
    expect(NO_HANDLER_TOOK_IT_REASON).toBe('no_handler_took_it')
    const outcomes: string[] = []
    const handler = resolveSendNowClickHandler({
      isFullscreen: true,
      invokeSendNow: () => false,
      onEvent: (event, reason) => {
        if (reason !== undefined) outcomes.push(`${event}:${reason}`)
      },
    })
    handler?.()
    expect(outcomes).toEqual(['input_send_now_click:no_handler_took_it'])
  })
})

describe('source wiring pins (component uses the pure decision logic)', () => {
  const promptInputSrc = readFileSync(
    fileURLToPath(new URL('../PromptInput.tsx', import.meta.url)),
    'utf8',
  )
  const replSrc = readFileSync(
    fileURLToPath(new URL('../../../screens/REPL.tsx', import.meta.url)),
    'utf8',
  )

  test('SendNowHint gates the click on fullscreen via isFullscreenActive and wires onClick', () => {
    const hintFn = promptInputSrc.slice(
      promptInputSrc.indexOf('export function SendNowHint'),
    )
    expect(hintFn.includes('resolveSendNowHintUi')).toBe(true)
    expect(hintFn.includes('resolveSendNowClickHandler')).toBe(true)
    expect(hintFn.includes('isFullscreenActive()')).toBe(true)
    expect(hintFn.includes('onClick')).toBe(true)
    expect(hintFn.includes('invokeAction')).toBe(true)
    // The click path invokes the SAME action as the chord key.
    expect(hintFn.includes('SEND_NOW_ACTION')).toBe(true)
  })

  test('the fullscreen render site (REPL) still renders SendNowHint', () => {
    expect(
      replSrc.includes('{isFullscreenEnvEnabled() && <SendNowHint abortController={abortController} />}'),
    ).toBe(true)
  })
})
