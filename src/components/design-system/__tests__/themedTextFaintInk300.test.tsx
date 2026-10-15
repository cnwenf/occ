/**
 * CC 2.1.300 changelog #47 — ThemedText auto-computes faintInk so dim
 * (secondary) text is distinguishable from normal text under the dark ANSI
 * theme and on 16-color terminals.
 *
 * Official evidence (2.1.300 linux-x64 ELF, byte-verified):
 *
 * - v300 themed-Text wrapper @235309350/235309900 — the standalone caller
 *   `faintInk` prop was REMOVED from the destructuring (v299 @234021584 had
 *   `faintInk:b`, `I=b===void 0?!1:b`, `G=I&&T&&!_?j:void 0`); v300 computes
 *   it automatically for ALL dimColor text:
 *     A=f===void 0?!1:f            (dimColor)
 *     W=Ae(Wet)                    (useContext of the message-row hover ctx)
 *     L=A&&!W?_.inactive:Y(d,_)    (resolvedColor)
 *     const G=A&&!W?D:void 0       (faintInk = dimColor && !hovered
 *                                    ? resolvedColor : undefined)
 *     e(Dc,{color:D,...,faintInk:G,...})
 *   The context `Wet` is `Kt(!1)` = createContext(false) @235309263; its sole
 *   provider (byte-identical in v299 as `$7e` @243869881) is the message-row
 *   wrapper `pE` @245282095: `Wet.Provider value={hovered && !expanded}` —
 *   i.e. W is the ROW-HOVER context, not a theme property. (The triage's
 *   "whitish theme" reading was wrong: the light-theme detector `y6e`
 *   (startsWith("light") @219913810) is consumed only by the hyperlink
 *   renderer @230815012.)
 * - Under the dark ANSI theme (`text:'ansi:whiteBright'`,
 *   `inactive:'ansi:white'` — matching the official palette @219919343) dim
 *   text was a near-invisible step, and on 16-color terminals ansi:white vs
 *   ansi:whiteBright often render identically. faintInk makes the painter add
 *   SGR-2 (see src/ink/__tests__/faintInkDim300.test.tsx).
 *
 * OCC mapping: OCC has no message-row hover boolean context; its hover
 * mechanism is `TextHoverColorContext` (recolors uncolored text when hovered),
 * which takes precedence over dimColor exactly like the official `!W` path
 * (hover wins → dim path inactive → faintInk stays undefined).
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { renderToAnsiStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import ThemedText, { TextHoverColorContext } from '../ThemedText.js'
import { ThemeProvider } from '../ThemeProvider.js'

const SGR2 = '\x1b[2m'

async function renderWithTheme(node: React.ReactNode, level: number): Promise<string> {
  const saved = chalk.level
  try {
    chalk.level = level as typeof chalk.level
    return await renderToAnsiStringIsolated(node, 60)
  } finally {
    chalk.level = saved
  }
}

function darkAnsiFrame(level: number): Promise<string> {
  return renderWithTheme(
    <ThemeProvider initialState="dark-ansi" onThemeSave={() => {}}>
      <ThemedText dimColor>secondary-span</ThemedText>
      <ThemedText color="text">normal-span</ThemedText>
    </ThemeProvider>,
    level,
  )
}

describe('CC 2.1.300 #47: ThemedText dimColor under the dark ANSI theme', () => {
  test('dim text carries SGR 2 at 16-color level (level 1)', async () => {
    const frame = await darkAnsiFrame(1)
    const idx = frame.indexOf('secondary-span')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(frame.slice(0, idx)).toContain(SGR2)
    // dark-ansi inactive = 'ansi:white' → SGR 37
    expect(frame.slice(0, idx)).toContain('\x1b[37m')
  })

  test('normal text does NOT carry SGR 2 — dim now differs from normal', async () => {
    const frame = await darkAnsiFrame(1)
    const idx = frame.indexOf('normal-span')
    expect(idx).toBeGreaterThanOrEqual(0)
    const dimIdx = frame.indexOf('secondary-span')
    // Between the end of the dim span and the normal span, no NEW dim open
    // code may appear; the normal span itself carries whiteBright (SGR 97).
    const between = frame.slice(dimIdx + 'secondary-span'.length, idx)
    expect(between).not.toContain(SGR2)
    expect(frame.slice(0, idx)).toContain('\x1b[97m')
  })

  test('dim text carries SGR 2 at truecolor level (level 3) too', async () => {
    const frame = await darkAnsiFrame(3)
    const idx = frame.indexOf('secondary-span')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(frame.slice(0, idx)).toContain(SGR2)
  })

  test('styled dim output is no longer the plain inactive color', async () => {
    // v299 behavior: dim span === chalk.white('secondary-span') exactly —
    // indistinguishable from normal on 16-color terminals. v300 adds SGR 2.
    const frame = await darkAnsiFrame(1)
    // Expected value MUST be computed at the pinned level — the test env's
    // default chalk.level is 0, where chalk.white('x') === 'x' and the
    // assertion would trivially fail against the raw text.
    const saved = chalk.level
    let plainV299: string
    try {
      chalk.level = 1 as typeof chalk.level
      plainV299 = chalk.white('secondary-span')
    } finally {
      chalk.level = saved
    }
    expect(plainV299).toContain('\x1b[37m')
    expect(frame).not.toContain(plainV299)
  })
})

describe('CC 2.1.300 #47: faintInk suppression paths', () => {
  test('hover override (OCC !W analog) drops faintInk — no SGR 2', async () => {
    // Official: G=A&&!W?D:void 0 — when the hover context is active the dim
    // path is inactive, so no faintInk. OCC analog: TextHoverColorContext
    // recolors uncolored text; 'subtle' is 'ansi:white' under dark-ansi, so
    // without the hover suppression this span WOULD be whitish-dimmed.
    const frame = await renderWithTheme(
      <ThemeProvider initialState="dark-ansi" onThemeSave={() => {}}>
        <TextHoverColorContext.Provider value="subtle">
          <ThemedText dimColor>hovered-span</ThemedText>
        </TextHoverColorContext.Provider>
      </ThemeProvider>,
      1,
    )
    const idx = frame.indexOf('hovered-span')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(frame.slice(0, idx)).not.toContain(SGR2)
    expect(frame.slice(0, idx)).toContain('\x1b[37m')
  })

  test('default dark theme (rgb inactive) does NOT over-apply SGR 2', async () => {
    // dark theme inactive = rgb(153,153,153) — a distinct color at every
    // level, so the whitish detector must stay false and no dim is added.
    const frame = await renderWithTheme(<ThemedText dimColor>rgb-dim-span</ThemedText>, 3)
    const idx = frame.indexOf('rgb-dim-span')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(frame.slice(0, idx)).not.toContain(SGR2)
    expect(frame.slice(0, idx)).toContain('38;2;153;153;153')
  })
})
