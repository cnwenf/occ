import * as React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { render, useApp, Text } from '../../../ink.js'
import {
  screenReader,
  isScreenReaderEnabled,
} from '../../../utils/screenReader.js'
import type { BaseInputState } from '../../../types/textInputTypes.js'
import type { TextHighlight } from '../../../utils/textHighlighting.js'

/**
 * CC 2.1.305 — PromptInput screen-reader gate on the segmented highlight
 * renderer (binary o4t @257777212, byte-verified).
 *
 * Official v305 adds `!ne` (ne = ot() = isScreenReaderEnabled) to the
 * highlight-render switch — `if(V&&V.length>0&&!W&&!ne)` — so under a screen
 * reader the per-char segmented shimmer renderer (f.text.split("").map(...))
 * never runs; the SR fallthrough renders the plain full input value in a
 * single Text (`Re=W?...:e(n,{"aria-preserve-whitespace":!0,children:
 * e(Xo,{children:u})})`). It also hides the placeholder under SR
 * (`hidePlaceholderText:m||ne`, m = isVoiceRecording). The per-char
 * segmentation made screen readers announce "spaces inside words".
 *
 * OCC applies the gate at the highlights SOURCE in PromptInput.tsx baseProps
 * (`highlights: srEnabled ? undefined : combinedHighlights` + conditional
 * `hidePlaceholderText: true` spread) because the actual switch
 * (`hasHighlights`) lives in BaseTextInput.tsx, outside this WP's allowed
 * touch list. Observable behavior is identical: BaseTextInput falls through
 * to its plain `<Ansi>{renderedValue}</Ansi>` path — structurally the
 * official SR fallthrough. Deviation: OCC's ink fork has no
 * `aria-preserve-whitespace` Text attribute (0 hits in src/ink,
 * packages/@ant, Text.tsx props), so that attribute alone is dropped.
 *
 * Test strategy (full PromptInput render is infeasible — ~40 props, 26
 * context hooks):
 *   1. Source-wiring pin on PromptInput.tsx (repo precedent:
 *      remoteControlHelp302.test.ts and other readFileSync pin tests).
 *   2. Downstream-contract behavior test through the REAL BaseTextInput with
 *      a mock.module spy on HighlightedInput (ShimmeredInput.tsx): the exact
 *      baseProps shape PromptInput produces under each SR state must (a) use
 *      the segmented renderer with highlights when SR is off and (b) bypass
 *      it and render the plain value when SR is on.
 */

// ── HighlightedInput spy (bun mock.module live bindings; restored in
// afterAll — Bun's mock.module crosses file boundaries in the same worker) ──

const REAL_SHIMMER = await import('../ShimmeredInput.js')

type SpyCall = { text: string; highlightsLen: number }
const spyCalls: SpyCall[] = []

function HighlightedInputSpy(t0: { text: string; highlights: TextHighlight[] }) {
  spyCalls.push({ text: t0.text, highlightsLen: t0.highlights.length })
  return <Text>{t0.text}</Text>
}

mock.module('../ShimmeredInput.js', () => ({
  ...REAL_SHIMMER,
  HighlightedInput: HighlightedInputSpy,
}))

afterAll(() => {
  mock.module('../ShimmeredInput.js', () => ({ ...REAL_SHIMMER }))
})

const { BaseTextInput } = await import('../../BaseTextInput.js')

// ── helpers ──────────────────────────────────────────────────────────────

function setSR(on: boolean): void {
  if (on) process.env.CLAUDE_AX_SCREEN_READER = '1'
  else delete process.env.CLAUDE_AX_SCREEN_READER
  screenReader.reset()
}

/** Hold the instance open ~30ms before exiting so the frame flushes. */
function Hold({ ms }: { ms: number }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const timer = setTimeout(exit, ms)
    return () => clearTimeout(timer)
  }, [exit, ms])
  return null
}

async function renderStripped(node: React.ReactNode): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (e: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const instance = await render(
    <>
      {node}
      <Hold ms={30} />
    </>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
  )
  await instance.waitUntilExit()
  return stripAnsi(output)
}

function makeInputState(value: string): BaseInputState {
  return {
    onInput: () => {},
    renderedValue: value,
    offset: value.length,
    setOffset: () => {},
    cursorLine: 0,
    cursorColumn: value.length,
    viewportCharOffset: 0,
    viewportCharEnd: value.length,
  }
}

const HIGHLIGHTS: TextHighlight[] = [
  { start: 0, end: 2, color: undefined, priority: 0 },
]

/**
 * Build the baseProps shape PromptInput.tsx produces for the current SR
 * state — the exact expressions from the CC 2.1.305 gate (srEnabled ?
 * undefined : combinedHighlights + conditional hidePlaceholderText spread).
 */
