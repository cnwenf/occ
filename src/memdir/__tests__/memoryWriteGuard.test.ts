import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  checkMemoryEntrypointOverCap,
  getMemoryIndexOverCapMessage,
  measureMemoryIndexContent,
  stripNonLoadedContent,
} from '../memdir.js'
import { getAutoMemPath } from '../paths.js'

/**
 * claude-code 2.1.210 #29: Memory writes that leave a MEMORY.md index over its
 * read limit now produce an explicit error instead of silent truncation.
 *
 * The official binary surfaces this as a PostToolUse `additionalContext` hook
 * output after a Write/Edit lands on MEMORY.md. The write itself SUCCEEDS —
 * the message tells the model to compact the index. The exact text (from the
 * 2.1.210 binary's `meo` function) is asserted verbatim here.
 *
 * Constants (from binary): line cap Pee=200, byte cap Eme=25000, approaching
 * threshold Sxg=0.8, target fraction KEu=0.7, read-cap z5n=4*Eme=100000.
 */

describe('2.1.210 #29 getMemoryIndexOverCapMessage (pure guard)', () => {
  test('over the BYTE cap → returns Error text with overCap=true', () => {
    // 30000 bytes, 1 line. byte frac = 30000/25000 = 1.2 (worst).
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 30000,
      byteCap: MAX_ENTRYPOINT_BYTES,
      lineCount: 1,
      lineCap: MAX_ENTRYPOINT_LINES,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.overCap).toBe(true)
    // formatFileSize(30000) = 29.3KB; formatFileSize(25000) = 24.4KB;
    // Math.floor(25000*0.7) = 17500 → formatFileSize = 17.1KB
    expect(result.text).toBe(
      'Error: this write left the memory index at MEMORY.md at 29.3KB, over its 24.4KB read limit. The write succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end are already invisible to readers. Rewrite it to under 17.1KB now: keep one line per entry, move detail into topic files, and merge or drop stale entries.',
    )
  })

  test('over the LINE cap → returns Error text using the line dimension', () => {
    // 201 lines, tiny bytes. line frac = 201/200 = 1.005 (worst).
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 50,
      byteCap: MAX_ENTRYPOINT_BYTES,
      lineCount: 201,
      lineCap: MAX_ENTRYPOINT_LINES,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.overCap).toBe(true)
    // sizeDesc "201 lines"; capDesc "200-line"; target 140 lines
    expect(result.text).toBe(
      'Error: this write left the memory index at MEMORY.md at 201 lines, over its 200-line read limit. The write succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end are already invisible to readers. Rewrite it to under 140 lines now: keep one line per entry, move detail into topic files, and merge or drop stale entries.',
    )
  })

  test('approaching the cap (0.8 <= frac < 1.0) → warning text, overCap=false', () => {
    // 21000 bytes → frac 0.84. byte dimension worst.
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 21000,
      byteCap: MAX_ENTRYPOINT_BYTES,
      lineCount: 10,
      lineCap: MAX_ENTRYPOINT_LINES,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.overCap).toBe(false)
    // formatFileSize(21000) = 20.5KB
    expect(result.text).toBe(
      'The memory index at MEMORY.md is 20.5KB, approaching the 24.4KB read limit. Compact it to under 17.1KB now: keep one line per entry, move detail into topic files, and merge or drop stale entries.',
    )
  })

  test('exactly at the 0.8 threshold → still returns a message (frac < 0.8 is null)', () => {
    // 20000 bytes → frac = 0.8 exactly. 0.8 < 0.8 is false → not null.
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 20000,
      byteCap: MAX_ENTRYPOINT_BYTES,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.overCap).toBe(false)
    expect(result.text).toContain('approaching the 24.4KB read limit')
  })

  test('under the 0.8 threshold → returns null (no warning)', () => {
    // 19000 bytes → frac 0.76 < 0.8 → null
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 19000,
      byteCap: MAX_ENTRYPOINT_BYTES,
    })
    expect(result).toBeNull()
  })

  test('picks the worst dimension when bytes are fine but lines are over', () => {
    // bytes well under cap, but line count over → line dimension wins.
    const result = getMemoryIndexOverCapMessage({
      label: 'memory index',
      displayPath: 'MEMORY.md',
      sizeBytes: 1000,
      byteCap: MAX_ENTRYPOINT_BYTES,
      lineCount: 250,
      lineCap: MAX_ENTRYPOINT_LINES,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.overCap).toBe(true)
    expect(result.text).toContain('at 250 lines, over its 200-line read limit')
  })
})

