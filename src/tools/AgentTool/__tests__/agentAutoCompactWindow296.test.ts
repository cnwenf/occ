/**
 * CC 2.1.296 #002 — `autoCompactWindow` in subagent frontmatter + --agents
 * definitions.
 *
 * Official schema (ev-agentfw296.txt @208188475), ported VERBATIM:
 *   autoCompactWindow: E().int().min(b0).max(TN).optional().describe(
 *     "Token count at which this agent compacts its own conversation when it
 *      runs as a subagent. It only lowers the window the subagent would
 *      otherwise inherit. No effect on the main session agent.")
 *
 * Bounds b0/TN are the settings-level autoCompactWindow bounds
 * (AUTO_COMPACT_WINDOW_MIN=100_000 / AUTO_COMPACT_WINDOW_MAX=1_000_000).
 *
 * Consumption semantics under test: subagent effective window =
 * min(inherited window, definition value) — it can only LOWER the window;
 * the main session (no override) is unaffected.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AgentDefinitionSchema } from '../../../entrypoints/sdk/coreSchemas.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '../../../services/compact/autoCompact.js'
import { getMaxOutputTokensForModel } from '../../../services/api/claude.js'
import {
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  setSessionAutoCompactWindow,
} from '../../../utils/autoCompactWindow.js'
import {
  AgentJsonSchema,
  parseAgentFromJson,
  parseAgentFromMarkdown,
} from '../loadAgentsDir.js'

const TEST_MODEL = 'claude-sonnet-4-6'
const WINDOW_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const PCT_ENV_KEY = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'

beforeEach(() => {
  delete process.env[WINDOW_ENV_KEY]
  delete process.env[PCT_ENV_KEY]
  setSessionAutoCompactWindow(undefined)
})

afterEach(() => {
  delete process.env[WINDOW_ENV_KEY]
  delete process.env[PCT_ENV_KEY]
  setSessionAutoCompactWindow(undefined)
})

// ---------------------------------------------------------------------------
// Schema bounds (--agents JSON definition path)
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #002: AgentJsonSchema autoCompactWindow bounds', () => {
  const base = { description: 'demo agent', prompt: 'You are a demo.' }

  test('accepts integers within [MIN, MAX] including both bounds', () => {
    // Arrange / Act
    const atMin = AgentJsonSchema().safeParse({
      ...base,
      autoCompactWindow: AUTO_COMPACT_WINDOW_MIN,
    })
    const atMax = AgentJsonSchema().safeParse({
      ...base,
      autoCompactWindow: AUTO_COMPACT_WINDOW_MAX,
    })

    // Assert
    expect(atMin.success).toBe(true)
    expect(atMax.success).toBe(true)
  })

  test('rejects values below AUTO_COMPACT_WINDOW_MIN', () => {
    // Act
    const result = AgentJsonSchema().safeParse({
      ...base,
      autoCompactWindow: AUTO_COMPACT_WINDOW_MIN - 1,
    })

    // Assert
    expect(result.success).toBe(false)
  })

  test('rejects values above AUTO_COMPACT_WINDOW_MAX', () => {
    // Act
    const result = AgentJsonSchema().safeParse({
      ...base,
      autoCompactWindow: AUTO_COMPACT_WINDOW_MAX + 1,
    })

    // Assert
    expect(result.success).toBe(false)
  })

  test('rejects non-integers', () => {
    // Act
    const result = AgentJsonSchema().safeParse({
      ...base,
      autoCompactWindow: 250_000.5,
    })

    // Assert
    expect(result.success).toBe(false)
  })

  test('is optional', () => {
    // Act
    const result = AgentJsonSchema().safeParse(base)

    // Assert
    expect(result.success).toBe(true)
  })
})

describe('CC 2.1.296 #002: SDK AgentDefinitionSchema describe text', () => {
  test('carries the official VERBATIM description and bounds', () => {
    // Arrange
    const shape = AgentDefinitionSchema().shape
    const field = shape.autoCompactWindow

    // Assert — official describe text, verbatim (ev-agentfw296.txt)
    expect(field?.description).toBe(
      'Token count at which this agent compacts its own conversation when it runs as a subagent. It only lowers the window the subagent would otherwise inherit. No effect on the main session agent.',
    )
    // Bounds enforced
    expect(
      AgentDefinitionSchema().safeParse({
        name: 'a',
        description: 'd',
        prompt: 'p',
        autoCompactWindow: AUTO_COMPACT_WINDOW_MIN - 1,
      }).success,
    ).toBe(false)
    expect(
      AgentDefinitionSchema().safeParse({
        name: 'a',
        description: 'd',
        prompt: 'p',
        autoCompactWindow: AUTO_COMPACT_WINDOW_MIN,
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// --agents JSON parsing path
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #002: parseAgentFromJson (--agents definitions)', () => {
  test('carries a valid autoCompactWindow onto the definition', () => {
    // Arrange
    const definition = {
      description: 'demo agent',
      prompt: 'You are a demo.',
      autoCompactWindow: 250_000,
    }

    // Act
    const agent = parseAgentFromJson('demo', definition)

    // Assert
    expect(agent).not.toBeNull()
    expect(agent?.autoCompactWindow).toBe(250_000)
  })

  test('omits autoCompactWindow when not provided', () => {
    // Act
    const agent = parseAgentFromJson('demo', {
      description: 'demo agent',
      prompt: 'You are a demo.',
    })

    // Assert
    expect(agent?.autoCompactWindow).toBeUndefined()
  })

  test('rejects the whole definition when autoCompactWindow is out of bounds', () => {
    // Act
    const agent = parseAgentFromJson('demo', {
      description: 'demo agent',
      prompt: 'You are a demo.',
      autoCompactWindow: 50,
    })

    // Assert — zod .parse throws → parseAgentFromJson returns null
    expect(agent).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Markdown frontmatter path
// ---------------------------------------------------------------------------

function makeFrontmatter(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: 'acw-agent', description: 'demo agent', ...extra }
}

describe('CC 2.1.296 #002: parseAgentFromMarkdown autoCompactWindow', () => {
  test('parses a numeric frontmatter value', () => {
    // Act
    const agent = parseAgentFromMarkdown(
      '/tmp/agents/acw.md',
      '/tmp/agents',
      makeFrontmatter({ autoCompactWindow: 300_000 }),
      'body',
      'userSettings',
    )

    // Assert
    expect(agent?.autoCompactWindow).toBe(300_000)
  })

  test('parses a string frontmatter value (YAML quoting)', () => {
    // Act
    const agent = parseAgentFromMarkdown(
      '/tmp/agents/acw.md',
      '/tmp/agents',
      makeFrontmatter({ autoCompactWindow: '250000' }),
      'body',
      'userSettings',
    )

    // Assert
    expect(agent?.autoCompactWindow).toBe(250_000)
  })

  test('ignores (omits) an out-of-range value', () => {
    // Act
    const agent = parseAgentFromMarkdown(
      '/tmp/agents/acw.md',
      '/tmp/agents',
      makeFrontmatter({ autoCompactWindow: 99 }),
      'body',
      'userSettings',
    )

    // Assert — agent still loads, field dropped
    expect(agent).not.toBeNull()
    expect(agent?.autoCompactWindow).toBeUndefined()
  })

  test('ignores a non-integer value', () => {
    // Act
    const agent = parseAgentFromMarkdown(
      '/tmp/agents/acw.md',
      '/tmp/agents',
      makeFrontmatter({ autoCompactWindow: 'soon' }),
      'body',
      'userSettings',
    )

    // Assert
    expect(agent?.autoCompactWindow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Consumption: min() lowering semantics + main session unaffected
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #002: subagent window override consumption', () => {
  const reserved = Math.min(
    getMaxOutputTokensForModel(TEST_MODEL),
    20_000, // MAX_OUTPUT_TOKENS_FOR_SUMMARY
  )

  test('lowers the effective window to the override (min semantics)', () => {
    // Arrange
    const inherited = getEffectiveContextWindowSize(TEST_MODEL)
    const override = AUTO_COMPACT_WINDOW_MIN // 100k — far below any model window

    // Act
    const effective = getEffectiveContextWindowSize(TEST_MODEL, override)

    // Assert — override wins when it is lower: window = override - reserved
    expect(inherited).toBeGreaterThan(override - reserved)
    expect(effective).toBe(override - reserved)
  })

  test('never RAISES the window above the inherited value', () => {
    // Arrange
    const inherited = getEffectiveContextWindowSize(TEST_MODEL)

    // Act — MAX bound override (1M) may exceed the resolved model window
    const effective = getEffectiveContextWindowSize(
      TEST_MODEL,
      AUTO_COMPACT_WINDOW_MAX,
    )

    // Assert — min() semantics: no higher than inherited
    expect(effective).toBeLessThanOrEqual(inherited)
  })

  test('threshold follows the lowered window', () => {
    // Arrange
    const override = 200_000

    // Act
    const threshold = getAutoCompactThreshold(TEST_MODEL, override)

    // Assert
    expect(threshold).toBe(override - reserved - AUTOCOMPACT_BUFFER_TOKENS)
  })

  test('main session (no override) is unaffected by prior override calls', () => {
    // Arrange
    const before = getEffectiveContextWindowSize(TEST_MODEL)

    // Act — subagent-style call, then main-session-style call again
    getEffectiveContextWindowSize(TEST_MODEL, AUTO_COMPACT_WINDOW_MIN)
    const after = getEffectiveContextWindowSize(TEST_MODEL)

    // Assert — no global mutation; "No effect on the main session agent."
    expect(after).toBe(before)
  })

  test('an inherited LOWER window still wins over a higher override', () => {
    // Arrange — session-level window lowered below the override
    setSessionAutoCompactWindow(150_000)
    const inherited = getEffectiveContextWindowSize(TEST_MODEL)

    // Act
    const effective = getEffectiveContextWindowSize(TEST_MODEL, 900_000)

    // Assert — min(inherited, override) = inherited
    expect(effective).toBe(inherited)
  })
})
