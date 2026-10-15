/**
 * CC 2.1.299 #126 — FileReadTool encoding behavior:
 *
 * 1. UTF-16LE+BOM files decode CORRECTLY on the fast path (official
 *    @222155100: `let P=await R.readFile({signal:h}); let{encoding:F,notText:G}
 *    =Rgt(P); ...P.toString(F)...` — previously OCC hardcoded utf8 and
 *    garbled the content).
 * 2. notText files are NOT refused by Read — the official attaches the nHs
 *    notice instead (@227180400: `if(rt.notText!==void 0)BTn.set(fo,nHs(rt.notText))`),
 *    APPENDED after the content via the fWr joiner (@227168072:
 *    `[BTn.get(e),$Tn.get(e)].filter(...).map(n=>`\n\n${n}`).join("")`).
 * 3. The not_utf8 notice carries the extra "Its undecodable bytes show above
 *    as U+FFFD." sentence; nul/utf16be do not.
 * 4. Clean UTF-8 reads carry no notice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReadTool } from '../FileReadTool.js'
import { stashCheckTimeResolutions } from '../../../utils/permissions/symlinkResolutionStash.js'
import { fileNotTextReadNotice } from '../../../utils/permissions/fileStateGuard.js'

let tmpDir: string
let savedSimpleEnv: string | undefined
let toolUseCounter = 0

beforeAll(async () => {
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  // Skip skill discovery in the read path (no network/fs scans).
  process.env.CLAUDE_CODE_SIMPLE = '1'
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-read-126-'))
})

afterAll(async () => {
  if (savedSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  toolUseCounter += 1
})

function makeContext() {
  return {
    toolUseId: `toolu_read126_${toolUseCounter}`,
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
  }
}

async function readAndMap(filePath: string): Promise<{
  data: { type: string; file?: { content: string } }
  mapped: string
}> {
  const context = makeContext()
  // TOCTOU gate: checkPermissions stashes resolutions before call() asserts
  // they are unchanged (CC 2.1.251).
  stashCheckTimeResolutions(context as never, filePath, 'read')
  const result = await FileReadTool.call(
    { file_path: filePath } as never,
    context as never,
  )
  const data = (result as { data: never }).data
  const block = FileReadTool.mapToolResultToToolResultBlockParam(
    data as never,
    context.toolUseId,
  ) as { content: string }
  return { data: data as never, mapped: block.content }
}

describe('CC 2.1.299 #126: FileReadTool UTF-16LE+BOM fast path', () => {
  test('UTF-16LE+BOM file reads as correctly decoded text (no garbling)', async () => {
    // Arrange — "héllo\nworld" in UTF-16LE behind its BOM.
    const filePath = join(tmpDir, 'utf16le-read.txt')
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('héllo\nworld', 'utf16le'),
      ]),
    )

    // Act
    const { data, mapped } = await readAndMap(filePath)

    // Assert — decoded via utf16le; the BOM char is stripped from the
    // content (official Ilo); no notText notice (UTF-16LE is a supported
    // encoding behind its BOM).
    expect(data.type).toBe('text')
    expect(data.file?.content).toContain('héllo')
    expect(data.file?.content).toContain('world')
    expect(data.file?.content).not.toContain('�')
    expect(mapped).not.toContain('[This file')
  })

  test('clean UTF-8 file reads with no notice (unchanged behavior)', async () => {
    const filePath = join(tmpDir, 'clean-read.txt')
    await writeFile(filePath, 'line one\nline two\n')

    const { data, mapped } = await readAndMap(filePath)

    expect(data.file?.content).toBe('line one\nline two\n')
    expect(mapped).not.toContain('[This file')
  })
})

describe('CC 2.1.299 #126: FileReadTool notText notice (official nHs via BTn)', () => {
  test('legacy-encoding (not_utf8) file → content kept, nHs notice appended with the U+FFFD sentence', async () => {
    // Arrange — cp1252/GBK-style invalid UTF-8 bytes in a .txt file.
    const filePath = join(tmpDir, 'gbk-read.txt')
    await writeFile(filePath, Buffer.from([0x63, 0x61, 0x66, 0xe9]))

    // Act
    const { mapped } = await readAndMap(filePath)

    // Assert — Read does NOT refuse; the notice is appended AFTER the
    // line-numbered content, separated by a blank line (official fWr).
    const notice = fileNotTextReadNotice('not_utf8')
    expect(mapped.endsWith(`\n\n${notice}`)).toBe(true)
    // Byte-exact notice text (v299 @216804364), incl. the not_utf8-only
    // extra sentence.
    expect(notice).toBe(
      '[This file is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. Its undecodable bytes show above as U+FFFD. Edit and Write will refuse it: change it with a shell command that keeps its encoding, or ask the user whether to convert it to UTF-8.]',
    )
    // The undecodable byte shows as U+FFFD in the numbered content.
    expect(mapped).toContain('�')
  })

  test('NUL-bearing file → nul notice WITHOUT the U+FFFD sentence', async () => {
    const filePath = join(tmpDir, 'nul-read.txt')
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from('text'), Buffer.alloc(1, 0), Buffer.from('more')]),
    )

    const { mapped } = await readAndMap(filePath)

    const notice = fileNotTextReadNotice('nul')
    expect(mapped.endsWith(`\n\n${notice}`)).toBe(true)
    expect(notice).not.toContain('U+FFFD')
    expect(notice).toContain('has NUL bytes in its first 8 KB')
  })

  test('UTF-16BE (FE FF) file → utf16be notice', async () => {
    const filePath = join(tmpDir, 'utf16be-read.txt')
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi')]),
    )

    const { mapped } = await readAndMap(filePath)

    const notice = fileNotTextReadNotice('utf16be')
    expect(mapped.endsWith(`\n\n${notice}`)).toBe(true)
    expect(notice).toContain('is UTF-16 big-endian (it starts FE FF)')
    expect(notice).not.toContain('U+FFFD')
  })
})