describe('2.1.210 #29 measureMemoryIndexContent (bVt parity)', () => {
  test('empty content → byteCount 0, lineCount 1 (matches bVt: Wu+1)', () => {
    const m = measureMemoryIndexContent('   \n  ')
    expect(m.byteCount).toBe(0)
    // trim() → "" ; Wu("","\n")=0; +1 → 1
    expect(m.lineCount).toBe(1)
  })

  test('single line, no newline → lineCount 1', () => {
    const m = measureMemoryIndexContent('hello')
    expect(m.byteCount).toBe(5)
    expect(m.lineCount).toBe(1)
  })

  test('three lines → lineCount 3 (newline count + 1)', () => {
    const m = measureMemoryIndexContent('a\nb\nc')
    expect(m.byteCount).toBe(5)
    expect(m.lineCount).toBe(3)
  })

  test('trims leading/trailing whitespace before measuring', () => {
    const m = measureMemoryIndexContent('\n\na\nb\n\n')
    // trimmed = "a\nb" → length 3, newlines 1 → +1 = 2
    expect(m.byteCount).toBe(3)
    expect(m.lineCount).toBe(2)
  })
})

describe('2.1.210 #29 checkMemoryEntrypointOverCap (post-write guard)', () => {
  // Drive the real filesystem via the CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env
  // override so getAutoMemPath()/isAutoMemPath() resolve to a temp dir without
  // touching the user's real ~/.claude. The memoize cache is cleared per test.
  let tmpDir: string

  function setup(): string {
    // Ensure auto-memory is enabled for the test (no disabling env vars).
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CLAUDE_CODE_REMOTE
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-memguard-'))
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = tmpDir
    getAutoMemPath.cache.clear?.()
    return tmpDir
  }

  function teardown(): void {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    getAutoMemPath.cache.clear?.()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  test('over the LINE cap (201 lines) → overCap=true, Error text surfaces', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      // 201 short lines → lineCount 201 > 200 (line dimension wins).
      const content = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).not.toBeNull()
      if (result === null) return
      expect(result.overCap).toBe(true)
      expect(result.text).toBe(
        'Error: this write left the memory index at MEMORY.md at 201 lines, over its 200-line read limit. The write succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end are already invisible to readers. Rewrite it to under 140 lines now: keep one line per entry, move detail into topic files, and merge or drop stale entries.',
      )
    } finally {
      teardown()
    }
  })

  test('over the BYTE cap (30000 bytes) → overCap=true, Error text surfaces', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      // One long line of 30000 bytes → byteCount 30000 > 25000.
      writeFileSync(entry, 'x'.repeat(30000), 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).not.toBeNull()
      if (result === null) return
      expect(result.overCap).toBe(true)
      expect(result.text).toBe(
        'Error: this write left the memory index at MEMORY.md at 29.3KB, over its 24.4KB read limit. The write succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end are already invisible to readers. Rewrite it to under 17.1KB now: keep one line per entry, move detail into topic files, and merge or drop stale entries.',
      )
    } finally {
      teardown()
    }
  })

  test('under the limit → null (write succeeds silently, no error)', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      // 10 short lines, ~100 bytes — well under both caps and the 0.8 threshold.
      const content = Array.from({ length: 10 }, (_, i) => `- item ${i}`).join('\n')
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).toBeNull()
    } finally {
      teardown()
    }
  })

  test('non-MEMORY.md file in the memory dir → null (guard only fires on the index)', async () => {
    setup()
    try {
      const other = join(tmpDir, 'user_role.md')
      // Huge content, but it's a topic file, not the MEMORY.md index.
      writeFileSync(other, 'x'.repeat(30000), 'utf8')

      const result = await checkMemoryEntrypointOverCap(other)
      expect(result).toBeNull()
    } finally {
      teardown()
    }
  })

  test('MEMORY.md that does not exist → null (no crash)', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).toBeNull()
    } finally {
      teardown()
    }
  })
})

/**
 * claude-code 2.1.211: The memory index over-limit warning now measures only
 * LOADED content — frontmatter (---\n...\n---) and HTML comments (<!--...-->)
 * are stripped before measuring, matching the binary's
 * `lwt(vXc(Zm(content).content).content)` refinement.
 *
 * Before the fix, `measureMemoryIndexContent` counted ALL bytes/lines including
 * frontmatter + HTML comments, causing false over-cap warnings when non-loaded
 * content pushed the total over the limit while the actual loaded content was
 * well under it.
 */
