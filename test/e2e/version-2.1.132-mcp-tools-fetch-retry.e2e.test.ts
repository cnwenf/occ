import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('MCP tools-fetch-failed retry + status (2.1.132, e2e)', () => {
  test('ConnectedMCPServer has toolsFetchError field', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/types.ts`).text()
    expect(src).toContain('toolsFetchError?: string')
  })

  test('fetchToolsForClient retries tools/list (requestToolsListWithRetry)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain('requestToolsListWithRetry')
    // 3 attempts with backoff
    expect(src).toMatch(/attempts\s*=\s*3/)
    expect(src).toContain('500 * (i + 1)')
  })

  test('SDK connection flow sets toolsFetchError instead of hard-failing', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain('tools fetch failed')
    expect(src).toContain('(connectedClient as ConnectedMCPServer).toolsFetchError')
  })

  test('/mcp renders "connected · tools fetch failed" when toolsFetchError set', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/components/mcp/MCPListPanel.tsx`,
    ).text()
    expect(src).toContain('connected · tools fetch failed')
    expect(src).toContain('server_3.client.toolsFetchError')
  })
})
