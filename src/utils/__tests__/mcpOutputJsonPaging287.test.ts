import { describe, expect, test } from 'bun:test'
import { getDefaultFileReadingLimits } from '../../tools/FileReadTool/limits.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import {
  computePersistedLineStats,
  getLargeOutputInstructions,
} from '../mcpOutputStorage.js'

/**
 * CC 2.1.287 #29 — "Fixed Claude being told to page large MCP results saved as
 * JSON with Read's offset and limit, which cannot split one long line."
 *
 * Byte forensics (v287 linux-x64 ELF, primary embedded JS copy):
 *
 * - Guidance builder `vsn` (v287) @207465427 / `ltn` (v286) @205457212.
 *   v287 adds the line-shape parameter `g={count,maxLen}` and three branches:
 *     `g===void 0`  → JSON note + jq probe (NO offset/limit recommendation)
 *     `!K`          → char-range slicing note (lines too long)
 *     `K`           → the classic offset/limit text (many short lines)
 *   with `j=Math.floor(OQ().maxTokens*4*0.8)` and `K=g!==void 0&&g.count>1&&g.maxLen<=j`.
 * - Requirements builder `mio(e,n,r)` — `r` (the shape note) sits between the
 *   "read … in sequential chunks" bullet and the truncation-warning bullet.
 * - Argv quoter `XK` (aliased `Ur` in the MCP module): safe-charset passthrough,
 *   otherwise `'…'` with `'` escaped as `'"'"'`.
 * - Caller gate: stats are computed only when the result was persisted as plain
 *   text (`ie = type==="toolResult" || unwrappedSingletonText!==undefined`);
 *   JSON-persisted results pass `g===undefined`.
 *
 * Helper mapping (official minified → OCC):
 *   OQ().maxTokens → getDefaultFileReadingLimits().maxTokens (default 25000)
 *   dt             → FILE_READ_TOOL_NAME ('Read')
 *   Ur([e])        → quoteArgvForShell([path]) (byte-exact `XK` port, private)
 *   mio(e,s,Ae)    → buildSummarizationRequirements(path, maxReadLength, note)
 *   s (4th param)  → maxReadLength (unchanged)
 *
 * Only the legacy `!QMt()` variant is ported — the `QMt()` subagent-routing
 * variant needs the `tengu_mcp_subagent_prompt` flag OCC does not have.
 */

// Official `j = Math.floor(OQ().maxTokens * 4 * 0.8)`.
const MAX_CHUNK_CHARS = Math.floor(
  getDefaultFileReadingLimits().maxTokens * 4 * 0.8,
)

const PATH = '/home/u/.claude/projects/p/tool-results/mcp-srv-search-1.json'

const OFFSET_LIMIT_TEXT =
  'Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n'

describe('CC 2.1.287 #29 getLargeOutputInstructions — legacy header', () => {
  test('header is byte-identical to the pre-287 text when lineStats is omitted', () => {
    const out = getLargeOutputInstructions(PATH, 1234567, 'JSON')

    expect(out.startsWith(
      `Error: result (1,234,567 characters) exceeds maximum allowed tokens. Output has been saved to ${PATH}.\n` +
        'Format: JSON\n',
    )).toBe(true)
    expect(out).not.toContain('characters across')
  })

  test('header gains the line-count phrasing only when lineStats is defined', () => {
    const out = getLargeOutputInstructions(PATH, 200000, 'Plain text', undefined, {
      count: 1000,
      maxLen: 200,
    })

    expect(out.startsWith(
      `Error: result (200,000 characters across 1,000 lines) exceeds maximum allowed tokens. Output has been saved to ${PATH}.\n` +
        'Format: Plain text\n',
    )).toBe(true)
  })

  test('singular "line" is used when count === 1', () => {
    const out = getLargeOutputInstructions(PATH, 900000, 'Plain text', undefined, {
      count: 1,
      maxLen: 900000,
    })

    expect(out).toContain('(900,000 characters across 1 line) exceeds')
    expect(out).not.toContain('1 lines')
  })
})

