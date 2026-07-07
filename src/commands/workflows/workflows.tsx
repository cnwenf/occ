/**
 * K3 (2.1.154): /workflows command — opens the interactive
 * WorkflowDetailDialog (a React/Ink selectable-list dialog), NOT a text
 * dump.
 *
 * Mirrors the 2.1.200 binary command descriptor verbatim:
 *   name:"workflows", description:"Browse running and completed workflows",
 *   type:"local-jsx", requires:{ink:true}, immediate:true,
 *   isEnabled:()=>CE()  (CE = isWorkflowsEnabled).
 *
 * The binary's /workflows renders `WorkflowDetailDialog` — a live,
 * auto-refreshing browser of running/completed dynamic-workflow runs
 * grouped by launch type (background/remote), with a detail view for a
 * selected run. OCC ports that component at
 * src/components/WorkflowDetailDialog.tsx; this command simply mounts it
 * and dismisses on its onDone callback.
 *
 * The dialog reads `appState.tasks` filtered to `type === 'local_workflow'`
 * (the same registry backing the Stop-hook background_tasks, D7) and
 * subscribes live, so it updates as the engine progresses runs.
 */
import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { WorkflowDetailDialog } from '../../components/WorkflowDetailDialog.js'
import { logEvent } from '../../services/analytics/index.js'

export const call: LocalJSXCommandCall = (
  onDone,
  _context,
  _args,
): Promise<React.ReactNode> => {
  logEvent('workflow_history_dialog', {} as never)
  return Promise.resolve(<WorkflowDetailDialog onDone={onDone} />)
}
