import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStringIsolated } from './renderIsolated280.js'
import { SelectMulti } from '../SelectMulti.js'

// CC 2.1.280 (#025): "Fixed multi-select option descriptions being indented
// under the option number instead of under the label."
//
// Official v280 @205601363 restructured the compact multi-select row: the
// number and the checkbox each live in their own flexShrink:0 box, followed by
// a flexDirection:"column" box holding the label (color:"suggestion" when
// focused) and — when present — the description (color:"inactive"):
//   `[!M&&e(s,{flexShrink:0,children:e(n,{dimColor:!0,children:...padEnd(Pe)})}),
//     e(s,{flexShrink:0,children:r(n,{color:le?"success":void 0,children:["[",...]})}),
//     r(s,{flexDirection:"column",children:[e(n,{color:he?"suggestion":void 0,
//       children:b.label}),b.description&&e(n,{color:"inactive",children:b.description})]})]`
// and the row wrapper no longer receives a description prop. v278 @206609472
// passed `description:v.description` into the wrapper, which rendered it at
// paddingLeft:2 — under the number, not under the label.
//
// These tests render the real SelectMulti through renderToString (the same
// full-frame Ink path MarkdownTable.e2e uses, with a fake-TTY stdin so the) and assert on the emitted text
// useInput-mounted components exit cleanly; asserts on the emitted text
// geometry: the description must start at the label's column.

const noop = () => {}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

describe('2.1.280 #025 SelectMulti row: description under label, not under number', () => {
  test('description renders on its own line aligned to the label column', async () => {
    // Arrange
    const out = await renderToStringIsolated(
      <SelectMulti
        options={[
          { label: 'Alpha', value: 'alpha', description: 'first letter' },
          { label: 'Beta', value: 'beta' },
        ]}
        onCancel={noop}
      />,
      80,
    )

    // Act
    const lines = out.split('\n').filter(line => line.trimEnd().length > 0)
    const labelLine = lines.find(line => line.includes('Alpha'))
    const descLine = lines.find(line => line.includes('first letter'))

    // Assert — label line keeps number + checkbox + label on one row
    expect(labelLine).toBeDefined()
    expect(labelLine).toMatch(/1\.\s*\[.\]\s*Alpha/)

    // The description exists and sits on the line right below the label row
    expect(descLine).toBeDefined()
    expect(lines.indexOf(descLine!)).toBe(lines.indexOf(labelLine!) + 1)

    // #025 core: description starts at the label's column (under the label)…
    const labelCol = labelLine!.indexOf('Alpha')
    expect(indentOf(descLine!)).toBe(labelCol)
    // …not at the v278 ListItem paddingLeft:2 position under the number.
    expect(indentOf(descLine!)).toBeGreaterThan(2)
  })

  test('option without description renders exactly one row (no empty description line)', async () => {
    // Arrange
    const out = await renderToStringIsolated(
      <SelectMulti
        options={[
          { label: 'Alpha', value: 'alpha', description: 'first letter' },
          { label: 'Beta', value: 'beta' },
        ]}
        onCancel={noop}
      />,
      80,
    )

    // Act
    const lines = out.split('\n').filter(line => line.trimEnd().length > 0)

    // Assert — 3 content lines total: Alpha row, description row, Beta row
    expect(lines.length).toBe(3)
    expect(lines[2]).toContain('Beta')
    expect(lines[2]).toMatch(/2\.\s*\[.\]\s*Beta/)
  })

  test('hideIndexes still hides the number but keeps description under the label', async () => {
    // Arrange — the v280 restructure keeps the !hideIndexes gate on the
    // flexShrink:0 number box only; checkbox + label column are unchanged.
    const out = await renderToStringIsolated(
      <SelectMulti
        options={[{ label: 'Alpha', value: 'alpha', description: 'first letter' }]}
        hideIndexes={true}
        onCancel={noop}
      />,
      80,
    )

    // Act
    const lines = out.split('\n').filter(line => line.trimEnd().length > 0)
    const labelLine = lines.find(line => line.includes('Alpha'))
    const descLine = lines.find(line => line.includes('first letter'))

    // Assert — no "1." index on the label row, description still aligned under label
    expect(labelLine).toBeDefined()
    expect(labelLine).not.toContain('1.')
    expect(descLine).toBeDefined()
    expect(indentOf(descLine!)).toBe(labelLine!.indexOf('Alpha'))
  })
})
