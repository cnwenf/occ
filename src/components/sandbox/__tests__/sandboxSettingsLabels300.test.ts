import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'bun:test'

/**
 * CC 2.1.300 (#63) — 'Changed the /sandbox mode options to read
 * "Sandbox commands" instead of "Sandbox BashTool"'.
 *
 * Official binary evidence (docs/gap-research-300/triage-T4.md §63):
 *   v300 option-builder dd @257304200 (verified this round):
 *     L=A?[{label:"Sandbox commands, with auto-allow",value:"auto-allow"}]:[]
 *     {label:A?"Sandbox commands, with regular permissions":"Sandbox commands",
 *      value:"regular"}
 *     {label:"No Sandbox",value:"disabled"}
 *   where A = Xe.isAutoAllowSupported(). grep -ac: v300 "Sandbox commands" → 2,
 *   "Sandbox BashTool" → 0; v299 inverse ("Sandbox BashTool" → 2).
 *
 * OCC note: OCC's SandboxSettings has no `isAutoAllowSupported` equivalent —
 * the auto-allow row is always shown — so per the triage sketch OCC keeps the
 * suffixed "with regular permissions" form unconditionally (the official `A`
 * arm is always-true here). "No Sandbox" is unchanged in both versions.
 *
 * These are source-label assertions (the brief's test spec: label assertions
 * + `grep -c 'Sandbox BashTool' src/` → 0): the strings are static Select
 * option labels rendered verbatim inside a React-Compiler-compiled Ink
 * component, so a file-content assertion checks exactly the shipped bytes.
 */

const SETTINGS_PATH = 'src/components/sandbox/SandboxSettings.tsx'

async function readSettings(): Promise<string> {
  return await Bun.file(SETTINGS_PATH).text()
}

describe('2.1.300 #63 — /sandbox mode option labels', () => {
  test('auto-allow option reads "Sandbox commands, with auto-allow"', async () => {
    const src = await readSettings()
    expect(src).toContain('Sandbox commands, with auto-allow')
  })

  test('regular option reads "Sandbox commands, with regular permissions"', async () => {
    const src = await readSettings()
    expect(src).toContain('Sandbox commands, with regular permissions')
  })

  test('"No Sandbox" option is unchanged', async () => {
    const src = await readSettings()
    expect(src).toContain('No Sandbox')
  })

  test('no "Sandbox BashTool" copy remains anywhere in src/', () => {
    const result = spawnSync(
      'grep',
      [
        '-rc',
        '--include=*.ts',
        '--include=*.tsx',
        // this test file necessarily quotes the old label in its assertions
        '--exclude=sandboxSettingsLabels300.test.ts',
        'Sandbox BashTool',
        'src/',
      ],
      { encoding: 'utf8' },
    )
    // grep exit 1 = zero matches across all files
    const hits = result.stdout
      .split('\n')
      .filter(line => line.length > 0 && !line.endsWith(':0'))
    expect(hits).toEqual([])
  })
})
