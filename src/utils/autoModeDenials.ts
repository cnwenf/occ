/**
 * Tracks commands recently denied by the auto mode classifier.
 * Populated from useCanUseTool.ts, read from RecentDenialsTab.tsx in /permissions.
 *
 * CC 2.1.218 #27: auto mode — the dangerous-rm, background-`&`, and
 * suspicious-Windows-path checks no longer open permission dialogs (auto
 * handles them instead of prompting). The pattern-matching functions below
 * detect these patterns so the auto-mode flow can auto-decide (deny) them
 * without opening a dialog.
 *
 * Binary evidence:
 *   - `if(/(^|[^&])&\s*$/m.test(e))return"background_amp"` — compound type
 *   - `dangerousPatterns` — function name in the official binary
 *   - OCC `findDestructiveCommandBlock` / `findCatastrophicSubstitutionBlock`
 *     already hard-deny catastrophic removals (rm -rf ~ / etc.); the patterns
 *     here cover the broader dangerous-rm set + background-& that previously
 *     forced a dialog in auto mode.
 */

import { feature } from 'src/utils/featureFlags.js'

export type AutoModeDenial = {
  toolName: string
  /** Human-readable description of the denied command (e.g. bash command string) */
  display: string
  reason: string
  timestamp: number
}

let DENIALS: readonly AutoModeDenial[] = []
const MAX_DENIALS = 20

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)]
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS
}

/** Test-only: clear the denials list between tests. */
export function _resetDenialsForTesting(): void {
  DENIALS = []
}

// ---------------------------------------------------------------------------
// CC 2.1.218 #27: auto-mode pattern checks
// ---------------------------------------------------------------------------

/**
 * Detects dangerous `rm -rf` commands targeting the root directory, home
 * directory, or unset variable expansions that could wipe the root.
 *
 * Direction-aligned with the official binary's `dangerousPatterns` rm
 * detection: the `dangerousPatterns` name is binary-verified, but the
 * precise rm regex here is self-drafted (the official's exact pattern is
 * not string-recoverable). OCC's `findDestructiveCommandBlock` /
 * `findCatastrophicSubstitutionBlock` already hard-deny the most
 * catastrophic forms; this catches the broader set that previously
 * prompted a dialog in auto mode.
 */
export function isDangerousRmPattern(command: string): boolean {
  // rm -rf /, rm -rf /*, rm -rf ~/, rm -rf ~
  // rm -rf $HOME, rm -rf $UNSET/* (unset var → root wipe)
  // rm -rf /, rm -rf /*, rm -rf ~/, rm -rf ~
  // rm -rf $HOME, rm -rf $UNSET/* (unset var → root wipe)
  const dangerousRmRegex =
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME\b|\$[A-Z_]+(?:\/|\s|$|\*))/
  return dangerousRmRegex.test(command)
}

/**
 * Detects background process syntax (trailing `&` that is not `&&`).
 * Mirrors the official binary's `background_amp` compound-statement type:
 * `/(^|[^&])&\s*$/m`.
 *
 * In auto mode, background-& commands are auto-decided (denied) instead of
 * opening a permission dialog.
 */
export function isBackgroundAmpPattern(command: string): boolean {
  // Trailing & that is not preceded by another & (which would be &&)
  return /(^|[^&])&\s*$/m.test(command)
}

/**
 * Auto-decide result for a command in auto mode.
 * When `deny` is true, the auto-mode flow should auto-deny the command
 * (recording it as an auto-mode denial) instead of opening a dialog.
 */
export type AutoModeAutoDenyResult = {
  deny: boolean
  reason: string
}

/**
 * CC 2.1.218 #27: In auto mode, dangerous-rm and background-& patterns are
 * auto-decided (denied) instead of opening a permission dialog. This function
 * checks the command against these patterns and returns an auto-deny decision.
 *
 * Called from the auto-mode permission flow in permissions.ts (after the
 * auto-mode branch condition is true, before the classifier call / fail-open),
 * so these patterns don't reach the dialog stage.
 */
export function shouldAutoDenyInAutoMode(
  toolName: string,
  command: string,
): AutoModeAutoDenyResult {
  if (isDangerousRmPattern(command)) {
    const denial: AutoModeDenial = {
      toolName,
      display: command,
      reason: 'dangerous rm pattern auto-denied in auto mode',
      timestamp: Date.now(),
    }
    recordAutoModeDenial(denial)
    return { deny: true, reason: 'dangerous rm pattern' }
  }

  if (isBackgroundAmpPattern(command)) {
    const denial: AutoModeDenial = {
      toolName,
      display: command,
      reason: 'background & pattern auto-denied in auto mode',
      timestamp: Date.now(),
    }
    recordAutoModeDenial(denial)
    return { deny: true, reason: 'background & pattern' }
  }

  return { deny: false, reason: '' }
}
