import { describe, expect, test } from 'bun:test'
import { OUTPUT_STYLE_CONFIG } from '../outputStyles.js'
import { normalizeAttachmentForAPI } from '../../utils/messages.js'
import type { Attachment } from '../../utils/attachments.js'

/**
 * 2.1.237 changelog #2: built-in "Concise" output style.
 *
 * Byte-exact evidence from the official 2.1.237 ELF: the style definition
 * (offset 312621400), the six-rule prompt body (offset 312618602, minified
 * Rkw) and the turnReminder (minified Lkw). Render template:
 * `${name} output style is active. ${turnReminder ?? "Remember to follow
 * the specific guidelines for this style."}`.
 */

const EXPECTED_DESCRIPTION =
  'Claude responds tersely, leading with results and skipping preamble and narration'

const EXPECTED_TURN_REMINDER =
  'Be concise: lead with the result, skip preamble and narration, keep only what the user needs.'

const EXPECTED_RULES = `The user chose brevity over narration. You should:

1. **Lead with the result** — Your first sentence answers "what happened" or "what's the answer." No preamble ("Let me...", "Now I'll...") and no closing recap of what you already said.
2. **Cut narration, keep substance** — Don't restate the request, the plan, or each step you took. Report outcomes, decisions, and anything the user must act on.
3. **Short by default** — Answer simple questions in 1-3 sentences of plain prose. Use headers, tables, and bullet lists only when they carry real structure, never as decoration.
4. **State things plainly** — Skip hedging boilerplate. Mention a caveat only when it changes what the user should do next.
5. **Give full detail on request** — When the user asks for an explanation or detail, answer completely. Conciseness never means withholding requested information.
6. **Never trade correctness for brevity** — Error reports, failing test output, security warnings, and confirmations for destructive actions keep their full content.

Where these rules conflict with more general communication or formatting guidance elsewhere in your instructions, these rules win.`

function textContent(message: { message: { content: unknown } }): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (block as { text?: string }).text ?? ''))
      .join('')
  }
  return ''
}

describe('2.1.237: built-in Concise output style', () => {
  const concise = OUTPUT_STYLE_CONFIG.Concise

  test('exists as a built-in style with the official description', () => {
    expect(concise).toBeDefined()
    expect(concise?.name).toBe('Concise')
    expect(concise?.source).toBe('built-in')
    expect(concise?.description).toBe(EXPECTED_DESCRIPTION)
    expect(concise?.keepCodingInstructions).toBe(true)
  })

  test('prompt matches the official template byte-for-byte', () => {
    expect(concise?.prompt).toBe(
      `You are an interactive CLI tool that helps users with software engineering tasks. Keep your responses short and direct while doing the work just as thoroughly.

# Concise Style Active
${EXPECTED_RULES}`,
    )
  })

  test('carries the official turnReminder', () => {
    expect(concise?.turnReminder).toBe(EXPECTED_TURN_REMINDER)
  })

  test('is listed between default and Explanatory (official order)', () => {
    const names = Object.keys(OUTPUT_STYLE_CONFIG)
    expect(names).toEqual(['default', 'Concise', 'Explanatory', 'Learning'])
  })
})

describe('2.1.237: output_style attachment render', () => {
  test('renders the turnReminder when the attachment carries one', () => {
    const attachment: Attachment = {
      type: 'output_style',
      style: 'Concise',
      turnReminder: EXPECTED_TURN_REMINDER,
    }
    const messages = normalizeAttachmentForAPI(attachment)
    expect(messages).toHaveLength(1)
    expect(textContent(messages[0]!)).toContain(
      `Concise output style is active. ${EXPECTED_TURN_REMINDER}`,
    )
  })

  test('falls back to the generic reminder when turnReminder is absent', () => {
    const attachment: Attachment = {
      type: 'output_style',
      style: 'Explanatory',
    }
    const messages = normalizeAttachmentForAPI(attachment)
    expect(messages).toHaveLength(1)
    expect(textContent(messages[0]!)).toContain(
      'Explanatory output style is active. Remember to follow the specific guidelines for this style.',
    )
  })

  test('renders nothing for an unknown style', () => {
    const attachment: Attachment = {
      type: 'output_style',
      style: 'NoSuchStyle',
    }
    expect(normalizeAttachmentForAPI(attachment)).toEqual([])
  })
})
