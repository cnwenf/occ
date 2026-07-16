/**
 * TDD tests for CC 2.1.211: "Fixed permission previews relayed to chat
 * channels not neutralizing bidirectional-override, zero-width, and
 * look-alike quote characters, so tool inputs cannot visually alter the
 * approval message."
 *
 * Tests call the REAL neutralizer AND the REAL buildRequiresActionDetails
 * renderer — the tool is a fake leaf collaborator that returns spoofing chars
 * from its getToolUseSummary/input. The neutralizer itself is never mocked.
 */

import { describe, expect, test } from 'bun:test'
import type { Tool } from 'src/Tool.js'
import { buildRequiresActionDetails } from 'src/cli/structuredIO.js'
import {
  neutralizePreviewInput,
  neutralizePreviewText,
} from 'src/utils/permissions/previewNeutralizer.js'

// ---------------------------------------------------------------------------
// Helpers — build a minimal fake Tool that returns a given summary.
// This is a LEAF collaborator (like a filesystem fixture), not the system
// under test. The neutralizer and buildRequiresActionDetails are real.
// ---------------------------------------------------------------------------

function makeFakeTool(opts: {
  name: string
  summary: string
}): Pick<Tool, 'name' | 'getToolUseSummary' | 'userFacingName'> {
  return {
    name: opts.name,
    getToolUseSummary: () => opts.summary,
    userFacingName: () => opts.name,
  }
}

// ---------------------------------------------------------------------------
// Unit tests for the neutralizer function itself
// ---------------------------------------------------------------------------

