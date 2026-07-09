import {
  getAdditionalWorkingDirectories,
  getOriginalCwd,
} from '../../bootstrap/state.js'

/**
 * Build the roots list returned to MCP servers via `roots/list`.
 *
 * Includes the session's original cwd plus any additional working
 * directories (added via /add-dir or permission grants). Each root is a
 * `file://` URI. The additional directories are read from the bootstrap
 * singleton that `PermissionUpdate.ts` keeps in sync with
 * `appState.toolPermissionContext.additionalWorkingDirectories`, so this
 * stays correct even though the MCP client lives outside React. (2.1.203)
 */
export function getMcpRoots(): Array<{ uri: string }> {
  const roots: Array<{ uri: string }> = [
    { uri: `file://${getOriginalCwd()}` },
  ]
  for (const dir of getAdditionalWorkingDirectories()) {
    roots.push({ uri: `file://${dir}` })
  }
  return roots
}
