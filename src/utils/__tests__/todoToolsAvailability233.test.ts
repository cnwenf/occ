import { afterEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.233 alignment (OCC-95): Todo/task-tracking tools are no longer
 * available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models;
 * CLAUDE_CODE_ENABLE_TODO_TOOLS=1 brings them back. Port of the official
 * `cX()` gate with the byte-identical restricted-model table
 * `[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]]`.
 */

let mockedMainLoopModel = 'claude-opus-4-7'

mock.module('../model/model.js', () => ({
  getMainLoopModel: () => mockedMainLoopModel,
}))

const { areTodoToolsAvailable } = await import('../todoToolsAvailability.js')

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

describe('2.1.233 — todo/task tool model gating', () => {
  test('models below the restricted thresholds keep todo tools', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-sonnet-4-5',
      'claude-fable-4',
      'claude-mythos-4-9',
      'claude-haiku-5', // family not in the restricted table
    ]) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(true)
    }
  })

  test('models at the restricted thresholds lose todo tools', () => {
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

  test('models newer than the restricted thresholds lose todo tools', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5-1', 'claude-mythos-6']) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(false)
    }
  })

  test('unrecognized model ids keep todo tools', () => {
    for (const model of ['my-custom-model', 'gpt-x', 'claude-unknown']) {
      mockedMainLoopModel = model
      expect(areTodoToolsAvailable()).toBe(true)
    }
  })

  test('CLAUDE_CODE_ENABLE_TODO_TOOLS=1 restores todo tools on restricted models', () => {
    mockedMainLoopModel = 'claude-opus-4-8'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, () => {
      expect(areTodoToolsAvailable()).toBe(true)
    })
  })

  test('CLAUDE_CODE_ENABLE_TODO_TOOLS=0 keeps the restriction', () => {
    mockedMainLoopModel = 'claude-sonnet-5'
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }, () => {
      expect(areTodoToolsAvailable()).toBe(false)
    })
  })
})
