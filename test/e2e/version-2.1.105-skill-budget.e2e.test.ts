import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.105 (C13): skillListingMaxDescChars +
 * skillListingBudgetFraction settings. The official binary reads these via
 * CHe()/fAo() with defaults d3p=1536 and c3p=0.01; OCC reads them from
 * getInitialSettings() (settings schema is .passthrough(), so the keys survive
 * even without an explicit Zod entry) and falls back to the same defaults.
 */
describe('2.1.105 skill listing budget settings (e2e)', () => {
  test('prompt.ts wires skillListingMaxDescChars / skillListingBudgetFraction', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/SkillTool/prompt.ts`,
    ).text()
    const checks = {
      maxDescSetting: src.includes('skillListingMaxDescChars'),
      fractionSetting: src.includes('skillListingBudgetFraction'),
      defaultMax1536: src.includes('1536'),
      defaultFraction: src.includes('0.01'),
      getterMax: src.includes('getSkillListingMaxDescChars'),
      getterFraction: src.includes('getSkillListingBudgetFraction'),
      envOverride: src.includes('SLASH_COMMAND_TOOL_CHAR_BUDGET'),
    }
    console.log(JSON.stringify(checks))
    expect(checks.maxDescSetting).toBe(true)
    expect(checks.fractionSetting).toBe(true)
    expect(checks.defaultMax1536).toBe(true)
    expect(checks.fractionSetting).toBe(true)
    expect(checks.getterMax).toBe(true)
    expect(checks.getterFraction).toBe(true)
    expect(checks.envOverride).toBe(true)
  })

  test('getters return binary defaults (1536 / 0.01) when unset', async () => {
    const script = `
import { getSkillListingMaxDescChars, getSkillListingBudgetFraction } from "${REPO_ROOT}/src/tools/SkillTool/prompt.ts";
console.log(JSON.stringify({
  max: getSkillListingMaxDescChars(),
  fraction: getSkillListingBudgetFraction(),
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.max).toBe(1536)
    expect(out.fraction).toBe(0.01)
  })
})
