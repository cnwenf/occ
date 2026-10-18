/**
 * CC 2.1.302 #06 — capped image-byte reader.
 *
 * Faithful port of the official v302 image-read limiter (`qXr` = readImageBytes,
 * `oOn` = chunked reader @246685000–246688600, absent from v301 which read
 * unbounded via `DW(e.handle,1/0,"stream")`).
 *
 * Behavior:
 *   - Regular file: stat-first. If size > cap → refuse WITHOUT reading a single
 *     byte (message 1, reason "File over the image read limit"). Otherwise read
 *     exactly `size` bytes.
 *   - Non-regular file (FIFO / char device) named like an image: read in 64 KiB
 *     chunks with a running total. If the total exceeds the cap → refuse
 *     (message 2, reason "Image stream over the read limit"). Never slurps the
 *     whole source into memory beyond the cap.
 *
 * The byte formatter (`formatByteCount`) is byte-identical to the official `Zt`
 * (@235066095) and to OCC's private `formatBytes` in `src/utils/bash/e2bigError.ts`,
 * so the 134217728 cap renders as "128MB" exactly as the official does.
 */
import { open } from 'fs/promises'

import { getFsImplementation } from '../../utils/fsOperations.js'
import { IMAGE_READ_CHUNK_BYTES, MAX_IMAGE_READ_BYTES } from './limits.js'

/**
 * Minimal readable-handle surface used by the chunked reader. Node's
 * `FileHandle` (from `fs/promises.open`) satisfies this structurally; tests can
 * supply a deterministic fake to exercise the pipe/device path without a FIFO.
 */
export interface ReadableHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/**
 * Error carrying the official reason string as a second field. The surfaced
 * `message` matches the official refusal text verbatim; `reason` mirrors the
 * official `x(message, reason)` error's second argument.
 */
export class ImageReadLimitError extends Error {
  readonly reason: string

  constructor(message: string, reason: string) {
    super(message)
    this.name = 'ImageReadLimitError'
    this.reason = reason
  }
}

/**
 * Format a byte count the way the official `Zt` does: `<n> bytes` under 1 KiB,
 * then `<x.x>KB` / `<x.x>MB` / `<x.x>GB` with a trailing `.0` stripped.
 * 134217728 → "128MB".
 */
function formatByteCount(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1) return `${bytes} bytes`
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`
}

/** Official refusal message 1 (regular file over the cap). */
export function imageFileTooLargeMessage(
  displayPath: string,
  maxBytes: number,
): string {
  return (
    `File is too large to read as an image (the limit is ${formatByteCount(maxBytes)}): ${displayPath}. ` +
    'If it is an image, resize it or export a smaller copy, then read that.'
  )
}

/** Official refusal message 2 (pipe/device over the cap). */
export function imageStreamTooLargeMessage(
  displayPath: string,
  maxBytes: number,
): string {
  return (
    `Cannot read this as an image: ${displayPath} is a pipe or a device, not a regular file, ` +
    `and it sent more than ${formatByteCount(maxBytes)} without ending.`
  )
}

/**
 * Read exactly `size` bytes from a regular-file handle (already known to be
 * within the cap). Returns a fresh buffer; the handle is not closed here.
 */
async function readRegularFileBytes(
  handle: ReadableHandle,
  size: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset < size ? buffer.subarray(0, offset) : buffer
}

/**
 * Read a non-regular source in chunks with a running total, refusing once the
 * total exceeds `maxBytes`. Mirrors the official `oOn` non-regular branch:
 * allocates at most `maxBytes + 1` bytes total, so it never slurps an unbounded
 * stream into memory.
 */
async function readNonRegularCapped(
  handle: ReadableHandle,
  displayPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let current = Buffer.alloc(0)
  let currentOffset = 0
  let total = 0
  while (total <= maxBytes) {
    if (currentOffset === current.length) {
      current = Buffer.allocUnsafe(
        Math.min(Math.max(total, IMAGE_READ_CHUNK_BYTES), maxBytes + 1 - total),
      )
      chunks.push(current)
      currentOffset = 0
    }
    const { bytesRead } = await handle.read(
      current,
      currentOffset,
      current.length - currentOffset,
      null,
    )
    if (bytesRead === 0) break
    currentOffset += bytesRead
    total += bytesRead
  }
  if (total > maxBytes) {
    throw new ImageReadLimitError(
      imageStreamTooLargeMessage(displayPath, maxBytes),
      'Image stream over the read limit',
    )
  }
  return Buffer.concat(chunks, total)
}

/**
 * Read image bytes from an already-open handle, enforcing the cap. Regular
 * files are stat-gated (refused over the cap without reading); non-regular
 * sources are read in chunks. Port of the official `oOn`.
 */
export async function readImageBytesFromHandle(
  handle: ReadableHandle,
  displayPath: string,
  maxBytes: number = MAX_IMAGE_READ_BYTES,
): Promise<Buffer> {
  const stats = await handle.stat()
  if (stats.isFile()) {
    if (stats.size > maxBytes) {
      throw new ImageReadLimitError(
        imageFileTooLargeMessage(displayPath, maxBytes),
        'File over the image read limit',
      )
    }
    return readRegularFileBytes(handle, stats.size)
  }
  return readNonRegularCapped(handle, displayPath, maxBytes)
}

/**
 * Open `filePath` for reading through the active `getFsImplementation()` seam.
 *
 * Fix #4 (acceptance review): this module previously called bare
 * `fs/promises.open`, bypassing the fs seam that sibling FileReadTool code
 * paths use (`FileReadTool.ts` routes stat/read through
 * `getFsImplementation()`), so test/custom fs implementations were silently
 * ignored for image reads.
 *
 * OCC-121 P3 carryover fix (contract-1 seam evenness): `FsOperations` now
 * DECLARES the optional `open?(path, mode)` member and the built-in
 * `NodeFsOperations` implements it, so the stock path routes through the seam
 * by contract instead of by undeclared structural probe. The bare
 * `fs/promises.open` fallback stays for seam implementations that do not
 * provide `open` (it is optional): documented, pinned by
 * imageReadSeam302.test.ts. Behavior is otherwise identical — same `'r'`
 * flag, same FileHandle usage.
 */
async function openForImageRead(filePath: string): Promise<ReadableHandle> {
  const impl = getFsImplementation()
  if (typeof impl.open === 'function') {
    return (await impl.open(filePath, 'r')) as ReadableHandle
  }
  return (await open(filePath, 'r')) as unknown as ReadableHandle
}

/**
 * Open `filePath` and read it as a capped image source. Port of the official
 * `qXr` string-path/undefined-maxBytes branch (opens RDONLY, defers to the
 * chunked reader). The handle is always closed.
 */
export async function readImageBytesCapped(
  filePath: string,
  maxBytes: number = MAX_IMAGE_READ_BYTES,
): Promise<Buffer> {
  const handle = await openForImageRead(filePath)
  try {
    return await readImageBytesFromHandle(handle, filePath, maxBytes)
  } finally {
    // Fix #9 (acceptance review): the close must run on the error path too —
    // an oversized read throws from readImageBytesFromHandle, and without
    // this finally-block the handle (fd) leaks silently.
    await handle.close()
  }
}
