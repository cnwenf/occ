import { logEvent } from 'src/services/analytics/index.js'
import { getSessionId, setCwdState } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'

/**
 * CC 2.1.281 changelog #028 — headless turn survives a deleted working
 * directory.
 *
 * Byte-verified against the official v2.1.281 linux-x64 ELF @215939600-
 * 215941150 (`kh`/`vh` sync+async turn wrappers → `bh` recovery handler;
 * `h6t` MissingWorkingDirectoryError; message fn `sVn` @206503737; markers
 * "the turn starts pinned to it" v280=0/v281=2 and "no longer exists; shell
 * commands cannot start there" v280=0/v281=2):
 *
 *   function bh(e,r){if(!(e instanceof h6t))throw e;
 *     r.setCwd(e.path),BDt(e.path),
 *     t(`[headless] working directory ${e.path} no longer exists; the turn
 *        starts pinned to it`,{level:"warn"});
 *     let n=axn.of(r); if(n.pinned)return; n.pinned=!0;
 *     try{i("tengu_shell_set_cwd",{success:!1,missing_at_turn:!0})}catch{}
 *     let s=Ag(r)?"":` ${e.path}`;
 *     return Ps(Wt(`The session's working directory${s} no longer exists;
 *       shell commands cannot start there and relative file paths that use it
 *       will fail until it is restored.`,"warning"))}
 *
 * Pre-v281 behavior (OCC today): `setCwd(cwd)` at the headless turn entry
 * (QueryEngine.submitMessage) calls realpathSync, which throws ENOENT when
 * the directory was deleted between turns (e.g. a temp dir cleanup) — the
 * whole turn dies. Official v281 recovers instead: re-pin the session cwd to
 * the (missing) path via the STATE setter (no realpath validation), warn at
 * `warn` level, fire `tengu_shell_set_cwd {success:false,missing_at_turn:true}`
 * ONCE per session, and inject a session-once user-visible warning message.
 *
 * The once-per-session pinned flag is module-level keyed by session id —
 * QueryEngine.ask() constructs a NEW QueryEngine per call, so an instance
 * field would fire the telemetry/warning on every turn (official `axn` is a
 * per-session weak store).
 */

/** Official `sVn(e)` @206503737 (message byte-exact). */
export function cwdMissingMessage(path: string): string {
  return `working directory no longer exists or is not accessible: ${path}`
}

/**
 * OCC's CwdDeletedError — the typed signal the turn wrappers recover on
 * (official `h6t` / MissingWorkingDirectoryError). Its constructor message is
 * the official `sVn` text; note the DETECTED throw comes from utils/Shell.ts
 * setCwd (`Path "<p>" does not exist` — byte-identical to the official `h6t`
 * constructor message), which `toCwdDeletedError` converts.
 */
export class CwdDeletedError extends Error {
  readonly path: string

  constructor(path: string) {
    super(cwdMissingMessage(path))
    this.name = 'CwdDeletedError'
    this.path = path
  }
}

/**
 * Convert the raw setCwd/realpath failure into a CwdDeletedError, or null
 * when the error is NOT a missing-cwd failure (caller must rethrow those —
 * official `bh` rethrows anything that isn't `h6t`).
 */
export function toCwdDeletedError(
  error: unknown,
  cwd: string,
): CwdDeletedError | null {
  if (error instanceof CwdDeletedError) return error
  if (
    error instanceof Error &&
    error.message === `Path "${cwd}" does not exist`
  ) {
    const converted = new CwdDeletedError(cwd)
    converted.cause = error
    return converted
  }
  return null
}

// Session-once pinned flags (official `axn` per-session store).
const pinnedSessions = new Set<string>()

/** Test-only: clear the once-per-session pinned flags. */
export function resetCwdTurnRecoveryForTesting(): void {
  pinnedSessions.clear()
}

/**
 * Official `bh` body. Re-pins the cwd, always logs the warn line; the
 * telemetry event + returned user-visible warning text fire ONCE per session
 * (null on later turns — the caller then injects nothing).
 */
export function recoverCwdDeletedAtTurnStart(
  error: CwdDeletedError,
  sessionKey: string = getSessionId(),
): string | null {
  const path = error.path
  // Re-pin via the session-state setter — setCwdState skips the realpath
  // validation that threw (official `r.setCwd(e.path)`).
  setCwdState(path)
  logForDebugging(
    `[headless] working directory ${path} no longer exists; the turn starts pinned to it`,
    { level: 'warn' },
  )
  if (pinnedSessions.has(sessionKey)) return null
  pinnedSessions.add(sessionKey)
  try {
    logEvent('tengu_shell_set_cwd', { success: false, missing_at_turn: true })
  } catch {
    // Analytics must never break the recovery (official try{}catch{}).
  }
  // Official `s=Ag(r)?"":` ${e.path}`` — shell-mode sessions omit the path.
  // OCC headless has no shell mode, so the path is always included.
  return `The session's working directory ${path} no longer exists; shell commands cannot start there and relative file paths that use it will fail until it is restored.`
}
