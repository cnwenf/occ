import type { Command } from '../../commands.js'

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  immediate: true,
  // Official v299 (#033): asking /btw while scrolled up must not yank the
  // transcript back to the bottom (s299 @43745961: `immediate:!0,keepsScrollPosition:!0,argumentHint:"[question]"`).
  keepsScrollPosition: true,
  argumentHint: '[question]',
  load: () => import('./btw.js'),
} satisfies Command

export default btw
