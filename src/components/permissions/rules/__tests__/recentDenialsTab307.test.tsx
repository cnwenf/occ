import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../../../ink.js'
import { KeybindingProvider } from '../../../../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../../../../keybindings/defaultBindings.js'
import { parseBindings } from '../../../../keybindings/parser.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../../../../keybindings/types.js'
import { AppStateProvider } from '../../../../state/AppState.js'
import {
  type AutoModeDenial,
  _resetDenialsForTesting,
  getAutoModeDenials,
  recordAutoModeDenial,
} from '../../../../utils/autoModeDenials.js'
import { WITHHELD_MARKER } from '../denialDisplay.js'
import { PermissionRuleList } from '../PermissionRuleList.js'
import { RecentDenialsTab } from '../RecentDenialsTab.js'

/**
 * CC 2.1.307 PORT B6 / review F-11 — component tests for the recently-denied
 * tab. denialDisplay307.test.ts covers the pure builders; the mutation probe
 * `focusedIdx → focusedIdx+1` in RecentDenialsTab.tsx (`focusedCommand =
 * commandDisplays[focusedIdx]`, line 140) survived that suite because no test
 * rendered the component. These tests render the REAL component through the
 * repo's fake-TTY harness (precedent: src/ink/__tests__/
 * keyboardEventBridge288.test.tsx setupInteractive — PassThrough stdout/stdin,
 * isTTY stdin with no-op setRawMode, render() from src/ink.js, stripAnsi on
 * collected chunks) wrapped in a bare KeybindingProvider over
 * parseBindings(DEFAULT_BINDINGS) so Select navigation (select:next/accept,
 * context 'Select') and ctrl+o (app:toggleTranscript, context 'Global')
 * resolve exactly as in production. No test library is installed; none exists
 * in package.json.
 *
 * ink rewrites the WHOLE component tree each frame, so the stdout buffer is a
 * concatenation of full frames. Assertions read only the LATEST frame (text
 * after the last occurrence of a per-frame marker line) so stale
 * pre-navigation frames cannot mask a wrong-row reveal.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Settling delay after each keystroke (precedent: keyboardEventBridge288). */
const FRAME_MS = 40
/**
 * A lone ESC is buffered as an incomplete escape sequence and flushed by
 * App.incompleteEscapeTimer after NORMAL_TIMEOUT=50ms (App.tsx:133) — wait
 * longer than the flush + a render cycle.
 */
const ESCAPE_FLUSH_MS = 200

// -- key sequences -----------------------------------------------------------
const KEY_DOWN = '\x1B[B'
const KEY_ENTER = '\r'
const KEY_CTRL_O = '\x0f'
const KEY_ESCAPE = '\x1b'

/** Rendered once per frame at the top of DenialsList — frame split marker. */
const LIST_HEADER = 'Commands recently denied by the auto mode classifier.'

// -- test data ---------------------------------------------------------------
// Row 0: a command long enough to window. The harness stdout has no .columns
// so ink defaults to 80 columns; contentWidth = 80 - WINDOW_GUTTER_COLUMNS(6)
// = 74. Each line is far under 74 chars, so wrapAnsi yields exactly 10 lines
// > MAX_COMMAND_ROWS(8): window 1 shows lines 0..6 (shown = visible-1 = 7),
// window 2 (nextStart 7 clamped to 10-7=3) shows lines 3..9.
const LONG_LINES = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
].map(n => `echo ALPHALINE${n}`)
const LONG_CMD = LONG_LINES.join('\n')

const SHORT_CMD = 'git push --force-with-lease origin SHORTBETACMD'

// Withheld row: the grapheme marker trips GRAPHEME_MARKER_RE inside
// sanitizeDenialValue, and >2000 units makes truncateCommand fall back to the
// preview head + cutChars > 0 → commandCutGutter renders. The DISPLAY carries
// the marker too so sanitizeDenialLabels withholds the row label
// (`${WITHHELD_MARKER} (#1)`) → withheldIdx blocks approval in the tab, while
// PermissionRuleList's meta message must still carry the RAW FULL command.
const GAMMA_CMD = `echo GAMMACMD … [+3 graphemes] ${'g'.repeat(2500)}`
const GAMMA_DISPLAY = 'Oversized script GAMMACMD … [+3 graphemes]'

