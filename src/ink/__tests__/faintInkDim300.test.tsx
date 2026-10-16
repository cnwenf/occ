/**
 * CC 2.1.300 changelog #47 — dim (secondary) text must be distinguishable
 * from normal text under the dark ANSI theme and on 16-color terminals.
 *
 * Official evidence (2.1.300 linux-x64 ELF, byte-verified):
 *
 * - Style applicator `h6e` @219912500 (v299 `F4e` @218792200 is identical
 *   minus the two new guards):
 *     if(i.faintInk&&i.faintInk===i.color&&!i.bold&&!i.dim
 *        &&!i.backgroundColor&&!i.inverse&&M.has(i.color))e=he.dim(e);
 *   applied AFTER bold/dim and BEFORE the foreground/background colorization.
 * - Whitish detector class `f` (singleton `M`) @219913150:
 *     let n=jue(" ",r,"foreground");
 *     e=he.level>0&&(n===he.white(" ")||n===he.black(" "))
 *   memoized per color, invalidated on chalk level generation (`vOe()` =
 *   `p.levelGeneration` @217575255 region). A color is "whitish" when its
 *   rendered form is indistinguishable from white or black — i.e. the themed
 *   color alone cannot express "dim" (dark ANSI theme: inactive 'ansi:white'
 *   vs text 'ansi:whiteBright' collapse on 16-color terminals).
 * - Text component `Dc` @231403881 threads `faintInk` into textStyles
 *   (`me=m&&{faintInk:m}`, spread after backgroundColor, before dim).
 *
 * Painter path: render-node-to-output → applyTextStyles (chalk), so frame
 * assertions pin chalk.level (same pattern as ansiBoldDim295.test.tsx).
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { renderToAnsiStringIsolated } from '../../components/CustomSelect/__tests__/renderIsolated280.js'
import { BaseText as Text } from '../../ink.js'
import { applyTextStyles } from '../colorize.js'
import type { TextStyles } from '../styles.js'

const SGR2 = '\x1b[2m'

function withChalkLevel(level: number, fn: () => string): string {
  const saved = chalk.level
  try {
    chalk.level = level as typeof chalk.level
    return fn()
  } finally {
    chalk.level = saved
  }
}

describe('CC 2.1.300 #47: applyTextStyles faintInk branch (official h6e @219912500)', () => {
  test('faintInk === whitish color applies chalk.dim (SGR 2) before colorizing', () => {
    // Arrange
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
    } as TextStyles

    // Act
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))

    // Assert — official order: he.dim(e) then jue(e,color,"foreground")
    const expected = withChalkLevel(3, () => chalk.white(chalk.dim('x')))
    expect(out).toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('works at 16-color level (level 1) — the changelog terminal class', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
    } as TextStyles
    const out = withChalkLevel(1, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(1, () => chalk.white(chalk.dim('x')))
    expect(out).toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('ansi:black is whitish too (official compares against white OR black)', () => {
    const styles: TextStyles = {
      color: 'ansi:black',
      faintInk: 'ansi:black',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.black(chalk.dim('x')))
    expect(out).toBe(expected)
  })

  test('bold suppresses faintInk dimming', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      bold: true,
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.white(chalk.bold('x')))
    expect(out).not.toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('dim suppresses the faintInk branch (no double dim)', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      dim: true,
    } as TextStyles
    const dimOnly: TextStyles = {
      color: 'ansi:white',
      dim: true,
    }
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => applyTextStyles('x', dimOnly))
    expect(out).toBe(expected)
    // Exactly one dim open code
    expect(out.split(SGR2).length - 1).toBe(1)
  })

  test('backgroundColor suppresses faintInk dimming (new v300 guard)', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'ansi:red',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.bgRed(chalk.white('x')))
    expect(out).not.toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('inverse suppresses faintInk dimming (new v300 guard)', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      inverse: true,
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    expect(out).not.toContain(SGR2)
  })

  test('non-whitish color suppresses faintInk dimming', () => {
    for (const color of ['ansi:red', 'ansi:whiteBright', 'ansi:blackBright'] as const) {
      const styles: TextStyles = { color, faintInk: color } as TextStyles
      const out = withChalkLevel(3, () => applyTextStyles('x', styles))
      expect(out).not.toContain(SGR2)
    }
  })

  test('faintInk !== color suppresses faintInk dimming', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:red',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.white('x'))
    expect(out).not.toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('faintInk without color does nothing', () => {
    const styles: TextStyles = { faintInk: 'ansi:white' } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    expect(out).toBe('x')
  })

  test('chalk level 0 (NO_COLOR) never dims — detector requires level > 0', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
    } as TextStyles
    const out = withChalkLevel(0, () => applyTextStyles('x', styles))
    expect(out).not.toContain(SGR2)
    expect(out).toBe('x')
  })

  test('whitish cache revalidates when chalk.level changes', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
    } as TextStyles
    // Prime the cache at level 3, then drop to level 0 — must NOT reuse the
    // cached "whitish" verdict (official invalidates on level generation).
    withChalkLevel(3, () => applyTextStyles('x', styles))
    const out = withChalkLevel(0, () => applyTextStyles('x', styles))
    expect(out).not.toContain(SGR2)
    const back = withChalkLevel(3, () => applyTextStyles('x', styles))
    expect(back).toContain(SGR2)
  })
})

describe('CC 2.1.301 #33: faintInk background clause widened to whitish backgrounds (official o5e @220863168)', () => {
  // v300 guard was `!backgroundColor` — ANY background suppressed the faint.
  // v301 relaxes it to `(!backgroundColor || B.has(backgroundColor))`: a
  // *whitish* (tracker-known, e.g. selection-highlight palette) background no
  // longer suppresses faint, while RGB/truecolor backgrounds (which the
  // tracker never reports as whitish — they render differently from
  // chalk.white/black) still suppress it.
  test('whitish background (ansi:white) now APPLIES faintInk dimming', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'ansi:white',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    // Official order: he.dim(e) → foreground colorize → background colorize
    const expected = withChalkLevel(3, () =>
      chalk.bgWhite(chalk.white(chalk.dim('x'))),
    )
    expect(out).toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('whitish background different from foreground (ansi:black bg) also applies faint', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'ansi:black',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () =>
      chalk.bgBlack(chalk.white(chalk.dim('x'))),
    )
    expect(out).toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('RGB background (non-tracked, e.g. search/selection highlight) still suppresses faint', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'rgb(58, 58, 58)',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () =>
      chalk.bgRgb(58, 58, 58)(chalk.white('x')),
    )
    expect(out).not.toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('hex background (non-tracked) still suppresses faint', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: '#333333',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    expect(out).not.toContain(SGR2)
  })

  test('non-whitish ANSI background still suppresses faint (v300 behavior retained)', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'ansi:red',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.bgRed(chalk.white('x')))
    expect(out).not.toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('no background — v301 clause degrades to the v300 truth (faint applied)', () => {
    const styles: TextStyles = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
    } as TextStyles
    const out = withChalkLevel(3, () => applyTextStyles('x', styles))
    const expected = withChalkLevel(3, () => chalk.white(chalk.dim('x')))
    expect(out).toContain(SGR2)
    expect(out).toBe(expected)
  })

  test('bold/dim/inverse guards still win over a whitish background', () => {
    const base = {
      color: 'ansi:white',
      faintInk: 'ansi:white',
      backgroundColor: 'ansi:white',
    }
    for (const override of [
      { bold: true },
      { dim: true },
      { inverse: true },
    ] as const) {
      const styles = { ...base, ...override } as TextStyles
      const out = withChalkLevel(3, () => applyTextStyles('x', styles))
      // Exactly the guard's own dim at most (dim:true case), never the
      // faintInk branch's extra dim.
      expect(out.split(SGR2).length - 1).toBeLessThanOrEqual(1)
      if ('bold' in override || 'inverse' in override) {
        expect(out).not.toContain(SGR2)
      }
    }
  })
})

describe('CC 2.1.300 #47: Text component threads faintInk (official Dc @231403881)', () => {
  test('Text with faintInk === color renders SGR 2 in the frame', async () => {
    const saved = chalk.level
    try {
      chalk.level = 3
      const frame = await renderToAnsiStringIsolated(
        <Text color={'ansi:white'} faintInk={'ansi:white'}>
          faint-span
        </Text>,
        40,
      )
      const idx = frame.indexOf('faint-span')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(frame.slice(0, idx)).toContain(SGR2)
    } finally {
      chalk.level = saved
    }
  })

  test('Text without faintInk renders no SGR 2', async () => {
    const saved = chalk.level
    try {
      chalk.level = 3
      const frame = await renderToAnsiStringIsolated(
        <Text color={'ansi:white'}>plain-span</Text>,
        40,
      )
      const idx = frame.indexOf('plain-span')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(frame.slice(0, idx)).not.toContain(SGR2)
    } finally {
      chalk.level = saved
    }
  })
})
