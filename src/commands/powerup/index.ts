import type { Command } from '../../commands.js'

/**
 * /powerup — discover Claude Code features through quick interactive lessons.
 *
 * 2.1.90: launches the powerup discovery view, a 5-minute tour of core features
 * (modes, undo, @-mentions, teaching Claude your rules). Each lesson emits
 * powerup_lesson_opened / powerup_lesson_completed analytics; the discovery
 * surface emits powerup_discovery_shown.
 *
 * Description verified against the 2.1.200 binary:
 *   name:"powerup",description:"Discover Claude Code features through quick interactive lessons",requires:{ink:!0}
 */
const powerup = {
  type: 'local-jsx',
  name: 'powerup',
  description: 'Discover Claude Code features through quick interactive lessons',
  load: () => import('./powerup.js'),
} satisfies Command

export default powerup
