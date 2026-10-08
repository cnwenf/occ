import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// The fetch path reads MACRO.VERSION (a build-time constant polyfilled in
// cli.tsx). Mirror that polyfill so the module imports cleanly under test.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Item #018a (2.1.292/293 forensics §2.11): `applyPromptToMarkdown` ≈ the
 * official secondary-model summarizer `Jht`, which OCC previously lacked two
 * always-on pieces of:
 *
 *   1. `contentLead` — official Jht builds `userPrompt: \`${z}${he}\`` where
 *      z is the caller-supplied contentLead (the "one part of a longer page"
 *      preamble when offset > 0).
 *   2. Surrogate-safe truncation — official `Y=n.length>$Tn?zJn(n)+
 *      "\n\n[Content truncated due to length...]":n` where `zJn(e)=ne(e,$Tn)`
 *      is the surrogate-safe head slicer (`ne` @203275474), NOT a plain
 *      `.slice(0, 100000)` which can leave a lone high surrogate dangling.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only queryHaiku, and restore after.
const actualClaude = await import('../../../services/api/claude.js')

let capturedUserPrompt: string | undefined

mock.module('../../../services/api/claude.js', () => ({
  ...actualClaude,
  queryHaiku: async (args: { userPrompt: string }) => {
    capturedUserPrompt = args.userPrompt
    return {
      message: { content: [{ type: 'text', text: 'SUMMARY' }] },
    }
  },
}))

// Fresh utils instance via a cache-busting suffix: another test file in the
// same worker (webfetchCall018) replaces the '../utils.js' registry entry
// with a spread-copy restore namespace, and functions captured in that copy
// no longer see this file's claude.js mock (OCC-97 class leak). A fresh
// evaluation deterministically binds queryHaiku to the mocked claude.js.
const { applyPromptToMarkdown, MAX_MARKDOWN_LENGTH } = await import(
  '../utils.js?contentLead018'
)

afterAll(() => {
  mock.module('../../../services/api/claude.js', () => ({ ...actualClaude }))
})

afterEach(() => {
  capturedUserPrompt = undefined
})

describe('#018a — applyPromptToMarkdown contentLead (official Jht `z` param)', () => {
  test('prepends contentLead verbatim to the secondary-model userPrompt', async () => {
    const lead =
      "The content below is one part of a longer page: it starts 4 characters into the page's 10.\n"
    await applyPromptToMarkdown(
      'summarize',
      'efghij',
      new AbortController().signal,
      false,
      false,
      lead,
    )
    expect(capturedUserPrompt).toBeDefined()
    expect(capturedUserPrompt?.startsWith(lead)).toBe(true)
    // The lead comes BEFORE the standard `\nWeb page content:` layout.
    expect(capturedUserPrompt).toContain(`${lead}\nWeb page content:`)
  })

  test('defaults to no lead (prior behavior preserved)', async () => {
    await applyPromptToMarkdown(
      'summarize',
      'efghij',
      new AbortController().signal,
      false,
      false,
    )
    expect(capturedUserPrompt?.startsWith('\nWeb page content:')).toBe(true)
    expect(capturedUserPrompt).not.toContain('one part of a longer page')
  })

  test('returns the model text', async () => {
    const result = await applyPromptToMarkdown(
      'summarize',
      'content',
      new AbortController().signal,
      false,
      false,
    )
    expect(result).toBe('SUMMARY')
  })
})

describe('#018a — applyPromptToMarkdown surrogate-safe truncation (official zJn/ne)', () => {
  test('truncates over-length content with the official marker', async () => {
    const long = 'x'.repeat(MAX_MARKDOWN_LENGTH + 5_000)
    await applyPromptToMarkdown(
      'summarize',
      long,
      new AbortController().signal,
      false,
      false,
    )
    expect(capturedUserPrompt).toContain('x'.repeat(MAX_MARKDOWN_LENGTH))
    expect(capturedUserPrompt).toContain(
      '\n\n[Content truncated due to length...]',
    )
    expect(capturedUserPrompt).not.toContain('x'.repeat(MAX_MARKDOWN_LENGTH + 1))
  })

  test('drops a lone high surrogate at the 100k cut point instead of splitting the pair', async () => {
    // '😀' straddles the MAX_MARKDOWN_LENGTH boundary: a plain
    // .slice(0, 100000) would keep the lone high surrogate '\uD83D';
    // official `ne` drops it.
    const content = 'a'.repeat(MAX_MARKDOWN_LENGTH - 1) + '😀' + 'b'.repeat(20)
    await applyPromptToMarkdown(
      'summarize',
      content,
      new AbortController().signal,
      false,
      false,
    )
    expect(capturedUserPrompt).toBeDefined()
    expect(capturedUserPrompt).not.toContain('\uD83D')
    expect(capturedUserPrompt).toContain(
      `${'a'.repeat(MAX_MARKDOWN_LENGTH - 1)}\n\n[Content truncated due to length...]`,
    )
  })

  test('keeps a complete surrogate pair ending exactly at the cut point', async () => {
    const content = 'a'.repeat(MAX_MARKDOWN_LENGTH - 2) + '😀' + 'b'.repeat(20)
    await applyPromptToMarkdown(
      'summarize',
      content,
      new AbortController().signal,
      false,
      false,
    )
    expect(capturedUserPrompt).toContain(
      `${'a'.repeat(MAX_MARKDOWN_LENGTH - 2)}😀\n\n[Content truncated due to length...]`,
    )
  })

  test('content at or below the cap is passed through untouched', async () => {
    const content = 'y'.repeat(MAX_MARKDOWN_LENGTH)
    await applyPromptToMarkdown(
      'summarize',
      content,
      new AbortController().signal,
      false,
      false,
    )
    expect(capturedUserPrompt).not.toContain('[Content truncated due to length')
    expect(capturedUserPrompt).toContain(content)
  })
})
