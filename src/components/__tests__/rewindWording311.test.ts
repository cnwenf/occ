/**
 * CC 2.1.311 items 46 + 47 (OCC-135 WP-O) — `/rewind` wording swaps in
 * `src/components/MessageSelector.tsx`.
 *
 * Official evidence (byte-verified against /tmp/cc-diff-311/v311/package/claude):
 * - Item 46 (`zje` rewind switch) @274784505:
 *     case"both":case"conversation":return"This message and everything after it will be removed."
 *   v310 carried `The conversation will be forked.` (2 hits); v311 has 0.
 * - Item 47 (`vls` warning const) @238723235:
 *     "Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone."
 *   v310 carried `Rewinding does not affect files edited manually or via bash.`
 *
 * Both strings must ship byte-identical to the v311 literals.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getRestoreOptionConversationText } from '../MessageSelector.js'

const ITEM46 = 'This message and everything after it will be removed.'
const ITEM47 =
  'Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone.'
const OLD46 = 'The conversation will be forked.'
const OLD47 = 'Rewinding does not affect files edited manually or via bash.'

const source = readFileSync(
  join(import.meta.dir, '..', 'MessageSelector.tsx'),
  'utf8',
)

describe('Item 46 — getRestoreOptionConversationText both/conversation', () => {
  test("returns the verbatim v311 string for 'both'", () => {
    expect(getRestoreOptionConversationText('both')).toBe(ITEM46)
  })

  test("returns the verbatim v311 string for 'conversation'", () => {
    expect(getRestoreOptionConversationText('conversation')).toBe(ITEM46)
  })

  test('the other switch cases are unchanged from official v311', () => {
    expect(getRestoreOptionConversationText('summarize')).toBe(
      'Messages after this point will be summarized.',
    )
    expect(getRestoreOptionConversationText('summarize_up_to')).toBe(
      'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.',
    )
    expect(getRestoreOptionConversationText('code')).toBe(
      'The conversation will be unchanged.',
    )
    expect(getRestoreOptionConversationText('nevermind')).toBe(
      'The conversation will be unchanged.',
    )
  })

  test('the old "will be forked" wording is gone from the source', () => {
    expect(source).not.toContain(OLD46)
  })
})

describe('Item 47 — rewind warning about manual/Bash edits', () => {
  test('the verbatim v311 warning is present in the source', () => {
    expect(source).toContain(ITEM47)
  })

  test('the old warning wording is gone from the source', () => {
    expect(source).not.toContain(OLD47)
  })

  test('the warning keeps its figures.warning icon + dimColor styling', () => {
    // The icon prefix and the dimColor wrapper must survive the string swap.
    expect(source).toContain('{figures.warning}')
    expect(source).toMatch(/<Text dimColor>\s*{\/\*[^}]*\*\/}\s*{figures\.warning}/s)
  })

  test('the warning string is emitted as a single JS literal (no JSX line-break artifacts)', () => {
    // Item 47 is rendered as `{'<literal>'}` so the output is byte-exact and
    // cannot pick up collapsed-whitespace/newline artifacts from JSX text.
    expect(source).toContain(`{'${ITEM47}'}`)
  })
})
