import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getStdoutWithGitTail } from '../gitOperationTracking.js'

// 2.1.205 #8: when `gh pr create` output exceeds the ~30K inline limit,
// result.stdout is truncated and the PR URL (printed at the END) is lost.
// The fix appends the last 8192 bytes of the output file so the URL is
// scanned. Mirrors the binary's `_zn(stdout, outputFilePath)` helper.
describe('2.1.205 #8 getStdoutWithGitTail', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-git-tail-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('no outputFilePath → returns stdout unchanged', async () => {
    const stdout = 'gh pr create ran'
    expect(await getStdoutWithGitTail(stdout)).toBe(stdout)
    expect(await getStdoutWithGitTail(stdout, undefined)).toBe(stdout)
    expect(await getStdoutWithGitTail(stdout, '')).toBe(stdout)
  })

  test('PR URL in output-file tail (beyond inline limit) is included in result', async () => {
    // Simulate a large `gh pr create` output: 40K of body text + the PR URL
    // printed at the very end (gh prints the URL last).
    const PR_URL = 'https://github.com/acme/widgets/pull/42'
    const body = 'x'.repeat(40_000)
    const fileContent = `${body}\n${PR_URL}\n`
    const filePath = join(tmpDir, 'out.txt')
    await writeFile(filePath, fileContent)

    // Truncated stdout (first 30K) does NOT contain the URL.
    const truncatedStdout = body.slice(0, 30_000)
    expect(truncatedStdout.includes(PR_URL)).toBe(false)

    // After appending the tail, the URL is present.
    const result = await getStdoutWithGitTail(truncatedStdout, filePath)
    expect(result.includes(PR_URL)).toBe(true)
    // Tail = last 8K of the file = trailing slice of body + "\n" + URL + "\n".
    expect(result.startsWith(truncatedStdout)).toBe(true)
    expect(result.endsWith(`${PR_URL}\n`)).toBe(true)
  })

  test('small file (< 8K) → whole file content appended', async () => {
    const PR_URL = 'https://github.com/foo/bar/pull/7'
    const fileContent = `some output\n${PR_URL}\n`
    const filePath = join(tmpDir, 'small.txt')
    await writeFile(filePath, fileContent)

    const result = await getStdoutWithGitTail('prefix', filePath)
    expect(result).toBe(`prefix\n${fileContent}`)
    expect(result.includes(PR_URL)).toBe(true)
  })

  test('empty output file → returns stdout unchanged', async () => {
    const filePath = join(tmpDir, 'empty.txt')
    await writeFile(filePath, '')
    const stdout = 'no PR here'
    expect(await getStdoutWithGitTail(stdout, filePath)).toBe(stdout)
  })

  test('non-existent outputFilePath → returns stdout (no throw)', async () => {
    const stdout = 'gh pr create ran'
    const result = await getStdoutWithGitTail(
      stdout,
      join(tmpDir, 'does-not-exist.txt'),
    )
    expect(result).toBe(stdout)
  })

  test('PR URL exactly at 8K-from-end boundary is captured', async () => {
    // Tail reads last 8192 bytes. Place the URL near the start of that tail.
    const PR_URL = 'https://github.com/acme/repo/pull/99'
    const tail = 'y'.repeat(8000) + `\n${PR_URL}\n` // ~8K + URL
    const head = 'z'.repeat(50_000)
    const filePath = join(tmpDir, 'boundary.txt')
    await writeFile(filePath, head + tail)

    const result = await getStdoutWithGitTail('head', filePath)
    expect(result.includes(PR_URL)).toBe(true)
  })

  test('PR URL beyond the 8K tail window is NOT captured (tail window limit)', async () => {
    // PR URL sits 10K from end — outside the 8K tail window.
    const PR_URL = 'https://github.com/acme/repo/pull/100'
    const afterUrl = 'w'.repeat(10_000)
    const fileContent = `stuff\n${PR_URL}\n${afterUrl}`
    const filePath = join(tmpDir, 'beyond.txt')
    await writeFile(filePath, fileContent)

    const result = await getStdoutWithGitTail('head', filePath)
    expect(result.includes(PR_URL)).toBe(false)
  })
})
