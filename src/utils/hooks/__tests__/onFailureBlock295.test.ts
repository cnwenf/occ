/**
 * CC 2.1.295 (#001): `onFailure: "block"` for command and HTTP hooks.
 *
 * Covers the schema field (official `ni` @208157433), the predicate set
 * (`jIe`/`W_t`/`fXn`/`G_t`/`Zre`/`z_t`+`jEt`/`q_t`/`lM`), the REPL
 * transform (`K_t` @215473113), and the outside-REPL transform (`V_t`
 * @215473943) — all ported verbatim from /tmp/cc-153/v295/package/claude.
 */
import { describe, expect, test } from 'bun:test'
import type { HookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'
import type { HookResultMessage } from 'src/types/message.js'
import { HookCommandSchema } from '../../../schemas/hooks.js'
import {
  applyOnFailureBlockOutsideRepl,
  applyOnFailureBlockTransform,
  getHookFailureBlockSource,
  getOnFailureHookLabel,
  hookJsonOutputAlreadyBlocks,
  hookMustSucceed,
  isOnFailureBlockHook,
  ON_FAILURE_IGNORED_EVENTS,
  onFailureBlockReason,
  shouldBlockOnHookFailure,
  type OnFailureHookShape,
  type OnFailureTransformableResult,
} from '../onFailureBlock.js'

const commandHook = (
  overrides: Partial<OnFailureHookShape> = {},
): OnFailureHookShape => ({
  type: 'command',
  command: './check.sh',
  ...overrides,
})

const httpHook = (
  overrides: Partial<OnFailureHookShape> = {},
): OnFailureHookShape => ({
  type: 'http',
  url: 'https://example.com/hook',
  ...overrides,
})

function nonBlockingErrorResult(
  hook: OnFailureHookShape,
  stderr: string,
): OnFailureTransformableResult {
  return {
    message: {
      type: 'attachment',
      attachment: {
        type: 'hook_non_blocking_error',
        stderr,
      },
    } as unknown as HookResultMessage,
    outcome: 'non_blocking_error',
    hook,
  }
}

describe('HookCommandSchema onFailure field (2.1.295 #001)', () => {
  test('accepts onFailure block and continue on command hooks', () => {
    // Arrange
    const schema = HookCommandSchema()

    // Act
    const block = schema.parse({
      type: 'command',
      command: './check.sh',
      onFailure: 'block',
    })
    const cont = schema.parse({
      type: 'command',
      command: './check.sh',
      onFailure: 'continue',
    })

    // Assert
    expect(block).toMatchObject({ type: 'command', onFailure: 'block' })
    expect(cont).toMatchObject({ type: 'command', onFailure: 'continue' })
  })

  test('accepts onFailure block on http hooks', () => {
    // Arrange
    const schema = HookCommandSchema()

    // Act
    const parsed = schema.parse({
      type: 'http',
      url: 'https://example.com/hook',
      onFailure: 'block',
    })

    // Assert
    expect(parsed).toMatchObject({ type: 'http', onFailure: 'block' })
  })

  test('rejects an invalid onFailure value on command hooks', () => {
    // Arrange
    const schema = HookCommandSchema()

    // Act
    const result = schema.safeParse({
      type: 'command',
      command: './check.sh',
      onFailure: 'deny',
    })

    // Assert
    expect(result.success).toBe(false)
  })

  test('omits onFailure from the parsed prompt hook (official: no onFailure on prompt/agent/mcp_tool)', () => {
    // Arrange
    const schema = HookCommandSchema()

    // Act
    const parsed = schema.parse({
      type: 'prompt',
      prompt: 'verify things',
      onFailure: 'block',
    })

    // Assert — zod strips the unknown key; prompt hooks never carry onFailure
    expect(parsed).toMatchObject({ type: 'prompt' })
    expect('onFailure' in parsed).toBe(false)
  })

  test('describe text matches the official ni schema verbatim', () => {
    // Arrange
    const schema = HookCommandSchema()

    // Act — pull the command variant's onFailure description
    const options = (
      schema as unknown as {
        options: Array<{
          shape?: Record<string, { description?: string }>
        }>
      }
    ).options
    const commandShape = options.find(o => o.shape && 'command' in o.shape)
      ?.shape as Record<string, { description?: string }> | undefined
    const description = commandShape?.onFailure?.description

    // Assert
    expect(description).toBe(
      "What a failure of this hook does: it could not start (a missing script or plugin directory), timed out, exited with a code other than 0 or 2, or printed JSON that is invalid or fails validation. 'continue' (default): the failure is reported and the action goes ahead. 'block': the failure counts as exit code 2, so the action the event guards (a tool call, a permission request, a prompt) is blocked. Ignored for async hooks and on Stop, SubagentStop, TaskCompleted and TeammateIdle.",
    )
  })
})

describe('isOnFailureBlockHook (official jIe)', () => {
  test('returns true for a command hook with onFailure block', () => {
    expect(isOnFailureBlockHook(commandHook({ onFailure: 'block' }))).toBe(true)
  })

  test('returns false for an async command hook with onFailure block (ignored for async hooks)', () => {
    expect(
      isOnFailureBlockHook(commandHook({ onFailure: 'block', async: true })),
    ).toBe(false)
  })

  test('returns false for an asyncRewake command hook with onFailure block', () => {
    expect(
      isOnFailureBlockHook(
        commandHook({ onFailure: 'block', asyncRewake: true }),
      ),
    ).toBe(false)
  })

  test('returns false for a command hook with onFailure continue or unset', () => {
    expect(isOnFailureBlockHook(commandHook({ onFailure: 'continue' }))).toBe(
      false,
    )
    expect(isOnFailureBlockHook(commandHook())).toBe(false)
  })

  test('returns true for an http hook with onFailure block (no async exclusion)', () => {
    expect(isOnFailureBlockHook(httpHook({ onFailure: 'block' }))).toBe(true)
  })

  test('returns false for prompt/agent/mcp_tool/callback/function hook types', () => {
    for (const type of ['prompt', 'agent', 'mcp_tool', 'callback', 'function']) {
      expect(isOnFailureBlockHook({ type, onFailure: 'block' })).toBe(false)
    }
  })
})

describe('shouldBlockOnHookFailure (official Zre) and ignored events (G_t)', () => {
  test('ignores onFailure block on Stop, SubagentStop, TaskCompleted, TeammateIdle', () => {
    // Assert
    expect([...ON_FAILURE_IGNORED_EVENTS].sort()).toEqual(
      ['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle'].sort(),
    )
    for (const event of ON_FAILURE_IGNORED_EVENTS) {
      expect(
        shouldBlockOnHookFailure(commandHook({ onFailure: 'block' }), event),
      ).toBe(false)
    }
  })

  test('blocks on failure for PreToolUse / UserPromptSubmit / PostToolUse', () => {
    for (const event of ['PreToolUse', 'UserPromptSubmit', 'PostToolUse'] as const) {
      expect(
        shouldBlockOnHookFailure(commandHook({ onFailure: 'block' }), event),
      ).toBe(true)
    }
  })

  test('returns false when onFailure is not block', () => {
    expect(shouldBlockOnHookFailure(commandHook(), 'PreToolUse')).toBe(false)
  })
})

describe('getHookFailureBlockSource (official W_t) and onFailureBlockReason (fXn)', () => {
  test('returns setting for an onFailure block hook', () => {
    expect(
      getHookFailureBlockSource(
        commandHook({ onFailure: 'block' }),
        'PreToolUse',
      ),
    ).toBe('setting')
  })

  test('returns undefined for a hook whose failures do not block', () => {
    expect(getHookFailureBlockSource(commandHook(), 'PreToolUse')).toBeUndefined()
  })

  test('returns personal for a sync command/http hook on a guarded event when restricted (STAGED path, explicit flag)', () => {
    // Arrange — official uXn set minus PreModelSwitch (absent from OCC)
    const events = [
      'PreToolUse',
      'PermissionRequest',
      'UserPromptSubmit',
      'UserPromptExpansion',
    ] as const

    // Act / Assert
    for (const event of events) {
      expect(getHookFailureBlockSource(commandHook(), event, true)).toBe(
        'personal',
      )
      expect(getHookFailureBlockSource(httpHook(), event, true)).toBe('personal')
    }
    // async command hooks are not eligible even under restricted mode
    expect(
      getHookFailureBlockSource(commandHook({ async: true }), 'PreToolUse', true),
    ).toBeUndefined()
    // non-guarded events are not eligible
    expect(
      getHookFailureBlockSource(commandHook(), 'PostToolUse', true),
    ).toBeUndefined()
  })

  test('setting reason is byte-identical to official fXn', () => {
    expect(onFailureBlockReason('setting')).toBe(
      'blocking because onFailure is "block"',
    )
  })

  test('personal reasons match official fXn (remoteCall and non-remoteCall)', () => {
    expect(onFailureBlockReason('personal', true)).toBe(
      'blocking because this hook is required.',
    )
    expect(onFailureBlockReason('personal', false)).toBe(
      "blocking because it is one of the user's own hooks, which must succeed in this session (CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG is set). The user needs to fix or remove the hook; Claude should not change it.",
    )
  })
})

describe('hookJsonOutputAlreadyBlocks (official z_t + jEt)', () => {
  test('returns true for decision block on non-PermissionRequest events', () => {
    const json = { decision: 'block' } as unknown as HookJSONOutput
    expect(hookJsonOutputAlreadyBlocks(json, 'PreToolUse')).toBe(true)
  })

  test('returns true for permissionDecision deny in hookSpecificOutput', () => {
    const json = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    } as unknown as HookJSONOutput
    expect(hookJsonOutputAlreadyBlocks(json, 'PreToolUse')).toBe(true)
  })

  test('returns false for permissionDecision allow', () => {
    const json = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    } as unknown as HookJSONOutput
    expect(hookJsonOutputAlreadyBlocks(json, 'PreToolUse')).toBe(false)
  })

  test('PermissionRequest uses the decision.behavior deny shape', () => {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    } as unknown as HookJSONOutput
    const allow = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    } as unknown as HookJSONOutput

    expect(hookJsonOutputAlreadyBlocks(deny, 'PermissionRequest')).toBe(true)
    expect(hookJsonOutputAlreadyBlocks(allow, 'PermissionRequest')).toBe(false)
  })

  test('PermissionRequest ignores a generic top-level decision block (official z_t branch)', () => {
    const json = { decision: 'block' } as unknown as HookJSONOutput
    expect(hookJsonOutputAlreadyBlocks(json, 'PermissionRequest')).toBe(false)
  })
})

