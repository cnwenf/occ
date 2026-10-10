import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ShellCommand } from '../../ShellCommand.js'

/**
 * CC 2.1.295 (#078): "Fixed an async hook's JSON output being ignored when
 * it is printed over several lines."
 *
 * v294 scanned async-hook stdout line by line (`Found JSON line` log
 * @213046724) and tried JSON.parse on single lines only — a pretty-printed
 * multi-line JSON object never parsed and the answer was silently dropped.
 * v295 removed the line-scan (the `Found JSON line` string is gone from the
 * binary) and replaced it with `fkt`: candidate list = [whole stdout (minus
 * a leading `{"async":true}` line), ...each trimmed line], first candidate
 * parsing to a non-async JSON object wins; `pkt` drives the new guidance
 * error when a `{`-line exists but nothing could be read.
 */

// Mock hookEvents to avoid timer/emit side effects during tests.
mock.module('../../hooks/hookEvents.js', () => ({
  startHookProgressInterval: () => () => {},
  emitHookResponse: () => {},
}))

const {
  parseHookJsonObject,
  isAsyncMarkerOutput,
  extractAsyncHookSyncResponse,
  hasUnreadableAsyncHookJsonAnswer,
} = await import('../../hooks/asyncHookJson.js')

const {
  registerPendingAsyncHook,
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
} = await import('../../hooks/AsyncHookRegistry.js')

