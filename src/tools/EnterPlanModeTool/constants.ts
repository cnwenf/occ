export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'

/**
 * CC 2.1.218 #31: plan mode with auto — no longer prompts for Bash commands
 * the static analyzer can't prove read-only; auto takes them.
 *
 * When this flag is enabled and the user enters plan mode with auto-mode
 * active, bash commands that can't be proven read-only by the static
 * analyzer are auto-handled by the classifier instead of opening a dialog.
 *
 * Binary evidence:
 *   - "static analysis does" — the official binary's bash static analyzer
 *     determines read-only status; unprovable commands previously prompted.
 */
export const PLAN_MODE_AUTO_BASH_HANDLING_ENABLED = true
