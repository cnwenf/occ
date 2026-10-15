import { describe, expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import { shouldKeepScrollPositionOnSubmit } from '../../types/command.js'
import {
  PROMPT_SUPPRESSION_MS,
  shouldReleaseSuppressedDialogs,
} from '../promptSuppression.js'

// ---------------------------------------------------------------------------
// #091 — ask withdrawal lifecycle: prompt-suppression release gate
// ---------------------------------------------------------------------------

describe('shouldReleaseSuppressedDialogs (#091 release gate)', () => {
  test('stays suppressed when unsent draft text is present at release time', () => {
    expect(shouldReleaseSuppressedDialogs('please run npm install')).toBe(false)
  })

  test('releases for whitespace-only input (trims to empty, matching the activation predicate)', () => {
    // Whitespace-only input is not a sendable draft; the gate matches the
    // activation predicate (`value.trim().length > 0`) so the two never
    // disagree and suppression cannot get stuck on invisible text.
    expect(shouldReleaseSuppressedDialogs('   \n\t ')).toBe(true)
  })

  test('releases when input was sent/cleared (empty string)', () => {
    expect(shouldReleaseSuppressedDialogs('')).toBe(true)
  })

  test('suppression debounce window matches the official 1500ms constant', () => {
    expect(PROMPT_SUPPRESSION_MS).toBe(1500)
  })
})

// ---------------------------------------------------------------------------
// #033 — keepsScrollPosition: /btw must not repin a scrolled-up transcript
// ---------------------------------------------------------------------------

const btwCommand = {
  type: 'local-jsx',
  name: 'btw',
  description: 'Ask a quick side question',
  immediate: true,
  keepsScrollPosition: true,
  load: async () => ({ call: async () => null as never }),
} satisfies Command

const clearCommand = {
  type: 'local-jsx',
  name: 'clear',
  description: 'Clear conversation',
  load: async () => ({ call: async () => null as never }),
} satisfies Command

const promptCommand = {
  type: 'prompt',
  name: 'review',
  description: 'Review',
  progressMessage: 'Reviewing…',
  contentLength: 0,
  source: 'builtin',
  getPromptForCommand: async () => [],
} satisfies Command

const commands: Command[] = [btwCommand, clearCommand, promptCommand]

describe('shouldKeepScrollPositionOnSubmit (#033)', () => {
  test('keeps scroll position for /btw with a question', () => {
    expect(shouldKeepScrollPositionOnSubmit('/btw what does this do?', false, commands)).toBe(true)
  })

  test('keeps scroll position for bare /btw', () => {
    expect(shouldKeepScrollPositionOnSubmit('/btw', false, commands)).toBe(true)
  })

  test('repins for other local-jsx commands without the flag', () => {
    expect(shouldKeepScrollPositionOnSubmit('/clear', false, commands)).toBe(false)
  })

  test('repins for prompt-type commands', () => {
    expect(shouldKeepScrollPositionOnSubmit('/review foo', false, commands)).toBe(false)
  })

  test('repins for plain (non-slash) input', () => {
    expect(shouldKeepScrollPositionOnSubmit('hello world', false, commands)).toBe(false)
  })

  test('repins in bash mode even for /btw-looking input', () => {
    expect(shouldKeepScrollPositionOnSubmit('/btw question', true, commands)).toBe(false)
  })

  test('repins for unknown slash commands', () => {
    expect(shouldKeepScrollPositionOnSubmit('/nonexistent args', false, commands)).toBe(false)
  })

  test('the shipped btw command carries keepsScrollPosition and the aligned argumentHint', async () => {
    const { default: btw } = await import('../../commands/btw/index.js')
    expect(btw.type).toBe('local-jsx')
    if (btw.type === 'local-jsx') {
      expect(btw.keepsScrollPosition).toBe(true)
    }
    expect(btw.argumentHint).toBe('[question]')
    expect(shouldKeepScrollPositionOnSubmit('/btw q?', false, [btw])).toBe(true)
  })
})
