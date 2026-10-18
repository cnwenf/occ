import { afterEach, describe, expect, test } from 'bun:test'

import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'
import {
  ImageReadLimitError,
  readImageBytesCapped,
  type ReadableHandle,
} from '../imageRead.js'
import { MAX_IMAGE_READ_BYTES } from '../limits.js'

/**
 * CC 2.1.302 acceptance-review fixes #4 / #8 / #9 for imageRead.ts.
 *
 * #4 (behavioral): `readImageBytesCapped` must open through the
 *   `getFsImplementation()` seam when the active implementation provides
 *   `open` — a bare `fs/promises.open` call bypasses test/custom fs impls.
 *   Pinned here via `setFsImplementation` (the seam's own runtime API — no
 *   mock.module needed, so nothing can leak into sibling test files): the
 *   spy `open` must be called with (path, 'r') and its handle must be used.
 *   Mutation: reverting production to bare `open()` drops the spy count to 0.
 *
 * #8 (boundary): the regular-file cap check is `size > maxBytes` (strict).
 *   A file EXACTLY 134217728 bytes must be ACCEPTED. The existing suite only
 *   covered cap+1 rejection via a real sparse file, so `>` → `>=` stayed
 *   green. The cap gate reads `handle.stat().size`, so a seam-provided fake
 *   handle with a fake stat size is the cheapest faithful probe (no real
 *   128 MiB file). Mutation `>` → `>=` makes the at-cap test throw.
 *   (Over-cap rejection at 134217729 is already pinned by
 *   imageReadCap302.test.ts's sparse-file test; a no-allocation fake-handle
 *   complement is added below.)
 *
 * #9 (fd hygiene): the handle must be closed even when the read is refused
 *   (oversized). Mutation: deleting the `finally { handle.close() }` in
 *   readImageBytesCapped drops the close count to 0 on the error path.
 */

type Fs = ReturnType<typeof getFsImplementation>
type SeamOpen = (path: string, mode: string) => Promise<ReadableHandle>

afterEach(() => {
  // Always hand the process back the stock implementation — Bun runs every
  // test file in one process and the seam is module-global state.
  setOriginalFsImplementation()
})

/** Build a seam whose `open` returns a scripted regular-file handle. */
function installSeam(
  openImpl: SeamOpen,
): { openCalls: Array<{ path: string; mode: string }> } {
  const openCalls: Array<{ path: string; mode: string }> = []
  setFsImplementation({
    ...getFsImplementation(),
    open: async (path: string, mode: string) => {
      openCalls.push({ path, mode })
      return openImpl(path, mode)
    },
  } as unknown as Fs)
  return { openCalls }
}

/** A fake regular-file handle reporting `size` from stat(). */
function fakeRegularHandle(
  size: number,
  content: Buffer = Buffer.alloc(0),
): { handle: ReadableHandle; closeCalls: () => number } {
  let closes = 0
  let served = 0
  const handle: ReadableHandle = {
    async stat() {
      return { isFile: () => true, size }
    },
    async read(buffer: Buffer, offset: number, length: number) {
      const n = Math.min(length, content.length - served)
      if (n > 0) {
        content.copy(buffer, offset, served, served + n)
        served += n
      }
      return { bytesRead: n }
    },
    async close() {
      closes += 1
    },
  }
  return { handle, closeCalls: () => closes }
}

describe('#4: readImageBytesCapped opens through the getFsImplementation seam', () => {
  test('the seam open is called with (path, "r") and its handle serves the bytes', async () => {
    const payload = Buffer.from('89504e470d0a1a0a', 'hex')
    const { handle } = fakeRegularHandle(payload.length, payload)
    const { openCalls } = installSeam(async () => handle)

    const bytes = await readImageBytesCapped('/virtual/image.png')

    expect(openCalls).toEqual([{ path: '/virtual/image.png', mode: 'r' }])
    expect(Buffer.compare(bytes, payload)).toBe(0)
  })

  test('the seam handle is used for the cap decision (seam open returning an oversized handle refuses)', async () => {
    const { handle } = fakeRegularHandle(MAX_IMAGE_READ_BYTES + 1)
    const { openCalls } = installSeam(async () => handle)

    let caught: unknown
    try {
      await readImageBytesCapped('/virtual/huge.png')
    } catch (e) {
      caught = e
    }

    expect(openCalls.length).toBe(1)
    expect(caught).toBeInstanceOf(ImageReadLimitError)
  })
})

describe('#8: regular-file cap boundary is strict (size > maxBytes)', () => {
  test('a regular file EXACTLY at the 134217728-byte cap is ACCEPTED', async () => {
    // The cap gate uses handle.stat().size; read() hits immediate EOF so no
    // real 128 MiB of content is ever produced (only the read buffer is
    // allocated by the production code path, exactly as for a real at-cap
    // file). Mutation `>` → `>=` makes this throw ImageReadLimitError.
    const { handle } = fakeRegularHandle(MAX_IMAGE_READ_BYTES)
    installSeam(async () => handle)

    let caught: unknown
    let bytes: Buffer | undefined
    try {
      bytes = await readImageBytesCapped('/virtual/exact-cap.png')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeUndefined()
    expect(Buffer.isBuffer(bytes)).toBe(true)
  })

  test('a regular file one byte over the cap is refused (no-allocation complement to the sparse-file test)', async () => {
    const { handle } = fakeRegularHandle(MAX_IMAGE_READ_BYTES + 1)
    installSeam(async () => handle)

    let caught: unknown
    try {
      await readImageBytesCapped('/virtual/over-cap.png')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImageReadLimitError)
    expect((caught as ImageReadLimitError).reason).toBe(
      'File over the image read limit',
    )
  })
})

describe('#9: the FileHandle is closed on the oversized-read error path', () => {
  test('an oversized read throws AND closes the handle exactly once', async () => {
    const { handle, closeCalls } = fakeRegularHandle(MAX_IMAGE_READ_BYTES + 1)
    installSeam(async () => handle)

    let caught: unknown
    try {
      await readImageBytesCapped('/virtual/leak-check.png')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImageReadLimitError)
    // Mutation: deleting `finally { handle.close() }` from
    // readImageBytesCapped drops this to 0 (silent fd leak).
    expect(closeCalls()).toBe(1)
  })

  test('a successful read also closes the handle exactly once', async () => {
    const payload = Buffer.from('deadbeef', 'hex')
    const { handle, closeCalls } = fakeRegularHandle(payload.length, payload)
    installSeam(async () => handle)

    const bytes = await readImageBytesCapped('/virtual/ok.png')

    expect(Buffer.compare(bytes, payload)).toBe(0)
    expect(closeCalls()).toBe(1)
  })
})
