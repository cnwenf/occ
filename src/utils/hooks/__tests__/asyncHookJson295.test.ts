/**
 * CC 2.1.295 — async hook JSON answer reading (official fkt/mkt/dse/Xyo
 * pipeline ported into AsyncHookRegistry).
 *
 * Headline fix: a JSON answer printed over SEVERAL LINES (pretty-printed)
 * was previously ignored — the old reader only jsonParse'd whole lines that
 * started with `{`. The official reader scans the whole stdout buffer for
 * the first balanced JSON object that is not the `{"async":true}` marker.
 *
 * Evidence: official 2.1.295 linux-x64 ELF — kkt/_kt/fkt/mkt/dse/YV/QIe/
 * ukt/Xyo (see the RECONSTRUCTION NOTE in AsyncHookRegistry.ts: fkt's body
 * is corrupted in the strings dump, so the extractor is a documented
 * balanced-brace reconstruction).
 */

import { describe, expect, mock, test } from 'bun:test'
import type { ShellCommand } from '../../ShellCommand.js'

// Mock hookEvents to avoid timer side effects during tests.
mock.module('../../hooks/hookEvents.js', () => ({
  startHookProgressInterval: () => () => {},
  emitHookResponse: () => {},
}))

// Capture logForDebugging calls so the official message texts can be
// asserted verbatim. Spread the real module so other exports survive.
type CapturedLog = { message: string; level: string }
const logs: CapturedLog[] = []
const actualDebug = await import('../../debug.js')
mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    logs.push({ message, level: opts?.level ?? 'debug' })
  },
}))

const {
  registerPendingAsyncHook,
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
  extractFirstJsonObject,
  hasUnreadableJsonAnswerLine,
  validateAsyncHookJsonResponse,
} = await import('../../hooks/AsyncHookRegistry.js')

