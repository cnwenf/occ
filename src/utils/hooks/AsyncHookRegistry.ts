import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  hookJSONOutputSchema,
  isSyncHookJSONOutput,
} from '../../types/hooks.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { ShellCommand } from '../ShellCommand.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
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

/**
 * CC 2.1.295 payload shape (official `_kt` return): adds `command` so the
 * delivered response carries the hook's display command.
 */
export type AsyncHookResponsePayload = {
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

// ---------------------------------------------------------------------------
// CC 2.1.295 — whole-buffer async hook JSON answer extraction.
//
// Official pipeline (per-hook reader `_kt` inside `kkt`):
//   fkt(stdout)  → first whole-buffer JSON object that is a SYNC response
//   mkt(parsed)  → schema validate + salvage recognized fields
//   dse(raw,ok)  → warn on unrecognized keys
//   Xyo/pkt      → "begins with { but no JSON answer could be read" check
//
// RECONSTRUCTION NOTE: the official `fkt` body is corrupted/interleaved in
// the binary strings dump (only `function fkt(e){let n=e.trim().split("\n`
// survives), so the extractor below is a documented reconstruction: a
// string/escape-aware balanced-brace scan over the WHOLE buffer that returns
// the first plain JSON object that is NOT the `{"async":true}` marker; if
// only marker object(s) are found, the first marker is returned so `mkt`'s
// official "async-marker response where a sync response was expected"
// salvage path runs (debug-level log, empty payload → attachment skipped).
// This makes multi-line pretty-printed JSON answers readable (previously
// only single-line JSON was parsed) while keeping the `{"async":true}`
// announcement behavior intact.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Official YV — human-readable type name for validation messages. */
function getTypeName(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  return `a ${typeof value}`
}

/** Official Dhe — the `{"async":true}` marker check. */
function isAsyncMarkerObject(value: Record<string, unknown>): boolean {
  return 'async' in value && value.async === true
}

/**
 * Official fkt (reconstructed — see note above): scans the whole stdout
 * buffer for balanced top-level `{...}` candidates and returns the first
 * plain JSON object that is not the async marker. Marker-only buffers fall
 * back to the first marker object; no candidate → undefined.
 */
export function extractFirstJsonObject(
  stdout: string,
): Record<string, unknown> | undefined {
  let firstAsyncMarker: Record<string, unknown> | undefined
  let depth = 0
  let candidateStart = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < stdout.length; i++) {
    const char = stdout[i]
    if (candidateStart === -1) {
      if (char === '{') {
        candidateStart = i
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        const candidate = stdout.slice(candidateStart, i + 1)
        candidateStart = -1
        let parsed: unknown
        try {
          parsed = jsonParse(candidate)
        } catch {
          continue
        }
        if (!isPlainObject(parsed)) {
          continue
        }
        if (isAsyncMarkerObject(parsed)) {
          if (firstAsyncMarker === undefined) {
            firstAsyncMarker = parsed
          }
          continue
        }
        return parsed
      }
    }
  }
  return firstAsyncMarker
}

/** Official QIe — single-line JSON object parse (must start with `{`). */
function parseSingleLineJsonObject(
  line: string,
): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) {
    return undefined
  }
  try {
    const parsed = jsonParse(line)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Official ukt — `"async" in (QIe(line) ?? {})`. */
function isAsyncMarkerLine(trimmedLine: string): boolean {
  const parsed = parseSingleLineJsonObject(trimmedLine)
  return parsed !== undefined && 'async' in parsed
}

/**
 * Official Xyo (called pkt in _kt) — true when some stdout line begins with
 * `{` but is not a readable async-marker line, i.e. the hook printed
 * something JSON-shaped that could not be read as an answer.
 */
export function hasUnreadableJsonAnswerLine(stdout: string): boolean {
  return stdout
    .replace(/^\uFEFF/, '')
    .split('\n')
    .some(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('{') && !isAsyncMarkerLine(trimmed)
    })
}

