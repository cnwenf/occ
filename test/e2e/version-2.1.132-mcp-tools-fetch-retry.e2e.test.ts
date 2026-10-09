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
    // 2.1.295 (item 2): the retry now runs inside the official paginated
    // walker — [250, 500, 1000]ms delays (`Os`) gated by isRetryableListError
    // (`jn`), replacing the old 3×500·(i+1)ms loop.
    const pagination = await Bun.file(
      `${REPO_ROOT}/src/services/mcp/listPagination.ts`,
    ).text()
    expect(pagination).toContain('[250, 500, 1000]')
    expect(pagination).toContain('isRetryableListError')
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
