/**
 * CC 2.1.296 #055 — with --debug, name unrecognized frontmatter fields in
 * custom agent files, with typo hints.
 *
 * Official recognized-field whitelist (`Wf` @210942084, forensics-batch3):
 *   name, description, prompt, tools, disallowedTools, model, effort,
 *   permissionMode, mcpServers, hooks, maxTurns, autoCompactWindow, skills,
 *   initialPrompt, memory, background, omitClaudeMd, isolation
 * OCC unions in its own supported keys (color, experimental) so it never
 * warns for fields it actually honors.
 *
 * DEVIATION NOTE: the exact official message string was not captured in the
 * 2.1.296 forensics — OCC composes it in its existing agent-warning style
 * ("Agent file <path> has unrecognized frontmatter field '<f>'. Did you mean
 * '<s>'?"). Tests assert OCC's composed message, not an official verbatim.
 *
 * DEDICATED mock.module FILE: bun's mock.module is process-global — the
 * debug.js capture mock must not share a file with other tests. The actual
 * module is re-pinned in afterAll.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// --- Capture seam: logForDebugging -----------------------------------------
const actualDebugModule = await import('../../../utils/debug.js')
const capturedLogs: Array<{ message: string; level?: string }> = []

mock.module('../../../utils/debug.js', () => ({
  ...(actualDebugModule as object),
  logForDebugging: (message: string, opts?: { level?: string }) => {
    capturedLogs.push({ message, level: opts?.level })
  },
}))

const {
  RECOGNIZED_AGENT_FRONTMATTER_FIELDS,
  findUnrecognizedAgentFrontmatterFields,
  parseAgentFromMarkdown,
  suggestRecognizedAgentField,
} = await import('../loadAgentsDir.js')

beforeEach(() => {
  capturedLogs.length = 0
})

afterAll(() => {
  mock.module('../../../utils/debug.js', () => actualDebugModule as object)
})

// ---------------------------------------------------------------------------
// Recognized-field whitelist
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #055: RECOGNIZED_AGENT_FRONTMATTER_FIELDS', () => {
  test('contains every official Wf whitelist field', () => {
    // Arrange — official list, verbatim from forensics-batch3 @210942084
    const officialWf = [
      'name',
      'description',
      'prompt',
      'tools',
      'disallowedTools',
      'model',
      'effort',
      'permissionMode',
      'mcpServers',
      'hooks',
      'maxTurns',
      'autoCompactWindow',
      'skills',
      'initialPrompt',
      'memory',
      'background',
      'omitClaudeMd',
      'isolation',
    ]

    // Assert
    for (const field of officialWf) {
      expect(RECOGNIZED_AGENT_FRONTMATTER_FIELDS).toContain(field)
    }
  })

  test('unions in OCC-supported additions (color, experimental)', () => {
    // Assert — OCC honors these; warning for them would be a false positive
    expect(RECOGNIZED_AGENT_FRONTMATTER_FIELDS).toContain('color')
    expect(RECOGNIZED_AGENT_FRONTMATTER_FIELDS).toContain('experimental')
  })
})

// ---------------------------------------------------------------------------
// Typo suggestions
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #055: suggestRecognizedAgentField', () => {
  test('suggests the nearest recognized field for a one-edit typo', () => {
    // Act / Assert
    expect(suggestRecognizedAgentField('toolz')).toBe('tools')
    expect(suggestRecognizedAgentField('maxTurnss')).toBe('maxTurns')
    expect(suggestRecognizedAgentField('autoCompactWindows')).toBe(
      'autoCompactWindow',
    )
  })

  test('suggests for a two-edit typo (transposition)', () => {
    // Act / Assert — 'modle' → 'model' is a transposition (distance 2)
    expect(suggestRecognizedAgentField('modle')).toBe('model')
  })

  test('matches case-insensitively', () => {
    // Act / Assert
    expect(suggestRecognizedAgentField('MODEL')).toBe('model')
    expect(suggestRecognizedAgentField('Name')).toBe('name')
  })

  test('returns undefined when nothing is within edit distance 2', () => {
    // Act / Assert — no guess is better than a wrong guess
    expect(suggestRecognizedAgentField('qqqqqqqqqqqq')).toBeUndefined()
    expect(suggestRecognizedAgentField('kubernetesNamespace')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Unrecognized-field detection
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #055: findUnrecognizedAgentFrontmatterFields', () => {
  test('flags unknown fields with suggestions and skips recognized ones', () => {
    // Arrange
    const frontmatter = {
      name: 'agent-x',
      description: 'does things',
      color: 'red', // OCC-supported — must NOT be flagged
      experimental: { cacheTtl: '5m' }, // OCC-supported — must NOT be flagged
      toolz: ['Bash'], // typo — flagged with suggestion
      qqqqqqqqqqqq: true, // unknown — flagged without suggestion
    }

    // Act
    const found = findUnrecognizedAgentFrontmatterFields(frontmatter)

    // Assert
    expect(found).toEqual([
      { field: 'toolz', suggestion: 'tools' },
      { field: 'qqqqqqqqqqqq', suggestion: undefined },
    ])
  })

  test('returns an empty list when every field is recognized', () => {
    // Arrange
    const frontmatter = {
      name: 'agent-x',
      description: 'does things',
      tools: ['Bash'],
      model: 'sonnet',
      autoCompactWindow: 250_000,
      color: 'blue',
    }

    // Act / Assert
    expect(findUnrecognizedAgentFrontmatterFields(frontmatter)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseAgentFromMarkdown warning emission (--debug surface)
// ---------------------------------------------------------------------------

function makeFrontmatter(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: 'warn-agent', description: 'demo agent', ...extra }
}

describe('CC 2.1.296 #055: parseAgentFromMarkdown warnings', () => {
  test('logs a named warning with a typo hint for unrecognized fields', () => {
    // Arrange
    const filePath = '/tmp/agents/warn-agent.md'

    // Act — agent still parses; the warning is advisory
    const agent = parseAgentFromMarkdown(
      filePath,
      '/tmp/agents',
      makeFrontmatter({ toolz: 'Bash' }),
      'body',
      'userSettings',
    )

    // Assert
    expect(agent).not.toBeNull()
    const warning = capturedLogs.find(m =>
      m.message.includes('unrecognized frontmatter field'),
    )
    expect(warning).toBeDefined()
    expect(warning?.message).toBe(
      `Agent file ${filePath} has unrecognized frontmatter field 'toolz'. Did you mean 'tools'?`,
    )
  })

  test('logs without a hint when no recognized field is close', () => {
    // Act
    parseAgentFromMarkdown(
      '/tmp/agents/warn-agent.md',
      '/tmp/agents',
      makeFrontmatter({ qqqqqqqqqqqq: true }),
      'body',
      'userSettings',
    )

    // Assert
    const warning = capturedLogs.find(m =>
      m.message.includes('unrecognized frontmatter field'),
    )
    expect(warning?.message).toBe(
      "Agent file /tmp/agents/warn-agent.md has unrecognized frontmatter field 'qqqqqqqqqqqq'",
    )
  })

  test('does not warn for recognized fields (official + OCC additions)', () => {
    // Act
    parseAgentFromMarkdown(
      '/tmp/agents/warn-agent.md',
      '/tmp/agents',
      makeFrontmatter({
        color: 'red',
        experimental: { cacheTtl: '1h' },
        autoCompactWindow: 250_000,
        maxTurns: 3,
      }),
      'body',
      'userSettings',
    )

    // Assert
    expect(
      capturedLogs.some(m =>
        m.message.includes('unrecognized frontmatter field'),
      ),
    ).toBe(false)
  })

  test('logs an invalid autoCompactWindow and drops the field', () => {
    // Act
    const agent = parseAgentFromMarkdown(
      '/tmp/agents/warn-agent.md',
      '/tmp/agents',
      makeFrontmatter({ autoCompactWindow: 50 }),
      'body',
      'userSettings',
    )

    // Assert
    expect(agent?.autoCompactWindow).toBeUndefined()
    expect(
      capturedLogs.some(m =>
        m.message.includes("has invalid autoCompactWindow '50'"),
      ),
    ).toBe(true)
  })
})