describe('CC 2.1.287 #29 — branch 1: lineStats undefined (JSON / unmeasured)', () => {
  test('emits the full official legacy JSON guidance verbatim', () => {
    const path = '/tmp/x.json'
    const out = getLargeOutputInstructions(path, 1234567, 'JSON')

    expect(out).toBe(
      `Error: result (1,234,567 characters) exceeds maximum allowed tokens. Output has been saved to ${path}.\n` +
        'Format: JSON\n' +
        'Use jq to make structured queries (find a value, filter by field).\n' +
        'REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n' +
        `- You MUST read the content from the file at ${path} in sequential chunks until 100% of the content has been read.\n` +
        `- Note: this file is JSON, so a long value (or the whole file) is a single line. ${FILE_READ_TOOL_NAME}'s offset/limit cannot split a line, so reading in chunks works only if every line is short. If a shell tool is available, first probe the structure (e.g., jq 'type, length, keys?' ${path}), then extract slices with jq or python.\n` +
        '- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n' +
        '- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n',
    )
  })

  test('never recommends Read offset/limit paging (the 2.1.287 bug)', () => {
    const out = getLargeOutputInstructions(PATH, 1234567, 'JSON')

    expect(out).not.toContain(OFFSET_LIMIT_TEXT)
    expect(out).not.toContain('Use offset and limit parameters')
    expect(out).toContain(
      `offset/limit cannot split a line, so reading in chunks works only if every line is short`,
    )
  })

  test('quotes a path that is not shell-safe in the jq probe hint', () => {
    const spaced = '/tmp/my project/out file.json'
    const out = getLargeOutputInstructions(spaced, 10, 'JSON')

    expect(out).toContain(
      `jq 'type, length, keys?' '${spaced}'), then extract slices with jq or python`,
    )

    const quoted = "/tmp/it's/out.json"
    const out2 = getLargeOutputInstructions(quoted, 10, 'JSON')
    // Official XK: `'` → `'"'"'`
    expect(out2).toContain(`jq 'type, length, keys?' '/tmp/it'"'"'s/out.json')`)
  })
})

describe('CC 2.1.287 #29 — branch 2: !K (lines too long)', () => {
  test('single huge line → char-range slicing guidance', () => {
    const out = getLargeOutputInstructions(PATH, 900000, 'Plain text', undefined, {
      count: 1,
      maxLen: 900000,
    })

    expect(out).toContain(
      'Search within the file for specific content, and use jq if the content is JSON.\n',
    )
    expect(out).toContain(
      `- Note: this file's lines are too long for ${FILE_READ_TOOL_NAME}'s offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.\n`,
    )
    expect(out).not.toContain('Use offset and limit parameters')
    expect(out).not.toContain('this file is JSON')
  })

  test('count === 1 with a short line still takes the !K branch (official requires count > 1)', () => {
    const out = getLargeOutputInstructions(PATH, 40, 'Plain text', undefined, {
      count: 1,
      maxLen: 40,
    })

    expect(out).toContain("this file's lines are too long for")
    expect(out).not.toContain('Use offset and limit parameters')
  })

  test('many lines whose maxLen is one char over the threshold takes the !K branch', () => {
    const out = getLargeOutputInstructions(PATH, 900000, 'Plain text', undefined, {
      count: 12,
      maxLen: MAX_CHUNK_CHARS + 1,
    })

    expect(out).toContain('slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.')
  })
})

describe('CC 2.1.287 #29 — branch 3: K (many short lines)', () => {
  test('keeps the existing offset/limit text and adds no shape note', () => {
    const out = getLargeOutputInstructions(PATH, 200000, 'Plain text', undefined, {
      count: 1000,
      maxLen: 200,
    })

    expect(out).toContain(OFFSET_LIMIT_TEXT)
    expect(out).not.toContain('- Note: this file')
    expect(out).not.toContain('slice by character range')
  })

  test('maxLen exactly at the threshold still chunks (K uses <=)', () => {
    const out = getLargeOutputInstructions(PATH, 200000, 'Plain text', undefined, {
      count: 2,
      maxLen: MAX_CHUNK_CHARS,
    })

    expect(out).toContain(OFFSET_LIMIT_TEXT)
    expect(out).not.toContain('- Note: this file')
  })
})

