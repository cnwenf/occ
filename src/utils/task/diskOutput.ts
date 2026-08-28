import { constants as fsConstants } from 'fs'
import {
  type FileHandle,
  mkdir,
  open,
  stat,
  symlink,
  unlink,
} from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getErrnoCode } from '../errors.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { logError } from '../log.js'
import { getProjectTempDir } from '../permissions/filesystem.js'

// SECURITY: O_NOFOLLOW prevents following symlinks when opening task output files.
// Without this, an attacker in the sandbox could create symlinks in the tasks directory
// pointing to arbitrary files, causing Claude Code on the host to write to those files.
// O_NOFOLLOW is not available on Windows, but the sandbox attack vector is Unix-only.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024 // 8MB

/**
 * Disk cap for task output files. In file mode (bash), a watchdog polls
 * file size and kills the process. In pipe mode (hooks), DiskTaskOutput
 * drops chunks past this limit. Shared so both caps stay in sync.
 */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

/**
 * Threshold of queued-but-unwritten characters above which a persistently
 * failing drain drops the whole queue and replaces it with the omission
 * marker. Without this, a hook or background task that prints megabytes of
 * output while the disk cannot be written grows the in-memory write queue
 * without bound (2.1.247 fix; official binary constant hlo = 16777216).
 */
const MAX_UNWRITTEN_CHARS_BEFORE_DROP = 16 * 1024 * 1024

/** Written in place of output that could not be persisted to disk. */
const OUTPUT_OMITTED_MARKER =
  '\n[output omitted: it could not be written to disk]\n'

/** Test-only handle to the marker (kept module-private in the official binary). */
export const OUTPUT_OMITTED_MARKER_FOR_TEST = OUTPUT_OMITTED_MARKER

/**
 * Errno codes that mean disk/fd exhaustion. Drain and read failures with
 * these codes get a terse error-level log; anything else is reported as an
 * unexpected error. Verbatim from the 2.1.247 binary (`nn` / `azd` set).
 */
const DISK_EXHAUSTION_ERRNOS = new Set([
  'ENOSPC',
  'EDQUOT',
  'ENFILE',
  'EMFILE',
])

/**
 * Get the task output directory for this session.
 * Uses project temp directory so reads are auto-allowed by checkReadableInternalPath.
 *
 * The session ID is included so concurrent sessions in the same project don't
 * clobber each other's output files. Startup cleanup in one session previously
 * unlinked in-flight output files from other sessions — the writing process's fd
 * keeps the inode alive but reads via path fail ENOENT, and getStdout() returned
 * empty string (inc-4586 / boris-20260309-060423).
 *
 * The session ID is captured at FIRST CALL, not re-read on every invocation.
 * /clear calls regenerateSessionId(), which would otherwise cause
 * ensureOutputDir() to create a new-session path while existing TaskOutput
 * instances still hold old-session paths — open() would ENOENT. Background
 * bash tasks surviving /clear need their output files to stay reachable.
 */
let _taskOutputDir: string | undefined
export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return _taskOutputDir
}

/** Test helper — clears the memoized dir. */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined
}

/**
 * Ensure the task output directory exists
 */
async function ensureOutputDir(): Promise<void> {
  await mkdir(getTaskOutputDir(), { recursive: true })
}

/**
 * Get the output file path for a task
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

// Tracks fire-and-forget promises (initTaskOutput, initTaskOutputAsSymlink,
// evictTaskOutput, #drain) so tests can drain before teardown. Prevents the
// async-ENOENT-after-teardown flake class (#24957, #25065): a voided async
// resumes after preload's afterEach nuked the temp dir → ENOENT → unhandled
// rejection → flaky test failure. allSettled so a rejection doesn't short-
// circuit the drain and leave other ops racing the rmSync.
const _pendingOps = new Set<Promise<unknown>>()
function track<T>(p: Promise<T>): Promise<T> {
  _pendingOps.add(p)
  void p.finally(() => _pendingOps.delete(p)).catch(() => {})
  return p
}

/**
 * Encapsulates async disk writes for a single task's output.
 *
 * Uses a flat array as a write queue processed by a single drain loop,
 * so each chunk can be GC'd immediately after its write completes.
 * This avoids the memory retention problem of chained .then() closures
 * where every reaction captures its data until the whole chain resolves.
 */
