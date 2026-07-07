import type { Command } from '../../commands.js'

/**
 * /tui — set the terminal UI renderer (default | fullscreen).
 *
 * 2.1.110: persists the `tui` setting ("default" | "fullscreen") to
 * userSettings. "fullscreen" selects the flicker-free alt-screen renderer
 * (equivalent to CLAUDE_CODE_NO_FLICKER=1); "default" selects the classic
 * main-screen renderer. The setting applies to sessions started directly with
 * `claude` and takes effect on the next session start.
 *
 * Description / argumentHint verified against the 2.1.200 binary:
 *   name:"tui",description:"Set the terminal UI renderer (default | fullscreen)"
 *   argumentHint:"[default|fullscreen]"
 */
const tui = {
  type: 'local-jsx',
  name: 'tui',
  description: 'Set the terminal UI renderer (default | fullscreen)',
  argumentHint: '[default|fullscreen]',
  load: () => import('./tui.js'),
} satisfies Command

export default tui
