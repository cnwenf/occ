import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import {
  applyHeldClearedDraft,
  heldClearedDraft,
} from '../../utils/heldClearedDraft.js'
import { render, Text, useApp } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import TextInput from '../TextInput.js'

/**
 * CC 2.1.288 #3 — INTERACTIVE coverage for the Ctrl+C draft hold + Up restore.
 *
 * The unit suite (`src/utils/__tests__/heldClearedDraft288.test.ts`) pins the
 * store's decision logic and the official apply order. This file drives the
 * real key sequence through a real Ink instance instead, so the two wiring
 * halves are covered end to end:
 *
 *   arm @228993610 — `if(Ad.ctrl&&Ad.key==="c"&&(X_===0||eT))N.holdCleared();`
 *     → `useTextInput.handleCtrlC`'s `useDoublePress` first-press branch →
 *       `TextInput`'s `onHoldCleared` → `heldClearedDraft.holdCleared`.
 *   restore @228991419 — history-up `Iy`'s `if(N.restoreCleared()){…return}`
 *     → `onHistoryUp` → `heldClearedDraft.restoreCleared` +
 *       `applyHeldClearedDraft`.
 *
 * `PromptInput.handleHistoryUp` additionally guards on `suggestions.length > 1`
 * and `isCursorOnFirstLine` before reaching the restore; those are
 * PromptInput-local state that an empty single-line prompt already satisfies,
 * so the probe wires `onHistoryUp` exactly the way PromptInput does after the
 * guards pass.
 *
 * The tmux REPL e2e harness is unusable in this sandbox (no tmux server —
 * A/B-verified identical at the pre-change HEAD), so this Ink-level drive is
 * the deepest available interactive surface.
 */

const CTRL_C = '\x03'
const UP_ARROW = '\x1b[A'
const SETTLE_MS = 100
const HOLD_MS = 500

const DRAFT_TEXT = 'fix the [Pasted text #1] parser'
/** The rich draft state the Ctrl+C hold must preserve. */
const DRAFT_PASTED: Record<number, PastedContent> = {
  1: { id: 1, type: 'text', content: 'long pasted body' },
  2: { id: 2, type: 'image', content: 'aW1hZ2U=', mediaType: 'image/png' },
}
const DRAFT_MODE: PromptInputMode = 'bash'
/** What the probe wipes the editor down to alongside the text clear. */
const CLEARED_PASTED: Record<number, PastedContent> = {}
const CLEARED_MODE: PromptInputMode = 'prompt'

type FlowResult = {
  /** Every value the editor was driven to, in order. */
  readonly values: string[]
  /** Output frame produced by the Ctrl+C press. */
  readonly ctrlCFrame: string
  /** Output frame produced by the Up press. */
  readonly upFrame: string
  readonly holdCalls: number
  readonly historyUpCalls: number
}

/** Keep the instance alive long enough for both key frames to flush, then exit. */
function Hold({ ms }: { ms: number }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const timer = setTimeout(exit, ms)
    return () => clearTimeout(timer)
  }, [exit, ms])
  return null
}

function StatusBar({
  mode,
  pastedIds,
}: {
  mode: PromptInputMode
  pastedIds: string
}) {
  return <Text>{`mode=${mode} pasted=${pastedIds}`}</Text>
}

/**
 * A real `TextInput` wired to the real singleton store, plus a status line
 * surfacing the non-text half of the restore (mode + pasted ids) that
 * `TextInput` itself does not render.
 */
function DraftProbe({
  wireHold,
  record,
}: {
  wireHold: boolean
  record: {
    value: (value: string) => void
    hold: () => void
    historyUp: () => void
  }
}) {
  const [value, setValue] = React.useState(DRAFT_TEXT)
  const [cursorOffset, setCursorOffset] = React.useState(DRAFT_TEXT.length)
  const [mode, setMode] = React.useState<PromptInputMode>(DRAFT_MODE)
  const [pastedContents, setPastedContents] =
    React.useState<Record<number, PastedContent>>(DRAFT_PASTED)

  const handleChange = React.useCallback(
    (next: string) => {
      record.value(next)
      setValue(next)
    },
    [record],
  )

  // PromptInput.handleHistoryUp's restore branch, minus the PromptInput-local
  // guards an empty single-line prompt already satisfies.
  const handleHistoryUp = React.useCallback(() => {
    record.historyUp()
    const held = heldClearedDraft.restoreCleared(value)
    if (held) {
      applyHeldClearedDraft(held, {
        setValue: handleChange,
        setCursorOffset,
        setPastedContents,
        setMode,
      })
    }
  }, [record, value, handleChange])

  const handleHoldCleared = React.useCallback(() => {
    record.hold()
    heldClearedDraft.holdCleared({ value, mode, pastedContents })
    // PROBE SCAFFOLDING (not a claim about PromptInput): wipe the surrounding
    // editor state alongside the text clear `useTextInput` is about to run, so
    // the mode + pastedContents halves of the restore are observable.
    setMode(CLEARED_MODE)
    setPastedContents(CLEARED_PASTED)
  }, [record, value, mode, pastedContents])

  const pastedIds = Object.values(pastedContents)
    .map(entry => entry.id)
    .sort()
    .join(',')

  return (
    <>
      <TextInput
        value={value}
        onChange={handleChange}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        columns={80}
        focus
        onHistoryUp={handleHistoryUp}
        {...(wireHold ? { onHoldCleared: handleHoldCleared } : {})}
      />
      <StatusBar mode={mode} pastedIds={pastedIds} />
    </>
  )
}