/**
 * Official dse — warn about keys present in the raw output but stripped by
 * schema validation (default level: debug, matching the official `t(msg)`).
 */
function warnUnrecognizedHookJsonKeys(
  raw: Record<string, unknown>,
  validated: Record<string, unknown>,
): void {
  const unrecognized: string[] = []
  const validatedKeys = new Set(Object.keys(validated))
  for (const key of Object.keys(raw)) {
    if (!validatedKeys.has(key)) {
      unrecognized.push(key)
    }
  }
  const rawSpecific = raw.hookSpecificOutput
  const validatedSpecific = validated.hookSpecificOutput
  if (isPlainObject(rawSpecific) && isPlainObject(validatedSpecific)) {
    const specificKeys = new Set(Object.keys(validatedSpecific))
    for (const key of Object.keys(rawSpecific)) {
      if (!specificKeys.has(key)) {
        unrecognized.push(`hookSpecificOutput.${key}`)
      }
    }
  }
  if (unrecognized.length === 0) {
    return
  }
  const hint = unrecognized.includes('additionalContext')
    ? ' Did you mean hookSpecificOutput.additionalContext (with a hookEventName)?'
    : ''
  logForDebugging(
    `Hook JSON output had unrecognized keys (ignored): ${unrecognized.join(', ')}.${hint}`,
  )
}

/**
 * Official mkt — validate a parsed async-hook JSON answer against the union
 * schema (official `fne` = OCC `hookJSONOutputSchema`: async marker ∪ sync
 * output). Valid SYNC responses pass through (with the dse unknown-keys
 * warn); everything else is salvaged field-by-field with the official
 * messages, returning a possibly-empty object.
 */
export function validateAsyncHookJsonResponse(
  parsed: unknown,
  hookName: string,
): SyncHookJSONOutput {
  if (!isPlainObject(parsed)) {
    logForDebugging(
      `${hookName} async hook JSON output must be an object, got ${getTypeName(parsed)} — ignored`,
      { level: 'error' },
    )
    return {}
  }
  const result = hookJSONOutputSchema().safeParse(parsed)
  if (result.success && isSyncHookJSONOutput(result.data)) {
    warnUnrecognizedHookJsonKeys(parsed, result.data as Record<string, unknown>)
    return result.data as SyncHookJSONOutput
  }
  // Salvage path — official mkt: keep recognized well-typed fields, report
  // malformed ones, and surface the first zod issue (or the async-marker
  // fallback text when the payload validated as the marker schema).
  const ignoredFields: string[] = []
  const salvaged: Record<string, unknown> = {}
  if ('systemMessage' in parsed) {
    if (typeof parsed.systemMessage === 'string') {
      salvaged.systemMessage = parsed.systemMessage
    } else {
      ignoredFields.push(`systemMessage (${getTypeName(parsed.systemMessage)})`)
    }
  }
  if ('metrics' in parsed) {
    if (isPlainObject(parsed.metrics)) {
      const entries = Object.entries(parsed.metrics).filter(
        ([, value]) => typeof value === 'boolean' || typeof value === 'number',
      )
      salvaged.metrics = Object.fromEntries(entries)
    } else {
      ignoredFields.push(`metrics (${getTypeName(parsed.metrics)})`)
    }
  }
  if ('hookSpecificOutput' in parsed) {
    if (isPlainObject(parsed.hookSpecificOutput)) {
      const { additionalContext, ...rest } = parsed.hookSpecificOutput
      const isContextString = typeof additionalContext === 'string'
      if (!isContextString && additionalContext !== undefined) {
        ignoredFields.push(
          `hookSpecificOutput.additionalContext (${getTypeName(additionalContext)})`,
        )
      }
      salvaged.hookSpecificOutput = isContextString
        ? parsed.hookSpecificOutput
        : rest
    } else {
      ignoredFields.push(
        `hookSpecificOutput (${getTypeName(parsed.hookSpecificOutput)})`,
      )
    }
  }
  const firstIssue = result.success ? undefined : result.error.issues[0]
  const issueText = firstIssue
    ? `${firstIssue.path.join('.') || '(root)'}: ${firstIssue.message}`
    : 'async-marker response where a sync response was expected'
  logForDebugging(
    `${hookName} async hook JSON output failed schema validation (${issueText})` +
      (ignoredFields.length > 0
        ? `; ignored malformed field(s): ${ignoredFields.join(', ')}`
        : '; delivering recognized fields as-is'),
    { level: ignoredFields.length > 0 ? 'error' : 'debug' },
  )
  return salvaged as SyncHookJSONOutput
}

