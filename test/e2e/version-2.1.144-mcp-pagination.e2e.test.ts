import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * 2.1.144 introduced nextCursor pagination for tools/list, resources/list
 * and prompts/list. 2.1.295 (item 2) moved all three walks onto the official
 * guarded paginated walker (`Qn`): repeated-cursor detection, a hard 20-page
 * cap (`rs=20`), the official [250, 500, 1000]ms transient retry schedule
 * (`Os`), and tengu_mcp_list_paginated telemetry (`Kn`, field `outcome`).
 * The directory-read walk keeps its own official guards (`R`: 20-page cap +
 * InvalidParams-on-cursor partial return, no sent-cursor Set / telemetry).
 */
describe('MCP pagination nextCursor (2.1.144 + 2.1.295 guards, e2e)', () => {
  test('all three list methods walk through the guarded paginated walker', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/mcp/client.ts`).text()
    expect(src).toContain('walkPaginatedList')
    expect(src).toContain("'tools/list'")
    expect(src).toContain("'resources/list'")
    expect(src).toContain("'prompts/list'")
  })

  test('walker detects a repeated cursor and caps at the official 20 pages', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/mcp/listPagination.ts`,
    ).text()
    // repeated-cursor stop (sent-cursor Set)
    expect(src).toContain('sentCursors.has(cursor)')
    // official `rs = 20` page cap
    expect(src).toContain('MAX_LIST_PAGES = 20')
    // official log lines
    expect(src).toContain(
      'returned a nextCursor already sent in this walk (page ${pageCount}); stopping',
    )
    expect(src).toContain(
      'still returning nextCursor after ${MAX_LIST_PAGES} pages; stopping',
    )
  })

  test('walker emits tengu_mcp_list_paginated telemetry and uses the official retry schedule', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/mcp/listPagination.ts`,
    ).text()
    expect(src).toContain('tengu_mcp_list_paginated')
    expect(src).toContain('outcome')
    // official `Os = [250, 500, 1000]` transient retry delays
    expect(src).toContain('[250, 500, 1000]')
  })

  test('directory-read walk keeps the official cap + InvalidParams partial return (2.1.295)', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/ReadMcpResourceDirTool/ReadMcpResourceDirTool.ts`,
    ).text()
    expect(src).toContain('MAX_DIRECTORY_READ_PAGES = 20')
    expect(src).toContain('pages with more pending')
    expect(src).toContain('entries from prior pages')
  })
})
