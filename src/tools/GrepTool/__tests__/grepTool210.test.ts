import { describe, expect, test } from 'bun:test'
import { GrepTool } from '../GrepTool.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Minimal ToolUseContext mock for GrepTool.call(). The permission context
 * needs alwaysAllowRules/alwaysDenyRules/denyRules keys for each source
 * to avoid "undefined is not an object" in getFileReadIgnorePatterns.
 */
function makeMockContext(): any {
  const emptyRules = {
    settings: [],
    cliArg: [],
    command: [],
    session: [],
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'ask',
        alwaysAllowRules: emptyRules,
        alwaysDenyRules: emptyRules,
        denyRules: emptyRules,
        additionalDirectories: [],
        hasFlaggedPermissions: false,
      },
    }),
    setAppState: () => {},
  }
}

/**
 * 2.1.208 #14d: Grep null-byte validation.
 * Ported from Claude Code 2.1.210 binary SJn(sd, ...).
 */
describe('2.1.208 #14d — Grep null-byte validation', () => {
  test('rejects a null byte in pattern', async () => {
    const result = await GrepTool.validateInput({
      pattern: 'foo\x00bar',
      path: undefined,
    } as any)
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(
      'Grep pattern cannot contain null bytes (\\0). Remove the null byte and try again.',
    )
  })

  test('rejects a null byte in glob', async () => {
    const result = await GrepTool.validateInput({
      pattern: 'foo',
      path: undefined,
      glob: '*.ts\x00',
    } as any)
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(
      'Grep glob cannot contain null bytes (\\0). Remove the null byte and try again.',
    )
  })

  test('does not reject valid input without null bytes', async () => {
    const result = await GrepTool.validateInput({
      pattern: 'foo',
      path: undefined,
    } as any)
    expect(result.result).toBe(true)
  })
})

/**
 * 2.1.208 #14b: Grep silently returning 'No files found' for invalid regex.
 * The fix rejects invalid regex patterns (ripgrep exit code 2 + pattern-error
 * stderr) as a SearchPatternError instead of resolving [].
 *
 * 2.1.208 #14c: Grep count mode under-reporting totals when paginated.
 * The fix computes numMatches/numFiles from the FULL results array before
 * applyHeadLimit, not from the paginated slice.
 *
 * 2.1.210 #14: Grep content/files_with_matches mode claiming 'No matches
 * found' / 'No files found' when paginating past the end of results. The
 * fix uses totalLines/totalFiles (full counts) to say 'No entries at this
 * offset' instead.
 */
describe('2.1.210 #14 — Grep mapper pagination', () => {
  test('content mode: "No entries at this offset" when paginated past end', () => {
    // Arrange — content empty, appliedOffset set, totalLines > 0
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    // Act
    const result = mapper(
      {
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content: '',
        numLines: 0,
        totalLines: 10, // full count before pagination
        appliedLimit: 10,
        appliedOffset: 20, // past end
      },
      'tool-use-1',
    )

    // Assert
    expect(result.type).toBe('tool_result')
    expect(result.content).toContain('No entries at this offset')
    expect(result.content).toContain('[Showing results with pagination = limit: 10, offset: 20]')
  })

  test('content mode: "No matches found" when there are genuinely zero results', () => {
    // Arrange — content empty, no offset, totalLines = 0
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    // Act
    const result = mapper(
      {
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content: '',
        numLines: 0,
        totalLines: 0,
      },
      'tool-use-2',
    )

    // Assert
    expect(result.content).toBe('No matches found')
  })

  test('count mode: "No entries at this offset" when paginated past end with full total > 0', () => {
    // Arrange — content empty, numMatches (FULL) > 0
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    // Act
    const result = mapper(
      {
        mode: 'count',
        numFiles: 3, // full file count
        filenames: [],
        content: '',
        numMatches: 15, // FULL match total (before pagination)
        appliedLimit: 10,
        appliedOffset: 20,
      },
      'tool-use-3',
    )

    // Assert
    expect(result.content).toContain('No entries at this offset')
    expect(result.content).toContain('Found 15 total occurrences across 3 files.')
    expect(result.content).toContain('with pagination = limit: 10, offset: 20')
  })

  test('count mode: "No matches found" when numMatches (FULL) is 0', () => {
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    const result = mapper(
      {
        mode: 'count',
        numFiles: 0,
        filenames: [],
        content: '',
        numMatches: 0,
      },
      'tool-use-4',
    )

    expect(result.content).toContain('No matches found')
    expect(result.content).toContain('Found 0 total occurrences across 0 files.')
  })

  test('files_with_matches: "No entries at this offset" when paginated past end', () => {
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    const result = mapper(
      {
        mode: 'files_with_matches',
        numFiles: 0, // paginated count
        filenames: [],
        totalFiles: 5, // full count before pagination
        appliedLimit: 5,
        appliedOffset: 10,
      },
      'tool-use-5',
    )

    expect(result.content).toBe(
      'No entries at this offset. [Showing results with pagination = limit: 5, offset: 10]',
    )
  })

  test('files_with_matches: "No files found" when genuinely no matches', () => {
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam

    const result = mapper(
      {
        mode: 'files_with_matches',
        numFiles: 0,
        filenames: [],
        totalFiles: 0,
      },
      'tool-use-6',
    )

    expect(result.content).toBe('No files found')
  })
})

