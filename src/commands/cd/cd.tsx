import { CdDirectoryPicker } from './CdDirectoryPicker.js'
import { performCd } from './cdLogic.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * /cd <path> — move the session to a new working directory.
 *
 * With no args, offers a directory picker with debounced path suggestions,
 * matching /add-dir's picker UX (claude-code 2.1.206 #1). With a path,
 * resolves and applies it directly.
 *
 * Resolves the path (relative to the current cwd), validates it is an existing
 * directory, then updates process.cwd() and the session CWD state so
 * subsequent tool calls and skill/command discovery use the new location.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmed = (args ?? '').trim()
  if (!trimmed) {
    // 2.1.206 #1: /cd with no args offers directory path suggestions,
    // matching /add-dir's picker UX.
    return <CdDirectoryPicker onDone={onDone} />
  }

  const result = performCd(trimmed)
  if (result.ok) {
    onDone(result.message, { display: 'system' })
  } else {
    onDone(result.error, { display: 'system' })
  }
  return null
}
