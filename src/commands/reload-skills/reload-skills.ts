import { getProjectRoot } from '../../bootstrap/state.js'
import { clearCommandsCache, getCommands } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

/**
 * /reload-skills — re-scan the skills directories and reload skills mid-session.
 *
 * Clears the memoized command/skill caches (so the next getCommands() call
 * re-reads disk), then eagerly reloads for the current project root and reports
 * the count. Mirrors the official 2.1.105 /reload-skills command.
 */
export const call: LocalCommandCall = async () => {
  const cwd = getProjectRoot()
  clearCommandsCache()
  const commands = await getCommands(cwd)
  const skillCount = commands.filter(
    c => c.type === 'prompt' && c.source !== 'builtin',
  ).length
  const noun = skillCount === 1 ? 'skill' : 'skills'
  return { type: 'text', value: `Reloaded skills: ${skillCount} ${noun}` }
}
