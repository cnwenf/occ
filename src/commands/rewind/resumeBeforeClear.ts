import { getSessionId } from '../../bootstrap/state.js'
import type { LogOption } from '../../types/logs.js'
import { sortLogs } from '../../types/logs.js'
import {
  fetchLogs,
  getTranscriptPathForSession,
  loadFullLog,
  loadTranscriptFile,
} from '../../utils/sessionStorage.js'

/**
 * claude-code 2.1.191: /rewind can resume from BEFORE a /clear.
 *
 * /clear starts a fresh session (regenerateSessionId) but leaves the pre-clear
 * conversation on disk as a separate session file. These helpers locate that
 * previous session — the most-recently-modified session that is NOT the
 * current one — so /rewind can offer it as the "previous-session entry at the
 * top" and restore the pre-/clear conversation on demand (hydrate-on-load).
 */

/**
 * Find the most recent prior session (the pre-/clear conversation).
 * This is the entry /rewind shows at the top of the message selector.
 */
export async function findPreClearSession(
  limit?: number,
): Promise<LogOption | null> {
  const current = getSessionId()
  const logs = sortLogs(await fetchLogs(limit))
  // The first entry that isn't the current session is the previous-session
  // entry /rewind surfaces for resume-from-before-clear.
  return logs.find((l) => l.sessionId && l.sessionId !== current) ?? null
}

/**
 * Hydrate the pre-/clear conversation messages on demand.
 * Lite logs (metadata-only) are upgraded to full logs lazily here.
 */
export async function loadPreClearMessages(
  log?: LogOption | null,
): Promise<LogOption | null> {
  const target = log ?? (await findPreClearSession())
  if (!target) return null
  if (!target.isLite) return target
  return loadFullLog(target)
}

/** Resolve the transcript file path for a pre-clear session. */
export function preClearTranscriptPath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId)
}

/**
 * Read the raw pre-clear transcript entries for /rewind restore.
 * Returns the parentUuid-keyed message map (same shape loadTranscriptFile
 * yields for the message selector's restore path).
 */
export async function readPreClearTranscript(
  sessionId: string,
): Promise<{ messages: Map<string, unknown> } | null> {
  const path = getTranscriptPathForSession(sessionId)
  try {
    const result = await loadTranscriptFile(path)
    return { messages: result.messages as Map<string, unknown> }
  } catch {
    return null
  }
}

/**
 * Resume from before /clear: locate the pre-clear session and hydrate its
 * messages so /rewind can restore the pre-/clear conversation. Returns null
 * when there is no prior session to restore (e.g. /clear was never run).
 */
export async function resumeFromBeforeClear(): Promise<LogOption | null> {
  const pre = await findPreClearSession()
  if (!pre) return null
  return loadPreClearMessages(pre)
}
