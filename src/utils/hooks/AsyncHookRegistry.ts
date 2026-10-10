import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../debug.js'
import type { ShellCommand } from '../ShellCommand.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { errorMessage } from '../errors.js'
import { jsonStringify } from '../slowOperations.js'
import {
  extractAsyncHookSyncResponse,
  hasUnreadableAsyncHookJsonAnswer,
} from './asyncHookJson.js'
import { emitHookResponse, startHookProgressInterval } from './hookEvents.js'

export type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  stopProgressInterval: () => void
}

// Global registry state
const pendingHooks = new Map<string, PendingAsyncHook>()

export function registerPendingAsyncHook({
  processId,
  hookId,
  asyncResponse,
  hookName,
  hookEvent,
  command,
  shellCommand,
  toolName,
  pluginId,
}: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  command: string
  shellCommand: ShellCommand
  toolName?: string
  pluginId?: string
}): void {
  const timeout = asyncResponse.asyncTimeout || 15000 // Default 15s
  logForDebugging(
    `Hooks: Registering async hook ${processId} (${hookName}) with timeout ${timeout}ms`,
  )
  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => {
      const taskOutput = pendingHooks.get(processId)?.shellCommand?.taskOutput
      if (!taskOutput) {
        return { stdout: '', stderr: '', output: '' }
      }
      const stdout = await taskOutput.getStdout()
      const stderr = taskOutput.getStderr()
      return { stdout, stderr, output: stdout + stderr }
    },
  })
  pendingHooks.set(processId, {
    processId,
    hookId,
    hookName,
    hookEvent,
    toolName,
    pluginId,
    command,
    startTime: Date.now(),
    timeout: timeout as number,
    responseAttachmentSent: false,
    shellCommand,
    stopProgressInterval,
  })
}

export function getPendingAsyncHooks(): PendingAsyncHook[] {
  return Array.from(pendingHooks.values()).filter(
    hook => !hook.responseAttachmentSent,
  )
}

async function finalizeHook(
  hook: PendingAsyncHook,
  exitCode: number,
  outcome: 'success' | 'error' | 'cancelled',
): Promise<void> {
  hook.stopProgressInterval()
  const taskOutput = hook.shellCommand?.taskOutput
  const stdout = taskOutput ? await taskOutput.getStdout() : ''
  const stderr = taskOutput?.getStderr() ?? ''
  hook.shellCommand?.cleanup()
  emitHookResponse({
    hookId: hook.hookId,
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    output: stdout + stderr,
    stdout,
    stderr,
    exitCode,
    outcome,
  })
}

export async function checkForAsyncHookResponses(): Promise<
  Array<{
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    // CC 2.1.295 (#070): official `_kt` payload gained `command:e.command` —
    // the SessionStart dedupe gate (official `Umn`) compares command+pluginId
    // to decide whether two hook runs share a source.
    command: string
    stdout: string
    stderr: string
    exitCode?: number
  }>
