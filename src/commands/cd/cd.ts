import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * /cd <path> — move the session to a new working directory.
 *
 * Resolves the path (relative to the current cwd), validates it is an existing
 * directory, then updates process.cwd() and the session CWD state so subsequent
 * tool calls and skill/command discovery use the new location.
 *
 * Mirrors the official 2.1.169 /cd command. The official also has a
 * worktree/cwd-move mechanism; this implements the direct path-move variant.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmed = (args ?? '').trim()
  if (!trimmed) {
    onDone('Usage: /cd <path>', { display: 'system' })
    return null
  }

  const target = resolve(trimmed)
  let physical: string
  try {
    physical = realpathSync(target)
  } catch {
    onDone(`Directory does not exist: ${target}`, { display: 'system' })
    return null
  }

  let isDir = false
  try {
    isDir = statSync(physical).isDirectory()
  } catch {
    // fall through to the not-a-directory error below
  }
  if (!isDir) {
    onDone(`Not a directory: ${target}`, { display: 'system' })
    return null
  }

  try {
    process.chdir(physical)
    setCwdState(physical)
    setOriginalCwd(physical)
    setProjectRoot(physical)
    // Commands/skills are memoized by cwd — clear so the new directory's
    // skills are discovered on the next getCommands() call.
    clearCommandsCache()
  } catch (e) {
    onDone(`Failed to change directory: ${(e as Error).message}`, {
      display: 'system',
    })
    return null
  }

  onDone(`Moved session to ${physical}`, { display: 'system' })
  return null
}
