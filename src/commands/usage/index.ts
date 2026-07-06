import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// 2.1.118: /cost and /stats were merged into /usage as aliases. The single
// /usage command shows session cost, plan usage, and activity stats.
export default {
  type: 'local-jsx',
  name: 'usage',
  aliases: ['cost', 'stats'],
  description: 'Show session cost, plan usage, and activity stats',
  requires: { ink: true },
  load: () => import('./usage.js'),
} satisfies Command

export const usageNonInteractive = {
  type: 'local',
  name: 'usage',
  aliases: ['cost', 'stats'],
  supportsNonInteractive: true,
  description: 'Show session cost, plan usage, and what\'s contributing to your limits',
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./usage-noninteractive.js'),
} satisfies Command
