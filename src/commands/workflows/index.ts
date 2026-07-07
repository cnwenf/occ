// K3 (2.1.154): /workflows command — "Browse running and completed workflows".
//
// Mirrors the official 2.1.200 binary command descriptor verbatim:
//   name:"workflows",aliases:[],description:"Browse running and completed
//   workflows",isEnabled:()=>CE(),immediate:!0
// CE() is the runtime workflows-enabled gate (isWorkflowsEnabled).
import type { Command } from '../../commands.js'
import { isWorkflowsEnabled } from '../../utils/effort/workflowDiscovery.js'

export default {
  type: 'local-jsx',
  name: 'workflows',
  aliases: [],
  description: 'Browse running and completed workflows',
  isEnabled: () => isWorkflowsEnabled(),
  immediate: true,
  load: () => import('./workflows.js'),
} satisfies Command
