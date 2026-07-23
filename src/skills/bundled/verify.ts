import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './verifyContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Verify a code change does what it should by running the app.'

// Official Claude Code 2.1.215 registers `/verify` unconditionally (no
// USER_TYPE gate, no isEnabled) — it is reachable by every user, not just
// internal `ant` builds. OCC previously early-returned for non-ant users,
// which made `/verify` return "Unknown command" for them — a divergence
// from upstream. The gate is removed so OCC matches official reachability.
// See OCC-12.
export function registerVerifySkill(): void {
  registerBundledSkill({
    name: 'verify',
    description: DESCRIPTION,
    userInvocable: true,
    files: SKILL_FILES,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
