/**
 * /daemon command - minimal metadata only.
 * Implementation is lazy-loaded from daemon.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const daemon = {
  type: 'local',
  name: 'daemon',
  description: 'Manage the background-agent daemon (install|status|stop|logs|scheduled)',
  argumentHint: '<subcommand>',
  supportsNonInteractive: true,
  load: () => import('./daemon.js'),
} satisfies Command

export default daemon
