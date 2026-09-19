/**
 * CC 2.1.278 (ITEM B9) — per-block empty-text strip on the normalization path.
 *
 * Official 2.1.277 `u6o` (@202382391) + helpers `uve` (@202382339),
 * `yve` (@202380721), `BY` (@202379864), `snt="[Empty text removed]"`
 * (@202380694), `mve` (@202304611). Byte-verified against the v277 ELF.
 *
 * Changelog: conversations failed EVERY request with the API error "text
 * content blocks must be non-empty" when an earlier assistant turn held an
 * empty text block BESIDE other content (including after --resume).
 *
 * Covers (task spec):
 * - `[{text:""},{tool_use}]` → empty stripped, non-empty kept
 * - whitespace `" "` NOT stripped (only exact `text === ''` — official uve)
 * - resume/normalization path (normalizeMessagesForAPI) same behavior
 * - placeholder `[Empty text removed]` only between two thinking blocks
 * - all-empty-ish unique-id rows untouched (whitespace pass owns them)
 * - shared-id streaming rows: empty-only sibling dropped, user merge after drop
 * - keepTrailingEmptyTextBlock parameter (official `n`)
 */
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import {
  normalizeMessagesForAPI,
  stripEmptyTextBlocksBesideContent,
} from '../messages.js'

const EMPTY_TEXT_REMOVED = '[Empty text removed]'

function assistant(content: unknown[], id?: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      ...(id !== undefined && { id }),
      role: 'assistant',
      content: content as never,
    },
  }
}

function user(content: unknown): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: content as never },
  }
}

function toolUse(id: string): Record<string, unknown> {
  return { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }
}

function toolResult(id: string): Record<string, unknown> {
  return { type: 'tool_result', tool_use_id: id, content: 'ok' }
}

function thinking(text = 'pondering'): Record<string, unknown> {
  return { type: 'thinking', thinking: text, signature: 'sig' }
}

