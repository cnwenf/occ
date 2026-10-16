import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import type { OperatorContext } from '../operators.js'
import { transition } from '../transitions.js'
import type { CommandState, RecordedChange } from '../types.js'
import type { VimMode } from '../../types/textInputTypes.js'

// CC 2.1.301 (occ160 WP-D) — vim "Esc cancels only from NORMAL" fix
// (changelog: "Fixed Esc discarding a typed AskUserQuestion answer in vim
// mode: the free-text field now supports vim NORMAL mode, and Esc cancels
// only from NORMAL").
//
// The AskUserQuestion free-text option renders a VimTextInput when vim mode
// is on and reports an editing state `{mode, takesEscape}` to the host via
// `onEditingStateChange`. `takesEscape` is true while the vim input should own
// the Escape key — any non-INSERT mode with a pending NORMAL command, OR any
// non-NORMAL mode. When `takesEscape` is true the select:cancel guard leaves
// Escape to vim (exit mode / cancel the pending command) instead of
// discarding the typed answer.
//
// The ported derivation (useVimInput.ts + VimTextInput.tsx, byte-verifiable
// against the official v301 hook `H({mode:c,takesEscape:E})` where
// `E = c !== "NORMAL" || b` and `b` is the pending-command report
// `zt = mode !== INSERT && command.type !== idle`):
//   isCommandPending = mode !== 'INSERT' && command.type !== 'idle'
//   takesEscape      = mode !== 'NORMAL' || isCommandPending
//
// These tests drive the REAL `transition` machine (src/vim/transitions.ts) to
// obtain genuine CommandState values, then assert the exact predicates that
// gate Escape ownership.

/**
 * The pending-command report threaded from useVimInput into VimTextInput.
 * Mirrors `zt` / `isCommandPending` (mode !== 'INSERT' && command.type !== 'idle').
 */
function isCommandPending(mode: VimMode, command: CommandState): boolean {
  return mode !== 'INSERT' && command.type !== 'idle'
}

/**
 * The takesEscape flag reported to the AskUserQuestion host via
 * onEditingStateChange. Mirrors VimTextInput's `mode !== "NORMAL" || isCommandPending`.
 */
function takesEscape(mode: VimMode, command: CommandState): boolean {
  return mode !== 'NORMAL' || isCommandPending(mode, command)
}

/** Minimal OperatorContext for driving `transition` (cursor + setOffset only). */
function createMockCtx(text: string, offset = 0) {
  const state = { text, offset }
  const recordedChanges: RecordedChange[] = []
  let cursorCache: { text: string; offset: number; cursor: Cursor } | null =
    null
  const ctx: OperatorContext = {
    get cursor() {
      if (
        !cursorCache ||
        cursorCache.text !== state.text ||
        cursorCache.offset !== state.offset
      ) {
        cursorCache = {
          text: state.text,
          offset: state.offset,
          cursor: Cursor.fromText(state.text, 80, state.offset),
        }
      }
      return cursorCache.cursor
    },
    get text() {
      return state.text
    },
    setText: (t: string) => {
      state.text = t
    },
    setOffset: (o: number) => {
      state.offset = o
    },
    enterInsert: () => {},
    getRegister: () => '',
    setRegister: () => {},
    getLastFind: () => null,
    setLastFind: () => {},
    recordChange: (change: RecordedChange) => {
      recordedChanges.push(change)
    },
  }
  return ctx
}

const IDLE: CommandState = { type: 'idle' }

describe('CC 2.1.301 vim Esc ownership — NORMAL idle releases Escape', () => {
  test('NORMAL + idle command does not take Escape (select may cancel)', () => {
    // From NORMAL idle, Escape belongs to the host select:cancel — the vim
    // input has no pending command and is already in NORMAL.
    expect(isCommandPending('NORMAL', IDLE)).toBe(false)
    expect(takesEscape('NORMAL', IDLE)).toBe(false)
  })
})

