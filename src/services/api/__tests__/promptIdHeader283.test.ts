/**
 * Official Claude Code 2.1.283 `x-claude-code-prompt-id` — unit tests for the
 * byte-verified port (official symbols in parens; binary offsets documented
 * in src/services/api/promptId.ts).
 *
 * Coverage per task requirements:
 *  - validator gate (en / d)
 *  - header emission: enabled / disabled / invalid-id (EV factory spread)
 *  - journal stamp/replace (U_e / qmt — OCC bootstrap/state getPromptId /
 *    setPromptId)
 *  - message derivation (SZt / EIe / Wve) + compaction backfill (hnr / iwr)
 *  - createUserMessage promptId passthrough (Ae factory spread)
 *  - attribution cc_prompt_id pair (r0r)
 *
 * Pure unit tests — no module mocking. Env save/restore follows the
 * gatewayHints273.test.ts + attributionHeader.test.ts patterns.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'

import { getPromptId, setPromptId } from 'src/bootstrap/state.js'
import { getAttributionHeader } from 'src/constants/system.js'
import type { Message } from 'src/types/message.js'
import type { AgentContext } from 'src/utils/agentContext.js'
import { runWithAgentContext } from 'src/utils/agentContext.js'
import { createUserMessage } from 'src/utils/messages.js'

import {
  PROMPT_ID_HEADER,
  PROMPT_ID_UUID_RE,
  backfillMessagePromptId,
  findLastRealUserTurnIndex,
  getMessagesPromptId,
  isForkBoilerplateMessage,
  isToolResultContent,
  resolveQueryPromptId,
  validatePromptId,
} from '../promptId.js'
import {
  AGENT_TYPE_HEADER,
  REQUEST_CLASS_HEADER,
  applyClientGatewayHintHeaders,
} from '../gatewayHints.js'

// getAttributionHeader reads MACRO.VERSION at call time — mirror the cli.tsx
// dev polyfill (same pattern as attributionHeader.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.999-test' }
}

const ENV_KEYS = [
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
] as const

const savedEnv: Record<string, string | undefined> = {}
let savedPromptId: string | null

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedPromptId = getPromptId()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setPromptId(savedPromptId)
})

const VALID_UUID = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
const OTHER_UUID = '0f0e0d0c-0b0a-4998-8776-655443322110'

function mkUser(
  content: unknown,
  extra: Record<string, unknown> = {},
): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content },
    ...extra,
  } as unknown as Message
}

function mkAssistant(): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  } as unknown as Message
}

// ---------------------------------------------------------------------------
// Constants (official bqn / d)
// ---------------------------------------------------------------------------

describe('2.1.283 promptId constants', () => {
  test('header name matches the official binary string (bqn)', () => {
    expect(PROMPT_ID_HEADER).toBe('x-claude-code-prompt-id')
  })

  test('UUID regex matches the official pattern verbatim (d)', () => {
    expect(PROMPT_ID_UUID_RE.source).toBe(
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    )
    expect(PROMPT_ID_UUID_RE.flags).toBe('i')
  })
})

// ---------------------------------------------------------------------------
// validatePromptId (official en)
// ---------------------------------------------------------------------------

describe('2.1.283 validatePromptId (en)', () => {
  test('returns a valid lowercase UUID unchanged', () => {
    expect(validatePromptId(VALID_UUID)).toBe(VALID_UUID)
  })

  test('accepts uppercase hex (regex is /i) and returns it unchanged', () => {
    const upper = VALID_UUID.toUpperCase()
    expect(validatePromptId(upper)).toBe(upper)
  })

  test('returns null for non-string values', () => {
    expect(validatePromptId(undefined)).toBeNull()
    expect(validatePromptId(null)).toBeNull()
    expect(validatePromptId(42)).toBeNull()
    expect(validatePromptId({ toString: () => VALID_UUID })).toBeNull()
  })

  test('returns null for malformed UUID strings', () => {
    expect(validatePromptId('')).toBeNull()
    expect(validatePromptId(VALID_UUID.replace('-', ''))).toBeNull()
    expect(validatePromptId(`${VALID_UUID}0`)).toBeNull()
    expect(validatePromptId(`g${VALID_UUID.slice(1)}`)).toBeNull()
    expect(validatePromptId(` ${VALID_UUID}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyClientGatewayHintHeaders (official EV factory spread, 283 arm)
// ---------------------------------------------------------------------------

describe('2.1.283 applyClientGatewayHintHeaders', () => {
  test('gate enabled + valid promptId → header emitted verbatim', () => {
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1'
    const headers: Record<string, string> = {}
    applyClientGatewayHintHeaders(headers, 'repl_main_thread', VALID_UUID)
    expect(headers[PROMPT_ID_HEADER]).toBe(VALID_UUID)
  })

  test('gate enabled + invalid promptId → no header (en(S)!==null arm)', () => {
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1'
    const headers: Record<string, string> = {}
    applyClientGatewayHintHeaders(headers, 'repl_main_thread', 'not-a-uuid')
    expect(PROMPT_ID_HEADER in headers).toBe(false)
  })

  test('gate enabled + undefined promptId → no header (S!==void 0 arm)', () => {
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1'
    const headers: Record<string, string> = {}
    applyClientGatewayHintHeaders(headers, 'repl_main_thread', undefined)
    expect(PROMPT_ID_HEADER in headers).toBe(false)
  })

  test('gate disabled → no prompt-id header even with a valid id', () => {
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '0'
    const headers: Record<string, string> = {}
    applyClientGatewayHintHeaders(headers, 'repl_main_thread', VALID_UUID)
    expect(PROMPT_ID_HEADER in headers).toBe(false)
    expect(REQUEST_CLASS_HEADER in headers).toBe(false)
  })

  test('gate unset + non-first-party base URL → no header', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const headers: Record<string, string> = {}
    applyClientGatewayHintHeaders(headers, 'repl_main_thread', VALID_UUID)
    expect(PROMPT_ID_HEADER in headers).toBe(false)
  })

  test('2.1.273 request-class/agent-type emission is unchanged (regression)', () => {
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1'
    const mainHeaders: Record<string, string> = {}
    applyClientGatewayHintHeaders(
      mainHeaders,
      'repl_main_thread',
      VALID_UUID,
    )
    expect(mainHeaders[REQUEST_CLASS_HEADER]).toBe('main')
    expect(AGENT_TYPE_HEADER in mainHeaders).toBe(false)

    const agentHeaders: Record<string, string> = {}
    const ctx = {
      agentId: 'agent-1',
      agentType: 'subagent',
      subagentName: 'Explore',
      isBuiltIn: true,
    } as unknown as AgentContext
    runWithAgentContext(ctx, () => {
      applyClientGatewayHintHeaders(
        agentHeaders,
        'agent:builtin:Explore',
        VALID_UUID,
      )
    })
    expect(agentHeaders[REQUEST_CLASS_HEADER]).toBe('subagent')
    expect(agentHeaders[AGENT_TYPE_HEADER]).toBe('Explore')
    expect(agentHeaders[PROMPT_ID_HEADER]).toBe(VALID_UUID)
  })
})

// ---------------------------------------------------------------------------
// Journal stamp/replace (official U_e / qmt — RequestJournal.promptId /
// replacePromptId)
// ---------------------------------------------------------------------------

describe('2.1.283 promptId journal (U_e/qmt)', () => {
  test('setPromptId stamps and getPromptId reads back', () => {
    setPromptId(VALID_UUID)
    expect(getPromptId()).toBe(VALID_UUID)
  })

  test('replacePromptId semantics: a later stamp replaces the earlier one', () => {
    setPromptId(VALID_UUID)
    setPromptId(OTHER_UUID)
    expect(getPromptId()).toBe(OTHER_UUID)
  })

  test('clearing back to null works', () => {
    setPromptId(VALID_UUID)
    setPromptId(null)
    expect(getPromptId()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Content predicates (official Zfe / lmt)
// ---------------------------------------------------------------------------

describe('2.1.283 isToolResultContent (Zfe)', () => {
  test('true when any block is a tool_result', () => {
    expect(
      isToolResultContent([
        { type: 'text', text: 'x' },
        { type: 'tool_result', tool_use_id: 't1', content: '' },
      ]),
    ).toBe(true)
  })

  test('false for plain text content, non-arrays, and empty arrays', () => {
    expect(isToolResultContent([{ type: 'text', text: 'x' }])).toBe(false)
    expect(isToolResultContent('a string')).toBe(false)
    expect(isToolResultContent(undefined)).toBe(false)
    expect(isToolResultContent([])).toBe(false)
  })
})

describe('2.1.283 isForkBoilerplateMessage (lmt)', () => {
  test('true for a user message whose text starts with <fork-boilerplate>', () => {
    expect(
      isForkBoilerplateMessage(
        mkUser([{ type: 'text', text: '<fork-boilerplate>ctx</fork-boilerplate>' }]),
      ),
    ).toBe(true)
  })

  test('false for assistant messages and non-matching text', () => {
    expect(isForkBoilerplateMessage(mkAssistant())).toBe(false)
    expect(isForkBoilerplateMessage(mkUser('hello'))).toBe(false)
    expect(
      isForkBoilerplateMessage(mkUser([{ type: 'text', text: 'fork-boilerplate' }])),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Message derivation (official SZt / EIe)
// ---------------------------------------------------------------------------

describe('2.1.283 findLastRealUserTurnIndex / getMessagesPromptId (SZt/EIe)', () => {
  test('empty or assistant-only arrays → -1 / undefined', () => {
    expect(findLastRealUserTurnIndex([])).toBe(-1)
    expect(getMessagesPromptId([])).toBeUndefined()
    expect(getMessagesPromptId([mkAssistant()])).toBeUndefined()
  })

  test('reads the promptId off the last real user turn', () => {
    const messages = [
      mkUser('first', { promptId: VALID_UUID }),
      mkAssistant(),
      mkUser('second', { promptId: OTHER_UUID }),
    ]
    expect(findLastRealUserTurnIndex(messages)).toBe(2)
    expect(getMessagesPromptId(messages)).toBe(OTHER_UUID)
  })

  test('trailing tool_result user messages are skipped (Zfe arm)', () => {
    const messages = [
      mkUser('real turn', { promptId: VALID_UUID }),
      mkAssistant(),
      mkUser([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]),
    ]
    expect(findLastRealUserTurnIndex(messages)).toBe(0)
    expect(getMessagesPromptId(messages)).toBe(VALID_UUID)
  })

  test('fork-boilerplate as the last user message → -1 (lmt arm)', () => {
    const messages = [
      mkUser('real turn', { promptId: VALID_UUID }),
      mkUser([
        { type: 'text', text: '<fork-boilerplate>parent ctx</fork-boilerplate>' },
      ]),
    ]
    expect(findLastRealUserTurnIndex(messages)).toBe(-1)
    expect(getMessagesPromptId(messages)).toBeUndefined()
  })

  test('isMeta/isVirtual/isVisibleInTranscriptOnly without promptId are skipped', () => {
    const messages = [
      mkUser('real turn', { promptId: VALID_UUID }),
      mkUser('meta noise', { isMeta: true }),
      mkUser('virtual noise', { isVirtual: true }),
      mkUser('hidden noise', { isVisibleInTranscriptOnly: true }),
    ]
    expect(findLastRealUserTurnIndex(messages)).toBe(0)
    expect(getMessagesPromptId(messages)).toBe(VALID_UUID)
  })

  test('a stamped meta message IS a real turn (promptId || !(isMeta...) arm)', () => {
    const messages = [
      mkUser('real turn', { promptId: VALID_UUID }),
      mkUser('stamped meta', { isMeta: true, promptId: OTHER_UUID }),
    ]
    expect(findLastRealUserTurnIndex(messages)).toBe(1)
    expect(getMessagesPromptId(messages)).toBe(OTHER_UUID)
  })

  test('an unselected real turn without promptId → undefined (EIe tail)', () => {
    const messages = [mkUser('plain human turn')]
    expect(findLastRealUserTurnIndex(messages)).toBe(0)
    expect(getMessagesPromptId(messages)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveQueryPromptId (official Wve — message derivation + subagent
// parentPromptId fallback)
// ---------------------------------------------------------------------------

describe('2.1.283 resolveQueryPromptId (Wve)', () => {
  const subagentCtx = (
    overrides: Record<string, unknown> = {},
  ): AgentContext =>
    ({
      agentId: 'agent-1',
      agentType: 'subagent',
      parentPromptId: OTHER_UUID,
      ...overrides,
    }) as unknown as AgentContext

  test('message-derived id wins over the context fallback', () => {
    const messages = [mkUser('turn', { promptId: VALID_UUID })]
    expect(resolveQueryPromptId(messages, subagentCtx())).toBe(VALID_UUID)
  })

  test('falls back to parentPromptId for subagent contexts', () => {
    expect(resolveQueryPromptId([], subagentCtx())).toBe(OTHER_UUID)
    expect(resolveQueryPromptId([mkAssistant()], subagentCtx())).toBe(
      OTHER_UUID,
    )
  })

  test('no fallback when isMainSession is true (official !n.isMainSession)', () => {
    expect(
      resolveQueryPromptId([], subagentCtx({ isMainSession: true })),
    ).toBeUndefined()
  })

  test('no fallback for teammate contexts (UE = agentType==="subagent")', () => {
    const teammate = {
      agentId: 't@team',
      agentName: 't',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'sess',
      isTeamLead: false,
      agentType: 'teammate',
      parentPromptId: OTHER_UUID,
    } as unknown as AgentContext
    expect(resolveQueryPromptId([], teammate)).toBeUndefined()
  })

  test('no context (main thread) and no message id → undefined', () => {
    expect(resolveQueryPromptId([], undefined)).toBeUndefined()
    expect(resolveQueryPromptId([mkUser('plain')], undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// backfillMessagePromptId (official hnr/iwr promptId half)
// ---------------------------------------------------------------------------

describe('2.1.283 backfillMessagePromptId (hnr/iwr)', () => {
  test('stamps the derived id onto summary messages that lack one', () => {
    const source = [mkUser('turn', { promptId: VALID_UUID }), mkAssistant()]
    const summary = [mkUser('Summary of the conversation')]
    const result = backfillMessagePromptId(summary, source)
    expect(result).toHaveLength(1)
    expect(result[0]?.promptId).toBe(VALID_UUID)
    // Original array is not mutated (immutable map).
    expect((summary[0] as { promptId?: string }).promptId).toBeUndefined()
  })

  test('messages that already carry a promptId keep it', () => {
    const source = [mkUser('turn', { promptId: VALID_UUID })]
    const summary = [mkUser('kept', { promptId: OTHER_UUID })]
    const result = backfillMessagePromptId(summary, source)
    expect(result[0]?.promptId).toBe(OTHER_UUID)
  })

  test('nothing to derive → identity (same array reference, iwr early return)', () => {
    const summary = [mkUser('Summary')]
    expect(backfillMessagePromptId(summary, [mkAssistant()])).toBe(summary)
    expect(backfillMessagePromptId(summary, [])).toBe(summary)
  })
})

// ---------------------------------------------------------------------------
// createUserMessage passthrough (official Ae factory spread)
// ---------------------------------------------------------------------------

describe('2.1.283 createUserMessage promptId (Ae)', () => {
  test('stamps promptId when provided', () => {
    const m = createUserMessage({ content: 'hi', promptId: VALID_UUID })
    expect(m.promptId).toBe(VALID_UUID)
  })

  test('omits the key entirely when not provided (conditional spread)', () => {
    const m = createUserMessage({ content: 'hi' })
    expect('promptId' in m).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Attribution header cc_prompt_id (official r0r arm)
// ---------------------------------------------------------------------------

describe('2.1.283 getAttributionHeader cc_prompt_id (r0r)', () => {
  test('emits the pair on plain first-party with a valid UUID', () => {
    const header = getAttributionHeader('fp', { promptId: VALID_UUID })
    expect(header).toContain(` cc_prompt_id=${VALID_UUID};`)
    // Field order: promptId pair follows cc_entrypoint (no cch/workload in
    // the clean test env), matching the official template tail `...${Xe}${Ze}`.
    expect(header).toContain(`cc_entrypoint=unknown; cc_prompt_id=${VALID_UUID};`)
  })

  test('no pair when promptId is undefined', () => {
    expect(getAttributionHeader('fp')).not.toContain('cc_prompt_id')
    expect(getAttributionHeader('fp', {})).not.toContain('cc_prompt_id')
  })

  test('no pair for a malformed UUID (inline regex gate)', () => {
    expect(getAttributionHeader('fp', { promptId: 'evil; cc_x=1' })).not.toContain(
      'cc_prompt_id',
    )
  })

  test('no pair for non-firstParty providers (d==="firstParty" gate)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(
      getAttributionHeader('fp', { promptId: VALID_UUID }),
    ).not.toContain('cc_prompt_id')
  })

  test('no pair behind a custom base URL (Os gate)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    expect(
      getAttributionHeader('fp', { promptId: VALID_UUID }),
    ).not.toContain('cc_prompt_id')
  })

  test('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL forces the Os arm on', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(getAttributionHeader('fp', { promptId: VALID_UUID })).toContain(
      ` cc_prompt_id=${VALID_UUID};`,
    )
  })

  test('the attribution env opt-out still suppresses the whole header', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    expect(getAttributionHeader('fp', { promptId: VALID_UUID })).toBe('')
  })
})
