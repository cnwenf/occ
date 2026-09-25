import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.281 #031 + #032 — FileReadTool PDF read gates.
 *
 * Upstream evidence (linux-x64 2.1.281):
 *   - @201315570: `jn=(!lRt()||yn.size>OTo)&&!x("tengu_deep_starlight",!0)`
 *     — the whole-document pre-render only runs when the deep_starlight
 *     kill-switch is OFF. Flag defaults ON ⇒ whole-doc render SKIPPED
 *     (v280 @198493712 rendered unconditionally — a 2-minute stall risk on
 *     large PDFs).
 *   - @203617282: per-read abort child → `pdfRenderSignal`; renders use
 *     `{signal: U.pdfRenderSignal ?? U.signal}`.
 *   - @201310256 (YR): every render outcome is logged as `cli_pdf_read`
 *     with request/render/outcome/file_bytes/document_pages/pages_rendered/
 *     duration_ms.
 *   - @203617810: abort-family errors re-run the fallback path instead of
 *     failing the read.
 *
 * Repo mock.module template (agentsMdDiscovery277.test.ts): snapshot actuals
 * BEFORE mocking, dynamic-import the module under test AFTER registration,
 * restore in afterAll — mock.module leaks across files in the same worker.
 */

const actualGrowthbook = {
  ...(await import('../../../services/analytics/growthbook.js')),
}
const actualPdf = { ...(await import('../../../utils/pdf.js')) }
const actualPdfUtils = { ...(await import('../../../utils/pdfUtils.js')) }

let gbFeatures: Record<string, unknown> = {}
let gbRequestedKeys: string[] = []

mock.module('../../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, def: unknown) => {
    gbRequestedKeys.push(key)
    return key in gbFeatures ? gbFeatures[key] : def
  },
}))

type ExtractOptions = {
  firstPage?: number
  lastPage?: number
  signal?: AbortSignal
}
let extractCalls: Array<{ filePath: string; options?: ExtractOptions }> = []
let readPdfCalls: string[] = []
let extractOverride:
  | ((
      filePath: string,
      options?: ExtractOptions,
    ) => Promise<unknown> | unknown)
  | null = null

mock.module('../../../utils/pdf.js', () => ({
  ...actualPdf,
  extractPDFPages: (filePath: string, options?: ExtractOptions) => {
    extractCalls.push({ filePath, options })
    if (extractOverride) {
      return extractOverride(filePath, options)
    }
    return actualPdf.extractPDFPages(filePath, options)
  },
  readPDF: (filePath: string) => {
    readPdfCalls.push(filePath)
    return Promise.resolve({
      success: true,
      data: {
        type: 'pdf' as const,
        file: { filePath, base64: 'ZmFrZS1wZGYtYnl0ZXM=', originalSize: 18 },
      },
    })
  },
  // Hermetic: pdfinfo availability must not change control flow. null keeps
  // the >10-page at-mention guard out of the way (real pdfinfo is absent in
  // CI too, but don't rely on it).
  getPDFPageCount: () => Promise.resolve(null),
}))

mock.module('../../../utils/pdfUtils.js', () => ({
  ...actualPdfUtils,
  // Model-independent: the whole-doc path must reach the gate + fallback.
  isPDFSupported: () => true,
}))

const { FileReadTool } = await import('../FileReadTool.js')
const { stashCheckTimeResolutions } = await import(
  '../../../utils/permissions/symlinkResolutionStash.js'
)

const DEEP_STARLIGHT_FLAG = 'tengu_deep_starlight'
const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024
const BIG_PDF_SIZE = PDF_EXTRACT_SIZE_THRESHOLD + 256 * 1024
const ABORTED_RENDER_MESSAGE = 'PDF page rendering was aborted.'
// Real minimal 1x1 JPEG — maybeResizeAndDownsampleImageBuffer's fallback
// passes raw bytes through for small, in-dimension images.
const MINIMAL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgAAAP/Z'

