import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Command description drift alignment 2 (2.1.200, e2e)', () => {
  test('/compact description matches binary', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/compact/index.ts`).text()
    expect(src).toContain('Free up context by summarizing the conversation so far')
    expect(src).not.toContain('Clear conversation history but keep a summary')
  })

  test('/review description matches binary', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/review.ts`).text()
    expect(src).toContain('Review a GitHub pull request; for your working diff use /code-review')
    expect(src).not.toContain("'Review a pull request'")
  })

  test('/advisor description matches binary', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/advisor.ts`).text()
    expect(src).toContain('Let Claude consult a stronger model at key moments')
    expect(src).not.toContain('Configure the advisor model')
  })
})
