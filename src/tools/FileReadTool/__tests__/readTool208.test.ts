import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readFileInRange,
  SelectedRangeTooLargeError,
} from '../../../utils/readFileInRange.js'

/**
 * 2.1.208 #14a: Read reporting empty files as 'shorter than offset'.
 * Ported the 4-case mapper from Claude Code 2.1.210 binary.
 *
 * Before the fix: an empty file (0 bytes) read with default offset (1)
 * reported "shorter than the provided offset (1). The file has 1 lines."
 * because readFileInRange returns totalLines=1 and the 2-case mapper
 * checked `totalLines === 0` (which was false).
 *
 * After the fix: the 4-case mapper checks `numLines >= 1` (case 3),
 * which catches empty files that returned 1 (empty) line.
 */
describe('2.1.208 #14a — Read empty file mapper', () => {
  const mapper = (FileReadTool as any).mapToolResultToToolResultBlockParam

  test('empty file with default offset reports "contents are empty" (not "shorter than offset")', () => {
    // Arrange — empty file: content='', numLines=1, totalLines=1
    const data = {
      type: 'text' as const,
      file: {
        filePath: '/tmp/empty.txt',
        content: '',
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    }

    // Act
    const result = mapper(data, 'tu-empty')

    // Assert — case 3: numLines >= 1 → "contents are empty"
    expect(result.type).toBe('tool_result')
    expect(result.content).toContain(
      'Warning: the file exists but the contents are empty.',
    )
    expect(result.content).not.toContain('shorter than the provided offset')
  })

  test('file with content shows line numbers (case 1)', () => {
    const data = {
      type: 'text' as const,
      file: {
        filePath: '/tmp/hello.txt',
        content: 'hello\nworld',
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    }

    const result = mapper(data, 'tu-hello')
    expect(result.content).toContain('hello')
    expect(result.content).toContain('world')
  })

  test('file shorter than offset reports "shorter than the provided offset" (case 4)', () => {
    // Arrange — 5-line file read with offset=10: content='', numLines=0, totalLines=5
    const data = {
      type: 'text' as const,
      file: {
        filePath: '/tmp/short.txt',
        content: '',
        numLines: 0,
        startLine: 10,
        totalLines: 5,
      },
    }

    const result = mapper(data, 'tu-short')
    expect(result.content).toContain('shorter than the provided offset (10)')
    expect(result.content).toContain('The file has 5 lines.')
  })

  test('file with blank lines shows single line number (case 2)', () => {
    // Arrange — 2 blank lines: content='' (joined), numLines=2, totalLines=2
    const data = {
      type: 'text' as const,
      file: {
        filePath: '/tmp/blanks.txt',
        content: '',
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    }

    const result = mapper(data, 'tu-blanks')
    // Case 2: lId(e) + jxn("", startLine, "\t") → startLine + tab
    expect(result.content).toContain('1\t')
  })
})

/**
 * 2.1.208 #30: Memory blowup when reading files with extremely long single
 * lines using offset/limit. The fix passes maxSelectedBytes to readFileInRange
 * so the streaming path rejects with SelectedRangeTooLargeError instead of
 * loading the whole line.
 *
 * Binary Wtr (SelectedRangeTooLargeError):
 *   "The requested line range contains over ${formatFileSize(maxSelectedBytes)}
 *   of text, more than a read can return. Use a smaller limit — or, if a
 *   single line is this large, no limit will fit it: search for specific
 *   content instead."
 */
describe('2.1.208 #30 — Read long-line cap (SelectedRangeTooLargeError)', () => {
  test('readFileInRange throws SelectedRangeTooLargeError for a single long line with limit', async () => {
    // Arrange — a 2 MB single-line file, read with offset=1 limit=100
    // maxSelectedBytes = 25000 * 128 = 3,200,000 (3.2 MB) by default
    // Actually we pass an explicit small maxSelectedBytes to trigger the cap
    const dir = mkdtempSync(join(tmpdir(), 'read-long-'))
    const longLine = 'A'.repeat(500_000) // 500 KB single line
    const filePath = join(dir, 'longline.txt')
    writeFileSync(filePath, longLine + '\n')

    // Act — pass a small maxSelectedBytes (10 KB) so the single line exceeds it
    await expect(
      readFileInRange(filePath, 0, 100, undefined, undefined, {
        maxSelectedBytes: 10_000,
      }),
    ).rejects.toThrow(SelectedRangeTooLargeError)
  })

  test('readFileInRange does NOT throw when file fits within maxSelectedBytes', async () => {
    // Arrange — small file, generous cap
    const dir = mkdtempSync(join(tmpdir(), 'read-small-'))
    const filePath = join(dir, 'small.txt')
    writeFileSync(filePath, 'line1\nline2\nline3\n')

    // Act
    const result = await readFileInRange(filePath, 0, 100, undefined, undefined, {
      maxSelectedBytes: 1_000_000,
    })

    // Assert
    expect(result.content).toContain('line1')
    expect(result.content).toContain('line3')
    expect(result.lineCount).toBeGreaterThanOrEqual(3)
  })

  test('SelectedRangeTooLargeError message matches the official string format', () => {
    // Arrange
    const err = new SelectedRangeTooLargeError(500_000, 10_000)

    // Assert
    expect(err.name).toBe('SelectedRangeTooLargeError')
    expect(err.message).toContain(
      'The requested line range contains over',
    )
    expect(err.message).toContain(
      'more than a read can return.',
    )
    expect(err.message).toContain(
      'Use a smaller limit',
    )
    expect(err.message).toContain(
      'search for specific content instead.',
    )
    expect(err.selectedBytes).toBe(500_000)
    expect(err.maxSelectedBytes).toBe(10_000)
  })

  // Regression: the streaming-path guard must accumulate the partial across
  // chunks. The earlier impl used Buffer.byteLength(chunk) for the no-newline
  // case, which under-counted: a 10 MB single line read in 512 KB chunks never
  // crossed a 3.2 MB cap (each chunk alone is under it), so the guard never
  // fired and the whole 10 MB was returned. The fix mirrors binary gXg's
  // `o = this.partialBytes + r` (carried-over partial bytes + chunk bytes).
  // File is >= 10 MB so it takes the STREAMING path (not the fast path).
  test('streaming path rejects a multi-chunk long line that crosses the cap', async () => {
    // Arrange — 10 MB single line (no newline), streaming path (size >= FAST_PATH_MAX_SIZE).
    // cap = 3.2 MB > 512 KB chunk, so NO single chunk exceeds the cap; only the
    // accumulated partial does. This is the case the prior impl missed.
    const dir = mkdtempSync(join(tmpdir(), 'read-stream-long-'))
    const filePath = join(dir, 'bigline.txt')
    // 10 * 1024 * 1024 = 10485760 bytes, exactly FAST_PATH_MAX_SIZE → streaming.
    const bigLine = 'B'.repeat(10 * 1024 * 1024)
    writeFileSync(filePath, bigLine) // no trailing newline

    // Act + Assert — the accumulated partial crosses 3.2 MB → throws.
    await expect(
      readFileInRange(filePath, 0, 100, undefined, undefined, {
        maxSelectedBytes: 25000 * 128, // 3.2 MB — the value FileReadTool passes
      }),
    ).rejects.toThrow(SelectedRangeTooLargeError)

    // Cleanup the 10 MB file so tmpdir doesn't bloat.
    rmSync(filePath, { force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test('streaming path does NOT throw when a long line fits within the cap', async () => {
    // Arrange — a 2 MB single line (streaming path, < 3.2 MB cap). Should
    // return the content, not throw. Guards the guard: the accumulation fix
    // must not over-fire for in-range, under-cap content.
    const dir = mkdtempSync(join(tmpdir(), 'read-stream-ok-'))
    const filePath = join(dir, 'midline.txt')
    // 2 MB single line, but pad past 10 MB total with newlines so the file
    // takes the streaming path while the selected range (first line) is small.
    const midLine = 'C'.repeat(2 * 1024 * 1024)
    const padding = '\n' + 'D'.repeat(8 * 1024 * 1024) // pushes file > 10 MB
    writeFileSync(filePath, midLine + padding)

    // Act — read just the first line (offset 0, limit 1).
    const result = await readFileInRange(filePath, 0, 1, undefined, undefined, {
      maxSelectedBytes: 25000 * 128, // 3.2 MB > 2 MB first line
    })

    // Assert — the 2 MB first line fits; returned, not rejected.
    expect(result.lineCount).toBeGreaterThanOrEqual(1)
    expect(result.content.length).toBeGreaterThan(1_000_000) // the 2 MB line

    rmSync(filePath, { force: true })
    rmSync(dir, { recursive: true, force: true })
  })
})
