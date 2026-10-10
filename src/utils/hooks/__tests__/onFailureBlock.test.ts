/**
 * Unit tests for onFailure:"block" (CC 2.1.295) — official jIe/lM/K_t/V_t
 * ports in src/utils/hooks/onFailureBlock.ts.
 *
 * Evidence: official 2.1.295 linux-x64 ELF (see onFailureBlock.ts header for
 * the verbatim jIe/G_t/K_t/V_t/W_t/fXn/lM function bodies).
 */

import { describe, expect, test } from 'bun:test'
import { HookCommandSchema } from '../../../schemas/hooks.js'
import type { HookResult } from '../../hooks.js'
import {
  applyOnFailureBlockOutcome,
  applyOnFailureBlockRaw,
  getHookFailureCommand,
  isOnFailureBlockHook,
  ON_FAILURE_BLOCK_IGNORED_EVENTS,
} from '../onFailureBlock.js'

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

const blockCommandHook = {
  type: 'command',
  command: 'my-hook.sh',
  onFailure: 'block',
} as const

const continueCommandHook = {
  type: 'command',
  command: 'my-hook.sh',
  onFailure: 'continue',
} as const

const blockHttpHook = {
  type: 'http',
  url: 'https://example.com/hook',
  onFailure: 'block',
} as const

function makeResult(
  overrides: Partial<HookResult> & { hook: HookResult['hook'] },
): HookResult {
  return { outcome: 'success', ...overrides } as HookResult
}

function makeNonBlockingErrorResult(
  hook: HookResult['hook'],
  stderr: string,
): HookResult {
  return makeResult({
    hook,
    outcome: 'non_blocking_error',
    message: {
      type: 'attachment',
      attachment: {
        type: 'hook_non_blocking_error',
        hookName: 'PreToolUse',
        stderr,
        stdout: '',
        exitCode: 1,
        toolUseID: 'tu-1',
        hookEvent: 'PreToolUse',
      },
      uuid: 'u-1',
      timestamp: '2026-10-10T00:00:00.000Z',
    } as unknown as HookResult['message'],
  })
}

// ---------------------------------------------------------------------------
// isOnFailureBlockHook (official jIe)
// ---------------------------------------------------------------------------

