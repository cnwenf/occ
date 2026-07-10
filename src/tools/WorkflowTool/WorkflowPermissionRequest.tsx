/**
 * K3 (2.1.154): Permission request component for the Workflow tool.
 *
 * Wraps WorkflowPermissionDialog — the pre-run consent dialog that surfaces
 * phase breakdown + script source before a dynamic workflow fans out across
 * multiple subagents. The standard permission prompt cannot show this info,
 * so WorkflowTool.checkPermissions returns { behavior: 'ask' } and the REPL
 * permission overlay dispatches here via permissionComponentForTool().
 *
 * Flow:
 *   1. Model calls Workflow tool (name or scriptPath)
 *   2. checkPermissions resolves the script path → returns { behavior: 'ask' }
 *   3. REPL renders this component (via PermissionRequest.tsx case WorkflowTool)
 *   4. Component loads the script (scriptLoader), renders WorkflowPermissionDialog
 *   5. onAccept/onAcceptAlways → toolUseConfirm.onAllow; onCancel → onReject
 *
 * Mirrors the 2.1.200 binary's consent flow (strings line 473565+).
 */
import * as React from 'react'
import { WorkflowPermissionDialog } from '../../components/WorkflowPermissionDialog.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { logEvent } from '../../services/analytics/index.js'
import { resolveWorkflowScript } from '../../utils/effort/workflowDiscovery.js'
import { loadScript, validateScriptPath } from './scriptLoader.js'

type WorkflowInput = {
  scriptPath?: string
  name?: string
  args?: Record<string, unknown>
  remote?: boolean
} & { [key: string]: unknown }

/**
 * Resolve the on-disk script path from the tool input.
 * - If input.scriptPath is set, validate it (rejects traversal / UNC paths).
 * - Else if input.name is set, discover it via the workflow registry.
 * Returns undefined when neither is available.
 */
function resolveScriptPath(input: WorkflowInput): string | undefined {
  if (input.scriptPath) {
    try {
      return validateScriptPath(input.scriptPath)
    } catch {
      return undefined
    }
  }
  if (input.name) {
    return resolveWorkflowScript(input.name) ?? undefined
  }
  return undefined
}

export function WorkflowPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { toolUseConfirm, onDone } = props
  const input = toolUseConfirm.input as WorkflowInput

  // Remote (async) launches are pre-approved by the user invoking the tool —
  // they cannot reach the Ink renderer, so skip the consent dialog.
  if (input.remote) {
    props.onAllow(input, [], undefined, undefined)
    onDone()
    return null
  }

  const scriptPath = resolveScriptPath(input)
  if (!scriptPath) {
    props.onReject(
      `Could not resolve workflow script${input.name ? ` "${input.name}"` : ''}. Add scripts to .claude/workflows/ (project) or ~/.claude/workflows/ (user).`,
      undefined,
    )
    onDone()
    return null
  }

  let loaded
  try {
    loaded = loadScript(scriptPath)
  } catch (err) {
    props.onReject(
      `Failed to load workflow script: ${(err as Error).message}`,
      undefined,
    )
    onDone()
    return null
  }

  const updatedInput = { ...input, scriptPath: loaded.scriptPath }

  return (
    <WorkflowPermissionDialog
      phases={loaded.meta.phases ?? []}
      scriptSummary={loaded.meta.description}
      scriptSource={loaded.source}
      scriptPath={loaded.scriptPath}
      args={input.args}
      onAccept={() => {
        logEvent('tengu_workflow_permission_accept', {} as never)
        props.onAllow(updatedInput, [], undefined, undefined)
        onDone()
      }}
      onAcceptAlways={() => {
        // TODO: persist a per-workflow allow rule (PermissionUpdate addRules)
        // so this workflow is auto-approved next run. For now, proceeds the
        // same as accept — the consent dialog at least renders + ctrl+g works.
        logEvent('tengu_workflow_permission_accept_always', {} as never)
        props.onAllow(updatedInput, [], undefined, undefined)
        onDone()
      }}
      onCancel={() => {
        logEvent('tengu_workflow_permission_reject', {} as never)
        props.onReject(undefined, undefined)
        onDone()
      }}
    />
  )
}