export class DiskTaskOutput {
  #path: string
  #fileHandle: FileHandle | null = null
  #queue: string[] = []
  #bytesWritten = 0
  #capped = false
  /** Characters currently queued but not yet written to disk. */
  #unwrittenChars = 0
  /** Incremented on cancel(); lets the drain detect a cancel racing a write. */
  #cancelCount = 0
  /** True while the drain loop is failing to write (see #drain). */
  #failing = false
  /** Dedup keys (`<kind>:<errno>`) for final-failure logs within one failure episode. */
  #seenFailureKeys = new Set<string>()
  /** True once output has been lost (dropped or unwritable) — the file is incomplete. */
  #lostOutput = false
  #flushPromise: Promise<void> | null = null
  #flushResolve: (() => void) | null = null

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId)
  }

  append(content: string): void {
    if (this.#capped) {
      return
    }
    // content.length (UTF-16 code units) undercounts UTF-8 bytes by at most ~3×.
    // Acceptable for a coarse disk-fill guard — avoids re-scanning every chunk.
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      const marker = `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`
      this.#queue.push(marker)
      this.#unwrittenChars += marker.length
    } else {
      this.#queue.push(content)
      this.#unwrittenChars += content.length
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>(resolve => {
        this.#flushResolve = resolve
      })
      void track(this.#drain())
    }
  }

  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve()
  }

  get failing(): boolean {
    return this.#failing
  }

  get lostOutput(): boolean {
    return this.#lostOutput
  }

  get unwrittenChars(): number {
    return this.#unwrittenChars
  }

  cancel(): void {
    this.#cancelCount += 1
    this.#queue.length = 0
    this.#unwrittenChars = 0
  }

  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir()
          this.#fileHandle = await open(
            this.#path,
            process.platform === 'win32'
              ? 'a'
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          )
        }
        while (true) {
          // If cancel() races a write, cancel() already dropped the queued
          // data — don't resurrect an omission marker for it. Only mark
          // lostOutput + unshift the marker when no cancel happened mid-write.
          const cancelCount = this.#cancelCount
          try {
            await this.#writeAllChunks()
          } catch (e) {
            if (this.#cancelCount === cancelCount) {
              this.#lostOutput = true
              this.#queue.unshift(OUTPUT_OMITTED_MARKER)
              this.#unwrittenChars += OUTPUT_OMITTED_MARKER.length
            }
            throw e
          }
          if (this.#queue.length === 0) {
            break
          }
        }
      } finally {
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle
          this.#fileHandle = null
          await fileHandle.close()
        }
      }
      // you could have another .append() while we're waiting for the file to close, so we check the queue again before fully exiting
      if (this.#queue.length) {
        continue
      }

      break
    }
  }

  #writeAllChunks(): Promise<void> {
    // This code is extremely precise.
    // You **must not** add an await here!! That will cause memory to balloon as the queue grows.
    // It's okay to add an `await` to the caller of this method (e.g. #drainAllChunks) because that won't cause Buffer[] to be kept alive in memory.
    return this.#fileHandle!.appendFile(
      // This variable needs to get GC'd ASAP.
      this.#queueToBuffers(),
    )
  }

  /** Keep this in a separate method so that GC doesn't keep it alive for any longer than it should. */
  #queueToBuffers(): Buffer {
    // Use .splice to in-place mutate the array, informing the GC it can free it.
    const queue = this.#queue.splice(0, this.#queue.length)
    // The queue is now empty — the spliced content is in flight to disk;
    // #drain's write-level catch accounts for it again if the write fails.
    this.#unwrittenChars = 0

    let totalLength = 0
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, 'utf8')
    }

    const buffer = Buffer.allocUnsafe(totalLength)
    let offset = 0
    for (const str of queue) {
      offset += buffer.write(str, offset, 'utf8')
    }

    return buffer
  }

  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks()
      this.#clearFailureState()
    } catch (e) {
      // Transient fs errors (EMFILE on busy CI, EPERM on Windows pending-
      // delete) previously rode up through `void this.#drain()` as an
      // unhandled rejection while the flush promise resolved anyway — callers
      // saw an empty file with no error. Retry once for the transient case
      // (queue is intact if open() failed); on a second failure classify the
      // errno, log once per kind+errno, and — if the unwritten queue has
      // grown past MAX_UNWRITTEN_CHARS_BEFORE_DROP — discard it in favor of
      // the omission marker so memory cannot grow unbounded (2.1.247 fix).
      if (!this.#failing) {
        this.#failing = true
        logError(new Error(`Task output drain failed (will retry once): ${e}`))
      }
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks()
          this.#clearFailureState()
        } catch (e2) {
          this.#handleFinalDrainFailure(e2)
        }
      }
    } finally {
      const resolve = this.#flushResolve!
      this.#flushPromise = null
      this.#flushResolve = null
      resolve()
    }
  }

  /** A successful drain ends the failure episode: reset flag + log dedup set. */
  #clearFailureState(): void {
    this.#failing = false
    this.#seenFailureKeys.clear()
  }

  #handleFinalDrainFailure(e: unknown): void {
    const code = getErrnoCode(e)
    const kind =
      code !== undefined && DISK_EXHAUSTION_ERRNOS.has(code)
        ? 'exhaustion'
        : 'unexpected'
    const failureKey = `${kind}:${code ?? 'no errno'}`
    if (!this.#seenFailureKeys.has(failureKey)) {
      this.#seenFailureKeys.add(failureKey)
      if (kind === 'exhaustion') {
        logError(new Error(`Task output drain retry failed (${code}): ${e}`))
      } else {
        logError(e)
      }
    }
    if (this.#unwrittenChars > MAX_UNWRITTEN_CHARS_BEFORE_DROP) {
      logError(
        new Error(
          `Task output still cannot be written (${code ?? 'no errno'}); dropped ${this.#unwrittenChars} chars of unwritten output`,
        ),
      )
      this.#lostOutput = true
      this.#queue.length = 0
      this.#queue.push(OUTPUT_OMITTED_MARKER)
      this.#unwrittenChars = OUTPUT_OMITTED_MARKER.length
    }
  }
}