function createMockShellCommand(opts: {
  status?: 'running' | 'backgrounded' | 'completed' | 'killed'
  stdout?: string
  stderr?: string
  code?: number
}): ShellCommand {
  const stdout = opts.stdout ?? ''
  const stderr = opts.stderr ?? ''
  return {
    status: opts.status ?? 'completed',
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
      getStderr: () => stderr,
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

function registerHook(opts: {
  processId: string
  shellCommand: ShellCommand
  hookEvent?: 'PreToolUse' | 'SessionStart'
}): void {
  registerPendingAsyncHook({
    processId: opts.processId,
    hookId: `hook-${opts.processId}`,
    asyncResponse: { async: true, asyncTimeout: 5000 },
    hookName: 'TestHook',
    hookEvent: opts.hookEvent ?? 'PreToolUse',
    command: 'echo hi',
    shellCommand: opts.shellCommand,
  })
}

function lastLogContaining(fragment: string): CapturedLog | undefined {
  return logs.findLast(log => log.message.includes(fragment))
}

// ---------------------------------------------------------------------------
// extractFirstJsonObject (official fkt — reconstructed whole-buffer scan)
// ---------------------------------------------------------------------------

describe('extractFirstJsonObject (official fkt reconstruction)', () => {
  test('extracts a single-line JSON object', () => {
    // Act
    const extracted = extractFirstJsonObject('{"systemMessage":"hi"}')

    // Assert
    expect(extracted).toEqual({ systemMessage: 'hi' })
  })

  test('extracts a multi-line pretty-printed JSON object (headline fix)', () => {
    // Arrange — previously ignored: no single line parses as JSON.
    const stdout = 'Running checks...\n{\n  "systemMessage": "hello",\n  "continue": true\n}\nAll done.'

    // Act
    const extracted = extractFirstJsonObject(stdout)

    // Assert
    expect(extracted).toEqual({ systemMessage: 'hello', continue: true })
  })

  test('skips the {"async":true} marker and returns the first sync object', () => {
    // Arrange
    const stdout = '{"async":true}\n{\n  "decision": "block"\n}'

    // Act & Assert
    expect(extractFirstJsonObject(stdout)).toEqual({ decision: 'block' })
  })

  test('returns the async marker itself when it is the only JSON object', () => {
    // Arrange & Act
    const extracted = extractFirstJsonObject('{"async": true}\n')

    // Assert — marker fallback feeds the official mkt salvage path
    expect(extracted).toEqual({ async: true })
  })

  test('ignores braces inside JSON strings', () => {
    // Arrange
    const stdout = '{"systemMessage":"a } b { c"}'

    // Act & Assert
    expect(extractFirstJsonObject(stdout)).toEqual({
      systemMessage: 'a } b { c',
    })
  })

  test('handles escaped quotes inside strings', () => {
    // Arrange
    const stdout = '{"systemMessage":"say \\"hi\\" }"}'

    // Act & Assert
    expect(extractFirstJsonObject(stdout)).toEqual({
      systemMessage: 'say "hi" }',
    })
  })

  test('skips an unparseable balanced candidate and finds the later valid object', () => {
    // Arrange — "{not: json,}" is balanced but not valid JSON.
    const stdout = '{not: json,}\n{"systemMessage":"ok"}'

    // Act & Assert
    expect(extractFirstJsonObject(stdout)).toEqual({ systemMessage: 'ok' })
  })

  test('returns undefined when stdout contains no JSON object', () => {
    expect(extractFirstJsonObject('plain text output\n')).toBeUndefined()
    expect(extractFirstJsonObject('')).toBeUndefined()
    // Unclosed brace never completes a candidate.
    expect(extractFirstJsonObject('{broken json\n')).toBeUndefined()
  })

  test('returns a nested object whole (outermost balanced candidate)', () => {
    // Arrange
    const stdout = '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'

    // Act & Assert
    expect(extractFirstJsonObject(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    })
  })
})

// ---------------------------------------------------------------------------
// hasUnreadableJsonAnswerLine (official Xyo/pkt)
// ---------------------------------------------------------------------------

describe('hasUnreadableJsonAnswerLine (official Xyo)', () => {
  test('is true when a line begins with { but is not a readable marker', () => {
    expect(hasUnreadableJsonAnswerLine('text\n{broken json\n')).toBe(true)
  })

  test('is false when the only {-lines are async markers', () => {
    expect(hasUnreadableJsonAnswerLine('{"async":true}\nsome text')).toBe(false)
  })

  test('is false when no line begins with {', () => {
    expect(hasUnreadableJsonAnswerLine('all plain text\n')).toBe(false)
  })

  test('strips a leading BOM before checking (official \\uFEFF replace)', () => {
    // Arrange — BOM would otherwise make the marker line unreadable.
    const stdout = '\uFEFF{"async":true}\n'

    // Act & Assert
    expect(hasUnreadableJsonAnswerLine(stdout)).toBe(false)
  })

  test('trims leading whitespace per line', () => {
    expect(hasUnreadableJsonAnswerLine('   {"async":true}')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateAsyncHookJsonResponse (official mkt + dse)
// ---------------------------------------------------------------------------

describe('validateAsyncHookJsonResponse (official mkt)', () => {
  test('passes a valid sync response through unchanged', () => {
    // Act
    const validated = validateAsyncHookJsonResponse(
      { systemMessage: 'hi' },
      'TestHook',
    )

    // Assert
    expect(validated).toEqual({ systemMessage: 'hi' })
  })

  test('returns {} with the official error message for a non-object answer', () => {
    // Act
    const validated = validateAsyncHookJsonResponse('a string' as never, 'TestHook')

    // Assert — official: `${n} async hook JSON output must be an object, got ${YV(e)} — ignored`
    expect(validated).toEqual({})
    expect(
      lastLogContaining(
        'TestHook async hook JSON output must be an object, got a string — ignored',
      )?.level,
    ).toBe('error')
  })

  test('salvages an async-marker answer to {} with the official debug message', () => {
    // Act
    const validated = validateAsyncHookJsonResponse({ async: true }, 'TestHook')

    // Assert — official marker-fallback text, debug level (no malformed fields)
    expect(validated).toEqual({})
    const log = lastLogContaining(
      'TestHook async hook JSON output failed schema validation (async-marker response where a sync response was expected); delivering recognized fields as-is',
    )
    expect(log?.level).toBe('debug')
  })

  test('salvages recognized fields and reports malformed ones with the official error message', () => {
    // Arrange — systemMessage wrong type, metrics partially valid,
    // hookSpecificOutput wrong type.
    const parsed = {
      systemMessage: 42,
      metrics: { tokens: 10, note: 'x', ok: true },
      hookSpecificOutput: 'nope',
    }

    // Act
    const validated = validateAsyncHookJsonResponse(parsed, 'TestHook')

    // Assert — metrics survives filtered to boolean|number entries
    expect(validated).toEqual({ metrics: { tokens: 10, ok: true } })
    const log = lastLogContaining(
      'TestHook async hook JSON output failed schema validation',
    )
    expect(log?.level).toBe('error')
    expect(log?.message).toContain(
      'ignored malformed field(s): systemMessage (a number), hookSpecificOutput (a string)',
    )
  })

  test('drops a non-string additionalContext from salvaged hookSpecificOutput', () => {
    // Arrange
    const parsed = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 42,
      },
    }

    // Act
    const validated = validateAsyncHookJsonResponse(parsed, 'TestHook')

    // Assert — rest kept, additionalContext dropped + reported
    expect(validated).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    })
    expect(
      lastLogContaining(
        'hookSpecificOutput.additionalContext (a number)',
      )?.level,
    ).toBe('error')
  })

  test('warns about unrecognized keys stripped by validation (official dse)', () => {
    // Act
    const validated = validateAsyncHookJsonResponse(
      { systemMessage: 'hi', bogus: 1 },
      'TestHook',
    )

    // Assert — recognized fields delivered, unknown key warned (debug default)
    expect(validated).toEqual({ systemMessage: 'hi' })
    const log = lastLogContaining(
      'Hook JSON output had unrecognized keys (ignored): bogus.',
    )
    expect(log).toBeDefined()
  })

  test('adds the additionalContext hint for a misplaced top-level key (official dse)', () => {
    // Act
    validateAsyncHookJsonResponse(
      { systemMessage: 'x', additionalContext: 'y' },
      'TestHook',
    )

    // Assert
    expect(
      lastLogContaining(
        'Hook JSON output had unrecognized keys (ignored): additionalContext. Did you mean hookSpecificOutput.additionalContext (with a hookEventName)?',
      ),
    ).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// checkForAsyncHookResponses integration (official _kt/kkt flow)
// ---------------------------------------------------------------------------

describe('checkForAsyncHookResponses — CC 2.1.295 JSON answer flow', () => {
  test('delivers a multi-line pretty-printed JSON answer with command and exitCode', async () => {
    // Arrange
    clearAllAsyncHooks()
    logs.length = 0
    registerHook({
      processId: 'multiline_json',
      shellCommand: createMockShellCommand({
        stdout: 'Starting...\n{\n  "systemMessage": "hello world"\n}\nFinished.',
      }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses).toHaveLength(1)
    expect(responses[0]?.response).toEqual({ systemMessage: 'hello world' })
    expect(responses[0]?.command).toBe('echo hi')
    expect(responses[0]?.exitCode).toBe(0)
    expect(responses[0]?.processId).toBe('multiline_json')
    expect(
      lastLogContaining('Hooks: Found sync response from multiline_json:'),
    ).toBeDefined()
  })

  test('keeps first-line {"async":true} detection working and reads the answer after it', async () => {
    // Arrange
    clearAllAsyncHooks()
    registerHook({
      processId: 'marker_then_answer',
      shellCommand: createMockShellCommand({
        stdout: '{"async":true}\n{"decision":"approve"}',
      }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses).toHaveLength(1)
    expect(responses[0]?.response).toEqual({ decision: 'approve' })
  })

  test('skips the attachment for a marker-only answer (empty payload, exit 0, empty stderr) and removes the hook', async () => {
    // Arrange
    clearAllAsyncHooks()
    logs.length = 0
    registerHook({
      processId: 'marker_only',
      shellCommand: createMockShellCommand({ stdout: '{"async":true}\n' }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert — official _kt: empty response + exit 0 + empty stderr → null
    expect(responses).toHaveLength(0)
    expect(
      lastLogContaining(
        'Hooks: marker_only (TestHook) produced no response payload — skipping attachment',
      ),
    ).toBeDefined()
    // Hook removed from the registry.
    const second = await checkForAsyncHookResponses()
    expect(second).toHaveLength(0)
  })

  test('logs the official error for a stdout line that begins with { but cannot be read', async () => {
    // Arrange
    clearAllAsyncHooks()
    logs.length = 0
    registerHook({
      processId: 'unreadable',
      shellCommand: createMockShellCommand({ stdout: '{broken json\n' }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert — official pkt/Xyo error text, verbatim
    expect(responses).toHaveLength(0)
    const log = lastLogContaining(
      'Hooks: async hook unreadable (TestHook) printed a stdout line that begins with { but no JSON answer could be read. After any {"async":true} line, print one JSON object and nothing else, or put the object on one line.',
    )
    expect(log?.level).toBe('error')
  })

  test('delivers the payload for a non-zero exit even when the salvaged response is empty', async () => {
    // Arrange — exit 1 means the failure must surface even with no JSON.
    clearAllAsyncHooks()
    registerHook({
      processId: 'failed_exit',
      shellCommand: createMockShellCommand({
        stdout: '',
        stderr: 'boom',
        code: 1,
      }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses).toHaveLength(1)
    expect(responses[0]?.response).toEqual({})
    expect(responses[0]?.exitCode).toBe(1)
    expect(responses[0]?.stderr).toBe('boom')
  })

  test('delivers the payload for exit 0 with empty response but non-empty stderr', async () => {
    // Arrange — official skip requires empty response AND exit 0 AND empty stderr.
    clearAllAsyncHooks()
    registerHook({
      processId: 'stderr_only',
      shellCommand: createMockShellCommand({
        stdout: '',
        stderr: 'warning: something',
        code: 0,
      }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses).toHaveLength(1)
    expect(responses[0]?.stderr).toBe('warning: something')
  })

  test('removes a SessionStart hook with an empty payload from the registry (isSessionStart remove path)', async () => {
    // Arrange
    clearAllAsyncHooks()
    registerHook({
      processId: 'session_start_empty',
      hookEvent: 'SessionStart',
      shellCommand: createMockShellCommand({ stdout: '' }),
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert — no attachment, but the hook is gone from the registry.
    expect(responses).toHaveLength(0)
    const second = await checkForAsyncHookResponses()
    expect(second).toHaveLength(0)
    expect(
      lastLogContaining(
        'Invalidating session env cache after SessionStart hook completed',
      ),
    ).toBeDefined()
  })
})
