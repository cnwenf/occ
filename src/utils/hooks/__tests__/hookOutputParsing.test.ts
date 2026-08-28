import { describe, expect, test } from 'bun:test'
import {
  formatHookJsonValidationError,
  hookOutputSchemaHint,
  isAsyncHookAnnouncement,
  isMultipleJsonDocuments,
  looksLikeMissingHookScript,
  parseHookOutput,
  wrapHookErrorWithStderr,
} from '../../hooks'

/**
 * Gap-108a (official 2.1.248): hook output parsing + validation-error
 * reporting rewrite. Unit coverage for the binary-ported helpers:
 *
 *   parseHookOutput            — official `sIe` (malformed-JSON reporting)
 *   formatHookJsonValidationError — official `vwt` (issue formatting + hints)
 *   hookOutputSchemaHint       — official `Ewt` (schema hint text)
 *   wrapHookErrorWithStderr    — official `Mct` (stderr wrap)
 *   looksLikeMissingHookScript — official `i$t` (missing-script heuristic)
 *   isAsyncHookAnnouncement    — official `o$t`
 *   isMultipleJsonDocuments    — official `$$n`
 */

describe('parseHookOutput (official sIe port)', () => {
  test('treats output not starting with { as plain text', () => {
    // Arrange
    const stdout = 'hello world'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.plainText).toBe(stdout)
    expect(result.json).toBeUndefined()
    expect(result.validationError).toBeUndefined()
  })

  test('parses valid sync hook JSON', () => {
    // Arrange
    const stdout = '{"decision":"approve","reason":"ok"}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.json).toBeDefined()
    expect(result.plainText).toBeUndefined()
    expect(result.validationError).toBeUndefined()
  })

  test('strips unknown keys instead of erroring', () => {
    // Arrange
    const stdout = '{"foo":true}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.json).toBeDefined()
    expect(result.validationError).toBeUndefined()
  })

  test('honors a first-line async announcement with trailing garbage', () => {
    // Arrange
    const stdout = '{"async":true}\nnot json at all'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.json).toEqual({ async: true })
    expect(result.validationError).toBeUndefined()
  })

  test('reports an invalid-JSON object as a validation error with encoder advice', () => {
    // Arrange
    const stdout = '{"decision": bad json}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.plainText).toBe(stdout)
    expect(result.validationError).toContain(
      'Hook output looks like a JSON object but is not valid JSON —',
    )
    expect(result.validationError).toContain(
      'Emit the payload with a JSON encoder (jq, ConvertTo-Json, json.dumps)',
    )
  })

  test('treats an unclosed brace as plain text, not an error', () => {
    // Arrange
    const stdout = '{not closed'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.plainText).toBe(stdout)
    expect(result.validationError).toBeUndefined()
  })

  test('treats several empty JSON documents as plain text', () => {
    // Arrange
    const stdout = '{}\n{}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.plainText).toBe(stdout)
    expect(result.validationError).toBeUndefined()
  })

  test('reports several non-empty JSON documents as a validation error', () => {
    // Arrange
    const stdout = '{"decision":"approve"}\n{"foo":1}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.validationError).toContain(
      'Hook output looks like a JSON object but is not valid JSON —',
    )
  })

  test('valid JSON failing the schema gets the vwt-format error plus schema hint', () => {
    // Arrange
    const stdout = '{"decision":"allow"}'

    // Act
    const result = parseHookOutput(stdout)

    // Assert
    expect(result.plainText).toBe(stdout)
    expect(result.validationError).toContain(
      'Hook JSON output validation failed — ',
    )
    expect(result.validationError).toContain('Expected schema:')
    expect(result.validationError).toContain("The hook's output was:")
  })
})