let tmpDir: string
let diagFile: string
let bigPdfPath: string
let smallPdfPath: string
let savedSimpleEnv: string | undefined
let savedDiagEnv: string | undefined
let toolUseCounter = 0

beforeAll(async () => {
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  savedDiagEnv = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  // Skip skill discovery in the read path (no network/fs scans).
  process.env.CLAUDE_CODE_SIMPLE = '1'
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-read-tool-281-'))
  diagFile = join(tmpDir, 'diagnostics.log')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagFile
  bigPdfPath = join(tmpDir, 'big.pdf')
  smallPdfPath = join(tmpDir, 'small.pdf')
  await writeFile(
    bigPdfPath,
    Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(BIG_PDF_SIZE, 0x78),
    ]),
  )
  await writeFile(smallPdfPath, '%PDF-1.4\n% small fixture\n')
})

afterAll(async () => {
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
  mock.module('../../../utils/pdf.js', () => ({ ...actualPdf }))
  mock.module('../../../utils/pdfUtils.js', () => ({ ...actualPdfUtils }))
  if (savedSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  }
  if (savedDiagEnv === undefined) {
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  } else {
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = savedDiagEnv
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  gbFeatures = {}
  gbRequestedKeys = []
  extractCalls = []
  readPdfCalls = []
  extractOverride = null
  await rm(diagFile, { force: true }).catch(() => {})
})

function makeContext() {
  toolUseCounter += 1
  return {
    toolUseId: `toolu_read281_${toolUseCounter}`,
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
  }
}

async function callRead(
  filePath: string,
  input: { pages?: string } = {},
  context: ReturnType<typeof makeContext> = makeContext(),
): Promise<{ result: any; context: ReturnType<typeof makeContext> }> {
  // TOCTOU gate: checkPermissions stashes resolutions before call() asserts
  // they are unchanged (CC 2.1.251).
  stashCheckTimeResolutions(context as never, filePath, 'read')
  const result = await FileReadTool.call(
    { file_path: filePath, ...input } as never,
    context as never,
  )
  return { result, context }
}

type PdfReadLogEntry = {
  request: string
  render: string
  outcome: string
  file_bytes: number | null
  document_pages: number | null
  pages_rendered: number | null
  duration_ms: number
}

async function readPdfOutcomeLogs(): Promise<PdfReadLogEntry[]> {
  let raw: string
  try {
    raw = await readFile(diagFile, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
    .filter(entry => entry.event === 'cli_pdf_read')
    .map(entry => entry.data as PdfReadLogEntry)
}

describe('CC 2.1.281 #031: whole-doc render gate (tengu_deep_starlight)', () => {
  test('whole-doc render is SKIPPED by default for a large PDF (flag defaults on)', async () => {
    const { result } = await callRead(bigPdfPath)

    expect(gbRequestedKeys).toContain(DEEP_STARLIGHT_FLAG)
    // Gate default-on ⇒ no pre-render; the fallback whole-file read serves it.
    expect(extractCalls).toEqual([])
    expect(readPdfCalls).toEqual([bigPdfPath])
    expect(result.data.type).toBe('pdf')

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({
      request: 'whole_file',
      render: 'none',
      outcome: 'ok',
      file_bytes: BIG_PDF_SIZE + '%PDF-1.4\n'.length,
      pages_rendered: null,
    })
    expect(logs[0]!.duration_ms).toBeGreaterThanOrEqual(0)
  })

  test('whole-doc render runs when tengu_deep_starlight is disabled (v280 behavior behind the gate)', async () => {
    gbFeatures = { [DEEP_STARLIGHT_FLAG]: false }
    extractOverride = (filePath: string) => ({
      success: true,
      data: {
        type: 'parts' as const,
        file: {
          filePath,
          originalSize: BIG_PDF_SIZE,
          outputDir: tmpDir,
          count: 12,
        },
      },
    })

    const { result } = await callRead(bigPdfPath)

    expect(extractCalls.length).toBe(1)
    // #032: the render receives a per-read abort signal.
    expect(extractCalls[0]!.options?.signal).toBeInstanceOf(AbortSignal)
    // The whole-doc render only feeds telemetry — data still comes from readPDF.
    expect(readPdfCalls).toEqual([bigPdfPath])
    expect(result.data.type).toBe('pdf')

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({
      request: 'whole_file',
      render: 'ok',
      outcome: 'ok',
      pages_rendered: 12,
    })
  })

  test('non-abort render failure propagates (no silent fallback) and logs render=threw', async () => {
    gbFeatures = { [DEEP_STARLIGHT_FLAG]: false }
    extractOverride = () => {
      throw new Error('render exploded')
    }

    await expect(callRead(bigPdfPath)).rejects.toThrow('render exploded')
    expect(readPdfCalls).toEqual([])

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({
      request: 'whole_file',
      render: 'threw',
      outcome: 'threw',
    })
  })
})

describe('CC 2.1.281 #032: abort signal + fallback', () => {
  test('abort during whole-doc render falls back to readPDF instead of crashing', async () => {
    gbFeatures = { [DEEP_STARLIGHT_FLAG]: false }
    extractOverride = () => ({
      success: false,
      error: { reason: 'aborted', message: ABORTED_RENDER_MESSAGE },
    })

    const { result } = await callRead(bigPdfPath)

    // Abort-family → fallback re-run (upstream @203617810 semantics).
    expect(readPdfCalls).toEqual([bigPdfPath])
    expect(result.data.type).toBe('pdf')

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(2)
    expect(logs[0]).toMatchObject({
      request: 'whole_file',
      render: 'aborted',
      outcome: 'aborted',
    })
    expect(logs[1]).toMatchObject({
      request: 'whole_file',
      render: 'aborted',
      outcome: 'ok',
    })
  })

  test('page-range render still works and its signal derives from the tool abortController', async () => {
    const outputDir = join(tmpDir, 'pdf-range-out')
    const context = makeContext()
    let capturedSignal: AbortSignal | undefined
    let signalAbortedDuringRender: boolean | undefined
    extractOverride = async (filePath: string, options?: ExtractOptions) => {
      capturedSignal = options?.signal
      // #032: interrupting the tool call DURING the render aborts the
      // per-read child signal (deriveChild(pdfAbortParent) → pdfRenderSignal),
      // which kills the pdftoppm child immediately.
      context.abortController.abort()
      signalAbortedDuringRender = capturedSignal?.aborted
      await mkdir(outputDir, { recursive: true })
      await writeFile(
        join(outputDir, 'page-01.jpg'),
        Buffer.from(MINIMAL_JPEG_BASE64, 'base64'),
      )
      return {
        success: true,
        data: {
          type: 'parts' as const,
          file: { filePath, originalSize: 27, outputDir, count: 1 },
        },
      }
    }

    const { result } = await callRead(
      smallPdfPath,
      { pages: '2-3' },
      context,
    )

    expect(extractCalls.length).toBe(1)
    expect(extractCalls[0]!.options).toMatchObject({
      firstPage: 2,
      lastPage: 3,
    })
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(signalAbortedDuringRender).toBe(true)
    expect(result.data.type).toBe('parts')
    expect(result.newMessages?.length).toBe(1)

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({
      request: 'page_range',
      render: 'ok',
      outcome: 'ok',
      pages_rendered: 1,
    })
  })

  test('aborted page-range render surfaces the aborted error (page_range has no fallback)', async () => {
    extractOverride = () => ({
      success: false,
      error: { reason: 'aborted', message: ABORTED_RENDER_MESSAGE },
    })

    await expect(
      callRead(smallPdfPath, { pages: '1-2' }),
    ).rejects.toThrow(ABORTED_RENDER_MESSAGE)

    const logs = await readPdfOutcomeLogs()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({
      request: 'page_range',
      render: 'aborted',
      outcome: 'aborted',
    })
  })
})
