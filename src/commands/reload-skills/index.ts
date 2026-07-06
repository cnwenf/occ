/**
 * /reload-skills command - minimal metadata only.
 * Implementation is lazy-loaded from reload-skills.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Pick up skills added or changed on disk during this session',
  supportsNonInteractive: true,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
