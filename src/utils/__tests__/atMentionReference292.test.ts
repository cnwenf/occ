import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  type AtMentionReferenceAttachment,
  generateFileAttachment,
} from '../attachments.js'
import { formatFileSize } from '../format.js'
import { normalizeAttachmentForAPI } from '../messages.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.292 (occ149 P5): official `cer.at_mention_reference` renderer
 * (@215812921) + generateFileAttachment wiring. Before 292 an @-mentioned
 * file exceeding the read size limit was silently dropped (`return null`);
 * 292 emits a lightweight reference attachment so the model is told (a) the
 * user @-mentioned the file, (b) why contents are absent, (c) to read it in
 * portions. All three official `unread` case texts are byte-faithful:
 *
 *   n = `The user @-mentioned ${e.mentions.map(Bd).join(", ")}`
 *   too_large:  `${n} (${en(e.fileSize)}). Its contents were not attached
 *     because the file is too large to read all at once, and a ${ct} call
 *     with no limit parameter will fail. Read it in portions with the offset
 *     and limit parameters, starting with a few hundred lines, or search for
 *     specific content instead of reading the whole file.`
 *   unexamined: `${n}. They could not be examined and were not attached:
 *     if these are files or directories in your working directory, read them
 *     with your file tools before responding.`
 *   undefined:  `${n}. File contents are not attached automatically in this
 *     session: if these are files or directories in your working directory,
 *     read them with your file tools before responding.`
 *
 * OCC mapping: en ≡ formatFileSize, ct ≡ FILE_READ_TOOL_NAME ('Read'),
 * Bd (display-path formatter) applied at creation time — `mentions` carries
 * display paths, matching the pdf_reference displayPath convention.
 */

function renderContent(att: AtMentionReferenceAttachment): string {
  const msgs = normalizeAttachmentForAPI(att)
  expect(msgs.length).toBeGreaterThanOrEqual(1)
  return msgs
    .map(m =>
      typeof m.message.content === 'string'
        ? m.message.content
        : JSON.stringify(m.message.content),
    )
    .join('\n')
}

describe('normalizeAttachmentForAPI at_mention_reference (CC 2.1.292 cer port)', () => {
  test('too_large: verbatim official text with human-readable size', () => {
    const content = renderContent({
      type: 'at_mention_reference',
      mentions: ['big.log'],
      unread: 'too_large',
      fileSize: 1234567,
    })
    expect(content).toContain(
      `The user @-mentioned big.log (${formatFileSize(1234567)}). ` +
        'Its contents were not attached because the file is too large to read all at once, ' +
        'and a Read call with no limit parameter will fail. ' +
        'Read it in portions with the offset and limit parameters, starting with a few hundred lines, ' +
        'or search for specific content instead of reading the whole file.',
    )
  })

  test('unexamined: verbatim official text', () => {
    const content = renderContent({
      type: 'at_mention_reference',
      mentions: ['a.ts', 'b.ts'],
      unread: 'unexamined',
    })
    expect(content).toContain(
      'The user @-mentioned a.ts, b.ts. They could not be examined and were not attached: ' +
        'if these are files or directories in your working directory, read them with your file tools before responding.',
    )
  })

  test('unread undefined: verbatim official session text', () => {
    const content = renderContent({
      type: 'at_mention_reference',
      mentions: ['notes.md'],
    })
    expect(content).toContain(
      'The user @-mentioned notes.md. File contents are not attached automatically in this session: ' +
        'if these are files or directories in your working directory, read them with your file tools before responding.',
    )
  })

  test('mentions are joined with ", " (official .join(", "))', () => {
    const content = renderContent({
      type: 'at_mention_reference',
      mentions: ['x', 'y', 'z'],
      unread: 'unexamined',
    })
    expect(content).toContain('The user @-mentioned x, y, z.')
  })

  test('rendered as a meta user message wrapped in a system-reminder', () => {
    const msgs = normalizeAttachmentForAPI({
      type: 'at_mention_reference',
      mentions: ['big.log'],
      unread: 'too_large',
      fileSize: 999,
    })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('user')
    expect(msgs[0].isMeta).toBe(true)
    expect(msgs[0].message.content).toContain('<system-reminder>')
  })
})

// ---------------------------------------------------------------------------
// generateFileAttachment: the too_large branch now returns the reference
// attachment instead of null.
// ---------------------------------------------------------------------------

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeToolUseContext(): ToolUseContext {
  return {
    options: { mcpClients: [], tools: [], mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext: makePermissionContext() }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-atmention292-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('generateFileAttachment too_large branch (CC 2.1.292 P5)', () => {
  test('oversized non-PDF @-mention returns at_mention_reference instead of null', async () => {
    const big = join(tmpDir, 'big.log')
    // Default maxSizeBytes is MAX_OUTPUT_SIZE = 0.25 MB — 300 KB exceeds it.
    const oversize = 300 * 1024
    writeFileSync(big, 'x'.repeat(oversize))

    const result = await generateFileAttachment(
      big,
      makeToolUseContext(),
      'tengu_test_success',
      'tengu_test_error',
      'at-mention',
    )

    expect(result).not.toBeNull()
    expect(result?.type).toBe('at_mention_reference')
    if (result?.type !== 'at_mention_reference') {
      throw new Error(`unexpected attachment type: ${result?.type}`)
    }
    expect(result.unread).toBe('too_large')
    expect(result.fileSize).toBe(oversize)
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].endsWith('big.log')).toBe(true)
  })

  test('within-limit @-mention does not produce a reference attachment', async () => {
    const small = join(tmpDir, 'small.txt')
    writeFileSync(small, 'hello world')

    const result = await generateFileAttachment(
      small,
      makeToolUseContext(),
      'tengu_test_success',
      'tengu_test_error',
      'at-mention',
    )

    // Small file → normal FileAttachment (content inlined), never the
    // at_mention_reference fallback.
    expect(result?.type).not.toBe('at_mention_reference')
    expect(result?.type).toBe('file')
  })
})
