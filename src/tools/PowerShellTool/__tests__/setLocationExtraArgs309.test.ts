/**
 * CC 2.1.309 changelog #41: "Windows: Fixed PowerShell permission checks
 * auto-approving some `Set-Location` or `cd` commands that target the current
 * directory and carry extra arguments; these now prompt for approval"
 *
 * Forensic note (read-only BIN308/BIN309 diff): four ~16-32KB windows across
 * the official PowerShell permission chunk (tengu_curious_lake @309:265450654
 * / @308:264498932) and the read-only validation chunk (exports @309 region,
 * `fct`/`Hlt` validator) show ONLY minified identifier renames between 2.1.308
 * and 2.1.309 — zero added/removed statements; per-build chunk hashes make a
 * whole-binary chunk diff impossible. Per triage-T3 item 41 the changelog is
 * therefore the authoritative spec, and the OCC bug is concrete:
 *
 *   powershellPermissions.ts step-5 filter dropped a cwd-targeting
 *   set-location from the approval list when its FIRST non-dash arg resolved
 *   to cwd — never checking the OTHER args. `Set-Location . -PassThru`,
 *   `Set-Location -Path:/etc .` and `cd . extra` were silently auto-approved.
 *
 * Fix: auto-approve ONLY when the resolved-cwd target is the SOLE argument
 * (mirrors the official V0o shape `w.startsWith("-")||pqe.test(w)→bail` —
 * any dash-param or extra operand leaves the command in the approval list).
 *
 * DEDICATED mock.module FILE: bun's mock.module is process-global and would
 * leak the fake parser into other suites in the same process.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// getBundledSkillsRoot (filesystem.ts) reads MACRO.VERSION deep inside the
// path-validation chain — same convention as exitWorktreeAtStake304.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

type MockElement = {
  name: string
  nameType: 'cmdlet' | 'application' | 'unknown'
  args: string[]
  text: string
}

// Command string → synthetic AST. The real parser shells out to pwsh (not
// installed in CI); the permission engine only consumes the AST shape.
const PARSE_TABLE: Record<string, MockElement[]> = {
  'Set-Location .': [
    { name: 'Set-Location', nameType: 'cmdlet', args: ['.'], text: 'Set-Location .' },
  ],
  'Set-Location . -PassThru': [
    {
      name: 'Set-Location',
      nameType: 'cmdlet',
      args: ['.', '-PassThru'],
      text: 'Set-Location . -PassThru',
    },
  ],
  'Set-Location -Path:/etc .': [
    {
      name: 'Set-Location',
      nameType: 'cmdlet',
      args: ['-Path:/etc', '.'],
      text: 'Set-Location -Path:/etc .',
    },
  ],
  'cd . extra': [
    { name: 'cd', nameType: 'cmdlet', args: ['.', 'extra'], text: 'cd . extra' },
  ],
  'Set-Location . -PassThru; Get-Process': [
    {
      name: 'Set-Location',
      nameType: 'cmdlet',
      args: ['.', '-PassThru'],
      text: 'Set-Location . -PassThru',
    },
    { name: 'Get-Process', nameType: 'cmdlet', args: [], text: 'Get-Process' },
  ],
}

// Spread the real module's exports (PS_TOKENIZER_DASH_CHARS, types, helpers)
// so only parsePowerShellCommand is faked — powershellPermissions.ts imports
// several other symbols from this module.
const actualParser = await import('../../../utils/powershell/parser.js')

mock.module('../../../utils/powershell/parser.js', () => ({
  ...actualParser,
  parsePowerShellCommand: async (command: string) => {
    const elements = PARSE_TABLE[command]
    if (!elements) {
      throw new Error(`test parser mock: unmapped command ${command}`)
    }
    // One statement per element (compound), matching the real parser's
    // `;`-separated statement split.
    return {
      valid: true,
      errors: [],
      variables: [],
      hasStopParsing: false,
      originalCommand: command,
      statements: elements.map(el => ({
        statementType: 'PipelineAst',
        commands: [{ elementType: 'CommandAst', ...el }],
        redirections: [],
        text: el.text,
      })),
    }
  },
}))

const { powershellToolHasPermission } = await import('../powershellPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
import type { ToolUseContext } from '../../../Tool.js'

afterAll(() => {
  mock.restore()
})

function makeContext(): ToolUseContext {
  return {
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

describe('CC 2.1.309 #41 Set-Location/cd current-dir + extra args must prompt', () => {
  // "Prompts" at the tool level is either an explicit 'ask' (early gates like
  // checkPathConstraints) or 'passthrough' — the outer flow converts
  // passthrough to ask (src/utils/permissions/permissions.ts:1661 "Convert
  // passthrough to ask") and renders the prompt with suggestions. Same
  // convention as BashTool's inlineShellRm288.test.ts.
  const PROMPTS = ['ask', 'passthrough']

  test('bare `Set-Location .` (sole cwd arg) stays auto-approved', async () => {
    // Arrange / Act
    const result = await powershellToolHasPermission(
      { command: 'Set-Location .' },
      makeContext(),
    )

    // Assert — the model-habit no-op cd keeps Bash parity (no prompt)
    expect(result.behavior).toBe('allow')
  })

  test('`Set-Location . -PassThru` now prompts (was auto-approved)', async () => {
    // Arrange / Act
    const result = await powershellToolHasPermission(
      { command: 'Set-Location . -PassThru' },
      makeContext(),
    )

    // Assert
    expect(PROMPTS).toContain(result.behavior)
  })

  test('`Set-Location -Path:/etc .` now prompts (colon-bound param bypass)', async () => {
    // Arrange / Act — the first non-dash arg `.` resolved to cwd and the
    // whole command (including the colon-bound -Path:/etc) was dropped from
    // the approval list.
    const result = await powershellToolHasPermission(
      { command: 'Set-Location -Path:/etc .' },
      makeContext(),
    )

    // Assert
    expect(PROMPTS).toContain(result.behavior)
  })

  test('`cd . extra` now prompts (extra positional operand)', async () => {
    // Arrange / Act
    const result = await powershellToolHasPermission(
      { command: 'cd . extra' },
      makeContext(),
    )

    // Assert
    expect(PROMPTS).toContain(result.behavior)
  })

  test('compound `Set-Location . -PassThru; Get-Process` still prompts (regression guard)', async () => {
    // Arrange / Act — the compound cd guard already forced ask pre-fix; the
    // fix must not loosen it.
    const result = await powershellToolHasPermission(
      { command: 'Set-Location . -PassThru; Get-Process' },
      makeContext(),
    )

    // Assert
    expect(PROMPTS).toContain(result.behavior)
  })
})