// Display-only row (no command) — focusedCommand is undefined, so the reveal
// block must not render at all.
const DELTA_DISPLAY = 'display-only-delta'

// Cut-command row with a CLEAN display: the grapheme marker inside the
// COMMAND trips truncateCommand's withheld branch (cutChars > 0) while the
// label stays approvable. denialsMetaMessage must carry the RAW FULL command
// for such rows (`display.cutChars > 0 ? denial.command : display.text`).
const EPSILON_CMD = `echo EPSILONCMD … [+3 graphemes] ${'e'.repeat(2500)}`
const EPSILON_DISPLAY = 'Epsilon script'

type SelectionState = {
  approved: Set<number>
  retry: Set<number>
  denials: readonly AutoModeDenial[]
}

const ALPHA_DENIAL: AutoModeDenial = {
  toolName: 'Bash',
  display: 'Long deploy script (alpha)',
  command: LONG_CMD,
  inputKey: '{"command":"key-alpha"}',
  reason: 'reason alpha',
  timestamp: 1,
}
const BETA_DENIAL: AutoModeDenial = {
  toolName: 'Bash',
  display: 'Push to origin (beta)',
  command: SHORT_CMD,
  inputKey: '{"command":"key-beta"}',
  reason: 'reason beta',
  timestamp: 2,
}
const GAMMA_DENIAL: AutoModeDenial = {
  toolName: 'Bash',
  display: GAMMA_DISPLAY,
  command: GAMMA_CMD,
  inputKey: '{"command":"key-gamma"}',
  reason: 'reason gamma',
  timestamp: 3,
}
const DELTA_DENIAL: AutoModeDenial = {
  toolName: 'WebFetch',
  display: DELTA_DISPLAY,
  inputKey: '{"url":"key-delta"}',
  reason: 'reason delta',
  timestamp: 4,
}
const EPSILON_DENIAL: AutoModeDenial = {
  toolName: 'Bash',
  display: EPSILON_DISPLAY,
  command: EPSILON_CMD,
  inputKey: '{"command":"key-epsilon"}',
  reason: 'reason epsilon',
  timestamp: 5,
}

/** recordAutoModeDenial prepends → record in reverse of the desired order. */
function seedDenials(denials: readonly AutoModeDenial[]): void {
  for (const denial of [...denials].reverse()) {
    recordAutoModeDenial(denial)
  }
}

// -- harness -----------------------------------------------------------------

const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  while (mounted.length > 0) {
    try {
      mounted.pop()?.unmount()
    } catch {
      // instance already torn down
    }
  }
  _resetDenialsForTesting()
})

type TestKeybindingProviderProps = {
  children: React.ReactNode
}

/**
 * Bare KeybindingProvider over the production DEFAULT_BINDINGS. Props mirror
 * KeybindingProviderSetup.tsx (pendingChordRef + state kept in sync, mutable
 * activeContexts Set, handler registry Map). No ChordInterceptor: single-key
 * bindings (down/enter/ctrl+o/escape) resolve inside useKeybinding(s)' own
 * useInput handler, which is all these tests drive.
 */
function TestKeybindingProvider({ children }: TestKeybindingProviderProps) {
  const [pendingChord, setPendingChordState] =
    React.useState<ParsedKeystroke[] | null>(null)
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const handlerRegistryRef = React.useRef(
    new Map<
      string,
      Set<{
        action: string
        context: KeybindingContextName
        handler: () => void
      }>
    >(),
  )
  const contextsRef = React.useRef(new Set<KeybindingContextName>())
  const bindings = React.useMemo(() => parseBindings(DEFAULT_BINDINGS), [])
  const setPendingChord = React.useCallback(
    (pending: ParsedKeystroke[] | null) => {
      pendingChordRef.current = pending
      setPendingChordState(pending)
    },
    [],
  )
  const registerActiveContext = React.useCallback(
    (context: KeybindingContextName) => {
      contextsRef.current.add(context)
    },
    [],
  )
  const unregisterActiveContext = React.useCallback(
    (context: KeybindingContextName) => {
      contextsRef.current.delete(context)
    },
    [],
  )
  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={contextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  )
}

