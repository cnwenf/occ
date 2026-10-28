import { afterEach, describe, expect, test } from 'bun:test'
import {
  absorbExplanationRequests,
  getExplanationRequestCount,
  isExplanationRequest,
  resetExplanationRequests,
  stripIdeAttachmentBlocks,
} from '../explanationRequests.js'

/**
 * claude-code 2.1.311 triage-T1 item 2 — the `mSs` explanation-request
 * detector that gates the `explanatory-output-style` spinner tip.
 *
 * Official v311 (byte-verified):
 *   `function mSs(e){let n=e.toLowerCase().replace(/’/g,"'")
 *      .replace(/\s+/g," ").trim();return/<detector>/.test(n)}` (@257316920)
 *   detector literal @257317076
 *   `function Gpr(t){return t.replace(z,"").trim()}` (@238958554)
 *   `var z=/<(ide_opened_file|ide_selection).../g` (@238958434)
 *
 * The detector is anchored (`^`), so only a message that STARTS with the
 * request phrasing counts — matching official, where "can you explain the bug
 * you just fixed" matches but "the docs explain this" does not.
 */

afterEach(() => {
  resetExplanationRequests()
})

describe('2.1.311 #2: isExplanationRequest — imperative teaching verbs', () => {
  test.each([
    'explain this function',
    'walk me through the auth flow',
    'help me understand why this fails',
    'teach me about the build system',
  ])('matches %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  test.each(['ok explain', 'okay explain this', 'please explain that'])(
    'matches with a politeness prefix: %s',
    text => {
      expect(isExplanationRequest(text)).toBe(true)
    },
  )

  test.each([
    'can you explain the diff',
    'could you walk me through it',
    'would you teach me this',
  ])('matches with a modal prefix: %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  test.each([
    'the docs explain this already',
    'i will explain it later',
    'explained',
    'teaching materials are ready',
  ])('does not match %s', text => {
    expect(isExplanationRequest(text)).toBe(false)
  })
})

describe('2.1.311 #2: isExplanationRequest — question forms', () => {
  test.each([
    'why does this throw',
    'why do the tests fail',
    'why is the build slow',
    'why are these duplicated',
    'why was that changed',
    'why were they removed',
    'why would that happen',
    'why should i care',
  ])('matches %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  test.each([
    'why do you keep doing that',
    'why does u fail',
    'why does it still fail',
    'why is this here again',
  ])('does not match an excluded why-question: %s', text => {
    expect(isExplanationRequest(text)).toBe(false)
  })

  test.each([
    'how come this works',
    'how does the cache refresh',
    'how do these hooks fire',
    'how do those pieces fit',
  ])('matches %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  test('does not match "how do you do that" (official excludes you)', () => {
    expect(isExplanationRequest('how do you do that')).toBe(false)
  })

  test.each([
    "what's this file for",
    'what is that flag',
    'what does the parser do',
  ])('matches %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  // Official's lookahead only excludes `you|u|we|i` after "what does/do", so a
  // third-person what-question still counts. Verified against the exact
  // official detector — do not "fix" the regex to make these false.
  test.each(['what does the spec say', 'what does it do'])(
    'matches a what-question the official lookahead does not exclude: %s',
    text => {
      expect(isExplanationRequest(text)).toBe(true)
    },
  )

  test.each([
    'what do you want',
    'what do we do',
    'what do i need',
  ])('does not match an excluded what-question: %s', text => {
    expect(isExplanationRequest(text)).toBe(false)
  })

  test.each([
    "i don't understand this",
    'i dont get it',
    'i do not understand why',
    'i don’t get why that happens',
  ])('matches a confusion phrasing: %s', text => {
    expect(isExplanationRequest(text)).toBe(true)
  })

  test.each([
    'i get it now',
    'understood, thanks',
    'make the tests pass',
    'fix the login redirect',
    'why',
    'how do i install bun',
  ])('does not match %s', text => {
    expect(isExplanationRequest(text)).toBe(false)
  })
})

describe('2.1.311 #2: isExplanationRequest — normalization (official mSs)', () => {
  test('is case-insensitive', () => {
    expect(isExplanationRequest('EXPLAIN This')).toBe(true)
    expect(isExplanationRequest('Why DOES It Throw')).toBe(true)
  })

  test('normalizes a curly apostrophe to a straight one', () => {
    expect(isExplanationRequest('what’s this')).toBe(true)
    expect(isExplanationRequest('i don’t get this')).toBe(true)
  })

  test('collapses internal whitespace runs', () => {
    expect(isExplanationRequest('explain\n\n  this\tfunction')).toBe(true)
  })

  test('trims surrounding whitespace', () => {
    expect(isExplanationRequest('   explain this   ')).toBe(true)
  })

  test('is false for an empty string', () => {
    expect(isExplanationRequest('')).toBe(false)
  })
})

describe('2.1.311 #2: stripIdeAttachmentBlocks (official Gpr / z)', () => {
  test('removes an ide_opened_file block', () => {
    expect(
      stripIdeAttachmentBlocks(
        '<ide_opened_file path="a.ts">code</ide_opened_file>\nexplain this',
      ),
    ).toBe('explain this')
  })

  test('removes an ide_selection block with attributes', () => {
    expect(
      stripIdeAttachmentBlocks(
        '<ide_selection lines="1-9">sel</ide_selection>\n\nwhy does it fail',
      ),
    ).toBe('why does it fail')
  })

  test('removes repeated blocks of both kinds', () => {
    expect(
      stripIdeAttachmentBlocks(
        '<ide_opened_file>a</ide_opened_file>\n<ide_selection>b</ide_selection>\nexplain x',
      ),
    ).toBe('explain x')
  })

  test('leaves unrelated angle-bracket text alone', () => {
    expect(stripIdeAttachmentBlocks('<other>text</other>')).toBe(
      '<other>text</other>',
    )
  })

  test('returns an empty string when only blocks are present', () => {
    expect(
      stripIdeAttachmentBlocks('<ide_opened_file>a</ide_opened_file>\n'),
    ).toBe('')
  })
})

