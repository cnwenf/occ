import { describe, expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from '../defaultBindings.js'
import { chordToDisplayString, chordToString, parseBindings, parseChord } from '../parser.js'
import { getBindingDisplayText } from '../resolver.js'
import type { KeybindingBlock } from '../types.js'

/**
 * Gap-110g + Gap-110h (2.1.251, OCC-110): shortcut display parity with the
 * official 2.1.251 REPL help overlay (live-captured):
 *   - `ctrl + shift + _ to undo` — the undo action has FOUR aliases in
 *     official order: ctrl+_, ctrl+-, ctrl+shift+-, ctrl+shift+_
 *     (byte-verified in the binary; display resolution picks the LAST).
 *   - `alt + p to switch model` — the registered binding is `meta+p`; the
 *     official getDisplayText path (`Sue` → `QHe` → per-platform display
 *     formatter) collapses alt/meta to "alt", whereas the canonical
 *     string keeps "meta".
 *   - canonical formatter byte-parity: space key renders lowercase "space",
 *     modifier order ctrl/alt/shift/meta/cmd (super → "cmd").
 */

function chatBindings(): Record<string, string> {
  const chat = DEFAULT_BINDINGS.find(b => b.context === 'Chat')
  if (!chat) throw new Error('Chat binding block missing')
  return chat.bindings
}

describe('2.1.251 undo alias set (Gap-110g)', () => {
  test('all four official undo aliases are registered', () => {
    const bindings = chatBindings()
    expect(bindings['ctrl+_']).toBe('chat:undo')
    expect(bindings['ctrl+-']).toBe('chat:undo')
    expect(bindings['ctrl+shift+-']).toBe('chat:undo')
    expect(bindings['ctrl+shift+_']).toBe('chat:undo')
  })

  test('alias order matches the official binary (display winner = last)', () => {
    const chat = DEFAULT_BINDINGS.find(b => b.context === 'Chat')!
    const undoKeys = Object.entries(chat.bindings)
      .filter(([, action]) => action === 'chat:undo')
      .map(([key]) => key)
    expect(undoKeys).toEqual([
      'ctrl+_',
      'ctrl+-',
      'ctrl+shift+-',
      'ctrl+shift+_',
    ])
  })

  test('display resolution picks the last alias: ctrl+shift+_', () => {
    const parsed = parseBindings(DEFAULT_BINDINGS as KeybindingBlock[])
    expect(getBindingDisplayText('chat:undo', 'Chat', parsed)).toBe(
      'ctrl+shift+_',
    )
  })
})

describe('2.1.251 shortcut display formatting (Gap-110h)', () => {
  test('meta+p displays as alt+p (alt/meta collapse, per-platform formatter)', () => {
    expect(chordToDisplayString(parseChord('meta+p'))).toBe('alt+p')
  })

  test('shift+tab displays with shift before the key', () => {
    expect(chordToDisplayString(parseChord('shift+tab'))).toBe('shift+tab')
  })

  test('ctrl+shift+_ renders ctrl, shift, then the key', () => {
    expect(chordToDisplayString(parseChord('ctrl+shift+_'))).toBe(
      'ctrl+shift+_',
    )
  })

  test('model picker display text resolves to alt+p from default bindings', () => {
    const parsed = parseBindings(DEFAULT_BINDINGS as KeybindingBlock[])
    expect(getBindingDisplayText('chat:modelPicker', 'Chat', parsed)).toBe(
      'alt+p',
    )
  })

  test('canonical string keeps the official modifier order ctrl/alt/shift/meta/cmd', () => {
    // ctrl+alt+shift+meta+super canonicalization path
    expect(chordToString(parseChord('ctrl+shift+alt+p'))).toBe(
      'ctrl+alt+shift+p',
    )
  })

  test('canonical space key name is lowercase "space" (byte-verified)', () => {
    expect(chordToString(parseChord('space'))).toBe('space')
  })
})
