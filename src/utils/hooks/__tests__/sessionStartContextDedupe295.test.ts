import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ShellCommand } from '../../ShellCommand.js'

/**
 * CC 2.1.295 (#070): "Fixed an async SessionStart hook's unchanged context
 * being re-added to the conversation on every resume."
 *
 * v294's `XPr` (getAsyncHookResponseAttachments) had NO dedupe gate — the
 * string "Not adding the output of" has zero hits in the v294 binary. v295
 * added the `rPr`/`Hmn`/`sPr`/`iPr`/`Umn` subsystem (@218461100-218462900)
 * and rewrote the generator as `JMr(h??[])` (@218534200+): seed prior
 * SessionStart attachments from the conversation, gate each new SessionStart
 * response through `Umn`, and accumulate created attachments for in-batch
 * dedupe.
 */

// Mock hookEvents to avoid timer/emit side effects during tests.
mock.module('../../hooks/hookEvents.js', () => ({
  startHookProgressInterval: () => () => {},
  emitHookResponse: () => {},
}))

const {
  extractSessionStartTexts,
  parseSessionStartAttachment,
  isDuplicateSessionStartResponse,
} = await import('../../hooks/sessionStartContextDedupe.js')

const {
  registerPendingAsyncHook,
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
} = await import('../../hooks/AsyncHookRegistry.js')

