/**
 * K3 (2.1.154): Bundled workflows entry point.
 *
 * Called by src/tools.ts when feature('WORKFLOW_SCRIPTS') is enabled:
 *   require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
 *
 * Registers any built-in/predefined workflows + returns the tool. The official
 * binary uses this to register built-in workflows like deep-research,
 * code-review, pr-review-artifact, etc. OCC ships ZERO bundled workflows by
 * design (see CLAUDE.md § "Bundled workflows & safe-mode divergences (OCC-31)"
 * — trimmed, not alignment debt; faithfully porting deep-research's minified
 * multi-agent orchestration risks an invented/partial implementation). OCC
 * discovers user-defined workflows from .claude/workflows/ +
 * ~/.claude/workflows/ at runtime instead. This no-op keeps the require()
 * call from throwing while the infrastructure stays wired for future use.
 */

// Built-in workflow registry (empty for now — wired for future bundled
// workflows). Maps name -> script source.
const BUNDLED_WORKFLOWS = new Map()

/**
 * Initialize bundled workflows. Called once at tool-registration time.
 * Returns the bundled-workflow registry (name -> script source).
 */
export function initBundledWorkflows() {
  // No-op: bundled workflows are registered here in the official build.
  // OCC discovers user workflows from .claude/workflows/ at runtime instead.
  return BUNDLED_WORKFLOWS
}

/**
 * Get a bundled workflow by name. Returns the script source or null.
 */
export function getBundledWorkflow(name) {
  return BUNDLED_WORKFLOWS.get(name) ?? null
}

/**
 * List all bundled workflow names.
 */
export function listBundledWorkflows() {
  return Array.from(BUNDLED_WORKFLOWS.keys())
}

export default { initBundledWorkflows, getBundledWorkflow, listBundledWorkflows }
