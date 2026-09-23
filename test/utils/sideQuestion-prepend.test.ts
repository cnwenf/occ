import { describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { Message } from '../../src/types/message.js'

/**
 * CC 2.1.280 changelog #072 — runSideQuestion prepends the synthesized
 * in-progress tool_result message ahead of the question.
 *
 * Official m4e @212514171 (v280; 0 hits in v278):
 *   h=e?x(n.forkContextMessages):void 0;
 *   promptMessages:[...h?[h]:[],...w,Ae({content:...system-reminder...})]
 * (`w` = btw-history replay; OCC has no history store — see the
 * BTW_HISTORY_OMISSION divergence note in sideQuestion.ts.)
 */

type CapturedForkParams = {
  promptMessages: Message[]
  querySource: string
  maxTurns: number
}

let captured: CapturedForkParams | null = null

// Must be registered BEFORE sideQuestion.ts (and thus forkedAgent.js) loads.
// The mock must cover EVERY runtime export of forkedAgent.ts: sideQuestion.ts
// pulls in messages.ts, whose transitive graph reaches SkillTool.ts (imports
// shouldForkedSkillRunAsync) — a partial mock makes Bun fail module linking
// with "Export named ... not found".
mock.module('../../src/utils/forkedAgent.js', () => ({
  saveCacheSafeParams: () => {},
  getLastCacheSafeParams: () => null,
  createCacheSafeParams: () => ({}),
  createGetAppStateWithAllowedTools: (getAppState: unknown) => getAppState,
  shouldForkedSkillRunAsync: (command: { context?: string; background?: boolean }) =>
    command.context === 'fork' && command.background !== false,
  prepareForkedCommandContext: async () => {
    throw new Error('prepareForkedCommandContext not expected in this test')
  },
  extractResultText: () => '',
  createSubagentContext: () => {
    throw new Error('createSubagentContext not expected in this test')
  },
  runForkedAgent: async (params: CapturedForkParams) => {
    captured = params
    return {
      messages: [],
      totalUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: null,
        iterations: null,
        speed: null,
      },
    }
  },
}))

const { runSideQuestion } = await import('../../src/utils/sideQuestion.js')
const { createUserMessage } = await import('../../src/utils/messages.js')

const fakeCacheSafeParams = {} as import('../../src/utils/forkedAgent.js').CacheSafeParams

function synthesizedInProgressMessage(): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: 'tu_1',
        content:
          '[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]',
      },
    ],
    isMeta: true,
  }) as unknown as Message
}

describe('runSideQuestion — synthesized in-progress message prepend (CC 2.1.280 #072)', () => {
  test('prepends the synthesized message FIRST, question second', async () => {
    captured = null
    const synthesized = synthesizedInProgressMessage()
    await runSideQuestion({
      question: 'what is running?',
      cacheSafeParams: fakeCacheSafeParams,
      inProgressToolResultMessage: synthesized,
    })
    expect(captured).not.toBeNull()
    const prompt = captured?.promptMessages ?? []
    expect(prompt).toHaveLength(2)
    // Identity: the exact synthesized message object leads the prompt.
    expect(prompt[0]).toBe(synthesized)
    expect(prompt[0]?.type).toBe('user')
    expect(prompt[0]?.isMeta).toBe(true)
    // The question message follows and still carries the system-reminder.
    const questionContent = prompt[1]?.message?.content
    expect(typeof questionContent).toBe('string')
    expect(questionContent as string).toContain('<system-reminder>')
    expect(questionContent as string).toContain('what is running?')
  })

  test('without a synthesized message the prompt is just the question (unchanged behavior)', async () => {
    captured = null
    await runSideQuestion({
      question: 'plain question',
      cacheSafeParams: fakeCacheSafeParams,
    })
    const prompt = captured?.promptMessages ?? []
    expect(prompt).toHaveLength(1)
    expect(prompt[0]?.type).toBe('user')
    expect(prompt[0]?.isMeta ?? false).toBe(false)
    expect(prompt[0]?.message?.content as string).toContain('plain question')
  })

  test('undefined synthesized message behaves like absence', async () => {
    captured = null
    await runSideQuestion({
      question: 'q',
      cacheSafeParams: fakeCacheSafeParams,
      inProgressToolResultMessage: undefined,
    })
    expect(captured?.promptMessages).toHaveLength(1)
  })

  test('fork parameters are untouched by the prepend', async () => {
    captured = null
    await runSideQuestion({
      question: 'q',
      cacheSafeParams: fakeCacheSafeParams,
      inProgressToolResultMessage: synthesizedInProgressMessage(),
    })
    expect(captured?.querySource).toBe('side_question')
    expect(captured?.maxTurns).toBe(1)
  })
})