// ---------------------------------------------------------------------------
// Official `Hmn` — extractSessionStartTexts
// ---------------------------------------------------------------------------
describe('extractSessionStartTexts (official Hmn)', () => {
  test('returns systemMessage and additionalContext as texts', () => {
    // Arrange
    const response = {
      systemMessage: 'welcome back',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'git status: clean',
      },
    }

    // Act
    const texts = extractSessionStartTexts(response)

    // Assert
    expect(texts).toEqual(['welcome back', 'git status: clean'])
  })

  test('filters out undefined and empty-string entries', () => {
    // Arrange / Act / Assert
    expect(extractSessionStartTexts({ systemMessage: '' })).toEqual([])
    expect(
      extractSessionStartTexts({
        hookSpecificOutput: { additionalContext: '' },
      }),
    ).toEqual([])
    expect(extractSessionStartTexts({})).toEqual([])
  })

  test('returns [] for malformed or non-object responses (safeParse failure)', () => {
    // Arrange / Act / Assert
    expect(extractSessionStartTexts(undefined)).toEqual([])
    expect(extractSessionStartTexts('not an object')).toEqual([])
    expect(extractSessionStartTexts({ systemMessage: 42 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Official `iPr` — parseSessionStartAttachment
// ---------------------------------------------------------------------------
describe('parseSessionStartAttachment (official iPr)', () => {
  test('parses a SessionStart async_hook_response and extracts texts', () => {
    // Arrange
    const attachment = {
      type: 'async_hook_response',
      hookEvent: 'SessionStart',
      response: { systemMessage: 'ctx' },
      command: './startup.sh',
      pluginId: undefined,
      exitCode: 0,
    }

    // Act
    const parsed = parseSessionStartAttachment(attachment)

    // Assert
    expect(parsed).toBeDefined()
    expect(parsed?.texts).toEqual(['ctx'])
    expect(parsed?.command).toBe('./startup.sh')
    expect(parsed?.exitCode).toBe(0)
  })

  test('rejects async_hook_response attachments from other hook events', () => {
    // Arrange — hookEvent literal gate in official `sPr`
    const attachment = {
      type: 'async_hook_response',
      hookEvent: 'PostToolUse',
      response: { systemMessage: 'ctx' },
    }

    // Act / Assert
    expect(parseSessionStartAttachment(attachment)).toBeUndefined()
  })

  test('parses a SessionStart hook_additional_context (sync path attachment)', () => {
    // Arrange
    const attachment = {
      type: 'hook_additional_context',
      hookEvent: 'SessionStart',
      content: ['memory file A', 'memory file B'],
      hookName: 'SessionStart',
      toolUseID: 'SessionStart',
    }

    // Act
    const parsed = parseSessionStartAttachment(attachment)

    // Assert
    expect(parsed?.texts).toEqual(['memory file A', 'memory file B'])
    expect(parsed?.command).toBeUndefined()
  })

  test('parses hook_success: empty content → [], non-empty → single text', () => {
    // Arrange / Act / Assert — official: content===""?[]:[content]
    expect(
      parseSessionStartAttachment({
        type: 'hook_success',
        hookEvent: 'SessionStart',
        content: '',
      })?.texts,
    ).toEqual([])
    expect(
      parseSessionStartAttachment({
        type: 'hook_success',
        hookEvent: 'SessionStart',
        content: 'done',
      })?.texts,
    ).toEqual(['done'])
  })

  test('returns undefined for other attachment types and malformed input', () => {
    // Arrange / Act / Assert
    expect(
      parseSessionStartAttachment({ type: 'queued_command', content: 'x' }),
    ).toBeUndefined()
    expect(parseSessionStartAttachment(null)).toBeUndefined()
    expect(parseSessionStartAttachment({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Official `Umn` — isDuplicateSessionStartResponse (THE #070 gate)
// ---------------------------------------------------------------------------
describe('isDuplicateSessionStartResponse (official Umn)', () => {
  const priorAsync = (opts: {
    command?: string
    pluginId?: string
    exitCode?: number
    response?: unknown
  }) => ({
    type: 'async_hook_response' as const,
    hookEvent: 'SessionStart' as const,
    response: opts.response ?? {},
    command: opts.command,
    pluginId: opts.pluginId,
    exitCode: opts.exitCode,
  })

  test('is false when the new response carries no texts', () => {
    // Arrange / Act / Assert — Hmn → [] short-circuits before the scan
    expect(
      isDuplicateSessionStartResponse(
        { response: {}, command: './a.sh' },
        [priorAsync({ command: './a.sh', response: {} })],
      ),
    ).toBe(false)
  })

  test('is true when the same command already delivered identical texts (resume case)', () => {
    // Arrange — the #070 bug: on resume the unchanged context was re-added
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert
    expect(duplicate).toBe(true)
  })

  test('is false when the same command delivers changed texts', () => {
    // Arrange
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v2' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert
    expect(duplicate).toBe(false)
  })

  test('is true when every new text is included in the prior texts (subset rule)', () => {
    // Arrange — official: r.every(S => h.texts.includes(S))
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: {
          systemMessage: 'a',
          hookSpecificOutput: { additionalContext: 'b' },
        },
      }),
    ]

    // Act / Assert
    expect(
      isDuplicateSessionStartResponse(
        { response: { systemMessage: 'a' }, command: './startup.sh' },
        prior,
      ),
    ).toBe(true)
    expect(
      isDuplicateSessionStartResponse(
        {
          response: {
            systemMessage: 'a',
            hookSpecificOutput: { additionalContext: 'c' },
          },
          command: './startup.sh',
        },
        prior,
      ),
    ).toBe(false)
  })

  test('skips prior async responses from a different command', () => {
    // Arrange — official: h.command!==void 0 && !y → continue
    const prior = [
      priorAsync({
        command: './other-hook.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert — identical texts but a different source hook: NOT a duplicate
    expect(duplicate).toBe(false)
  })

  test('matches against a prior sync hook_additional_context (command undefined)', () => {
    // Arrange — sync SessionStart attachments carry no command, so they are
    // not skipped by the different-command rule
    const prior = [
      {
        type: 'hook_additional_context',
        hookEvent: 'SessionStart',
        content: ['context v1'],
        hookName: 'SessionStart',
        toolUseID: 'SessionStart',
      },
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert
    expect(duplicate).toBe(true)
  })

  test('returns false at a prior same-source async response with no texts and exitCode 0', () => {
    // Arrange — official: y && h.exitCode===0 → return !1 (decisive entry)
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
      priorAsync({ command: './startup.sh', exitCode: 0, response: {} }),
    ]

    // Act — backward scan hits the text-less entry FIRST and stops there
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert
    expect(duplicate).toBe(false)
  })

  test('scans backward: the most recent prior entry with texts decides', () => {
    // Arrange — [identical-old, different-new]; backward scan sees different first
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v2' },
      }),
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert
    expect(duplicate).toBe(false)
  })

  test('skips unparseable prior entries and non-SessionStart attachments', () => {
    // Arrange
    const prior = [
      priorAsync({
        command: './startup.sh',
        exitCode: 0,
        response: { systemMessage: 'context v1' },
      }),
      { type: 'queued_command' }, // unparseable → continue
      {
        type: 'async_hook_response',
        hookEvent: 'PostToolUse', // wrong event → continue
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
    ]

    // Act
    const duplicate = isDuplicateSessionStartResponse(
      {
        response: { systemMessage: 'context v1' },
        command: './startup.sh',
      },
      prior,
    )

    // Assert — the first (oldest) entry still decides
    expect(duplicate).toBe(true)
  })

  test('is false with an empty prior-attachment list', () => {
    // Arrange / Act / Assert
    expect(
      isDuplicateSessionStartResponse(
        { response: { systemMessage: 'context v1' }, command: './a.sh' },
        [],
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration — registry payload carries `command` for the dedupe gate
// ---------------------------------------------------------------------------
function createMockShellCommand(opts: {
  stdout?: string
  code?: number
}): ShellCommand {
  const stdout = opts.stdout ?? ''
  return {
    status: 'completed',
    result: Promise.resolve({
      stdout: '',
      stderr: '',
      code: opts.code ?? 0,
      interrupted: false,
    }),
    cleanup: () => {},
    kill: () => {},
    background: () => true,
    onTimeout: undefined,
    taskOutput: {
      getStdout: async () => stdout,
      getStderr: () => '',
      clear: () => {},
      spillToDisk: () => {},
      stdoutToFile: false,
      path: '',
      taskId: '',
      outputFileRedundant: false,
      outputFileSize: 0,
      totalLines: 0,
      totalBytes: 0,
      isOverflowed: false,
      deleteOutputFile: async () => {},
      flush: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    },
  } as unknown as ShellCommand
}

describe('checkForAsyncHookResponses payload includes command (#070)', () => {
  afterEach(() => {
    clearAllAsyncHooks()
  })

  test('delivers the registered command string in the response payload', async () => {
    // Arrange — official `_kt` payload gained `command:e.command` in v295
    registerPendingAsyncHook({
      processId: 'session_start_1',
      hookId: 'hook-session_start_1',
      asyncResponse: { async: true, asyncTimeout: 5000 },
      hookName: 'startup-hook',
      hookEvent: 'SessionStart',
      command: './startup.sh',
      shellCommand: createMockShellCommand({
        stdout: '{"systemMessage":"context v1"}',
      }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses.length).toBe(1)
    expect(responses[0]?.command).toBe('./startup.sh')
    expect(responses[0]?.hookEvent).toBe('SessionStart')
    expect(responses[0]?.response).toEqual({ systemMessage: 'context v1' })
  })
})
