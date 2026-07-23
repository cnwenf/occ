import { describe, expect, test } from 'bun:test'
import type { ContextData } from '../../../utils/analyzeContext.js'
import { generateContextSuggestions } from '../../../utils/contextSuggestions.js'
import {
  formatContextAsMarkdownTable,
  rescaleSkillTokensForModel,
} from '../context-noninteractive.js'

// 2.1.216 #35 (a): "/context now shows an explicit warning when the
// conversation exceeds the context window".
//
// Before: /context only had `checkNearCapacity` (>=80% → "Context is X% full"),
// which treats an over-window (percentage > 100) state identically to a
// merely-full one — no explicit "exceeds the context window" signal. The
// changelog adds an explicit warning for the over-window case.
//
// This file locks the gap fix at the command-logic layer:
//  - `generateContextSuggestions` (interactive /context renderer) emits an
//    "exceeds the context window" warning when totalTokens > rawMaxTokens.
//  - `formatContextAsMarkdownTable` (non-interactive /context) emits an
//    explicit over-window warning line.
// Under-window usage emits no such warning.

/** Minimal ContextData fixture. Only the fields the suggestion/table logic
 * read are populated; everything else is the empty/default shape. */
function buildData(overrides: Partial<ContextData> = {}): ContextData {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 0,
    gridRows: [],
    model: 'claude-sonnet-4-6',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...overrides,
  } as ContextData
}

describe("2.1.216 #35 (a) — /context over-window warning", () => {
  describe('generateContextSuggestions (interactive renderer)', () => {
    test('over-window (totalTokens > rawMaxTokens) → explicit exceeds-window warning present', () => {
      // Arrange — 210k tokens against a 200k window = 105%.
      const data = buildData({
        totalTokens: 210_000,
        rawMaxTokens: 200_000,
        percentage: 105,
      })

      // Act
      const suggestions = generateContextSuggestions(data)

      // Assert — an explicit "exceeds the context window" warning exists.
      const overWindow = suggestions.find(s =>
        /exceeds the context window/i.test(s.title),
      )
      expect(overWindow).toBeDefined()
      expect(overWindow?.severity).toBe('warning')
    })

    test('over-window warning recommends /compact', () => {
      const data = buildData({
        totalTokens: 250_000,
        rawMaxTokens: 200_000,
        percentage: 125,
      })
      const suggestions = generateContextSuggestions(data)
      const overWindow = suggestions.find(s =>
        /exceeds the context window/i.test(s.title),
      )
      expect(overWindow).toBeDefined()
      expect(overWindow?.detail).toMatch(/\/compact/i)
    })

    test('at-limit (totalTokens === rawMaxTokens) → no exceeds-window warning', () => {
      // Exactly full is not *over* the window.
      const data = buildData({
        totalTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 100,
      })
      const suggestions = generateContextSuggestions(data)
      const overWindow = suggestions.find(s =>
        /exceeds the context window/i.test(s.title),
      )
      expect(overWindow).toBeUndefined()
    })

    test('under-window (totalTokens < rawMaxTokens) → no exceeds-window warning', () => {
      const data = buildData({
        totalTokens: 80_000,
        rawMaxTokens: 200_000,
        percentage: 40,
      })
      const suggestions = generateContextSuggestions(data)
      const overWindow = suggestions.find(s =>
        /exceeds the context window/i.test(s.title),
      )
      expect(overWindow).toBeUndefined()
    })
  })

  describe('formatContextAsMarkdownTable (non-interactive /context)', () => {
    test('over-window → explicit warning line present', () => {
      const data = buildData({
        totalTokens: 210_000,
        rawMaxTokens: 200_000,
        percentage: 105,
      })
      const out = formatContextAsMarkdownTable(data)
      expect(out).toMatch(/exceeds the context window/i)
    })

    test('under-window → no exceeds-window warning line', () => {
      const data = buildData({
        totalTokens: 80_000,
        rawMaxTokens: 200_000,
        percentage: 40,
      })
      const out = formatContextAsMarkdownTable(data)
      expect(out).not.toMatch(/exceeds the context window/i)
    })
  })
})

// rescaleSkillTokensForModel is re-exported alongside the table formatter; keep
// the import alive so the test file's dependency surface matches production.
test('rescaleSkillTokensForModel is exported', () => {
  expect(typeof rescaleSkillTokensForModel).toBe('function')
})
