import type { Message } from '../../types/message.js'

/**
 * CC 2.1.212 — fork session naming.
 *
 * Mirrors the official `deriveForkName` symbol in the 2.1.212 binary (and the
 * `deriveFirstPrompt` fallback it builds on). The 2.1.212 changelog (P2 #39):
 * "/fork [names] the copy after your prompt when the session has no title, so
 * the row is recognizable in the agent view." The fork's `custom-title`
 * entry (the `custom-title` field at binary offset 135647888, sibling of the
 * `Forked session` + ` (fork)` output) is set to this name.
 *
 * The directive (`/fork <directive>`) is the user's prompt for the fork, so it
 * is preferred. When absent, the first user message of the inherited
 * conversation is used. A stable fallback covers sessions with no extractable
 * prompt.
 */

/** Max length of a derived fork name (matches deriveFirstPrompt). */
const MAX_NAME = 100

/** Fallback when no directive and no extractable first prompt. */
export const FORK_NAME_FALLBACK = 'Forked session'

/**
 * Collapse whitespace and cap length so multiline / pasted directives don't
 * break the saved title or the resume hint. Returns the fallback when the
 * normalized result is empty.
 */
function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || FORK_NAME_FALLBACK
}

/**
 * Extract single-line text from a user message's content.
 *
 * `Message.message.content` is either a plain string or an array of content
 * blocks; we pick the first `text` block (matching `deriveFirstPrompt`).
 * Returns `undefined` when there is no extractable text.
 */
function extractUserText(
  msg: Message | undefined,
): string | undefined {
  const content = (msg as { message?: { content?: unknown } } | undefined)
    ?.message?.content
  if (!content) {
    return undefined
  }
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text',
    )
    return textBlock?.text
  }
  return undefined
}

/**
 * Derive the fork session's display name.
 *
 * Preference order:
 *  1. The `/fork` directive (the user's prompt for the fork).
 *  2. The first user message text of the inherited conversation.
 *  3. `FORK_NAME_FALLBACK`.
 *
 * @param directive The `/fork <directive>` argument string (may be empty).
 * @param messages  The parent conversation messages the fork inherits.
 */
export function deriveForkName(
  directive: string,
  messages: readonly Message[],
): string {
  const trimmed = directive.trim()
  if (trimmed) {
    return normalizeName(trimmed)
  }
  const firstUser = messages.find((m) => m.type === 'user')
  return normalizeName(extractUserText(firstUser) ?? '')
}
