// Re-export runtime values + type stubs for bundling
// Types are erased at runtime, but we need the value exports

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  // 2.1.169: post-session lifecycle hook (self-hosted runner). Fires after
  // the session ends so runner-side cleanup/finalization hooks can run.
  'PostSession',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'MessageDisplay',
  // 2.1.219: fires after /add-dir or the register_repo_root SDK control
  // request registers a new working directory mid-session (after sandbox refresh).
  'DirectoryAdded',
]

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
]
