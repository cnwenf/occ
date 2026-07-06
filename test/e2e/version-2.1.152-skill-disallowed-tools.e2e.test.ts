import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Skill disallowed-tools frontmatter (2.1.152, e2e)', () => {
  test('frontmatter parser accepts disallowed-tools', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/frontmatterParser.ts`).text()
    expect(src).toContain("'disallowed-tools'")
  })

  test('Command type has disallowedTools', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/types/command.ts`).text()
    expect(src).toContain('disallowedTools?: string[]')
  })

  test('BundledSkillDefinition + registerBundledSkill pass disallowedTools through', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/skills/bundledSkills.ts`).text()
    expect(src).toContain('disallowedTools?: string[]')
    expect(src).toContain('disallowedTools: definition.disallowedTools ?? []')
  })

  test('loadSkillsDir maps frontmatter disallowed-tools -> disallowedTools on the Command', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/skills/loadSkillsDir.ts`).text()
    expect(src).toContain("frontmatter['disallowed-tools']")
    expect(src).toContain('disallowedTools: parseSlashCommandToolsFromFrontmatter')
  })
})
