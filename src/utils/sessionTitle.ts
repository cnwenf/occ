/**
 * Session title generation via Haiku.
 *
 * Standalone module with minimal dependencies so it can be imported from
 * print.ts (SDK control request handler) without pulling in the React/chalk/
 * git dependency chain that teleport.tsx carries.
 *
 * This is the single source of truth for AI-generated session titles across
 * all surfaces. Previously there were separate Haiku title generators:
 * - teleport.tsx generateTitleAndBranch (6-word title + branch for CCR)
 * - rename/generateSessionName.ts (kebab-case name for /rename)
 * Each remains for backwards compat; new callers should use this module.
 */

import { z } from 'zod/v4'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import { queryHaiku } from '../services/api/claude.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../services/api/errors.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { safeParseJSON } from './json.js'
import { lazySchema } from './lazySchema.js'
import { extractTextContent } from './messages.js'
import { isMeaningfulTitleText } from './sessionTitleInput.js'
import type { SessionTitleRequestResult } from './sessionTitleInput.js'
import { asSystemPrompt } from './systemPromptType.js'
import { getInitialSettings } from './settings/settings.js'

const MAX_CONVERSATION_TEXT = 1000

/**
 * Official `wfn=2000` @255029272 — the session-title input cap. The cap is
 * only applied behind `w()` = the `tengu_lucky_brooks` Statsig gate (default
 * off, catch→false), so with the flag off the official never truncates the
 * input; `wfn` survives only as the `input_over_cap` analytics threshold.
 * OCC has no Statsig — flag-off semantics are ported exactly (no capping,
 * `input_capped: false`, `input_over_cap: length > 2000`).
 */
const SESSION_TITLE_INPUT_CAP = 2000

/**
 * Flatten a message array into a single text string for Haiku title input.
 * Skips meta/non-human messages. Tail-slices to the last 1000 chars so
 * recent context wins when the conversation is long.
 */
export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if ('isMeta' in msg && msg.isMeta) continue
    if ('origin' in msg && (msg as any).origin && (msg as any).origin.kind !== 'human') continue
    const content = msg.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ('type' in block && block.type === 'text' && 'text' in block) {
          parts.push(block.text as string)
        }
      }
    }
  }
  const text = parts.join('\n')
  return text.length > MAX_CONVERSATION_TEXT
    ? text.slice(-MAX_CONVERSATION_TEXT)
    : text
}

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

const titleSchema = lazySchema(() => z.object({ title: z.string() }))

/**
 * Official `B3(e)` @246467524 (byte-verified):
 * `if(!e.isApiErrorMessage)return!1; let t=e.message.content;
 *  if(!Array.isArray(t))return!1;
 *  return t.some((r)=>r.type==="text"&&r.text.startsWith(YN))`
 * with `YN="Prompt is too long"`. (Same shape as OCC's existing
 * `isPromptTooLongMessage` in services/api/errors.ts — kept local here so
 * this module's import surface stays minimal, per its header contract.)
 */
export function isPromptTooLongApiError(result: AssistantMessage): boolean {
  if (!result.isApiErrorMessage) return false
  const content = result.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block: { type?: string; text?: string }) =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * Official `nin(text,signal,credentials)` @261924458 + inner `C(...)`
 * (byte-verified) — CC 2.1.314 item 61. Returns a three-way result instead
 * of title-or-null so the REPL can distinguish:
 *  - `titled`   → apply the title, drop the fallback (official pzn case 1);
 *  - `unusable` → input/output unusable (too short, unparseable, or the
 *    "Prompt is too long" API error — official `B3` exemption: C() does NOT
 *    throw for it, the json_schema parse fails → null → unusable); burns one
 *    fallback reply (pzn case 3);
 *  - `failed`   → API/network error (C() throws
 *    `"Session title request failed with an API error"` when
 *    `isApiErrorMessage && !B3`); the fallback is PRESERVED and the REPL
 *    resets `_haikuTitleAttempted` so the next turn retries with the
 *    ORIGINAL prompt — the item 61 fix.
 *
 * Official `C()` sends `language`-aware instructions and wraps the input in
 * `<session>…</session>`; OCC keeps its pre-existing SESSION_TITLE_PROMPT
 * language-suffix wiring (documented pre-existing divergence). The
 * `wfn`/`b1r` input cap is skipped (flag off — see SESSION_TITLE_INPUT_CAP).
 */
export async function requestSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<SessionTitleRequestResult> {
  const trimmed = description.trim()
  if (!isMeaningfulTitleText(trimmed)) return { kind: 'unusable' }
  const inputOverCap = trimmed.length > SESSION_TITLE_INPUT_CAP

  try {
    const language = getInitialSettings()?.language
    const prompt = language
      ? `${SESSION_TITLE_PROMPT}\n\nGenerate the session title in ${language}.`
      : SESSION_TITLE_PROMPT
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([prompt]),
      userPrompt: trimmed,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'generate_session_title',
        agents: [],
        // Reflect the actual session mode — this module is called from
        // both the SDK print path (non-interactive) and the CCR remote
        // session path via useRemoteSession (interactive).
        isNonInteractiveSession: getIsNonInteractiveSession(),
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // Official C(): `if(d.isApiErrorMessage&&!B3(d))throw Error("Session
    // title request failed with an API error")`.
    if (result.isApiErrorMessage && !isPromptTooLongApiError(result)) {
      throw new Error('Session title request failed with an API error')
    }

    const text = extractTextContent(result.message.content as never)
    const parsed = titleSchema().safeParse(safeParseJSON(text))
    const title = parsed.success ? parsed.data.title.trim() || null : null

    logEvent('tengu_session_title_generated', {
      success: title !== null,
      input_capped: false,
      input_over_cap: inputOverCap,
    })

    return title === null ? { kind: 'unusable' } : { kind: 'titled', title }
  } catch (error) {
    logForDebugging(`requestSessionTitle failed: ${error}`, {
      level: 'error',
    })
    logEvent('tengu_session_title_generated', {
      success: false,
      input_capped: false,
      input_over_cap: inputOverCap,
    })
    return { kind: 'failed' }
  }
}

/**
 * Official `Uht(e,c,r)` @261925003 (byte-verified):
 * `let n=await nin(e,c,r); return n.kind==="titled"?n.title:null`.
 *
 * Generate a sentence-case session title from a description or first message.
 * Returns null on error or if Haiku returns an unparseable response. Kept as
 * the string-or-null facade for the existing callers (print.ts,
 * initReplBridge.ts, useRemoteSession.ts); the REPL uses requestSessionTitle
 * directly for the item 61 fallback state machine.
 *
 * @param description - The user's first message or a description of the session
 * @param signal - Abort signal for cancellation
 */
export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await requestSessionTitle(description, signal)
  return result.kind === 'titled' ? result.title : null
}