/**
 * Official _kt — read, validate and finalize one completed async hook.
 * Returns null when the hook produced no response payload (empty salvaged
 * response + exit 0 + empty stderr → the attachment is skipped).
 */
async function readAsyncHookResponse(
  hook: PendingAsyncHook,
  shellCommand: ShellCommand,
): Promise<AsyncHookResponsePayload | null> {
  const stdout = await shellCommand.taskOutput.getStdout()
  const stderr = shellCommand.taskOutput.getStderr()
  const { code } = await shellCommand.result
  let response: SyncHookJSONOutput = {}
  try {
    const parsed = extractFirstJsonObject(stdout)
    if (parsed !== undefined) {
      logForDebugging(
        `Hooks: Found sync response from ${hook.processId}: ${jsonStringify(parsed)}`,
      )
      response = validateAsyncHookJsonResponse(parsed, hook.hookName)
    } else if (hasUnreadableJsonAnswerLine(stdout)) {
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
  await finalizeHook(hook, code, code === 0 ? 'success' : 'error')
  if (Object.keys(response).length === 0 && code === 0 && !stderr.trim()) {
    logForDebugging(
      `Hooks: ${hook.processId} (${hook.hookName}) produced no response payload — skipping attachment`,
    )
    return null
  }
  return {
    processId: hook.processId,
    response,
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    toolName: hook.toolName,
    pluginId: hook.pluginId,
    command: hook.command,
    stdout,
    stderr,
    exitCode: code,
  }
}

export async function checkForAsyncHookResponses(): Promise<
  AsyncHookResponsePayload[]
> {
  const responses: AsyncHookResponsePayload[] = []

  const pendingCount = pendingHooks.size
  logForDebugging(`Hooks: Found ${pendingCount} total hooks in registry`)

  // Snapshot hooks before processing — we'll mutate the map after.
  const hooks = Array.from(pendingHooks.values())

  const settled = await Promise.allSettled(
    hooks.map(async hook => {
      logForDebugging(
        `Hooks: Checking hook ${hook.processId} (${hook.hookName}) - attachmentSent: ${hook.responseAttachmentSent}`,
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

      if (hook.responseAttachmentSent) {
        // CC 2.1.295 (official kkt): the OCC-side `|| !stdout.trim()` early
        // skip is REMOVED — empty-stdout hooks now flow through
        // readAsyncHookResponse so they still finalize (emitHookResponse +
        // cache invalidation for SessionStart) before the empty payload
        // skips the attachment. cleanup() is retained here as the OCC-side
        // #29 (2.1.208) memory-leak fix (official kkt does not clean up in
        // this branch; JIe/finalizeHook does).
        logForDebugging(
          `Hooks: Skipping hook ${hook.processId} - already delivered`,
        )
        hook.stopProgressInterval()
        hook.shellCommand.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      const isSessionStart = hook.hookEvent === 'SessionStart'
      const payload = await readAsyncHookResponse(hook, hook.shellCommand)
      return payload === null
        ? { type: 'remove' as const, processId: hook.processId, isSessionStart }
        : {
            type: 'response' as const,
            processId: hook.processId,
            isSessionStart,
            payload,
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
      // Official kkt: `"isSessionStart"in w&&w.isSessionStart` — a
      // SessionStart hook that finalized with an EMPTY payload (attachment
      // skipped) still invalidates the session env cache.
      if ('isSessionStart' in r && r.isSessionStart) {
        sessionStartCompleted = true
      }
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
