import chalk from 'chalk'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { renderToAnsiStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import { Text } from '../../../ink.js'
import { Tab, Tabs, resolveTabCursorStyle } from '../Tabs.js'

/**
 * v2.1.281 PORT #094 — NO_COLOR tab highlight (official `Ple` resolver).
 *
 * Byte-level forensics on the official linux-x64 ELFs:
 *
 * - v281 @209319791: `function Ple(o="tint"){return ue.level===0?"inverse":o}`
 *   (v280 has ZERO hits for `.level===0?"inverse"` — new in v281).
 * - v281 Tabs consumption site (@216535588 region):
 *   `Ae=ue.level===0, P=c&&d&&h&&!Ae` — the color cursor (backgroundColor
 *   highlight) requires color level != 0; at level 0 the current tab falls
 *   through to the inverse highlight branch.
 * - v280 counterpart (@213409179 region): `Y=c&&d&&h` — no level gate, so
 *   under NO_COLOR the selected-tab highlight was invisible (backgroundColor
 *   stripped by chalk while inverse was suppressed).
 * - Renderer parity: the official applies inverse via a raw SGR-7 emitter
 *   (v281 `F4` / v280 `Bde`: `"\x1B[7m"+text+"\x1B[27m"`), NOT chalk —
 *   chalk.inverse is a no-op at level 0. OCC's colorize.ts now mirrors this.
 *
 * resolveTabCursorStyle() is OCC's mirror of `Ple` for the Tabs cursor.
 */

const SGR7_OPEN = '\x1B[7m'

function renderTabs(): React.ReactElement {
  return (
    <Tabs color="permission" title="Test:">
      <Tab title="One">
        <Text>content-a</Text>
      </Tab>
      <Tab title="Two">
        <Text>content-b</Text>
      </Tab>
    </Tabs>
  )
}

describe('v2.1.281 #094: resolveTabCursorStyle mirrors official Ple (@209319791)', () => {
  test('resolves to "inverse" at color level 0 (NO_COLOR)', () => {
    // Arrange / Act
    const style = resolveTabCursorStyle(0)

    // Assert — official: ue.level===0 ? "inverse" : o
    expect(style).toBe('inverse')
  })

  test('resolves to "color" at every color-capable level (1, 2, 3)', () => {
    for (const level of [1, 2, 3]) {
      expect(resolveTabCursorStyle(level)).toBe('color')
    }
  })

  test('default argument tracks the live chalk.level', () => {
    // Arrange
    const savedLevel = chalk.level
    try {
      // Act / Assert — level 0
      chalk.level = 0
      expect(resolveTabCursorStyle()).toBe('inverse')

      // Act / Assert — level restored to color-capable
      chalk.level = 2
      expect(resolveTabCursorStyle()).toBe('color')
    } finally {
      chalk.level = savedLevel
    }
  })
})

describe('v2.1.281 #094: Tabs selected-tab highlight under NO_COLOR (level 0)', () => {
  test('current tab gets the inverse (SGR-7) highlight and no background color at level 0', async () => {
    // Arrange
    const savedLevel = chalk.level
    chalk.level = 0
    try {
      // Act
      const ansi = await renderToAnsiStringIsolated(renderTabs())

      // Assert — official v281 `P=c&&d&&h&&!Ae` is false at level 0, so the
      // current tab falls through to the inverse branch (raw SGR-7 survives
      // chalk level 0 per the official F4 emitter parity in colorize.ts).
      expect(ansi).toContain(SGR7_OPEN)
      expect(ansi).toContain('\x1B[27m')
      // The inverse highlight wraps exactly the current tab (" One ").
      expect(ansi).toContain(`${SGR7_OPEN} One \x1B[27m`)
      // No background-color cursor may be emitted (chalk strips it at level 0
      // anyway, but the component must not even request it).
      expect(ansi).not.toContain('\x1B[48')
      // Sanity: both tab labels still render.
      const plain = stripAnsi(ansi)
      expect(plain).toContain('One')
      expect(plain).toContain('Two')
    } finally {
      chalk.level = savedLevel
    }
  })

  test('current tab keeps the background-color cursor (no inverse) at color level 2', async () => {
    // Arrange
    const savedLevel = chalk.level
    chalk.level = 2
    try {
      // Act
      const ansi = await renderToAnsiStringIsolated(renderTabs())

      // Assert — color-capable terminal keeps the pre-v281 background cursor.
      expect(ansi).toContain('\x1B[48;')
      expect(ansi).not.toContain(SGR7_OPEN)
      const plain = stripAnsi(ansi)
      expect(plain).toContain('One')
      expect(plain).toContain('Two')
    } finally {
      chalk.level = savedLevel
    }
  })
})
