import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

const LESS_PERMISSION_PROMPTS_PROMPT = `You are helping the user reduce permission prompts by scanning the recent conversation transcript for safe, read-only Bash and MCP tool calls that could be added to the permissions allowlist.

## Your Task

1. **Scan recent tool calls.** Look back through the conversation at the Bash commands and MCP tool invocations that the user has already approved. Focus on the ones that were:
   - Approved by the user (not auto-allowed already).
   - Repeatedly used with the same form (these are the highest-value allowlist candidates).

2. **Classify by safety.** For each distinct command pattern, assess whether it is genuinely safe to auto-allow:
   - **Safe (read-only, no side effects):** Commands that only read state — e.g. \`git status\`, \`git log\`, \`git diff\`, \`ls\`, \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\`, \`wc\`, \`which\`, \`node --version\`, \`bun --version\`, \`npm ls\`, \`tsc --noEmit\`, \`biome lint\` (without --write), test runners in read mode.
   - **Unsafe (mutations / side effects):** Commands that write, delete, install, deploy, or otherwise change state — e.g. \`git commit\`, \`git push\`, \`rm\`, \`mv\`, \`npm install\`, \`bun add\`, any \`>\` redirect, \`curl ... | sh\`. NEVER suggest auto-allowing these.

3. **Propose allowlist entries.** For each safe, repeated pattern, propose a concrete permission rule. Use the prefix-glob form so the rule covers variations:
   - \`Bash(git status:*)\` — allows \`git status\` and any args after it.
   - \`Bash(git diff:*)\`, \`Bash(git log:*)\`, \`Bash(git show:*)\`.
   - \`Bash(ls:*)\`, \`Bash(cat:*)\`, \`Bash(grep:*)\`, \`Bash(find:*)\`.
   - For MCP tools: \`mcp__<server>__<tool>\` if the tool is read-only.

4. **Present a prioritized list.** Rank by how often the command appeared in the transcript (most frequent first). For each entry show:
   - The proposed rule.
   - The concrete commands it would auto-allow.
   - A one-line safety rationale.

5. **Offer to apply.** After presenting the list, ask the user which entries they want to add. Then write the selected rules to the project \`.claude/settings.json\` under \`permissions.allow\` (or the user's global \`~/.claude/settings.json\` if they prefer). Merge with any existing allow rules — do not overwrite them.

## Safety Guardrails

- ONLY propose read-only commands. If you are less than 95% confident a command has no side effects, do not propose it.
- Never propose rules that would auto-allow writes, deletes, installs, network mutations, or anything involving secrets/credentials.
- Prefer narrow prefix rules (\`Bash(git status:*)\`) over broad ones (\`Bash(git:*)\`) — the latter would also allow \`git push\`.
- Respect the user's existing allowlist; do not propose duplicates.

Begin by summarizing the distinct Bash/MCP patterns you see in the recent transcript, then present your prioritized recommendations.`

const lessPermissionPrompts = {
  type: 'prompt',
  name: 'less-permission-prompts',
  description:
    'Scan recent tool calls and suggest safe read-only commands to auto-allow',
  progressMessage: 'scanning for allowlist opportunities',
  contentLength: LESS_PERMISSION_PROMPTS_PROMPT.length,
  source: 'builtin',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: LESS_PERMISSION_PROMPTS_PROMPT }]
  },
} satisfies Command

export default lessPermissionPrompts
