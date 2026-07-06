import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Open a memory file in your editor',
  load: () => import('./memory.js'),
}

export default memory