> {
  const responses: {
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    command: string
    stdout: string
    stderr: string
    exitCode?: number
  }[] = []

  const pendingCount = pendingHooks.size
  logForDebugging(`Hooks: Found ${pendingCount} total hooks in registry`)

  // Snapshot hooks before processing — we'll mutate the map after.
  const hooks = Array.from(pendingHooks.values())

  const settled = await Promise.allSettled(
    hooks.map(async hook => {
      const stdout = (await hook.shellCommand?.taskOutput.getStdout()) ?? ''
      const stderr = hook.shellCommand?.taskOutput.getStderr() ?? ''
      logForDebugging(
        `Hooks: Checking hook ${hook.processId} (${hook.hookName}) - attachmentSent: ${hook.responseAttachmentSent}, stdout length: ${stdout.length}`,
      )

      if (!hook.shellCommand) {
        logForDebugging(
          `Hooks: Hook ${hook.processId} has no shell command, removing from registry`,
        )
        hook.stopProgressInterval()
        return { type: 'remove' as const, processId: hook.processId }
      }

      logForDebugging(`Hooks: Hook shell status ${hook.shellCommand.status}`)

      if (hook.shellCommand.status === 'killed') {
        logForDebugging(
          `Hooks: Hook ${hook.processId} is ${hook.shellCommand.status}, removing from registry`,
        )
        hook.stopProgressInterval()
        hook.shellCommand.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      if (hook.shellCommand.status !== 'completed') {
        return { type: 'skip' as const }
      }

      if (hook.responseAttachmentSent || !stdout.trim()) {
        logForDebugging(
          `Hooks: Skipping hook ${hook.processId} - already delivered/sent or no stdout`,
        )
        hook.stopProgressInterval()
        // #29 (2.1.208): Release retained async hook output. Without
        // cleanup(), the ShellCommand's StreamWrapper event listeners and
        // TaskOutput's in-memory buffers (CircularBuffer, DiskTaskOutput
        // handle) persist for the session lifetime — a memory leak in long
        // sessions with many backgrounded async hooks.
        hook.shellCommand?.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      const execResult = await hook.shellCommand.result
      const exitCode = execResult.code

      // CC 2.1.295 (#078): extract the JSON answer from the WHOLE stdout
      // (official `fkt`), so a pretty-printed multi-line JSON object is
      // recognized; per-line scanning survives only as the in-candidate
      // fallback. When nothing can be read but a line begins with `{`,
      // log the official guidance error (official `pkt` branch).
      let response: SyncHookJSONOutput = {}
      try {
        const parsed = extractAsyncHookSyncResponse(stdout)
        if (parsed !== undefined) {
          logForDebugging(
            `Hooks: Found sync response from ${hook.processId}: ${jsonStringify(parsed)}`,
          )
          response = parsed
        } else if (hasUnreadableAsyncHookJsonAnswer(stdout)) {
          logForDebugging(
            `Hooks: async hook ${hook.processId} (${hook.hookName}) printed a stdout line that begins with { but no JSON answer could be read. After any {"async":true} line, print one JSON object and nothing else, or put the object on one line.`,
            { level: 'error' },
          )
        }
      } catch (error) {
        logForDebugging(
          `Hooks: Failed to read the JSON answer of ${hook.processId} (${hook.hookName}), so it is dropped: ${errorMessage(error)}`,
          { level: 'error' },
        )
      }

      hook.responseAttachmentSent = true
      await finalizeHook(hook, exitCode, exitCode === 0 ? 'success' : 'error')

      return {
        type: 'response' as const,
        processId: hook.processId,
        isSessionStart: hook.hookEvent === 'SessionStart',
        payload: {
          processId: hook.processId,
          response,
          hookName: hook.hookName,
          hookEvent: hook.hookEvent,
          toolName: hook.toolName,
          pluginId: hook.pluginId,
          command: hook.command,
          stdout,
          stderr,
          exitCode,
        },
      }
    }),
  )

  // allSettled — isolate failures so one throwing callback doesn't orphan
  // already-applied side effects (responseAttachmentSent, finalizeHook) from others.
  let sessionStartCompleted = false
  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      logForDebugging(
        `Hooks: checkForAsyncHookResponses callback rejected: ${s.reason}`,
        { level: 'error' },
      )
      continue
    }
    const r = s.value
    if (r.type === 'remove') {
      pendingHooks.delete(r.processId)
    } else if (r.type === 'response') {
      responses.push(r.payload)
      pendingHooks.delete(r.processId)
      if (r.isSessionStart) sessionStartCompleted = true
    }
  }

  if (sessionStartCompleted) {
    logForDebugging(
      `Invalidating session env cache after SessionStart hook completed`,
    )
    invalidateSessionEnvCache()
  }

  logForDebugging(
    `Hooks: checkForNewResponses returning ${responses.length} responses`,
  )
  return responses
}

export function removeDeliveredAsyncHooks(processIds: string[]): void {
  for (const processId of processIds) {
    const hook = pendingHooks.get(processId)
    if (hook && hook.responseAttachmentSent) {
      logForDebugging(`Hooks: Removing delivered hook ${processId}`)
      hook.stopProgressInterval()
      // #29 (2.1.208): Release retained async hook output after delivery.
      // Without cleanup(), the ShellCommand and its TaskOutput (with in-memory
      // CircularBuffer + DiskTaskOutput) persist — a leak in long sessions.
      hook.shellCommand?.cleanup()
      pendingHooks.delete(processId)
    }
  }
}

export async function finalizePendingAsyncHooks(): Promise<void> {
  const hooks = Array.from(pendingHooks.values())
  await Promise.all(
    hooks.map(async hook => {
      if (hook.shellCommand?.status === 'completed') {
        const result = await hook.shellCommand.result
        await finalizeHook(
          hook,
          result.code,
          result.code === 0 ? 'success' : 'error',
        )
      } else {
        if (hook.shellCommand && hook.shellCommand.status !== 'killed') {
          hook.shellCommand.kill()
        }
        await finalizeHook(hook, 1, 'cancelled')
      }
    }),
  )
  pendingHooks.clear()
}

// Test utility function to clear all hooks
export function clearAllAsyncHooks(): void {
  for (const hook of pendingHooks.values()) {
    hook.stopProgressInterval()
  }
  pendingHooks.clear()
}