describe('CC 2.1.301 vim Esc ownership — pending NORMAL command claims Escape', () => {
  test("typing 'd' from idle goes operator-pending → isCommandPending true", () => {
    const ctx = createMockCtx('hello world', 0)
    const result = transition(IDLE, 'd', ctx)
    // Real transition output: an operator-pending CommandState (non-idle).
    expect(result.next).toBeDefined()
    expect(result.next?.type).toBe('operator')

    const pending = result.next!
    expect(isCommandPending('NORMAL', pending)).toBe(true)
    // Escape now belongs to vim (cancel the pending operator), NOT the select.
    expect(takesEscape('NORMAL', pending)).toBe(true)
  })

  test("typing 'c' from idle goes operator-pending → takes Escape", () => {
    const ctx = createMockCtx('hello world', 0)
    const result = transition(IDLE, 'c', ctx)
    expect(result.next?.type).toBe('operator')
    expect(takesEscape('NORMAL', result.next!)).toBe(true)
  })

  test('count-pending (e.g. "3") is non-idle → takes Escape', () => {
    const ctx = createMockCtx('hello world', 0)
    const result = transition(IDLE, '3', ctx)
    expect(result.next).toBeDefined()
    expect(result.next?.type).not.toBe('idle')
    expect(isCommandPending('NORMAL', result.next!)).toBe(true)
    expect(takesEscape('NORMAL', result.next!)).toBe(true)
  })

  test('Escape from operator-pending resets to idle → releases Escape', () => {
    // useVimInput.ts: NORMAL + escape → `{ mode: 'NORMAL', command: {type:'idle'} }`
    // (@426-427). After the reset, Escape ownership returns to the host.
    const ctx = createMockCtx('hello world', 0)
    const pending = transition(IDLE, 'd', ctx).next!
    expect(takesEscape('NORMAL', pending)).toBe(true)

    // Escape cancels the pending command (mirrors the hook's reset).
    const afterEscape: CommandState = { type: 'idle' }
    expect(isCommandPending('NORMAL', afterEscape)).toBe(false)
    expect(takesEscape('NORMAL', afterEscape)).toBe(false)
  })
})

describe('CC 2.1.301 vim Esc ownership — non-NORMAL modes always take Escape', () => {
  test('INSERT mode takes Escape regardless of command', () => {
    // In INSERT, Escape exits to NORMAL — the vim input owns it. Note that
    // isCommandPending is false in INSERT (mode === 'INSERT'), but takesEscape
    // is still true because mode !== 'NORMAL'.
    expect(isCommandPending('INSERT', IDLE)).toBe(false)
    expect(takesEscape('INSERT', IDLE)).toBe(true)
  })

  test('VISUAL mode takes Escape regardless of command', () => {
    expect(isCommandPending('VISUAL', IDLE)).toBe(false)
    expect(takesEscape('VISUAL', IDLE)).toBe(true)
  })

  test('VISUAL LINE mode takes Escape', () => {
    expect(takesEscape('VISUAL LINE', IDLE)).toBe(true)
  })
})

describe('CC 2.1.301 select:cancel guard predicate', () => {
  // The guard in use-select-input.ts short-circuits select:cancel when the
  // focused option is an input whose vimEditing.takesEscape is true. This
  // mirrors the guard condition so the decision table is pinned.
  function shouldCancelSelect(
    focusedIsInput: boolean,
    vimTakesEscape: boolean | undefined,
  ): boolean {
    // `if (focusedOption?.type === 'input' && focusedOption.vimEditing?.takesEscape) return`
    if (focusedIsInput && vimTakesEscape) return false
    return true
  }

  test('input option owning Escape blocks cancel', () => {
    expect(shouldCancelSelect(true, true)).toBe(false)
  })

  test('input option in NORMAL idle allows cancel', () => {
    expect(shouldCancelSelect(true, false)).toBe(true)
  })

  test('non-input option always allows cancel', () => {
    expect(shouldCancelSelect(false, true)).toBe(true)
    expect(shouldCancelSelect(false, false)).toBe(true)
    expect(shouldCancelSelect(false, undefined)).toBe(true)
  })
})
