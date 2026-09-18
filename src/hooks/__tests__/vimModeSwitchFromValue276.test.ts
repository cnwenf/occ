import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { shouldSwitchModeFromValue } from 'src/components/PromptInput/inputModes.js'
import { Cursor } from 'src/utils/Cursor.js'

/**
 * CC 2.1.276 (ITEM P): "Fixed vim mode placing the cursor one character right
 * after a dot-repeated `!` or a fast-typed `i!` switched a non-empty prompt
 * into shell mode."
 *
 * Official v276 inputModes module (@202985169) gained the VALUE-shaped
 * predicate `Twr`; v274's module only had the keystroke-shaped `aGe` char
 * test, so the vim engine could not tell that a value it just produced flips
 * the input mode. v276 vim closure (@206279682):
 *   `function Q(I,q){return z!==void 0&&Twr({nextValue:I,value:h,cursorOffset:q.offset,mode:z()})}`
 * and the dot-repeat insert branch (@206279846; v274 @205118989 was
 * `j.setOffset(J.offset)` — no compensation):
 *   `case"insert":if(I.text){let me=q.insert(I.text),Ce=Q(me.text,L);
 *     j.setText(me.text),j.setOffset(me.offset-(Ce?1:0))}break;`
 *
 * `h` is the PRE-INSERT value and `L.offset` the PRE-INSERT cursor offset
 * (`ve(I)` passes the textInput/operator context as the 4th arg). When the
 * replayed insert produces a leading `!`, the host consumes that character as
 * its mode indicator, so the uncompensated offset lands one column too far
 * right — the changelog bug.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

/** The vim hook's dot-repeat arithmetic, composed from the real primitives. */
function dotRepeatInsertOffset(
  value: string,
  offset: number,
  insertedText: string,
  mode: 'bash' | 'prompt',
): number {
  const cursor = Cursor.fromText(value, 80, offset)
  const newCursor = cursor.insert(insertedText)
  const modeSwitch = shouldSwitchModeFromValue({
    nextValue: newCursor.text,
    value,
    cursorOffset: offset,
    mode,
  })
  return newCursor.offset - (modeSwitch ? 1 : 0)
}

/**
 * Drives the REAL `replayLastChange` `case 'insert'` block extracted from
 * `src/hooks/useVimInput.ts` (the repo's e2e idiom for logic that lives inside
 * a React hook — see `test/e2e/version-2.1.211-repl-input-vim-substitute`).
 * The block is annotation-free JS, so it evaluates as-is against the real
 * `Cursor`, the real `shouldSwitchModeFromValue` and a stub textInput/props
 * pair. Returns the buffer text and cursor offset the hook would commit.
 */
function runRealDotRepeatInsertCase(args: {
  value: string
  offset: number
  insertedText: string
  mode: 'bash' | 'prompt'
}): { text: string; offset: number } {
  const source = readSource('src/hooks/useVimInput.ts')
  const marker = "case 'insert':"
  const start = source.indexOf(marker)
  if (start === -1) {
    throw new Error('dot-repeat `case \'insert\'` block not found in useVimInput.ts')
  }
  const end = source.indexOf('\n        break', start)
  if (end === -1) {
    throw new Error('dot-repeat `case \'insert\'` block is not terminated by `break`')
  }
  const block = source.slice(start + marker.length, end)

  const committed: { text: string; offset: number } = {
    text: args.value,
    offset: args.offset,
  }
  const cursor = Cursor.fromText(args.value, 80, args.offset)
  const textInput = {
    offset: args.offset,
    setOffset: (next: number) => {
      committed.offset = next
    },
  }
  const props = {
    value: args.value,
    onChange: (next: string) => {
      committed.text = next
    },
    getInputMode: () => args.mode,
  }
  // The hook's own closure, rebuilt over the REAL predicate (official `Q`).
  const shouldSwitchInputMode = (nextValue: string, cursorOffset: number) => {
    const { getInputMode } = props
    if (getInputMode === undefined) return false
    return shouldSwitchModeFromValue({
      nextValue,
      value: props.value,
      cursorOffset,
      mode: getInputMode(),
    })
  }

  const runBlock = new Function(
    'change',
    'cursor',
    'textInput',
    'props',
    'shouldSwitchInputMode',
    'MODE_PREFIX_LENGTH',
    block,
  )
  runBlock(
    { type: 'insert', text: args.insertedText },
    cursor,
    textInput,
    props,
    shouldSwitchInputMode,
    1,
  )
  return committed
}