describe('hookMustSucceed (official q_t)', () => {
  test('true for an onFailure block hook on an honored event', () => {
    expect(
      hookMustSucceed(commandHook({ onFailure: 'block' }), 'PreToolUse'),
    ).toBe(true)
  })

  test('false on ignored events even with onFailure block', () => {
    expect(hookMustSucceed(commandHook({ onFailure: 'block' }), 'Stop')).toBe(
      false,
    )
  })

  test('true for any sync command hook on a guarded event under restricted personal config', () => {
    expect(hookMustSucceed(commandHook(), 'PreToolUse', true)).toBe(true)
    expect(hookMustSucceed(commandHook(), 'PostToolUse', true)).toBe(false)
  })
})

describe('getOnFailureHookLabel (official lM — raw label, NOT statusMessage)', () => {
  test('command hook joins exec-form args with spaces', () => {
    expect(
      getOnFailureHookLabel(
        commandHook({ command: '/bin/check', args: ['--strict', 'x y'] }),
      ),
    ).toBe('/bin/check --strict x y')
  })

  test('command hook without args is the bare command', () => {
    expect(getOnFailureHookLabel(commandHook())).toBe('./check.sh')
  })

  test('http hook is the url; prompt/agent hooks are the prompt', () => {
    expect(getOnFailureHookLabel(httpHook())).toBe('https://example.com/hook')
    expect(
      getOnFailureHookLabel({ type: 'prompt', prompt: 'verify things' }),
    ).toBe('verify things')
    expect(getOnFailureHookLabel({ type: 'agent', prompt: 'run checks' })).toBe(
      'run checks',
    )
  })

  test('mcp_tool is server/tool; callback and function are literals', () => {
    expect(
      getOnFailureHookLabel({ type: 'mcp_tool', server: 'srv', tool: 'tl' }),
    ).toBe('srv/tl')
    expect(getOnFailureHookLabel({ type: 'callback' })).toBe('callback')
    expect(getOnFailureHookLabel({ type: 'function' })).toBe('function')
  })

  test('statusMessage does not replace the label (deliberate divergence from getHookDisplayText)', () => {
    expect(
      getOnFailureHookLabel({
        ...commandHook(),
        statusMessage: 'Checking…',
      } as OnFailureHookShape),
    ).toBe('./check.sh')
  })
})

