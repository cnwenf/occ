import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import {
  LOCAL_COMMAND_ERROR_MARKER,
  isLocalCommandError,
} from '../../../utils/localCommandOutput.js'
import { call as compactCall } from '../compact.js'

// 2.1.216 #35 (b): "a failed /compact displays as an error".
//
// Recon found that at the command-logic layer OCC already surfaces compact
// failures: compact.ts throws on every failure path (empty messages, API
// error, incomplete response, prompt-too-long) and processSlashCommand's
// `local` catch wraps the thrown error in a `<local-command-stderr>` tag.
// The genuine gap is the DISPLAY layer: UserLocalCommandOutputMessage rendered
// `<local-command-stderr>` IDENTICALLY to `<local-command-stdout>` (same
// IndentedContent, no error color, no marker) — so a failed /compact looked
// like a normal result line, not an error.
//
// Fix: a pure helper (isLocalCommandError) classifies stderr payloads as
// errors so the renderer can surface them with OCC's existing error marker
// (✘, the same glyph StatusIcon uses for status:'error'). The renderer wires
// the helper into the stderr branch.
//
// This file locks the fix at two layers:
//  (1) RENDER-LOGIC: isLocalCommandError flags a failed-compact (stderr)
//      payload as an error and yields the error marker; a succeeded-compact
//      (stdout) payload does not. [genuine RED→GREEN]
//  (2) COMMAND-LOGIC: compact `call` surfaces failures by throwing (error
//      surfaced), never by returning a success result. [characterization]

describe("2.1.216 #35 (b) — failed /compact displays as an error", () => {
  describe('render-logic layer (isLocalCommandError)', () => {
    test('failed compact (stderr) → classified as an error', () => {
      // Arrange — the exact tag processSlashCommand emits when compact throws.
      const content =
        '<local-command-stderr>Error during compaction: API Error</local-command-stderr>'

      // Act + Assert — the failure must be distinguishable from a normal
      // result so the renderer can surface it as an error.
      expect(isLocalCommandError(content)).toBe(true)
    })

    test('succeeded compact (stdout) → NOT classified as an error', () => {
      const content =
        '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'

      expect(isLocalCommandError(content)).toBe(false)
    })

    test('canceled compact (stderr) → classified as an error', () => {
      const content =
        '<local-command-stderr>Compaction canceled.</local-command-stderr>'

      expect(isLocalCommandError(content)).toBe(true)
    })

    test('empty / no-tag content → NOT classified as an error', () => {
      expect(isLocalCommandError('')).toBe(false)
      expect(isLocalCommandError('<local-command-stderr></local-command-stderr>')).toBe(false)
    })

    test('error marker is the ✘ glyph OCC uses for errors', () => {
      // Reuses the same glyph StatusIcon renders for status:'error'
      // (figures.cross), so a failed /compact displays with a consistent
      // error indicator across the UI.
      expect(LOCAL_COMMAND_ERROR_MARKER).toBe('✘')
    })
  })

  describe('command-logic layer (compact `call`)', () => {
    // Minimal context: compact `call` destructures abortController + messages
    // at the top, then throws on empty messages before touching any other
    // dependency — so a near-empty context is sufficient to exercise the
    // failure-surfacing path.
    function buildContext(messages: Message[]): ToolUseContext {
      return {
        messages,
        abortController: new AbortController(),
      } as unknown as ToolUseContext
    }

    test('empty conversation → throws (error surfaced, not a success result)', async () => {
      // Arrange
      const context = buildContext([])

      // Act + Assert — compact surfaces this failure by throwing, which
      // processSlashCommand translates into a <local-command-stderr> error.
      // It must NOT return a {type:'compact'} success result.
      await expect(compactCall('', context)).rejects.toThrow()
    })
  })
})
