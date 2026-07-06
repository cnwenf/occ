import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.199 (C14): stacked slash-skill invocations. `/skill-a
 * /skill-b do XYZ` loads up to 5 leading skills (jFl=5) and passes the
 * remaining text as trailing args. Mirrors the binary's GFl() split +
 * tengu_stacked_slash_commands telemetry + stackedExpansion/stackedOriginalInput
 * message tags.
 */
describe('2.1.199 stacked slash-skill loading (e2e)', () => {
  test('stackedSlashCommands.ts has binary-matching cap + telemetry', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/skills/stackedSlashCommands.ts`,
    ).text()
    const checks = {
      cap5: src.includes('MAX_STACKED_SKILLS = 5'),
      split: src.includes('splitStackedSlashCommands'),
      filter: src.includes('isStackableSkill'),
      telemetry: src.includes('tengu_stacked_slash_commands'),
      stackedCount: src.includes('stacked_count'),
      load: src.includes('loadStackedSkills'),
      stackedExpansion: src.includes('stackedExpansion'),
    }
    console.log(JSON.stringify(checks))
    expect(checks.cap5).toBe(true)
    expect(checks.split).toBe(true)
    expect(checks.filter).toBe(true)
    expect(checks.telemetry).toBe(true)
    expect(checks.stackedCount).toBe(true)
    expect(checks.load).toBe(true)
    expect(checks.stackedExpansion).toBe(true)
  })

  test('processSlashCommand.tsx wires the stacked split + load', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/processUserInput/processSlashCommand.tsx`,
    ).text()
    expect(src.includes('splitStackedSlashCommands')).toBe(true)
    expect(src.includes('loadStackedSkills')).toBe(true)
    expect(src.includes('logStackedSlashCommands')).toBe(true)
    expect(src.includes('stackedOriginalInput')).toBe(true)
  })

  test('split caps at 5 (6th leading skill stays in trailing args)', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const commands = names.map(n => ({
      name: n,
      type: 'prompt',
      userInvocable: true,
      isEnabled: () => true,
    }))
    const script = `
const commands = ${JSON.stringify(commands)};
import { splitStackedSlashCommands, MAX_STACKED_SKILLS } from "${REPO_ROOT}/src/skills/stackedSlashCommands.ts";
const args = commands.map(c=>'/' + c.name).join(' ') + ' do work';
const { stacked, trailingArgs, capped } = splitStackedSlashCommands(args, commands);
console.log(JSON.stringify({ cap: MAX_STACKED_SKILLS, stackedCount: stacked.length, capped, trailing: trailingArgs }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.cap).toBe(5)
    expect(out.stackedCount).toBe(5)
    expect(out.capped).toBe(true)
    // The 6th leading skill (/f) was not consumed; it remains in trailing args
    // alongside the real task text, matching the binary's GFl break-on-cap.
    expect(out.trailing).toBe('/f do work')
  })

  test('split loads 2 leading skills and leaves the real task as trailing', async () => {
    const commands = [
      { name: 'skill-a', type: 'prompt', userInvocable: true, isEnabled: () => true },
      { name: 'skill-b', type: 'prompt', userInvocable: true, isEnabled: () => true },
    ]
    const script = `
const commands = ${JSON.stringify(commands)};
import { splitStackedSlashCommands } from "${REPO_ROOT}/src/skills/stackedSlashCommands.ts";
const { stacked, trailingArgs, capped } = splitStackedSlashCommands('/skill-a /skill-b do XYZ', commands);
console.log(JSON.stringify({ stackedCount: stacked.length, capped, trailing: trailingArgs, first: stacked[0]?.command.name, second: stacked[1]?.command.name }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.stackedCount).toBe(2)
    expect(out.capped).toBe(false)
    expect(out.trailing).toBe('do XYZ')
    expect(out.first).toBe('skill-a')
    expect(out.second).toBe('skill-b')
  })

  test('split returns empty when args do not start with a slash', async () => {
    const commands = [
      { name: 'a', type: 'prompt', userInvocable: true, isEnabled: () => true },
    ]
    const script = `
const commands = ${JSON.stringify(commands)};
import { splitStackedSlashCommands } from "${REPO_ROOT}/src/skills/stackedSlashCommands.ts";
const { stacked, trailingArgs } = splitStackedSlashCommands('just plain text', commands);
console.log(JSON.stringify({ stackedCount: stacked.length, trailing: trailingArgs }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.stackedCount).toBe(0)
    expect(out.trailing).toBe('just plain text')
  })
})