describe('2.1.211 stripNonLoadedContent (frontmatter + HTML comment stripping)', () => {
  test('strips a frontmatter block from the start of content', () => {
    const raw = '---\nname: test\ndescription: stuff\n---\nreal content here'
    const stripped = stripNonLoadedContent(raw)
    expect(stripped).toBe('real content here')
  })

  test('strips HTML comments (single line)', () => {
    const raw = '<!-- this is a comment -->\nreal content'
    const stripped = stripNonLoadedContent(raw)
    // The marked Lexer treats the comment + trailing newline as one HTML
    // block, so the newline is absorbed into the stripped token.
    expect(stripped).toBe('real content')
  })

  test('strips HTML comments (multi-line)', () => {
    const raw = '<!-- multi\nline\ncomment -->\nreal content'
    const stripped = stripNonLoadedContent(raw)
    expect(stripped).toBe('real content')
  })

  test('strips both frontmatter and HTML comments', () => {
    const raw =
      '---\nname: index\n---\n<!-- comment 1 -->\n<!-- comment 2 -->\nreal line'
    const stripped = stripNonLoadedContent(raw)
    expect(stripped).toBe('real line')
  })

  test('content with no frontmatter and no HTML comments → unchanged', () => {
    const raw = '- [item](file.md) — hook\n- [item2](file2.md) — hook2'
    const stripped = stripNonLoadedContent(raw)
    expect(stripped).toBe(raw)
  })

  test('empty content → empty string', () => {
    expect(stripNonLoadedContent('')).toBe('')
  })

  test('frontmatter only (no real content) → empty', () => {
    const raw = '---\nname: test\n---\n'
    const stripped = stripNonLoadedContent(raw)
    expect(stripped).toBe('')
  })
})

describe('2.1.211 checkMemoryEntrypointOverCap — measures only loaded content', () => {
  let tmpDir: string

  function setup(): string {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CLAUDE_CODE_REMOTE
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-memguard-211-'))
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = tmpDir
    getAutoMemPath.cache.clear?.()
    return tmpDir
  }

  function teardown(): void {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    getAutoMemPath.cache.clear?.()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  test('TOTAL over byte cap but LOADED content under 0.8 threshold → null (no false warn)', async () => {
    // BEFORE FIX (2.1.210 measurement): total > 25000 → overCap=true (false positive).
    // AFTER FIX (2.1.211 measurement): stripped content ~30 bytes → null.
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      const frontmatter = '---\nname: test-index\ndescription: test\n---\n'
      const htmlComment1 = `<!-- ${'x'.repeat(15000)} -->\n`
      const htmlComment2 = `<!-- ${'x'.repeat(15000)} -->\n`
      const realContent = '- [item](file.md) — hook\n'
      const content = frontmatter + htmlComment1 + htmlComment2 + realContent
      // Total > 30000 bytes → over the 25000 byte cap.
      // Stripped (frontmatter + HTML comments removed) ~30 bytes → null.
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).toBeNull()
    } finally {
      teardown()
    }
  })

  test('TOTAL approaching byte cap but LOADED content well under → null', async () => {
    // BEFORE FIX: total ~21000 → 0.84 > 0.8 → approaching warning (false positive).
    // AFTER FIX: stripped ~500 bytes → null.
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      const frontmatter = '---\nname: test\n---\n'
      const htmlComment = `<!-- ${'x'.repeat(20000)} -->\n`
      const realContent = '- [item](file.md) — hook\n'
      const content = frontmatter + htmlComment + realContent
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).toBeNull()
    } finally {
      teardown()
    }
  })

  test('LOADED content over byte cap → still warns (stripping does not suppress real warnings)', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      const frontmatter = '---\nname: test\n---\n'
      const htmlComment = '<!-- small comment -->\n'
      // Real content alone exceeds the 25000 byte cap.
      const realContent = 'x'.repeat(26000)
      const content = frontmatter + htmlComment + realContent
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).not.toBeNull()
      if (result === null) return
      expect(result.overCap).toBe(true)
      expect(result.text).toContain('over its 24.4KB read limit')
    } finally {
      teardown()
    }
  })

  test('LOADED content approaching byte cap → still warns', async () => {
    setup()
    try {
      const entry = join(tmpDir, 'MEMORY.md')
      const frontmatter = '---\nname: test\n---\n'
      const htmlComment = '<!-- comment -->\n'
      // Real content alone is approaching the cap (21000/25000 = 0.84 > 0.8).
      const realContent = 'x'.repeat(21000)
      const content = frontmatter + htmlComment + realContent
      writeFileSync(entry, content, 'utf8')

      const result = await checkMemoryEntrypointOverCap(entry)
      expect(result).not.toBeNull()
      if (result === null) return
      expect(result.overCap).toBe(false)
      expect(result.text).toContain('approaching the 24.4KB read limit')
    } finally {
      teardown()
    }
  })
})