const outputs = new Map<string, DiskTaskOutput>()

/**
 * Test helper — cancel pending writes, await in-flight ops, clear the map.
 * backgroundShells.test.ts and other task tests spawn real shells that
 * write through this module without afterEach cleanup; their entries
 * leak into diskOutput.test.ts on the same shard.
 *
 * Awaits all tracked promises until the set stabilizes — a settling promise
 * may spawn another (initTaskOutputAsSymlink's catch → initTaskOutput).
 * Call this in afterEach BEFORE rmSync to avoid async-ENOENT-after-teardown.
 */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel()
  }
  while (_pendingOps.size > 0) {
    await Promise.allSettled([..._pendingOps])
  }
  outputs.clear()
}

function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId)
  if (!output) {
    output = new DiskTaskOutput(taskId)
    outputs.set(taskId, output)
  }
  return output
}

/**
 * Log a read/cleanup-side failure the 2.1.247 way: disk-exhaustion errno codes
 * get a terse error-level message (expected condition, e.g. a full disk);
 * anything else is reported as an unexpected error.
 */
function logTaskOutputFailure(context: string, e: unknown): void {
  const code = getErrnoCode(e)
  if (code && DISK_EXHAUSTION_ERRNOS.has(code)) {
    logError(new Error(`${context} failed (${code}): ${e}`))
  } else {
    logError(e)
  }
}

/**
 * Append output to a task's disk file asynchronously.
 * Creates the file if it doesn't exist.
 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content)
}

/**
 * Wait for all pending writes for a task to complete.
 * Useful before reading output to ensure all data is flushed.
 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    await output.flush()
  }
}

/**
 * Evict a task's DiskTaskOutput from the in-memory map after flushing.
 * Unlike cleanupTaskOutput, this does not delete the output file on disk.
 * Call this when a task completes and its output has been consumed.
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  return track(
    (async () => {
      const output = outputs.get(taskId)
      if (output) {
        await output.flush()
        if (output.failing && output.unwrittenChars > 0) {
          logError(
            new Error(
              `Task output writer evicted while failing; discarded ${output.unwrittenChars} chars of unwritten output`,
            ),
          )
        }
        outputs.delete(taskId)
      }
    })(),
  )
}

/**
 * Get delta (new content) since last read.
 * Reads only from the byte offset, up to maxBytes — never loads the full file.
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(
      getTaskOutputPath(taskId),
      fromOffset,
      maxBytes,
    )
    if (!result) {
      return { content: '', newOffset: fromOffset }
    }
    return {
      content: result.content,
      newOffset: fromOffset + result.bytesRead,
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return { content: '', newOffset: fromOffset }
    }
    logTaskOutputFailure('getTaskOutputDelta', e)
    return { content: '', newOffset: fromOffset }
  }
}

/**
 * Get output for a task, reading the tail of the file.
 * Caps at maxBytes to avoid loading multi-GB files into memory.
 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      maxBytes,
    )
    if (bytesTotal > bytesRead) {
      return `[${Math.round((bytesTotal - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`
    }
    return content
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return ''
    }
    logTaskOutputFailure('getTaskOutput', e)
    return ''
  }
}

/**
 * Get the current size (offset) of a task's output file.
 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return 0
    }
    logTaskOutputFailure('getTaskOutputSize', e)
    return 0
  }
}

/**
 * Clean up a task's output file and write queue.
 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    output.cancel()
    outputs.delete(taskId)
  }

  try {
    await unlink(getTaskOutputPath(taskId))
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    logTaskOutputFailure('cleanupTaskOutput', e)
  }
}

/**
 * Initialize output file for a new task.
 * Creates an empty file to ensure the path exists.
 */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(
    (async () => {
      await ensureOutputDir()
      const outputPath = getTaskOutputPath(taskId)
      // SECURITY: O_NOFOLLOW prevents symlink-following attacks from the sandbox.
      // O_EXCL ensures we create a new file and fail if something already exists at this path.
      // On Windows, use string flags — numeric O_EXCL can produce EINVAL through libuv.
      const fh = await open(
        outputPath,
        process.platform === 'win32'
          ? 'wx'
          : fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              O_NOFOLLOW,
      )
      await fh.close()
      return outputPath
    })(),
  )
}

/**
 * Initialize output file as a symlink to another file (e.g., agent transcript).
 * Tries to create the symlink first; if a file already exists, removes it and retries.
 */
export function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  return track(
    (async () => {
      try {
        await ensureOutputDir()
        const outputPath = getTaskOutputPath(taskId)

        try {
          await symlink(targetPath, outputPath)
        } catch {
          await unlink(outputPath)
          await symlink(targetPath, outputPath)
        }

        return outputPath
      } catch (error) {
        logError(error)
        return initTaskOutput(taskId)
      }
    })(),
  )
}
