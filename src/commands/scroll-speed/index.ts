/**
 * /scroll-speed command - minimal metadata only.
 * Implementation is lazy-loaded from scroll-speed.tsx to reduce startup time.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// Official 2.1.139 gates /scroll-speed on terminal type (interactive + a
// supported terminal, excluding JetBrains). OCC simplifies to interactive-only.
const scrollSpeed = {
  type: 'local-jsx',
  name: 'scroll-speed',
  description: 'Adjust mouse wheel scroll speed',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./scroll-speed.js'),
} satisfies Command

export default scrollSpeed