function gatedProps(value: string, combinedHighlights: TextHighlight[]) {
  const srEnabled = isScreenReaderEnabled()
  return {
    value,
    onChange: () => {},
    focus: false,
    showCursor: false,
    highlights: srEnabled ? undefined : combinedHighlights,
    ...(srEnabled ? { hidePlaceholderText: true } : {}),
  }
}

// ── 1. source-wiring pin ─────────────────────────────────────────────────

const PROMPT_INPUT_SRC = readFileSync(
  fileURLToPath(new URL('../PromptInput.tsx', import.meta.url)),
  'utf8',
)

describe('CC 2.1.305: PromptInput SR gate source wiring', () => {
  test('imports isScreenReaderEnabled from the screenReader singleton', () => {
    expect(PROMPT_INPUT_SRC).toMatch(
      /import \{[^}]*isScreenReaderEnabled[^}]*\} from '[^']*utils\/screenReader\.js'/,
    )
  })

  test('computes srEnabled from isScreenReaderEnabled()', () => {
    expect(PROMPT_INPUT_SRC).toContain(
      'const srEnabled = isScreenReaderEnabled()',
    )
  })

  test('gates the highlights source: srEnabled ? undefined : combinedHighlights', () => {
    // Under SR the highlight array never reaches BaseTextInput's
    // hasHighlights switch (official `if(V&&V.length>0&&!W&&!ne)` — the !ne
    // arm, applied at the source in OCC).
    expect(PROMPT_INPUT_SRC).toContain(
      'highlights: srEnabled ? undefined : combinedHighlights',
    )
  })

  test('hides the placeholder text under SR (official hidePlaceholderText:m||ne)', () => {
    expect(PROMPT_INPUT_SRC).toMatch(
      /\.\.\.\(srEnabled \? \{\s*hidePlaceholderText: true\s*\} : \{\}\)/,
    )
  })
})

// ── 2. downstream contract through the real BaseTextInput ───────────────

describe('CC 2.1.305: SR-gated baseProps shape through BaseTextInput', () => {
  beforeEach(() => {
    setSR(false)
    spyCalls.length = 0
  })
  afterEach(() => setSR(false))

  test('SR off: highlights reach the segmented HighlightedInput renderer', async () => {
    // Arrange
    setSR(false)
    expect(isScreenReaderEnabled()).toBe(false)

    // Act — non-SR baseProps keep combinedHighlights.
    const props = gatedProps('hello', HIGHLIGHTS)
    await renderStripped(
      <BaseTextInput inputState={makeInputState('hello')} terminalFocus={false} {...props} />,
    )

    // Assert — the segmented renderer ran with the highlights.
    expect(spyCalls.length).toBeGreaterThan(0)
    expect(spyCalls[0].text).toBe('hello')
    expect(spyCalls[0].highlightsLen).toBe(1)
  })

  test('SR on: gated shape bypasses the segmented renderer and renders the plain value', async () => {
    // Arrange — official SR fallthrough: single plain Text with the full
    // input value (aria-preserve-whitespace dropped — unsupported in OCC's
    // ink fork, documented deviation).
    setSR(true)
    expect(isScreenReaderEnabled()).toBe(true)

    // Act — the SR baseProps shape: highlights undefined.
    const props = gatedProps('hello', HIGHLIGHTS)
    expect(props.highlights).toBeUndefined()
    const out = await renderStripped(
      <BaseTextInput inputState={makeInputState('hello')} terminalFocus={false} {...props} />,
    )

    // Assert — no per-char segmentation; the value survives as plain text.
    expect(spyCalls.length).toBe(0)
    expect(out).toContain('hello')
  })

  test('SR on: placeholder text is hidden (hidePlaceholderText)', async () => {
    // Arrange — official `hidePlaceholderText:m||ne`: under SR an empty
    // input renders no placeholder prose (screen readers otherwise announce
    // the hint text as if it were input content).
    setSR(true)

    // Act
    const props = { ...gatedProps('', []), placeholder: 'Try "edit file"' }
    expect(props.hidePlaceholderText).toBe(true)
    const out = await renderStripped(
      <BaseTextInput inputState={makeInputState('')} terminalFocus={false} {...props} />,
    )

    // Assert
    expect(out).not.toContain('Try "edit file"')
  })

  test('SR off: placeholder text still renders (non-SR unchanged)', async () => {
    // Arrange
    setSR(false)

    // Act
    const props = { ...gatedProps('', []), placeholder: 'Try "edit file"' }
    expect(props.hidePlaceholderText).toBeUndefined()
    const out = await renderStripped(
      <BaseTextInput inputState={makeInputState('')} terminalFocus={false} {...props} />,
    )

    // Assert
    expect(out).toContain('Try "edit file"')
  })
})
