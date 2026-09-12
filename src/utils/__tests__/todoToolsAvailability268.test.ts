import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.268 alignment (supersedes the 2.1.233 denylist port): Todo/task-tracking
 * tools are gated by a model ALLOWLIST. Port of the official `dD()` gate with
 * the byte-identical `JAo` 15-id allowlist. Models NOT in the set — including
 * former denylist entries (Opus 4.8+, Sonnet 5+, Fable 5+, Mythos 5+) and any
 * newer/unknown id — hide the tools unless CLAUDE_CODE_ENABLE_TODO_TOOLS is
 * truthy. Official `pl()` (bg sessions) / `Ozn()` (SDK launchOptions) overrides
 * are N/A — those surfaces are trimmed from OCC.
 */

let mockedMainLoopModel: string | undefined = 'claude-opus-4-7'

// OCC-97 (Gap-97b): Bun's mock.module registration leaks into test files that
// run later in the same worker. A factory returning ONLY getMainLoopModel
// stripped every other export of model.js for those files. Spread the real
// module and override just the one function this suite needs; re-register the
// untouched module after the suite so later files see the real implementation.
const actualModelModule = await import('../model/model.js')

mock.module('../model/model.js', () => ({
  ...actualModelModule,
  getMainLoopModel: () => mockedMainLoopModel,
}))

afterAll(() => {
  mock.module('../model/model.js', () => ({ ...actualModelModule }))
})

const { areTodoToolsAvailable, TODO_TOOL_ALLOWED_MODELS } = await import(
  '../todoToolsAvailability.js'
)

function withEnv(env: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}

afterEach(() => {
  delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS
})

describe('2.1.268 — todo/task tool model allowlist', () => {
  test('TODO_TOOL_ALLOWED_MODELS is byte-identical to the official JAo set (exactly 15 ids)', () => {
    expect([...TODO_TOOL_ALLOWED_MODELS].sort()).toEqual(
      [
        'claude-3-opus',
        'claude-3-sonnet',
        'claude-3-haiku',
        'claude-3-5-sonnet',
        'claude-3-5-haiku',
        'claude-3-7-sonnet',
        'claude-opus-4-0',
        'claude-opus-4-1',
        'claude-opus-4-5',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-sonnet-4-0',
        'claude-sonnet-4-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ].sort(),
    )
    expect(TODO_TOOL_ALLOWED_MODELS.size).toBe(15)
  })

  test('allowlisted models keep todo tools', () => {
    for (const model of TODO_TOOL_ALLOWED_MODELS) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(true)
    }
  })

  test('former denylist entries lose todo tools (not in the allowlist)', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(false)
    }
  })

  test('unknown / newer model ids lose todo tools (allowlist is closed)', () => {
    for (const model of [
      'my-custom-model',
      'gpt-x',
      'claude-unknown',
      'claude-opus-5',
      'claude-sonnet-5-1',
    ]) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(false)
    }
  })

  test('CLAUDE_CODE_ENABLE_TODO_TOOLS=1 restores todo tools for non-allowlisted models', () => {
    mockedMainLoopModel = 'claude-opus-4-8'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, () => {
      expect(areTodoToolsAvailable()).toBe(true)
    })
  })

  test('CLAUDE_CODE_ENABLE_TODO_TOOLS=true (case-insensitive) restores todo tools', () => {
    mockedMainLoopModel = 'claude-sonnet-5'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true' }, () => {
      expect(areTodoToolsAvailable()).toBe(true)
    })
  })

  test('CLAUDE_CODE_ENABLE_TODO_TOOLS=0 keeps the restriction', () => {
    mockedMainLoopModel = 'claude-sonnet-5'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }, () => {
      expect(areTodoToolsAvailable()).toBe(false)
    })
  })

  test('allowlisted models keep todo tools even with the env var set to 0', () => {
    mockedMainLoopModel = 'claude-opus-4-7'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }, () => {
      expect(areTodoToolsAvailable()).toBe(true)
    })
  })

  test('Bedrock application inference profiles keep todo tools', () => {
    mockedMainLoopModel =
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile'
    expect(areTodoToolsAvailable()).toBe(true)
  })

  test('undefined model keeps todo tools (official e===void 0 fallthrough)', () => {
    mockedMainLoopModel = undefined
    expect(areTodoToolsAvailable()).toBe(true)
  })
})