describe('2.1.276 ITEM P — shouldSwitchModeFromValue predicate', () => {
  test('a single ! typed at offset 0 of a non-empty prompt switches to shell mode', () => {
    // Arrange / Act
    const result = shouldSwitchModeFromValue({
      nextValue: '!ls',
      value: 'ls',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('a ! at offset 0 of an EMPTY prompt switches (grew-by-one clause)', () => {
    // Arrange / Act
    const result = shouldSwitchModeFromValue({
      nextValue: '!',
      value: '',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('a multi-char value into an EMPTY prompt switches (value.length === 0 clause)', () => {
    // Arrange — tab-accepting a suggestion like `! gcloud auth login`.
    const result = shouldSwitchModeFromValue({
      nextValue: '!gcloud auth login',
      value: '',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('a multi-char value replacing a non-empty prompt does not switch', () => {
    // Arrange — the fast-typed shape where the buffer was REPLACED rather than
    // grown by one character (e.g. a replayed multi-char insert over `echo hi`).
    const result = shouldSwitchModeFromValue({
      nextValue: '!ls -la',
      value: 'echo hi',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert — official `t.length===r.length+1||r.length===0` is false here, so
    // the `!` stays literal content instead of flipping the prompt to shell mode.
    expect(result).toBe(false)
  })

  test('a leading ! prepended to a non-empty prompt still switches (grew by one)', () => {
    // Arrange / Act
    const result = shouldSwitchModeFromValue({
      nextValue: '!ls -la',
      value: 'ls -la',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('cursorOffset !== 0 never switches', () => {
    // Arrange / Act / Assert — official `if(n!==0||…)return!1`.
    expect(
      shouldSwitchModeFromValue({
        nextValue: '!ls',
        value: 'ls',
        cursorOffset: 1,
        mode: 'prompt',
      }),
    ).toBe(false)
  })

  test('a value that maps to prompt mode never switches', () => {
    // Arrange / Act / Assert — official `e==="prompt"` clause.
    expect(
      shouldSwitchModeFromValue({
        nextValue: 'ls',
        value: 's',
        cursorOffset: 0,
        mode: 'prompt',
      }),
    ).toBe(false)
  })

  test('already in shell mode, a leading ! is content (2.1.273 parity)', () => {
    // Arrange / Act — `! grep -v x` must stay typable in bash mode.
    const result = shouldSwitchModeFromValue({
      nextValue: '!grep -v x',
      value: 'grep -v x',
      cursorOffset: 0,
      mode: 'bash',
    })

    // Assert — official `e===o` clause.
    expect(result).toBe(false)
  })

  test('other non-prompt modes differ from bash, so ! still switches', () => {
    // Arrange / Act / Assert
    expect(
      shouldSwitchModeFromValue({
        nextValue: '!ls',
        value: 'ls',
        cursorOffset: 0,
        mode: 'orphaned-permission',
      }),
    ).toBe(true)
    expect(
      shouldSwitchModeFromValue({
        nextValue: '!ls',
        value: 'ls',
        cursorOffset: 0,
        mode: 'task-notification',
      }),
    ).toBe(true)
  })

  test('a same-length value change never switches', () => {
    // Arrange — a replace (not a growth) that happens to start with `!`.
    const result = shouldSwitchModeFromValue({
      nextValue: '!s',
      value: 'ls',
      cursorOffset: 0,
      mode: 'prompt',
    })

    // Assert — neither length clause holds: not +1 growth, not an empty value.
    expect(result).toBe(false)
  })
})

describe('2.1.276 ITEM P — dot-repeat cursor compensation', () => {
  test('dot-repeating ! at offset 0 of a non-empty prompt lands the cursor at 0, not 1', () => {
    // Arrange — NORMAL mode, buffer `ls`, cursor at the start, last change was
    // an insert of `!` (the host ate the character as its mode indicator).

    // Act
    const offset = dotRepeatInsertOffset('ls', 0, '!', 'prompt')

    // Assert — v274 returned newCursor.offset (1): one column right of the
    // shell-mode indicator, the changelog bug.
    expect(offset).toBe(0)
  })

  test('dot-repeating ! into an EMPTY prompt lands the cursor at 0', () => {
    // Arrange / Act
    const offset = dotRepeatInsertOffset('', 0, '!', 'prompt')

    // Assert
    expect(offset).toBe(0)
  })

  test('a plain replayed insert keeps the uncompensated offset', () => {
    // Arrange / Act — no mode flip, so `-(Ce?1:0)` is a no-op.
    const offset = dotRepeatInsertOffset('ls', 0, 'x', 'prompt')

    // Assert
    expect(offset).toBe(1)
  })

  test('replaying ! while already in shell mode keeps the uncompensated offset', () => {
    // Arrange / Act — the `!` is content here (`! grep -v x`), so the host does
    // not consume a character and no compensation may be applied.
    const offset = dotRepeatInsertOffset('grep -v x', 0, '!', 'bash')

    // Assert
    expect(offset).toBe(1)
  })

  test('replaying ! away from offset 0 keeps the uncompensated offset', () => {
    // Arrange / Act
    const offset = dotRepeatInsertOffset('ls', 1, '!', 'prompt')

    // Assert — inserted at offset 1 → `l!s`, cursor 2, no switch, no -1.
    expect(offset).toBe(2)
  })

  test('a multi-char replayed insert into a non-empty prompt is not compensated', () => {
    // Arrange / Act — official `Re` uses the same predicate: a multi-char
    // value over a non-empty buffer never flips the mode.
    const offset = dotRepeatInsertOffset('echo hi', 0, '!ls -la', 'prompt')

    // Assert
    expect(offset).toBe('!ls -la'.length)
  })

  test('the REAL hook block commits offset 0 (not 1) for a dot-repeated !', () => {
    // Arrange / Act — evaluates the extracted `case 'insert'` block from
    // src/hooks/useVimInput.ts against the real Cursor + predicate.
    const committed = runRealDotRepeatInsertCase({
      value: 'ls',
      offset: 0,
      insertedText: '!',
      mode: 'prompt',
    })

    // Assert — the buffer the host receives still carries the `!` (PromptInput
    // strips it and flips to shell mode); the cursor must be compensated.
    expect(committed.text).toBe('!ls')
    expect(committed.offset).toBe(0)
  })

  test('the REAL hook block leaves a plain replayed insert uncompensated', () => {
    // Arrange / Act
    const committed = runRealDotRepeatInsertCase({
      value: 'ls',
      offset: 0,
      insertedText: 'x',
      mode: 'prompt',
    })

    // Assert
    expect(committed.text).toBe('xls')
    expect(committed.offset).toBe(1)
  })

  test('the REAL hook block does not compensate a ! replayed in shell mode', () => {
    // Arrange / Act — already in bash mode the `!` is content (`! grep -v x`).
    const committed = runRealDotRepeatInsertCase({
      value: 'grep -v x',
      offset: 0,
      insertedText: '!',
      mode: 'bash',
    })

    // Assert
    expect(committed.text).toBe('!grep -v x')
    expect(committed.offset).toBe(1)
  })
})

describe('2.1.276 ITEM P — getInputMode reaches the vim engine', () => {
  test('VimTextInput threads getInputMode into the vim hook props', () => {
    // Arrange — React Compiler output enumerates props explicitly, so a new
    // prop must appear in the memo dep-check, the assignment block AND the
    // props object; a future recompile can silently drop it again.
    const source = readSource('src/components/VimTextInput.tsx')

    // Act / Assert
    expect(source).toContain('getInputMode: props.getInputMode')
    expect(source).toContain('$[40] !== props.getInputMode')
    expect(source).toContain('$[40] = props.getInputMode;')
  })

  test('the vim hook consumes getInputMode through the value-shaped predicate', () => {
    // Arrange
    const source = readSource('src/hooks/useVimInput.ts')

    // Act / Assert — official `Q(I,q){return z!==void 0&&Twr({…})}`: no getter,
    // no switch (hosts without input modes keep the v274 offsets).
    expect(source).toContain('shouldSwitchModeFromValue')
    expect(source).toContain('if (getInputMode === undefined) return false')
    expect(source).toContain('newCursor.offset - (modeSwitch ? MODE_PREFIX_LENGTH : 0)')
  })

  test('PromptInput supplies the mode getter the vim engine needs', () => {
    // Arrange
    const source = readSource('src/components/PromptInput/PromptInput.tsx')

    // Act / Assert
    expect(source).toContain('getInputMode: () => mode')
  })
})
