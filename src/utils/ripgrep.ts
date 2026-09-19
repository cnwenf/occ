import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile, spawn } from 'child_process'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import { logEvent } from 'src/services/analytics/index.js'
import { fileURLToPath } from 'url'
import { isInBundledMode } from './bundledMode.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { parseEnvInt } from './envValidation.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'
import { countCharInString } from './stringUtils.js'

const __filename = fileURLToPath(import.meta.url)
// we use node:path.join instead of node:url.resolve because the former doesn't encode spaces
const __dirname = path.join(
  __filename,
  process.env.NODE_ENV === 'test' ? '../../../' : '../',
)

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
}

const getRipgrepConfig = memoize((): RipgrepConfig => {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    process.env.USE_BUILTIN_RIPGREP,
  )

  // Try system ripgrep if user wants it
  if (userWantsSystemRipgrep) {
    const { cmd: systemPath } = findExecutable('rg', [])
    if (systemPath !== 'rg') {
      // SECURITY: Use command name 'rg' instead of systemPath to prevent PATH hijacking
      // If we used systemPath, a malicious ./rg.exe in current directory could be executed
      // Using just 'rg' lets the OS resolve it safely with NoDefaultCurrentDirectoryInExePath protection
      return { mode: 'system', command: 'rg', args: [] }
    }
  }

  // In bundled (native) mode, ripgrep is statically compiled into bun-internal
  // and dispatches based on argv[0]. We spawn ourselves with argv0='rg'.
  if (isInBundledMode()) {
    return {
      mode: 'embedded',
      command: process.execPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  const rgRoot = path.resolve(__dirname, 'vendor', 'ripgrep')
  const command =
    process.platform === 'win32'
      ? path.resolve(rgRoot, `${process.arch}-win32`, 'rg.exe')
      : path.resolve(rgRoot, `${process.arch}-${process.platform}`, 'rg')

  // Fallback: if the builtin rg binary doesn't exist (e.g. npm install
  // without the vendor/ dir), try system rg, then 'grep -rn' as last resort.
  try {
    const fs = require('fs')
    if (fs.existsSync(command)) {
      return { mode: 'builtin', command, args: [] }
    }
  } catch {}
  // Try system rg
  const { cmd: systemRg } = findExecutable('rg', [])
  if (systemRg !== 'rg') {
    return { mode: 'system', command: 'rg', args: [] }
  }
  // Last resort: grep (recursive + line numbers; limited but functional)
  return { mode: 'system', command: 'grep', args: ['-rn'] }
})

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

// 2.1.275 (binary Ljt): capped output is decoded in 1MB slices. Accumulating
// into one growing string is O(n²) in copy work — a 20MB flood stalled the
// event loop (and could OOM) before ripgrep was ever reaped.
const DECODE_CHUNK_SIZE = 1_048_576

// Node/Bun's own code for an execFile maxBuffer overflow. The embedded-rg
// spawn path reports overflow with the same code so `handleResult` has a
// single discriminator for both paths.
const MAXBUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

// SIGTERM may be ignored while ripgrep is blocked in uninterruptible I/O;
// escalate to SIGKILL after this delay.
const KILL_ESCALATION_DELAY_MS = 5_000

/**
 * Byte-capped, incrementally-decoded output accumulator.
 *
 * Mirrors the official 2.1.275 `CappedOutputBuffer` (binary `eqe`): bytes are
 * appended to a bounded budget, decoded through a `StringDecoder` in
 * `DECODE_CHUNK_SIZE` slices, and stored as `pieces[]` so peak memory stays
 * proportional to the cap instead of to the concat churn of one big string.
 * A `StringDecoder` (not `TextDecoder`) is used so a multi-byte character
 * split across a slice or chunk boundary decodes intact.
 */
export class CappedOutputBuffer {
  readonly maxBytes: number
  truncated = false
  private readonly decoder = new StringDecoder('utf8')
  private pieces: string[] = []
  private byteLength = 0

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  /**
   * Store `chunk`, clipping it to the remaining budget.
   *
   * @returns true exactly once — on the chunk that crossed the cap. Later
   *   chunks are dropped and return false (the caller kills the child on the
   *   first true, so nothing more should arrive).
   */
  append(chunk: Buffer): boolean {
    if (this.truncated) {
      return false
    }
    const remaining = this.maxBytes - this.byteLength
    const fits = chunk.length <= remaining
    const accepted = fits ? chunk : chunk.subarray(0, remaining)
    this.byteLength += accepted.length
    for (let offset = 0; offset < accepted.length; offset += DECODE_CHUNK_SIZE) {
      this.pieces.push(
        this.decoder.write(
          accepted.subarray(offset, offset + DECODE_CHUNK_SIZE),
        ),
      )
    }
    if (!fits) {
      this.truncated = true
    }
    return !fits
  }

  /** Drain the accumulated text, flushing any incomplete trailing sequence. */
  takeText(): string {
    const pieces = this.pieces
    this.pieces = []
    pieces.push(this.decoder.end())
    return pieces.join('')
  }

  /** Drop the buffered text without decoding a flush (error path). */
  release(): void {
    this.pieces = []
  }
}

/**
 * The `<stream> maxBuffer length exceeded` error Node/Bun's execFile raises on
 * overflow. The embedded-rg spawn path synthesizes the same shape so
 * `handleResult` treats both paths identically.
 */
function maxBufferError(stream: 'stdout' | 'stderr'): ExecFileException {
  const error: ExecFileException = new Error(
    `${stream} maxBuffer length exceeded`,
  )
  error.code = MAXBUFFER_ERROR_CODE
  return error
}

/**
 * 2.1.275 (binary `oqe`): collecting ripgrep output itself failed — a handler
 * threw mid-stream. Distinct from "no matches" and from "output over cap".
 */
export class RipgrepOutputError extends Error {
  name = 'RipgrepOutputError'
}

/**
 * Byte-exact 2.1.275 message (binary `Xjt`). `cause` is normalized to an
 * Error first (binary `ue`) so `.message` always exists.
 */
function ripgrepOutputCollectionError(cause: unknown): RipgrepOutputError {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new RipgrepOutputError(
    `Failed to collect ripgrep output: ${error.message}. If the search matches a very large amount of text, try a more specific path or pattern.`,
    { cause: error },
  )
}

/**
 * 2.1.275 (binary `Zjt`): ripgrep blew the output cap before a single
 * complete line was read. Without this the caller saw `[]` and rendered
 * "No matches found" / "No files found" for a search that never really ran —
 * the misreport fixed upstream (a >20MB stderr flood of e.g. per-file
 * permission warnings, or one extremely long matching line on stdout).
 */
export class RipgrepOutputTooLargeError extends Error {
  constructor(stream: 'stdout' | 'stderr') {
    super(
      stream === 'stdout'
        ? `Ripgrep output passed the ${MAX_BUFFER_SIZE / 1e6}MB limit before a single complete line was read, so there are no usable results: at least one matching line is extremely long. Try a more specific pattern or path, or exclude very large files.`
        : `Ripgrep produced more than ${MAX_BUFFER_SIZE / 1e6}MB of error output (for example per-file permission warnings) before any result line, so the search is incomplete. Try a more specific path.`,
    )
    this.name = 'RipgrepOutputTooLargeError'
  }
}

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

// 2.1.208 #14b: ripgrep exit code 2 with a pattern-parse-error stderr means
// the regex/glob/type was invalid — NOT "no matches". Surfaces as a tool error
// so the model can correct the pattern instead of seeing "No files found".
// Mirrors binary FYh regex and K6c (RipgrepUsageError).
const RG_PATTERN_ERROR_REGEX =
  /^rg: (?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m

export class SearchPatternError extends Error {
  constructor(public readonly stderr: string) {
    super(
      `Search failed \u2014 ripgrep rejected the pattern, glob, or file type without searching:\n${stderr.trim().slice(0, 2000)}`,
    )
    this.name = 'RipgrepUsageError'
  }
}

// 2.1.208 #14d: null byte in args/target/cwd would cause spawn to fail with
// a cryptic error. Mirrors binary Y6c (RipgrepNullByteError).
export class RipgrepNullByteError extends Error {
  name = 'RipgrepNullByteError'
}

// Options for ripGrep.  rejectOnInputError (binary n?.rejectOnInputError)
// converts invalid-pattern exit-code-2 into a rejected promise instead of
// silently returning [].
export type RipGrepOptions = {
  rejectOnInputError?: boolean
}

// 2.1.208 #14d: Returns the error message for a null-byte in args/target/cwd,
// or null if no null byte is found. Priority: cwd > target > args (matches
// binary X6c). The returned string is the full error message.
function checkRipgrepNullByte(
  args: string[],
  target: string,
  cwd: string,
): string | null {
  let local: string | null = null
  if (cwd.includes('\x00')) {
    local = 'the session working directory'
  } else if (target.includes('\x00')) {
    local = 'the target path'
  } else {
    const argIdx = args.findIndex(a => a.includes('\x00'))
    if (argIdx !== -1) {
      local = `caller argument ${argIdx}`
    }
  }
  if (local) {
    return `Cannot spawn ripgrep: ${local} contains a null byte (\\0)`
  }
  return null
}

// ---------------------------------------------------------------------------
// Embedded-rg (argv0) output collection — 2.1.275 `Wjt` collect side
// ---------------------------------------------------------------------------
// Module-level named handlers over a state object (the same shape
// readFileInRange's streaming path uses) so each stays small and testable.

export type RipgrepCollectCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void

export type RipgrepCollectorOptions = {
  callback: RipgrepCollectCallback
  /** Kill escalation deadline for the whole run (ms). */
  timeoutMs: number
  /** Per-stream byte cap. Defaults to MAX_BUFFER_SIZE; tests may lower it. */
  maxBytes?: number
}

type CollectorState = {
  child: ChildProcess
  stdoutBuffer: CappedOutputBuffer
  stderrBuffer: CappedOutputBuffer
  callback: RipgrepCollectCallback
  settled: boolean
  timeoutId: ReturnType<typeof setTimeout> | undefined
  killTimeoutId: ReturnType<typeof setTimeout> | undefined
}

/** Settle exactly once — on Windows both 'close' and 'error' can fire. */
function settleCollector(
  state: CollectorState,
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): void {
  if (state.settled) {
    return
  }
  state.settled = true
  clearTimeout(state.timeoutId)
  clearTimeout(state.killTimeoutId)
  state.callback(error, stdout, stderr)
}

/** SIGKILL cannot be caught or ignored; swallow ESRCH on an already-dead child. */
function killCollectorChild(state: CollectorState): void {
  try {
    state.child.kill('SIGKILL')
  } catch {
    // Child already reaped — nothing to kill.
  }
}

/**
 * A collector handler threw (binary `ft`): drop the buffered text, settle with
 * a RipgrepOutputError so the promise always resolves or rejects, then kill.
 */
function failCollector(state: CollectorState, cause: unknown): void {
  if (state.settled) {
    return
  }
  state.stdoutBuffer.release()
  state.stderrBuffer.release()
  settleCollector(state, ripgrepOutputCollectionError(cause), '', '')
  killCollectorChild(state)
}

/**
 * The overflow error for this run, or undefined when neither stream truncated.
 * stdout wins — it is the stream that carries results, and the official
 * collector kills the child the instant stdout crosses the cap.
 */
function collectorOverflowError(
  state: CollectorState,
): ExecFileException | undefined {
  if (state.stdoutBuffer.truncated) {
    return maxBufferError('stdout')
  }
  if (state.stderrBuffer.truncated) {
    return maxBufferError('stderr')
  }
  return undefined
}

function collectorOnStdout(state: CollectorState, chunk: Buffer): void {
  try {
    // Cap exceeded → kill immediately instead of draining a flood we will
    // never return (binary: `if(!settled && stdoutBuf.append(chunk)) kill()`).
    if (!state.settled && state.stdoutBuffer.append(chunk)) {
      killCollectorChild(state)
    }
  } catch (cause) {
    failCollector(state, cause)
  }
}

function collectorOnStderr(state: CollectorState, chunk: Buffer): void {
  try {
    // stderr is diagnostics only — cap it, but never kill a search that is
    // still producing results.
    if (!state.settled) {
      state.stderrBuffer.append(chunk)
    }
  } catch (cause) {
    failCollector(state, cause)
  }
}

function collectorOnClose(
  state: CollectorState,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  try {
    if (state.settled) {
      return
    }
    const stdout = state.stdoutBuffer.takeText()
    const stderr = state.stderrBuffer.takeText()
    const overflow = collectorOverflowError(state)
    // 0 = matches found, 1 = no matches (both are success) — but a truncated
    // stream is never a silent success.
    if (code === 0 || code === 1) {
      settleCollector(state, overflow ?? null, stdout, stderr)
      return
    }
    const error: ExecFileException = new Error(
      `ripgrep exited with code ${code}`,
    )
    error.code = code ?? undefined
    error.signal = signal ?? undefined
    settleCollector(state, overflow ?? error, stdout, stderr)
  } catch (cause) {
    failCollector(state, cause)
  }
}

function collectorOnError(state: CollectorState, err: NodeJS.ErrnoException): void {
  try {
    if (state.settled) {
      return
    }
    settleCollector(
      state,
      collectorOverflowError(state) ?? err,
      state.stdoutBuffer.takeText(),
      state.stderrBuffer.takeText(),
    )
  } catch (cause) {
    failCollector(state, cause)
  }
}

/**
 * Attach capped stdout/stderr collectors, the timeout kill escalation, and the
 * settle-once close/error handlers to an already-spawned ripgrep child.
 *
 * Exported for tests: the embedded (argv0) branch is unreachable under
 * `bun test` because the runtime is not a compiled binary.
 */
export function startRipgrepCollector(
  child: ChildProcess,
  options: RipgrepCollectorOptions,
): ChildProcess {
  const maxBytes = options.maxBytes ?? MAX_BUFFER_SIZE
  const state: CollectorState = {
    child,
    stdoutBuffer: new CappedOutputBuffer(maxBytes),
    stderrBuffer: new CappedOutputBuffer(maxBytes),
    callback: options.callback,
    settled: false,
    timeoutId: undefined,
    killTimeoutId: undefined,
  }

  // Set up timeout with SIGKILL escalation.
  // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
  // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
  // escalate to SIGKILL which cannot be caught or ignored.
  // On Windows, child.kill('SIGTERM') throws; use default signal.
  state.timeoutId = setTimeout(() => {
    if (process.platform === 'win32') {
      child.kill()
    } else {
      child.kill('SIGTERM')
      state.killTimeoutId = setTimeout(
        c => c.kill('SIGKILL'),
        KILL_ESCALATION_DELAY_MS,
        child,
      )
    }
  }, options.timeoutMs)

  child.stdout?.on('data', (chunk: Buffer) => collectorOnStdout(state, chunk))
  child.stderr?.on('data', (chunk: Buffer) => collectorOnStderr(state, chunk))
  child.on('close', (code, signal) => collectorOnClose(state, code, signal))
  child.on('error', (err: NodeJS.ErrnoException) =>
    collectorOnError(state, err),
  )

  return child
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseEnvInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS) ?? 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

    // 2.1.275: capped, incrementally-decoded collection with kill-on-overflow
    // and settle-once handlers — never a silent success on truncated output.
    return startRipgrepCollector(child, { callback, timeoutMs: timeout })
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    rgPath,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
    },
    callback,
  )
}