describe('hookOutputSchemaHint (official Ewt port)', () => {
  test('includes the 2.1.248 sections', () => {
    // Arrange / Act
    const hint = hookOutputSchemaHint()

    // Assert
    expect(hint).toContain('terminalSequence')
    expect(hint).toContain('"for PermissionRequest"')
    expect(hint).toContain('"for PostToolBatch"')
  })

  test('has no top-level permissionDecision and no sessionTitle', () => {
    // Arrange / Act
    const hint = hookOutputSchemaHint()

    // Assert
    expect(hint).not.toContain('sessionTitle')
    // top-level key from the pre-2.1.248 hint (3-value enum, no defer)
    expect(hint).not.toContain(
      `"permissionDecision": '"allow" | "deny" | "ask" (optional)'`,
    )
  })

  test('UserPromptSubmit additionalContext is optional', () => {
    // Arrange / Act
    const hint = hookOutputSchemaHint()

    // Assert
    expect(hint).not.toContain('"additionalContext": "string (required)"')
  })
})

describe('formatHookJsonValidationError (official vwt port)', () => {
  test('formats a top-level enum failure with the issue path', () => {
    // Arrange
    const result = parseHookOutput('{"decision":"allow"}')

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain(
      'decision: Invalid option: expected one of "approve"|"block"',
    )
  })

  test('annotates legacy top-level decision allow/deny', () => {
    // Arrange
    const result = parseHookOutput('{"decision":"allow"}')

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain(
      '(top-level decision is the legacy approve|block field; for "allow" use hookSpecificOutput.permissionDecision in a PreToolUse hook, or hookSpecificOutput.decision: {"behavior": "allow"} in a PermissionRequest hook)',
    )
  })

  test('annotates legacy top-level decision ask with the PreToolUse-only hint', () => {
    // Arrange
    const result = parseHookOutput('{"decision":"ask"}')

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain(
      'for "ask" use hookSpecificOutput.permissionDecision in a PreToolUse hook',
    )
    expect(error).not.toContain('in a PermissionRequest hook')
  })

  test('replaces the primary issue when hookSpecificOutput lacks hookEventName', () => {
    // Arrange
    const result = parseHookOutput('{"hookSpecificOutput":{"additionalContext":"x"}}')

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain(
      'hookSpecificOutput is missing required field "hookEventName"',
    )
  })

  test('appends the PermissionRequest decision shape hint', () => {
    // Arrange
    const result = parseHookOutput(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":"allow"}}',
    )

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain('hookSpecificOutput.decision: expected object, received string')
    expect(error).toContain(
      '(PermissionRequest decision must be {"behavior": "allow"} or {"behavior": "deny", "message": "..."})',
    )
  })

  test('aggregates discriminator values into an expected-one-of preview with ellipsis', () => {
    // Arrange
    const result = parseHookOutput('{"hookSpecificOutput":{"hookEventName":"Bogus"}}')

    // Act
    const error = result.validationError ?? ''

    // Assert
    expect(error).toContain('hookSpecificOutput.hookEventName: expected one of')
    expect(error).toContain('"PreToolUse" | "UserPromptSubmit" | "SessionStart"')
    expect(error).toContain(' | …')
  })

  test('lists remaining issues under the primary one', () => {
    // The hook schema is a union, so real failures surface as ONE top-level
    // invalid_union issue; the rest-list only fills when several top-level
    // issues exist. Cover the formatter directly with synthetic issues.
    // Arrange
    const issues = [
      {
        code: 'invalid_type',
        path: ['continue'],
        message: 'expected boolean, received string',
      },
      {
        code: 'invalid_type',
        path: ['suppressOutput'],
        message: 'expected boolean, received number',
      },
    ]

    // Act
    const error = formatHookJsonValidationError({}, issues)

    // Assert
    expect(error).toContain('continue: expected boolean, received string')
    expect(error).toContain(
      '\n  - suppressOutput: expected boolean, received number',
    )
  })

  test('returns unknown error for an empty issue list', () => {
    // Arrange / Act
    const error = formatHookJsonValidationError({}, [])

    // Assert
    expect(error).toContain(
      'Hook JSON output validation failed — unknown error',
    )
  })
})

