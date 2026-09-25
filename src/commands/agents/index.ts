import type { Command } from '../../commands.js'

// 2.1.198: the /agents wizard was removed. This is the slash-command stub only
// — the `claude agents` CLI subcommand (background-session dashboard) is a
// separate workstream and is not affected here.
// 2.1.281 #150: the stub is hidden from the command menu and /help
// (isHidden); typing /agents by exact name still resolves and prints the
// "(removed)" explanation (commandSuggestions.ts exact-name fallback).
const agents = {
  type: 'local',
  name: 'agents',
  description: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/',
  isHidden: true,
  supportsNonInteractive: true,
  load: () => import('./agents.js'),
} satisfies Command

export default agents
