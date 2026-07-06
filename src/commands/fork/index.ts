import type { Command } from '../../commands.js'

/**
 * claude-code 2.1.118: /fork spawns a background agent that inherits the full
 * conversation. Rather than copying the parent conversation into the fork's
 * session file, /fork writes a `fork-context-ref` POINTER and hydrates the
 * prefix on demand (see ./pointer.ts). Metadata below matches the 2.1.200
 * binary exactly (type / name / description / argumentHint / isEnabled).
 */
const fork = {
  type: 'local-jsx',
  name: 'fork',
  description: 'Spawn a background agent that inherits the full conversation',
  argumentHint: '<directive>',
  // Official isEnabled: () => !Ew() — enabled unless coordinator mode is
  // active. OCC polyfills feature() to false (COORDINATOR_MODE off), so this
  // is true by default; coordinator mode env still disables it.
  isEnabled: () => !process.env.CLAUDE_CODE_COORDINATOR_MODE,
  load: () => import('./fork.js'),
} satisfies Command

export default fork

export {
  writeForkPointer,
  hydrateForkPrefix,
  _clearHydrateCache,
} from './pointer.js'
export type { ForkContextRef, WriteForkPointerArgs } from './pointer.js'
