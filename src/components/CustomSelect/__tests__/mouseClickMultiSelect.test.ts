import { describe, expect, test } from 'bun:test'
import {
  getMultiSelectClickAction,
  toggleValueInSelection,
} from '../selection-utils.js'
import { isMouseClicksDisabled } from '../../../utils/fullscreen.js'

// CC 2.1.208#4: mouse-click support for multi-select menus + "Other" rows in
// fullscreen. These UTs verify the three pure building blocks of the
// click→select dispatch path (OCC has no Ink component-test harness, so we
// test the extracted pure helpers + the kill-switch gate instead of rendering):
//
// 1. toggleValueInSelection — the immutable add/remove algorithm that
//    useMultiSelectState.toggleValue delegates to (the actual click handler).
// 2. getMultiSelectClickAction — the dispatch-decision tree mirroring the
//    official binary's inline factory: disabled→none, input→focus, else→toggle.
// 3. isMouseClicksDisabled — the CLAUDE_CODE_DISABLE_MOUSE_CLICKS kill-switch
//    that gates ALL mouse-click dispatch in handleMouseEvent (App.tsx line 518).

describe('2.1.208#4 toggleValueInSelection (mouse-click toggle algorithm)', () => {
  test('adds value when absent (click selects an unselected item)', () => {
    expect(toggleValueInSelection(['a'], 'b')).toEqual(['a', 'b'])
  })

  test('removes value when present (click deselects a selected item)', () => {
    expect(toggleValueInSelection(['a', 'b'], 'a')).toEqual(['b'])
  })

  test('toggling the only selected value yields empty list', () => {
    expect(toggleValueInSelection(['a'], 'a')).toEqual([])
  })

  test('toggling on empty list adds the value', () => {
    expect(toggleValueInSelection([], 'x')).toEqual(['x'])
  })

  test('does not mutate the input array (immutability)', () => {
    const original = ['a', 'b']
    const result = toggleValueInSelection(original, 'b')
    expect(original).toEqual(['a', 'b']) // unchanged
    expect(result).not.toBe(original) // new reference
  })

  test('preserves sibling selections when removing', () => {
    expect(toggleValueInSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  test('preserves sibling selections when adding', () => {
    expect(toggleValueInSelection(['a', 'c'], 'b')).toEqual(['a', 'c', 'b'])
  })

  test('toggling a value not in list does not duplicate existing entries', () => {
    expect(toggleValueInSelection(['a', 'a'], 'b')).toEqual(['a', 'a', 'b'])
  })
})

describe('2.1.208#4 getMultiSelectClickAction (dispatch decision)', () => {
  test('normal option → toggle (click selects/deselects)', () => {
    expect(getMultiSelectClickAction({ type: 'text' }, false)).toBe('toggle')
  })

  test('option with no type field → toggle (default text-like option)', () => {
    expect(getMultiSelectClickAction({}, false)).toBe('toggle')
  })

  test('input option ("Other") → focus (click focuses the input, no toggle)', () => {
    expect(getMultiSelectClickAction({ type: 'input' }, false)).toBe('focus')
  })

  test('disabled option → none (no click handler)', () => {
    expect(getMultiSelectClickAction({ disabled: true }, false)).toBe('none')
  })

  test('disabled input option → none (disabled takes precedence over input)', () => {
    expect(getMultiSelectClickAction({ type: 'input', disabled: true }, false)).toBe('none')
  })

  test('globally disabled menu → none for every option type', () => {
    expect(getMultiSelectClickAction({ type: 'text' }, true)).toBe('none')
    expect(getMultiSelectClickAction({ type: 'input' }, true)).toBe('none')
    expect(getMultiSelectClickAction({}, true)).toBe('none')
  })

  test('disabled:false explicitly → still toggles (only disabled===true blocks)', () => {
    expect(getMultiSelectClickAction({ disabled: false }, false)).toBe('toggle')
  })
})

describe('2.1.208#4 isMouseClicksDisabled (kill-switch gate)', () => {
  const original = process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS

  // Restore after each test so we don't leak env into sibling tests
  // (see memory: bun mock.module leaks process-wide — same caution for env).
  test('unset env → clicks enabled (default: full mouse mode)', () => {
    delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
    expect(isMouseClicksDisabled()).toBe(false)
  })

  test('env=1 → clicks disabled (scroll-only mouse mode)', () => {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
    expect(isMouseClicksDisabled()).toBe(true)
  })

  test('env=true → clicks disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = 'true'
    expect(isMouseClicksDisabled()).toBe(true)
  })

  test('env=0 → clicks enabled (explicitly falsy)', () => {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '0'
    expect(isMouseClicksDisabled()).toBe(false)
  })

  test('env=false → clicks enabled', () => {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = 'false'
    expect(isMouseClicksDisabled()).toBe(false)
  })

  test('env=empty → clicks enabled (empty string is falsy)', () => {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = ''
    expect(isMouseClicksDisabled()).toBe(false)
  })

  // Restore original env
  if (original === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  } else {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = original
  }
})
