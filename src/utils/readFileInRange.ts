// ---------------------------------------------------------------------------
// readFileInRange — line-oriented file reader with two code paths
// ---------------------------------------------------------------------------
//
// Returns lines [offset, offset + maxLines) from a file.
//
// Fast path (regular files < 10 MB):
//   Opens the file, stats the fd, reads the whole file with readFile(),
//   then splits lines in memory.  This avoids the per-chunk async overhead
//   of createReadStream and is ~2x faster for typical source files.
//
// Streaming path (large files, pipes, devices, etc.):
//   Uses createReadStream with manual indexOf('\n') scanning.  Content is
//   only accumulated for lines inside the requested range — lines outside
//   the range are counted (for totalLines) but discarded, so reading line
//   1 of a 100 GB file won't balloon RSS.
//
//   All event handlers (streamOnOpen/Data/End) are module-level named
//   functions with zero closures.  State lives in a StreamState object;
//   handlers access it via `this`, bound at registration time.
//
//   Lifecycle: `open`, `end`, and `error` use .once() (auto-remove).
//   `data` fires until the stream ends or is destroyed — either way the
//   stream and state become unreachable together and are GC'd.
//
//   On error (including maxBytes exceeded), stream.destroy(err) emits
//   'error' → reject (passed directly to .once('error')).
//
// Both paths strip UTF-8 BOM and \r (CRLF → LF).
//
// mtime comes from fstat/stat on the already-open fd — no extra open().
//
// maxBytes behavior depends on options.truncateOnByteLimit:
//   false (default): legacy semantics — throws FileTooLargeError if the FILE
//     size (fast path) or total streamed bytes (streaming) exceed maxBytes.
//   true: caps SELECTED OUTPUT at maxBytes.  Stops at the last complete line
//     that fits; sets truncatedByBytes in the result.  Never throws.
// ---------------------------------------------------------------------------

import { createReadStream, fstat } from 'fs'
import { stat as fsStat, readFile } from 'fs/promises'
import { formatFileSize } from './format.js'

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean
}

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

// 2.1.208 #30: Thrown when a ranged read's SELECTED content (including a
// single very long line without newlines) exceeds maxSelectedBytes. Mirrors
// binary Wtr / SelectedRangeTooLargeError.
export class SelectedRangeTooLargeError extends Error {
  constructor(
    public selectedBytes: number,
    public maxSelectedBytes: number,
  ) {
    super(
      `The requested line range contains over ${formatFileSize(maxSelectedBytes)} of text, more than a read can return. Use a smaller limit — or, if a single line is this large, no limit will fit it: search for specific content instead.`,
    )
    this.name = 'SelectedRangeTooLargeError'
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean; maxSelectedBytes?: number },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted()
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false
  let maxSelectedBytes = options?.maxSelectedBytes

  // stat to decide the code path and guard against OOM.
  // For regular files under 10 MB: readFile + in-memory split (fast).
  // Everything else (large files, FIFOs, devices): streaming.
  const stats = await fsStat(filePath)

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    )
  }

  // 2.1.208 #30: If the whole file fits within maxSelectedBytes, the cap can
  // never trigger — drop it to avoid per-line byte accounting overhead.
  // Binary: if(a!==void 0&&l.isFile()&&l.size<=a)a=void 0
  if (maxSelectedBytes !== undefined && stats.isFile() && stats.size <= maxSelectedBytes) {
    maxSelectedBytes = undefined
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }

    const text = await readFile(filePath, { encoding: 'utf8', signal })
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
      maxSelectedBytes,
    )
  }

  return readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
    maxSelectedBytes,
  )
}

// ---------------------------------------------------------------------------
// Fast path — readFile + in-memory split
// ---------------------------------------------------------------------------

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
  maxSelectedBytes: number | undefined,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  // Strip BOM.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  // Split lines, strip \r, select range.
  const selectedLines: string[] = []
  let lineIndex = 0
  let startPos = 0
  let newlinePos: number
  let selectedBytes = 0
  let truncatedByBytes = false

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined || maxSelectedBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line)
      if (truncateAtBytes !== undefined && nextBytes > truncateAtBytes) {
        truncatedByBytes = true
        return false
      }
      // 2.1.208 #30: throw (not truncate) when the selected range exceeds
      // maxSelectedBytes — a single long line would otherwise OOM.
      if (maxSelectedBytes !== undefined && nextBytes > maxSelectedBytes) {
        throw new SelectedRangeTooLargeError(nextBytes, maxSelectedBytes)
      }
      selectedBytes = nextBytes
    }
    selectedLines.push(line)
    return true
  }

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      tryPush(line)
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  // Final fragment (no trailing newline).
  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    tryPush(line)
  }
  lineIndex++

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming path — createReadStream + event handlers
// ---------------------------------------------------------------------------

type StreamState = {
  stream: ReturnType<typeof createReadStream>
  offset: number
  endLine: number
  maxBytes: number | undefined
  maxSelectedBytes: number | undefined
  truncateOnByteLimit: boolean
  resolve: (value: ReadFileRangeResult) => void
  totalBytesRead: number
  selectedBytes: number
  truncatedByBytes: boolean
  currentLineIndex: number
  selectedLines: string[]
  partial: string
  partialBytes: number
  isFirstChunk: boolean
  resolveMtime: (ms: number) => void
  mtimeReady: Promise<number>
}

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs)
  })
}

