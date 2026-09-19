/**
 * Stop-hook summary sanitizer — port of the official Claude Code 2.1.277
 * `s$e` / `T5e` / `XG` / `HEe` cluster (v277 binary @202102832; all four are
 * new in v277 — v276 folds/renders raw fields).
 *
 * CC 2.1.278 changelog (D12): "Fixed a crash when resuming a session whose
 * saved history contains a stop-hook summary without a well-formed hook
 * list". A transcript row whose `hookInfos` / `hookErrors` / `hookCount` /
 * `hookLabel` fields are missing or malformed (corrupted JSONL, older or
 * foreign writer) crashed every consumer that trusted the shape:
 * - the PreToolUse absorb fold (`hookInfos.reduce(...)`, `hookCount +=`)
 * - the labeled-summary fold (`flatMap(m => m.hookErrors)`, `Math.max(...)`)
 * - the renderer (`hookErrors.length`, `hookInfos.reduce(...)`)
 *
 * The official fix validates EACH field with a Zod `safeParse` and rebuilds a
 * summary object that always carries safe defaults:
 * - `hookCount`    — int ≥ 0, else falls back to the sanitized hookInfos length
 * - `hookInfos`    — array filtered to `{command: string, promptText?: string,
 *                    durationMs?: number}` entries (same-reference fast path
 *                    when every entry already passes — official `HEe`)
 * - `hookErrors`   — array filtered to strings
 * - `hookAdditionalContext` — only present when the input field is an array
 *                    (then filtered to strings)
 * - `preventedContinuation` — boolean `true` only when the input is a valid
 *                    boolean true (everything else coerces to false)
 * - `stopReason`   — included only when a valid string
 * - `hookLabel`    — included only when a valid NON-EMPTY string (official
 *                    `T5e` — `z.string().min(1)`); grouping/predicate sites
 *                    key off this, so a `hookLabel: 42` row is treated as
 *                    unlabeled rather than crashing the label comparisons
 * - `totalDurationMs` — included only when a valid number
 *
 * Applied at ALL THREE official sites: the PreToolUse absorb fold
 * (collapseReadSearch.ts), the labeled-summary fold (collapseHookSummaries.ts)
 * and the renderer (SystemTextMessage.tsx `StopHookSummaryMessage`).
 *
 * Like the official, filtering keeps the ORIGINAL block references (the Zod
 * parse result is only consulted for `.success`) — extra fields on a
 * well-formed hookInfo survive untouched.
 */
import { z } from 'zod'
import type { StopHookInfo } from '../types/message.js'

/** Official `c2o` — `z.object({command: z.string(), promptText: z.string().optional(), durationMs: z.number().optional()})`. */
const hookInfoSchema = z.object({
  command: z.string(),
  promptText: z.string().optional(),
  durationMs: z.number().optional(),
})
/** Official `BEe` — `z.string()`. */
const stringSchema = z.string()
/** Official `d2o` — `z.string().min(1)`. */
const nonEmptyStringSchema = z.string().min(1)
/** Official `u2o` — `z.number().int().nonnegative()`. */
const nonNegativeIntSchema = z.number().int().nonnegative()
/** Official `f2o` — `z.number()`. */
const numberSchema = z.number()
/** Official `p2o` — `z.boolean()`. */
const booleanSchema = z.boolean()

/** Official `XG(e,n){return n.safeParse(e).success}`. */
function passesSchema(value: unknown, schema: z.ZodType): boolean {
  return schema.safeParse(value).success
}

/**
 * Official `HEe(e,n)`: non-array → `[]`; every entry valid → the ORIGINAL
 * array reference (fast path, keeps referential memo stability); else the
 * filtered array.
 */
export function filterBySchema<T>(value: unknown, schema: z.ZodType): T[] {
  if (!Array.isArray(value)) return []
  const isValid = (item: unknown): boolean => passesSchema(item, schema)
  return (value.every(isValid) ? value : value.filter(isValid)) as T[]
}

/** Loose structural input — every field the official `s$e` reads, as unknown. */
export interface StopHookSummaryLike {
  hookCount?: unknown
  hookInfos?: unknown
  hookErrors?: unknown
  hookAdditionalContext?: unknown
  preventedContinuation?: unknown
  stopReason?: unknown
  hookLabel?: unknown
  totalDurationMs?: unknown
}

/** The always-safe output shape of `sanitizeStopHookSummary` (official `s$e` return). */
export interface SanitizedStopHookSummary {
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  hookAdditionalContext?: string[]
  preventedContinuation: boolean
  stopReason?: string
  hookLabel?: string
  totalDurationMs?: number
}

/**
 * Official `T5e(e){return XG(e.hookLabel,d2o())?e.hookLabel:void 0}` — the
 * hookLabel only survives when it is a non-empty string. Exported because the
 * official uses it standalone in the labeled-summary predicate/grouping
 * (`Xot(h){...&&T5e(h)!==void 0}` and `T5e(we)!==ee`).
 */
export function sanitizeHookLabel(
  message: StopHookSummaryLike,
): string | undefined {
  return passesSchema(message.hookLabel, nonEmptyStringSchema)
    ? (message.hookLabel as string)
    : undefined
}

/** Official `s$e` — per-field Zod safeParse rebuild of a stop-hook summary. */
export function sanitizeStopHookSummary(
  message: StopHookSummaryLike,
): SanitizedStopHookSummary {
  const hookInfos = filterBySchema<StopHookInfo>(message.hookInfos, hookInfoSchema)
  const hookLabel = sanitizeHookLabel(message)
  return {
    hookCount: passesSchema(message.hookCount, nonNegativeIntSchema)
      ? (message.hookCount as number)
      : hookInfos.length,
    hookInfos,
    hookErrors: filterBySchema<string>(message.hookErrors, stringSchema),
    ...(Array.isArray(message.hookAdditionalContext) && {
      hookAdditionalContext: filterBySchema<string>(
        message.hookAdditionalContext,
        stringSchema,
      ),
    }),
    preventedContinuation:
      passesSchema(message.preventedContinuation, booleanSchema) &&
      (message.preventedContinuation as boolean),
    ...(passesSchema(message.stopReason, stringSchema) && {
      stopReason: message.stopReason as string,
    }),
    ...(hookLabel !== undefined && { hookLabel }),
    ...(passesSchema(message.totalDurationMs, numberSchema) && {
      totalDurationMs: message.totalDurationMs as number,
    }),
  }
}
