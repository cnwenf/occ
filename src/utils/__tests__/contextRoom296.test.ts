import { describe, expect, test } from 'bun:test'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import { bytesPerTokenForModel } from '../../services/tokenEstimation.js'
import type { Message } from '../../types/message.js'
import {
  CUTOFF_RESUME_REWRITE_TEXT,
  CUTOFF_RESUME_STREAM_TEXT,
  isSyntheticLoopFeedbackMetaRow,
} from '../messages.js'
import {
  type ContextRoom,
  contextManagementClearedTokens,
  createContextRoom,
  isAnsweredAssistantTurn,
  isCutoffResumeMetaRow,
  sumClearedInputTokens,
} from '../contextRoom.js'
import { tokenCountWithEstimation } from '../tokens.js'

/**
 * Claude Code 2.1.296 (OCC-154 #006, Slice A): the per-turn "context room"
 * infrastructure that Read's new `allow_large` mode consults to decide how
 * much of an oversized file still fits in the current turn.
 *
 * Official pieces ported (v296 ELF offsets, byte-verified):
 *   bytesPerToken `kh` @210122985:   `function kh(e){if(!e)return 4;
 *     let n=Dt(e),r=Ht(We(n)).replace(/[._]/g,"-");return rF.has(r)?4:3}`
 *   legacy set `rF` @210122710:      14 canonical model names → 4 bytes/tok
 *   room factory `ra` @224116753:    try/catch initial threshold → undefined
 *     on failure; `{get threshold(){return na(e(),o)}, held:()=>Ff(n(),
 *     e().bytesPerToken)+IHe(n()), claimed:()=>r, claim:(u)=>{r+=u}}`
 *   held cleared-tokens `IHe` @216454443: backward scan — compact boundary
 *     → 0; skip non-assistant / no-usage / zero-usage; skip no-cm rows with
 *     stop_reason===null or answered (syr); return Oms(cm)
 *   answered-turn `syr` @211732941:  stop_reason ∈ {tool_use,end_turn} then
 *     forward scan — user → CAs; assistant isApiErrorMessage → error===
 *     "server_error"; different message id → false; end → false
 *   cleared sum `Oms` @211732714:    applied_edits entries of type
 *     clear_tool_uses_20250919 with finite ≥0 cleared_input_tokens
 *   cutoff carrier `CAs` @207902421: synthetic loop-feedback meta row whose
 *     first text content is one of the two cut-off-resume texts (nMt/rMt)
 *   query wiring @224224750:         `contextRoom:ra(()=>Rt,
 *     p.options.autoCompactWindow,()=>P)` per turn
 *
 * OCC mapping: `na` (extra-usage clamp) → getAutoCompactThreshold directly
 * (the clamp reads subscription surfaces OCC lacks — documented
 * simplification); `Ff` → tokenCountWithEstimation with the new optional
 * bytesPerToken param; `e().bytesPerToken` → bytesPerTokenForModel(model).
 * OCC canonical names for bare Claude 4.0 models are 'claude-opus-4' /
 * 'claude-sonnet-4' where the official set spells them 'claude-opus-4-0' /
 * 'claude-sonnet-4-0' — the legacy set carries both spellings.
 */

const LEGACY_MODEL = 'claude-sonnet-4-5'
const MODERN_MODEL = 'claude-opus-5'

let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

type UsageFixture = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type AssistantOpts = {
  id?: string
  usage?: UsageFixture
  stopReason?: string | null
  contextManagement?: unknown
  isApiErrorMessage?: boolean
  error?: string
  content?: unknown[]
}

function makeAssistant(opts: AssistantOpts = {}): Message {
  const {
    id = `resp-${nextUuid()}`,
    usage = { input_tokens: 1000, output_tokens: 50 },
    stopReason = 'tool_use',
    contextManagement,
    isApiErrorMessage,
    error,
    content = [],
  } = opts
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: '2026-10-10T00:00:00.000Z',
    ...(isApiErrorMessage !== undefined ? { isApiErrorMessage } : {}),
    ...(error !== undefined ? { error } : {}),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: LEGACY_MODEL,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      ...(contextManagement !== undefined
        ? { context_management: contextManagement }
        : {}),
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  } as unknown as Message
}

function makeUser(text: string, isMeta = false): Message {
  return {
    type: 'user',
    uuid: nextUuid(),
    timestamp: '2026-10-10T00:00:00.000Z',
    ...(isMeta ? { isMeta: true } : {}),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as unknown as Message
}

function makeCompactBoundary(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: nextUuid(),
    timestamp: '2026-10-10T00:00:00.000Z',
    compactMetadata: {},
    message: { role: 'system', content: [] },
  } as unknown as Message
}

