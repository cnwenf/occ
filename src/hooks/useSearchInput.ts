import { useCallback, useState } from 'react'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until consumers wire handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { useTerminalSize } from './useTerminalSize.js'

type UseSearchInputOptions = {
  isActive: boolean
  onExit: () => void
  /** Esc + Ctrl+C abandon (distinct from onExit = Enter commit). When
   *  provided: single-Esc calls this directly (no clear-first-then-exit
   *  two-press). When absent: current behavior — Esc clears non-empty
   *  query, exits on empty; Ctrl+C silently swallowed (no switch case). */
  onCancel?: () => void
  onExitUp?: () => void
  columns?: number
  passthroughCtrlKeys?: string[]
  initialQuery?: string
  /** Backspace (and ctrl+h) on empty query calls onCancel ?? onExit — the
   *  less/vim "delete past the /" convention. Dialogs that want Esc-only
   *  cancel set this false so a held backspace doesn't eject the user. */
  backspaceExitsOnEmpty?: boolean
}

type UseSearchInputReturn = {
  query: string
  setQuery: (q: string) => void
  cursorOffset: number
  handleKeyDown: (e: KeyboardEvent) => void
}

// 2.1.261 search-box kill-key set (official binary `phA` region): Ctrl+K/U/W;
// Meta/Ctrl+Backspace; Alt+D (no flavor gate — always a kill now). Non-kill
// keys reset kill accumulation.
function isKillKey(e: KeyboardEvent): boolean {
  if (e.ctrl && (e.key === 'k' || e.key === 'u' || e.key === 'w')) {
    return true
  }
  if ((e.meta || e.ctrl) && e.key === 'backspace') {
    return true
  }
  if (e.meta && !e.ctrl && e.key.toLowerCase() === 'd') {
    return true
  }
  return false
}

function isYankKey(e: KeyboardEvent): boolean {
  return (e.ctrl || e.meta) && e.key === 'y'
}

