import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { processAtMentionedFilesForTesting } from '../attachments.js'
import { isFileMentionsDisabled } from '../envUtils.js'
import { normalizeAttachmentForAPI } from '../messages.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.299 (#001): `CLAUDE_CODE_DISABLE_FILE_MENTIONS` — official resolver
 * gate (@227272610 in /tmp/cc-diff-299/v299/package/claude):
 *   `Ydn()||a.CLAUDE_CODE_DISABLE_FILE_MENTIONS ? TGr(e,n) : RGr(e,be,…)`
 * When set, @-mentioned files are NOT read; they resolve to a single
 * `at_mention_reference` attachment carrying the mention paths (v296 `mLr`
 * shape — no `unread`, so the renderer's default case applies: "File
 * contents are not attached automatically in this session…"). Unset/falsy →
 * unchanged content-fetch behavior (`RGr` ≡ OCC's per-file resolution).
 */

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
let targetFile: string
const savedEnv = process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-disable-file-mentions-299-'))
  targetFile = join(tmpDir, 'notes.txt')
  writeFileSync(targetFile, 'secret mention contents')
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS
  } else {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = savedEnv
  }
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('isFileMentionsDisabled (CC 2.1.299 #001 env gate)', () => {
  test('unset → false', () => {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS
    expect(isFileMentionsDisabled()).toBe(false)
  })

  test('truthy values → true; falsy → false', () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1'
    expect(isFileMentionsDisabled()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = 'true'
    expect(isFileMentionsDisabled()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '0'
    expect(isFileMentionsDisabled()).toBe(false)
  })
})

describe('processAtMentionedFiles with CLAUDE_CODE_DISABLE_FILE_MENTIONS (CC 2.1.299 #001)', () => {
  test('env set → single at_mention_reference with paths, no file read', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1'
    const result = await processAtMentionedFilesForTesting(
      `look at @${targetFile} please`,
      makeToolUseContext(),
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('at_mention_reference')
    if (result[0]?.type !== 'at_mention_reference') {
      throw new Error(`unexpected attachment type: ${result[0]?.type}`)
    }
    expect(result[0].mentions).toHaveLength(1)
    expect(result[0].mentions[0]?.endsWith('notes.txt')).toBe(true)
    // No `unread` discriminant → renderer default case (v296 `mLr` shape).
    expect(result[0].unread).toBeUndefined()
    // Contents never attached.
    const rendered = normalizeAttachmentForAPI(result[0])
      .map(m =>
        typeof m.message.content === 'string'
          ? m.message.content
          : JSON.stringify(m.message.content),
      )
      .join('\n')
    expect(rendered).toContain('The user @-mentioned')
    expect(rendered).toContain(
      'File contents are not attached automatically in this session',
    )
    expect(rendered).not.toContain('secret mention contents')
  })

  test('env set → line-range fragment is stripped from the reference path', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1'
    const result = await processAtMentionedFilesForTesting(
      `@${targetFile}#L1-2`,
      makeToolUseContext(),
    )
    expect(result).toHaveLength(1)
    if (result[0]?.type !== 'at_mention_reference') {
      throw new Error(`unexpected attachment type: ${result[0]?.type}`)
    }
    expect(result[0].mentions[0]).not.toContain('#L1-2')
    expect(result[0].mentions[0]?.endsWith('notes.txt')).toBe(true)
  })

  test('env set → no mentions → empty result', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1'
    const result = await processAtMentionedFilesForTesting(
      'no mentions here',
      makeToolUseContext(),
    )
    expect(result).toEqual([])
  })

  test('env unset → unchanged content-fetch behavior', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS
    const result = await processAtMentionedFilesForTesting(
      `look at @${targetFile} please`,
      makeToolUseContext(),
    )
    expect(result).toHaveLength(1)
    // Normal path attaches the file (or an already_read/file variant) — the
    // key assertion is that it is NOT the paths-only reference block.
    expect(result[0]?.type).not.toBe('at_mention_reference')
  })

  test('env falsy ("0") → unchanged content-fetch behavior', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '0'
    const result = await processAtMentionedFilesForTesting(
      `look at @${targetFile} please`,
      makeToolUseContext(),
    )
    expect(result[0]?.type).not.toBe('at_mention_reference')
  })
})