/**
 * 2.1.208 #14c: count mode under-reporting. The call() method must compute
 * numMatches/numFiles from the FULL results array (before applyHeadLimit).
 * This integration test creates real files, runs Grep in count mode with
 * head_limit + offset past the end, and verifies the FULL totals appear in
 * the tool result.
 */
describe('2.1.208 #14c — Grep count totals from full results', () => {
  test('count mode reports full totals even when paginated past end', async () => {
    // Arrange — create a temp dir with 3 files, each matching "foo"
    const dir = mkdtempSync(join(tmpdir(), 'grep-count-'))
    writeFileSync(join(dir, 'a.ts'), 'foo\nfoo\n') // 2 matches
    writeFileSync(join(dir, 'b.ts'), 'foo\n') // 1 match
    writeFileSync(join(dir, 'c.ts'), 'foo\nfoo\nfoo\n') // 3 matches

    // Act — head_limit=1, offset=10 (past end of 3-file results)
    const callResult = await GrepTool.call(
      {
        pattern: 'foo',
        path: dir,
        output_mode: 'count',
        head_limit: 1,
        offset: 10,
      } as any,
      makeMockContext(),
    )

    // Assert — data has FULL totals (6 matches, 3 files)
    expect(callResult.data.mode).toBe('count')
    expect(callResult.data.numMatches).toBe(6)
    expect(callResult.data.numFiles).toBe(3)
    // content is empty (paginated past end)
    expect(callResult.data.content).toBe('')

    // The mapper should show "No entries at this offset" + full totals
    const mapper = (GrepTool as any).mapToolResultToToolResultBlockParam
    const result = mapper(callResult.data, 'tu')
    expect(result.content).toContain('No entries at this offset')
    expect(result.content).toContain('Found 6 total occurrences across 3 files.')
  })
})

/**
 * 2.1.208 #14b: invalid regex → SearchPatternError (not silent "No files found").
 */
describe('2.1.208 #14b — Grep invalid regex rejection', () => {
  test('invalid regex pattern throws an error instead of returning empty results', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'grep-regex-'))
    writeFileSync(join(dir, 'a.ts'), 'hello\n')

    // Act — an unbalanced paren is an invalid regex
    const promise = GrepTool.call(
      {
        pattern: '(unclosed',
        path: dir,
      } as any,
      makeMockContext(),
    )

    // Assert — should reject (not resolve with empty results)
    await expect(promise).rejects.toThrow()
    try {
      await promise
    } catch (e: any) {
      expect(e.message).toContain('Search failed')
      expect(e.message).toContain('ripgrep rejected the pattern')
    }
  })
})
