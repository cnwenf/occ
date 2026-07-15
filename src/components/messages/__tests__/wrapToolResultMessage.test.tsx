import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { wrapToolResultMessage } from '../wrapToolResultMessage'

/**
 * claude-code 2.1.210 #8: Fixed session crash when tool result renderer
 * returned bigint/plain text instead of UI element.
 *
 * The guard wraps bare primitives (string/number/bigint) in <Text> so Ink
 * can reconcile them safely, instead of crashing the session.
 */
describe('2.1.210 #8 wrapToolResultMessage guard', () => {
  const tool = { name: 'FakeTool' }

  test('passes through a valid React element unchanged', () => {
    const element = React.createElement('span', null, 'hello')
    const result = wrapToolResultMessage(element, tool)
    expect(result).toBe(element)
  })

  test('passes through null unchanged', () => {
    const result = wrapToolResultMessage(null, tool)
    expect(result).toBeNull()
  })

  test('passes through undefined unchanged', () => {
    const result = wrapToolResultMessage(undefined, tool)
    expect(result).toBeUndefined()
  })

  test('wraps a string in a Text element', () => {
    const result = wrapToolResultMessage('plain text', tool)
    expect(React.isValidElement(result)).toBe(true)
  })

  test('wraps a number in a Text element', () => {
    const result = wrapToolResultMessage(42, tool)
    expect(React.isValidElement(result)).toBe(true)
  })

  test('wraps a bigint in a Text element (the crash fix)', () => {
    // bigint previously crashed Ink's reconciler — the guard wraps it.
    const result = wrapToolResultMessage(123n, tool)
    expect(React.isValidElement(result)).toBe(true)
  })

  test('does not throw for any bare primitive type', () => {
    expect(() => wrapToolResultMessage('str', tool)).not.toThrow()
    expect(() => wrapToolResultMessage(0, tool)).not.toThrow()
    expect(() => wrapToolResultMessage(0n, tool)).not.toThrow()
    expect(() => wrapToolResultMessage(-1n, tool)).not.toThrow()
    expect(() => wrapToolResultMessage(Number.MAX_SAFE_INTEGER, tool)).not.toThrow()
  })
})
