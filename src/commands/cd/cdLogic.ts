import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'

/**
 * /cd logic — shared by the direct-path (with args) and picker (no-args)
 * entry points so both apply the exact same resolution + side effects.
 *
 * Split out of cd.tsx so the picker can validate a selection and report a
 * precise error without duplicating the realpath/stat/chdir sequence.
 * (claude-code 2.1.206 #1)
 */
export type ResolveResult =
  | { ok: true; physical: string }
  | { ok: false; error: string }

/**
 * Resolve a user-provided path to a real, existing directory.
 * No side effects — safe to call for live validation in the picker.
 */
export function resolveDirectoryTarget(target: string): ResolveResult {
  const resolved = resolve(target)
  let physical: string
  try {
    physical = realpathSync(resolved)
  } catch {
    return { ok: false, error: `Directory does not exist: ${resolved}` }
  }
  try {
    if (!statSync(physical).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` }
    }
  } catch {
    return { ok: false, error: `Not a directory: ${resolved}` }
  }
  return { ok: true, physical }
}

export type CdResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

/**
 * Apply a resolved physical directory: update process.cwd() and the
 * session CWD/project-root state, and clear the commands/skills cache so
 * the new directory's skills are discovered on the next getCommands() call.
 */
export function applyDirectoryChange(physical: string): CdResult {
  try {
    process.chdir(physical)
    setCwdState(physical)
    setOriginalCwd(physical)
    setProjectRoot(physical)
    clearCommandsCache()
    return { ok: true, message: `Moved session to ${physical}` }
  } catch (e) {
    return { ok: false, error: `Failed to change directory: ${(e as Error).message}` }
  }
}

/** Resolve + apply in one step. Returns the user-visible message or error. */
export function performCd(target: string): CdResult {
  const resolved = resolveDirectoryTarget(target)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return applyDirectoryChange(resolved.physical)
}
