import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Explore agent inherits main model (2.1.198, e2e)', () => {
  test('exploreAgent model is inherit for all users (not haiku-for-non-ant)', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/AgentTool/built-in/exploreAgent.ts`,
    ).text()
    // 2.1.198: Explore inherits the main session model (capped at Opus) for all
    // users. Previously non-ant users got 'haiku'.
    expect(src).toMatch(/model:\s*['"]inherit['"]/)
    // The old ant/haiku split must be gone.
    expect(src).not.toContain("process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku'")
  })
})
