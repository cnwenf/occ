import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Official 2.1.299 (#145): /reload-skills message says the reload re-sends the
 * full skill list. Byte-verified from the v299 ELF (@236896600 region):
 *   `Reloaded skills: ${e.length} ${I(e.length,"skill")} available (${p}${f}).${h}`
 *   p = "N added"/"N removed" joins or "none added or removed"
 *   f = "; custom skills are disabled in safe mode" (safe mode only)
 *   h = " Claude will get the full list of skills with your next message."
 *       (skills present AND the Skill tool is in context.options.tools)
 */

let currentSkills: Array<{ type: string; source: string; name: string }> = []
let nextSkills: Array<{ type: string; source: string; name: string }> = []
let cacheCleared = false

mock.module('../../../commands.js', () => ({
  getCommands: async () => (cacheCleared ? nextSkills : currentSkills),
  clearCommandsCache: () => {
    cacheCleared = true
  },
}))

mock.module('../../../bootstrap/state.js', () => ({
  getProjectRoot: () => '/tmp/reload-skills-test',
}))

const { call } = await import('../reload-skills.js')

function skill(name: string) {
  return { type: 'prompt', source: 'user', name }
}

function makeContext(tools: Array<{ name: string }>) {
  return { options: { tools } } as never
}

const SKILL_TOOL = [{ name: 'Skill' }]
const NO_TOOLS: Array<{ name: string }> = []

beforeEach(() => {
  cacheCleared = false
  delete process.env.CLAUDE_CODE_SAFE_MODE
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_SAFE_MODE
})

describe('2.1.299 #145: /reload-skills message', () => {
  test('reports added and removed counts', async () => {
    currentSkills = [skill('a'), skill('b')]
    nextSkills = [skill('b'), skill('c')]
    const result = await call('', makeContext(NO_TOOLS))
    expect(result).toEqual({
      type: 'text',
      value: 'Reloaded skills: 2 skills available (1 added, 1 removed).',
    })
  })

  test('reports "none added or removed" when unchanged', async () => {
    currentSkills = [skill('a')]
    nextSkills = [skill('a')]
    const result = await call('', makeContext(NO_TOOLS))
    expect(result).toEqual({
      type: 'text',
      value: 'Reloaded skills: 1 skill available (none added or removed).',
    })
  })

  test('appends the full-list sentence when the Skill tool is present', async () => {
    currentSkills = [skill('a'), skill('b')]
    nextSkills = [skill('a'), skill('b')]
    const result = await call('', makeContext(SKILL_TOOL))
    expect(result).toEqual({
      type: 'text',
      value:
        'Reloaded skills: 2 skills available (none added or removed).' +
        ' Claude will get the full list of skills with your next message.',
    })
  })

  test('omits the full-list sentence when no skills remain', async () => {
    currentSkills = [skill('a')]
    nextSkills = []
    const result = await call('', makeContext(SKILL_TOOL))
    expect(result).toEqual({
      type: 'text',
      value: 'Reloaded skills: 0 skills available (1 removed).',
    })
  })

  test('adds the safe-mode note inside the parens', async () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    currentSkills = [skill('a')]
    nextSkills = [skill('a')]
    const result = await call('', makeContext(NO_TOOLS))
    expect(result).toEqual({
      type: 'text',
      value:
        'Reloaded skills: 1 skill available (none added or removed; ' +
        'custom skills are disabled in safe mode).',
    })
  })

  test('builtin commands are excluded from the skill count', async () => {
    currentSkills = []
    nextSkills = [
      skill('a'),
      { type: 'prompt', source: 'builtin', name: 'help' },
      { type: 'local', source: 'builtin', name: 'clear' },
    ]
    const result = await call('', makeContext(NO_TOOLS))
    expect(result).toEqual({
      type: 'text',
      value: 'Reloaded skills: 1 skill available (1 added).',
    })
  })
})
