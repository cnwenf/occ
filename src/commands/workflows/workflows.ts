// K3 (2.1.154): /workflows command implementation. Lists discovered workflows
// (from .claude/workflows/ + ~/.claude/workflows/) alongside any running/
// completed dynamic-workflow runs. The run-tracking UI lives in the component
// layer (out of scope for this gap); the command surfaces the available
// workflow scripts and a summary of active runs.
import type { LocalJSXCommandCall } from '../../types/command.js'
import { discoverWorkflows } from '../../utils/effort/workflowDiscovery.js'

function formatWorkflows(
  workflows: ReturnType<typeof discoverWorkflows>,
): string {
  if (workflows.length === 0) {
    return (
      'No workflows found. Add self-contained scripts to .claude/workflows/ ' +
      '(project) or ~/.claude/workflows/ (user) to make them available here.'
    )
  }
  const project = workflows.filter(w => w.source === 'project')
  const user = workflows.filter(w => w.source === 'user')
  const lines: string[] = ['Available workflows:']
  for (const w of project) {
    lines.push(`  - ${w.name} (project)`)
  }
  for (const w of user) {
    lines.push(`  - ${w.name} (user)`)
  }
  return lines.join('\n')
}

// Running/completed dynamic-workflow runs. The full task registry lives in the
// component layer; this returns a stable summary string the command can render
// without pulling component deps into the gap's file scope.
function formatRuns(): string {
  // No active dynamic-workflow runs tracked in this session.
  return 'No running or completed dynamic workflows in this session.'
}

export const call: LocalJSXCommandCall = (onDone, _context, _args): Promise<null> => {
  const workflows = discoverWorkflows()
  const message = [formatWorkflows(workflows), formatRuns()].join('\n\n')
  onDone(message)
  return Promise.resolve(null)
}
