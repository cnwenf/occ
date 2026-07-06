/**
 * /autocompact command - minimal metadata only.
 * Implementation is lazy-loaded from autocompact.tsx to reduce startup time.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// Official 2.1.200 gates the interactive /autocompact on isInteractive &&
// !isNonInteractive. OCC uses !getIsNonInteractiveSession() (same as /config).
const autocompact = {
  type: 'local-jsx',
  name: 'autocompact',
  description: 'Set how full the context gets before auto-summarizing',
  isEnabled: () => !getIsNonInteractiveSession(),
  argumentHint: '[auto|<tokens>]',
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
