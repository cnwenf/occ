import { describe, expect, test } from 'bun:test'
import { resolveEffectiveInputMode } from '../../../screens/submitInputMode309.js'
import type { ProcessUserInputContext } from '../processUserInput.js'

// Some transitively-imported modules read MACRO.VERSION at import/call time.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.309 PORT (WP-D / changelog item 14): a key-bound slash command
 * triggered from `!` (bash) mode must route as a PROMPT command, never through
 * processBashCommand.
 *
 * Routing contract (processUserInput.ts): the bash branch
 * `if (inputString !== null && mode === 'bash')` (:683) runs BEFORE the slash
 * branch (:699), so whatever mode the composer submits with decides the route.
 * Official BIN309 composer computes `ao=D?.inputModeOverride??st.mode`
 * (@276384951) and passes `mode:ao` down (@276389479); OCC mirrors this via
 * resolveEffectiveInputMode (src/screens/submitInputMode309.ts) in REPL.tsx
 * onSubmit.
 *
 * MOCK-FREE BY DESIGN: bun evaluates every test file's module scope before any
 * test runs, so a top-level `mock.module` here would be active during OTHER
 * files' tests in the same process (proved: an earlier revision spying
 * processSlashCommand broke hooksBeforeExpansion299.test.ts, which needs the
 * real module). Instead the prompt-route proof drives the REAL
 * processUserInput → REAL processSlashCommand with an unknown command, whose
 * byte-verified `Unknown command: /<name>` resultText (unknownCommandParity251)
 * is only reachable through the slash branch — a bash-branch route would have
 * executed the string as a shell command instead. The bash-branch contrast is
 * asserted purely (mode stays 'bash' without the override) because actually
 * invoking it would spawn a real shell (processBashCommand calls BashTool.call
 * with dangerouslyDisableSandbox:true).
 */

function makeContext(): ProcessUserInputContext {
  const appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      shouldAvoidPermissionPrompts: false,
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    sessionHooks: new Map(),
    ultraplanSessionUrl: undefined,
    ultraplanLaunching: false,
  }
  return {
    abortController: new AbortController(),
    agentId: undefined,
    getAppState: () => appState,
    setAppState: () => {},
    options: { commands: [], tools: [], isNonInteractiveSession: false },
    messages: [],
    readFileState: {},
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths: new Set(),
    dynamicSkillDirTriggers: new Set(),
    discoveredSkillNames: new Set(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    onChangeAPIKey: () => {},
    setMessages: () => {},
  } as unknown as ProcessUserInputContext
}

const NOOP_SET_TOOL_JSX = () => {}

describe('2.1.309 item 14 — keybound slash command routing', () => {
  test('without the override the submit mode stays "bash" (would hit the bash branch, which runs before the slash branch)', () => {
    // The pre-fix path: live `!` mode with no inputModeOverride keeps mode
    // 'bash', and processUserInput's `mode === 'bash'` branch (:683) precedes
    // the slash branch (:699) — the keybound /commit would run in the shell.
    expect(resolveEffectiveInputMode('bash', undefined)).toBe('bash')
    expect(resolveEffectiveInputMode('bash', {})).toBe('bash')
    // fromKeybinding ALONE never changed the route — only the override does.
    expect(resolveEffectiveInputMode('bash', { fromKeybinding: true })).toBe(
      'bash',
    )
  })

  test('keybound submit from bash mode routes as prompt → real slash branch answers, not the shell', async () => {
    const { processUserInput } = await import('../processUserInput.js')
    // Exactly the computation REPL onSubmit performs for a keybinding submit
    // carrying {fromKeybinding:true, inputModeOverride:'prompt'} while the
    // composer lives in `!` mode.
    const effectiveMode = resolveEffectiveInputMode('bash', {
      fromKeybinding: true,
      inputModeOverride: 'prompt',
    })
    expect(effectiveMode).toBe('prompt')

    const result = await processUserInput({
      input: '/definitely-not-a-cmd-309',
      mode: effectiveMode,
      setToolJSX: NOOP_SET_TOOL_JSX,
      context: makeContext(),
      // Keep the run attachment-free; irrelevant for prompt+slash (the
      // shouldExtractAttachments gate is false) but explicit for hygiene.
      skipAttachments: true,
    })

    // Proof of the slash route: the REAL processSlashCommand produced its
    // byte-verified unknown-command resultText (2.1.251 parity,
    // unknownCommandParity251). Had this routed to the bash branch, the string
    // would have been executed as a shell command instead and no such
    // resultText could exist.
    expect(result.resultText).toBe(
      'Unknown command: /definitely-not-a-cmd-309',
    )
    expect(result.shouldQuery).toBe(false)
  })
})
