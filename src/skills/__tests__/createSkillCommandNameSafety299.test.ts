/**
 * CC 2.1.299 #154 (security) — createSkillCommand wiring.
 *
 * Official registration gates in the skill loader closure (r8t):
 *   entry @227121024: `if(!sj(qn)){wI(qn,"is not offered");return}`
 *   exit  @227123544: `if(!k6(ln.replace(/&[lg]t;/g,"<")))wI(ln,`is not shown for ${qn}`),Bgr(Xn);return Xn`
 *   Bgr @220109757:   strips userFacingName (official also records shedAliases;
 *                     OCC's Command type has no shedAliases — stripping the
 *                     alias is the full observable effect).
 *
 * So: a refused skill name → the skill is NOT offered (null, dropped by the
 * loader). A refused DISPLAY name → the skill still loads under its internal
 * name but the userFacingName alias is shed (getCommandName falls back to
 * cmd.name).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as debug from '../../utils/debug.js'
import { getCommandName } from '../../types/command.js'
import { _resetNamesNotShownForTesting } from '../../utils/nameSafety.js'
import { createSkillCommand } from '../loadSkillsDir.js'

const ZWSP = '\u200B'

function makeArgs(overrides: {
  skillName?: string
  displayName?: string | undefined
} = {}) {
  return {
    skillName: overrides.skillName ?? 'my-skill',
    displayName: overrides.displayName,
    description: 'a test skill',
    hasUserSpecifiedDescription: false,
    markdownContent: '# hello',
    allowedTools: [],
    disallowedTools: [],
    argumentHint: undefined,
    argumentNames: [],
    whenToUse: undefined,
    version: undefined,
    model: undefined,
    disableModelInvocation: false,
    userInvocable: true,
    source: 'builtin' as const,
    baseDir: undefined,
    loadedFrom: 'skills' as const,
    hooks: undefined,
    executionContext: undefined,
    agent: undefined,
    paths: undefined,
    effort: undefined,
    shell: undefined,
    defaultEnabled: undefined,
    fallback: false,
    metadata: undefined,
    background: undefined,
    contentHash: undefined,
  }
}

let logs: { message: string; level?: string }[] = []
let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  logs = []
  spy = spyOn(debug, 'logForDebugging').mockImplementation(
    (message: string, opts?: { level?: string }) => {
      logs.push({ message, level: opts?.level })
      return undefined as never
    },
  )
  _resetNamesNotShownForTesting()
})

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

describe('CC 2.1.299 #154: createSkillCommand entry gate (sj)', () => {
  test('clean skill name is offered', () => {
    // Act
    const command = createSkillCommand(makeArgs())

    // Assert
    expect(command).not.toBeNull()
    expect(command!.name).toBe('my-skill')
    expect(logs.filter(l => l.message.startsWith('[names]'))).toHaveLength(0)
  })

  test('skill name with a hidden character is not offered (null + warn)', () => {
    // Act
    const command = createSkillCommand(
      makeArgs({ skillName: `evil${ZWSP}skill` }),
    )

    // Assert
    expect(command).toBeNull()
    const namesWarn = logs.find(l => l.message.startsWith('[names]'))
    expect(namesWarn).toBeDefined()
    expect(namesWarn!.level).toBe('warn')
    expect(namesWarn!.message).toContain(
      'evil\\u{200B}skill is not offered: a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters',
    )
  })

  test('skill name with < is not offered', () => {
    expect(createSkillCommand(makeArgs({ skillName: 'bad<name' }))).toBeNull()
  })
})

describe('CC 2.1.299 #154: createSkillCommand display-name gate (k6 + Bgr)', () => {
  test('clean display name keeps userFacingName', () => {
    // Act
    const command = createSkillCommand(
      makeArgs({ displayName: 'My Nice Skill' }),
    )

    // Assert
    expect(command).not.toBeNull()
    expect(command!.userFacingName).toBeDefined()
    expect(getCommandName(command!)).toBe('My Nice Skill')
  })

  test('refused display name sheds userFacingName but the skill still loads', () => {
    // Act
    const command = createSkillCommand(
      makeArgs({ displayName: `Sneaky${ZWSP}Alias` }),
    )

    // Assert — command survives under its internal name; alias is shed.
    expect(command).not.toBeNull()
    expect(command!.name).toBe('my-skill')
    expect(command!.userFacingName).toBeUndefined()
    expect(getCommandName(command!)).toBe('my-skill')
    expect(
      logs.some(
        l =>
          l.message.startsWith('[names]') &&
          l.message.includes('is not shown for my-skill'),
      ),
    ).toBe(true)
  })

  test('HTML-entity display name is unescaped before the k6 check (official &[lg]t; replace)', () => {
    // '&lt;evil&gt;' renders as '<evil>' — official replaces the entities
    // then applies k6, so the rendered '<'/'>' refuses the alias.
    const command = createSkillCommand(
      makeArgs({ displayName: '&lt;evil&gt;' }),
    )
    expect(command).not.toBeNull()
    expect(command!.userFacingName).toBeUndefined()
  })

  test('no display name → internal name is checked and kept when clean', () => {
    // displayName undefined → ln = skillName, which already passed sj (and
    // sj is strictly stronger than k6), so no stripping and no extra warn.
    const command = createSkillCommand(makeArgs())
    expect(command!.userFacingName).toBeDefined()
    expect(getCommandName(command!)).toBe('my-skill')
  })
})
