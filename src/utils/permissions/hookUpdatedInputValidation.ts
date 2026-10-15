import isEqual from 'lodash-es/isEqual.js'
import { z, type ZodIssue } from 'zod/v4'
import type { Tool, ValidationResult } from '../../Tool.js'
import type { PermissionDenyDecision } from '../../types/permissions.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, isAbortError, toError } from '../errors.js'
import { logError } from '../log.js'
import { formatZodValidationError } from '../toolErrors.js'

/**
 * CC 2.1.300 (#65) — hook `updatedInput` rewrite validation.
 *
 * Faithful port of the v300 binary's validation subsystem (all offsets in
 * the 2.1.300 linux-x64 ELF, byte-verified):
 *   - `aHe` @225233390 — checkHookUpdatedInput (full ordering preserved)
 *   - `xCt` @225236572 — checkPermissionRequestUpdatedInput
 *   - `ykr` @227296608 — findPermissionUpdatedInputSchemaIssues
 *   - `cEe` @218734593 — isEmptyPlainObject
 *   - `tHe`/`iHe` @225233125 — filterUnrecognizedKeyIssues / deepStripUnknownKeys
 *   - `S_o` (shown-key merge), `XMt` (shown-value exemption), `lHe`
 *     (source classifier), `b_o` (backfill re-apply), `QMt`/`KMt`
 *     (dropped-key count), `ude` (deny label), `YMt` (schema-failure deny),
 *     `cde` (hook deny builder), `w_o` (check-throw describer),
 *     `Z0e`/`b3`/`jMt` (`__artifact` reserved-key checks)
 *
 * Documented OCC deviations:
 *   - Enforcement is the constant `HOOK_REWRITE_ENFORCED = true`. Official:
 *     `me()||da("tengu_glimmering_newt",{safe:!0})` — a rollout gate whose
 *     `{safe:!0}` option makes it default-on; OCC's gate helper has no such
 *     parameter and returns false when GrowthBook (stubbed) is disabled, so
 *     the constant preserves the shipped behavior.
 *   - `vy(e)` (tool label inside the warn logs) is unresolved in the binary;
 *     `tool.name` is used. Debug-level only, not user-visible.
 *   - `decideLocation:"ask-path"` (official `T_o` spread on PermissionRequest
 *     denies) is not ported — no OCC type/consumer for that field.
 *   - `UMt` (mintsArtifactKeys exemption) is moot: OCC has no
 *     `mintsArtifactKeys` tool surface (grep-verified empty).
 */

/** Official `eHe` (@225233549) — appended to rewrite-denial messages. */
export const HOOK_MODEL_INPUT_VALID_NOTE =
  "The tool input from the model was valid; the hook's rewrite of it was not."

/** Official `BMt` (@225230165). */
const RESERVED_KEY_PREFIX = '__artifact'

/**
 * Official enforcement gate `me()||da("tengu_glimmering_newt",{safe:!0})`
 * (@225233848) — see the deviation note above.
 */
export const HOOK_REWRITE_ENFORCED = true

export type HookRewriteEvent = 'PreToolUse' | 'PermissionRequest'

export interface HookUpdatedInputContext {
  event: HookRewriteEvent
  /** Official `r.source` — hook config source (settings / plugin:x / skill:x). */
  source?: string
  /** Official `r.applies` — false for deny/defer behaviors (head skipped). */
  applies: boolean
  /** Official `r.validate` — the tool's own input validation. */
  validate: (
    input: Record<string, unknown>,
  ) => Promise<ValidationResult | undefined>
  /** Official `r.shown` — the input value actually shown/approved upstream. */
  shown?: Record<string, unknown>
}

export type HookUpdatedInputOutcome =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; deny: PermissionDenyDecision }

interface TelemetryFields {
  keysDropped?: number
  refusedBy?: string
  errorCode?: number
}

/** Official `KMt`. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Official `Z0e`. */
function isReservedArtifactKey(key: string): boolean {
  return key.toLowerCase().startsWith(RESERVED_KEY_PREFIX)
}

/** Official `jMt`. */
function reservedKeyDeny(): PermissionDenyDecision {
  return {
    behavior: 'deny',
    // Byte-verified @225230300 region.
    message: 'Nothing was done. The arguments carry a key that only Claude Code sets.',
    decisionReason: {
      type: 'other',
      reason: 'tool call carried a key only an artifact check mints',
    },
  }
}

