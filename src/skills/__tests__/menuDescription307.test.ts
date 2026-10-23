/**
 * CC 2.1.307 (B7): bundled-skill short menu descriptions — /help and the
 * slash-command menu show a SHORT `menuDescription` for bundled skills while
 * the model-facing `description` (and the SDK tables in src/cli/print.ts)
 * keep the full raw text.
 *
 * Official v307 (byte-verified in /tmp/cc-diff-308/new307.txt):
 *   - Resolver `p1e`:
 *       function p1e(e){if(e.type!=="prompt"||!yDt(e))return e.description;
 *                       return e.menuDescription||e.description}
 *     (`yDt(e)` = source builtin|bundled; OCC only ever sets
 *     menuDescription on bundled prompt commands, so the plain prompt-type
 *     check is data-equivalent — documented simplification.)
 *   - Skill→command converter (×2 regions @10096378 / @13136625):
 *       menuDescription:typeof e.menuDescription==="function"?void 0:e.menuDescription
 *   - claude-api registration:
 *       Ri({name:"claude-api",menuDescription:"Build and debug apps that use the Claude API",...})
 *   - Menu builder @7481999 substitutes the description BEFORE decoration:
 *       w=S.menuDescription!=null&&S.menuDescription!==""?{...S,description:S.menuDescription}:S
 *     OCC analogue: formatDescriptionWithSource({...cmd, description: menuDescriptionFor(cmd)})
 *     — OCC's existing " (bundled)" source decoration is intentionally kept
 *     (official `ift` returns plain text for bundled; documented divergence).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { menuDescriptionFor } = await import('../../commands.js')
const {
  registerBundledSkill,
  getBundledSkills,
  clearBundledSkills,
} = await import('../bundledSkills.js')

type Cmd = Parameters<typeof menuDescriptionFor>[0]

function makePromptCommand(overrides: Record<string, unknown> = {}): Cmd {
  return {
    type: 'prompt',
    name: 'test-skill',
    description: 'full model-facing description',
    source: 'bundled',
    loadedFrom: 'bundled',
    getPromptForCommand: async () => [{ type: 'text', text: 'body' }],
    ...overrides,
  } as unknown as Cmd
}

// ---------------------------------------------------------------------------
// menuDescriptionFor resolver (official p1e)
// ---------------------------------------------------------------------------

describe('menuDescriptionFor (CC 2.1.307 B7 — official p1e port)', () => {
  test('prompt command with menuDescription returns the short menu text', () => {
    // Arrange
    const cmd = makePromptCommand({ menuDescription: 'Short menu text' })

    // Act & Assert
    expect(menuDescriptionFor(cmd)).toBe('Short menu text')
  })

  test('prompt command without menuDescription falls back to description', () => {
    // Arrange
    const cmd = makePromptCommand()

    // Act & Assert
    expect(menuDescriptionFor(cmd)).toBe('full model-facing description')
  })

  test('empty-string menuDescription falls back to description (official || semantics)', () => {
    // Arrange
    const cmd = makePromptCommand({ menuDescription: '' })

    // Act & Assert
    expect(menuDescriptionFor(cmd)).toBe('full model-facing description')
  })

  test('non-prompt command always returns description even if a menuDescription field exists', () => {
    // Arrange
    const cmd = {
      type: 'local',
      name: 'test-local',
      description: 'local description',
      menuDescription: 'should be ignored',
      supportsNonInteractive: true,
      load: async () => ({ call: async () => ({ type: 'skip' }) }),
    } as unknown as Cmd

    // Act & Assert
    expect(menuDescriptionFor(cmd)).toBe('local description')
  })
})

// ---------------------------------------------------------------------------
// registerBundledSkill converter (official function-valued drop)
// ---------------------------------------------------------------------------

describe('registerBundledSkill carries menuDescription through (CC 2.1.307 B7)', () => {
  beforeEach(() => clearBundledSkills())
  afterEach(() => clearBundledSkills())

  function baseDef(overrides: Record<string, unknown> = {}) {
    return {
      name: 'converter-test',
      description: 'converter full description',
      getPromptForCommand: async () => [{ type: 'text', text: 'x' }],
      ...overrides,
    } as never
  }

  test('string menuDescription is carried onto the Command', () => {
    // Act
    registerBundledSkill(baseDef({ menuDescription: 'Short one' }))

    // Assert
    const cmd = getBundledSkills().find(c => c.name === 'converter-test')
    expect(cmd).toBeDefined()
    expect(cmd!.type === 'prompt' && cmd!.menuDescription).toBe('Short one')
    // raw description untouched (model-facing)
    expect(cmd!.description).toBe('converter full description')
  })

  test('function-valued menuDescription is dropped (official typeof==="function"?void 0 guard)', () => {
    // Act — official def type tolerates functions; the converter must not
    // leak one onto the Command.
    registerBundledSkill(
      baseDef({ menuDescription: () => 'from function' } as never),
    )

    // Assert
    const cmd = getBundledSkills().find(c => c.name === 'converter-test')
    expect(cmd).toBeDefined()
    expect(cmd!.type === 'prompt' && cmd!.menuDescription).toBeUndefined()
  })

  test('absent menuDescription stays undefined', () => {
    // Act
    registerBundledSkill(baseDef())

    // Assert
    const cmd = getBundledSkills().find(c => c.name === 'converter-test')
    expect(cmd!.type === 'prompt' && cmd!.menuDescription).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Bundled-skill definitions carry the official verbatim menuDescription
// values (byte-verified against /tmp/cc-diff-308/new307.txt).
// ---------------------------------------------------------------------------

const OFFICIAL_MENU_DESCRIPTIONS: Array<[file: string, value: string]> = [
  ['claudeApi.ts', 'Build and debug apps that use the Claude API'],
  ['batch.ts', 'Plan a large change; background agents each open a PR'],
  [
    'claudeInChrome.ts',
    'Let Claude browse and interact with pages in your Chrome',
  ],
  ['debug.ts', 'Turn on debug logging and investigate problems'],
  [
    'updateConfig.ts',
    'Change settings: hooks, permissions, environment variables',
  ],
  ['loop.ts', 'Repeat a prompt or command on an interval (e.g. /loop 5m /foo)'],
  [
    'simplify.ts',
    'Clean up the changed code without changing behavior',
  ],
  ['simplify.ts', 'Review the current diff or a PR for bugs and cleanups'],
]

describe('bundled skill defs carry official verbatim menuDescription values (CC 2.1.307 B7)', () => {
  for (const [file, value] of OFFICIAL_MENU_DESCRIPTIONS) {
    test(`${file} registers menuDescription ${JSON.stringify(value)}`, () => {
      // Arrange
      const src = readFileSync(
        join(import.meta.dir, '..', 'bundled', file),
        'utf8',
      )

      // Act & Assert — verbatim official string present as a menuDescription
      expect(src).toContain(`menuDescription: '${value}'`)
    })
  }

  test('claude-api menuDescription matches the official Ri() registration exactly', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'bundled', 'claudeApi.ts'),
      'utf8',
    )
    expect(src).toContain(
      "menuDescription: 'Build and debug apps that use the Claude API'",
    )
  })
})

// ---------------------------------------------------------------------------
// Consumers wired to the resolver; SDK tables keep raw description.
// ---------------------------------------------------------------------------

describe('menu-description consumers (CC 2.1.307 B7)', () => {
  test('/help Commands list resolves through menuDescriptionFor and keeps source decoration', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../components/HelpV2/Commands.tsx'),
      'utf8',
    )
    expect(src).toContain('menuDescriptionFor')
    expect(src).toContain('formatDescriptionWithSource')
  })

  test('slash-command suggestions resolve through menuDescriptionFor', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../utils/suggestions/commandSuggestions.ts'),
      'utf8',
    )
    expect(src).toContain('menuDescriptionFor')
    expect(src).toContain('formatDescriptionWithSource')
  })

  test('SDK tables in src/cli/print.ts keep the RAW description (no resolver)', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../cli/print.ts'),
      'utf8',
    )
    expect(src).not.toContain('menuDescriptionFor')
  })
})