const CM_5000 = {
  applied_edits: [
    { type: 'clear_tool_uses_20250919', cleared_input_tokens: 5000 },
  ],
}

describe('2.1.296 #006: bytesPerTokenForModel (official kh + rF)', () => {
  test('empty/undefined model → 4', () => {
    expect(bytesPerTokenForModel(undefined)).toBe(4)
    expect(bytesPerTokenForModel('')).toBe(4)
  })

  test('legacy canonical models → 4', () => {
    expect(bytesPerTokenForModel('claude-sonnet-4-5')).toBe(4)
    expect(bytesPerTokenForModel('claude-sonnet-4-5-20250514')).toBe(4)
    expect(bytesPerTokenForModel('claude-opus-4-6')).toBe(4)
    expect(bytesPerTokenForModel('claude-opus-4-1')).toBe(4)
    expect(bytesPerTokenForModel('claude-haiku-4-5')).toBe(4)
    expect(bytesPerTokenForModel('claude-3-5-haiku-20241022')).toBe(4)
    expect(bytesPerTokenForModel('claude-3-7-sonnet-latest')).toBe(4)
  })

  test('bare Claude 4.0 models map through the OCC canonical alias → 4', () => {
    // Official rF spells these 'claude-opus-4-0'/'claude-sonnet-4-0'; OCC
    // getCanonicalName returns 'claude-opus-4'/'claude-sonnet-4'.
    expect(bytesPerTokenForModel('claude-opus-4-20250514')).toBe(4)
    expect(bytesPerTokenForModel('claude-sonnet-4-20250514')).toBe(4)
  })

  test('3P provider spellings canonicalize into the legacy set → 4', () => {
    expect(bytesPerTokenForModel('us.anthropic.claude-sonnet-4-5-v1:0')).toBe(4)
  })

  test('modern models → 3', () => {
    expect(bytesPerTokenForModel('claude-opus-5')).toBe(3)
    expect(bytesPerTokenForModel('claude-sonnet-5')).toBe(3)
    expect(bytesPerTokenForModel('claude-fable-5')).toBe(3)
    expect(bytesPerTokenForModel('claude-opus-4-8')).toBe(3)
  })

  test('unknown models → 3 (official: everything not in rF)', () => {
    expect(bytesPerTokenForModel('some-custom-model')).toBe(3)
  })
})

describe('2.1.296 #006: tokenCountWithEstimation bytesPerToken threading', () => {
  test('estimation slice uses the given ratio; default stays 4', () => {
    const messages: Message[] = [makeUser('a'.repeat(1200))]
    // No usage anchor → whole-transcript rough estimate.
    expect(tokenCountWithEstimation(messages)).toBe(300)
    expect(tokenCountWithEstimation(messages, 4)).toBe(300)
    expect(tokenCountWithEstimation(messages, 3)).toBe(400)
  })

  test('post-anchor slice uses the given ratio too', () => {
    const messages: Message[] = [
      makeAssistant({ usage: { input_tokens: 1000, output_tokens: 50 } }),
      makeUser('b'.repeat(900)),
    ]
    // anchor tokens = 1050; trailing user slice = round(900/bpt)
    expect(tokenCountWithEstimation(messages)).toBe(1050 + 225)
    expect(tokenCountWithEstimation(messages, 3)).toBe(1050 + 300)
  })
})

describe('2.1.296 #006: sumClearedInputTokens (official Oms)', () => {
  test('undefined / non-object / non-array applied_edits → 0', () => {
    expect(sumClearedInputTokens(undefined)).toBe(0)
    expect(sumClearedInputTokens(null)).toBe(0)
    expect(sumClearedInputTokens({})).toBe(0)
    expect(sumClearedInputTokens({ applied_edits: 'nope' })).toBe(0)
  })

  test('sums only clear_tool_uses_20250919 entries with finite ≥0 tokens', () => {
    expect(
      sumClearedInputTokens({
        applied_edits: [
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: 3000 },
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: 2000 },
          { type: 'some_other_edit', cleared_input_tokens: 9999 },
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: -5 },
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: Number.NaN },
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: '100' },
          { type: 'clear_tool_uses_20250919' },
          null,
          'junk',
        ],
      }),
    ).toBe(5000)
  })

  test('zero counts are valid (finite ≥ 0)', () => {
    expect(
      sumClearedInputTokens({
        applied_edits: [
          { type: 'clear_tool_uses_20250919', cleared_input_tokens: 0 },
        ],
      }),
    ).toBe(0)
  })
})

