/**
 * Vim Mode State Machine Types
 *
 * This file defines the complete state machine for vim input handling.
 * The types ARE the documentation - reading them tells you how the system works.
 *
 * State Diagram:
 * ```
 *                              VimState
 *   ┌──────────────────────────────┬──────────────────────────────────────┐
 *   │  INSERT                      │  NORMAL                              │
 *   │  (tracks insertedText)       │  (CommandState machine)              │
 *   │                              │                                      │
 *   │                              │  idle ──┬─[d/c/y]──► operator        │
 *   │                              │         ├─[1-9]────► count           │
 *   │                              │         ├─[fFtT]───► find            │
 *   │                              │         ├─[g]──────► g               │
 *   │                              │         ├─[r]──────► replace         │
 *   │                              │         └─[><]─────► indent          │
 *   │                              │                                      │
 *   │                              │  operator ─┬─[motion]──► execute     │
 *   │                              │            ├─[0-9]────► operatorCount│
 *   │                              │            ├─[ia]─────► operatorTextObj
 *   │                              │            └─[fFtT]───► operatorFind │
 *   └──────────────────────────────┴──────────────────────────────────────┘
 * ```
 */

// ============================================================================
// Core Types
// ============================================================================

export type Operator = 'delete' | 'change' | 'yank'

export type FindType = 'f' | 'F' | 't' | 'T'

export type TextObjScope = 'inner' | 'around'

/**
 * Visual mode kind: char-wise (v) or line-wise (V).
 * Matches the official binary's `kind: "char" | "line"`.
 */
export type VisualKind = 'char' | 'line'

/**
 * Case operation type for visual ~ / u / U.
 */
export type CaseOp = 'toggle' | 'lower' | 'upper'

// ============================================================================
// State Machine Types
// ============================================================================

/**
 * Complete vim state. Mode determines what data is tracked.
 *
 * INSERT mode: Track text being typed (for dot-repeat)
 * NORMAL mode: Track command being parsed (state machine)
 */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }
  | {
      mode: 'VISUAL'
      kind: VisualKind
      /** Fixed end of the selection (does not move with the cursor). */
      anchor: number
      command: CommandState
    }

/**
 * Command state machine for NORMAL mode.
 *
 * Each state knows exactly what input it's waiting for.
 * TypeScript ensures exhaustive handling in switches.
 */
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjScope
    }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'textObject'; scope: TextObjScope; count: number }

/**
 * Persistent state that survives across commands.
 * This is the "memory" of vim - what gets recalled for repeats and pastes.
 */
export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

/**
 * Recorded change for dot-repeat.
 * Captures everything needed to replay a command.
 */
export type RecordedChange =
  | { type: 'insert'; text: string }
  | {
      type: 'operator'
      op: Operator
      motion: string
      count: number
    }
  | {
      type: 'operatorTextObj'
      op: Operator
      objType: string
      scope: TextObjScope
      count: number
    }
  | {
      type: 'operatorFind'
      op: Operator
      find: FindType
      char: string
      count: number
    }
  | { type: 'replace'; char: string; count: number }
  | { type: 'substitute'; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }
  | {
      type: 'visualOp'
      op: Operator
      /** grapheme count (char-wise) or line count (line-wise) — for dot-repeat */
      span: number
      linewise: boolean
    }
  | {
      type: 'visualChange'
      span: number
      linewise: boolean
      text: string
    }
  | {
      type: 'visualReplace'
      char: string
      span: number
      linewise: boolean
    }
  | {
      type: 'visualCase'
      op: CaseOp
      span: number
      linewise: boolean
    }
  // CC 2.1.216 #6 (b): paste was never recorded for dot-repeat. The `paste`
  // variant captures the count, direction (after), and linewise flag so `.`
  // can re-apply the paste.
  | {
      type: 'paste'
      after: boolean
      count: number
      linewise: boolean
    }
  // CC 2.1.216 #6 (b): `c`-operator's inserted text was not captured for
  // dot-repeat. When exiting INSERT after a `c`-operator, the lastChange is
  // upgraded to `operatorChange` carrying the motion + typed text so `.`
  // re-deletes the range and re-inserts the text.
  | {
      type: 'operatorChange'
      op: Operator
      motion: string
      count: number
      text: string
    }

// ============================================================================
// Key Groups - Named constants, no magic strings
// ============================================================================

export const OPERATORS = {
  d: 'delete',
  c: 'change',
  y: 'yank',
} as const satisfies Record<string, Operator>

export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return key in OPERATORS
}

/**
 * Maps the visual-mode entry key to its kind.
 * v → char-wise, V → line-wise (matches the binary's `U==="V"?"line":"char"`).
 */
export const VISUAL_KINDS = {
  v: 'char',
  V: 'line',
} as const satisfies Record<string, VisualKind>

export function isVisualKindKey(
  key: string,
): key is keyof typeof VISUAL_KINDS {
  return key in VISUAL_KINDS
}

export const SIMPLE_MOTIONS = new Set([
  'h',
  'l',
  'j',
  'k', // Basic movement
  'w',
  'b',
  'e',
  'W',
  'B',
  'E', // Word motions
  '0',
  '^',
  '$', // Line positions
])

export const FIND_KEYS = new Set(['f', 'F', 't', 'T'])

export const TEXT_OBJ_SCOPES = {
  i: 'inner',
  a: 'around',
} as const satisfies Record<string, TextObjScope>

export function isTextObjScopeKey(
  key: string,
): key is keyof typeof TEXT_OBJ_SCOPES {
  return key in TEXT_OBJ_SCOPES
}

export const TEXT_OBJ_TYPES = new Set([
  'w',
  'W', // Word/WORD
  '"',
  "'",
  '`', // Quotes
  '(',
  ')',
  'b', // Parens
  '[',
  ']', // Brackets
  '{',
  '}',
  'B', // Braces
  '<',
  '>', // Angle brackets
])

export const MAX_VIM_COUNT = 10000

// ============================================================================
// State Factories
// ============================================================================

export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}