describe('2.1.311 #2: absorbExplanationRequests session counter', () => {
  const userMessage = (
    uuid: string,
    content: string | Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'user',
    uuid,
    message: { role: 'user', content },
    ...extra,
  })

  test('counts a human prompt that asks for an explanation', () => {
    expect(absorbExplanationRequests([userMessage('a', 'explain this')])).toBe(1)
    expect(getExplanationRequestCount()).toBe(1)
  })

  test('ignores a prompt that is not an explanation request', () => {
    expect(absorbExplanationRequests([userMessage('a', 'fix the bug')])).toBe(0)
  })

  test('ignores assistant messages', () => {
    expect(
      absorbExplanationRequests([
        { type: 'assistant', uuid: 'a', message: { content: 'explain this' } },
      ]),
    ).toBe(0)
  })

  test('dedupes a repeated uuid across absorbs', () => {
    const messages = [userMessage('a', 'explain this')]
    expect(absorbExplanationRequests(messages)).toBe(1)
    expect(absorbExplanationRequests(messages)).toBe(1)
  })

  test('counts distinct uuids separately', () => {
    expect(
      absorbExplanationRequests([
        userMessage('a', 'explain this'),
        userMessage('b', 'why does it fail'),
      ]),
    ).toBe(2)
  })

  test.each([
    ['isMeta', { isMeta: true }],
    ['textNotTyped', { textNotTyped: true }],
    ['isCompactSummary', { isCompactSummary: true }],
    ['handedOff', { handedOff: true }],
    ['queueSkipAttachments', { queueSkipAttachments: true }],
    ['queueTranscriptOnly', { queueTranscriptOnly: true }],
    ['verifiedSlackHumanTurn', { verifiedSlackHumanTurn: true }],
    ['promptSource', { promptSource: 'suggestion_accepted' }],
  ])('skips an official-excluded user entry: %s', (_label, extra) => {
    expect(
      absorbExplanationRequests([userMessage('a', 'explain this', extra)]),
    ).toBe(0)
  })

  test('skips a tool-result user entry', () => {
    expect(
      absorbExplanationRequests([
        userMessage('a', 'explain this', { toolUseResult: { ok: true } }),
      ]),
    ).toBe(0)
  })

  test('reads text from a content-block array', () => {
    expect(
      absorbExplanationRequests([
        userMessage('a', [
          { type: 'text', text: 'why does' },
          { type: 'tool_use', id: 't' },
          { type: 'text', text: 'this fail' },
        ]),
      ]),
    ).toBe(1)
  })

  test('ignores a content array with no text blocks', () => {
    expect(
      absorbExplanationRequests([userMessage('a', [{ type: 'image' }])]),
    ).toBe(0)
  })

  test('strips IDE attachment blocks before detecting', () => {
    expect(
      absorbExplanationRequests([
        userMessage(
          'a',
          '<ide_opened_file path="a.ts">x</ide_opened_file>\nexplain this',
        ),
      ]),
    ).toBe(1)
  })

  test('counts a queued prompt attachment', () => {
    expect(
      absorbExplanationRequests([
        {
          type: 'attachment',
          uuid: 'q1',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            prompt: 'explain this',
          },
        },
      ]),
    ).toBe(1)
  })

  test.each([
    ['command', { commandMode: 'command' }],
    ['isMeta', { isMeta: true }],
    ['suggestion', { inputSource: 'suggestion_accepted' }],
    ['slack', { verifiedSlackHumanTurn: true }],
  ])('skips an official-excluded queued attachment: %s', (_label, extra) => {
    expect(
      absorbExplanationRequests([
        {
          type: 'attachment',
          uuid: 'q1',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            prompt: 'explain this',
            ...extra,
          },
        },
      ]),
    ).toBe(0)
  })

  test('scans only entries appended since the previous absorb', () => {
    const first = [userMessage('a', 'explain this')]
    const second = [...first, userMessage('b', 'why does it fail')]
    expect(absorbExplanationRequests(first)).toBe(1)
    expect(absorbExplanationRequests(second)).toBe(2)
  })

  test('tolerates malformed entries without throwing', () => {
    expect(
      absorbExplanationRequests([
        null,
        undefined,
        'plain string',
        42,
        { type: 'user' },
        { type: 'user', uuid: 'a' },
        { type: 'user', uuid: 'a', message: 'not an object' },
        { type: 'user', uuid: 7, message: { content: 'explain this' } },
        { type: 'attachment', uuid: 'q', attachment: 'nope' },
      ]),
    ).toBe(0)
  })

  test('reset clears the count and rescans from the start', () => {
    const messages = [userMessage('a', 'explain this')]
    expect(absorbExplanationRequests(messages)).toBe(1)
    resetExplanationRequests()
    expect(getExplanationRequestCount()).toBe(0)
    expect(absorbExplanationRequests(messages)).toBe(1)
  })
})