type Harness = {
  /** Everything written to stdout so far (all frames), ANSI-stripped. */
  all: () => string
  stdin: NodeJS.ReadStream
}

async function setup(node: React.ReactNode): Promise<Harness> {
  const chunks: string[] = []
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    chunks.push(chunk.toString())
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(
    <TestKeybindingProvider>{node}</TestKeybindingProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    },
  )
  mounted.push(instance)
  return {
    all: () => stripAnsi(chunks.join('')),
    stdin,
  }
}

/** The newest rendered frame: everything after the marker's last occurrence. */
function lastFrame(harness: Harness, marker: string): string {
  const full = harness.all()
  const index = full.lastIndexOf(marker)
  return index === -1 ? full : full.slice(index)
}

/** Write a key, let ink flush, return the newest frame. */
async function press(
  harness: Harness,
  sequence: string,
  marker: string,
  ms: number = FRAME_MS,
): Promise<string> {
  harness.stdin.write(sequence)
  await delay(ms)
  return lastFrame(harness, marker)
}

type ExitOptions = {
  display?: string
  shouldQuery?: boolean
  metaMessages?: string[]
  metaMessagesOrigin?: { kind: 'auto-continuation' }
}

// -- tests -------------------------------------------------------------------

describe('RecentDenialsTab (2.1.307 B6, review F-11): focused-row reveal', () => {
  let latestState: SelectionState | undefined
  let headerFocus: boolean | undefined
  const onStateChange = (state: SelectionState) => {
    latestState = state
  }

  beforeEach(() => {
    _resetDenialsForTesting()
    latestState = undefined
    headerFocus = undefined
  })

  test('empty state renders the official copy and reports empty selection', async () => {
    const harness = await setup(
      <RecentDenialsTab
        onStateChange={onStateChange}
        onHeaderFocusChange={focused => {
          headerFocus = focused
        }}
      />,
    )
    await delay(FRAME_MS)
    const frame = lastFrame(harness, 'No recent denials.')
    expect(frame.replace(/\s+/g, ' ')).toContain(
      'No recent denials. Commands denied by the auto mode classifier will appear here.',
    )
    expect(headerFocus).toBe(true)
    expect(latestState).toBeDefined()
    expect(latestState?.approved.size).toBe(0)
    expect(latestState?.retry.size).toBe(0)
    expect(latestState?.denials.length).toBe(0)
  })

  test('initial reveal shows the FOCUSED (first) row command — kills focusedIdx+1', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    const frame = lastFrame(harness, LIST_HEADER)
    // Row 0 is focused at mount → its windowed command is revealed (rows
    // 1..7 of 10), NOT row 1's (the focusedIdx+1 mutant would reveal
    // SHORTBETACMD here and none of the alpha lines).
    for (const token of ['ALPHALINE01', 'ALPHALINE04', 'ALPHALINE07']) {
      expect(frame).toContain(token)
    }
    for (const token of ['ALPHALINE08', 'ALPHALINE09', 'ALPHALINE10']) {
      expect(frame).not.toContain(token)
    }
    expect(frame).not.toContain('SHORTBETACMD')
    expect(frame).not.toContain('GAMMACMD')
    // Hidden-rows gutter with the resolved ctrl+o chord hint.
    expect(frame).toContain('… +3 lines (ctrl+o to see more)')
  })

  test('down-arrow navigation switches the reveal to the next row command — kills focusedIdx+1', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    const frame = await press(harness, KEY_DOWN, LIST_HEADER)
    // Focus is row 1 → reveal must be row 1's command. The focusedIdx+1
    // mutant reveals commandDisplays[2] (the withheld GAMMACMD preview).
    expect(frame).toContain('SHORTBETACMD')
    expect(frame).not.toContain('ALPHALINE')
    expect(frame).not.toContain('GAMMACMD')
  })

  test('display-only row reveals no command at all', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    let frame = ''
    for (let i = 0; i < 3; i++) {
      frame = await press(harness, KEY_DOWN, LIST_HEADER)
    }
    // Row 3 has command === undefined → focusedCommand undefined → the whole
    // reveal block is absent (a focusedIdx-1 mutant would reveal GAMMACMD).
    expect(frame).toContain('display-only-delt')
    expect(frame).not.toContain('ALPHALINE')
    expect(frame).not.toContain('SHORTBETACMD')
    expect(frame).not.toContain('GAMMACMD')
    expect(frame).not.toContain('ctrl+o to see')
    expect(DELTA_DISPLAY).toBe('display-only-delta')
  })

  test('ctrl+o advances the focused command window and cycles back', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    // Window 2: lines 3..9 (nextStart 7 clamped to 10-7).
    const expanded = await press(harness, KEY_CTRL_O, LIST_HEADER)
    for (const token of ['ALPHALINE08', 'ALPHALINE09', 'ALPHALINE10']) {
      expect(expanded).toContain(token)
    }
    for (const token of ['ALPHALINE01', 'ALPHALINE02', 'ALPHALINE03']) {
      expect(expanded).not.toContain(token)
    }
    expect(expanded).toContain('… +3 lines above')
    expect(expanded).toContain('(ctrl+o to see the first lines)')
    // Window end reached → nextStart wraps to 0 → back to the first window.
    const cycled = await press(harness, KEY_CTRL_O, LIST_HEADER)
    expect(cycled).toContain('ALPHALINE01')
    expect(cycled).not.toContain('ALPHALINE08')
    expect(cycled).toContain('… +3 lines (ctrl+o to see more)')
  })

  test('digit first-press moves focus only; Enter approves the FOCUSED denial', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    // Digit '2' → Select onChange('1') on an unfocused row → official `ot`:
    // first press moves focus (pressedEnterValue/defaultFocusValue), no
    // approval yet.
    const moved = await press(harness, '2', LIST_HEADER)
    expect(latestState?.approved.size).toBe(0)
    expect(moved).toContain('SHORTBETACMD')
    expect(moved).not.toContain('ALPHALINE')
    expect(moved).not.toContain('Esc will approve')
    // Second Enter on the now-focused row toggles approval — the callback
    // must carry row 1's identity, not the visually-first row's.
    const approvedFrame = await press(harness, KEY_ENTER, LIST_HEADER)
    expect(latestState?.approved.size).toBe(1)
    const [approvedIdx] = [...(latestState?.approved ?? new Set<number>())]
    expect(approvedIdx).toBe(1)
    expect(latestState?.denials[approvedIdx]).toBe(BETA_DENIAL)
    expect(latestState?.denials[approvedIdx]?.inputKey).toBe(
      '{"command":"key-beta"}',
    )
    expect(approvedFrame).toContain('Esc will approve 1 denied call')
  })

  test('down + Enter approves the navigated-to denial identity; Enter again un-toggles', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    await press(harness, KEY_DOWN, LIST_HEADER)
    await press(harness, KEY_ENTER, LIST_HEADER)
    expect(latestState?.approved.size).toBe(1)
    const [approvedIdx] = [...(latestState?.approved ?? new Set<number>())]
    expect(approvedIdx).toBe(1)
    expect(latestState?.denials[approvedIdx]).toBe(BETA_DENIAL)
    expect(latestState?.denials[approvedIdx]?.inputKey).toBe(
      '{"command":"key-beta"}',
    )
    // Enter again un-toggles.
    await press(harness, KEY_ENTER, LIST_HEADER)
    expect(latestState?.approved.size).toBe(0)
  })

  test('withheld row shows the marker + cut gutter and is not approvable', async () => {
    seedDenials([ALPHA_DENIAL, BETA_DENIAL, GAMMA_DENIAL, DELTA_DENIAL])
    const harness = await setup(<RecentDenialsTab onStateChange={onStateChange} />)
    await delay(FRAME_MS)
    await press(harness, KEY_DOWN, LIST_HEADER)
    const frame = await press(harness, KEY_DOWN, LIST_HEADER)
    // Row label: withheld marker with the (#1) numbering (the label wraps at
    // the 74-column content width, so compare whitespace-normalized).
    const flat = frame.replace(/\s+/g, ' ')
    expect(flat).toContain(`${WITHHELD_MARKER} (#1)`)
    // Reveal: sanitized preview head + the cut gutter ("approving grants the
    // whole command").
    expect(frame).toContain('echo GAMMACMD')
    expect(frame).toMatch(
      /… and \d[\d,]* more characters not shown; approving grants the whole command/,
    )
    // Enter must NOT approve a withheld row (official `ke`).
    const afterEnter = await press(harness, KEY_ENTER, LIST_HEADER)
    expect(latestState?.approved.size).toBe(0)
    expect(afterEnter).not.toContain('Esc will approve')
  })
})

