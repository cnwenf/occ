import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

function getAutofixPrPrompt(args: string): string {
  const target = args.trim() || '(current branch)'
  return `You are automatically fixing issues on a pull request.

## Target
${target}

## Task
Systematically identify and fix all blocking issues on the current PR so it can merge cleanly.

## Steps
1. **Gather PR context** — run these to understand the current state:
   - \`git status\` — see uncommitted changes
   - \`git diff origin/HEAD...\` — see all changes on this branch vs base
   - \`git log --oneline origin/HEAD...\` — see commits on this branch

2. **Run checks** — identify what's failing:
   - Run the project's lint command (e.g., \`bun run lint\`, \`npm run lint\`, \`ruff check\`)
   - Run the project's type check if applicable (e.g., \`tsc --noEmit\`, \`mypy\`)
   - Run the project's test suite
   - Check for build errors

3. **Fix issues** — for each failing check:
   - Lint errors: fix style/import/usage issues. Prefer auto-fix where available (\`--fix\` / \`--write\`).
   - Type errors: fix type mismatches, missing types, or incorrect signatures. Do not use \`any\` or \`@ts-ignore\` to silence errors — fix the root cause.
   - Test failures: read the failing test, understand the expected behavior, fix the implementation (not the test, unless the test itself is wrong).
   - Build errors: resolve missing imports, syntax errors, or configuration issues.

4. **Verify** — re-run all checks to confirm everything passes after your fixes.

5. **Commit and push** — stage only the files you changed, write a clear commit message describing the fixes, and push to the branch.

## Constraints
- Do NOT reformat or refactor code that is unrelated to the failing checks — keep diffs minimal.
- Do NOT modify lock files unless a dependency change is required to fix a real issue.
- Do NOT silence errors with suppress comments, \`any\` casts, or disabled rules.
- If an issue is unfixable (e.g., a flaky test, an environment problem), document it clearly and move on to the next issue.

## Output
After completing the work, provide a summary:
- List of issues found and fixed (file, issue, fix)
- List of issues that could not be fixed (with explanation)
- Final check status (pass/fail for each check)
- The commit hash(es) pushed`
}

const autofixPr = {
  type: 'prompt',
  name: 'autofix-pr',
  description: 'Automatically fix lint, type, and test issues on the current PR',
  argumentHint: '[branch or PR reference]',
  progressMessage: 'fixing PR issues',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: getAutofixPrPrompt(args) }]
  },
} satisfies Command

export default autofixPr
