import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

// The fetch path reads MACRO.VERSION (a build-time constant polyfilled in
// cli.tsx). Mirror that polyfill so the module imports cleanly under test.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.299 (#156): "WebFetch page reads pick effort like web searches: the
 * caller's effort level when the read runs on the caller's model, otherwise
 * the small-model setting."
 *
 * Official forensics (v299/v296 ELF, /tmp/cc-diff-299 — offsets into
 * package/claude; full notes in ../utils.ts on WebFetchApplyEffort):
 *   - `helperEffortFor` is true-new in v299 (11 string hits vs 0 in v296).
 *   - v299 `VTt` @225757953 (WebFetch apply) threads it into the helper query
 *     options; v296 `avt` @217539548 is identical without it.
 *   - v299 `nen` @219478902:
 *     `UBn(o,Tc(e))?{effortValue:jh(e),...}:{effortValue:Rks(...),turnEffort:void 0}`
 *     — family match (`UBn`=`lK` equality, @218710257) → caller's effort.
 *   - `JD`/`BNr` @226727688 spreads `...h?.(S)` (helperEffortFor called with
 *     the resolved helper model) into the request options.
 *
 * OCC reduction under test: webFetchApplyEffortValue (family match →
 * caller's appState.effortValue — the same source WebSearchTool passes;
 * mismatch → undefined, since OCC has no per-model settings-effort table)
 * and its wiring through applyPromptToMarkdown into queryHaiku options.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only queryHaiku, and restore after.
const actualClaude = await import('../../../services/api/claude.js')

let capturedOptions: Record<string, unknown> | undefined

mock.module('../../../services/api/claude.js', () => ({
  ...actualClaude,
  queryHaiku: async (args: { options: Record<string, unknown> }) => {
    capturedOptions = args.options
    return {
      message: { content: [{ type: 'text', text: 'SUMMARY' }] },
    }
  },
}))

// Fresh utils instance via a cache-busting suffix (same OCC-97 rationale as
// applyPromptContentLead018.test.ts): a fresh evaluation deterministically
// binds queryHaiku to the mocked claude.js.
const { applyPromptToMarkdown, webFetchApplyEffortValue } = await import(
  '../utils.js?applyEffort299'
)

// getSmallFastModel() reads the env at call time — pin it so the integration
// assertions are provider/default independent.
const SMALL_MODEL_ENV = 'ANTHROPIC_SMALL_FAST_MODEL'
let savedSmallModelEnv: string | undefined

beforeAll(() => {
  savedSmallModelEnv = process.env[SMALL_MODEL_ENV]
  process.env[SMALL_MODEL_ENV] = 'claude-haiku-4-5'
})

afterAll(() => {
  mock.module('../../../services/api/claude.js', () => ({ ...actualClaude }))
  if (savedSmallModelEnv === undefined) {
    delete process.env[SMALL_MODEL_ENV]
  } else {
    process.env[SMALL_MODEL_ENV] = savedSmallModelEnv
  }
})

afterEach(() => {
  capturedOptions = undefined
})

describe('#156 — webFetchApplyEffortValue (official nen effortValue half)', () => {
  test('caller model in the small-model family → the caller effort', () => {
    expect(
      webFetchApplyEffortValue(
        { callerModel: 'claude-haiku-4-5-20251001', callerEffortValue: 'high' },
        'claude-haiku-4-5',
      ),
    ).toBe('high')
  })

  test('numeric effort values pass through unchanged', () => {
    expect(
      webFetchApplyEffortValue(
        { callerModel: 'claude-haiku-4-5', callerEffortValue: 42 },
        'claude-haiku-4-5',
      ),
    ).toBe(42)
  })

  test('different family → undefined (official Rks settings-effort branch; no OCC per-model settings-effort table)', () => {
    expect(
      webFetchApplyEffortValue(
        { callerModel: 'claude-sonnet-4-5', callerEffortValue: 'high' },
        'claude-haiku-4-5',
      ),
    ).toBeUndefined()
  })

  test('family match with no caller effort → undefined (official jh(e) may be unset)', () => {
    expect(
      webFetchApplyEffortValue(
        { callerModel: 'claude-haiku-4-5' },
        'claude-haiku-4-5',
      ),
    ).toBeUndefined()
  })

  test('missing callerModel / missing argument → undefined (fail-closed)', () => {
    expect(
      webFetchApplyEffortValue({ callerEffortValue: 'high' }, 'claude-haiku-4-5'),
    ).toBeUndefined()
    expect(webFetchApplyEffortValue(undefined, 'claude-haiku-4-5')).toBeUndefined()
  })

  test('the [1m] tag does not break family equality (official lK strips it)', () => {
    expect(
      webFetchApplyEffortValue(
        { callerModel: 'claude-haiku-4-5[1m]', callerEffortValue: 'medium' },
        'claude-haiku-4-5',
      ),
    ).toBe('medium')
  })

  test('defaults the helper model to getSmallFastModel() (env-pinned above)', () => {
    expect(
      webFetchApplyEffortValue({
        callerModel: 'claude-haiku-4-5',
        callerEffortValue: 'low',
      }),
    ).toBe('low')
    expect(
      webFetchApplyEffortValue({
        callerModel: 'claude-opus-5',
        callerEffortValue: 'low',
      }),
    ).toBeUndefined()
  })
})

describe('#156 — applyPromptToMarkdown wiring (official BNr `...h?.(S)` spread)', () => {
  const signal = () => new AbortController().signal

  test('family match: the caller effort reaches the queryHaiku options', async () => {
    await applyPromptToMarkdown('summarize', 'page body', signal(), false, false, '', {
      callerModel: 'claude-haiku-4-5',
      callerEffortValue: 'xhigh',
    })
    expect(capturedOptions?.effortValue).toBe('xhigh')
    // Prior option fields preserved (web_fetch_apply unchanged).
    expect(capturedOptions?.querySource).toBe('web_fetch_apply')
  })

  test('family mismatch: no effortValue on the apply query (pre-#156 behavior)', async () => {
    await applyPromptToMarkdown('summarize', 'page body', signal(), false, false, '', {
      callerModel: 'claude-sonnet-4-5',
      callerEffortValue: 'xhigh',
    })
    expect(capturedOptions?.effortValue).toBeUndefined()
  })

  test('no effort argument (legacy callers): no effortValue, options unchanged', async () => {
    await applyPromptToMarkdown('summarize', 'page body', signal(), false, false)
    expect(capturedOptions?.effortValue).toBeUndefined()
    expect(capturedOptions?.querySource).toBe('web_fetch_apply')
    expect(capturedOptions?.hasAppendSystemPrompt).toBe(false)
  })
})
