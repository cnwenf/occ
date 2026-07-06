import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Fast mode default + override no-op (2.1.142/2.1.160, e2e)', () => {
  test('FAST_MODE_MODEL_DISPLAY is Opus 4.8 (not 4.6)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/fastMode.ts`).text()
    expect(src).toContain("FAST_MODE_MODEL_DISPLAY = 'Opus 4.8'")
    expect(src).not.toContain("FAST_MODE_MODEL_DISPLAY = 'Opus 4.6'")
  })

  test('getFastModeModel returns opus (default Opus 4.8)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/fastMode.ts`).text()
    // The override is a no-op: the functional env check is gone (the string
    // may still appear in a deprecation comment).
    expect(src).not.toContain(
      'isEnvTruthy(process.env.CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE)',
    )
    expect(src).not.toContain('useOpus46')
    expect(src).toMatch(/return 'opus'/)
  })
})
