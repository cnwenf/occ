/**
 * Fable 5 credits tracking.
 *
 * A simple best-effort counter persisted to `~/.claude/fable-credits.json`.
 * The file shape is `{ used: number, limit: number, lastUpdated: timestamp }`.
 * Every Fable 5 query turn increments `used`; the status indicator shows
 * `limit - used` remaining.
 *
 * All access is best-effort: read/write failures fall back to defaults and
 * never block the model from being used. This is a local counter, not a
 * billing record — it can be reset by deleting the file.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'

export interface FableCredits {
  used: number
  limit: number
  lastUpdated: number
}

/** Default credit allotment for the research preview. */
const DEFAULT_FABLE_CREDITS_LIMIT = 1000
const CREDITS_FILENAME = 'fable-credits.json'

function getCreditsFilePath(): string {
  return join(getClaudeConfigHomeDir(), CREDITS_FILENAME)
}

function getDefaultCredits(): FableCredits {
  return { used: 0, limit: DEFAULT_FABLE_CREDITS_LIMIT, lastUpdated: 0 }
}

/**
 * Read the current Fable 5 credit balance. Returns defaults when the file is
 * missing or unreadable so callers never need to handle failure.
 */
export function getFableCredits(): FableCredits {
  try {
    const path = getCreditsFilePath()
    if (!existsSync(path)) return getDefaultCredits()
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<FableCredits>
    return {
      used: typeof parsed.used === 'number' ? parsed.used : 0,
      limit: typeof parsed.limit === 'number' ? parsed.limit : DEFAULT_FABLE_CREDITS_LIMIT,
      lastUpdated: typeof parsed.lastUpdated === 'number' ? parsed.lastUpdated : 0,
    }
  } catch {
    return getDefaultCredits()
  }
}

/** Remaining credits for the Fable 5 research preview (never negative). */
export function getRemainingFableCredits(): number {
  const { used, limit } = getFableCredits()
  return Math.max(0, limit - used)
}

/**
 * Increment the Fable 5 credit counter by `amount` (default 1). Best-effort:
 * failures are swallowed so a disk error can never block a query.
 */
export function incrementFableCredits(amount = 1): void {
  try {
    const current = getFableCredits()
    const updated: FableCredits = {
      used: current.used + amount,
      limit: current.limit,
      lastUpdated: Date.now(),
    }
    const path = getCreditsFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSyncAndFlush_DEPRECATED(path, JSON.stringify(updated, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch {
    // Best-effort: never block model usage on a credit-counter write failure.
  }
}
