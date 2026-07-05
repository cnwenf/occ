import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./config.js'),
} satisfies Command

// Non-interactive (-p) variant: validates/sets key=value pairs. Mirrors the
// official 2.1.200 -p /config behavior (usage on no args; rejects unknown
// keys). See config-noninteractive.ts.
export const configNonInteractive: Command = {
  type: 'local',
  name: 'config',
  description: 'Set config: key=value [key=value ...]',
  supportsNonInteractive: true,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import('./config-noninteractive.js'),
} satisfies Command

export default config
