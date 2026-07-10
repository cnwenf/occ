import { describe, expect, test } from 'bun:test'
import { writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, runOcc } from './helpers'

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

// Live-agent e2e — opt-in via ANTHROPIC_API_KEY. Drives /feedback through the
// real agent loop (needs dist/cli.js built: `bun run build`). A fake `gh` on a
// temp PATH captures the synthesized title/body and prints a fake issue URL,
// so no real GitHub issue is ever created.
const hasApiKey = !!process.env.ANTHROPIC_API_KEY
const live = hasApiKey ? describe : describe.skip

live('/feedback: live agent files an issue via fake gh', () => {
  test('agent runs gh issue create with a title+body reflecting the report', async () => {
    // Fake gh shim: captures --title/--body, prints a fake issue URL.
    const binDir = mkdtempSync(join(tmpdir(), 'occ-gh-shim-'))
    const capturePath = join(binDir, 'capture.json')
    const shim = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let title = '', body = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title' && i + 1 < args.length) { title = args[++i]; }
  else if (args[i] === '--body' && i + 1 < args.length) { body = args[++i]; }
}
fs.writeFileSync('${capturePath}', JSON.stringify({ title, body, args }));
// Print a fake issue URL — the agent reports this back.
console.log('https://github.com/cnwenf/occ/issues/99999');
`
    const ghPath = join(binDir, 'gh')
    writeFileSync(ghPath, shim)
    chmodSync(ghPath, 0o755)

    try {
      // Pipe mode: the positional "/feedback ..." is captured as the [prompt]
      // arg (main.tsx getPrompt), routed through processUserInput →
      // processSlashCommand → getPromptForCommand, then the agent turn runs
      // with Bash and invokes the PATH-shadowing gh shim.
      // --dangerously-skip-permissions so gh (the shim) runs unattended.
      const result = await runOcc(
        [
          '-p',
          '--dangerously-skip-permissions',
          '/feedback 测试报错：TypeError: live boom at app.ts:10',
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ''}` },
        180_000,
      )

      // Agent should have run gh and printed the fake URL.
      expect(result.stdout + result.stderr).toContain(
        'https://github.com/cnwenf/occ/issues/99999',
      )

      // The shim captured the title + body the agent synthesized.
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'))
      expect(captured.title.length).toBeLessThanOrEqual(80)
      expect(captured.title).toMatch(/^\[Bug\]|^\[Feedback\]/)
      expect(captured.body).toContain('live boom')
      expect(captured.body).toMatch(/用户反馈|User Report/)
      expect(captured.body).toMatch(/环境信息|Environment/)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 200_000)
})
