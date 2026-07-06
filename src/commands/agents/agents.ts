import type { LocalCommandCall } from '../../types/command.js'

// 2.1.198: the /agents wizard was removed. The slash command is now a stub that
// returns a pointer to ask Claude or edit .claude/agents/ directly. Mirrors the
// official Egm call.
export const call: LocalCommandCall = async () => ({
  type: 'text',
  value: `The /agents wizard has been removed.
Ask Claude to create or update subagents for you (e.g. "create a code-reviewer subagent that ..."),
or edit the files directly:
  • .claude/agents/       (this project)
  • ~/.claude/agents/     (all projects)
Docs: https://code.claude.com/docs/en/sub-agents`,
})
