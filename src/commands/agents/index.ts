import type { Command } from '../../commands.js'

// 2.1.198: the /agents wizard was removed. This is the slash-command stub only
// — the `claude agents` CLI subcommand (background-session dashboard) is a
// separate workstream and is not affected here.
const agents = {
  type: 'local',
  name: 'agents',
  description: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/',
  supportsNonInteractive: true,
  load: () => import('./agents.js'),
} satisfies Command

export default agents
