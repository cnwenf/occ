import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../settings/types.js'

/**
 * CC 2.1.284 (security, OCC-101) — elicitation hook blocked-branch parity.
 *
 * Official v284 `mEr` (byte-verified @207400684 region) starts with
 *   if(e.blocked) return {blockingError: e.output || fallback}
 * while v283 `Vbr` (@205549934) had `if(e.blocked&&!e.succeeded)` plus a
 * `decision==="block"||e.blocked` disjunct in the JSON branch.
 *
 * The delta is observable for a hook that BOTH blocks via JSON
 * (`{"decision":"block"}`, exit 0 → blocked=true via jsonBlocked,
 * succeeded=true): v283 fell through to the JSON branch and surfaced
 * `reason`; v284 short-circuits on `blocked` and surfaces the raw output.
 *
 * Wire-level tests: real command hooks executed through the exported
 * executeElicitationHooks / executeElicitationResultHooks entrypoints.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only getHooksConfigFromSnapshot, restore.
const actualSnapshotModule = await import('../hooks/hooksConfigSnapshot.js')

let mockedHooksConfig: HooksSettings | null = null

mock.module('../hooks/hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

afterAll(() => {
  mock.module('../hooks/hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
})

const { getIsInteractive, setIsInteractive } = await import(
  '../../bootstrap/state.js'
)
const { executeElicitationHooks, executeElicitationResultHooks } =
  await import('../hooks.js')

let root: string

// Hooks require workspace trust in interactive mode; a non-interactive
// session (SDK/print path — computeTrustDialogAccepted fast-path) executes
// hooks without a persisted trust entry. Flip the session flag instead of
// touching the user's real config.
const savedInteractive = getIsInteractive()
setIsInteractive(false)

async function makeHookScript(name: string, body: string): Promise<string> {
  const path = join(root, name)
  writeFileSync(path, body, { mode: 0o755 })
  return path
}

function elicitationConfig(command: string): HooksSettings {
  return {
    Elicitation: [{ hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

function elicitationResultConfig(command: string): HooksSettings {
  return {
    ElicitationResult: [{ hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'occ-elicit-284-'))
}

afterEach(async () => {
  mockedHooksConfig = null
  await rm(root, { recursive: true, force: true })
})

afterAll(() => {
  setIsInteractive(savedInteractive)
})

describe('CC 2.1.284 — elicitation hook blocked branch (mEr parity)', () => {
  test('exit-2 plain-text hook blocks with the hook output (both versions, no regression)', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'block2.sh',
      "printf 'HOOK BLOCK TEXT' >&2; exit 2",
    )
    mockedHooksConfig = elicitationConfig(script)

    // Act
    const result = await executeElicitationHooks({
      serverName: 'srv',
      message: 'Approve?',
    })

    // Assert
    expect(result.blockingError?.blockingError).toBe('HOOK BLOCK TEXT')
    expect(result.elicitationResponse).toBeUndefined()
  })

  test('JSON decision:block with exit 0 surfaces the RAW output (v284 if(e.blocked) short-circuit; v283 would show reason)', async () => {
    // Arrange — blocked=true (jsonBlocked) AND succeeded=true (exit 0):
    // exactly the case v283's `!e.succeeded` conjunct stranded.
    await setup()
    const script = await makeHookScript(
      'jsonblock.sh',
      `printf '%s' '{"decision":"block","reason":"R"}'; exit 0`,
    )
    mockedHooksConfig = elicitationConfig(script)

    // Act
    const result = await executeElicitationHooks({
      serverName: 'srv',
      message: 'Approve?',
    })

    // Assert — v284 pins the raw output, NOT "R"
    expect(result.blockingError).toBeDefined()
    expect(result.blockingError?.blockingError).toBe(
      '{"decision":"block","reason":"R"}',
    )
  })

  test('structured accept response flows through (hookSpecificOutput.action)', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'accept.sh',
      `printf '%s' '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"ok":true}}}'; exit 0`,
    )
    mockedHooksConfig = elicitationConfig(script)

    // Act
    const result = await executeElicitationHooks({
      serverName: 'srv',
      message: 'Approve?',
    })

    // Assert
    expect(result.blockingError).toBeUndefined()
    expect(result.elicitationResponse?.action).toBe('accept')
    expect(result.elicitationResponse?.content).toEqual({ ok: true })
  })

  test('structured decline response blocks with the official fallback message', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'decline.sh',
      `printf '%s' '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}'; exit 0`,
    )
    mockedHooksConfig = elicitationConfig(script)

    // Act
    const result = await executeElicitationHooks({
      serverName: 'srv',
      message: 'Approve?',
    })

    // Assert
    expect(result.elicitationResponse?.action).toBe('decline')
    expect(result.blockingError?.blockingError).toBe(
      'Elicitation denied by hook',
    )
  })

  test('non-JSON exit-0 output is ignored (no block, no response)', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'plain.sh',
      "printf 'just some text'; exit 0",
    )
    mockedHooksConfig = elicitationConfig(script)

    // Act
    const result = await executeElicitationHooks({
      serverName: 'srv',
      message: 'Approve?',
    })

    // Assert
    expect(result.blockingError).toBeUndefined()
    expect(result.elicitationResponse).toBeUndefined()
  })

  test('ElicitationResult path: exit-2 blocks with result-specific fallback wiring', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'block2r.sh',
      "printf 'RESULT BLOCK TEXT' >&2; exit 2",
    )
    mockedHooksConfig = elicitationResultConfig(script)

    // Act
    const result = await executeElicitationResultHooks({
      serverName: 'srv',
      action: 'accept',
    })

    // Assert
    expect(result.blockingError?.blockingError).toBe('RESULT BLOCK TEXT')
    expect(result.elicitationResultResponse).toBeUndefined()
  })

  test('ElicitationResult path: decline blocks with the result-specific fallback message', async () => {
    // Arrange
    await setup()
    const script = await makeHookScript(
      'decliner.sh',
      `printf '%s' '{"hookSpecificOutput":{"hookEventName":"ElicitationResult","action":"decline"}}'; exit 0`,
    )
    mockedHooksConfig = elicitationResultConfig(script)

    // Act
    const result = await executeElicitationResultHooks({
      serverName: 'srv',
      action: 'accept',
    })

    // Assert
    expect(result.blockingError?.blockingError).toBe(
      'Elicitation result blocked by hook',
    )
  })
})
