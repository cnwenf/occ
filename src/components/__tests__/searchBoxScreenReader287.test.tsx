import * as React from 'react'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { SearchBox } from '../SearchBox.js'
import CursorDeclarationContext, {
  type CursorDeclaration,
} from '../../ink/components/CursorDeclarationContext.js'
import type { DOMElement } from '../../ink/dom.js'
import { render, useApp } from '../../ink.js'
import { screenReader, isScreenReaderEnabled } from '../../utils/screenReader.js'

/**
 * v2.1.287 Item 1b — SearchBox screen-reader gating (official `By` delta).
 *
 * Official v287 `By` reads `Me = Ze()` (isScreenReaderEnabled) and, under SR:
 *   - renders the box borderless: `borderStyle: ge ? "round" : void 0` and
 *     `paddingX: ge ? 1 : 0` with `ge = false` under SR → borderStyle undefined,
 *     paddingX 0. OCC's `borderless` prop is the equivalent of official `!ge`,
 *     so SR folds into it (`effectiveBorderless = borderless || srEnabled`).
 *   - declares the caret so screen readers / magnifiers track it:
 *     `cE({ line: ne + we.line, column: q + we.column, active: J && !ue, visible: je })`.
 *     Under SR the box is borderless, so the border/padding offsets (official
 *     q / ne) collapse to 0; the caret column is its position within the
 *     rendered `{prefix} {query}` layout, in display cells (OCC's
 *     declared-cursor convention: Cursor.getPosition → stringIndexToDisplayWidth).
 *     `active` mirrors official `J && !ue` (box focused), gated on SR so
 *     non-SR cursor behavior is unchanged.
 *
 * Two render surfaces are exercised:
 *   - Borderless layout: the SR flat-render serializer output (screen-reader
 *     users see the flat serialization, not the SYNC-framed screen buffer).
 *   - Cursor declaration: via a CursorDeclarationContext spy. The declaration
 *     fires in useDeclaredCursor's layout effect during React commit, which is
 *     independent of Ink's render mode, so the spy observes it under SR.
 */

// ── helpers ──────────────────────────────────────────────────────────────

const BORDER_CHARS = ['╭', '╮', '╰', '╯', '│', '─']

function setSR(on: boolean): void {
  if (on) process.env.CLAUDE_AX_SCREEN_READER = '1'
  else delete process.env.CLAUDE_AX_SCREEN_READER
  screenReader.reset()
}

/**
 * Hold the instance open ~30ms before exiting. The shared isolated harness
 * exits at `setTimeout(exit, 0)`, which is too fast for the SR flat-render
 * frame to flush (SR's onRenderScreenReader writes on a later tick than the
 * normal screen-buffer blit). Verified: plain `<Box><Text>hi</Text></Box>`
 * renders "hi" under SR only with a real hold.
 */
function Hold({ ms }: { ms: number }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const timer = setTimeout(exit, ms)
    return () => clearTimeout(timer)
  }, [exit, ms])
  return null
}

/** Render under SR (or not) and return the STRIPPED flat output. */
async function renderSrStripped(node: React.ReactNode): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (e: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const instance = await render(
    <>
      {node}
      <Hold ms={30} />
    </>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
  )
  await instance.waitUntilExit()
  return stripAnsi(output)
}

type SpyCall = { decl: CursorDeclaration | null; node?: DOMElement | null }

/** Wraps children in a CursorDeclarationContext that records every setter call. */
function CursorSpy({
  calls,
  children,
}: {
  calls: SpyCall[]
  children: React.ReactNode
}) {
  const setter = React.useCallback(
    (decl: CursorDeclaration | null, node?: DOMElement | null) => {
      calls.push({ decl, node })
    },
    [calls],
  )
  return (
    <CursorDeclarationContext.Provider value={setter}>
      {children}
    </CursorDeclarationContext.Provider>
  )
}

/** The active (non-null) declarations recorded by the spy, in commit order. */
function activeDecls(calls: SpyCall[]): CursorDeclaration[] {
  return calls.map(c => c.decl).filter((d): d is CursorDeclaration => d !== null)
}

// ── fixtures ─────────────────────────────────────────────────────────────

const focusedProps = {
  query: 'ab',
  isFocused: true,
  isTerminalFocused: true,
  cursorOffset: 2,
} as const

