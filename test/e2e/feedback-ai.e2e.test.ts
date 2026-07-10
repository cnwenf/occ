import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

const FEEDBACK_SRC = `${REPO_ROOT}/src/commands/feedback/index.ts`

describe('/feedback command: prompt assembly + registration', () => {
  test('is a prompt-type command registered in commands.ts', async () => {
    const src = await Bun.file(FEEDBACK_SRC).text()
    expect(src).toContain("type: 'prompt'")
    expect(src).toContain('getPromptForCommand')
    expect(src).toContain("'filing feedback issue'")
    expect(src).toContain('cnwenf/occ')
  })

  test('collects + redacts diagnostics into the returned prompt', async () => {
    // Exercise the REAL getPromptForCommand, not a mock.
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const cmd = mod.default
    expect(cmd.type).toBe('prompt')

    // Seed an in-memory error + last API request via the same modules the
    // command reads from, so the prompt reflects them. logError() populates
    // the same in-memory store that getInMemoryErrors() reads (log.ts local
    // singleton — NOT state.ts's addToInMemoryErrorLog, which writes a
    // different store).
    const { logError } = await import(`${REPO_ROOT}/src/utils/log.js`)
    const { setLastAPIRequest } = await import(
      `${REPO_ROOT}/src/bootstrap/state.js`
    )
    logError(new Error('TypeError: test boom at x.ts:42'))
    setLastAPIRequest({ model: 'claude-sonnet-4-6', max_tokens: 8192 } as never)

    const blocks = await cmd.getPromptForCommand(
      '我的报错：TypeError: test boom',
      { messages: [], abortController: new AbortController() } as never,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    const text = (blocks[0] as { type: 'text'; text: string }).text

    // User question embedded verbatim (redacted).
    expect(text).toContain('我的报错：TypeError: test boom')
    // Seeded error survives into the prompt.
    expect(text).toContain('TypeError: test boom')
    // OCC version present.
    expect(text).toMatch(/2\.1\.204|unknown/)
    // Last API request model present.
    expect(text).toContain('claude-sonnet-4-6')
    // Agent instructions for gh submission + fallback URL.
    expect(text).toContain('gh issue create')
    expect(text).toContain('cnwenf/occ')
    expect(text).toContain('issues/new')
  })

  test('no-args returns a prompt asking the user what to report', async () => {
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const blocks = await mod.default.getPromptForCommand(
      '',
      { messages: [], abortController: new AbortController() } as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text.length).toBeGreaterThan(0)
    // Asks the user for their report.
    expect(text.toLowerCase()).toMatch(/ask|what|report/)
  })
})

describe('/feedback: redaction safety', () => {
  test('strips sk-ant keys from seeded errors before embedding', async () => {
    const { logError } = await import(`${REPO_ROOT}/src/utils/log.js`)
    logError(new Error('Auth failed for key sk-ant-api03-deadbeef000000000000000000000000'))
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const blocks = await mod.default.getPromptForCommand(
      'feedback about auth',
      { messages: [], abortController: new AbortController() } as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).not.toContain('sk-ant-api03-deadbeef')
    expect(text).toContain('[REDACTED_API_KEY]')
  })
})
