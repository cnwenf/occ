import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Streaming idle watchdog default-on + 5min (2.1.196, e2e)', () => {
  test('watchdog is default-on (opt-out, not opt-in)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/api/claude.ts`).text()
    // 2.1.196: tengu_stream_watchdog_default_on → on by default.
    // Opt out via CLAUDE_DISABLE_STREAM_WATCHDOG (was: opt-in via CLAUDE_ENABLE_STREAM_WATCHDOG).
    expect(src).toContain('CLAUDE_DISABLE_STREAM_WATCHDOG')
    expect(src).not.toContain('process.env.CLAUDE_ENABLE_STREAM_WATCHDOG')
  })

  test('idle timeout default is 5min (300000ms), not 90s', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/api/claude.ts`).text()
    // 2.1.196: default idle timeout is 300000ms. The source uses nullish
    // coalescing (`?? 300_000`) so an explicit `0` env override is honored —
    // assert on `?? 300_000` (the correct, current operator) rather than the
    // legacy `|| 300_000` string.
    expect(src).toContain('?? 300_000')
    expect(src).not.toContain('|| 90_000')
  })
})