describe('2.1.296 #006: isCutoffResumeMetaRow (official CAs)', () => {
  test('isMeta user row carrying either cut-off text → true', () => {
    expect(isCutoffResumeMetaRow(makeUser(CUTOFF_RESUME_STREAM_TEXT, true))).toBe(
      true,
    )
    expect(
      isCutoffResumeMetaRow(makeUser(CUTOFF_RESUME_REWRITE_TEXT, true)),
    ).toBe(true)
  })

  test('non-meta row with the same text → false', () => {
    expect(isCutoffResumeMetaRow(makeUser(CUTOFF_RESUME_STREAM_TEXT))).toBe(
      false,
    )
  })

  test('isMeta row with a different synthetic nudge → false', () => {
    expect(
      isCutoffResumeMetaRow(
        makeUser(
          'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
          true,
        ),
      ),
    ).toBe(false)
  })

  test('assistant rows are never carriers', () => {
    expect(isCutoffResumeMetaRow(makeAssistant())).toBe(false)
  })

  test('the cutoff texts remain synthetic loop-feedback meta rows', () => {
    expect(
      isSyntheticLoopFeedbackMetaRow(makeUser(CUTOFF_RESUME_STREAM_TEXT, true)),
    ).toBe(true)
    expect(
      isSyntheticLoopFeedbackMetaRow(makeUser(CUTOFF_RESUME_REWRITE_TEXT, true)),
    ).toBe(true)
  })
})

describe('2.1.296 #006: isAnsweredAssistantTurn (official syr)', () => {
  test('non-assistant index → false', () => {
    const messages = [makeUser('hi')]
    expect(isAnsweredAssistantTurn(messages, 0)).toBe(false)
  })

  test('stop_reason outside {tool_use,end_turn} → false', () => {
    const messages = [
      makeAssistant({ stopReason: null }),
      makeUser(CUTOFF_RESUME_STREAM_TEXT, true),
    ]
    expect(isAnsweredAssistantTurn(messages, 0)).toBe(false)
    const maxTokens = [
      makeAssistant({ stopReason: 'max_tokens' }),
      makeUser(CUTOFF_RESUME_STREAM_TEXT, true),
    ]
    expect(isAnsweredAssistantTurn(maxTokens, 0)).toBe(false)
  })

  test('nothing after the assistant → false', () => {
    expect(isAnsweredAssistantTurn([makeAssistant()], 0)).toBe(false)
  })

  test('next user row: cutoff-resume carrier → true, ordinary → false', () => {
    const answered = [
      makeAssistant({ stopReason: 'end_turn' }),
      makeUser(CUTOFF_RESUME_REWRITE_TEXT, true),
    ]
    expect(isAnsweredAssistantTurn(answered, 0)).toBe(true)
    const ordinary = [makeAssistant(), makeUser('real user turn')]
    expect(isAnsweredAssistantTurn(ordinary, 0)).toBe(false)
  })

  test('next assistant API-error row: server_error → true, other → false', () => {
    const serverError = [
      makeAssistant(),
      makeAssistant({ isApiErrorMessage: true, error: 'server_error' }),
    ]
    expect(isAnsweredAssistantTurn(serverError, 0)).toBe(true)
    const overloaded = [
      makeAssistant(),
      makeAssistant({ isApiErrorMessage: true, error: 'overloaded_error' }),
    ]
    expect(isAnsweredAssistantTurn(overloaded, 0)).toBe(false)
  })

  test('same-id sibling continuation keeps scanning; different id → false', () => {
    const sameId = [
      makeAssistant({ id: 'resp-1' }),
      makeAssistant({ id: 'resp-1' }),
      makeUser(CUTOFF_RESUME_STREAM_TEXT, true),
    ]
    expect(isAnsweredAssistantTurn(sameId, 0)).toBe(true)
    const differentId = [
      makeAssistant({ id: 'resp-1' }),
      makeAssistant({ id: 'resp-2' }),
      makeUser(CUTOFF_RESUME_STREAM_TEXT, true),
    ]
    expect(isAnsweredAssistantTurn(differentId, 0)).toBe(false)
  })
})