function streamOnData(this: StreamState, chunk: string): void {
  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }

  this.totalBytesRead += Buffer.byteLength(chunk)
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    )
    return
  }

  // 2.1.208 #30: o = this.partialBytes + r — the ACCUMULATED byte count of
  // the carried-over partial plus this chunk. Mirrors binary gXg: `let n=...,
  // o=this.partialBytes+r; this.partial=""; this.partialBytes=0;`. When the
  // selected range has no newline (startPos===0), the partial grows across
  // chunks and o is the running total — a single long line is rejected once
  // it crosses maxSelectedBytes, regardless of chunk boundaries. (The prior
  // impl used Buffer.byteLength(chunk) for the startPos===0 case, which
  // under-counted the accumulated partial and let a multi-chunk long line
  // blow past the cap.)
  const chunkBytes = Buffer.byteLength(chunk)
  const accumulatedPartialBytes = this.partialBytes + chunkBytes
  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''
  this.partialBytes = 0

  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      let line = data.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      const truncateMode = this.truncateOnByteLimit && this.maxBytes !== undefined
      if (truncateMode || this.maxSelectedBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (truncateMode && nextBytes > this.maxBytes!) {
          // Cap hit — collapse the selection range so nothing more is
          // accumulated.  Stream continues (to count totalLines).
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
        } else if (
          this.maxSelectedBytes !== undefined &&
          nextBytes > this.maxSelectedBytes
        ) {
          // 2.1.208 #30: a single line (or cumulative range) exceeds the
          // selected-bytes cap — destroy with SelectedRangeTooLargeError.
          this.stream.destroy(
            new SelectedRangeTooLargeError(nextBytes, this.maxSelectedBytes),
          )
          return
        } else {
          this.selectedBytes = nextBytes
          this.selectedLines.push(line)
        }
      } else {
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
    startPos = newlinePos + 1
  }

  // Only keep the trailing fragment when inside the selected range.
  // Outside the range we just count newlines — discarding prevents
  // unbounded memory growth on huge single-line files.
  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos)
      // Binary: l = i===0 ? o : Buffer.byteLength(a). o = accumulated partial
      // bytes (carried over + this chunk); a = fragment after the last newline.
      const fragBytes =
        startPos === 0 ? accumulatedPartialBytes : Buffer.byteLength(fragment)
      const truncateMode = this.truncateOnByteLimit && this.maxBytes !== undefined
      if (truncateMode || this.maxSelectedBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + fragBytes
        if (truncateMode && nextBytes > this.maxBytes!) {
          // In truncate mode, `partial` can grow unboundedly if the selected
          // range contains a huge single line (no newline across many chunks).
          // Once the fragment alone would overflow the remaining budget, we know
          // the completed line can never fit — set truncated, collapse the
          // selection range, and discard the fragment to stop accumulation.
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
          return
        }
        if (
          this.maxSelectedBytes !== undefined &&
          nextBytes > this.maxSelectedBytes
        ) {
          // 2.1.208 #30: the partial (incomplete) line alone already exceeds
          // the cap — destroy with SelectedRangeTooLargeError before the
          // partial grows further.
          this.stream.destroy(
            new SelectedRangeTooLargeError(nextBytes, this.maxSelectedBytes),
          )
          return
        }
      }
      this.partial = fragment
      this.partialBytes = fragBytes
    }
  }
}

function streamOnEnd(this: StreamState): void {
  let line = this.partial
  if (line.endsWith('\r')) {
    line = line.slice(0, -1)
  }
  if (
    this.currentLineIndex >= this.offset &&
    this.currentLineIndex < this.endLine
  ) {
    const truncateMode = this.truncateOnByteLimit && this.maxBytes !== undefined
    if (truncateMode || this.maxSelectedBytes !== undefined) {
      const sep = this.selectedLines.length > 0 ? 1 : 0
      // Use partialBytes (tracked in streamOnData) for the final line's byte
      // length — matches binary yXg which uses this.partialBytes.
      const nextBytes =
        this.selectedBytes + sep + (this.partialBytes || Buffer.byteLength(line))
      if (truncateMode && nextBytes > this.maxBytes!) {
        this.truncatedByBytes = true
      } else if (
        this.maxSelectedBytes !== undefined &&
        nextBytes > this.maxSelectedBytes
      ) {
        // 2.1.208 #30: final partial line exceeds the cap.
        this.mtimeReady.then(() => {
          this.stream.destroy(
            new SelectedRangeTooLargeError(nextBytes, this.maxSelectedBytes!),
          )
        })
        return
      } else {
        this.selectedBytes = nextBytes
        this.selectedLines.push(line)
      }
    } else {
      this.selectedLines.push(line)
    }
  }
  this.currentLineIndex++

  const content = this.selectedLines.join('\n')
  const truncated = this.truncatedByBytes
  this.mtimeReady.then(mtimeMs => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    })
  })
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
  maxSelectedBytes?: number,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    const state: StreamState = {
      stream: createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      maxSelectedBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      partialBytes: 0,
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    }
    state.mtimeReady = new Promise<number>(r => {
      state.resolveMtime = r
    })

    state.stream.once('open', streamOnOpen.bind(state))
    state.stream.on('data', streamOnData.bind(state))
    state.stream.once('end', streamOnEnd.bind(state))
    state.stream.once('error', reject)
  })
}
