import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getUserContext } from '../context.js'
import { resetGetMemoryFilesCache } from '../utils/claudemd.js'
import {
  isMemoryLoadingPaused,
  setMemoryLoadingPaused,
} from '../bootstrap/state.js'

const call: LocalCommandCall = async () => {
  const newState = !isMemoryLoadingPaused()
  setMemoryLoadingPaused(newState)

  // Clear cached context so the next query re-evaluates with the new flag.
  getUserContext.cache.clear?.()
  resetGetMemoryFilesCache('session_start')

  return {
    type: 'text',
    value: newState
      ? 'Memory loading paused. CLAUDE.md and memory files will not be injected into context. Use /pause-memory again to resume.'
      : 'Memory loading resumed. CLAUDE.md and memory files will be injected into context on the next query.',
  }
}

const pauseMemory = {
  type: 'local',
  name: 'pause-memory',
  description: 'Pause or resume loading CLAUDE.md and memory files into context',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default pauseMemory