describe('2.1.296 #006: contextManagementClearedTokens (official IHe)', () => {
  test('empty transcript → 0', () => {
    expect(contextManagementClearedTokens([])).toBe(0)
  })

  test('reads cleared tokens off the newest eligible assistant row', () => {
    expect(
      contextManagementClearedTokens([
        makeUser('prompt'),
        makeAssistant({ contextManagement: CM_5000 }),
      ]),
    ).toBe(5000)
  })

  test('compact boundary anywhere in the backward scan → 0', () => {
    expect(
      contextManagementClearedTokens([
        makeAssistant({ contextManagement: CM_5000 }),
        makeCompactBoundary(),
        makeAssistant(),
      ]),
    ).toBe(0)
  })

  test('zero-usage assistant rows are skipped', () => {
    expect(
      contextManagementClearedTokens([
        makeAssistant({ contextManagement: CM_5000 }),
        makeAssistant({
          contextManagement: {
            applied_edits: [
              { type: 'clear_tool_uses_20250919', cleared_input_tokens: 7000 },
            ],
          },
          usage: { input_tokens: 0, output_tokens: 10 },
        }),
      ]),
    ).toBe(5000)
  })

  test('no-cm rows with stop_reason===null are skipped (still streaming)', () => {
    expect(
      contextManagementClearedTokens([
        makeAssistant({ contextManagement: CM_5000 }),
        makeAssistant({ stopReason: null }),
      ]),
    ).toBe(5000)
  })

  test('no-cm answered rows (syr) are skipped; the walk continues', () => {
    expect(
      contextManagementClearedTokens([
        makeAssistant({ contextManagement: CM_5000 }),
        makeAssistant({ stopReason: 'end_turn' }),
        makeUser(CUTOFF_RESUME_STREAM_TEXT, true),
      ]),
    ).toBe(5000)
  })

  test('no-cm UNanswered terminal row stops the scan with 0', () => {
    // syr false (nothing follows) and stop_reason !== null → the row is
    // eligible, and Oms(undefined) === 0.
    expect(
      contextManagementClearedTokens([
        makeAssistant({ contextManagement: CM_5000 }),
        makeAssistant({ stopReason: 'end_turn' }),
      ]),
    ).toBe(0)
  })

  test('assistant without cm but eligible returns 0 (official Oms(undefined))', () => {
    expect(
      contextManagementClearedTokens([makeAssistant({ stopReason: null })]),
    ).toBe(0)
  })
})

describe('2.1.296 #006: createContextRoom (official ra)', () => {
  test('threshold mirrors getAutoCompactThreshold for the current model', () => {
    let model = LEGACY_MODEL
    const room = createContextRoom({
      getModel: () => model,
      getMessages: () => [],
    }) as ContextRoom
    expect(room).toBeDefined()
    expect(room.threshold).toBe(getAutoCompactThreshold(LEGACY_MODEL))
    // The getter recomputes — official `get threshold(){return na(e(),o)}`.
    model = MODERN_MODEL
    expect(room.threshold).toBe(getAutoCompactThreshold(MODERN_MODEL))
  })

  test('returns undefined when the initial threshold resolution throws', () => {
    const room = createContextRoom({
      getModel: () => {
        throw new Error('model state unavailable')
      },
      getMessages: () => [],
    })
    expect(room).toBeUndefined()
  })

  test('held() = token estimate at the model ratio + cleared tokens', () => {
    const messages: Message[] = [makeUser('c'.repeat(900))]
    const room = createContextRoom({
      getModel: () => MODERN_MODEL, // bytesPerToken 3
      getMessages: () => messages,
    }) as ContextRoom
    expect(room.held()).toBe(300)

    const withCleared: Message[] = [
      makeAssistant({ contextManagement: CM_5000 }),
      makeUser('c'.repeat(900)),
    ]
    const room2 = createContextRoom({
      getModel: () => LEGACY_MODEL, // bytesPerToken 4
      getMessages: () => withCleared,
    }) as ContextRoom
    // anchor 1050 + trailing user round(900/4)=225 + cleared 5000
    expect(room2.held()).toBe(1050 + 225 + 5000)
  })

  test('claimed()/claim() accumulate from zero', () => {
    const room = createContextRoom({
      getModel: () => LEGACY_MODEL,
      getMessages: () => [],
    }) as ContextRoom
    expect(room.claimed()).toBe(0)
    room.claim(1200)
    room.claim(300)
    expect(room.claimed()).toBe(1500)
  })

  test('held() tracks the live messages getter (official ()=>P)', () => {
    let messages: Message[] = []
    const room = createContextRoom({
      getModel: () => MODERN_MODEL,
      getMessages: () => messages,
    }) as ContextRoom
    expect(room.held()).toBe(0)
    messages = [makeUser('d'.repeat(300))]
    expect(room.held()).toBe(100)
  })
})
