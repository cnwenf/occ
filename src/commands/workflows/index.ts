// K3 (2.1.154): /workflows command — "Browse running and completed workflows".
//
// Mirrors the official 2.1.200 binary command descriptor verbatim:
//   name:"workflows",aliases:[],description:"Browse running and completed
//   workflows",type:"local-jsx",requires:{ink:!0},immediate:!0,
//   isEnabled:()=>CE()
// CE() is the runtime workflows-enabled gate (isWorkflowsEnabled).
//
// requires:{ink:true} marks the command as needing the interactive Ink UI —
// it is blocked in non-interactive (pipe) mode and renders a React dialog
// (WorkflowDetailDialog) rather than emitting a text result.
import type { Command } from '../../commands.js'
import { isWorkflowsEnabled } from '../../utils/effort/workflowDiscovery.js'

const workflows: Command = {
  type: 'local-jsx',
  name: 'workflows',
  aliases: [],
  description: 'Browse running and completed workflows',
  isEnabled: () => isWorkflowsEnabled(),
  immediate: true,
  requires: { ink: true },
  load: () => import('./workflows.js'),
}

export default workflows
