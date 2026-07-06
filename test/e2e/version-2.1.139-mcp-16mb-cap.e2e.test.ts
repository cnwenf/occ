import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('MCP SSE 16MB response cap (2.1.139, e2e)', () => {
  test('cap constant + helper present + wired into fetch wrapper', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    // Official 2.1.200 binary: maxContentLength/maxBodyLength = 16777216 (16MB)
    expect(src).toContain('MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024')
    expect(src).toContain('capMcpResponseBody')
    // Wired into the POST path of wrapFetchWithTimeout (GET/SSE is skipped)
    expect(src).toContain('return capMcpResponseBody(response)')
    // Two-way enforcement: Content-Length pre-check + mid-read stream cap
    expect(src).toContain('content-length')
    expect(src).toContain('received > MAX_MCP_RESPONSE_BYTES')
  })
})
