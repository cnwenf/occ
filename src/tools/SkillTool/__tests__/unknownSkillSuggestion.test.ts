import { describe, expect, test } from 'bun:test'
import {
  findPluginSkillFullNameMatch,
  isSkillNameSafeToDisplay,
} from '../../../commands.js'
import type { Command } from '../../../types/command.js'
import { buildUnknownSkillMessage } from '../SkillTool.js'

/**
 * Official Claude Code 2.1.269 (E52): "Unknown skill" names a plugin skill's
 * full name when the bare name matches exactly one plugin skill, and lists
 * candidates when several skills share the bare name.
 *
 * Official resolver (`Oun`, js269.txt @ 1277648):
 *   empty query or query containing ":" → none
 *   filter: type==="prompt" && loadedFrom!=="syncedSkills" && name.endsWith(":"+query)
 *   >1 → ambiguous; unique but source!=="plugin" → none; unique plugin → unique
 * (OCC has no 'syncedSkills' loadedFrom — that guard is omitted, documented
 * in commands.ts.)
 */

function promptCommand(
  name: string,
  source: 'plugin' | 'user' | 'project' | 'builtin' = 'plugin',
): Command {
  return {
    type: 'prompt',
    name,
    source,
    description: '',
    getPromptForCommand: async () => '',
  } as unknown as Command
}

function localCommand(name: string): Command {
  return {
    type: 'local-jsx',
    name,
    source: 'builtin',
    description: '',
  } as unknown as Command
}

describe('2.1.269 E52: findPluginSkillFullNameMatch resolver', () => {
  test('unique plugin match resolves to that command', () => {
    const cmd = promptCommand('myplugin:deploy')
    const match = findPluginSkillFullNameMatch('deploy', [
      cmd,
      promptCommand('other:build'),
    ])
    expect(match.kind).toBe('unique')
    if (match.kind === 'unique') expect(match.command.name).toBe('myplugin:deploy')
  })

  test('two matches resolve to ambiguous with both candidates', () => {
    const a = promptCommand('alpha:deploy')
    const b = promptCommand('beta:deploy')
    const match = findPluginSkillFullNameMatch('deploy', [a, b])
    expect(match.kind).toBe('ambiguous')
    if (match.kind === 'ambiguous')
      expect(match.candidates.map(c => c.name)).toEqual([
        'alpha:deploy',
        'beta:deploy',
      ])
  })

  test('unique non-plugin match resolves to none (official source!=="plugin" guard)', () => {
    const match = findPluginSkillFullNameMatch('deploy', [
      promptCommand('mydir:deploy', 'user'),
    ])
    expect(match.kind).toBe('none')
  })

  test('query containing ":" resolves to none', () => {
    const match = findPluginSkillFullNameMatch('myplugin:deploy', [
      promptCommand('myplugin:deploy'),
    ])
    expect(match.kind).toBe('none')
  })

  test('empty query resolves to none', () => {
    expect(findPluginSkillFullNameMatch('', [promptCommand('p:x')]).kind).toBe(
      'none',
    )
  })

  test('non-prompt commands are excluded from matching', () => {
    const match = findPluginSkillFullNameMatch('deploy', [
      localCommand('ui:deploy'),
    ])
    expect(match.kind).toBe('none')
  })

  test('suffix must be colon-anchored (no partial-name matches)', () => {
    // "mydeploy" ends with "deploy" but not ":deploy"
    const match = findPluginSkillFullNameMatch('deploy', [
      promptCommand('myplugin:mydeploy'),
    ])
    expect(match.kind).toBe('none')
  })
})

describe('2.1.269 E52: isSkillNameSafeToDisplay (official Pee)', () => {
  test('accepts normal names up to 256 chars', () => {
    expect(isSkillNameSafeToDisplay('myplugin:deploy')).toBe(true)
    expect(isSkillNameSafeToDisplay('a'.repeat(256))).toBe(true)
  })

  test('rejects empty and over-long names', () => {
    expect(isSkillNameSafeToDisplay('')).toBe(false)
    expect(isSkillNameSafeToDisplay('a'.repeat(257))).toBe(false)
  })

  test('rejects control chars, line separators and angle brackets', () => {
    expect(isSkillNameSafeToDisplay('bad\nname')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad\x00name')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad\u2028name')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad\u2029name')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad<name')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad>name')).toBe(false)
    expect(isSkillNameSafeToDisplay('bad\x7fname')).toBe(false)
  })
})

describe('2.1.269 E52: buildUnknownSkillMessage', () => {
  test('unique plugin match produces the official suggestion message', () => {
    expect(
      buildUnknownSkillMessage('deploy', [promptCommand('myplugin:deploy')]),
    ).toBe(
      'Unknown skill: deploy. Did you mean myplugin:deploy? Invoke it by that full name.',
    )
  })

  test('ambiguous match lists names with the official message', () => {
    expect(
      buildUnknownSkillMessage('deploy', [
        promptCommand('alpha:deploy'),
        promptCommand('beta:deploy'),
      ]),
    ).toBe(
      'Unknown skill: deploy. Several skills match that name: alpha:deploy, beta:deploy — invoke one by its full name.',
    )
  })

  test('non-plugin unique match keeps the bare message', () => {
    expect(
      buildUnknownSkillMessage('deploy', [
        promptCommand('mydir:deploy', 'project'),
      ]),
    ).toBe('Unknown skill: deploy')
  })

  test('":" query keeps the bare message', () => {
    expect(
      buildUnknownSkillMessage('myplugin:deploy', [
        promptCommand('myplugin:deploy'),
      ]),
    ).toBe('Unknown skill: myplugin:deploy')
  })

  test('no match keeps the bare message', () => {
    expect(buildUnknownSkillMessage('nope', [])).toBe('Unknown skill: nope')
  })

  test('display-unsafe candidate name falls back to the bare message (official Pee gate)', () => {
    expect(
      buildUnknownSkillMessage('deploy', [
        promptCommand('myplugin:de<ploy'),
      ]),
    ).toBe('Unknown skill: deploy')
  })

  test('ambiguous with one unsafe candidate falls back to the bare message', () => {
    expect(
      buildUnknownSkillMessage('deploy', [
        promptCommand('alpha:deploy'),
        promptCommand('be\u2028ta:deploy'),
      ]),
    ).toBe('Unknown skill: deploy')
  })
})
