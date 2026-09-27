/**
 * OCC-99: thinking-only response nudge — helper predicates ported
 * byte-faithfully from the official 2.1.283 linux-x64 ELF
 * (md5 b5afa8208e39db13e13e89449b1825f2):
 *
 * - `I$t` nudge text @197449268
 * - `nVe`/`MFn` textless query-source set @204278422:
 *   `MFn=new Set(["prompt_suggestion","away_summary","agent_summary","narration"])`
 * - `kk` tool_result user-message check @207076120
 * - `r$e` terminal-MCP-tool env parse + `Ggo` walk-back @206152475
 * - `ie` StructuredOutput-turn walk-back @211160472
 *   (`bi="StructuredOutput"` @201499968)
 *
 * The nudge itself (condition + transition) lives in src/query.ts; upstream
 * changelog 2.1.183: "Fixed turns silently completing with no visible
 * output". See docs/upstream-version-gap-occ99-2026-09.md.
 */

import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from '../types/message.js'

/** Official `I$t` — byte-exact (@197449268). */
export const THINKING_ONLY_NUDGE_TEXT =
  '[Your previous response had no visible output. Please continue and produce a user-visible response.]'

/**
 * Official `MFn` (@204278422) — query sources that legitimately end with no
 * visible text; the nudge must not fire for them (`nVe(h)` guard).
 */
const TEXTLESS_QUERY_SOURCES = new Set([
  'prompt_suggestion',
  'away_summary',
  'agent_summary',
  'narration',
])

/** Official `nVe(e)` — `e!==void 0 && MFn.has(e)`. */
export function isTextlessQuerySource(
  querySource: string | undefined,
): boolean {
  return querySource !== undefined && TEXTLESS_QUERY_SOURCES.has(querySource)
}

/** Official `kk(e)` (@207076120): user message whose content is tool_result blocks. */
function isToolResultUserMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message?.content
  if (typeof content === 'string') return false
  if (!Array.isArray(content)) return false
  return content.some(block => (block as { type?: string }).type === 'tool_result')
}

/** Official `r$e()` (@206152475): CLAUDE_CODE_TERMINAL_MCP_TOOLS env → name set. */
function getTerminalMcpToolNames(): Set<string> {
  return new Set(
    (process.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  )
}

/**
 * Official `Ggo(e)` (@206152591) — true when the walk-back from the end of
 * history finds a SUCCESSFUL tool_result for a tool_use whose name is a
 * terminal MCP tool (those end the session by design; no visible text is
 * expected after them). Empty env set → false (official early return).
 */
export function isTerminalMcpToolTurn(messages: Message[]): boolean {
  const terminalNames = getTerminalMcpToolNames()
  if (terminalNames.size === 0) return false
  const succeededToolUseIds = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type === 'user') {
      if (message.isMeta) continue
      const content = message.message?.content
      if (!Array.isArray(content)) return false
      let sawToolResult = false
      for (const block of content as Array<{
        type?: string
        is_error?: boolean
        tool_use_id?: string
      }>) {
        if (block.type === 'tool_result') {
          sawToolResult = true
          if (!block.is_error && block.tool_use_id !== undefined) {
            succeededToolUseIds.add(block.tool_use_id)
          }
        }
      }
      if (!sawToolResult) return false
    } else if (message.type === 'assistant') {
      const content = message.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
        if (
          block.type === 'tool_use' &&
          block.id !== undefined &&
          succeededToolUseIds.has(block.id) &&
          block.name !== undefined &&
          terminalNames.has(block.name)
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Official `ie` (@211160472) — true when the current turn (walk-back from
 * the end, skipping meta and tool_result user messages, stopping at the
 * first real user message) already contains a `StructuredOutput` tool call.
 * Structured-output turns end without visible text BY DESIGN (the answer
 * rides in the tool input), so the nudge must not fire.
 */
export function isStructuredOutputTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type === 'user') {
      if (message.isMeta || isToolResultUserMessage(message)) continue
      return false
    }
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    if (
      content.some(
        block =>
          (block as { type?: string }).type === 'tool_use' &&
          (block as { name?: string }).name === SYNTHETIC_OUTPUT_TOOL_NAME,
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Official visible-text check inside the nudge condition
 * (`!L.some(W=>W.message.content.some(de=>de.type==="text"&&de.text.trim().length>0))`):
 * true when ANY assistant message of the current turn carries non-empty
 * visible text.
 */
export function hasVisibleText(assistantMessages: Message[]): boolean {
  return assistantMessages.some(message => {
    const content = message.message?.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        ((block as { text: string }).text).trim().length > 0,
    )
  })
}
