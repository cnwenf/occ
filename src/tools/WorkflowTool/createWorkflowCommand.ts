/**
 * K3 (2.1.154): Workflow command descriptors.
 *
 * Mirrors the 2.1.200 binary's getWorkflowCommands() — returns built-in
 * workflow command descriptors (one per bundled workflow). These appear as
 * slash commands (e.g. /code-review) that map to a bundled workflow script.
 *
 * For OCC's reconstruction, there are no bundled workflows yet (users add
 * scripts to .claude/workflows/), so this returns an empty array. Wired for
 * future bundled workflows.
 */
import type { Command } from '../../commands.js'

/**
 * Get built-in workflow command descriptors. Called by src/commands.ts
 * when feature('WORKFLOW_SCRIPTS') is enabled. Returns one Command per
 * bundled workflow (empty for now).
 */
export async function getWorkflowCommands(
  _cwd?: string,
): Promise<Command[]> {
  // No bundled workflow commands yet. User-defined workflows are discovered
  // from .claude/workflows/ by workflowDiscovery.ts and run via the Workflow
  // tool directly (not as slash commands).
  return []
}