/**
 * Stream-count lines from `rg --files` without buffering stdout.
 *
 * On large repos (e.g. 247k files, 16MB of paths), calling `ripGrep()` just
 * to read `.length` materializes the full stdout string plus a 247k-element
 * array. This counts newline bytes per chunk instead; peak memory is one
 * stream chunk (~64KB).
 *
 * Intentionally minimal: the only caller is telemetry (countFilesRoundedRg),
 * which swallows all errors. No EAGAIN retry, no stderr capture, no internal
 * timeout (callers pass AbortSignal.timeout; spawn's signal option kills rg).
 */
async function ripGrepFileCount(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<number>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let lines = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      lines += countCharInString(chunk, '\n')
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0 || code === 1) resolve(lines)
      else reject(new Error(`rg --files exited ${code}`))
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
    let remainder = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString()
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return
      settled = true
      if (code === 0 || code === 1) {
        if (remainder) onLines([stripCR(remainder)])
        resolve()
      } else {
        reject(new Error(`ripgrep exited with code ${code}`))
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  options?: RipGrepOptions,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // 2.1.208 #14d: Reject null bytes in args/target/cwd before spawning
  // ripgrep — a null byte causes a cryptic spawn failure. Mirrors binary
  // X6c(args, target, cwd) with priority cwd > target > args.
  const cwd = getCwd()
  const nullByteError = checkRipgrepNullByte(args, target, cwd)
  if (nullByteError) {
    throw new RipgrepNullByteError(nullByteError)
  }

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // 2.1.275 (binary `o8`): output collection itself failed — surface it
      // instead of falling through to a "no matches" style result.
      if (error instanceof RipgrepOutputError) {
        reject(error)
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        reject(error)
        return
      }

      const isBufferOverflow = error.code === MAXBUFFER_ERROR_CODE

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      // 2.1.275: an output-cap overflow whose truncated stderr happens to
      // mention EAGAIN must NOT retry — the retry would flood the same way
      // (binary: `!isRetry && !isBufferOverflow && isEagainError(stderr)`).
      if (!isRetry && !isBufferOverflow && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        logEvent('tengu_ripgrep_eagain_retry', {})
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            safeHandleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow - it may be incomplete
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // 2.1.275 (binary `o8`): the cap was hit before a single complete line
      // was read, so `[]` would misreport the search as "no matches". The
      // `startsWith('stderr')` discriminator matches Node/Bun's own execFile
      // overflow message ("stderr maxBuffer length exceeded") — the system-rg
      // warning-flood case.
      if (isBufferOverflow && lines.length === 0 && options?.rejectOnInputError) {
        reject(
          new RipgrepOutputTooLargeError(
            error.message.startsWith('stderr') ? 'stderr' : 'stdout',
          ),
        )
        return
      }

      // If we timed out with no results, throw an error so Claude knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      // 2.1.208 #14b: exit code 2 + pattern-parse-error stderr = invalid regex/
      // glob/type, not "no matches". Reject so the model sees a tool error
      // instead of silently returning "No files found".
      // Binary: n?.rejectOnInputError && a.code===2 && y.length===0 && FYh.test(c)
      if (
        options?.rejectOnInputError &&
        error.code === 2 &&
        lines.length === 0 &&
        RG_PATTERN_ERROR_REGEX.test(stderr)
      ) {
        reject(new SearchPatternError(stderr))
        return
      }

      resolve(lines)
    }

    // 2.1.275 (binary `o8`'s `w` wrapper): handleResult runs inside a
    // child_process callback — a throw there escapes to the event loop and the
    // promise never settles (the reported hang). Route every result, retry
    // included, through this guard so the promise always settles.
    const safeHandleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      try {
        handleResult(error, stdout, stderr, isRetry)
      } catch (cause) {
        if (cause instanceof RangeError) {
          reject(ripgrepOutputCollectionError(cause))
          return
        }
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      safeHandleResult(error, stdout, stderr, false)
    })
  })
}

/**
 * Count files in a directory recursively using ripgrep and round to the nearest power of 10 for privacy
 *
 * This is much more efficient than using native Node.js methods for counting files
 * in large directories since it uses ripgrep's highly optimized file traversal.
 *
 * @param path Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRoundedRg = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      // Build ripgrep arguments:
      // --files: List files that would be searched (rather than searching them)
      // --count: Only print a count of matching lines for each file
      // --no-ignore-parent: Don't respect ignore files in parent directories
      // --hidden: Search hidden files and directories
      const args = ['--files', '--hidden']

      // Add ignore patterns if provided
      ignorePatterns.forEach(pattern => {
        args.push('--glob', `!${pattern}`)
      })

      const count = await ripGrepFileCount(args, dirPath, abortSignal)

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = Math.pow(10, magnitude)

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // AbortSignal.timeout firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
