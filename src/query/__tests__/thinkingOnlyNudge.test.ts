import { afterEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  hasVisibleText,
  isStructuredOutputTurn,
  isTerminalMcpToolTurn,
  isTextlessQuerySource,
  THINKING_ONLY_NUDGE_TEXT,
} from '../thinkingOnlyNudge.js'

/**
 * OCC-99: unit tests for the thinking-only-nudge helper predicates ported
 * from official 2.1.283 (ELF md5 b5afa820...). Offsets cited per helper in
 * ../thinkingOnlyNudge.ts. The nudge condition itself is covered end-to-end
 * by test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts.
 */

function userMsg(
  content: unknown,
  extra: Record<string, unknown> = {},
): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    ...extra,
  } as unknown as Message
}

function assistantMsg(content: unknown[]): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
  } as unknown as Message
}

describe('THINKING_ONLY_NUDGE_TEXT', () => {
  test('is byte-exact official I$t (@197449268)', () => {
    expect(THINKING_ONLY_NUDGE_TEXT).toBe(
      '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
    )
  })
})

describe('isTextlessQuerySource (official nVe/MFn @204278422)', () => {
  test('true for the four official textless sources', () => {
    for (const source of [
      'prompt_suggestion',
      'away_summary',
      'agent_summary',
      'narration',
    ]) {
      expect(isTextlessQuerySource(source)).toBe(true)
    }
  })

  test('false for regular sources and undefined', () => {
    expect(isTextlessQuerySource('sdk')).toBe(false)
    expect(isTextlessQuerySource('repl_main_thread')).toBe(false)
    expect(isTextlessQuerySource(undefined)).toBe(false)
  })
})

describe('hasVisibleText', () => {
  test('false for thinking-only assistant messages', () => {
    expect(
      hasVisibleText([
        assistantMsg([{ type: 'thinking', thinking: 'deep thought' }]),
      ]),
    ).toBe(false)
  })

  test('false for whitespace-only text (official uses .trim().length>0)', () => {
    expect(
      hasVisibleText([assistantMsg([{ type: 'text', text: '   \n  ' }])]),
    ).toBe(false)
  })

  test('true when any message has non-empty trimmed text', () => {
    expect(
      hasVisibleText([
        assistantMsg([{ type: 'thinking', thinking: 'x' }]),
        assistantMsg([{ type: 'text', text: 'hi' }]),
      ]),
    ).toBe(true)
  })

  test('false for empty list / non-array content', () => {
    expect(hasVisibleText([])).toBe(false)
    expect(hasVisibleText([assistantMsg('plain string' as never)])).toBe(false)
  })
})

describe('isStructuredOutputTurn (official ie @211160472)', () => {
  const structuredToolUse = {
    type: 'tool_use',
    id: 'tu_1',
    name: 'StructuredOutput',
    input: { answer: 42 },
  }

  test('true when walk-back hits a StructuredOutput tool_use before a real user message', () => {
    expect(
      isStructuredOutputTurn([
        userMsg('do the task'),
        assistantMsg([structuredToolUse]),
        userMsg([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]),
        assistantMsg([{ type: 'thinking', thinking: 'hmm' }]),
      ]),
    ).toBe(true)
  })

  test('skips meta user messages during walk-back', () => {
    expect(
      isStructuredOutputTurn([
        userMsg('real prompt'),
        assistantMsg([structuredToolUse]),
        userMsg('injected reminder', { isMeta: true }),
      ]),
    ).toBe(true)
  })

  test('stops at a real user message → false', () => {
    expect(
      isStructuredOutputTurn([
        assistantMsg([structuredToolUse]),
        userMsg('a real follow-up question'),
        assistantMsg([{ type: 'thinking', thinking: 'hmm' }]),
      ]),
    ).toBe(false)
  })

  test('false when the turn has no StructuredOutput tool call', () => {
    expect(
      isStructuredOutputTurn([
        userMsg('hi'),
        assistantMsg([{ type: 'thinking', thinking: 'hmm' }]),
      ]),
    ).toBe(false)
  })

  test('ignores non-StructuredOutput tool_use names', () => {
    expect(
      isStructuredOutputTurn([
        userMsg('run it'),
        assistantMsg([
          { type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} },
        ]),
      ]),
    ).toBe(false)
  })
})

describe('isTerminalMcpToolTurn (official Ggo/r$e @206152475)', () => {
  const SAVED = process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS
  afterEach(() => {
    if (SAVED === undefined) {
      delete process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS
    } else {
      process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS = SAVED
    }
  })

  test('false when env unset (official early return on empty set)', () => {
    delete process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS
    expect(
      isTerminalMcpToolTurn([
        assistantMsg([
          { type: 'tool_use', id: 'tu_1', name: 'mcp__term__exit', input: {} },
        ]),
        userMsg([
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'bye' },
        ]),
      ]),
    ).toBe(false)
  })

  test('true when a terminal MCP tool has a successful tool_result', () => {
    process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS = 'mcp__term__exit, other_tool'
    expect(
      isTerminalMcpToolTurn([
        userMsg('go'),
        assistantMsg([
          { type: 'tool_use', id: 'tu_1', name: 'mcp__term__exit', input: {} },
        ]),
        userMsg([
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'bye' },
        ]),
      ]),
    ).toBe(true)
  })

  test('false when the terminal tool result is an error (is_error)', () => {
    process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS = 'mcp__term__exit'
    expect(
      isTerminalMcpToolTurn([
        userMsg('go'),
        assistantMsg([
          { type: 'tool_use', id: 'tu_1', name: 'mcp__term__exit', input: {} },
        ]),
        userMsg([
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'boom',
            is_error: true,
          },
        ]),
      ]),
    ).toBe(false)
  })

  test('false when walk-back reaches a real user message without tool_result', () => {
    process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS = 'mcp__term__exit'
    expect(
      isTerminalMcpToolTurn([
        assistantMsg([
          { type: 'tool_use', id: 'tu_1', name: 'mcp__term__exit', input: {} },
        ]),
        userMsg([
          { type: 'tool_result', tool_use_id: 'tu_other', content: 'x' },
        ]),
        userMsg('fresh prompt'),
      ]),
    ).toBe(false)
  })

  test('skips meta user messages while walking back', () => {
    process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS = 'mcp__term__exit'
    expect(
      isTerminalMcpToolTurn([
        assistantMsg([
          { type: 'tool_use', id: 'tu_1', name: 'mcp__term__exit', input: {} },
        ]),
        userMsg([
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'bye' },
        ]),
        userMsg('system reminder', { isMeta: true }),
      ]),
    ).toBe(true)
  })
})
