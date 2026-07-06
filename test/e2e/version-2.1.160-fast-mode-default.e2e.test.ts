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
    // No override branch — fast mode always uses 'opus'.
    expect(src).not.toContain('CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE')
    expect(src).toMatch(/return 'opus'/)
  })
})
