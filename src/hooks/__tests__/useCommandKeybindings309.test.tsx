import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import { render } from '../../ink.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { parseBindings } from '../../keybindings/parser.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../../keybindings/types.js'
import { AppStateProvider } from '../../state/AppState.js'
import { CommandKeybindingHandlers } from '../useCommandKeybindings.js'

/**
 * CC 2.1.309 PORT (WP-D / changelog item 14) — key-bound slash commands must
 * NOT run in the shell when triggered from `!` (bash) mode.
 *
 * Official 2.1.309 keybinding loop (BIN309 @274974889):
 *   `Ge[st]=()=>{x(\`/${ct}\`,Wm,{fromKeybinding:!0,inputModeOverride:"prompt"})}`
 * 308 (BIN308 @273947007) omitted `inputModeOverride`, so the command inherited
 * the composer's live mode and — in `!` mode — routed through processBashCommand.
 *
 * This test renders the REAL CommandKeybindingHandlers through the repo's
 * fake-TTY harness (precedent: recentDenialsTab307.test.tsx) wrapped in a bare
 * KeybindingProvider over a custom binding that maps ctrl+g → command:commit in
 * the Chat context, plus an AppStateProvider (useIsModalOverlayActive reads
 * AppState). Pressing the bound key must fire onSubmit with the 309 options
 * object carrying inputModeOverride:'prompt'.
 */

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const FRAME_MS = 40

/** ctrl+g — BEL (0x07); ink reports key.ctrl with the letter. */
const KEY_CTRL_G = '\x07'

const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  while (mounted.length > 0) {
    try {
      mounted.pop()?.unmount()
    } catch {
      // instance already torn down
    }
  }
})

type SpyCall = {
  input: string
  options: { fromKeybinding?: boolean; inputModeOverride?: string } | undefined
}

function makeProvider(bindings: ReturnType<typeof parseBindings>) {
  return function TestKeybindingProvider({
    children,
  }: {
    children: React.ReactNode
  }) {
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
}

async function setup(node: React.ReactNode, Provider: React.ComponentType<any>) {
  const stdout = new PassThrough()
  stdout.on('data', () => {})
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(
    <Provider>
      <AppStateProvider>{node}</AppStateProvider>
    </Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    },
  )
  mounted.push(instance)
  return { stdin }
}

describe('useCommandKeybindings (2.1.309 item 14): inputModeOverride plumb', () => {
  test('key-bound slash command submits with fromKeybinding + inputModeOverride:"prompt"', async () => {
    const calls: SpyCall[] = []
    const onSubmit = (
      input: string,
      _helpers: unknown,
      _speculationAccept?: undefined,
      options?: { fromKeybinding?: boolean; inputModeOverride?: string },
    ) => {
      calls.push({ input, options })
    }
    const bindings = parseBindings([
      { context: 'Chat', bindings: { 'ctrl+g': 'command:commit' } },
    ])
    const Provider = makeProvider(bindings)
    const harness = await setup(
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={true} />,
      Provider,
    )
    await delay(FRAME_MS)

    harness.stdin.write(KEY_CTRL_G)
    await delay(FRAME_MS)

    expect(calls.length).toBe(1)
    expect(calls[0]?.input).toBe('/commit')
    // 2.1.309: the submit MUST carry inputModeOverride:'prompt' so the command
    // never routes through the shell when the composer is in `!` mode.
    expect(calls[0]?.options).toEqual({
      fromKeybinding: true,
      inputModeOverride: 'prompt',
    })
  })

  test('every command:* binding gets the inputModeOverride, command name sliced at 8 chars', async () => {
    const calls: SpyCall[] = []
    const onSubmit = (
      input: string,
      _helpers: unknown,
      _speculationAccept?: undefined,
      options?: { fromKeybinding?: boolean; inputModeOverride?: string },
    ) => {
      calls.push({ input, options })
    }
    const bindings = parseBindings([
      { context: 'Chat', bindings: { 'ctrl+g': 'command:clear' } },
    ])
    const Provider = makeProvider(bindings)
    const harness = await setup(
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={true} />,
      Provider,
    )
    await delay(FRAME_MS)

    harness.stdin.write(KEY_CTRL_G)
    await delay(FRAME_MS)

    expect(calls.length).toBe(1)
    // "command:clear".slice(8) === "clear" → "/clear"
    expect(calls[0]?.input).toBe('/clear')
    expect(calls[0]?.options?.inputModeOverride).toBe('prompt')
    expect(calls[0]?.options?.fromKeybinding).toBe(true)
  })
})
