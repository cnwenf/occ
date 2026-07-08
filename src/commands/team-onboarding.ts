import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

const TEAM_ONBOARDING_PROMPT = `You are guiding the user through setting up an agent team for collaborative multi-agent work in Claude Code.

## Implicit Team Model

Claude Code supports an implicit, lightweight team model — no explicit "team" object exists. Instead, a team is formed at runtime by launching subagents that each carry a stable identity. The key primitives are:

### 1. Agent \`name\` parameter
When the Task/Agent tool spawns a subagent, it accepts a \`name\` parameter. This name:
- Becomes the subagent's identity for the duration of the session.
- Is used as the routing target for inter-agent messaging.
- Should be descriptive and role-oriented (e.g. \`researcher\`, \`implementer\`, \`reviewer\`, \`tester\`).
- Persists after the agent completes a task — a named agent can be resumed with its context intact via SendMessage.

### 2. SendMessage
Teammates communicate by sending messages to each other by name:
- Send to a named teammate: \`SendMessage({ to: "researcher", message: "..." })\`
- Send back to the main conversation: \`SendMessage({ to: "main", message: "..." })\`
- Messages from teammates are delivered automatically; agents do not poll an inbox.
- A send to a completed agent resumes it from its transcript, preserving context.

### 3. Teammate Mode
A subagent running in "teammate" mode:
- Runs in the background by default (the orchestrator is notified on completion).
- Has its own context window and token budget, isolated from the orchestrator.
- Can be given a specialized agent type (via \`subagent_type\`) to constrain its tools and system prompt.
- Coordinates via SendMessage rather than returning a single value.

## Your Task

Walk the user through designing a team for their use case. Ask clarifying questions about:
1. **Goal** — What is the team trying to accomplish?
2. **Roles** — What distinct roles are needed? (e.g. researcher, planner, implementer, reviewer, tester)
3. **Workflow** — How should work flow between roles? (sequential pipeline? parallel fan-out? iterative loop?)
4. **Communication patterns** — What information do teammates need to share, and when?

Then propose a concrete team configuration:
- A roster of named agents, each with: name, role/purpose, recommended subagent_type (or "general-purpose"), and which tools it needs.
- A workflow diagram (text-based) showing how tasks and messages flow between agents.
- The launch sequence — which agents to spawn first, which depend on others.

Keep the proposal practical and tailored to the user's stated goal. Prefer fewer, well-defined roles over many overlapping ones. After presenting the plan, offer to help the user kick off the first task using the proposed team.`

const teamOnboarding = {
  type: 'prompt',
  name: 'team-onboarding',
  description: 'Set up an agent team for collaborative multi-agent work',
  progressMessage: 'setting up your agent team',
  contentLength: TEAM_ONBOARDING_PROMPT.length,
  source: 'builtin',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: TEAM_ONBOARDING_PROMPT }]
  },
} satisfies Command

export default teamOnboarding