type FakeStdin = NodeJS.ReadStream & {
  write: (chunk: string) => boolean
}

function makeFakeStdin(): FakeStdin {
  const stdin = new PassThrough() as unknown as FakeStdin
  // Object.assign keeps the TTY shims off the intersected `NodeJS.ReadStream`
  // property types (its `setRawMode`/`ref`/`unref` signatures differ).
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  })
  return stdin
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Render the probe, press Ctrl+C, then Up on the emptied prompt. */
async function runCtrlCThenUp(wireHold: boolean): Promise<FlowResult> {
  const values: string[] = []
  let holdCalls = 0
  let historyUpCalls = 0
  const record = {
    value: (next: string) => {
      values.push(next)
    },
    hold: () => {
      holdCalls += 1
    },
    historyUp: () => {
      historyUpCalls += 1
    },
  }

  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = makeFakeStdin()

  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <DraftProbe wireHold={wireHold} record={record} />
      <Hold ms={HOLD_MS} />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
      // Ink exits on Ctrl+C by default (`src/ink/root.ts` `exitOnCtrlC: true`);
      // the official flow needs the first press to reach `handleCtrlC`.
      exitOnCtrlC: false,
    },
  )

  // Ink appends frames to a non-TTY stdout, so each key press is measured
  // against the bytes it alone produced.
  await sleep(SETTLE_MS)
  let mark = output.length
  stdin.write(CTRL_C)
  await sleep(SETTLE_MS)
  const ctrlCFrame = stripAnsi(output.slice(mark))

  mark = output.length
  stdin.write(UP_ARROW)
  await sleep(SETTLE_MS)
  const upFrame = stripAnsi(output.slice(mark))

  await instance.waitUntilExit()
  return {
    values: [...values],
    ctrlCFrame,
    upFrame,
    holdCalls,
    historyUpCalls,
  }
}

beforeEach(() => {
  heldClearedDraft.clear()
})

afterEach(() => {
  heldClearedDraft.clear()
})

describe('CC 2.1.288 #3 — Ctrl+C draft recovery through real Ink input', () => {
  test('Ctrl+C holds the draft, then Up on the empty prompt brings it back', async () => {
    const { values, ctrlCFrame, upFrame, holdCalls, historyUpCalls } =
      await runCtrlCThenUp(true)

    // Official arm site runs holdCleared on the FIRST press, before the clear.
    expect(holdCalls).toBe(1)
    expect(historyUpCalls).toBe(1)
    // …and the clear itself still happens.
    expect(values).toContain('')
    expect(ctrlCFrame).not.toContain(DRAFT_TEXT)

    // Up restored text, pasted contents ("including pasted text and images")
    // and mode — all three overwrote the wiped editor state.
    expect(values[values.length - 1]).toBe(DRAFT_TEXT)
    expect(upFrame).toContain(DRAFT_TEXT)
    expect(upFrame).toContain('pasted=1,2')
    expect(upFrame).toContain(`mode=${DRAFT_MODE}`)
  })

  test('the restore is single-shot — the held slot is consumed by the first Up', async () => {
    await runCtrlCThenUp(true)
    expect(heldClearedDraft.peek()).toBeNull()
  })

  test('negative control: without onHoldCleared wired, Up does not restore the cleared draft', async () => {
    const { values, upFrame, holdCalls } = await runCtrlCThenUp(false)

    expect(holdCalls).toBe(0)
    expect(values).toContain('')
    // The cleared value is never re-applied.
    expect(values.filter(value => value === DRAFT_TEXT)).toHaveLength(0)
    expect(upFrame).not.toContain(DRAFT_TEXT)
  })
})
