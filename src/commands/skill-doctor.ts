import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

function getSkillDoctorPrompt(args: string): string {
  const scope = args.trim() || '(all discovered skills)'
  return `You are diagnosing skill issues in this Claude Code project.

## Scope
${scope}

## Task
Systematically inspect all skills (bundled, project-level ~/.claude/skills/, and plugin skills) for common issues:

1. **Missing or invalid frontmatter** — every skill SKILL.md must start with valid YAML frontmatter containing at minimum a \`name\` and \`description\` field.
2. **Invalid frontmatter fields** — check for unknown fields, wrong types (e.g., name not a string), or empty descriptions.
3. **Broken paths** — any \`references\` or resource paths declared in frontmatter or referenced in the skill body must point to files that actually exist on disk.
4. **Missing skill body** — SKILL.md files that are empty or contain only frontmatter with no instructional content.
5. **Naming issues** — skill names that don't match the directory name, contain invalid characters, or conflict with built-in skill names.

## Method
1. Use Glob to find all SKILL.md files under ~/.claude/skills/, .claude/skills/, and the bundled skills directory.
2. Read each SKILL.md file and parse its frontmatter.
3. For each skill, verify:
   - Frontmatter exists and is valid YAML
   - \`name\` and \`description\` are present and non-empty
   - Any declared resource paths exist on disk
   - The skill body has substantive instructional content
4. Cross-check skill names against the built-in skill list for conflicts.

## Output
Produce a markdown report with:
- A summary line (total skills checked, issues found)
- One section per skill with issues, listing the specific problems
- For each issue, include: the file path, the problem, and a recommended fix

If no issues are found, state that clearly. Do not modify any files — this is a diagnostic only.`
}

const skillDoctor = {
  type: 'prompt',
  name: 'skill-doctor',
  description: 'Diagnose skill issues (missing frontmatter, invalid fields, broken paths)',
  argumentHint: '[skill name or scope]',
  progressMessage: 'diagnosing skill issues',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: getSkillDoctorPrompt(args) }]
  },
} satisfies Command

export default skillDoctor
