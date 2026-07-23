import { expect, test, describe, beforeEach } from 'bun:test'
import { registerCodeReviewSkill } from '../bundled/simplify.js'
import {
  getBundledSkills,
  clearBundledSkills,
} from '../bundledSkills.js'
import { shouldForkedSkillRunAsync } from '../../utils/forkedAgent.js'

/**
 * CC 2.1.218 #1: /code-review runs as a background subagent, so review work
 * no longer fills the main conversation and keeps stacked slash commands as
 * its review target.
 *
 * The change routes /code-review through the forked-skill dispatch path
 * (CC 2.1.218 #35's `context: 'fork'` + default `background: true`). The
 * SkillTool checks `command.context === 'fork'` to call `executeForkedSkill`,
 * and `shouldForkedSkillRunAsync` returns true when `background` is unset
 * (default background). This keeps the review output out of the main
 * conversation — it reports back as a background task instead.
 *
 * Inner finders (launched via AGENT_TOOL_NAME inside the prompt) are NOT
 * blocked by the spawn-depth cap: `createSubagentContext` does not propagate
 * `subagentDepth` into the subagent's own ToolUseContext, so inner AgentTool
 * calls resolve `subagentDepth ?? 0` → 0, spawning at depth 1 (within the
 * default cap of 1).
 */
describe('CC 2.1.218 #1 — /code-review as background subagent', () => {
  beforeEach(() => {
    clearBundledSkills()
    registerCodeReviewSkill()
  })

  function getCodeReviewCommand() {
    const skills = getBundledSkills()
    const cmd = skills.find((c) => c.name === 'code-review')
    expect(cmd).toBeDefined()
    return cmd!
  }

  test('code-review skill is registered with context: fork', () => {
    const cmd = getCodeReviewCommand()
    expect(cmd.context).toBe('fork')
  })

  test('code-review skill defaults to background (background field unset)', () => {
    const cmd = getCodeReviewCommand()
    // background unset → default background (not opted out)
    expect(cmd.background).toBeUndefined()
  })

  test('shouldForkedSkillRunAsync returns true for code-review (background by default)', () => {
    const cmd = getCodeReviewCommand()
    expect(shouldForkedSkillRunAsync(cmd)).toBe(true)
  })

  test('code-review prompt still generates (fork does not break prompt generation)', () => {
    const cmd = getCodeReviewCommand()
    // The prompt is still generated the same way; forking only changes the
    // dispatch path (where the prompt runs), not the prompt itself.
    expect(cmd.type).toBe('prompt')
    expect(typeof cmd.getPromptForCommand).toBe('function')
  })
})