/** Official `XMt` — key present in shown AND deep-equal there. */
function isShownValueUnchanged(
  key: string,
  updatedInput: Record<string, unknown>,
  shown: Record<string, unknown> | undefined,
): boolean {
  return (
    shown !== undefined &&
    key !== '__proto__' &&
    Object.hasOwn(shown, key) &&
    Object.hasOwn(updatedInput, key) &&
    isEqual(updatedInput[key], shown[key])
  )
}

/** Official `S_o` — re-merge shown keys the schema dropped unchanged. */
function mergeShownKeys(
  parsed: Record<string, unknown>,
  updatedInput: Record<string, unknown>,
  shown: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (shown === undefined) {
    return parsed
  }
  const merged: Record<string, unknown> = { ...parsed }
  for (const key of Object.keys(shown)) {
    if (!Object.hasOwn(merged, key) && isShownValueUnchanged(key, updatedInput, shown)) {
      merged[key] = shown[key]
    }
  }
  return merged
}

/** Official `lHe` — analytics source classifier. */
function classifyHookSource(source: string | undefined): string | undefined {
  if (source === undefined || source === 'settings') {
    return source
  }
  if (source === 'plugin' || source.startsWith('plugin:')) {
    return 'plugin'
  }
  return source === 'skill' || source.startsWith('skill:') ? 'skill' : 'other'
}

/** Official `b_o` — backfill re-apply on a copy. */
function applyBackfill(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const backfill = tool.backfillObservableInput as
    | ((input: Record<string, unknown>) => void)
    | undefined
  if (!backfill) {
    return input
  }
  const copy: Record<string, unknown> = { ...input }
  backfill(copy)
  return copy
}

/** Official `QMt` — recursive dropped-key count. */
function countDroppedKeys(
  original: unknown,
  cleaned: unknown,
): number {
  if (original === cleaned || !isObjectValue(original) || !isObjectValue(cleaned)) {
    return 0
  }
  let count = 0
  for (const key of Object.keys(original)) {
    count += Object.hasOwn(cleaned, key)
      ? countDroppedKeys(original[key], cleaned[key])
      : 1
  }
  return count
}

interface UnrecognizedKeysIssue {
  code: 'unrecognized_keys'
  keys: PropertyKey[]
  path: PropertyKey[]
}

/** Official `tHe`. */
function filterUnrecognizedKeyIssues(
  issues: ZodIssue[],
): UnrecognizedKeysIssue[] {
  return (Array.isArray(issues) ? issues : []).filter(
    (issue): issue is ZodIssue & UnrecognizedKeysIssue =>
      issue?.code === 'unrecognized_keys' &&
      Array.isArray((issue as { keys?: unknown }).keys) &&
      Array.isArray(issue.path),
  )
}

/** Official `iHe` — copy-on-write deep strip of unknown keys. */
function deepStripUnknownKeys(
  input: Record<string, unknown>,
  issues: UnrecognizedKeysIssue[],
): Record<string, unknown> {
  const root: Record<string, unknown> = { ...input }
  const copied = new Set<unknown>([root])
  for (const issue of issues) {
    let node: Record<string, unknown> | undefined = root
    for (const segment of issue.path) {
      const child = node[segment as string]
      if (!isObjectValue(child)) {
        node = undefined
        break
      }
      if (!copied.has(child)) {
        const clone: unknown = Array.isArray(child)
          ? [...(child as unknown[])]
          : { ...child }
        copied.add(clone)
        node[segment as string] = clone as Record<string, unknown>
      }
      node = node[segment as string] as Record<string, unknown>
    }
    if (node !== undefined) {
      for (const key of issue.keys) {
        delete node[key as string]
      }
    }
  }
  return root
}

/** Official `ude` — deny-message label. */
function hookRewriteLabel(
  tool: Tool,
  context: HookUpdatedInputContext,
): string {
  const sourceSuffix =
    context.source === undefined || context.source === 'settings'
      ? ''
      : ` (${context.source})`
  return `${context.event} hook${sourceSuffix} for ${tool.name}`
}