describe('wrapHookErrorWithStderr (official Mct port)', () => {
  test('appends exit code and stderr on non-zero exit', () => {
    // Arrange / Act
    const wrapped = wrapHookErrorWithStderr('validation failed', 1, 'boom')

    // Assert
    expect(wrapped).toBe(
      'validation failed\n\nHook exited 1 with stderr:\nboom',
    )
  })

  test('leaves the error unchanged on exit code 0', () => {
    // Arrange / Act
    const wrapped = wrapHookErrorWithStderr('validation failed', 0, 'boom')

    // Assert
    expect(wrapped).toBe('validation failed')
  })

  test('leaves the error unchanged when stderr is blank', () => {
    // Arrange / Act
    const wrapped = wrapHookErrorWithStderr('validation failed', 3, '   ')

    // Assert
    expect(wrapped).toBe('validation failed')
  })
})

describe('looksLikeMissingHookScript (official i$t port)', () => {
  test('detects a missing script on Stop with no-such-file stderr', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'Stop',
      stdout: '',
      stderr: 'bash: /path/to/hook.sh: No such file or directory',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('covers every allowlisted event', () => {
    for (const hookEvent of [
      'Stop',
      'SubagentStop',
      'TaskCompleted',
      'TeammateIdle',
    ] as const) {
      // Arrange / Act
      const result = looksLikeMissingHookScript({
        hookEvent,
        stdout: '',
        stderr: "sh: can't open /x.sh",
      })

      // Assert
      expect(result).toBe(true)
    }
  })

  test('rejects events outside the allowlist without a plugin', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'PreToolUse',
      stdout: '',
      stderr: 'No such file or directory',
    })

    // Assert
    expect(result).toBe(false)
  })

  test('accepts plugin-owned UserPromptSubmit with can\'t-open stderr', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'UserPromptSubmit',
      stdout: '',
      stderr: "sh: can't open /plugins/x/hook.sh",
      pluginId: 'my-plugin',
    })

    // Assert
    expect(result).toBe(true)
  })

  test('rejects non-plugin UserPromptSubmit', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'UserPromptSubmit',
      stdout: '',
      stderr: 'No such file or directory',
    })

    // Assert
    expect(result).toBe(false)
  })

  test('requires empty stdout', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'Stop',
      stdout: 'some output',
      stderr: 'No such file or directory',
    })

    // Assert
    expect(result).toBe(false)
  })

  test('requires the missing-file stderr signature', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'Stop',
      stdout: '',
      stderr: 'permission denied',
    })

    // Assert
    expect(result).toBe(false)
  })

  test('matches case-insensitively', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      hookEvent: 'Stop',
      stdout: '',
      stderr: 'NO SUCH FILE OR DIRECTORY',
    })

    // Assert
    expect(result).toBe(true)
  })
})

describe('isAsyncHookAnnouncement (official o$t port)', () => {
  test('accepts a bare async announcement', () => {
    expect(isAsyncHookAnnouncement('{"async":true}')).toBe(true)
  })

  test('accepts async with timeout and trailing output', () => {
    expect(
      isAsyncHookAnnouncement('{"async":true,"asyncTimeout":5000}\nrest'),
    ).toBe(true)
  })

  test('rejects async: false', () => {
    expect(isAsyncHookAnnouncement('{"async":false}')).toBe(false)
  })

  test('rejects non-JSON first lines', () => {
    expect(isAsyncHookAnnouncement('not json')).toBe(false)
  })

  test('rejects malformed first-line JSON', () => {
    expect(isAsyncHookAnnouncement('{invalid')).toBe(false)
  })

  test('only inspects the first line', () => {
    expect(
      isAsyncHookAnnouncement('{"decision":"approve"}\n{"async":true}'),
    ).toBe(false)
  })
})

describe('isMultipleJsonDocuments (official $$n port)', () => {
  test('accepts several empty-object documents', () => {
    expect(isMultipleJsonDocuments('{}\n{}')).toBe(true)
  })

  test('filters blank lines', () => {
    expect(isMultipleJsonDocuments('{}\n\n{}')).toBe(true)
  })

  test('rejects a single document', () => {
    expect(isMultipleJsonDocuments('{}')).toBe(false)
  })

  test('rejects documents with real payload keys', () => {
    expect(isMultipleJsonDocuments('{"decision":"approve"}\n{"foo":1}')).toBe(
      false,
    )
  })

  test('rejects unparseable lines', () => {
    expect(isMultipleJsonDocuments('not json\nalso not')).toBe(false)
  })
})
