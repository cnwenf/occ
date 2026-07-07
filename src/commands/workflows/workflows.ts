/**
 * K3 (2.1.154): /workflows command implementation. Lists discovered workflows
 * (from .claude/workflows/ + ~/.claude/workflows/) alongside any running/
 * completed dynamic-workflow runs (local_workflow tasks in the background
 * task registry).
 *
 * Mirrors the 2.1.200 binary's DAc component (which renders a React/Ink
 * dialog). For OCC's reconstruction, this returns a formatted string
 * (a valid ReactNode for local-jsx) showing available scripts + runs.
 *
 * Runs are queried from appState.tasks filtered to type==='local_workflow'
 * (the same registry backing the Stop-hook background_tasks, D7).
 */
import type { LocalJSXCommandCall } from '../../types/command.js'
import { discoverWorkflows } from '../../utils/effort/workflowDiscovery.js'
import { isLocalWorkflowTask, type LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { logEvent } from '../../services/analytics/index.js'

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

/**
 * Format running/completed workflow runs from the background task registry.
 * Queries appState.tasks filtered to type==='local_workflow'.
 */
function formatRuns(tasks: Record<string, unknown> | undefined): string {
  if (!tasks) {
    return 'No running or completed dynamic workflows in this session.'
  }
  const runs = Object.values(tasks).filter(isLocalWorkflowTask) as LocalWorkflowTaskState[]
  if (runs.length === 0) {
    return 'No running or completed dynamic workflows in this session.'
  }
  const lines: string[] = ['Workflow runs:']
  for (const run of runs) {
    const name = run.workflowName ?? run.description ?? 'workflow'
    const runId = run.workflowRunId ?? run.id
    const status = run.status
    const agents = run.agentCount ?? 0
    const tokens = run.totalTokens ?? 0
    const phaseInfo =
      run.workflowProgress && run.workflowProgress.length > 0
        ? ` [phases: ${run.workflowProgress.map(p => `${p.phase}(${p.completedAgents})`).join(', ')}]`
        : ''
    lines.push(
      `  - ${name} (${status}) runId=${runId} agents=${agents} tokens=${tokens}${phaseInfo}`,
    )
  }
  return lines.join('\n')
}

export const call: LocalJSXCommandCall = (onDone, context, _args): Promise<null> => {
  logEvent('workflow-history-dialog', {} as never)
  const workflows = discoverWorkflows()
  // Query the background task registry (same as Stop-hook background_tasks).
  const appState = context.getAppState()
  const tasks = appState?.tasks as Record<string, unknown> | undefined
  const message = [formatWorkflows(workflows), formatRuns(tasks)].join('\n\n')
  onDone(message)
  return Promise.resolve(null)
}