/** Official `cde` (the `T_o` decideLocation spread is skipped — see header). */
function buildHookRewriteDeny(
  tool: Tool,
  context: HookUpdatedInputContext,
  message: string,
): PermissionDenyDecision {
  return {
    behavior: 'deny',
    message,
    decisionReason: {
      type: 'hook',
      hookName:
        context.event === 'PermissionRequest'
          ? 'PermissionRequest'
          : `PreToolUse:${tool.name}`,
      hookSource: context.source,
      reason: message,
    },
  }
}

/** Official `YMt` — schema-failure deny + warn. */
function buildSchemaFailureDeny(
  tool: Tool,
  context: HookUpdatedInputContext,
  issues: ZodIssue[],
): HookUpdatedInputOutcome {
  const message = `${hookRewriteLabel(tool, context)} returned updatedInput that failed schema validation: ${formatZodValidationError(tool.name, new z.ZodError(issues))}\n${HOOK_MODEL_INPUT_VALID_NOTE}`
  logForDebugging(
    `${context.event} hook's updatedInput for ${tool.name} failed schema validation (${issues.map(issue => issue.code).join(',')})`,
    { level: 'warn' },
  )
  return { ok: false, deny: buildHookRewriteDeny(tool, context, message) }
}

/** Official `w_o` — describer for a throwing tool check. */
function describeCheckThrow(
  tool: Tool,
  context: HookUpdatedInputContext,
  error: unknown,
): string {
  const label = errorMessage(error) || (error instanceof Error ? error.name : undefined)
  if (label === undefined || label === '') {
    logError(
      new Error("the tool's check of a hook's updatedInput threw", {
        cause: toError(error),
      }),
    )
  } else {
    logForDebugging(
      `${context.event} hook's updatedInput for ${tool.name}: the tool's check threw ${label}`,
      { level: 'warn' },
    )
  }
  return errorMessage(error)
}