describe('neutralizePreviewText', () => {
  test('neutralizes RLO (U+202E) that would reverse the display order', () => {
    // Arrange: RLO before "rm -rf /" would display the command backwards
    const malicious = '‮rm -rf /'

    // Act
    const result = neutralizePreviewText(malicious)

    // Assert: RLO replaced with U+FFFD, text no longer reversed
    expect(result).not.toContain('‮')
    expect(result).toContain('rm -rf /')
    expect(result).toContain('�')
  })

  test('neutralizes zero-width space (U+200B) that is invisible', () => {
    // Arrange: ZWSP between "rm" and " -rf" is invisible but present
    const malicious = 'rm​ -rf​ /'

    // Act
    const result = neutralizePreviewText(malicious)

    // Assert: ZWSP removed
    expect(result).not.toContain('​')
    expect(result).toBe('rm -rf /')
  })

  test('neutralizes look-alike double quotes (U+201C/U+201D)', () => {
    // Arrange: smart quotes look like ASCII quotes but are different code points
    const malicious = '“safe” command'

    // Act
    const result = neutralizePreviewText(malicious)

    // Assert: smart quotes replaced with ASCII double quotes
    expect(result).not.toContain('“')
    expect(result).not.toContain('”')
    expect(result).toContain('"')
    expect(result).toBe('"safe" command')
  })

  test('neutralizes look-alike single quotes (U+2018/U+2019)', () => {
    // Arrange: smart single quotes look like apostrophes
    const malicious = '‘safe’'

    // Act
    const result = neutralizePreviewText(malicious)

    // Assert: replaced with ASCII single quotes
    expect(result).not.toContain('‘')
    expect(result).not.toContain('’')
    expect(result).toBe("'safe'")
  })

  test('neutralizes all bidi controls (U+061C, U+202A-202E, U+2066-2069)', () => {
    // Arrange: all bidi control characters
    const bidiChars = [
      '؜', // Arabic Letter Mark
      '‪', // LRE
      '‫', // RLE
      '‬', // PDF
      '‭', // LRO
      '‮', // RLO
      '⁦', // LRI
      '⁧', // RLI
      '⁨', // FSI
      '⁩', // PDI
    ]

    for (const char of bidiChars) {
      const input = `${char}safe command`
      const result = neutralizePreviewText(input)
      expect(result).not.toContain(char)
      expect(result).toContain('safe command')
    }
  })

  test('neutralizes all zero-width chars (U+200B-200F, U+2060, U+FEFF, U+00AD)', () => {
    const zwChars = [
      '​', // ZWSP
      '‌', // ZWNJ
      '‍', // ZWJ
      '‎', // LRM
      '‏', // RLM
      '⁠', // Word Joiner
      '﻿', // BOM / ZWNBSP
      '­', // Soft Hyphen
    ]

    for (const char of zwChars) {
      const input = `safe${char} command`
      const result = neutralizePreviewText(input)
      expect(result).not.toContain(char)
      expect(result).toContain('safe')
      expect(result).toContain('command')
    }
  })

  test('passes through plain ASCII text unchanged', () => {
    const input = 'Editing src/foo.ts'
    expect(neutralizePreviewText(input)).toBe(input)
  })

  test('handles empty and null gracefully', () => {
    expect(neutralizePreviewText('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — REAL buildRequiresActionDetails renderer
// ---------------------------------------------------------------------------

describe('buildRequiresActionDetails neutralization (integration)', () => {
  test('action_description is neutralized when tool returns bidi+zero-width+look-alike', () => {
    // Arrange: a tool input containing RLO + ZWSP + look-alike quotes
    // RLO (U+202E) + ZWSP (U+200B) + smart double quotes (U+201C/U+201D)
    const spoofingSummary = '‮rm ​-rf​ “safe”'
    const fakeTool = makeFakeTool({
      name: 'Bash',
      summary: spoofingSummary,
    })
    const input = { command: spoofingSummary }

    // Act: call the REAL buildRequiresActionDetails renderer
    const details = buildRequiresActionDetails(
      fakeTool as unknown as Tool,
      input,
      'tool-use-id-123',
      'request-id-456',
    )

    // Assert: the relayed preview has dangerous chars neutralized
    expect(details.action_description).not.toContain('‮')
    expect(details.action_description).not.toContain('​')
    expect(details.action_description).not.toContain('“')
    expect(details.action_description).not.toContain('”')
    // ASCII double quote is present (replacement for look-alike)
    expect(details.action_description).toContain('"')
    // Bidi control replaced with U+FFFD
    expect(details.action_description).toContain('�')
    // The text "rm" and "safe" are still present (not lost)
    expect(details.action_description).toContain('rm')
    expect(details.action_description).toContain('safe')
  })

  test('input object string values are also neutralized', () => {
    // Arrange
    const maliciousInput = {
      command: '‮rm -rf /',
      path: 'safe​path',
      normal: 42,
    }
    const fakeTool = makeFakeTool({
      name: 'Bash',
      summary: 'Running command',
    })

    // Act
    const details = buildRequiresActionDetails(
      fakeTool as unknown as Tool,
      maliciousInput,
      'tu-id',
      'req-id',
    )

    // Assert
    expect(details.input?.command).not.toContain('‮')
    expect(details.input?.command).toContain('rm -rf /')
    expect(details.input?.path).not.toContain('​')
    expect(details.input?.path).toBe('safepath')
    expect(details.input?.normal).toBe(42)
  })

  test('plain ASCII preview passes through unchanged', () => {
    const fakeTool = makeFakeTool({
      name: 'Edit',
      summary: 'Editing src/foo.ts',
    })
    const input = { file: 'src/foo.ts' }

    const details = buildRequiresActionDetails(
      fakeTool as unknown as Tool,
      input,
      'id',
      'req',
    )

    expect(details.action_description).toBe('Editing src/foo.ts')
    expect(details.input?.file).toBe('src/foo.ts')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for neutralizePreviewInput
// ---------------------------------------------------------------------------

describe('neutralizePreviewInput', () => {
  test('neutralizes nested string values in arrays and objects', () => {
    const input = {
      cmd: '‮spoof',
      args: ['​invisible', 'normal', { nested: '“quote”' }],
    }

    const result = neutralizePreviewInput(input)

    expect(result.cmd).not.toContain('‮')
    expect(result.cmd).toContain('�')
    expect(result.args[0]).not.toContain('​')
    expect(result.args[1]).toBe('normal')
    expect((result.args[2] as Record<string, unknown>).nested).toBe(
      '"quote"',
    )
  })

  test('does not mutate the original input object', () => {
    const input = { cmd: '‮spoof' }
    const original = { ...input }

    neutralizePreviewInput(input)

    // Original value still contains the dangerous char
    expect(input.cmd).toBe(original.cmd)
  })
})

// ---------------------------------------------------------------------------
// CC 2.1.211 hardening: depth>10 fail-secure
// ---------------------------------------------------------------------------

describe('neutralizePreviewInput — depth > 10 fail-secure', () => {
  test('deeply-nested string leaf is still neutralized at depth > 10', () => {
    // Arrange: build a nested object deeper than MAX_NEUTRALIZE_DEPTH (10).
    // At the deepest level, a string with a bidi control char (RLO U+202E).
    let deep: Record<string, unknown> = { val: '‮spoof' }
    for (let i = 0; i < 12; i++) {
      deep = { nested: deep }
    }

    // Act
    const result = neutralizePreviewInput(deep)

    // Assert: the dangerous RLO char must NOT appear anywhere in the output.
    // At depth 11+, the object containing the string becomes U+FFFD (not the
    // raw object), so the dangerous char never leaks through.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('‮')
  })

  test('deeply-nested non-string leaf returns U+FFFD (not raw passthrough)', () => {
    // Arrange: a deeply-nested object (past depth 10) containing a
    // dangerous string. The object itself must NOT pass through — it
    // should be replaced with U+FFFD to prevent un-neutralized content.
    let deep: Record<string, unknown> = { danger: '‮rm -rf /' }
    for (let i = 0; i < 15; i++) {
      deep = { nested: deep }
    }

    // Act
    const result = neutralizePreviewInput(deep)

    // Assert: walk down until we hit a non-object (the fail-secure U+FFFD).
    let node: unknown = result
    while (node !== null && typeof node === 'object') {
      node = (node as Record<string, unknown>).nested
    }
    expect(node).toBe('�')
    expect(typeof node).toBe('string')
    // The raw object must NOT have passed through
    expect(node).not.toHaveProperty('danger')
    // The dangerous bidi char must not appear anywhere
    expect(JSON.stringify(result)).not.toContain('‮')
  })

  test('string at depth > 10 is still neutralized (fail-secure)', () => {
    // Arrange: an array nested 12 levels deep, with a string leaf
    // containing a zero-width char. The string should still be neutralized
    // even beyond the depth limit.
    let deep: unknown = 'safe​command'
    for (let i = 0; i < 12; i++) {
      deep = [deep]
    }

    // Act
    const result = neutralizePreviewInput({ arr: deep })

    // Assert: walk down until we hit a non-object (the fail-secure U+FFFD).
    let leaf: unknown = (result as Record<string, unknown>).arr
    while (leaf !== null && typeof leaf === 'object') {
      leaf = (leaf as unknown[])[0]
    }
    expect(leaf).toBe('�')
    // The zero-width char must not appear anywhere
    expect(JSON.stringify(result)).not.toContain('​')
  })
})
