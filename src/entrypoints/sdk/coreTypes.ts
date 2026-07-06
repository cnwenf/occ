// SDK Core Types - Common serializable types used by both SDK consumers and SDK builders.
//
// Types are generated from Zod schemas in coreSchemas.ts.
// To modify types:
// 1. Edit Zod schemas in coreSchemas.ts
// 2. Run: bun scripts/generate-sdk-types.ts
//
// Schemas are available in coreSchemas.ts for runtime validation but are not
// part of the public API.

// Re-export sandbox types for SDK consumers
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'
// Re-export all generated types
export * from './coreTypes.generated.js'

// Re-export utility types that can't be expressed as Zod schemas
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// Const arrays for runtime usage
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  // 2.1.152: PostToolBatch fires once after every tool call in a batch has
  // resolved (before the next model request). PostToolUse fires per-tool.
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  // cross-version: UserPromptExpansion fires when a user-typed slash command
  // (or MCP prompt) expands into a prompt, before UserPromptSubmit.
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
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
  // 2.1.152: MessageDisplay fires with each batch of newly completed lines
  // while an assistant message is streamed (display-only, per-flush).
  'MessageDisplay',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
