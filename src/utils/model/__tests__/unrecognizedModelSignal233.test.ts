import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

/**
 * 2.1.233 alignment (OCC-95): `[claude-code:unrecognized_model]` diagnostic.
 * One-time per-model warning when a query goes out with a model the CLI does
 * not recognize; stderr in print mode, debug log in interactive sessions.
 */

// Silence the override path through a mocked modelStrings BEFORE the signal
// module (and model.ts) load — mirrors the official `zo`/`vHr` reverse lookup
// where a modelOverrides value silences the signal. Keep every real export
// and only override resolveOverriddenModel.
import * as realModelStrings from '../modelStrings.js'

mock.module('../modelStrings.js', () => ({
  ...realModelStrings,
  resolveOverriddenModel: (m: string) =>
    m === 'my-bedrock-arn' ? 'claude-opus-5' : m,
}))

const {
  UNRECOGNIZED_MODEL_TAG,
  isModelRecognized,
  resetUnrecognizedModelSignalForTesting,
  signalUnrecognizedModel,
} = await import('../unrecognizedModelSignal.js')
const { getIsInteractive, setIsInteractive } = await import(
  '../../../bootstrap/state.js'
)

const ENV_KEY = 'CLAUDE_CODE_SESSION_KIND'
let savedInteractive: boolean
let savedSessionKind: string | undefined
let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>
let stderrWrites: string[]

beforeEach(() => {
  savedInteractive = getIsInteractive()
  savedSessionKind = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  setIsInteractive(false) // print mode — the diagnostic writes to stderr
  resetUnrecognizedModelSignalForTesting()
  stderrWrites = []
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  stderrSpy.mockRestore()
  setIsInteractive(savedInteractive)
  if (savedSessionKind === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedSessionKind
  }
  resetUnrecognizedModelSignalForTesting()
})

afterAll(() => {
  resetUnrecognizedModelSignalForTesting()
})

describe('2.1.233 — isModelRecognized', () => {
  test('known first-party models are recognized', () => {
    for (const model of [
      'claude-opus-5',
      'claude-opus-4-7-20250101',
      'claude-sonnet-4-5',
      'claude-3-5-haiku-20241022',
      'claude-mythos-preview',
      'us.anthropic.claude-opus-4-6-v1:0',
    ]) {
      expect(isModelRecognized(model)).toBe(true)
    }
  })

  test('unknown models are not recognized', () => {
    for (const model of ['my-custom-model', 'gpt-x', 'claude-unknown']) {
      expect(isModelRecognized(model)).toBe(false)
    }
  })

  test('a modelOverrides value resolves to its recognized key (silencing)', () => {
    // Mocked resolveOverriddenModel maps 'my-bedrock-arn' → 'claude-opus-5'.
    expect(isModelRecognized('my-bedrock-arn')).toBe(true)
  })
})

describe('2.1.233 — signalUnrecognizedModel', () => {
  test('unrecognized model in print mode writes the exact stderr line', () => {
    signalUnrecognizedModel('my-custom-model', 'repl_main_thread')
    expect(stderrWrites).toEqual([
      `${UNRECOGNIZED_MODEL_TAG} ${JSON.stringify({
        model: 'my-custom-model',
        query_source: 'repl_main_thread',
      })}\n`,
    ])
  })

  test('the signal fires at most once per model per process', () => {
    signalUnrecognizedModel('my-custom-model', 'repl_main_thread')
    signalUnrecognizedModel('my-custom-model', 'side_query')
    // The dedup key is the normalized model — ANSI width markers included.
    signalUnrecognizedModel('my-custom-model[1m]', 'repl_main_thread')
    expect(stderrWrites.length).toBe(1)
  })

  test('recognized models stay silent', () => {
    signalUnrecognizedModel('claude-opus-5', 'repl_main_thread')
    signalUnrecognizedModel('claude-3-5-haiku-20241022', 'side_query')
    expect(stderrWrites).toEqual([])
  })

  test('a modelOverrides-silenced model stays silent', () => {
    signalUnrecognizedModel('my-bedrock-arn', 'repl_main_thread')
    expect(stderrWrites).toEqual([])
  })

  test('interactive sessions do not write to stderr', () => {
    setIsInteractive(true)
    signalUnrecognizedModel('my-custom-model', 'repl_main_thread')
    expect(stderrWrites).toEqual([])
  })

  test('bg sessions do not write to stderr', () => {
    process.env[ENV_KEY] = 'bg'
    signalUnrecognizedModel('my-custom-model', 'repl_main_thread')
    expect(stderrWrites).toEqual([])
  })

  test('bedrock application-inference-profile models are skipped', () => {
    signalUnrecognizedModel(
      'my.application-inference-profile.arn',
      'repl_main_thread',
    )
    expect(stderrWrites).toEqual([])
  })

  test('the signal never throws', () => {
    expect(() => signalUnrecognizedModel('', 'repl_main_thread')).not.toThrow()
  })
})