describe('CC 2.1.287 #29 — mio composition and truncation note', () => {
  test('the shape note sits between the read bullet and the truncation bullet', () => {
    const out = getLargeOutputInstructions(PATH, 1234567, 'JSON')

    const readBullet = out.indexOf(
      '- You MUST read the content from the file at',
    )
    const note = out.indexOf('- Note: this file is JSON')
    const truncation = out.indexOf('- If you receive truncation warnings')
    const completion = out.indexOf('- Before producing ANY summary or analysis')
    const requirements = out.indexOf(
      'REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n',
    )
    const strategy = out.indexOf(
      'Use jq to make structured queries (find a value, filter by field).\n',
    )

    expect(requirements).toBeGreaterThan(0)
    expect(strategy).toBeGreaterThan(0)
    expect(strategy).toBeLessThan(requirements)
    expect(readBullet).toBeGreaterThan(requirements)
    expect(note).toBeGreaterThan(readBullet)
    expect(truncation).toBeGreaterThan(note)
    expect(completion).toBeGreaterThan(truncation)
  })

  test('maxReadLength still renders the Bash-limit truncation bullet in every branch', () => {
    const expected =
      '- If you receive truncation warnings when reading the file ("[N lines truncated]"), reduce the chunk size until you have read 100% of the content without truncation ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***. Bash output is limited to 25,000 chars.\n'

    const jsonBranch = getLargeOutputInstructions(PATH, 100, 'JSON', 25000)
    const longLineBranch = getLargeOutputInstructions(
      PATH,
      100,
      'Plain text',
      25000,
      { count: 1, maxLen: MAX_CHUNK_CHARS + 1 },
    )
    const chunkableBranch = getLargeOutputInstructions(
      PATH,
      100,
      'Plain text',
      25000,
      { count: 500, maxLen: 100 },
    )

    expect(jsonBranch).toContain(expected)
    expect(longLineBranch).toContain(expected)
    expect(chunkableBranch).toContain(expected)
  })

  test('maxReadLength omitted keeps the short truncation bullet', () => {
    const out = getLargeOutputInstructions(PATH, 100, 'JSON')

    expect(out).toContain(
      '- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n',
    )
    expect(out).not.toContain('Bash output is limited to')
  })
})

describe('CC 2.1.287 #29 computePersistedLineStats (official caller logic)', () => {
  test('drops a single trailing newline so it does not count a phantom line', () => {
    expect(computePersistedLineStats('a\nbb\nccc\n')).toEqual({
      count: 3,
      maxLen: 3,
    })
  })

  test('single line without trailing newline', () => {
    expect(computePersistedLineStats('{"a":1}')).toEqual({ count: 1, maxLen: 7 })
  })

  test('keeps interior empty lines', () => {
    expect(computePersistedLineStats('a\n\n')).toEqual({ count: 2, maxLen: 1 })
  })

  test('empty content is one empty line', () => {
    expect(computePersistedLineStats('')).toEqual({ count: 1, maxLen: 0 })
  })

  test('maxLen is the longest line, single pass over the content', () => {
    const content = `${'x'.repeat(50)}\nshort\n${'y'.repeat(MAX_CHUNK_CHARS + 1)}`
    const stats = computePersistedLineStats(content)

    expect(stats.count).toBe(3)
    expect(stats.maxLen).toBe(MAX_CHUNK_CHARS + 1)
    // …and such a file takes the !K branch.
    const out = getLargeOutputInstructions(
      PATH,
      content.length,
      'Plain text',
      undefined,
      stats,
    )
    expect(out).toContain("this file's lines are too long for")
  })
})
