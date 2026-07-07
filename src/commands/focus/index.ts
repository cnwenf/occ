import type { Command } from '../../commands.js'

/**
 * /focus — toggle focus view (just your prompt, summary, and response).
 *
 * 2.1.110: focus view is a fullscreen-renderer-only minimal layout. The command
 * is `immediate` (executes without waiting for a stop point) and toggles the
 * runtime focus-view flag. When the fullscreen renderer isn't active the toggle
 * is refused with the official "needs the fullscreen renderer" hint.
 *
 * Description verified against the 2.1.200 binary:
 *   name:"focus",description:"Toggle focus view: just your prompt, summary, and response",immediate:!0
 */
const focus = {
  type: 'local-jsx',
  name: 'focus',
  description: 'Toggle focus view: just your prompt, summary, and response',
  immediate: true,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
