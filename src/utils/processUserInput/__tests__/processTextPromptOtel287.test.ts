import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.287 (#4) — "Added `prompt_text` to the OpenTelemetry `user_prompt`
 * event, a copy of `prompt` for backends that nest dotted keys; drop or mask
 * it wherever you drop or mask `prompt` (#70763)."
 *
 * Byte evidence (docs/gap-research-287/cluster-c-features.md §#4):
 *   v287 helper @203885633: G$t(e){let o=me(e);return{prompt:o,prompt_text:o}}
 *   — `me` is the redactor gated on OTEL_LOG_USER_PROMPTS (`pe()`), so the
 *   redacted value is computed ONCE and both keys are emitted from it.
 *   v287 builder: ys("user_prompt",{prompt_length:String(L.length),...G$t(L),
 *                 ...X&&{"prompt.id":X},"message.uuid":D})
 *   v286 builder carried the single field prompt:gDt(B) instead of the spread.
 *   `prompt_text` novelty: v286=2 → v287=3 (+1 = the G$t helper).
 * Scope note: the official also carries "message.uuid" on this event, but
 * that field pre-exists in v286 and OCC already omits it — a separate
 * pre-existing divergence, NOT part of the #4 v287 delta.
 */

// --- Mock seam (OCC-97: Bun's mock.module leaks across test files in the
// same worker — snapshot the real exports into a plain object BEFORE mocking,
// override logOTelEvent narrowly (the REAL redactIfDisabled stays live), and
// restore from the snapshot in afterAll). ---
const actualEventsModule = await import('../../telemetry/events.js')
const actualEventsExports = { ...actualEventsModule }
type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []
mock.module('../../telemetry/events.js', () => ({
  ...actualEventsExports,
  logOTelEvent: (
    name: string,
    attrs: Record<string, string | undefined> = {},
  ): Promise<void> => {
    otelCalls.push({ name, attrs })
    return Promise.resolve()
  },
}))

afterAll(() => {
  mock.module('../../telemetry/events.js', () => ({ ...actualEventsExports }))
})

const { processTextPrompt } = await import('../processTextPrompt.js')

const PROMPT_ENV_KEY = 'OTEL_LOG_USER_PROMPTS'
let savedPromptEnv: string | undefined

beforeAll(() => {
  savedPromptEnv = process.env[PROMPT_ENV_KEY]
})

afterEach(() => {
  otelCalls.length = 0
  if (savedPromptEnv === undefined) delete process.env[PROMPT_ENV_KEY]
  else process.env[PROMPT_ENV_KEY] = savedPromptEnv
})

function lastUserPromptAttrs(): Record<string, string | undefined> {
  const events = otelCalls.filter(c => c.name === 'user_prompt')
  expect(events).toHaveLength(1)
  return events[0]!.attrs
}

describe('2.1.287 (#4) — user_prompt OTEL event carries prompt_text beside prompt', () => {
  test('prompt logging enabled: prompt and prompt_text both carry the raw text', () => {
    process.env[PROMPT_ENV_KEY] = '1'

    processTextPrompt('hello telemetry world', [], [], [])

    const attrs = lastUserPromptAttrs()
    expect(attrs.prompt).toBe('hello telemetry world')
    expect(attrs.prompt_text).toBe('hello telemetry world')
    expect(attrs.prompt_text).toBe(attrs.prompt)
  })

  test('prompt logging disabled: prompt_text mirrors the prompt redaction ("drop or mask it wherever you drop or mask prompt")', () => {
    delete process.env[PROMPT_ENV_KEY]

    processTextPrompt('super secret prompt', [], [], [])

    const attrs = lastUserPromptAttrs()
    expect(attrs.prompt).toBe('<REDACTED>')
    expect(attrs.prompt_text).toBe('<REDACTED>')
    expect(attrs.prompt_text).toBe(attrs.prompt)
  })

  test('attr layout mirrors the official builder: prompt_length, ...G$t spread (prompt, prompt_text), prompt.id', () => {
    process.env[PROMPT_ENV_KEY] = '1'

    processTextPrompt('layout check', [], [], [])

    const attrs = lastUserPromptAttrs()
    expect(attrs.prompt_length).toBe(String('layout check'.length))
    // Insertion order mirrors the official
    // {prompt_length:String(L.length),...G$t(L),...X&&{"prompt.id":X}} builder.
    expect(Object.keys(attrs)).toEqual([
      'prompt_length',
      'prompt',
      'prompt_text',
      'prompt.id',
    ])
  })

  test('array input (SDK/VS Code shape): both keys carry the LAST text block', () => {
    process.env[PROMPT_ENV_KEY] = '1'

    processTextPrompt(
      [
        { type: 'text' as const, text: '<ide_selection>ctx</ide_selection>' },
        { type: 'text' as const, text: 'actual prompt' },
      ],
      [],
      [],
      [],
    )

    const attrs = lastUserPromptAttrs()
    expect(attrs.prompt).toBe('actual prompt')
    expect(attrs.prompt_text).toBe('actual prompt')
    expect(attrs.prompt_text).toBe(attrs.prompt)
  })
})
