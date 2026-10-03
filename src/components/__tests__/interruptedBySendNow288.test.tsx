/**
 * CC 2.1.288 #59 — the Interrupted row hides its hint after a ctrl+enter
 * send-now.
 *
 * Official binary evidence (offsets into /tmp/cc-diff-288/v288/package/claude,
 * verified with dd):
 *
 *   @227383175 —
 *     `function Ia(){return"What should Claude do instead?"}`
 *     `var Lt=Wt(!1);`                       // createContext(false)
 *     `function La(){ … if(Ce(Lt)){ … e(n,{dimColor:!0,children:"Interrupted"}) … return p }`
 *     `… e(n,{dimColor:!0,children:"Interrupted "}) … r(K,{children:[p, r(n,{dimColor:!0,children:["\xB7 ",Ia()]})]}) …`
 *
 *   So the row has TWO shapes:
 *     - context TRUE  (send-now cut):  `<Text dimColor>Interrupted</Text>`
 *                                      — no trailing space, no hint.
 *     - context FALSE (user Esc):      `<Text dimColor>Interrupted </Text>` +
 *                                      `<Text dimColor>· What should Claude do instead?</Text>`
 *
 *   @227595016 — the message-row `case "user"` supplies the context value:
 *     `const Te=l.interruptedBySendNow===!0; … e(Lt.Provider,{value:Te,children:qe})`
 *   @227597624 — the `case "collapsed_read_search"` supplies it from the
 *     group's tool results:
 *     `lookups.toolResultByToolUseID.get(uuid)?.type==="user" && …interruptedBySendNow===!0`
 */

import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'
import {
  InterruptedBySendNowContext,
  InterruptedByUser,
  interruptedHintText,
} from '../InterruptedByUser.js'

// Official `Ia()` @227383175 — verbatim.
const OFFICIAL_HINT = 'What should Claude do instead?'

/**
 * The production shape — every call site renders
 * `<MessageResponse height={1}><InterruptedByUser /></MessageResponse>`
 * (UserTextMessage.tsx:89, AssistantTextMessage.tsx:197,
 * UserToolCanceledMessage.tsx:9, UserToolErrorMessage.tsx:36,
 * FallbackToolUseRejectedMessage.tsx:9), so the row is asserted inside it.
 */
function Row({ isBySendNow }: { isBySendNow?: boolean }) {
  const row = (
    <MessageResponse height={1}>
      <InterruptedByUser />
    </MessageResponse>
  )
  if (isBySendNow === undefined) {
    return row
  }
  return (
    <InterruptedBySendNowContext.Provider value={isBySendNow}>
      {row}
    </InterruptedBySendNowContext.Provider>
  )
}

/** Collapse the ⎿ gutter + layout newlines so the row reads as one line. */
function normalize(out: string): string {
  return out
    .replace(/⎿/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('CC 2.1.288 #59 — InterruptedByUser row', () => {
  test('interruptedHintText() is the verbatim official Ia() string', () => {
    expect(interruptedHintText()).toBe(OFFICIAL_HINT)
  })

  test('the context defaults to false with no Provider above it (official `Wt(!1)`)', async () => {
    function Probe() {
      const value = React.useContext(InterruptedBySendNowContext)
      return <Text>{String(value)}</Text>
    }
    const out = await renderToStringIsolated(<Probe />)

    expect(out.trim()).toBe('false')
  })

  test('with no provider it renders "Interrupted · What should Claude do instead?"', async () => {
    const out = await renderToStringIsolated(<Row />)

    expect(normalize(out)).toContain('Interrupted')
    expect(normalize(out)).toContain(`· ${OFFICIAL_HINT}`)
  })

  test('provider value=false keeps the hint (the user Esc interrupt)', async () => {
    const out = await renderToStringIsolated(<Row isBySendNow={false} />)

    expect(normalize(out)).toContain(`· ${OFFICIAL_HINT}`)
  })

  test('provider value=true drops the hint AND the trailing space (ctrl+enter send-now)', async () => {
    const out = await renderToStringIsolated(<Row isBySendNow={true} />)

    expect(normalize(out)).toBe('Interrupted')
    expect(out).not.toContain(OFFICIAL_HINT)
    expect(out).not.toContain('·')
  })

  test('the two shapes differ only by the hint suffix', async () => {
    const withHint = await renderToStringIsolated(<Row isBySendNow={false} />)
    const withoutHint = await renderToStringIsolated(<Row isBySendNow={true} />)

    expect(normalize(withHint)).toContain(`Interrupted · ${OFFICIAL_HINT}`)
    expect(normalize(withoutHint)).toBe('Interrupted')
  })
})
