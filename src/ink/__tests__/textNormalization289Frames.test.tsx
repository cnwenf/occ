import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'
import { Box, render, Text } from '../../ink.js'
import type { DOMElement } from '../dom.js'
import { LayoutDisplay, type LayoutNode } from '../layout/node.js'
import Output from '../output.js'
import renderNodeToOutput from '../render-node-to-output.js'
import { CharPool, HyperlinkPool, StylePool, createScreen } from '../screen.js'

/**
 * CC 2.1.289 changelog #19 — shared text-normalization pipeline: the
 * RENDERED-FRAME half (the normalizer itself is unit-tested in
 * textNormalization289.test.ts).
 *
 * Official markers recovered verbatim from the 2.1.289 linux-x64 ELF:
 *   @201062051  YSt/uR/hR/pR/_R/mR/gR, $se, $rr, u9r, p9r, Ua, Va, La
 *   @200687588  Mme({forOutput:!0}) — the text/sequence tokenizer `Ua` uses
 *   @205420347  bft = [[1564,1564],[8234,8238],[8294,8297]] (bidi table
 *               handed to the NATIVE painter) + R8e (bidi-only /gu regex)
 *   @213553684  h0/amo, Ya (replaceBidi), XX, Oc, Hc, ja (wrap-mode test)
 *   @213590147  mE (measure) + pE (raw-ansi measure, NOT normalized)
 *   @213698657  dC (segment-list normalizer) + fC (padding)
 *   @213699402  Gs (render ink-text) incl. the `ce!==ie` re-slice
 *   @213698178  Rv (wrapWithSoftWrap) incl. the /\r\n?/g -> \n pre-pass
 *
 * Two claims in docs/gap-research-289/cluster-f-mods-ui-runtime.md §#19 are
 * corrected by the binary and are asserted accordingly below:
 *   1. "a<0x9b>b shows U+FFFD" — WRONG. `hR=/[\x1b\x9b]/g` maps 0x9b to CAN
 *      (U+0018); only `pR=/[\x90\x98\x9d-\x9f]/g` maps to U+FFFD and it does
 *      NOT include 0x9b. CAN is zero-width, so the frame keeps "b" and shows
 *      no replacement glyph.
 *   2. "a<ESC>b keeps b with <0x18>" — only true at a PIECE boundary. A
 *      complete ESC+printable pair tokenizes as a `sequence` (Ua: ESC +
 *      0x30-0x7e), `Va` returns undefined for sequences, and `$rr` appends
 *      the token verbatim. The dangling-ESC-as-text rewrite (`mR` gate on
 *      the tokenizer's end-of-input buffer) fires only when the ESC ends a
 *      non-final piece.
 *
 * Harness note: frames are captured raw (no stripAnsi) because the escapes
 * ARE the assertions; only the DEC sync markers (?2026h/l) are removed.
 */

const ch = (code: number): string => String.fromCharCode(code)

const BEL = ch(0x07)
const CAN = ch(0x18)
const ESC = ch(0x1b)
const C1_CSI = ch(0x9b)
const C1_OSC = ch(0x9d)
const RLO = ch(0x202e)
const FFFD = ch(0xfffd)
const SYNC_ON = `${ESC}[?2026h`
const SYNC_OFF = `${ESC}[?2026l`

/** 8-column tab stop: 'a' sits in column 0, so the tab pads 8 - 1 = 7. */
const TAB_FROM_COL_1 = ' '.repeat(7)
/** Column tracker is shared across pieces: 'a' + FFFD = 2 columns -> 6. */
const TAB_FROM_COL_2 = ' '.repeat(6)

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const mounted: Array<{ unmount: () => void }> = []

afterEach(async () => {
  for (const instance of mounted.splice(0)) {
    instance.unmount()
    await delay(10)
  }
})

/**
 * Render `node` offscreen and return the exact bytes the frame encoder
 * emitted, minus the DEC synchronous-update markers.
 */
async function captureFrame(node: React.ReactNode): Promise<string> {
  const chunks: string[] = []
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    chunks.push(chunk.toString())
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  // Per-property casts: ReadStream's declared setRawMode/ref/unref signatures
  // (`this`-returning) conflict with no-op polyfill assignments otherwise.
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  mounted.push(instance)
  await delay(60)
  return chunks
    .join('')
    .split(SYNC_ON)
    .join('')
    .split(SYNC_OFF)
    .join('')
}

