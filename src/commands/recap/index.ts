/**
 * /recap command - minimal metadata only.
 * Implementation is lazy-loaded from recap.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

// Official 2.1.200 gates /recap on the `tengu_sedge_lantern` GrowthBook flag
// (default true). OCC omits the runtime GrowthBook check here so the command is
// always available (the 3P default is true anyway, and calling
// getFeatureValue_CACHED_MAY_BE_STALE inside isEnabled() would fire exposure
// logging on every command-list refresh). isCommandEnabled() defaults to true.
const recap = {
  type: 'local',
  name: 'recap',
  description: 'Generate a one-line session recap now',
  supportsNonInteractive: true,
  load: () => import('./recap.js'),
} satisfies Command

export default recap
