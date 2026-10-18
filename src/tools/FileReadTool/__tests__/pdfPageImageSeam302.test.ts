import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * OCC-121 P3 carryover fix (contract-1 seam evenness) — the PDF page-range
 * image mapping in FileReadTool.ts must route through the
 * `getFsImplementation()` seam (readdir + readFileBytes), not bare
 * `fs/promises` calls.
 *
 * Before the fix, `readdir(outputDir)` + `readFile(imgPath)` on the extracted
 * page JPEGs were the only image-byte reads in FileReadTool that bypassed the
 * seam — a test/custom fs implementation saw stat/text/image reads but not
 * PDF page images. This test installs a recording seam (spread-real, via the
 * seam's own runtime API `setFsImplementation` — no mock.module leak risk for
 * the fs layer) and drives the REAL production path:
 * `FileReadTool.call({file_path, pages}) → extractPDFPages (mocked) →
 * seam.readdir(outputDir) → seam.readFileBytes(jpg) → image blocks`.
 *
 * Would-fail pin: revert the two call sites to bare
 * `readdir`/`readFileAsync` from 'fs/promises' and both spy arrays below
 * stay empty → RED. The image-block assertions additionally pin that the
 * seam-routed bytes are what reach the response.
 *
 * Mock template: readTool281.test.ts (snapshot actuals BEFORE mocking,
 * dynamic-import the module under test AFTER registration, restore in
 * afterAll — mock.module leaks across files in the same worker).
 */

const actualPdf = { ...(await import('../../../utils/pdf.js')) }
const actualPdfUtils = { ...(await import('../../../utils/pdfUtils.js')) }

// Real minimal 1x1 JPEG — maybeResizeAndDownsampleImageBuffer's fallback
// passes raw bytes through for small, in-dimension images (readTool281).
const MINIMAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgAAAP/Z',
  'base64',
)

let tmpDir: string
let pdfPath: string
let outputDir: string

/** Set by the extractPDFPages mock before each call; read by the seam spy. */
let extractOutputDir: string | null = null

mock.module('../../../utils/pdf.js', () => ({
  ...actualPdf,
  // Hermetic page extraction: create the output dir with two real minimal
  // JPEGs and return the success ('parts') variant with the production shape.
  extractPDFPages: async (filePath: string) => {
    extractOutputDir = join(tmpDir, `pdf-pages-${filePath.length}`)
    await mkdir(extractOutputDir, { recursive: true })
    await writeFile(join(extractOutputDir, 'page-2.jpg'), MINIMAL_JPEG)
    await writeFile(join(extractOutputDir, 'page-1.jpg'), MINIMAL_JPEG)
    // A non-.jpg sibling that must NOT be picked up by the filter.
    await writeFile(join(extractOutputDir, 'page-1.txt'), 'ignored')
    outputDir = extractOutputDir
    return {
      success: true,
      data: {
        type: 'parts' as const,
        file: { filePath, originalSize: 18, count: 2, outputDir },
      },
    }
  },
  getPDFPageCount: () => Promise.resolve(null),
}))

mock.module('../../../utils/pdfUtils.js', () => ({
  ...actualPdfUtils,
  isPDFSupported: () => true,
}))

const { FileReadTool } = await import('../FileReadTool.js')
const {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} = await import('../../../utils/fsOperations.js')
const { stashCheckTimeResolutions } = await import(
  '../../../utils/permissions/symlinkResolutionStash.js'
)

let savedSimpleEnv: string | undefined
let readdirCalls: string[] = []
let readFileBytesCalls: string[] = []

beforeAll(async () => {
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  // Skip skill discovery in the read path (no network/fs scans).
  process.env.CLAUDE_CODE_SIMPLE = '1'
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-pdf-seam-302-'))
  pdfPath = join(tmpDir, 'small.pdf')
  await writeFile(pdfPath, '%PDF-1.4\n% small fixture\n')
})

afterAll(async () => {
  mock.module('../../../utils/pdf.js', () => ({ ...actualPdf }))
  mock.module('../../../utils/pdfUtils.js', () => ({ ...actualPdfUtils }))
  if (savedSimpleEnv === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

afterEach(() => {
  setOriginalFsImplementation()
  readdirCalls = []
  readFileBytesCalls = []
  extractOutputDir = null
})

/** Recording seam: spread-real, delegates every call to the stock impl. */
function installRecordingSeam(): void {
  const stock = getFsImplementation()
  setFsImplementation({
    ...stock,
    readdir: async (p: string) => {
      readdirCalls.push(p)
      return stock.readdir(p)
    },
    readFileBytes: async (p: string, maxBytes?: number) => {
      readFileBytesCalls.push(p)
      return stock.readFileBytes(p, maxBytes)
    },
  })
}

describe('OCC-121 P3 (contract-1): PDF page-image mapping routes through the fs seam', () => {
  test('page-range read enumerates and reads the page JPEGs via getFsImplementation, and the seam-routed bytes reach the image blocks', async () => {
    // Arrange
    installRecordingSeam()
    const context = {
      toolUseId: 'toolu_pdfseam_302',
      abortController: new AbortController(),
      readFileState: new Map(),
      dynamicSkillDirTriggers: new Set(),
      nestedMemoryAttachmentTriggers: new Set(),
    }
    stashCheckTimeResolutions(context as never, pdfPath, 'read')

    // Act — real production call path (extractPDFPages is the only mock).
    const result = await FileReadTool.call(
      { file_path: pdfPath, pages: '1-2' } as never,
      context as never,
    )

    // Assert — seam routing (the mutation target: bare fs/promises calls
    // leave both arrays empty).
    expect(extractOutputDir).not.toBeNull()
    expect(readdirCalls).toContain(extractOutputDir)
    expect(
      readFileBytesCalls.filter(p => p.startsWith(extractOutputDir!)).sort(),
    ).toEqual([
      join(extractOutputDir!, 'page-1.jpg'),
      join(extractOutputDir!, 'page-2.jpg'),
    ])

    // Assert — the seam-routed bytes are what reach the response: two image
    // blocks (sorted, .txt sibling filtered out), base64 of the real JPEG
    // after the pass-through resize fallback.
    const newMessages = (
      result as { newMessages?: Array<{ message: { content: unknown[] } }> }
    ).newMessages
    expect(newMessages?.length).toBe(1)
    const blocks = newMessages?.[0].message.content as Array<{
      type: string
      source: { type: string; media_type: string; data: string }
    }>
    expect(blocks.length).toBe(2)
    for (const block of blocks) {
      expect(block.type).toBe('image')
      expect(block.source.media_type).toContain('image/')
      expect(block.source.data.length).toBeGreaterThan(0)
    }
  })
})
