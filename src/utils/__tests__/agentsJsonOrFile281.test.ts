/**
 * 2.1.281 PORT #112 tests: `--agents <json-or-file>` helpers —
 * isInlineAgentsJson shape-sniff (official oBt), readAgentsFile guarded read
 * (official qWr: Olt/Gko/Oct/zWn guards + dev/ino TOCTOU re-check + CRLF→LF),
 * validateAgentsJson (official Tvt: BOM strip, sanitized paths, dash-name
 * check, 20-line cap), and the exact official error strings.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, linkSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS_FILE_MAX_BYTES,
  AGENTS_FILE_PATH_REQUIRES_PRINT_ERROR,
  isInlineAgentsJson,
  readAgentsFile,
  validateAgentsJson,
} from '../agentsCliArg.js'

// NOTE: no mock.module('node:fs/promises') here — mocking the fs builtin
// deadlocks Bun's module loader. The TOCTOU branch is exercised through
// readAgentsFile's injectable reStat seam instead.

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-agents-cli-arg-281-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('2.1.281 #112: official error string constants', () => {
  test('the file-path-requires-print gate error is byte-exact (official VWr)', () => {
    expect(AGENTS_FILE_PATH_REQUIRES_PRINT_ERROR).toBe(
      'Error: --agents takes a JSON object, or a file path only with --print (-p). Pass the agents as inline JSON, or run with -p to read them from a file.',
    )
  })

  test('the size cap matches the official 256 MiB', () => {
    expect(AGENTS_FILE_MAX_BYTES).toBe(268435456)
  })
})

describe('2.1.281 #112: isInlineAgentsJson shape-sniff (official oBt)', () => {
  test('treats a value starting with { as inline JSON', () => {
    expect(isInlineAgentsJson('{"reviewer": {}}')).toBe(true)
  })

  test('ignores leading whitespace and BOM before the sniff', () => {
    expect(isInlineAgentsJson('  \n {"reviewer": {}}')).toBe(true)
    expect(isInlineAgentsJson('﻿{"reviewer": {}}')).toBe(true)
  })

  test('treats any parseable JSON as inline (validator rejects non-objects later)', () => {
    expect(isInlineAgentsJson('[1,2]')).toBe(true)
    expect(isInlineAgentsJson('null')).toBe(false) // parses to null → not inline
  })

  test('treats non-JSON values as file paths', () => {
    expect(isInlineAgentsJson('agents.json')).toBe(false)
    expect(isInlineAgentsJson('/path/to/my agents.json')).toBe(false)
    expect(isInlineAgentsJson('')).toBe(false)
  })
})

describe('2.1.281 #112: readAgentsFile guarded read (official qWr)', () => {
  test('reads a regular file and normalizes CRLF to LF', async () => {
    const filePath = join(tempDir, 'agents-ok.json')
    writeFileSync(filePath, '{"a": 1}\r\n')
    const result = await readAgentsFile(filePath)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.json).toBe('{"a": 1}\n')
    expect(result.filePath).toBe(filePath)
    expect(result.realPath.length).toBeGreaterThan(0)
  })

  test('missing file errors with the official not-found message', async () => {
    const filePath = join(tempDir, 'definitely-missing.json')
    const result = await readAgentsFile(filePath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      `Error: --agents file not found: ${filePath} (a value that is not a JSON object is read as a file path)`,
    )
  })

  test('directory errors through the default read-failure mapping', async () => {
    const result = await readAgentsFile(tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(`Error reading --agents file ${tempDir}: `)
  })

  test('hard-linked file errors with the official multiple-links message', async () => {
    const filePath = join(tempDir, 'agents-link-target.json')
    const linkPath = join(tempDir, 'agents-link-name.json')
    writeFileSync(filePath, '{}')
    linkSync(filePath, linkPath)
    const result = await readAgentsFile(linkPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      `Error: --agents file has more than one hard link: ${linkPath} (its other names are not write-protected; pass a file with one name)`,
    )
  })

  test('oversized file errors with the official too-large message', async () => {
    const filePath = join(tempDir, 'agents-huge.json')
    writeFileSync(filePath, '')
    // Sparse file — stat size exceeds the cap without allocating 256 MiB.
    truncateSync(filePath, AGENTS_FILE_MAX_BYTES + 1)
    const result = await readAgentsFile(filePath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      `Error: --agents file is larger than ${AGENTS_FILE_MAX_BYTES} bytes: ${filePath}`,
    )
  })

  test('dev/ino mismatch during the read window errors with the official changed message', async () => {
    const filePath = join(tempDir, 'agents-toctou.json')
    writeFileSync(filePath, '{}')
    // Injected reStat reports a different dev/ino than the opened handle —
    // exactly what a mid-read symlink swap or replace would produce.
    const result = await readAgentsFile(filePath, async () => ({
      dev: 999_999n,
      ino: 999_999n,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      `Error: --agents file changed while it was read: ${filePath}`,
    )
  })

  test('FIFO errors as not a regular file (best effort — skips without mkfifo)', async () => {
    const fifoPath = join(tempDir, 'agents-fifo')
    try {
      execFileSync('mkfifo', [fifoPath])
    } catch {
      // mkfifo unavailable in this environment — nothing to assert.
      return
    }
    const result = await readAgentsFile(fifoPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(
      'Not a regular file (device, FIFO, or socket)',
    )
  })
})

describe('2.1.281 #112: validateAgentsJson (official Tvt)', () => {
  const validAgent = { description: 'Reviews code', prompt: 'You review.' }

  test('returns null for a valid agents object', () => {
    expect(
      validateAgentsJson(JSON.stringify({ reviewer: validAgent })),
    ).toBeNull()
  })

  test('accepts an empty prompt (2.1.281 relaxation — official JW uses bare o())', () => {
    expect(
      validateAgentsJson(
        JSON.stringify({ reviewer: { description: 'd', prompt: '' } }),
      ),
    ).toBeNull()
  })

  test('still rejects an empty description', () => {
    const details = validateAgentsJson(
      JSON.stringify({ reviewer: { description: '', prompt: 'p' } }),
    )
    expect(details).not.toBeNull()
    expect(details).toContain('reviewer.description: ')
  })

  test('strips a leading BOM before parsing', () => {
    expect(
      validateAgentsJson(`﻿${JSON.stringify({ reviewer: validAgent })}`),
    ).toBeNull()
  })

  test('invalid JSON reports the sanitized parse error', () => {
    const details = validateAgentsJson('{not json')
    expect(details).not.toBeNull()
    expect(details!.startsWith('invalid JSON: ')).toBe(true)
  })

  test('schema issues are rendered as sanitized dotted paths', () => {
    const details = validateAgentsJson(
      JSON.stringify({ reviewer: { description: 5, prompt: 'p' } }),
    )
    expect(details).not.toBeNull()
    expect(details).toContain('reviewer.description: ')
  })

  test('agent names starting with a dash are rejected with the official message', () => {
    const details = validateAgentsJson(
      JSON.stringify({ '-x': validAgent }),
    )
    expect(details).toBe("-x: agent names must not start with '-'")
  })

  test('issue lines are capped at 20 with the official "…and N more" tail', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) {
      many[`agent${i}`] = {}
    }
    const details = validateAgentsJson(JSON.stringify(many))
    expect(details).not.toBeNull()
    const lines = details!.split('\n')
    expect(lines.length).toBe(21)
    expect(lines[20]).toMatch(/^…and \d+ more$/)
  })

  test('control characters in agent names are sanitized out of error text', () => {
    const details = validateAgentsJson(
      JSON.stringify({ '-x\u001b[31m': validAgent }),
    )
    expect(details).not.toBeNull()
    expect(details!.includes('\u001b')).toBe(false)
    expect(details).toContain("agent names must not start with '-'")
  })
})
