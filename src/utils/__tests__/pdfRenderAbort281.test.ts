import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.281 #032 — pdfRenderSignal abort support in extractPDFPages.
 *
 * Upstream evidence (linux-x64 2.1.281):
 *   - @203617282: Read creates a per-call abort parent for PDFs
 *     (`ge = h?.pdfAbortParent !== undefined && isPdf(ext) ? deriveChild(...)
 *     : undefined`) and the tool call receives `{pdfRenderSignal: ge?.signal}`.
 *   - @201315789: renders run with `{signal: U.pdfRenderSignal ?? U.signal}`
 *     so an interrupt kills the pdftoppm child immediately instead of letting
 *     it run to its 120s timeout ceiling.
 *
 * Repo mock.module template (agentsMdDiscovery277.test.ts): snapshot actuals
 * BEFORE mocking, dynamic-import the module under test AFTER registration,
 * restore in afterAll — mock.module leaks across files in the same worker.
 */

const actualExec = { ...(await import('../execFileNoThrow.js')) }

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}
type ExecOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  useCwd?: boolean
}

let execImpl:
  | ((file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>)
  | null = null
const execCalls: Array<{
  file: string
  args: string[]
  options: ExecOptions | undefined
}> = []

mock.module('../execFileNoThrow.js', () => ({
  ...actualExec,
  execFileNoThrow: (
    file: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    execCalls.push({ file, args, options })
    if (execImpl) {
      return execImpl(file, args, options)
    }
    return actualExec.execFileNoThrow(file, args, options ?? {})
  },
}))

const { extractPDFPages, resetPdftoppmCache } = await import('../pdf.js')

import type { PDFResult } from '../pdf.js'

// strictNullChecks is off in this repo, so the false-branch of the PDFResult
// union doesn't narrow — pin the failure variant explicitly.
function pdfFailure<T>(
  result: PDFResult<T>,
): Extract<PDFResult<T>, { success: false }> {
  return result as Extract<PDFResult<T>, { success: false }>
}

const PDFTOPPM_VERSION_STDERR = 'pdftoppm version 24.02.0'
const SIGTERM_EXIT_CODE = 143
const PDF_RENDER_TIMEOUT_MS = 120_000

let tmpDir: string
let pdfPath: string

beforeEach(async () => {
  execImpl = null
  execCalls.length = 0
  resetPdftoppmCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-pdf-abort-281-'))
  pdfPath = join(tmpDir, 'doc.pdf')
  await writeFile(pdfPath, '%PDF-1.4\n% not a real pdf body\n')
})

afterAll(async () => {
  // Reset the seam state FIRST: modules whose bindings already resolved to
  // the mock namespace keep this closure for the rest of the shared process,
  // and beforeEach no longer runs after this file — a stale execImpl would
  // silently fake every later subprocess call (git clone, pdftoppm, …).
  execImpl = null
  execCalls.length = 0
  mock.module('../execFileNoThrow.js', () => ({ ...actualExec }))
})

/** Stub exec so the pdftoppm availability probe succeeds. */
function stubExecWithPdftoppm(
  renderImpl: (
    args: string[],
    options: ExecOptions | undefined,
  ) => Promise<ExecResult>,
): void {
  execImpl = async (file, args, options) => {
    if (file === 'pdftoppm' && args[0] === '-v') {
      return { stdout: '', stderr: PDFTOPPM_VERSION_STDERR, code: 0 }
    }
    return renderImpl(args, options)
  }
}

describe('CC 2.1.281 #032: extractPDFPages abort signal', () => {
  test('returns aborted without spawning any child when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await extractPDFPages(pdfPath, {
      signal: controller.signal,
    })

    expect(result.success).toBe(false)
    expect(pdfFailure(result).error.reason).toBe('aborted')
    // Early-out happens before stat/availability/render — nothing spawned.
    expect(execCalls).toEqual([])
  })

  test('passes the signal as abortSignal with the 120s timeout ceiling to the render child', async () => {
    const controller = new AbortController()
    stubExecWithPdftoppm(async () => ({
      stdout: '',
      stderr: '',
      code: SIGTERM_EXIT_CODE,
      error: 'SIGTERM',
    }))

    await extractPDFPages(pdfPath, {
      firstPage: 2,
      lastPage: 3,
      signal: controller.signal,
    })

    const renderCall = execCalls.find(c => c.args[0] === '-jpeg')
    expect(renderCall).toBeDefined()
    expect(renderCall?.options?.abortSignal).toBe(controller.signal)
    expect(renderCall?.options?.timeout).toBe(PDF_RENDER_TIMEOUT_MS)
    // Page-range args still threaded through.
    expect(renderCall?.args).toContain('-f')
    expect(renderCall?.args).toContain('2')
    expect(renderCall?.args).toContain('-l')
    expect(renderCall?.args).toContain('3')
  })

  test('classifies a mid-render abort (child killed, non-zero exit) as aborted, not a pdftoppm failure', async () => {
    const controller = new AbortController()
    stubExecWithPdftoppm(async (_args, options) => {
      // Simulate the tool interrupt: the caller aborts while the child runs;
      // execa's cancelSignal SIGTERMs it and (reject:false) resolves.
      expect(options?.abortSignal).toBeDefined()
      controller.abort()
      return { stdout: '', stderr: '', code: SIGTERM_EXIT_CODE }
    })

    const result = await extractPDFPages(pdfPath, {
      signal: controller.signal,
    })

    expect(result.success).toBe(false)
    expect(pdfFailure(result).error.reason).toBe('aborted')
    expect(pdfFailure(result).error.message).toBe(
      'PDF page rendering was aborted.',
    )
  })

  test('execFileNoThrow kills a real long-running child on abort and resolves (never rejects)', async () => {
    // Real implementation (execImpl = null delegates to actualExec).
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = actualExec.execFileNoThrow(
      'sleep',
      ['30'],
      {
        abortSignal: controller.signal,
        timeout: 60_000,
        useCwd: false,
      },
    )
    await new Promise(resolve => setTimeout(resolve, 200))
    controller.abort()

    const result = await pending
    const elapsedMs = Date.now() - startedAt

    // Killed promptly — nowhere near the 30s sleep or the 60s timeout.
    expect(elapsedMs).toBeLessThan(10_000)
    expect(result.code).not.toBe(0)
  })

  test('non-abort render failure still surfaces its own reason (unchanged behavior)', async () => {
    stubExecWithPdftoppm(async () => ({
      stdout: '',
      stderr: 'Syntax Error: document is corrupted',
      code: 1,
    }))

    const result = await extractPDFPages(pdfPath)

    expect(result.success).toBe(false)
    expect(pdfFailure(result).error.reason).toBe('corrupted')
  })
})

// Keep the tmpdir tidy (best-effort; mkdtemp dirs are unique per test).
afterAll(async () => {
  await rm(join(tmpdir(), 'occ-pdf-abort-281-'), {
    recursive: true,
    force: true,
  }).catch(() => {})
})