describe('isOnFailureBlockHook (official jIe predicate)', () => {
  test('returns true for a sync command hook with onFailure "block"', () => {
    expect(isOnFailureBlockHook(blockCommandHook as never)).toBe(true)
  })

  test('returns false for an async command hook even with onFailure "block"', () => {
    // Arrange
    const hook = { ...blockCommandHook, async: true }

    // Act & Assert — async hooks ignore onFailure (official jIe)
    expect(isOnFailureBlockHook(hook as never)).toBe(false)
  })

  test('returns false for an asyncRewake command hook even with onFailure "block"', () => {
    const hook = { ...blockCommandHook, asyncRewake: true }
    expect(isOnFailureBlockHook(hook as never)).toBe(false)
  })

  test('returns false for a command hook with onFailure "continue"', () => {
    expect(isOnFailureBlockHook(continueCommandHook as never)).toBe(false)
  })

  test('returns false for a command hook without onFailure', () => {
    expect(
      isOnFailureBlockHook({ type: 'command', command: 'x' } as never),
    ).toBe(false)
  })

  test('returns true for an http hook with onFailure "block"', () => {
    expect(isOnFailureBlockHook(blockHttpHook as never)).toBe(true)
  })

  test('returns false for an http hook without onFailure', () => {
    expect(
      isOnFailureBlockHook({
        type: 'http',
        url: 'https://example.com',
      } as never),
    ).toBe(false)
  })

  test('returns false for prompt, agent, mcp_tool, callback and function hooks', () => {
    const hooks = [
      { type: 'prompt', prompt: 'p', onFailure: 'block' },
      { type: 'agent', prompt: 'p', onFailure: 'block' },
      { type: 'mcp_tool', server: 's', tool: 't', onFailure: 'block' },
      { type: 'callback', callback: async () => ({}) },
      { type: 'function', callback: () => true, errorMessage: 'e' },
    ]
    for (const hook of hooks) {
      expect(isOnFailureBlockHook(hook as never)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// getHookFailureCommand (official lM)
// ---------------------------------------------------------------------------

describe('getHookFailureCommand (official lM display text)', () => {
  test('returns the command for a command hook', () => {
    expect(
      getHookFailureCommand({ type: 'command', command: 'do.sh' } as never),
    ).toBe('do.sh')
  })

  test('joins command and args for exec-form command hooks', () => {
    expect(
      getHookFailureCommand({
        type: 'command',
        command: 'do',
        args: ['--flag', 'value'],
      } as never),
    ).toBe('do --flag value')
  })

  test('returns the prompt for prompt and agent hooks', () => {
    expect(
      getHookFailureCommand({ type: 'prompt', prompt: 'check it' } as never),
    ).toBe('check it')
    expect(
      getHookFailureCommand({ type: 'agent', prompt: 'verify' } as never),
    ).toBe('verify')
  })

  test('returns the url for http hooks and server/tool for mcp_tool hooks', () => {
    expect(
      getHookFailureCommand({
        type: 'http',
        url: 'https://example.com/h',
      } as never),
    ).toBe('https://example.com/h')
    expect(
      getHookFailureCommand({
        type: 'mcp_tool',
        server: 'srv',
        tool: 'tl',
      } as never),
    ).toBe('srv/tl')
  })

  test('returns "callback"/"function" for in-process hook types', () => {
    expect(getHookFailureCommand({ type: 'callback' } as never)).toBe(
      'callback',
    )
    expect(getHookFailureCommand({ type: 'function' } as never)).toBe(
      'function',
    )
  })
})

// ---------------------------------------------------------------------------
// ON_FAILURE_BLOCK_IGNORED_EVENTS (official G_t)
// ---------------------------------------------------------------------------

describe('ON_FAILURE_BLOCK_IGNORED_EVENTS (official G_t)', () => {
  test('contains exactly Stop, SubagentStop, TaskCompleted and TeammateIdle', () => {
    expect([...ON_FAILURE_BLOCK_IGNORED_EVENTS].sort()).toEqual([
      'Stop',
      'SubagentStop',
      'TaskCompleted',
      'TeammateIdle',
    ])
  })
})

// ---------------------------------------------------------------------------
// applyOnFailureBlockOutcome (official K_t, setting path)
// ---------------------------------------------------------------------------

describe('applyOnFailureBlockOutcome (official K_t)', () => {
  test('passes through results from hooks without onFailure "block" unchanged (same object)', () => {
    // Arrange
    const result = makeNonBlockingErrorResult(
      continueCommandHook as never,
      'boom',
    )

    // Act
    const transformed = applyOnFailureBlockOutcome(result, 'PreToolUse')

    // Assert — identity: K_t returns `e` untouched
    expect(transformed).toBe(result)
  })

  test('passes through successful results unchanged', () => {
    const result = makeResult({ hook: blockCommandHook as never })
    expect(applyOnFailureBlockOutcome(result, 'PreToolUse')).toBe(result)
  })

  test('converts a non_blocking_error into a blocking result with the official message text', () => {
    // Arrange
    const result = makeNonBlockingErrorResult(
      blockCommandHook as never,
      'Failed with non-blocking status code: script said no',
    )

    // Act
    const transformed = applyOnFailureBlockOutcome(result, 'PreToolUse')

    // Assert — official ke: `[G]: failed; blocking because onFailure is "block"\n<stderr>`
    // with Jre ("Failed with non-blocking status code: ") stripped.
    expect(transformed.outcome).toBe('blocking')
    expect(transformed.message).toBeUndefined()
    expect(transformed.suppressOriginalPrompt).toBe(true)
    expect(transformed.blockingError).toEqual({
      blockingError:
        '[my-hook.sh]: failed; blocking because onFailure is "block"\nscript said no',
      command: 'my-hook.sh',
    })
  })

  test('strips the "Treating as non-blocking. " marker from extracted stderr (official UIe replace)', () => {
    const result = makeNonBlockingErrorResult(
      blockCommandHook as never,
      'Failed with non-blocking status code: bad thing. Treating as non-blocking. extra',
    )

    const transformed = applyOnFailureBlockOutcome(result, 'PreToolUse')

    expect(transformed.blockingError?.blockingError).toBe(
      '[my-hook.sh]: failed; blocking because onFailure is "block"\nbad thing. extra',
    )
  })

  test('omits the stderr line entirely when the attachment stderr is empty', () => {
    const result = makeResult({
      hook: blockCommandHook as never,
      outcome: 'non_blocking_error',
    })

    const transformed = applyOnFailureBlockOutcome(result, 'PreToolUse')

    expect(transformed.blockingError?.blockingError).toBe(
      '[my-hook.sh]: failed; blocking because onFailure is "block"',
    )
  })

  test('treats a cancelled result with a non-aborted parent signal as "timed out"', () => {
    // Arrange — official: e.outcome==="cancelled"&&r?.aborted!==!0 → "timed out"
    const result = makeResult({
      hook: blockCommandHook as never,
      outcome: 'cancelled',
    })

    // Act
    const transformed = applyOnFailureBlockOutcome(result, 'PreToolUse')

    // Assert
    expect(transformed.outcome).toBe('blocking')
    expect(transformed.blockingError?.blockingError).toBe(
      '[my-hook.sh]: timed out; blocking because onFailure is "block"',
    )
  })

  test('passes through a cancelled result when the parent signal aborted (user abort, not a timeout)', () => {
    // Arrange
    const controller = new AbortController()
    controller.abort()
    const result = makeResult({
      hook: blockCommandHook as never,
      outcome: 'cancelled',
    })

    // Act
    const transformed = applyOnFailureBlockOutcome(
      result,
      'PreToolUse',
      controller.signal,
    )

    // Assert — identity passthrough
    expect(transformed).toBe(result)
  })

  test('does not block on Stop, SubagentStop, TaskCompleted or TeammateIdle (warn + pass through)', () => {
    for (const event of [
      'Stop',
      'SubagentStop',
      'TaskCompleted',
      'TeammateIdle',
    ] as const) {
      const result = makeNonBlockingErrorResult(
        blockCommandHook as never,
        'Failed with non-blocking status code: nope',
      )
      const transformed = applyOnFailureBlockOutcome(result, event)
      // Identity passthrough — the failure is reported but not converted.
      expect(transformed).toBe(result)
    }
  })

  test('adds a deny permissionRequestResult on PermissionRequest events', () => {
    // Arrange
    const result = makeNonBlockingErrorResult(
      blockHttpHook as never,
      'connection refused',
    )

    // Act
    const transformed = applyOnFailureBlockOutcome(result, 'PermissionRequest')

    // Assert — official: ...n==="PermissionRequest"&&{permissionRequestResult:{behavior:"deny",message:ke}}
    expect(transformed.permissionRequestResult).toEqual({
      behavior: 'deny',
      message:
        '[https://example.com/hook]: failed; blocking because onFailure is "block"\nconnection refused',
    })
    expect(transformed.blockingError?.command).toBe('https://example.com/hook')
  })

  test('does not mutate the original result object', () => {
    // Arrange
    const result = makeNonBlockingErrorResult(
      blockCommandHook as never,
      'Failed with non-blocking status code: x',
    )
    const originalOutcome = result.outcome

    // Act
    applyOnFailureBlockOutcome(result, 'PreToolUse')

    // Assert
    expect(result.outcome).toBe(originalOutcome)
    expect(result.suppressOriginalPrompt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applyOnFailureBlockRaw (official V_t)
// ---------------------------------------------------------------------------

describe('applyOnFailureBlockRaw (official V_t)', () => {
  const failedRaw = {
    command: 'my-hook.sh',
    succeeded: false,
    output: 'spawn ENOENT',
    blocked: false,
  }

  test('converts a failed raw result into a blocked result with the official output text', () => {
    // Act
    const transformed = applyOnFailureBlockRaw(
      blockCommandHook as never,
      failedRaw,
    )

    // Assert
    expect(transformed.blocked).toBe(true)
    expect(transformed.output).toBe(
      'failed; blocking because onFailure is "block"\nspawn ENOENT',
    )
  })

  test('converts a "Hook cancelled" output (own timeout) into "timed out" with no detail line', () => {
    // Arrange — official: r=n.output==="Hook cancelled" → "timed out", s=""
    const cancelledRaw = { ...failedRaw, output: 'Hook cancelled' }

    // Act
    const transformed = applyOnFailureBlockRaw(
      blockCommandHook as never,
      cancelledRaw,
    )

    // Assert
    expect(transformed.blocked).toBe(true)
    expect(transformed.output).toBe(
      'timed out; blocking because onFailure is "block"',
    )
  })

  test('passes through parent-cancelled results (cancelled:true) unchanged', () => {
    // Arrange — official guard: n.cancelled===!0 → return n
    const parentCancelled = { ...failedRaw, cancelled: true }

    // Act & Assert — identity
    expect(
      applyOnFailureBlockRaw(blockCommandHook as never, parentCancelled),
    ).toBe(parentCancelled)
  })

  test('passes through succeeded, already-blocked, and non-block-hook results unchanged', () => {
    const succeeded = { ...failedRaw, succeeded: true }
    const blocked = { ...failedRaw, blocked: true }
    expect(applyOnFailureBlockRaw(blockCommandHook as never, succeeded)).toBe(
      succeeded,
    )
    expect(applyOnFailureBlockRaw(blockCommandHook as never, blocked)).toBe(
      blocked,
    )
    expect(applyOnFailureBlockRaw(continueCommandHook as never, failedRaw)).toBe(
      failedRaw,
    )
  })

  test('passes through async command hook results unchanged (async ignores onFailure)', () => {
    const asyncHook = { ...blockCommandHook, async: true }
    expect(applyOnFailureBlockRaw(asyncHook as never, failedRaw)).toBe(
      failedRaw,
    )
  })

  test('does not mutate the original raw result object', () => {
    // Act
    applyOnFailureBlockRaw(blockCommandHook as never, failedRaw)

    // Assert
    expect(failedRaw.blocked).toBe(false)
    expect(failedRaw.output).toBe('spawn ENOENT')
  })
})

// ---------------------------------------------------------------------------
// Schema surface (official ni() zod field, 2.1.295)
// ---------------------------------------------------------------------------

describe('HookCommandSchema onFailure field (2.1.295)', () => {
  test('accepts onFailure "block" and "continue" on command hooks', () => {
    const schema = HookCommandSchema()
    for (const value of ['block', 'continue'] as const) {
      const parsed = schema.safeParse({
        type: 'command',
        command: 'x.sh',
        onFailure: value,
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data).toMatchObject({ onFailure: value })
      }
    }
  })

  test('accepts onFailure "block" on http hooks', () => {
    const parsed = HookCommandSchema().safeParse({
      type: 'http',
      url: 'https://example.com/h',
      onFailure: 'block',
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects unknown onFailure values', () => {
    const parsed = HookCommandSchema().safeParse({
      type: 'command',
      command: 'x.sh',
      onFailure: 'explode',
    })
    expect(parsed.success).toBe(false)
  })

  test('carries the official ni() describe text verbatim on both schemas', () => {
    // Official (2.1.295) describe text — verbatim from the binary.
    const officialDescribe =
      "What a failure of this hook does: it could not start (a missing script or plugin directory), timed out, exited with a code other than 0 or 2, or printed JSON that is invalid or fails validation. 'continue' (default): the failure is reported and the action goes ahead. 'block': the failure counts as exit code 2, so the action the event guards (a tool call, a permission request, a prompt) is blocked. Ignored for async hooks and on Stop, SubagentStop, TaskCompleted and TeammateIdle."
    const options = HookCommandSchema().options as Array<{
      shape: Record<string, { description?: string }>
    }>
    const commandShape = options.find(
      o => 'command' in o.shape && 'args' in o.shape,
    )?.shape
    const httpShape = options.find(
      o => 'url' in o.shape && 'headers' in o.shape,
    )?.shape
    expect(commandShape?.onFailure?.description).toBe(officialDescribe)
    expect(httpShape?.onFailure?.description).toBe(officialDescribe)
  })

  test('prompt, agent and mcp_tool hook schemas have no onFailure field', () => {
    const options = HookCommandSchema().options as Array<{
      shape: Record<string, unknown>
    }>
    const promptShape = options.find(
      o =>
        'prompt' in o.shape && 'model' in o.shape && !('command' in o.shape),
    )?.shape
    const agentShape = options.find(
      o => 'prompt' in o.shape && !('continueOnBlock' in o.shape),
    )?.shape
    const mcpShape = options.find(
      o => 'server' in o.shape && 'tool' in o.shape,
    )?.shape
    // Official Ap() places onFailure:ni() exactly twice (command + http).
    expect(promptShape).toBeDefined()
    expect(agentShape).toBeDefined()
    expect(mcpShape).toBeDefined()
    expect(promptShape && 'onFailure' in promptShape).toBe(false)
    expect(agentShape && 'onFailure' in agentShape).toBe(false)
    expect(mcpShape && 'onFailure' in mcpShape).toBe(false)
  })
})