function logRewriteChecked(
  tool: Tool,
  context: HookUpdatedInputContext,
  fields: TelemetryFields,
): void {
  logEvent('tengu_hook_rewrite_checked', {
    hook_event:
      context.event as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    hook_source: classifyHookSource(
      context.source,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
    keys_dropped: fields.keysDropped,
    refused_by:
      fields.refusedBy as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    refused_error_code: fields.errorCode,
    enforced: HOOK_REWRITE_ENFORCED,
  })
}

/**
 * Official `aHe` @225233390 — validate a hook's `updatedInput` rewrite like
 * Claude's own input. Ordering is byte-faithful:
 * real-schema-issue deny (unconditional) → applies early-return →
 * `__artifact` reserved-key pre-check → deep unknown-key strip + re-parse →
 * shown-key merge → tool validate + backfill → dropped-key warn.
 */
export async function checkHookUpdatedInput(
  tool: Tool,
  updatedInput: Record<string, unknown>,
  context: HookUpdatedInputContext,
): Promise<HookUpdatedInputOutcome> {
  const schema = tool.inputSchema as unknown as z.ZodType
  let parsed = schema.safeParse(updatedInput)
  if (!parsed.success) {
    const realIssues = parsed.error.issues.filter(
      issue => issue.code !== 'unrecognized_keys',
    )
    if (realIssues.length > 0) {
      return buildSchemaFailureDeny(tool, context, realIssues)
    }
  }
  if (!context.applies) {
    return { ok: true, input: updatedInput }
  }
  const enforced = HOOK_REWRITE_ENFORCED
  const reserved =
    enforced &&
    Object.keys(updatedInput).some(
      key => isReservedArtifactKey(key) && !isShownValueUnchanged(key, updatedInput, context.shown),
    )
      ? reservedKeyDeny()
      : null
  if (reserved !== null) {
    logRewriteChecked(tool, context, { refusedBy: 'reserved_key' })
    logForDebugging(
      `${context.event} hook's updatedInput for ${tool.name} was refused for a reserved key`,
      { level: 'warn' },
    )
    const head = `${hookRewriteLabel(tool, context)} returned updatedInput with a key starting with "${RESERVED_KEY_PREFIX}" (in any letter case)`
    return {
      ok: false,
      deny:
        context.event === 'PermissionRequest'
          ? buildHookRewriteDeny(
              tool,
              context,
              `${head} that Claude Code did not set, or did not set to that value. Only Claude Code sets such keys: send one back unchanged, and add none. The tool was not run.\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
            )
          : {
              ...reserved,
              message: `${head}. Only Claude Code sets such keys. Remove the key from updatedInput. The tool was not run.`,
            },
    }
  }
  if (!parsed.success) {
    parsed = schema.safeParse(
      deepStripUnknownKeys(
        updatedInput,
        filterUnrecognizedKeyIssues(parsed.error.issues),
      ),
    )
    if (!parsed.success) {
      logRewriteChecked(tool, context, { refusedBy: 'schema' })
      return enforced
        ? buildSchemaFailureDeny(tool, context, parsed.error.issues)
        : { ok: true, input: updatedInput }
    }
  }
  const parsedData = parsed.data as Record<string, unknown>
  let cleaned = mergeShownKeys(parsedData, updatedInput, context.shown)
  let validation: ValidationResult | undefined
  let checkThrow: string | undefined
  try {
    validation = enforced ? await context.validate(parsedData) : undefined
    cleaned = applyBackfill(tool, cleaned)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    checkThrow = describeCheckThrow(tool, context, error)
  }
  const keysDropped = countDroppedKeys(updatedInput, cleaned)
  if (validation?.result === false) {
    logRewriteChecked(tool, context, {
      keysDropped,
      refusedBy: 'tool',
      errorCode: validation.errorCode,
    })
    logForDebugging(
      `${context.event} hook's updatedInput for ${tool.name} was refused by the tool (code=${validation.errorCode})`,
      { level: 'warn' },
    )
    return {
      ok: false,
      deny: buildHookRewriteDeny(
        tool,
        context,
        `${hookRewriteLabel(tool, context)} returned updatedInput that the tool refused: ${validation.message}\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
      ),
    }
  }
  if (enforced && checkThrow !== undefined) {
    logRewriteChecked(tool, context, { keysDropped, refusedBy: 'check_threw' })
    return {
      ok: false,
      deny: buildHookRewriteDeny(
        tool,
        context,
        `${hookRewriteLabel(tool, context)} returned updatedInput that the tool could not check: ${checkThrow}\nThe tool input from the model was valid.`,
      ),
    }
  }
  if (keysDropped > 0) {
    logRewriteChecked(tool, context, { keysDropped })
    logForDebugging(
      `${context.event} hook's updatedInput for ${tool.name}: ${enforced ? 'dropped' : 'kept'} ${keysDropped} key(s) that the tool's schema does not know`,
      { level: 'warn' },
    )
  }
  return { ok: true, input: enforced ? cleaned : updatedInput }
}

/**
 * Official `xCt` @225236572 — PermissionRequest entry: undefined/empty pass
 * through; deep-equal to the shown input returns the ORIGINAL shown object;
 * otherwise the full `aHe` check with the shown input as exemption base.
 */
export async function checkPermissionRequestUpdatedInput(
  tool: Tool,
  updatedInput: Record<string, unknown> | undefined,
  shownInput: Record<string, unknown>,
  validate: (
    input: Record<string, unknown>,
  ) => Promise<ValidationResult | undefined>,
): Promise<{
  input?: Record<string, unknown>
  deny?: PermissionDenyDecision
}> {
  if (updatedInput === undefined || Object.keys(updatedInput).length === 0) {
    return { input: updatedInput }
  }
  if (isEqual(updatedInput, shownInput)) {
    return { input: shownInput }
  }
  const outcome = await checkHookUpdatedInput(tool, updatedInput, {
    event: 'PermissionRequest',
    applies: true,
    validate,
    shown: shownInput,
  })
  return outcome.ok ? { input: outcome.input } : { deny: outcome.deny }
}

/**
 * Official `ykr` @227296608 — the tool-execution chokepoint parse: unknown
 * keys are TOLERATED here (stripping lives in `aHe` at the hook sites); only
 * real schema issues deny.
 */
export function findPermissionUpdatedInputSchemaIssues(
  schema: z.ZodType,
  updatedInput: unknown,
): ZodIssue[] | null {
  const result = schema.safeParse(updatedInput)
  if (result.success) {
    return null
  }
  const realIssues = result.error.issues.filter(
    issue => issue.code !== 'unrecognized_keys',
  )
  return realIssues.length > 0 ? realIssues : null
}

/** Official `cEe` @218734593 — empty plain object check. */
export function isEmptyPlainObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}