describe('applyOnFailureBlockTransform (official K_t, REPL path)', () => {
  test('converts a failed command hook result to blocking with the byte-identical message', () => {
    // Arrange
    const result = nonBlockingErrorResult(
      commandHook({ onFailure: 'block' }),
      'Failed with non-blocking status code: boom',
    )

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PreToolUse')

    // Assert
    expect(transformed.outcome).toBe('blocking')
    expect(transformed.message).toBeUndefined()
    expect(transformed.suppressOriginalPrompt).toBe(true)
    expect(transformed.blockingError).toEqual({
      blockingError:
        '[./check.sh]: failed; blocking because onFailure is "block"\nboom',
      command: './check.sh',
    })
  })

  test('converts a cancelled (timed-out) result to a "timed out" blocking message without detail', () => {
    // Arrange — hook_cancelled attachment carries no hook_non_blocking_error stderr
    const result: OnFailureTransformableResult = {
      outcome: 'cancelled',
      hook: commandHook({ onFailure: 'block' }),
    }

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PreToolUse')

    // Assert
    expect(transformed.outcome).toBe('blocking')
    expect(transformed.blockingError?.blockingError).toBe(
      '[./check.sh]: timed out; blocking because onFailure is "block"',
    )
  })

  test('leaves a cancelled result unchanged when the parent signal was aborted (user interrupt, not timeout)', () => {
    // Arrange
    const controller = new AbortController()
    controller.abort()
    const result: OnFailureTransformableResult = {
      outcome: 'cancelled',
      hook: commandHook({ onFailure: 'block' }),
    }

    // Act
    const transformed = applyOnFailureBlockTransform(
      result,
      'PreToolUse',
      controller.signal,
    )

    // Assert
    expect(transformed).toBe(result)
  })

  test('strips the Gap-108d "Treating as non-blocking. " suffix from the detail', () => {
    // Arrange
    const result = nonBlockingErrorResult(
      commandHook({ onFailure: 'block' }),
      'Hook script appears to be missing — "./check.sh" exited 2 with: bash: ./check.sh: No such file or directory. Treating as non-blocking. Run `/plugin` to reinstall.',
    )

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PreToolUse')

    // Assert
    expect(transformed.blockingError?.blockingError).toBe(
      '[./check.sh]: failed; blocking because onFailure is "block"\n' +
        'Hook script appears to be missing — "./check.sh" exited 2 with: bash: ./check.sh: No such file or directory. Run `/plugin` to reinstall.',
    )
  })

  test('passes success and blocking outcomes through unchanged', () => {
    // Arrange
    const success: OnFailureTransformableResult = {
      outcome: 'success',
      hook: commandHook({ onFailure: 'block' }),
    }
    const blocking: OnFailureTransformableResult = {
      outcome: 'blocking',
      hook: commandHook({ onFailure: 'block' }),
    }

    // Act / Assert
    expect(applyOnFailureBlockTransform(success, 'PreToolUse')).toBe(success)
    expect(applyOnFailureBlockTransform(blocking, 'PreToolUse')).toBe(blocking)
  })

  test('passes results through unchanged on ignored events (Stop)', () => {
    // Arrange
    const result = nonBlockingErrorResult(
      commandHook({ onFailure: 'block' }),
      'Failed with non-blocking status code: boom',
    )

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'Stop')

    // Assert
    expect(transformed).toBe(result)
  })

  test('passes results through unchanged for hooks without onFailure block', () => {
    // Arrange
    const result = nonBlockingErrorResult(commandHook(), 'boom')

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PreToolUse')

    // Assert
    expect(transformed).toBe(result)
  })

  test('PermissionRequest failures also yield a deny permissionRequestResult', () => {
    // Arrange
    const result = nonBlockingErrorResult(
      commandHook({ onFailure: 'block' }),
      'Failed with non-blocking status code: denied by policy',
    )

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PermissionRequest')

    // Assert
    expect(transformed.outcome).toBe('blocking')
    expect(transformed.permissionRequestResult).toEqual({
      behavior: 'deny',
      message:
        '[./check.sh]: failed; blocking because onFailure is "block"\ndenied by policy',
    })
  })

  test('http hook failures block with the url as the command label', () => {
    // Arrange
    const result = nonBlockingErrorResult(
      httpHook({ onFailure: 'block' }),
      'HTTP 500 from https://example.com/hook',
    )

    // Act
    const transformed = applyOnFailureBlockTransform(result, 'PreToolUse')

    // Assert
    expect(transformed.blockingError).toEqual({
      blockingError:
        '[https://example.com/hook]: failed; blocking because onFailure is "block"\nHTTP 500 from https://example.com/hook',
      command: 'https://example.com/hook',
    })
  })
})