// Special key names that fall through the explicit handlers above the
// text-input branch (return/escape/arrows/home/end/tab/backspace/delete
// all early-return). Reject these so e.g. PageUp doesn't leak 'pageup'
// as literal text. The length>=1 check below is intentionally loose —
// batched input like stdin.write('abc') arrives as one multi-char e.key,
// matching the old useInput(input) behavior where cursor.insert(input)
// inserted the full chunk.
const UNHANDLED_SPECIAL_KEYS = new Set([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

export function useSearchInput({
  isActive,
  onExit,
  onCancel,
  onExitUp,
  columns,
  passthroughCtrlKeys = [],
  initialQuery = '',
  backspaceExitsOnEmpty = true,
}: UseSearchInputOptions): UseSearchInputReturn {
  const { columns: terminalColumns } = useTerminalSize()
  const effectiveColumns = columns ?? terminalColumns
  const [query, setQueryState] = useState(initialQuery)
  const [cursorOffset, setCursorOffset] = useState(initialQuery.length)

  const setQuery = useCallback((q: string) => {
    setQueryState(q)
    setCursorOffset(q.length)
  }, [])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!isActive) return

    const cursor = Cursor.fromText(query, effectiveColumns, cursorOffset)

    // Reset kill accumulation for non-kill keys. 2.1.239 runs this dispatch
    // BEFORE the passthrough early-return (official binary order) so a
    // passthrough key still breaks kill accumulation.
    if (!isKillKey(e)) {
      resetKillAccumulation()
    }

    // Reset yank state for non-yank keys
    if (!isYankKey(e)) {
      resetYankState()
    }

    // Check passthrough ctrl keys
    if (e.ctrl && passthroughCtrlKeys.includes(e.key.toLowerCase())) {
      return
    }

    // Exit conditions
    if (e.key === 'return' || e.key === 'down') {
      e.preventDefault()
      onExit()
      return
    }
    if (e.key === 'up') {
      e.preventDefault()
      if (onExitUp) {
        onExitUp()
      }
      return
    }
    if (e.key === 'escape') {
      e.preventDefault()
      if (onCancel) {
        onCancel()
      } else if (query.length > 0) {
        setQueryState('')
        setCursorOffset(0)
      } else {
        onExit()
      }
      return
    }

    // Backspace/Delete
    if (e.key === 'backspace') {
      e.preventDefault()
      if (e.meta || e.ctrl) {
        // 2.1.261 (official binary): Meta/Ctrl+Backspace always kills back
        // over a readline word (backwardKillWord) and records the kill
        // prepend. The classic Segmenter-word variant was deleted upstream.
        const { cursor: newCursor, killed } = cursor.backwardKillWord()
        pushToKillRing(killed, 'prepend')
        setQueryState(newCursor.text)
        setCursorOffset(newCursor.offset)
        return
      }
      if (query.length === 0) {
        // Backspace past the / — cancel (clear + snap back), not commit.
        // less: same. vim: deletes the / and exits command mode.
        if (backspaceExitsOnEmpty) (onCancel ?? onExit)()
        return
      }
      const newCursor = cursor.backspace()
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
      return
    }

    if (e.key === 'delete') {
      e.preventDefault()
      const newCursor = cursor.del()
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
      return
    }

    // Arrow keys with modifiers (word jump). 2.1.261: always readline word
    // units (backwardWord/forwardWord).
    if (e.key === 'left' && (e.ctrl || e.meta || e.fn)) {
      e.preventDefault()
      const newCursor = cursor.backwardWord()
      setCursorOffset(newCursor.offset)
      return
    }
    if (e.key === 'right' && (e.ctrl || e.meta || e.fn)) {
      e.preventDefault()
      const newCursor = cursor.forwardWord()
      setCursorOffset(newCursor.offset)
      return
    }

    // Plain arrow keys
    if (e.key === 'left') {
      e.preventDefault()
      const newCursor = cursor.left()
      setCursorOffset(newCursor.offset)
      return
    }
    if (e.key === 'right') {
      e.preventDefault()
      const newCursor = cursor.right()
      setCursorOffset(newCursor.offset)
      return
    }

    // Home/End
    if (e.key === 'home') {
      e.preventDefault()
      setCursorOffset(0)
      return
    }
    if (e.key === 'end') {
      e.preventDefault()
      setCursorOffset(query.length)
      return
    }

    // Ctrl key bindings
    if (e.ctrl) {
      e.preventDefault()
      switch (e.key.toLowerCase()) {
        case 'a':
          setCursorOffset(0)
          return
        case 'e':
          setCursorOffset(query.length)
          return
        case 'b':
          setCursorOffset(cursor.left().offset)
          return
        case 'f':
          setCursorOffset(cursor.right().offset)
          return
        case 'd': {
          if (query.length === 0) {
            ;(onCancel ?? onExit)()
            return
          }
          const newCursor = cursor.del()
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'h': {
          if (query.length === 0) {
            if (backspaceExitsOnEmpty) (onCancel ?? onExit)()
            return
          }
          const newCursor = cursor.backspace()
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'k': {
          const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
          pushToKillRing(killed, 'append')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'u': {
          const { cursor: newCursor, killed } = cursor.deleteToLineStart()
          pushToKillRing(killed, 'prepend')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'w': {
          // 2.1.261: always readline Ctrl+W (deleteWORDBefore — kills back to
          // the previous whitespace). The classic variant was deleted.
          const { cursor: newCursor, killed } = cursor.deleteWORDBefore()
          pushToKillRing(killed, 'prepend')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'y': {
          const text = getLastKill()
          if (text.length > 0) {
            const startOffset = cursor.offset
            const newCursor = cursor.insert(text)
            recordYank(startOffset, text.length)
            setQueryState(newCursor.text)
            setCursorOffset(newCursor.offset)
          }
          return
        }
        case 'g':
        case 'c':
          // Cancel (abandon search). ctrl+g is less's cancel key. Only
          // fires if onCancel provided — otherwise falls through and
          // returns silently (11 call sites, most expect ctrl+c to no-op).
          if (onCancel) {
            onCancel()
            return
          }
      }
      return
    }

    // Meta key bindings
    if (e.meta) {
      e.preventDefault()
      switch (e.key.toLowerCase()) {
        case 'b':
          // 2.1.261: always readline word-back (backwardWord).
          setCursorOffset(cursor.backwardWord().offset)
          return
        case 'f':
          // 2.1.261: always readline word-forward (forwardWord).
          setCursorOffset(cursor.forwardWord().offset)
          return
        case 'd': {
          // 2.1.261: Alt+D always kills the word after the cursor (killWord)
          // and records it append for Ctrl+Y. The classic deleteWordAfter
          // variant was deleted upstream with the flavor setting.
          const { cursor: newCursor, killed } = cursor.killWord()
          pushToKillRing(killed, 'append')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'y': {
          const popResult = yankPop()
          if (popResult) {
            const { text, start, length } = popResult
            const before = query.slice(0, start)
            const after = query.slice(start + length)
            const newText = before + text + after
            const newOffset = start + text.length
            updateYankLength(text.length)
            setQueryState(newText)
            setCursorOffset(newOffset)
          }
          return
        }
      }
      return
    }

    // Tab: ignore
    if (e.key === 'tab') {
      return
    }

    // Regular character input. Accepts multi-char e.key so batched writes
    // (stdin.write('abc') in tests, or paste outside bracketed-paste mode)
    // insert the full chunk — matching the old useInput behavior.
    if (e.key.length >= 1 && !UNHANDLED_SPECIAL_KEYS.has(e.key)) {
      e.preventDefault()
      const newCursor = cursor.insert(e.key)
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
    }
  }

  // Backward-compat bridge: existing consumers don't yet wire handleKeyDown
  // to <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until all 11 call sites are migrated (separate PRs).
  // TODO(onKeyDown-migration): remove once all consumers pass handleKeyDown.
  useInput(
    (_input, _key, event) => {
      handleKeyDown(new KeyboardEvent(event.keypress))
    },
    { isActive },
  )

  return { query, setQuery, cursorOffset, handleKeyDown }
}
