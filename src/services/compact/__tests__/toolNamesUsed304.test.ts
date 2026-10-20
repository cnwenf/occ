import { describe, expect, test } from 'bun:test'
import { getCompactUserSummaryMessage } from '../prompt.js'
import { COMPACT_SUMMARY_HEADER } from '../summaryHeader.js'
import {
  getToolNamesUsed,
  renderToolsUsedBeforeSummary,
  stripToolsUsedTagForTranscript,
  TOOLS_USED_BEFORE_SUMMARY_TAG,
  TOOLS_USED_TAG_RE,
  VALID_TOOL_NAME_RE,
} from '../toolNamesUsed.js'

/**
 * CC 2.1.304 changelog #6 — "compaction summary now includes the names of
 * tools used before the summary". Byte-verified ports of the official symbols
 * (offsets in docs/gap-research-304/research-R3-session-api.md §#6):
 *   HJ  = getToolNamesUsed       Zan = renderToolsUsedBeforeSummary
 *   jEs = stripToolsUsedTagForTranscript   Mir = VALID_TOOL_NAME_RE
 *   Xan = TOOLS_USED_TAG_RE      dve = TOOLS_USED_BEFORE_SUMMARY_TAG
 *   GJ  = getCompactUserSummaryMessage (composer, prompt.ts)
 */

// ── fixtures ────────────────────────────────────────────────────────────────
const toolUse = (name: string) => ({ type: 'tool_use', name, id: 'tu', input: {} })
const serverToolUse = (name: string) => ({
  type: 'server_tool_use',
  name,
  id: 'stu',
  input: {},
})
const assistant = (content: unknown) => ({
  type: 'assistant' as const,
  message: { role: 'assistant' as const, content },
})
const user = (content: unknown, isCompactSummary = false) => ({
  type: 'user' as const,
  message: { role: 'user' as const, content },
  ...(isCompactSummary ? { isCompactSummary: true as const } : {}),
})
const tag = (names: string) =>
  `<${TOOLS_USED_BEFORE_SUMMARY_TAG}>${names}</${TOOLS_USED_BEFORE_SUMMARY_TAG}>`

// ── Zan: renderToolsUsedBeforeSummary ───────────────────────────────────────
describe('2.1.304 #6 — renderToolsUsedBeforeSummary (official Zan)', () => {
  test('renders the tag with comma-space-joined names', () => {
    // Arrange
    const names = ['Bash', 'Read']

    // Act
    const out = renderToolsUsedBeforeSummary(names)

    // Assert
    expect(out).toBe('<tools-used-before-summary>Bash, Read</tools-used-before-summary>\n')
  })

  test('renders an EMPTY tag by default (official Zan default `[]`)', () => {
    expect(renderToolsUsedBeforeSummary()).toBe(
      '<tools-used-before-summary></tools-used-before-summary>\n',
    )
  })

  test('renders an empty tag for an empty array', () => {
    expect(renderToolsUsedBeforeSummary([])).toBe(
      '<tools-used-before-summary></tools-used-before-summary>\n',
    )
  })

  test('tag name is the verbatim official `dve`', () => {
    expect(TOOLS_USED_BEFORE_SUMMARY_TAG).toBe('tools-used-before-summary')
  })
})

// ── Mir: VALID_TOOL_NAME_RE ─────────────────────────────────────────────────
describe('2.1.304 #6 — VALID_TOOL_NAME_RE (official Mir)', () => {
  test('accepts ordinary + namespaced + single-space names', () => {
    expect(VALID_TOOL_NAME_RE.test('Bash')).toBe(true)
    expect(VALID_TOOL_NAME_RE.test('mcp__server__tool')).toBe(true)
    expect(VALID_TOOL_NAME_RE.test('Web Search')).toBe(true)
  })

  test('rejects comma, angle brackets, empty, and double-whitespace', () => {
    expect(VALID_TOOL_NAME_RE.test('bad,name')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('a<b')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('a>b')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('two  spaces')).toBe(false)
  })

  test('rejects control chars and line/paragraph separators', () => {
    expect(VALID_TOOL_NAME_RE.test('tab\tname')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('line\u2028sep')).toBe(false)
    expect(VALID_TOOL_NAME_RE.test('para\u2029sep')).toBe(false)
  })

  test('enforces the 1–256 length bound', () => {
    expect(VALID_TOOL_NAME_RE.test('a'.repeat(256))).toBe(true)
    expect(VALID_TOOL_NAME_RE.test('a'.repeat(257))).toBe(false)
  })
})

