/**
 * /background command - minimal metadata only.
 * Implementation is lazy-loaded from background.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const background = {
  type: 'local',
  name: 'background',
  description: 'Move the current task to a background daemon worker',
  supportsNonInteractive: false,
  load: () => import('./background.js'),
} satisfies Command

export default background
