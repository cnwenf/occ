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

import { AbortError } from '../../utils/errors.js'
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
 * CC 2.1.304 #32 — abort-race helper, faithful port of the official `$i`
 * (@236274849): races a pending I/O promise against an AbortSignal.
 *
 * Official verbatim body:
 *   function $i(t,r,e){let o=()=>{t.catch(()=>{})};if(r.aborted)throw o(),e();
 *   let n=()=>{};try{return await Promise.race([t,new Promise((m,i)=>{
 *   n=()=>i(e()),r.addEventListener("abort",n,{once:!0})})])}catch(m){throw
 *   o(),m}finally{r.removeEventListener("abort",n)}}
 *
 * Key semantics preserved:
 *   - pre-aborted signal → attach a no-op catch to the source promise (so its
 *     later rejection cannot surface as an unhandled rejection) then throw the
 *     caller-supplied error;
 *   - abort listener registered with `{once: true}`, removed in `finally`;
 *   - if the source promise itself rejects, a no-op catch is attached before
 *     rethrowing (defensive: the race loser may still reject later).
 */
async function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  makeError: () => Error,
): Promise<T> {
  const swallowSourceRejection = () => {
    pending.catch(() => {})
  }
  if (signal.aborted) {
    swallowSourceRejection()
    throw makeError()
  }
  let onAbort = () => {}
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(makeError())
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } catch (error) {
    swallowSourceRejection()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Read exactly `size` bytes from a regular-file handle (already known to be
 * within the cap). Returns a fresh buffer; the handle is not closed here.
 *
 * CC 2.1.304 #32: NOT signal-threaded — faithful to the official, which only
 * threads the non-regular (pipe/device) chunked path (`Mbn`); the regular-file
 * reader (`ik`/`Sk`) has no signal parameter in either binary.
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
 *
 * CC 2.1.304 #32 — interrupt now ends a Read waiting on an idle pipe/device:
 * optional `signal` aborts BOTH between chunks (top-of-iteration
 * `if (signal?.aborted) throw new AbortError()`, official `Mbn`
 * `if(r?.aborted)throw new Ye`) and DURING a pending read (each `handle.read`
 * raced against the signal via `raceAbort`, official
 * `await(r===void 0?H:$i(H,r,()=>new Ye))`). `signal === undefined` keeps the
 * plain await — the official's unthreaded branch shape.
 */
async function readNonRegularCapped(
  handle: ReadableHandle,
  displayPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let current = Buffer.alloc(0)
  let currentOffset = 0
  let total = 0
  while (total <= maxBytes) {
    // CC 2.1.304 #32: between-chunks abort check (official `if(r?.aborted)throw new Ye`).
    if (signal?.aborted) {
      throw new AbortError()
    }
    if (currentOffset === current.length) {
      current = Buffer.allocUnsafe(
        Math.min(Math.max(total, IMAGE_READ_CHUNK_BYTES), maxBytes + 1 - total),
      )
      chunks.push(current)
      currentOffset = 0
    }
    const pendingRead = handle.read(
      current,
      currentOffset,
      current.length - currentOffset,
      null,
    )
    // CC 2.1.304 #32: during-read abort race (official
    // `await(r===void 0?H:$i(H,r,()=>new Ye))`).
    const { bytesRead } = await (signal === undefined
      ? pendingRead
      : raceAbort(pendingRead, signal, () => new AbortError()))
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
 * sources are read in chunks. Port of the official `oOn`/`Mbn`.
 *
 * CC 2.1.304 #32: `signal` is threaded into the non-regular chunked path only
 * (official `Mbn(e,n,r)` third param; the regular-file branch is unthreaded in
 * the official too).
 */
export async function readImageBytesFromHandle(
  handle: ReadableHandle,
  displayPath: string,
  maxBytes: number = MAX_IMAGE_READ_BYTES,
  signal?: AbortSignal,
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
  return readNonRegularCapped(handle, displayPath, maxBytes, signal)
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
 * `qXr`/`kAr` string-path/undefined-maxBytes branch (opens RDONLY, defers to
 * the chunked reader). The handle is always closed.
 *
 * CC 2.1.304 #32: optional `signal` threads into the chunked reader
 * (official `kAr(e,n,r)` → `Mbn(s,e,void 0)` passes void 0 for the
 * string-path branch, but the Read-tool path arrives via
 * `q_o(…, pdfRenderSignal??signal)` → `kAr(e,r,S)` and IS threaded; OCC's
 * Read tool calls this function with the tool-context signal).
 */
export async function readImageBytesCapped(
  filePath: string,
  maxBytes: number = MAX_IMAGE_READ_BYTES,
  signal?: AbortSignal,
): Promise<Buffer> {
  const handle = await openForImageRead(filePath)
  try {
    return await readImageBytesFromHandle(handle, filePath, maxBytes, signal)
  } finally {
    // Fix #9 (acceptance review): the close must run on the error path too —
    // an oversized read throws from readImageBytesFromHandle, and without
    // this finally-block the handle (fd) leaks silently.
    await handle.close()
  }
}
