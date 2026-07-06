import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.162 Glob/Grep --tools re-add (source-grep): verifies H14
 * against the official 2.1.200 binary.
 *
 *   H14 — On embedded-search builds (ant-native bfs/ugrep in the bun binary)
 *         Glob/Grep are excluded from getAllBaseTools() (the dedicated tools
 *         are unnecessary when the shell's find/grep already hit the fast
 *         embedded binaries). But the `--tools` flag must still be able to opt
 *         back into them. OCC removed them entirely with no re-add path; the
 *         binary re-adds them in getTools() filtered by the permission-context
 *         deny rules (which is what `--tools` populates).
 *
 * Source-grep assertions only (no model credentials required).
 */
describe('2.1.162 Glob/Grep --tools re-add (source-grep)', () => {
  test('H14: getTools() re-adds Glob/Grep on embedded-search builds via the deny filter', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/tools.ts`).text()

    // The embedded-search exclusion still exists in getAllBaseTools.
    expect(src).toContain('hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]')

    // ...and getTools() re-adds them, gated on embedded-search + not-REPL,
    // filtered by the permission-context deny rules (the --tools path).
    // Mirrors the binary's `if(ZC()&&!s&&!i){l=[...l,...Nie([dK,y2].filter
    // (!l.includes),e)]}` re-add block.
    expect(src).toContain('hasEmbeddedSearchTools() && !isReplModeEnabled()')
    expect(src).toContain('[GlobTool, GrepTool].filter')
    expect(src).toContain('!enabledTools.includes')
    expect(src).toMatch(/filterToolsByDenyRules\(reAddable, permissionContext\)/)
  })

  test('H14: Glob/Grep tool defs remain intact (not gutted by the embedded exclusion)', async () => {
    const globSrc = await Bun.file(
      `${REPO_ROOT}/src/tools/GlobTool/GlobTool.ts`,
    ).text()
    const grepSrc = await Bun.file(
      `${REPO_ROOT}/src/tools/GrepTool/GrepTool.ts`,
    ).text()

    // The tool objects themselves are unchanged — the exclusion is purely a
    // registry-list concern, so re-adding the same tool object works.
    expect(globSrc).toContain("name: GLOB_TOOL_NAME")
    expect(grepSrc).toContain("name: GREP_TOOL_NAME")
    expect(globSrc).toContain('isSearchOrReadCommand')
    expect(grepSrc).toContain('isSearchOrReadCommand')
  })
})
