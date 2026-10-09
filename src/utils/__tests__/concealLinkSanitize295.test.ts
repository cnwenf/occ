import { describe, expect, test } from 'bun:test'
import {
  createHyperlink,
  OSC8_END,
  OSC8_START,
  SHOWN_URL_NEUTRALIZER,
} from '../hyperlink.js'

/**
 * CC 2.1.295 changelog #031 (P0 render-security) — "Fixed a link address shown
 * as text being hidden by a colour or conceal style a reply left on, including
 * where it wraps in a table or a question preview."
 *
 * This is the SGR sibling of #050 (raw OSC-8 strip). Official v295 emits
 * `Fe = ESC[28m ESC[39m ESC[49m` (conceal OFF, default fg, default bg) at the
 * start of a link ADDRESS SHOWN AS TEXT — byte-verified in the v295 ELF
 * @94784380, beside the markdown URL/nbsp regexes. It is genuinely new in 295:
 * `shownUrlStart` and `afterStyle` are both 0→3 occurrences in the 2.1.294→295
 * strings diff. Official gates `Fe` on an `afterStyle` flag; OCC tracks no such
 * flag, so it applies `Fe` unconditionally whenever the address is the visible
 * text — a safe superset matching official's unconditional `pe(e)=ue(e,Fe)`.
 *
 * OCC seam: `createHyperlink` (src/utils/hyperlink.ts). Every shown-as-text URL
 * funnels through it — the markdown link whose label equals the URL / is empty
 * (markdown.ts:292, which is how a table cell or a question-preview markdown
 * link renders), and a bare URL in shell output (OutputLine.tsx:45). A link with
 * a DISTINCT label shows the label, not the address, so official skips `Fe`
 * (its `U` flag is false) and so does OCC.
 */

const URL = 'https://example.com/a/very/long/address'

describe('CC 2.1.295 #031 — SHOWN_URL_NEUTRALIZER is official `Fe`', () => {
  test('is exactly conceal-off + default-fg + default-bg, in that order', () => {
    // Arrange / Act / Assert — SGR 28 (conceal off), 39 (default fg), 49
    // (default bg). Resetting all three defeats both a lingering conceal AND a
    // foreground colour matched to the background.
    expect(SHOWN_URL_NEUTRALIZER).toBe('\x1b[28m\x1b[39m\x1b[49m')
    expect(SHOWN_URL_NEUTRALIZER).toContain('\x1b[28m') // reveal
    expect(SHOWN_URL_NEUTRALIZER).toContain('\x1b[39m') // default foreground
    expect(SHOWN_URL_NEUTRALIZER).toContain('\x1b[49m') // default background
  })
})

describe('CC 2.1.295 #031 — no OSC-8 support: the bare address is shown as text', () => {
  test('prepends `Fe` before the URL so a residual conceal/colour cannot hide it', () => {
    // Arrange / Act
    const result = createHyperlink(URL, undefined, { supportsHyperlinks: false })

    // Assert — neutralizer first, then the visible address, nothing else.
    expect(result).toBe(`${SHOWN_URL_NEUTRALIZER}${URL}`)
    expect(result.startsWith(SHOWN_URL_NEUTRALIZER)).toBe(true)
    expect(result).toContain(URL)
  })

  test('still neutralizes when a label is passed but ignored (unsupported terminals show only the URL)', () => {
    // Arrange / Act — `content` is ignored without OSC-8 support, so the address
    // is still the shown text and still gets `Fe`.
    const result = createHyperlink(URL, 'click here', {
      supportsHyperlinks: false,
    })

    // Assert
    expect(result).toBe(`${SHOWN_URL_NEUTRALIZER}${URL}`)
  })
})

describe('CC 2.1.295 #031 — OSC-8 supported, address shown as text (no distinct label)', () => {
  test('emits `Fe` ahead of the OSC-8 cell when there is no label', () => {
    // Arrange / Act
    const result = createHyperlink(URL, undefined, { supportsHyperlinks: true })

    // Assert — neutralizer leads, then a well-formed OSC-8 wrapping the address.
    expect(result.startsWith(SHOWN_URL_NEUTRALIZER)).toBe(true)
    expect(result).toContain(`${OSC8_START}${URL}${OSC8_END}`)
  })

  test('emits `Fe` when the label is identical to the address (address is the visible text)', () => {
    // Arrange / Act
    const result = createHyperlink(URL, URL, { supportsHyperlinks: true })

    // Assert
    expect(result.startsWith(SHOWN_URL_NEUTRALIZER)).toBe(true)
    expect(result).toContain(`${OSC8_START}${URL}${OSC8_END}`)
  })
})

describe('CC 2.1.295 #031 — OSC-8 supported, distinct label (address NOT shown as text)', () => {
  test('does NOT emit `Fe` when a distinct label is the visible text', () => {
    // Arrange / Act — official skips `Fe` here (its address-shown-as-text flag
    // `U` is false): the user sees "click here", not the address.
    const result = createHyperlink(URL, 'click here', {
      supportsHyperlinks: true,
    })

    // Assert — no neutralizer, but a live clickable OSC-8 cell around the label.
    expect(result).not.toContain(SHOWN_URL_NEUTRALIZER)
    expect(result.startsWith(SHOWN_URL_NEUTRALIZER)).toBe(false)
    expect(result).toContain(`${OSC8_START}${URL}${OSC8_END}`)
    expect(result).toContain('click here')
  })
})