describe('PermissionRuleList handleRulesCancel (2.1.307 B6, review F-11): approve wiring', () => {
  beforeEach(() => {
    _resetDenialsForTesting()
  })

  test('Esc after approving removes the denials from the store and builds the meta message with FULL cut commands', async () => {
    // alpha (long windowed command) + epsilon (CUT command, clean label —
    // withheld rows cannot be approved, so the cut-command meta path needs a
    // row whose display sanitizes fine but whose command trips
    // truncateCommand's withheld branch → cutChars > 0). hasDenials →
    // defaultTab 'recent' AND initialHeaderFocused={!hasDenials} = false, so
    // the denial list has focus from mount: Enter approves alpha → Down moves
    // to epsilon → Enter approves → Escape fires the real handleRulesCancel
    // (confirm:no, Settings context, escape binding resolved by the
    // production DEFAULT_BINDINGS through useKeybinding's useInput).
    seedDenials([ALPHA_DENIAL, EPSILON_DENIAL])
    const exits: Array<{ result?: string; options?: ExitOptions }> = []
    const retried: string[][] = []
    const harness = await setup(
      <AppStateProvider>
        <PermissionRuleList
          onExit={(result, options) => {
            exits.push({ result, options: options as ExitOptions })
          }}
          onRetryDenials={commands => {
            retried.push(commands)
          }}
        />
      </AppStateProvider>,
    )
    await delay(FRAME_MS)
    expect(harness.all()).toContain(LIST_HEADER)

    const step = async (sequence: string, ms: number = FRAME_MS) => {
      harness.stdin.write(sequence)
      await delay(ms)
    }
    await step(KEY_ENTER) // approve alpha (row 0, focused from mount)
    await step(KEY_DOWN) // row 1 (epsilon)
    await step(KEY_ENTER) // approve epsilon
    await step(KEY_ESCAPE, ESCAPE_FLUSH_MS) // handleRulesCancel

    expect(retried.length).toBe(0)
    expect(exits.length).toBe(1)
    const exit = exits[0]
    // Result string: "Approved <bold label>, <bold label>" in approval order.
    expect(exit.result).toBe(
      `Approved ${chalk.bold('Long deploy script (alpha)')}, ${chalk.bold(EPSILON_DISPLAY)}`,
    )
    // Meta message: cut rows carry the RAW FULL command (denialsMetaMessage),
    // windowed rows carry the sanitized text (=== LONG_CMD here, ASCII).
    expect(exit.options?.metaMessages?.length).toBe(1)
    expect(exit.options?.metaMessages?.[0]).toBe(
      `Permission granted for: ${LONG_CMD}, ${EPSILON_CMD}. You may now retry these commands if you would like.`,
    )
    expect(exit.options?.metaMessagesOrigin).toEqual({
      kind: 'auto-continuation',
    })
    expect(exit.options?.shouldQuery).toBeUndefined()
    // Official `for(const xh of lr)b(xh)`: both approved denials left the
    // module store (removed BY IDENTITY).
    const remaining = getAutoModeDenials()
    expect(remaining).not.toContain(ALPHA_DENIAL)
    expect(remaining).not.toContain(EPSILON_DENIAL)
  })

  test('Esc with nothing approved dismisses without meta messages', async () => {
    seedDenials([ALPHA_DENIAL])
    const exits: Array<{ result?: string; options?: ExitOptions }> = []
    const harness = await setup(
      <AppStateProvider>
        <PermissionRuleList
          onExit={(result, options) => {
            exits.push({ result, options: options as ExitOptions })
          }}
        />
      </AppStateProvider>,
    )
    await delay(FRAME_MS)
    harness.stdin.write(KEY_ESCAPE)
    await delay(ESCAPE_FLUSH_MS)

    expect(exits.length).toBe(1)
    expect(exits[0].result).toBe('Permissions dialog dismissed')
    expect(exits[0].options).toEqual({ display: 'system' })
    // Nothing approved → the denial stays in the store.
    expect(getAutoModeDenials()).toContain(ALPHA_DENIAL)
  })
})