// ---------------------------------------------------------------------------
// Official `QIe` — parseHookJsonObject
// ---------------------------------------------------------------------------
describe('parseHookJsonObject (official QIe)', () => {
  test('returns the object for a single-line JSON object string', () => {
    // Arrange
    const text = '{"decision":"block","reason":"nope"}'

    // Act
    const parsed = parseHookJsonObject(text)

    // Assert
    expect(parsed).toEqual({ decision: 'block', reason: 'nope' })
  })

  test('returns the object for a multi-line pretty-printed JSON object', () => {
    // Arrange
    const text = '{\n  "decision": "approve"\n}'

    // Act
    const parsed = parseHookJsonObject(text)

    // Assert
    expect(parsed).toEqual({ decision: 'approve' })
  })

  test('returns undefined for text not starting with a brace', () => {
    // Arrange / Act / Assert
    expect(parseHookJsonObject('  {"a":1}')).toBeUndefined()
    expect(parseHookJsonObject('hello')).toBeUndefined()
    expect(parseHookJsonObject('[{"a":1}]')).toBeUndefined()
  })

  test('returns undefined for malformed JSON', () => {
    // Arrange / Act / Assert — the try/catch in QIe swallows the parse error
    expect(parseHookJsonObject('{"a":1')).toBeUndefined()
    expect(parseHookJsonObject('{not valid json')).toBeUndefined()
    expect(parseHookJsonObject('{')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Official `ukt` — isAsyncMarkerOutput
// ---------------------------------------------------------------------------
describe('isAsyncMarkerOutput (official ukt)', () => {
  test('is true for a JSON object carrying an "async" key', () => {
    // Arrange / Act / Assert
    expect(isAsyncMarkerOutput('{"async":true}')).toBe(true)
    expect(isAsyncMarkerOutput('{"async":true,"asyncTimeout":5000}')).toBe(true)
  })

  test('is false for an object without "async", non-objects and bad JSON', () => {
    // Arrange / Act / Assert
    expect(isAsyncMarkerOutput('{"decision":"block"}')).toBe(false)
    expect(isAsyncMarkerOutput('{}')).toBe(false)
    expect(isAsyncMarkerOutput('not json')).toBe(false)
    expect(isAsyncMarkerOutput('{broken')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Official `fkt` — extractAsyncHookSyncResponse (THE #078 fix)
// ---------------------------------------------------------------------------
describe('extractAsyncHookSyncResponse (official fkt — 2.1.295 multi-line fix)', () => {
  test('extracts a pretty-printed multi-line JSON answer (the 2.1.295 fix)', () => {
    // Arrange — v294's per-line parse returned undefined for this input
    const stdout = '{\n  "decision": "block",\n  "reason": "denied by policy"\n}'

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toEqual({
      decision: 'block',
      reason: 'denied by policy',
    })
  })

  test('extracts multi-line JSON with hookSpecificOutput spanning lines', () => {
    // Arrange
    const stdout = [
      '{',
      '  "hookSpecificOutput": {',
      '    "hookEventName": "PostToolUse",',
      '    "additionalContext": "context from async hook"',
      '  },',
      '  "systemMessage": "done"',
      '}',
    ].join('\n')

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'context from async hook',
      },
      systemMessage: 'done',
    })
  })

  test('skips a leading {"async":true} line and extracts the multi-line answer after it', () => {
    // Arrange — official: first line parses with "async" → candidate joins
    // lines.slice(1)
    const stdout = '{"async":true}\n{\n  "systemMessage": "later"\n}'

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toEqual({ systemMessage: 'later' })
  })

  test('still extracts a single-line JSON answer (v294 behavior preserved)', () => {
    // Arrange / Act / Assert
    expect(extractAsyncHookSyncResponse('{"decision":"approve"}')).toEqual({
      decision: 'approve',
    })
  })

  test('falls back to per-line candidates for a single-line answer after noise', () => {
    // Arrange — whole-stdout candidate fails; the per-line fallback finds it
    const stdout = 'Running checks...\n{"decision":"approve"}\nDone.'

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toEqual({ decision: 'approve' })
  })

  test('returns undefined when only an async-marker line was printed', () => {
    // Arrange / Act / Assert
    expect(extractAsyncHookSyncResponse('{"async":true}')).toBeUndefined()
    expect(
      extractAsyncHookSyncResponse('{"async":true,"asyncTimeout":1000}'),
    ).toBeUndefined()
  })

  test('returns undefined for plain non-JSON stdout', () => {
    // Arrange / Act / Assert
    expect(extractAsyncHookSyncResponse('all good\nnothing to report')).toBeUndefined()
    expect(extractAsyncHookSyncResponse('')).toBeUndefined()
  })

  test('does NOT recognize multi-line JSON preceded by other output (official contract)', () => {
    // Arrange — whole-stdout candidate fails to parse; no single line parses.
    // Official guidance error (pkt) covers this case instead.
    const stdout = 'Running checks...\n{\n  "decision": "block"\n}'

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toBeUndefined()
  })

  test('per-line fallback picks an object line inside a multi-line JSON array (official shape)', () => {
    // Arrange — whole-stdout candidate starts with '[' (rejected by QIe);
    // the per-line fallback finds the single-line object inside.
    const stdout = '[\n  {"decision":"block"}\n]'

    // Act
    const parsed = extractAsyncHookSyncResponse(stdout)

    // Assert
    expect(parsed).toEqual({ decision: 'block' })
  })
})

// ---------------------------------------------------------------------------
// Official `pkt` — hasUnreadableAsyncHookJsonAnswer (diagnostic predicate)
// ---------------------------------------------------------------------------
describe('hasUnreadableAsyncHookJsonAnswer (official pkt)', () => {
  test('is true when a line begins with { but nothing parseable was found', () => {
    // Arrange / Act / Assert
    expect(hasUnreadableAsyncHookJsonAnswer('{not valid json')).toBe(true)
    expect(
      hasUnreadableAsyncHookJsonAnswer('some output\n{broken answer'),
    ).toBe(true)
  })

  test('is true for a broken answer following the async-marker line', () => {
    // Arrange / Act / Assert
    expect(
      hasUnreadableAsyncHookJsonAnswer('{"async":true}\n{broken'),
    ).toBe(true)
  })

  test('is false when the whole stdout is just the async-marker object', () => {
    // Arrange / Act / Assert
    expect(hasUnreadableAsyncHookJsonAnswer('{"async":true}')).toBe(false)
  })

  test('is false for stdout with no brace-leading lines', () => {
    // Arrange / Act / Assert
    expect(hasUnreadableAsyncHookJsonAnswer('plain text output')).toBe(false)
    expect(hasUnreadableAsyncHookJsonAnswer('')).toBe(false)
  })

  test('is true for valid pretty JSON (only consulted when extraction failed — official shape)', () => {
    // Arrange — documents that pkt is a raw predicate: the registry only
    // calls it in the else branch after fkt returned undefined.
    const stdout = '{\n  "a": 1\n}'

    // Act / Assert
    expect(hasUnreadableAsyncHookJsonAnswer(stdout)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration — checkForAsyncHookResponses delivers multi-line JSON answers
// ---------------------------------------------------------------------------
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

function registerCompletedHook(processId: string, stdout: string): void {
  registerPendingAsyncHook({
    processId,
    hookId: `hook-${processId}`,
    asyncResponse: { async: true, asyncTimeout: 5000 },
    hookName: 'multi-line-answer-hook',
    hookEvent: 'PostToolUse',
    command: './slow-hook.sh',
    shellCommand: createMockShellCommand({ stdout, status: 'completed' }),
  })
}

describe('checkForAsyncHookResponses multi-line JSON delivery (#078)', () => {
  afterEach(() => {
    clearAllAsyncHooks()
  })

  test('delivers a pretty-printed multi-line JSON answer as the response', async () => {
    // Arrange
    registerCompletedHook(
      'multiline_pretty',
      '{\n  "decision": "block",\n  "reason": "denied"\n}',
    )

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses.length).toBe(1)
    expect(responses[0]?.response).toEqual({
      decision: 'block',
      reason: 'denied',
    })
    expect(responses[0]?.exitCode).toBe(0)
  })

  test('delivers multi-line JSON printed after the {"async":true} announcement', async () => {
    // Arrange
    registerCompletedHook(
      'multiline_after_marker',
      '{"async":true}\n{\n  "systemMessage": "async finished"\n}',
    )

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses.length).toBe(1)
    expect(responses[0]?.response).toEqual({
      systemMessage: 'async finished',
    })
  })

  test('still delivers a single-line JSON answer (no regression)', async () => {
    // Arrange
    registerCompletedHook('single_line', '{"decision":"approve"}')

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses.length).toBe(1)
    expect(responses[0]?.response).toEqual({ decision: 'approve' })
  })

  test('delivers an empty response for non-JSON stdout without throwing', async () => {
    // Arrange
    registerCompletedHook('no_json', 'just some log output')

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert — stdout non-empty → response delivered with {} payload
    expect(responses.length).toBe(1)
    expect(responses[0]?.response).toEqual({})
  })

  test('delivers an empty response when a brace line cannot be read as JSON', async () => {
    // Arrange — pkt branch: guidance error is logged, response stays {}
    registerCompletedHook('broken_answer', 'working...\n{broken json answer')

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert
    expect(responses.length).toBe(1)
    expect(responses[0]?.response).toEqual({})
  })
})