// ── HJ: getToolNamesUsed ────────────────────────────────────────────────────
describe('2.1.304 #6 — getToolNamesUsed (official HJ)', () => {
  test('extracts, dedupes, and sorts tool_use names', () => {
    // Arrange
    const messages = [
      assistant([toolUse('Read'), toolUse('Bash'), toolUse('Read')]),
    ]

    // Act
    const names = getToolNamesUsed(messages)

    // Assert — Set dedupe + lexicographic sort
    expect(names).toEqual(['Bash', 'Read'])
  })

  test('includes server_tool_use blocks', () => {
    const names = getToolNamesUsed([assistant([serverToolUse('mcp__x__y')])])
    expect(names).toEqual(['mcp__x__y'])
  })

  test('trims surrounding whitespace on names', () => {
    const names = getToolNamesUsed([assistant([toolUse('  Read  ')])])
    expect(names).toEqual(['Read'])
  })

  test('filters invalid names but keeps valid siblings', () => {
    const names = getToolNamesUsed([
      assistant([toolUse('bad,name'), toolUse('ok'), toolUse('a<b')]),
    ])
    expect(names).toEqual(['ok'])
  })

  test('skips non-user/non-assistant messages', () => {
    const names = getToolNamesUsed([
      { type: 'system', message: { content: [toolUse('Bash')] } },
      { type: 'progress', message: { content: [toolUse('Read')] } },
    ])
    expect(names).toEqual([])
  })

  test('plain string content contributes no tool names', () => {
    expect(getToolNamesUsed([assistant('just text'), user('a question')])).toEqual([])
  })

  test('carries forward names from a prior compact-summary tag', () => {
    // Arrange — a prior summary user message whose text starts with the tag
    const priorText = `${COMPACT_SUMMARY_HEADER}\n\n${tag('OldTool, AnotherOld')}\nSummary:\nold`
    const prior = user(priorText, true)

    // Act
    const names = getToolNamesUsed([prior])

    // Assert — split on comma, trimmed, sorted
    expect(names).toEqual(['AnotherOld', 'OldTool'])
  })

  test('does NOT read the tag from a non-compact-summary user message', () => {
    const priorText = `${COMPACT_SUMMARY_HEADER}\n\n${tag('OldTool')}\nSummary:\nold`
    const names = getToolNamesUsed([user(priorText, false)])
    expect(names).toEqual([])
  })
})

// ── jEs: stripToolsUsedTagForTranscript ─────────────────────────────────────
describe('2.1.304 #6 — stripToolsUsedTagForTranscript (official jEs)', () => {
  test('rewrites the tag into a readable transcript line', () => {
    // Arrange
    const text = `${COMPACT_SUMMARY_HEADER}\n\n${tag('Bash, Read')}\nSummary:\nfoo`

    // Act
    const out = stripToolsUsedTagForTranscript(text)

    // Assert — readable line, no raw XML left
    expect(out).toBe(
      `${COMPACT_SUMMARY_HEADER}\n\nTools called before this summary: Bash, Read\nSummary:\nfoo`,
    )
    expect(out).not.toContain('<tools-used-before-summary>')
  })

  test('hides an empty tag (collapses to the header prefix)', () => {
    const text = `${COMPACT_SUMMARY_HEADER}\n\n${tag('')}\nSummary:\nfoo`
    const out = stripToolsUsedTagForTranscript(text)
    expect(out).toBe(`${COMPACT_SUMMARY_HEADER}\n\nSummary:\nfoo`)
    expect(out).not.toContain('Tools called before this summary')
  })

  test('leaves text without the tag unchanged', () => {
    const text = `${COMPACT_SUMMARY_HEADER}\n\nSummary:\nfoo`
    expect(stripToolsUsedTagForTranscript(text)).toBe(text)
  })
})

// ── TOOLS_USED_TAG_RE (Xan) contract ────────────────────────────────────────
describe('2.1.304 #6 — TOOLS_USED_TAG_RE (official Xan, adapted)', () => {
  test('group1 = header prefix, group2 = comma-joined names', () => {
    const text = `${COMPACT_SUMMARY_HEADER}\n\n${tag('Bash, Read')}\nrest`
    const m = text.match(TOOLS_USED_TAG_RE)
    expect(m?.[1]).toBe(`${COMPACT_SUMMARY_HEADER}\n\n`)
    expect(m?.[2]).toBe('Bash, Read')
  })
})

// ── GJ: getCompactUserSummaryMessage placement ──────────────────────────────
describe('2.1.304 #6 — getCompactUserSummaryMessage tag placement (official GJ)', () => {
  test('injects the tag between the header and the summary', () => {
    // Act
    const out = getCompactUserSummaryMessage(
      'summary text',
      false,
      undefined,
      ['Bash', 'Read'],
    )

    // Assert — header, blank line, tag, then the (analysis-stripped) summary
    expect(out).toBe(
      `${COMPACT_SUMMARY_HEADER}\n\n<tools-used-before-summary>Bash, Read</tools-used-before-summary>\nsummary text`,
    )
  })

  test('emits an empty tag when no tool names are supplied', () => {
    const out = getCompactUserSummaryMessage('summary text')
    expect(out).toBe(
      `${COMPACT_SUMMARY_HEADER}\n\n<tools-used-before-summary></tools-used-before-summary>\nsummary text`,
    )
  })

  test('round-trips: the composer output is read back by the extractor', () => {
    // Arrange — a prior summary composed with one tool, plus a fresh tool call
    const priorContent = getCompactUserSummaryMessage('old summary', false, undefined, [
      'OldTool',
    ])
    const prior = user(priorContent, true)
    const fresh = assistant([toolUse('Bash')])

    // Act
    const names = getToolNamesUsed([prior, fresh])

    // Assert — carried name + new name, sorted
    expect(names).toEqual(['Bash', 'OldTool'])

    // And re-composing embeds both
    const next = getCompactUserSummaryMessage('new summary', false, undefined, names)
    expect(next).toContain('<tools-used-before-summary>Bash, OldTool</tools-used-before-summary>')
  })

  test('the transcript rewrite of a composed summary is readable', () => {
    const composed = getCompactUserSummaryMessage('summary text', false, undefined, [
      'Bash',
      'Read',
    ])
    const shown = stripToolsUsedTagForTranscript(composed)
    expect(shown).toContain('Tools called before this summary: Bash, Read')
    expect(shown).not.toContain('<tools-used-before-summary>')
  })
})
