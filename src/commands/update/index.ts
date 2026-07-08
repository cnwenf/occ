/**
 * /update command - minimal metadata only.
 * Implementation is lazy-loaded from update.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const update = {
  type: 'local',
  name: 'update',
  description: 'Update OCC to the latest version',
  supportsNonInteractive: true,
  load: () => import('./update.js'),
} satisfies Command

export default update
