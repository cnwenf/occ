import React, { useCallback, useState } from 'react'
import type { Key } from '../ink.js'
import type { VimInputState, VimMode } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeVisualCase,
  executeVisualIndent,
  executeVisualJoin,
  executeVisualOperator,
  executeVisualPaste,
  executeVisualReplace,
  executeX,
  replayVisualCase,
  replayVisualChange,
  replayVisualOp,
  replayVisualReplace,
  type OperatorContext,
} from '../vim/operators.js'
import {
  type TransitionContext,
  transition,
  transitionVisual,
  type VisualTransitionResult,
} from '../vim/transitions.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimState,
  type VisualKind,
  VISUAL_KINDS,
  isVisualKindKey,
} from '../vim/types.js'
import { type UseTextInputProps, useTextInput } from './useTextInput.js'

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  /**
   * Opens reverse history search. Called when '/' is pressed in vim NORMAL
   * idle mode (2.1.152+). Binary: `P.key==="/"&&a`.
   */
  onHistorySearch?: () => void
  inputFilter?: UseTextInputProps['inputFilter']
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const [mode, setMode] = useState<VimMode>('INSERT')

  const persistentRef = React.useRef<PersistentState>(
    createInitialPersistentState(),
  )

  // inputFilter is applied once at the top of handleVimInput (not here) so
  // vim-handled paths that return without calling textInput.onInput still
  // run the filter — otherwise a stateful filter (e.g. lazy-space-after-
  // pill) stays armed across an Escape → NORMAL → INSERT round-trip.
  const textInput = useTextInput({ ...props, inputFilter: undefined })
  const { onModeChange, inputFilter, onHistorySearch } = props

  const switchToInsertMode = useCallback(
    (offset?: number): void => {
      if (offset !== undefined) {
        textInput.setOffset(offset)
      }
      vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      setMode('INSERT')
      onModeChange?.('INSERT')
    },
    [textInput, onModeChange],
  )

  const switchToNormalMode = useCallback((): void => {
    const current = vimStateRef.current
    if (current.mode === 'INSERT') {
      const last = persistentRef.current.lastChange
      // 2.1.118: When exiting INSERT after a visual change (vc/Vc), capture
      // the typed text into a visualChange record for dot-repeat.
      // Binary: `if($?.type==="visualOp"&&$.op==="change")...visualChange`
      if (last?.type === 'visualOp' && last.op === 'change') {
        persistentRef.current.lastChange = {
          type: 'visualChange',
          span: last.span,
          linewise: last.linewise,
          text: current.insertedText ?? '',
        }
      } else if (current.insertedText) {
        persistentRef.current.lastChange = {
          type: 'insert',
          text: current.insertedText,
        }
      }
    }

    // Vim behavior: move cursor left by 1 when exiting insert mode
    // (unless at beginning of line or at offset 0)
    const offset = textInput.offset
    if (offset > 0 && props.value[offset - 1] !== '\n') {
      textInput.setOffset(offset - 1)
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange, textInput, props.value])

  /**
   * Enter VISUAL mode (2.1.118). Binary: `H(offset, kind)` sets
   * `{mode:"VISUAL",kind,anchor:offset,command:{type:"idle"}}` and
   * displays "VISUAL" (char) or "VISUAL LINE" (line).
   */
  const enterVisual = useCallback(
    (offset: number, kind: VisualKind): void => {
      vimStateRef.current = {
        mode: 'VISUAL',
        kind,
        anchor: offset,
        command: { type: 'idle' },
      }
      const displayMode = kind === 'line' ? 'VISUAL LINE' : 'VISUAL'
      setMode(displayMode)
      onModeChange?.(displayMode)
    },
    [onModeChange],
  )

  /**
   * Exit VISUAL mode back to NORMAL. Binary: `S()`.
   */
  const exitVisual = useCallback((): void => {
    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange])

  function createOperatorContext(
    cursor: Cursor,
    isReplay: boolean = false,
  ): OperatorContext {
    return {
      cursor,
      text: props.value,
      setText: (newText: string) => props.onChange(newText),
      setOffset: (offset: number) => textInput.setOffset(offset),
      enterInsert: (offset: number) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content: string, linewise: boolean) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: isReplay
        ? () => {}
        : (change: RecordedChange) => {
            persistentRef.current.lastChange = change
          },
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) return

    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)
    const ctx = createOperatorContext(cursor, true)

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text)
          props.onChange(newCursor.text)
          textInput.setOffset(newCursor.offset)
        }
        break

      case 'x':
        executeX(change.count, ctx)
        break

      case 'replace':
        executeReplace(change.char, change.count, ctx)
        break

      case 'toggleCase':
        executeToggleCase(change.count, ctx)
        break

      case 'indent':
        executeIndent(change.dir, change.count, ctx)
        break

      case 'join':
        executeJoin(change.count, ctx)
        break

      case 'openLine':
        executeOpenLine(change.direction, ctx)
        break

      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx)
        break

      case 'operatorFind':
        executeOperatorFind(
          change.op,
          change.find,
          change.char,
          change.count,
          ctx,
        )
        break

      case 'operatorTextObj':
        executeOperatorTextObj(
          change.op,
          change.scope,
          change.objType,
          change.count,
          ctx,
        )
        break

      case 'visualOp':
        replayVisualOp(change.op, change.span, change.linewise, ctx)
        break

      case 'visualChange':
        replayVisualChange(
          change.span,
          change.linewise,
          change.text,
          ctx,
        )
        break

      case 'visualReplace':
        replayVisualReplace(change.char, change.span, change.linewise, ctx)
        break

      case 'visualCase':
        replayVisualCase(change.op, change.span, change.linewise, ctx)
        break
    }
  }

  function handleVimInput(rawInput: string, key: Key): void {
    const state = vimStateRef.current
    // Run inputFilter in all modes so stateful filters disarm on any key,
    // but only apply the transformed input in INSERT — NORMAL-mode command
    // lookups expect single chars and a prepended space would break them.
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const input = state.mode === 'INSERT' ? filtered : rawInput
    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)

    if (key.ctrl) {
      // Binary: ctrl/meta in VISUAL does not pass through to the base handler.
      if (state.mode !== 'VISUAL') {
        textInput.onInput(input, key)
      }
      return
    }

    // NOTE(keybindings): This escape handler is intentionally NOT migrated to the keybindings system.
    // It's vim's standard INSERT->NORMAL mode switch - a vim-specific behavior that should not be
    // configurable via keybindings. Vim users expect Esc to always exit INSERT mode.
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode()
      return
    }

    // Escape in NORMAL mode cancels any pending command (replace, operator, etc.)
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      return
    }

    // 2.1.118: Escape in VISUAL cancels a pending command, or exits to NORMAL.
    // Binary: `if(P.name==="escape"&&L.mode==="VISUAL"){if(L.command.type!=="idle")...;else S()}`
    if (key.escape && state.mode === 'VISUAL') {
      if (state.command.type !== 'idle') {
        vimStateRef.current = { ...state, command: { type: 'idle' } }
      } else {
        exitVisual()
      }
      return
    }

    // Pass Enter to base handler (not in VISUAL — binary: `return&&mode!=="VISUAL"`)
    if (key.return && state.mode !== 'VISUAL') {
      textInput.onInput(input, key)
      return
    }

    if (state.mode === 'INSERT') {
      // Track inserted text for dot-repeat
      if (key.backspace || key.delete) {
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          }
        }
      } else {
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + input,
        }
      }
      textInput.onInput(input, key)
      return
    }

    // 2.1.118: VISUAL mode (v / V) — handle visual selection and operators.
    // Binary: `if(L.mode==="VISUAL"){...MKl(L.command,K,V)...}`
    if (state.mode === 'VISUAL') {
      const ctx: TransitionContext = {
        ...createOperatorContext(cursor, false),
        onUndo: props.onUndo,
        onDotRepeat: replayLastChange,
        onHistorySearch,
      }

      // Map arrow keys to motions (only in idle/count states)
      const expectsMotion =
        state.command.type === 'idle' ||
        state.command.type === 'count'
      let vimInput = input
      if (key.leftArrow) vimInput = expectsMotion ? 'h' : ''
      else if (key.rightArrow) vimInput = expectsMotion ? 'l' : ''
      else if (key.upArrow) vimInput = expectsMotion ? 'k' : ''
      else if (key.downArrow) vimInput = expectsMotion ? 'j' : ''

      const result = transitionVisual(state.command, vimInput, ctx)
      const linewise = state.kind === 'line'

      if ('next' in result) {
        result.move?.()
        if (vimStateRef.current.mode === 'VISUAL') {
          vimStateRef.current = {
            mode: 'VISUAL',
            kind: state.kind,
            anchor: state.anchor,
            command: result.next,
          }
        }
      } else if (result.exit === 'operator') {
        const forceLinewise = result.forceLinewise === true
        executeVisualOperator(
          result.op,
          state.anchor,
          ctx,
          linewise || forceLinewise,
        )
        // Only exit if the operator didn't switch to INSERT (e.g. change)
        if (vimStateRef.current.mode === 'VISUAL') exitVisual()
      } else if (result.exit === 'replace') {
        executeVisualReplace(result.char, state.anchor, ctx, linewise)
        exitVisual()
      } else if (result.exit === 'case') {
        executeVisualCase(result.op, state.anchor, ctx, linewise)
        exitVisual()
      } else if (result.exit === 'paste') {
        if (ctx.getRegister()) {
          executeVisualPaste(state.anchor, ctx, linewise)
          exitVisual()
        } else {
          vimStateRef.current = { ...state, command: { type: 'idle' } }
        }
      } else if (result.exit === 'join') {
        executeVisualJoin(state.anchor, ctx)
        exitVisual()
      } else if (result.exit === 'indent') {
        executeVisualIndent(result.dir, state.anchor, ctx)
        exitVisual()
      } else if (result.exit === 'swap') {
        // Swap anchor and cursor positions
        const curOffset = cursor.offset
        textInput.setOffset(state.anchor)
        vimStateRef.current = {
          mode: 'VISUAL',
          kind: state.kind,
          anchor: curOffset,
          command: { type: 'idle' },
        }
      } else if (result.exit === 'selectRange') {
        // Binary: `ee=X.end>X.start?prevOffset(X.end):X.start`
        const targetOffset =
          result.end > result.start
            ? cursor.measuredText.prevOffset(result.end)
            : result.start
        textInput.setOffset(targetOffset)
        vimStateRef.current = {
          mode: 'VISUAL',
          kind: state.kind,
          anchor: result.start,
          command: { type: 'idle' },
        }
      } else if (result.exit === 'toggleKind') {
        const newKind = result.key === 'V' ? 'line' : 'char'
        if (newKind === state.kind) {
          exitVisual()
        } else {
          enterVisual(state.anchor, newKind)
        }
      }
      return
    }

    if (state.mode !== 'NORMAL') {
      return
    }

    // In idle state, delegate arrow keys to base handler for cursor movement
    // and history fallback (upOrHistoryUp / downOrHistoryDown)
    if (
      state.command.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      textInput.onInput(input, key)
      return
    }

    const ctx: TransitionContext = {
      ...createOperatorContext(cursor, false),
      onUndo: props.onUndo,
      onDotRepeat: replayLastChange,
      onHistorySearch,
    }

    // Backspace/Delete are only mapped in motion-expecting states. In
    // literal-char states (replace, find, operatorFind), mapping would turn
    // r+Backspace into "replace with h" and df+Delete into "delete to next x".
    // Delete additionally skips count state: in vim, N<Del> removes a count
    // digit rather than executing Nx; we don't implement digit removal but
    // should at least not turn a cancel into a destructive Nx.
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount'

    // Map arrow keys to vim motions in NORMAL mode
    let vimInput = input
    if (key.leftArrow) vimInput = 'h'
    else if (key.rightArrow) vimInput = 'l'
    else if (key.upArrow) vimInput = 'k'
    else if (key.downArrow) vimInput = 'j'
    else if (expectsMotion && key.backspace) vimInput = 'h'
    else if (expectsMotion && state.command.type !== 'count' && key.delete)
      vimInput = 'x'

    // 2.1.118: Enter visual mode — v (char-wise) or V (line-wise).
    // Binary: `if((W==="v"||W==="V")&&(command.type==="idle"||"count")){H(offset,kind);return}`
    if (
      isVisualKindKey(vimInput) &&
      (state.command.type === 'idle' || state.command.type === 'count')
    ) {
      enterVisual(textInput.offset, VISUAL_KINDS[vimInput])
      return
    }

    const result = transition(state.command, vimInput, ctx)

    if (result.execute) {
      result.execute()
    }

    // Update command state (only if execute didn't switch to INSERT)
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
    }

    if (
      input === '?' &&
      state.mode === 'NORMAL' &&
      state.command.type === 'idle'
    ) {
      props.onChange('?')
    }
  }

  const setModeExternal = useCallback(
    (newMode: VimMode) => {
      if (newMode === 'INSERT') {
        vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      } else if (newMode === 'VISUAL' || newMode === 'VISUAL LINE') {
        vimStateRef.current = {
          mode: 'VISUAL',
          kind: newMode === 'VISUAL LINE' ? 'line' : 'char',
          anchor: textInput.offset,
          command: { type: 'idle' },
        }
      } else {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
      setMode(newMode)
      onModeChange?.(newMode)
    },
    [onModeChange, textInput],
  )

  return {
    ...textInput,
    onInput: handleVimInput,
    mode,
    setMode: setModeExternal,
  }
}
