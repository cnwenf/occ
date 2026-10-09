import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { AppStateProvider, getDefaultAppState } from '../../../state/AppState.js'
import { renderToAnsiStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import { AssistantTextMessage } from '../AssistantTextMessage.js'
import { TeammateMessageContent } from '../UserTeammateMessage.js'

/**
 * CC 2.1.295 P0 render-security — component-level raw OSC-8 sanitize.
 *
 * Official v295 strips raw OSC-8 hyperlink escapes from model text at the
 * render boundary (`Ecn` walkTokens control-char strip @220891500 region +
 * scanner `Ue` @220895091) so a smuggled clickable cell with a hidden address
 * never reaches the terminal. OCC seam: stripRawHyperlinks applied
 *   - in AssistantTextMessage before <Markdown> (component site),
 *   - in TeammateMessageContent before the raw-ANSI <Ansi> render,
 *   - in applyMarkdown (sanitize boundary for other callers).
 *
 * Markdown-GENERATED links must keep working (official `rw` emits OSC-8 for
 * `[text](url)` downstream of the strip).
 */

const ESC = '\x1b'
const BEL = '\x07'
const COLUMNS = 100

const EVIL = `${ESC}]8;;http://evil\x07click here${ESC}]8;;\x07`

function render(node: React.ReactNode): Promise<string> {
  return renderToAnsiStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>,
    COLUMNS,
  )
}

let savedForce: string | undefined
beforeAll(() => {
  savedForce = process.env.FORCE_HYPERLINK
  process.env.FORCE_HYPERLINK = '1'
})
afterAll(() => {
  if (savedForce === undefined) delete process.env.FORCE_HYPERLINK
  else process.env.FORCE_HYPERLINK = savedForce
})

describe('AssistantTextMessage — raw OSC-8 stripped before Markdown (2.1.295)', () => {
  test('smuggled raw hyperlink renders as plain anchor text; no OSC-8 bytes in the frame', async () => {
    const frame = await render(
      <AssistantTextMessage
        param={{ type: 'text', text: EVIL }}
        addMargin={false}
        shouldShowDot={false}
        verbose={false}
      />,
    )
    expect(frame).toContain('click here')
    expect(frame).not.toContain(`${ESC}]8;`)
    expect(frame).not.toContain(BEL)
    expect(frame).not.toContain('http://evil')
  })

  test('markdown link still produces a clickable OSC-8 cell in the frame', async () => {
    const frame = await render(
      <AssistantTextMessage
        param={{ type: 'text', text: '[x](https://ok)' }}
        addMargin={false}
        shouldShowDot={false}
        verbose={false}
      />,
    )
    // The component path renders the link via ink <Link>, which emits OSC-8
    // with a unique id param (`\x1b]8;id=xxxx;https://ok\x07`) — accept any
    // param segment; the security property is the live clickable cell.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC-8 hyperlinks are delimited by ESC(\x1b)/BEL(\x07); this assertion intentionally matches those control chars to verify the rendered link is well-formed.
    expect(frame).toMatch(/\x1b\]8;[^;\x07]*;https:\/\/ok\x07/)
    expect(frame).toContain('x')
  })
})

describe('TeammateMessageContent — raw OSC-8 stripped before Ansi (2.1.295)', () => {
  test('transcript-mode teammate content is sanitized', async () => {
    const frame = await render(
      <TeammateMessageContent
        displayName="peer"
        inkColor={undefined}
        content={EVIL}
        isTranscriptMode={true}
      />,
    )
    expect(frame).toContain('click here')
    expect(frame).not.toContain(`${ESC}]8;`)
    expect(frame).not.toContain(BEL)
    expect(frame).not.toContain('http://evil')
  })
})
