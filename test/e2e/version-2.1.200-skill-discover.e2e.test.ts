import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.200 (C9): skill search / DiscoverSkillsTool. The official
 * binary ships a `SearchSkills` tool (noun:"skill", run:s6n) that searches the
 * user's claude.ai skill library by keyword over the OAuth org endpoint. OCC
 * has no teleport-org client, so the tool searches the locally-loaded skill
 * set instead — name/description/prompt match the binary exactly.
 */
describe('2.1.200 DiscoverSkillsTool / SearchSkills (e2e)', () => {
  test('prompt.ts exports the binary-matching tool name + description', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/DiscoverSkillsTool/prompt.ts`,
    ).text()
    const checks = {
      name: src.includes("DISCOVER_SKILLS_TOOL_NAME = 'SearchSkills'"),
      description: src.includes(
        "Search the user's claude.ai skills by keyword to find skills that might help complete the task.",
      ),
      prompt: src.includes(
        "Search the user's claude.ai skills by keyword. Call this when a skill",
      ),
    }
    console.log(JSON.stringify(checks))
    expect(checks.name).toBe(true)
    expect(checks.description).toBe(true)
    expect(checks.prompt).toBe(true)
  })

  test('DiscoverSkillsTool.ts is a real Tool def + searchSkills.ts backing', async () => {
    const toolSrc = await Bun.file(
      `${REPO_ROOT}/src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`,
    ).text()
    const searchSrc = await Bun.file(
      `${REPO_ROOT}/src/skills/searchSkills.ts`,
    ).text()
    expect(toolSrc.includes('buildTool(')).toBe(true)
    expect(toolSrc.includes('name: DISCOVER_SKILLS_TOOL_NAME')).toBe(true)
    expect(toolSrc.includes('keywords')).toBe(true)
    expect(searchSrc.includes('export async function searchSkills')).toBe(true)
    expect(searchSrc.includes('formatSkillSearchResults')).toBe(true)
  })

  test('tool name imports cleanly (no TDZ)', async () => {
    const script = `
import { DISCOVER_SKILLS_TOOL_NAME } from "${REPO_ROOT}/src/tools/DiscoverSkillsTool/prompt.ts";
console.log(DISCOVER_SKILLS_TOOL_NAME);
`
    const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim()
    expect(out).toBe('SearchSkills')
  })
})
