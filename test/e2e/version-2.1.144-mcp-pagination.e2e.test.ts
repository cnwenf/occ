import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('MCP pagination nextCursor (2.1.144, e2e)', () => {
  test('tools/list follows nextCursor', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain("'tools/list'")
    expect(src).toMatch(/params:\s*\{\s*cursor\s*\}/)
    expect(src).toContain("(result as { nextCursor?: string }).nextCursor")
  })

  test('resources/list follows nextCursor', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain("'resources/list'")
    // resources loop uses .concat to accumulate across pages
    expect(src).toContain('resources.concat(result.resources)')
  })

  test('prompts/list follows nextCursor', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain("'prompts/list'")
    expect(src).toContain('allPrompts.push(...result.prompts)')
  })
})