describe('v2.1.287 Item 1b: SearchBox borderless layout under screen reader', () => {
  beforeEach(() => setSR(false))
  afterEach(() => setSR(false))

  test('renders borderless flat text under SR (no border characters)', async () => {
    // Arrange
    setSR(true)
    expect(isScreenReaderEnabled()).toBe(true)

    // Act — SR flat-render serialization is what a screen reader consumes.
    const out = await renderSrStripped(<SearchBox {...focusedProps} />)

    // Assert — prefix + query survive; the round border is gone
    // (official borderStyle:ge?"round":void 0 → undefined under SR).
    expect(out).toContain('⌕')
    expect(out).toContain('ab')
    for (const ch of BORDER_CHARS) {
      expect(out).not.toContain(ch)
    }
  })

  test('renders the round border when SR is off (default)', async () => {
    // Arrange
    setSR(false)
    expect(isScreenReaderEnabled()).toBe(false)

    // Act — normal (non-SR) frame via the shared isolated harness.
    const out = await renderToStringIsolated(<SearchBox {...focusedProps} />)

    // Assert — the box border is present, confirming SR is what removes it.
    expect(out).toContain('╭')
    expect(out).toContain('│')
    expect(out).toContain('╰')
  })

  test('borderless prop renders no border with SR off (the path SR folds into)', async () => {
    // Arrange
    setSR(false)

    // Act — effectiveBorderless = borderless || srEnabled; here borderless=true.
    const out = await renderToStringIsolated(
      <SearchBox {...focusedProps} borderless={true} />,
    )

    // Assert — same borderless shape SR produces, via the explicit prop.
    expect(out).toContain('⌕')
    expect(out).toContain('ab')
    for (const ch of BORDER_CHARS) {
      expect(out).not.toContain(ch)
    }
  })
})

describe('v2.1.287 Item 1b: SearchBox cursor declaration under screen reader', () => {
  beforeEach(() => setSR(false))
  afterEach(() => setSR(false))

  test('declares the caret at end-of-query when SR on and focused', async () => {
    // Arrange — query "ab", caret after both chars (offset 2).
    // column = width("⌕")1 + space1 + width("ab")2 = 4; single text row → line 0.
    setSR(true)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox {...focusedProps} />
      </CursorSpy>,
    )

    // Assert
    const decls = activeDecls(calls)
    expect(decls.length).toBeGreaterThan(0)
    expect(decls[0].relativeX).toBe(4)
    expect(decls[0].relativeY).toBe(0)
    expect(decls[0].node).toBeTruthy()
  })

  test('declares caret at start-of-query (offset 0) as prefix + space width', async () => {
    // Arrange — caret before any query char: column = width("⌕")1 + space1 = 2.
    setSR(true)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox query="ab" isFocused={true} isTerminalFocused={true} cursorOffset={0} />
      </CursorSpy>,
    )

    // Assert
    const decls = activeDecls(calls)
    expect(decls.length).toBeGreaterThan(0)
    expect(decls[0].relativeX).toBe(2)
    expect(decls[0].relativeY).toBe(0)
  })

  test('declares caret mid-query at the correct cell offset', async () => {
    // Arrange — caret after "a" (offset 1): column = 1 + 1 + width("a")1 = 3.
    setSR(true)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox query="ab" isFocused={true} isTerminalFocused={true} cursorOffset={1} />
      </CursorSpy>,
    )

    // Assert
    const decls = activeDecls(calls)
    expect(decls.length).toBeGreaterThan(0)
    expect(decls[0].relativeX).toBe(3)
  })

  test('declares caret using display cells, not char offsets (CJK width 2)', async () => {
    // Arrange — query "日本", caret after "日" (offset 1). "日" is 2 cells, so
    // column = width("⌕")1 + space1 + width("日")2 = 4. A char-offset bug
    // would yield 3. OCC's declared-cursor column is cell-based (stringWidth).
    setSR(true)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox query="日本" isFocused={true} isTerminalFocused={true} cursorOffset={1} />
      </CursorSpy>,
    )

    // Assert
    const decls = activeDecls(calls)
    expect(decls.length).toBeGreaterThan(0)
    expect(decls[0].relativeX).toBe(4)
  })

  test('declares nothing when SR on but box is NOT focused', async () => {
    // Arrange — active mirrors official J && !ue; unfocused → inactive.
    setSR(true)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox query="ab" isFocused={false} isTerminalFocused={false} cursorOffset={2} />
      </CursorSpy>,
    )

    // Assert — the effect ran but only emitted clears (null), never a declaration.
    expect(calls.length).toBeGreaterThan(0)
    expect(activeDecls(calls).length).toBe(0)
  })

  test('declares nothing when SR is off even if focused (non-SR unchanged)', async () => {
    // Arrange — SearchBox declared no cursor before this port; SR gate keeps
    // non-SR behavior byte-identical.
    setSR(false)
    const calls: SpyCall[] = []

    // Act
    await renderToStringIsolated(
      <CursorSpy calls={calls}>
        <SearchBox {...focusedProps} />
      </CursorSpy>,
    )

    // Assert
    expect(calls.length).toBeGreaterThan(0)
    expect(activeDecls(calls).length).toBe(0)
  })
})