describe('CC 2.1.289 #19 — normalized frames: tabs ($rr, 8-column stops)', () => {
  test('paints "a TAB b" as literal 8-column spacing with no cursor-forward escape', async () => {
    // Arrange
    const node = <Text>{'a\tb'}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — doc expectation #1: literal spaces, never a CUF escape.
    expect(frame).toBe(`a${TAB_FROM_COL_1}b`)
    expect(frame).not.toContain(ESC)
  })

  test('tracks the tab column across separately-styled pieces', async () => {
    // Arrange — two segments: 'ab' then TAB + 'c'. Official `$rr` carries the
    // column register `r` across the piece list, so the stop is 8 - 2 = 6.
    const node = (
      <Text>
        {'ab'}
        <Text>{'\tc'}</Text>
      </Text>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert
    expect(frame).toBe(`ab${' '.repeat(6)}c`)
  })

  test('shares the column register with a replacement char from an earlier piece', async () => {
    // Arrange — piece 0 carries a C1 OSC (0x9d, in `pR`) which normalizes to
    // U+FFFD (width 1), so the tab in piece 1 pads from column 2, not 1.
    const node = (
      <Text>
        {`a${C1_OSC}`}
        <Text>{'\tb'}</Text>
      </Text>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert
    expect(frame).toBe(`a${FFFD}${TAB_FROM_COL_2}b`)
  })
})

describe('CC 2.1.289 #19 — normalized frames: control bytes (Va/La)', () => {
  test('keeps the text after a piece-final stray ESC instead of swallowing it', async () => {
    // Arrange — the ESC ends a NON-final piece, so `Ua` flushes it as a text
    // token (`mR` does not match a lone ESC) and `Va` rewrites it to CAN.
    const node = (
      <Text>
        {`a${ESC}`}
        <Text>{'b'}</Text>
      </Text>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — doc expectation #2: 'b' survives. CAN itself is zero-width.
    expect(frame).toBe('ab')
  })

  test('leaves a complete ESC+printable sequence alone (binary-verified)', async () => {
    // Arrange — one piece, ESC followed by 'b': `Mme({forOutput:!0})` emits
    // ESC + 0x30-0x7e as a *sequence* token, `Va` returns undefined for it,
    // and `$rr` appends the raw value. The normalizer must NOT rewrite it.
    const node = <Text>{`a${ESC}b`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — unchanged from pre-port OCC: the cell writer still consumes
    // the two-byte escape. The doc's "keeps b with 0x18" reading applies at
    // piece boundaries only (see the test above).
    expect(frame).toBe('a')
    expect(frame).not.toContain(FFFD)
  })

  test('maps a bare C1 CSI to CAN and keeps the following text', async () => {
    // Arrange — 0x9b is in `hR` (ESC|CSI -> CAN), NOT in `pR` (-> U+FFFD).
    const node = <Text>{`a${C1_CSI}b`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — doc expectation #3, corrected per the binary: no glyph, and
    // crucially 'b' is not eaten as a CSI parameter byte.
    expect(frame).toBe('ab')
    expect(frame).not.toContain(FFFD)
  })

  test('maps a C1 OSC byte to U+FFFD', async () => {
    // Arrange — 0x9d IS in `pR`, so `La` replaces it with U+FFFD.
    const node = <Text>{`a${C1_OSC}b`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert
    expect(frame).toBe(`a${FFFD}b`)
  })

  test('turns an unterminated string introducer into visible text (mR)', async () => {
    // Arrange — OSC opens but never terminates. Official `Ua` types the
    // end-of-input buffer as `isLast && !mR.test(buffer) ? 'sequence' : 'text'`
    // and `mR=/^\x1b[P\]X^_k]/` MATCHES ESC + ']', so a truncated OSC is forced
    // to TEXT: `Va` then CAN-ifies the ESC and the payload survives as cells.
    // A half-written title sequence must never reach the terminal as a control
    // sequence (that is exactly the "stray escape" hazard from the changelog).
    const node = <Text>{`a${ESC}]0;title`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — CAN (0x18) is width 0 and skipped by the cell writer, so the
    // payload paints. Pre-port OCC swallowed ']0;title' as an unterminated OSC.
    expect(frame).toBe('a]0;title')
    expect(frame).not.toContain(FFFD)
    expect(frame).not.toContain(CAN)
  })
})

describe('CC 2.1.289 #19 — normalized frames: bidi overrides (Ya / bft)', () => {
  test('neutralizes a right-to-left override with U+FFFD', async () => {
    // Arrange — U+202E is inside the official `bft` range [8234,8238]. The
    // official delegates this to the NATIVE painter (constructed with bft);
    // OCC's cell writer is the painter, so it applies `Ya` before caching.
    const node = <Text>{`a${RLO}b`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — U+FFFD is width 1, exactly like the override it replaces, so
    // measure and paint stay in agreement.
    expect(frame).toBe(`a${FFFD}b`)
  })
})

describe('CC 2.1.289 #19 — non-wrap modes normalize the whole string (XX)', () => {
  test('expands a tab before styling in truncate mode (single piece)', async () => {
    // Arrange — `ne` is not a wrap mode, so `ce = XX(ie)`: the tab is already
    // literal spaces when BOTH the width decision (`lf(ce) > le`) and the styled
    // runs are computed. Truncate modes have no cell-writer tab expansion to
    // fall back on, which is exactly why the official normalizes them here.
    const node = (
      <Box width={20}>
        <Text textWrap="truncate">{'a\tb'}</Text>
      </Box>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — 8-column stop measured from column 1, no control byte left.
    expect(frame).toBe(`a${TAB_FROM_COL_1}b`)
    expect(frame).not.toContain(ESC)
  })

  test('keeps the re-sliced runs aligned across pieces in truncate mode', async () => {
    // Arrange — two pieces, so `Gs`'s `let fe = ce !== ie` re-slice runs: it
    // walks the ORIGINAL offsets ('ab' then '\tc') but emits the NORMALIZED
    // characters. An off-by-one in that walk shows up as a wrong space count.
    const node = (
      <Box width={20}>
        <Text textWrap="truncate">
          {'ab'}
          <Text>{'\tc'}</Text>
        </Text>
      </Box>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — the column register is shared across pieces: 2 columns used, so
    // the stop pads 8 - 2 = 6.
    expect(frame).toBe(`ab${' '.repeat(6)}c`)
  })

  test('neutralizes a bidi override in truncate mode', async () => {
    // Arrange — `XX` runs `Ya`, so in a non-wrap mode the override is replaced
    // before the width decision rather than only at paint time.
    const node = (
      <Box width={20}>
        <Text textWrap="truncate">{`a${RLO}b`}</Text>
      </Box>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — U+FFFD is width 1, the same width the override measured as.
    expect(frame).toBe(`a${FFFD}b`)
  })
})

describe('CC 2.1.289 #19 — normalized frames: styles and links survive', () => {
  test('keeps SGR-styled text intact through normalization', async () => {
    // Arrange
    const node = <Text>{`${ESC}[31mred${ESC}[39m`}</Text>

    // Act
    const frame = await captureFrame(node)

    // Assert — sequence tokens are appended verbatim by `$rr`, so no control
    // byte may be substituted and the visible text is untouched. (The exact
    // SGR bytes depend on the color environment, hence substring assertions.)
    expect(frame).toContain('red')
    expect(frame).not.toContain(FFFD)
    expect(frame).not.toContain(CAN)
  })

  test('keeps an OSC-8 hyperlink intact through normalization', async () => {
    // Arrange
    const node = (
      <Text>{`${ESC}]8;;https://example.com${BEL}label${ESC}]8;;${BEL}`}</Text>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — BEL-terminated OSC pairs satisfy `gR`, so `Va` cleans them as
    // text (ESC -> CAN) and the writer re-emits the link. OCC injects its own
    // `id=` parameter, so assert shape rather than exact bytes.
    expect(frame).toContain('label')
    expect(frame).toContain('https://example.com')
    expect(frame).not.toContain(FFFD)
  })
})

describe('CC 2.1.289 #19 — normalized frames: row containment', () => {
  test('keeps a height-1 box from painting the row after a CRLF', async () => {
    // Arrange — doc expectation #4.
    const node = (
      <Box flexDirection="column">
        <Box height={1}>
          <Text>{'x\ty\r\nz'}</Text>
        </Box>
        <Text>SENTINEL</Text>
      </Box>
    )

    // Act
    const frame = await captureFrame(node)

    // Assert — 'z' stays clipped inside the 1-row box; SENTINEL owns row 2.
    expect(frame).toBe(`x${TAB_FROM_COL_1}y\nSENTINEL`)
  })
})

/**
 * Row-provenance harness: `Rv` (wrapWithSoftWrap) gained a
 * `n.replace(/\r\n?/g,"\n").split("\n")` pre-pass, so a lone CR is a HARD
 * break (official `$n.HardBreak`) rather than one long line that the wrapper
 * soft-splits. The frame encoder emits a newline either way, so the
 * observable is `screen.softWrap[row]` — which is what text selection
 * (`getSelectedText`) reads to decide whether two rows are one logical line.
 *
 * Built on stub LayoutNodes (the pattern from deepUiTreeStackGuard.test.ts)
 * so yoga's recursive calculateLayout never runs.
 */
const PROV_WIDTH = 4
const PROV_HEIGHT = 4

function makeStubYoga(): LayoutNode {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'getDisplay') return () => LayoutDisplay.Flex
        if (prop === 'getComputedLeft' || prop === 'getComputedTop')
          return () => 0
        if (prop === 'getComputedWidth') return () => PROV_WIDTH
        if (prop === 'getComputedHeight') return () => PROV_HEIGHT
        if (prop === 'getComputedBorder' || prop === 'getComputedPadding')
          return () => 0
        if (prop === 'getParent') return () => null
        if (prop === 'getChildCount') return () => 0
        return () => {}
      },
    },
  ) as unknown as LayoutNode
}

function makeElement(nodeName: string): DOMElement {
  return {
    nodeName,
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: makeStubYoga(),
    style: {},
    dirty: true,
  } as unknown as DOMElement
}

/** Paint one ink-text node holding `value` and return the soft-wrap bitmap. */
function renderSoftWrapBits(value: string): Int32Array {
  const root = makeElement('ink-root')
  const text = makeElement('ink-text')
  const leaf = {
    nodeName: '#text',
    nodeValue: value,
    attributes: {},
    childNodes: [],
    style: {},
  } as unknown as DOMElement
  leaf.parentNode = text
  text.childNodes.push(leaf)
  text.parentNode = root
  root.childNodes.push(text)

  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const screen = createScreen(
    PROV_WIDTH,
    PROV_HEIGHT,
    stylePool,
    charPool,
    hyperlinkPool,
  )
  const output = new Output({
    width: PROV_WIDTH,
    height: PROV_HEIGHT,
    stylePool,
    screen,
  })
  renderNodeToOutput(root, output, { prevScreen: undefined })
  output.get()
  return screen.softWrap
}

describe('CC 2.1.289 #19 — Rv CR pre-pass: row provenance', () => {
  test('marks the row after a lone CR as a hard break', () => {
    // Arrange — 'aaa' + CR + 'bbb' in a 4-column box: two 3-wide rows.
    const softWrap = renderSoftWrapBits('aaa\rbbb')

    // Act / Assert — 0 means "row starts a new logical line" (HardBreak).
    // Pre-port this was prevContentEnd (3), i.e. a soft continuation, which
    // made copy/selection glue the two rows into 'aaabbb'.
    expect(softWrap[1]).toBe(0)
  })

  test('marks the row after a newline as a hard break (control)', () => {
    // Arrange
    const softWrap = renderSoftWrapBits('aaa\nbbb')

    // Act / Assert
    expect(softWrap[1]).toBe(0)
  })

  test('still marks a wrapped continuation row as soft', () => {
    // Arrange — 6 chars in a 4-column box wraps at the width, so row 1 is a
    // genuine continuation of row 0.
    const softWrap = renderSoftWrapBits('aaaabb')

    // Act / Assert — non-zero = the previous row's content end.
    expect(softWrap[1]).toBeGreaterThan(0)
  })
})
