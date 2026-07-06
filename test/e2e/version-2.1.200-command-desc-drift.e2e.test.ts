import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('Command description drift alignment (2.1.200, e2e)', () => {
  test('/clear description matches binary', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/clear/index.ts`).text()
    expect(src).toContain('Start a new session with empty context')
    expect(src).toContain('resumable with /resume')
    expect(src).not.toContain('Clear conversation history and free up context')
  })

  test('/memory description matches binary', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/memory/index.ts`).text()
    expect(src).toContain("Open a memory file in your editor")
    expect(src).not.toContain('Edit Claude memory files')
  })

  test('/remote-env description matches binary (cloud agents, not teleport)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/remote-env/index.ts`).text()
    expect(src).toContain('Choose the default environment for cloud agents')
    expect(src).not.toContain('teleport sessions')
  })
})
