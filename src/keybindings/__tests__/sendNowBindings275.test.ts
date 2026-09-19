import { describe, expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from '../defaultBindings.js'
import { parseBindings, parseChord } from '../parser.js'
import { getBindingDisplayText } from '../resolver.js'
import { KEYBINDING_ACTIONS } from '../schema.js'

/**
 * CC 2.1.275 (ITEM O): send-now key bindings.
 *
 * Byte-verified against the official 2.1.276 binary:
 *   - Chat binding block @195276038:
 *       enter:"chat:submit","ctrl+x enter":"chat:queueSubmit",
 *       "ctrl+x ctrl+s":"chat:sendNow","ctrl+enter":"chat:sendNow",
 *       "ctrl+j":"chat:newline"
 *   - Action allowlist Lme @195284784:
 *       ..."chat:submit","chat:queueSubmit","chat:sendNow","chat:newline"...
 *
 * Order invariants that matter at runtime:
 *   - display resolution picks the LAST binding for an action (findLast), so
 *     ctrl+enter must be registered after ctrl+x ctrl+s;
 *   - enter must precede the queueSubmit/sendNow chords in the Chat block
 *     (official table order).
 */

function chatBindings(): Record<string, string> {
  const chat = DEFAULT_BINDINGS.find(b => b.context === 'Chat')
  if (!chat) throw new Error('Chat binding block missing')
  return chat.bindings
}

describe('2.1.275 send-now schema allowlist (ITEM O)', () => {
  test('chat:queueSubmit and chat:sendNow are allowed actions', () => {
    expect(KEYBINDING_ACTIONS).toContain('chat:queueSubmit')
    expect(KEYBINDING_ACTIONS).toContain('chat:sendNow')
  })

  test('allowlist order matches official Lme: submit, queueSubmit, sendNow, newline', () => {
    const idx = (a: string) => KEYBINDING_ACTIONS.indexOf(a as never)
    expect(idx('chat:submit')).toBeLessThan(idx('chat:queueSubmit'))
    expect(idx('chat:queueSubmit')).toBeLessThan(idx('chat:sendNow'))
    expect(idx('chat:sendNow')).toBeLessThan(idx('chat:newline'))
  })
})

describe('2.1.275 send-now default bindings (ITEM O)', () => {
  test('all three official chords are registered in the Chat context', () => {
    const bindings = chatBindings()
    expect(bindings['ctrl+x enter']).toBe('chat:queueSubmit')
    expect(bindings['ctrl+x ctrl+s']).toBe('chat:sendNow')
    expect(bindings['ctrl+enter']).toBe('chat:sendNow')
  })

  test('official key order: enter(submit) → ctrl+x enter(queueSubmit) → ctrl+x ctrl+s(sendNow) → ctrl+enter(sendNow)', () => {
    const keys = Object.keys(chatBindings())
    const order = ['enter', 'ctrl+x enter', 'ctrl+x ctrl+s', 'ctrl+enter'].map(
      k => keys.indexOf(k),
    )
    for (const i of order) {
      expect(i).toBeGreaterThanOrEqual(0)
    }
    // Strictly increasing → insertion order matches the official table.
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
    expect(order[2]).toBeLessThan(order[3])
  })

  test('sendNow chords appear in official order (ctrl+x ctrl+s before ctrl+enter)', () => {
    const parsed = parseBindings(DEFAULT_BINDINGS)
    const sendNowKeys = parsed
      .filter(b => b.action === 'chat:sendNow' && b.context === 'Chat')
      .map(b => b.chord.map(ks => (ks.ctrl ? 'ctrl+' : '') + ks.key).join(' '))
    expect(sendNowKeys).toEqual(['ctrl+x ctrl+s', 'ctrl+enter'])
  })

  test('display resolution picks ctrl+enter (LAST sendNow binding)', () => {
    const parsed = parseBindings(DEFAULT_BINDINGS)
    expect(getBindingDisplayText('chat:sendNow', 'Chat', parsed)).toBe(
      'ctrl+Enter',
    )
  })

  test('queueSubmit display text is ctrl+x enter', () => {
    const parsed = parseBindings(DEFAULT_BINDINGS)
    expect(getBindingDisplayText('chat:queueSubmit', 'Chat', parsed)).toBe(
      'ctrl+x Enter',
    )
  })
})

describe('chord parsing for the send-now key set', () => {
  test('ctrl+enter parses to a single ctrl-modified enter keystroke', () => {
    const chord = parseChord('ctrl+enter')
    expect(chord).toHaveLength(1)
    expect(chord[0].key).toBe('enter')
    expect(chord[0].ctrl).toBe(true)
  })

  test('ctrl+x enter parses to two keystrokes (prefix x, then enter)', () => {
    const chord = parseChord('ctrl+x enter')
    expect(chord).toHaveLength(2)
    expect(chord[0].key).toBe('x')
    expect(chord[0].ctrl).toBe(true)
    expect(chord[1].key).toBe('enter')
  })

  test('ctrl+x ctrl+s parses to two ctrl-modified keystrokes', () => {
    const chord = parseChord('ctrl+x ctrl+s')
    expect(chord).toHaveLength(2)
    expect(chord[0].key).toBe('x')
    expect(chord[0].ctrl).toBe(true)
    expect(chord[1].key).toBe('s')
    expect(chord[1].ctrl).toBe(true)
  })
})
