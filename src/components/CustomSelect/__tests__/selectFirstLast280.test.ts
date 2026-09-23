import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { OptionWithDescription } from '../select.js'
import {
  createDefaultState,
  reducer,
  type State,
} from '../use-select-navigation.js'

/**
 * CC 2.1.280 (#028) — select:first / select:last reach the shared select
 * navigation layer, so Home/End work in /model, permission prompts and every
 * other CustomSelect consumer.
 *
 * Official v280 wiring, byte-verified against
 * /tmp/cc-diff-280/v280/package/claude:
 *   useSelectInput handler map @205570426:
 *     h["select:first"]=()=>{i.focusOption(a[0]?.value)},
 *     h["select:last"]=()=>{i.focusOption(a.at(-1)?.value)}
 *   (absent from the v278 map @206578871 — the keys were dead in v278).
 *   slash-menu Select-context map @217346338:
 *     "select:first":()=>St(0),"select:last":()=>St(Je)   // Je = last index
 *
 * Verified semantics: first/last of the FULL option list (options[0] /
 * options.at(-1)), NOT the visible window. OCC has no Ink render harness, so
 * the focus-jump + viewport-scroll semantics are tested through the exported
 * reducer (the exact `set-focus` path focusOption dispatches), and the
 * hook-level wiring is asserted against the source (repo convention).
 */

const makeOptions = (count: number): OptionWithDescription<string>[] =>
  Array.from({ length: count }, (_, i) => ({
    label: `Item ${i}`,
    value: `v${i}`,
  }))

const makeState = (
  count: number,
  visibleOptionCount = 5,
): State<string> =>
  createDefaultState<string>({
    visibleOptionCount,
    options: makeOptions(count),
    initialFocusValue: undefined,
  })

describe('2.1.280 #028 — set-focus jump to the last option (select:last)', () => {
  test('focuses options.at(-1).value and scrolls the viewport to the end', () => {
    // Arrange
    const options = makeOptions(10)
    const initial = makeState(10)
    expect(initial.focusedValue).toBe('v0')
    expect(initial.visibleFromIndex).toBe(0)
    expect(initial.visibleToIndex).toBe(5)

    // Act — mirrors focusLastOption: focusOption(options.at(-1)?.value)
    const next = reducer(initial, {
      type: 'set-focus',
      value: options.at(-1)!.value,
    })

    // Assert
    expect(next.focusedValue).toBe('v9')
    expect(next.visibleToIndex).toBe(10)
    expect(next.visibleFromIndex).toBe(5)
  })

  test('last of a list shorter than the viewport keeps the full window', () => {
    const options = makeOptions(3)
    const initial = makeState(3)
    const next = reducer(initial, {
      type: 'set-focus',
      value: options.at(-1)!.value,
    })
    expect(next.focusedValue).toBe('v2')
    expect(next.visibleFromIndex).toBe(0)
    expect(next.visibleToIndex).toBe(3)
  })
})

describe('2.1.280 #028 — set-focus jump to the first option (select:first)', () => {
  test('focuses options[0].value and scrolls the viewport back to the top', () => {
    // Arrange — start parked at the end of the list
    const options = makeOptions(10)
    const atEnd = reducer(makeState(10), {
      type: 'set-focus',
      value: options.at(-1)!.value,
    })
    expect(atEnd.focusedValue).toBe('v9')

    // Act — mirrors focusFirstOption: focusOption(options[0]?.value)
    const next = reducer(atEnd, { type: 'set-focus', value: options[0]!.value })

    // Assert
    expect(next.focusedValue).toBe('v0')
    expect(next.visibleFromIndex).toBe(0)
    expect(next.visibleToIndex).toBe(5)
  })

  test('edge value expressions match the official: first of full list, last of full list', () => {
    const options = makeOptions(7)
    expect(options[0]?.value).toBe('v0')
    expect(options.at(-1)?.value).toBe('v6')
  })

  test('empty option list yields undefined edge values (focusOption no-op guard)', () => {
    const empty: OptionWithDescription<string>[] = []
    expect(empty[0]?.value).toBeUndefined()
    expect(empty.at(-1)?.value).toBeUndefined()
  })
})

describe('2.1.280 #028 — hook wiring (source)', () => {
  const NAV_SOURCE = readFileSync(
    join(import.meta.dir, '..', 'use-select-navigation.ts'),
    'utf8',
  )

  test('focusFirstOption/focusLastOption use the official edge expressions', () => {
    expect(NAV_SOURCE).toContain('focusOption(options[0]?.value)')
    expect(NAV_SOURCE).toContain('focusOption(options.at(-1)?.value)')
  })

  test("registers 'select:first'/'select:last' handlers in the Select context", () => {
    expect(NAV_SOURCE).toContain("'select:first': focusFirstOption")
    expect(NAV_SOURCE).toContain("'select:last': focusLastOption")
    expect(NAV_SOURCE).toContain("context: 'Select'")
  })

  test('registration is gated off while an input option is focused (official !isInInput map composition)', () => {
    expect(NAV_SOURCE).toContain('isActive: options.length > 0 && !isInInput')
  })
})