describe('B9: stripEmptyTextBlocksBesideContent (official u6o)', () => {
  test('strips text:"" beside a tool_use block, keeps the tool_use', () => {
    const row = assistant([{ type: 'text', text: '' }, toolUse('toolu_1')])
    const result = stripEmptyTextBlocksBesideContent([row])
    expect(result).toHaveLength(1)
    const content = result[0]!.message!.content as Array<{ type: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('tool_use')
  })

  test('does NOT strip whitespace-only text (" ") — only exact text === ""', () => {
    const row = assistant([{ type: 'text', text: ' ' }, toolUse('toolu_1')])
    const input = [row]
    const result = stripEmptyTextBlocksBesideContent(input)
    // Identity fast path: no block matches uve, the input array is returned.
    expect(result).toBe(input)
    const content = result[0]!.message!.content as Array<{ text?: string }>
    expect(content[0]!.text).toBe(' ')
  })

  test('mixed row: only exact-empty text removed, whitespace sibling kept', () => {
    const row = assistant([
      { type: 'text', text: '' },
      { type: 'text', text: ' ' },
      toolUse('toolu_1'),
    ])
    const result = stripEmptyTextBlocksBesideContent([row])
    const content = result[0]!.message!.content as Array<{
      type: string
      text?: string
    }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: ' ' })
    expect(content[1]!.type).toBe('tool_use')
  })

  test('empty text between two thinking blocks becomes the placeholder', () => {
    const row = assistant([
      thinking('first'),
      { type: 'text', text: '' },
      thinking('second'),
      toolUse('toolu_1'),
    ])
    const result = stripEmptyTextBlocksBesideContent([row])
    const content = result[0]!.message!.content as Array<{
      type: string
      text?: string
      citations?: unknown[]
    }>
    expect(content).toHaveLength(4)
    expect(content[1]).toEqual({
      type: 'text',
      text: EMPTY_TEXT_REMOVED,
      citations: [],
    })
  })

  test('empty text NOT between two thinking blocks is removed, no placeholder', () => {
    const row = assistant([
      thinking('first'),
      { type: 'text', text: '' },
      toolUse('toolu_1'),
    ])
    const result = stripEmptyTextBlocksBesideContent([row])
    const content = result[0]!.message!.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe('thinking')
    expect(content[1]!.type).toBe('tool_use')
    expect(content.some(c => c.text === EMPTY_TEXT_REMOVED)).toBe(false)
  })

  test('all-empty-ish content with a unique id is left untouched', () => {
    // Official yve gate: the whitespace-only pass (QDn) owns such rows.
    const row = assistant([{ type: 'text', text: '' }], 'unique_1')
    const result = stripEmptyTextBlocksBesideContent([row])
    expect(result).toHaveLength(1)
    expect(result[0]!.message!.content).toEqual([{ type: 'text', text: '' }])
  })

  test('shared-id streaming rows: the empty-only sibling is dropped', () => {
    // Official h-set: another row with the same message.id holds real
    // content, so the empty-only row loses the yve/unique-id exemption.
    const real = assistant([{ type: 'text', text: 'hello' }], 'shared_1')
    const empty = assistant([{ type: 'text', text: '' }], 'shared_1')
    const result = stripEmptyTextBlocksBesideContent([real, empty])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(real)
  })

  test('dropping a row between two user rows merges them (official mve)', () => {
    const real = assistant([{ type: 'text', text: 'hello' }], 'shared_2')
    const empty = assistant([{ type: 'text', text: '' }], 'shared_2')
    const input: Message[] = [
      real,
      user([{ type: 'text', text: 'q1' }]),
      empty,
      user([{ type: 'text', text: 'q2' }]),
    ]
    const result = stripEmptyTextBlocksBesideContent(input)
    // empty dropped → [real, user(q1), user(q2)] → adjacent users merged.
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(real)
    expect(result[1]!.type).toBe('user')
    const merged = JSON.stringify(result[1]!.message!.content)
    expect(merged).toContain('q1')
    expect(merged).toContain('q2')
  })

  test('identity fast path when no assistant row holds an empty text block', () => {
    const input: Message[] = [
      user([{ type: 'text', text: 'hi' }]),
      assistant([{ type: 'text', text: 'hello' }, toolUse('toolu_1')]),
    ]
    expect(stripEmptyTextBlocksBesideContent(input)).toBe(input)
  })

  test('keepTrailingEmptyTextBlock (official n) rescues the last row placeholder', () => {
    const makeRow = () =>
      assistant([
        thinking('first'),
        { type: 'text', text: '' },
        thinking('second'),
      ])
    const withoutKeep = stripEmptyTextBlocksBesideContent([makeRow()])
    const contentOff = withoutKeep[0]!.message!.content as Array<{
      type: string
    }>
    expect(contentOff).toHaveLength(2) // placeholder branch off → removed

    const withKeep = stripEmptyTextBlocksBesideContent([makeRow()], true)
    const contentOn = withKeep[0]!.message!.content as Array<{
      type: string
      text?: string
    }>
    expect(contentOn).toHaveLength(3)
    expect(contentOn[1]!.text).toBe(EMPTY_TEXT_REMOVED)
  })

  test('normalization path (live + resume): API payload never holds text:""', () => {
    // normalizeMessagesForAPI is the single chain both the live loop and the
    // resume path feed through — the official applies u6o on this chain
    // (`Pn=u6o(mn,...)` first, @202302374), so resume gets the same strip.
    const messages: Message[] = [
      user([{ type: 'text', text: 'hi' }]),
      assistant([{ type: 'text', text: '' }, toolUse('toolu_1')], 'api_1'),
      user([toolResult('toolu_1')]),
      assistant([{ type: 'text', text: ' ' }, toolUse('toolu_2')], 'api_2'),
      user([toolResult('toolu_2')]),
    ]
    const normalized = normalizeMessagesForAPI(messages)
    for (const row of normalized) {
      if (row.type !== 'assistant') continue
      const content = row.message!.content as Array<{
        type: string
        text?: string
      }>
      for (const block of content) {
        // B9 contract: no exactly-empty text block survives to the API.
        expect(block.type === 'text' && block.text === '').toBe(false)
      }
    }
    // Whitespace text is NOT the B9 target — it must survive the strip.
    const second = normalized.find(
      r => r.type === 'assistant' && r.message?.id === 'api_2',
    )
    const secondContent = second!.message!.content as Array<{
      type: string
      text?: string
    }>
    expect(secondContent.some(b => b.type === 'text' && b.text === ' ')).toBe(
      true,
    )
    // The tool_use beside the stripped empty text is kept.
    const first = normalized.find(
      r => r.type === 'assistant' && r.message?.id === 'api_1',
    )
    const firstContent = first!.message!.content as Array<{ type: string }>
    expect(firstContent.some(b => b.type === 'tool_use')).toBe(true)
  })
})
