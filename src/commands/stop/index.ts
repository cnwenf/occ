/**
 * /stop command - minimal metadata only.
 * Implementation is lazy-loaded from stop.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const stop = {
  type: 'local',
  name: 'stop',
  description: 'Stop a background agent/session by ID or pid',
  argumentHint: '[id|pid]',
  supportsNonInteractive: true,
  load: () => import('./stop.js'),
} satisfies Command

export default stop
