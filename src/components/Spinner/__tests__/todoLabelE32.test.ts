import { describe, expect, test } from 'bun:test'

import { truncateToWidthNoEllipsis } from '../../../utils/truncate.js'
import {
  collapseWhitespace,
  computeSpinnerVerbWidth,
  computeTodoLabel,
} from '../utils.js'

/**
 * CC 2.1.268 E32: the spinner verb label stays within one terminal row.
 * Official 2.1.268 spinner (byte-verified from the binary):
 *
 *   ft=mt?[mt.activeForm,mt.subject]
 *         .map((W)=>W?.replace(/\s+/g," ").trim()).find(Boolean):void 0,
 *   jt=(g??(ft===void 0?void 0:xA(ft,Math.max(40,ot-8)))??(k||wt))+"…"
 *
 * `xA` is the grapheme-aware width truncator — OCC's
 * `truncateToWidthNoEllipsis` is shape-identical (stringWidth short-circuit,
 * `maxWidth<=0 → ''`, grapheme segmenter loop).
 */

describe('2.1.268 E32 collapseWhitespace (official .replace(/\\s+/g," ").trim())', () => {
  test('collapses runs of whitespace to single spaces and trims', () => {
    expect(collapseWhitespace('  Refactor\tthe   login  flow\n')).toBe(
      'Refactor the login flow',
    )
  })

  test('plain text is unchanged', () => {
    expect(collapseWhitespace('Running tests')).toBe('Running tests')
  })

  test('whitespace-only → empty string', () => {
    expect(collapseWhitespace(' \t\n ')).toBe('')
  })
})

describe('2.1.268 E32 computeTodoLabel (official ft)', () => {
  test('prefers activeForm, falls back to subject (official .find(Boolean))', () => {
    expect(
      computeTodoLabel({ activeForm: 'Running tests', subject: 'Run tests' }),
    ).toBe('Running tests')
    expect(computeTodoLabel({ subject: 'Run tests' })).toBe('Run tests')
  })

  test('whitespace-only activeForm collapses to empty → falls back to subject', () => {
    expect(computeTodoLabel({ activeForm: '  \t ', subject: 'Run tests' })).toBe(
      'Run tests',
    )
  })

  test('multi-line subject collapses onto one row', () => {
    expect(
      computeTodoLabel({ subject: 'Fix the\n  flaky   spinner test' }),
    ).toBe('Fix the flaky spinner test')
  })

  test('both fields empty → undefined (verb falls back to random verb)', () => {
    expect(computeTodoLabel({ activeForm: ' ', subject: '' })).toBeUndefined()
  })
})

describe('2.1.268 E32 computeSpinnerVerbWidth (official Math.max(40,ot-8))', () => {
  test('wide terminals reserve 8 columns', () => {
    expect(computeSpinnerVerbWidth(120)).toBe(112)
    expect(computeSpinnerVerbWidth(48)).toBe(40)
  })

  test('narrow terminals floor at 40', () => {
    expect(computeSpinnerVerbWidth(47)).toBe(40)
    expect(computeSpinnerVerbWidth(20)).toBe(40)
    expect(computeSpinnerVerbWidth(0)).toBe(40)
  })
})

describe('2.1.268 E32 label truncation (official xA(ft,Math.max(40,ot-8)))', () => {
  test('long label truncated to the width budget without ellipsis', () => {
    const label = 'x'.repeat(200)
    const truncated = truncateToWidthNoEllipsis(
      label,
      computeSpinnerVerbWidth(80),
    )
    expect(truncated).toBe('x'.repeat(72))
  })

  test('short label passes through unchanged', () => {
    const label = 'Running tests'
    expect(
      truncateToWidthNoEllipsis(label, computeSpinnerVerbWidth(80)),
    ).toBe(label)
  })

  test('collapsed label + truncation keeps one row end-to-end', () => {
    const todo = {
      subject: `Refactor  the\t${'very long '.repeat(30)}module`,
    }
    const label = computeTodoLabel(todo)!
    expect(label).not.toContain('\t')
    const width = computeSpinnerVerbWidth(100)
    const truncated = truncateToWidthNoEllipsis(label, width)
    expect(truncated.length).toBeLessThanOrEqual(width)
    expect(label.startsWith(truncated)).toBe(true)
  })
})