describe('applyOnFailureBlockOutsideRepl (official V_t)', () => {
  const blockHook = commandHook({ onFailure: 'block' })

  test('leaves succeeded, already-blocked, and cancelled results unchanged', () => {
    // Arrange
    const succeeded = { succeeded: true, output: 'ok', blocked: false }
    const alreadyBlocked = { succeeded: false, output: 'nope', blocked: true }
    const cancelled = {
      succeeded: false,
      output: 'Hook cancelled',
      blocked: false,
      cancelled: true,
    }

    // Act / Assert — V_t returns the same object identity when it skips
    expect(applyOnFailureBlockOutsideRepl(blockHook, succeeded)).toBe(succeeded)
    expect(applyOnFailureBlockOutsideRepl(blockHook, alreadyBlocked)).toBe(
      alreadyBlocked,
    )
    expect(applyOnFailureBlockOutsideRepl(blockHook, cancelled)).toBe(cancelled)
  })

  test('blocks a timed-out result with the exact official output string', () => {
    // Arrange
    const timedOut = {
      succeeded: false,
      output: 'Hook cancelled',
      blocked: false,
    }

    // Act
    const transformed = applyOnFailureBlockOutsideRepl(blockHook, timedOut)

    // Assert
    expect(transformed.blocked).toBe(true)
    expect(transformed.output).toBe(
      'timed out; blocking because onFailure is "block"',
    )
  })

  test('blocks a failed result and appends the trimmed output as detail', () => {
    // Arrange
    const failed = {
      succeeded: false,
      output: '  boom\n',
      blocked: false,
    }

    // Act
    const transformed = applyOnFailureBlockOutsideRepl(blockHook, failed)

    // Assert
    expect(transformed.blocked).toBe(true)
    expect(transformed.output).toBe(
      'failed; blocking because onFailure is "block"\nboom',
    )
  })

  test('blocks a failed result with empty output without a trailing newline', () => {
    // Arrange
    const failed = { succeeded: false, output: '', blocked: false }

    // Act
    const transformed = applyOnFailureBlockOutsideRepl(blockHook, failed)

    // Assert
    expect(transformed.output).toBe(
      'failed; blocking because onFailure is "block"',
    )
  })

  test('leaves failures of non-block hooks unchanged', () => {
    // Arrange
    const failed = { succeeded: false, output: 'boom', blocked: false }

    // Act / Assert
    expect(applyOnFailureBlockOutsideRepl(commandHook(), failed)).toBe(failed)
    expect(
      applyOnFailureBlockOutsideRepl(
        commandHook({ onFailure: 'block', async: true }),
        failed,
      ),
    ).toBe(failed)
  })
})
