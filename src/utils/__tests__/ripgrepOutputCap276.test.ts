/**
 * CC 2.1.275/2.1.276 (ITEM I) — ripgrep output-cap overhaul.
 *
 * Official v274 accumulated child output with `stdout += chunk.toString()` up
 * to the 20MB cap, silently discarded the truncation flag, never killed the
 * child, and resolved `callback(null, stdout, stderr)` on exit 0/1. A >20MB
 * stderr flood (e.g. per-file permission warnings from system rg) or a single
 * extremely long matching line therefore surfaced as "No matches found" /
 * "No files found", and a throw inside the result callback escaped to the
 * event loop, leaving the promise pending forever.
 *
 * Official v276, byte-extracted from /tmp/cc-diff-276/v276/package/claude:
 *   @196377150  class eqe (CappedOutputBuffer): 1MB-slice StringDecoder decode
 *               into pieces[], `if(!r)this.truncated=!0;return!r`
 *   @196378383  class oqe: `name="RipgrepOutputError"`
 *   @196378438  Xjt: `Failed to collect ripgrep output: ${e.message}. If the
 *               search matches a very large amount of text, try a more
 *               specific path or pattern.`
 *   @196379998  class Zjt (RipgrepOutputTooLargeError): the two messages below
 *   @196386900  Wjt collect side: `if(!Ye&&Me.append(Qt))at()` (SIGKILL on
 *               stdout overflow), `bt=()=>{let Qt=Error("stdout maxBuffer
 *               length exceeded");Qt.code="ERR_CHILD_PROCESS_STDIO_MAXBUFFER"}`,
 *               `ft=` release + settle(RipgrepOutputError) + kill
 *   @196389600  o8 result side: `if(_e&&Ie.length===0&&s?.rejectOnInputError)
 *               {h(new Zjt(O.message.startsWith("stderr")?"stderr":"stdout"))}`,
 *               EAGAIN retry gained `!_e`, callback wrapped in try/catch
 *               (`h(he instanceof RangeError?Xjt(he):ue(he))`).
 *
 * Both collect paths are exercised: the execFile path for real (a fake `rg` on
 * PATH that floods at the production 20MB cap — each run is ~50ms) and the
 * embedded/argv0 spawn path through the exported collector with an injected
 * cap (the argv0 branch is unreachable under `bun test` because the runtime is
 * not a compiled binary).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { ChildProcess, ExecFileException } from 'child_process'
import { EventEmitter } from 'events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Test double for `rg`
// ---------------------------------------------------------------------------

const FLOOD_CHUNKS = 21 // 21MB — just over the production 20MB cap

const FAKE_RG_SOURCE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_RG_MODE || 'passthrough'
const realRg = process.env.FAKE_RG_REAL_PATH || 'rg'

let invocation = 0
if (process.env.FAKE_RG_COUNT_FILE) {
  appendFileSync(process.env.FAKE_RG_COUNT_FILE, 'x')
  invocation = readFileSync(process.env.FAKE_RG_COUNT_FILE, 'utf8').length
}
if (process.env.FAKE_RG_ARGS_FILE) {
  appendFileSync(process.env.FAKE_RG_ARGS_FILE, JSON.stringify(argv) + '\\n')
}

if (mode === 'passthrough') {
  const res = Bun.spawnSync([realRg, ...argv], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(res.exitCode === null ? 1 : res.exitCode)
}

if (mode === 'exit-3') {
  process.stderr.write('rg: fatal failure while searching\\n')
  process.exit(3)
}

if (mode === 'lines') {
  process.stdout.write('alpha\\nbeta\\ngamma\\n')
  process.exit(0)
}

if (mode === 'no-matches') {
  process.exit(1)
}

// Transient EAGAIN on the first spawn only: the -j 1 retry must succeed.
if (mode === 'eagain-then-ok') {
  if (invocation === 1) {
    process.stderr.write('rg: thread pool spawn failed: os error 11\\n')
    process.exit(2)
  }
  process.stdout.write('alpha\\nbeta\\ngamma\\n')
  process.exit(0)
}

const MB = Buffer.alloc(1024 * 1024, 0x78)

function flood(stream, prefix, chunks) {
  return new Promise(resolve => {
    if (prefix) stream.write(prefix)
    let sent = 0
    const pump = () => {
      while (sent < chunks) {
        sent++
        if (!stream.write(MB)) {
          stream.once('drain', pump)
          return
        }
      }
      resolve()
    }
    pump()
  })
}

const modes = {
  'stderr-flood': () => flood(process.stderr, null, ${FLOOD_CHUNKS}),
  'stdout-flood': () => flood(process.stdout, null, ${FLOOD_CHUNKS}),
  'partial-then-stderr-flood': async () => {
    process.stdout.write('match-one\\nmatch-two\\nmatch-three\\npartial-tail')
    await flood(process.stderr, null, ${FLOOD_CHUNKS})
  },
  'eagain-stderr-flood': () =>
    flood(process.stderr, 'rg: thread pool spawn failed: os error 11\\n', ${FLOOD_CHUNKS}),
}

const run = modes[mode]
if (!run) {
  process.stderr.write('unknown FAKE_RG_MODE: ' + mode + '\\n')
  process.exit(9)
}
await run()

// Only reached when the child was NOT killed for exceeding maxBuffer.
if (process.env.FAKE_RG_DONE_FILE) {
  writeFileSync(process.env.FAKE_RG_DONE_FILE, 'finished')
}
process.exit(0)
`

const sandboxDir = mkdtempSync(join(tmpdir(), 'occ-rg-cap-'))
const fakeBinDir = join(sandboxDir, 'bin')
const fakeRgPath = join(fakeBinDir, 'rg')

// Resolve the real rg BEFORE shadowing PATH (the fake delegates to it for the
// passthrough mode). whichSync is imported for its side-effect-free lookup.
const { whichSync } = await import('../which.js')
const realRgPath = whichSync('rg')

mkdirSync(fakeBinDir, { recursive: true })
writeFileSync(fakeRgPath, FAKE_RG_SOURCE, { mode: 0o755 })
chmodSync(fakeRgPath, 0o755)
const originalPath = process.env.PATH
process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`
process.env.FAKE_RG_REAL_PATH = realRgPath ?? 'rg'
process.env.FAKE_RG_MODE = 'passthrough'

// ---------------------------------------------------------------------------
// Module under test (imported after PATH is shadowed — getRipgrepConfig is
// memoized on first use, so the fake `rg` becomes the system-mode command).
//
// OCC-97: Bun's mock.module leaks across test files in the same worker. Spread
// the real module, override only what these tests drive, restore in afterAll.
// The real exports are snapshotted into a plain object BEFORE mocking.
// ---------------------------------------------------------------------------

const actualLog = { ...(await import('../log.js')) }

// `logError` is the only throw site inside handleResult we can reach without
// contriving a 512MB string, so it doubles as the "handler throws" injector.
let logErrorThrow: unknown = null

mock.module('../log.js', () => ({
  ...actualLog,
  logError: (error: unknown) => {
    if (logErrorThrow !== null) {
      throw logErrorThrow
    }
    return actualLog.logError(error)
  },
}))

const {
  CappedOutputBuffer,
  RipgrepOutputError,
  RipgrepOutputTooLargeError,
  ripGrep,
  startRipgrepCollector,
} = await import('../ripgrep.js')

afterAll(() => {
  mock.module('../log.js', () => ({ ...actualLog }))
  // `bun test` runs every file in one process — undo the PATH shadow so later
  // files (GrepTool, glob, …) resolve the real rg.
  process.env.PATH = originalPath
  delete process.env.FAKE_RG_MODE
  delete process.env.FAKE_RG_REAL_PATH
  delete process.env.FAKE_RG_COUNT_FILE
  delete process.env.FAKE_RG_ARGS_FILE
  delete process.env.FAKE_RG_DONE_FILE
  rmSync(sandboxDir, { recursive: true, force: true })
})

afterEach(() => {
  logErrorThrow = null
  process.env.FAKE_RG_MODE = 'passthrough'
  delete process.env.FAKE_RG_COUNT_FILE
  delete process.env.FAKE_RG_ARGS_FILE
  delete process.env.FAKE_RG_DONE_FILE
})

// Warm the memoized first-use probe while the double is in passthrough mode,
// so later flood modes never become the cached availability result.
beforeAll(async () => {
  await ripGrep(['--files'], sandboxDir, new AbortController().signal)
})

// Byte-exact v276 messages (Zjt), reproduced from MAX_BUFFER_SIZE / 1e6 = 20.
const STDOUT_CAP_MESSAGE =
  'Ripgrep output passed the 20MB limit before a single complete line was read, so there are no usable results: at least one matching line is extremely long. Try a more specific pattern or path, or exclude very large files.'
const STDERR_CAP_MESSAGE =
  'Ripgrep produced more than 20MB of error output (for example per-file permission warnings) before any result line, so the search is incomplete. Try a more specific path.'

// ---------------------------------------------------------------------------
// CappedOutputBuffer (binary eqe)
// ---------------------------------------------------------------------------

describe('CappedOutputBuffer (v276 eqe)', () => {
  test('append returns false while the budget is not exhausted', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(10)

    // Act / Assert
    expect(buffer.append(Buffer.from('abcd'))).toBe(false)
    expect(buffer.truncated).toBe(false)
    expect(buffer.takeText()).toBe('abcd')
  })

  test('append returns true exactly once, on the chunk that crosses the cap', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(4)

    // Act
    const first = buffer.append(Buffer.from('abc'))
    const crossing = buffer.append(Buffer.from('defg'))
    const after = buffer.append(Buffer.from('h'))

    // Assert
    expect(first).toBe(false)
    expect(crossing).toBe(true)
    expect(after).toBe(false)
    expect(buffer.truncated).toBe(true)
  })

  test('stores only the capped prefix and drops everything after truncation', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(4)

    // Act
    buffer.append(Buffer.from('abc'))
    buffer.append(Buffer.from('defg'))
    buffer.append(Buffer.from('IGNORED'))

    // Assert
    expect(buffer.takeText()).toBe('abcd')
  })

  test('decodes a multi-byte character split across appends', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(64)
    const emoji = Buffer.from('😀', 'utf8') // 4 bytes: F0 9F 98 80

    // Act
    buffer.append(emoji.subarray(0, 2))
    buffer.append(emoji.subarray(2))

    // Assert — a TextDecoder-per-chunk would emit replacement characters here.
    expect(buffer.takeText()).toBe('😀')
  })

  test('release drops the buffered text without flushing it into a result', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(64)
    buffer.append(Buffer.from('discarded'))

    // Act
    buffer.release()

    // Assert
    expect(buffer.takeText()).toBe('')
  })

  test('takeText drains: a second call returns nothing', () => {
    // Arrange
    const buffer = new CappedOutputBuffer(64)
    buffer.append(Buffer.from('once'))

    // Act / Assert
    expect(buffer.takeText()).toBe('once')
    expect(buffer.takeText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Embedded (argv0) spawn path — collector with an injected cap
// ---------------------------------------------------------------------------

type FakeChild = {
  child: ChildProcess
  stdout: EventEmitter
  stderr: EventEmitter
  close: EventEmitter
  kills: Array<string | undefined>
}

function createFakeChild(): FakeChild {
  const close = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const kills: Array<string | undefined> = []
  const child = Object.assign(close, {
    stdout,
    stderr,
    kill: (signal?: string) => {
      kills.push(signal)
      return true
    },
  }) as unknown as ChildProcess
  return { child, stdout, stderr, close, kills }
}

type Collected = {
  error: ExecFileException | null
  stdout: string
  stderr: string
}

function collectWith(
  fake: FakeChild,
  maxBytes: number,
  timeoutMs = 60_000,
): Collected[] {
  const results: Collected[] = []
  startRipgrepCollector(fake.child, {
    callback: (error, stdout, stderr) => results.push({ error, stdout, stderr }),
    timeoutMs,
    maxBytes,
  })
  return results
}

describe('embedded-rg collector (v276 Wjt collect side)', () => {
  test('stdout over the cap kills the child with SIGKILL immediately', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 16)

    // Act
    fake.stdout.emit('data', Buffer.from('0123456789abcdefghij'))

    // Assert — killed before 'close', and nothing has settled yet.
    expect(fake.kills).toEqual(['SIGKILL'])
    expect(results).toHaveLength(0)

    // Cleanup: settle so the collector's kill-escalation timer is cleared.
    fake.close.emit('close', null, 'SIGKILL')
    expect(results).toHaveLength(1)
  })

  test('stdout overflow settles with the maxBuffer error, never a silent success', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 16)

    // Act
    fake.stdout.emit('data', Buffer.from('0123456789abcdefghij'))
    fake.close.emit('close', 0, null)

    // Assert — exit code 0 would have resolved as success in v274.
    expect(results).toHaveLength(1)
    expect(results[0]?.error?.message).toBe('stdout maxBuffer length exceeded')
    expect(results[0]?.error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(results[0]?.stdout).toBe('0123456789abcdef')
  })

  test('stderr overflow settles with the stderr maxBuffer error', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 8)

    // Act — stderr is diagnostics: capped, but it does not kill the search.
    fake.stderr.emit('data', Buffer.from('warning flood'))
    fake.close.emit('close', 0, null)

    // Assert
    expect(fake.kills).toEqual([])
    expect(results[0]?.error?.message).toBe('stderr maxBuffer length exceeded')
    expect(results[0]?.error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(results[0]?.stderr).toBe('warning ')
  })

  test('uncapped output still resolves as success with the exact text', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)

    // Act
    fake.stdout.emit('data', Buffer.from('one\ntwo\n'))
    fake.stderr.emit('data', Buffer.from('note\n'))
    fake.close.emit('close', 0, null)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]?.error).toBeNull()
    expect(results[0]?.stdout).toBe('one\ntwo\n')
    expect(results[0]?.stderr).toBe('note\n')
  })

  test('exit code 1 (no matches) resolves as success', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)

    // Act
    fake.close.emit('close', 1, null)

    // Assert
    expect(results[0]?.error).toBeNull()
    expect(results[0]?.stdout).toBe('')
  })

  test('a non-zero exit keeps the ripgrep exit-code error when under the cap', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)

    // Act
    fake.close.emit('close', 2, null)

    // Assert
    expect(results[0]?.error?.message).toBe('ripgrep exited with code 2')
    expect(results[0]?.error?.code).toBe(2)
  })

  test('a throwing data handler settles with RipgrepOutputError and kills', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)
    const decodeFailure = new Error('synthetic decode failure')
    // A chunk whose subarray throws — the same shape a real decoder/alloc
    // failure takes inside CappedOutputBuffer.append.
    const explodingChunk = {
      length: 8,
      subarray: () => {
        throw decodeFailure
      },
    } as unknown as Buffer

    // Act
    fake.stdout.emit('data', explodingChunk)

    // Assert — v274 let this escape the EventEmitter and hang the promise.
    expect(results).toHaveLength(1)
    expect(results[0]?.error).toBeInstanceOf(RipgrepOutputError)
    expect(results[0]?.error?.name).toBe('RipgrepOutputError')
    expect(results[0]?.error?.message).toBe(
      'Failed to collect ripgrep output: synthetic decode failure. ' +
        'If the search matches a very large amount of text, try a more specific path or pattern.',
    )
    expect((results[0]?.error as { cause?: unknown } | undefined)?.cause).toBe(
      decodeFailure,
    )
    expect(results[0]?.stdout).toBe('')
    expect(results[0]?.stderr).toBe('')
    expect(fake.kills).toContain('SIGKILL')
  })

  test('a throw after settling does not settle twice (Windows close+error guard)', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)

    // Act
    fake.close.emit('close', 0, null)
    fake.close.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]?.error).toBeNull()
  })

  test('a spawn error settles with that error', () => {
    // Arrange
    const fake = createFakeChild()
    const results = collectWith(fake, 1024)

    // Act
    fake.close.emit('error', Object.assign(new Error('boom'), { code: 'ENOENT' }))

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]?.error?.message).toBe('boom')
  })

  test('a throwing collector callback does not escape the emit or settle twice', () => {
    // Arrange
    const fake = createFakeChild()
    const calls: number[] = []
    startRipgrepCollector(fake.child, {
      callback: () => {
        calls.push(calls.length)
        throw new Error('callback exploded')
      },
      timeoutMs: 60_000,
      maxBytes: 1024,
    })

    // Act / Assert — the throw is contained; a second event is a no-op.
    expect(() => fake.close.emit('close', 0, null)).not.toThrow()
    fake.close.emit('error', Object.assign(new Error('late'), { code: 'ENOENT' }))
    expect(calls).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through ripGrep (execFile path, real 20MB cap, fake rg)
// ---------------------------------------------------------------------------

describe('ripGrep output cap (v276 o8 result side)', () => {
  test('stderr flood over 20MB rejects with RipgrepOutputTooLargeError, not []', async () => {
    // Arrange — the changelog case: system rg drowning in per-file warnings.
    process.env.FAKE_RG_MODE = 'stderr-flood'
    const doneFile = join(sandboxDir, 'stderr-flood-done')
    process.env.FAKE_RG_DONE_FILE = doneFile

    // Act
    const promise = ripGrep(['--files'], sandboxDir, new AbortController().signal, {
      rejectOnInputError: true,
    })

    // Assert
    const error = await promise.then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines)}`)
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RipgrepOutputTooLargeError)
    expect((error as Error).name).toBe('RipgrepOutputTooLargeError')
    expect((error as Error).message).toBe(STDERR_CAP_MESSAGE)
    // The child was killed at the cap rather than allowed to finish flooding.
    expect(existsSync(doneFile)).toBe(false)
  })

  test('stdout flood over 20MB rejects with the stdout-cap message', async () => {
    // Arrange — one extremely long matching line: no newline to split on.
    process.env.FAKE_RG_MODE = 'stdout-flood'
    const doneFile = join(sandboxDir, 'stdout-flood-done')
    process.env.FAKE_RG_DONE_FILE = doneFile

    // Act
    const error = await ripGrep(
      ['-e', 'x', '--no-filename'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    ).then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines.length)}`)
      },
      (e: unknown) => e,
    )

    // Assert
    expect(error).toBeInstanceOf(RipgrepOutputTooLargeError)
    expect((error as Error).message).toBe(STDOUT_CAP_MESSAGE)
    expect(existsSync(doneFile)).toBe(false)
  })

  test('overflow keeps the complete lines and drops the torn last one', async () => {
    // Arrange
    process.env.FAKE_RG_MODE = 'partial-then-stderr-flood'

    // Act — Glob/@-file callers pass no rejectOnInputError.
    const lines = await ripGrep(
      ['--files'],
      sandboxDir,
      new AbortController().signal,
    )

    // Assert
    expect(lines).toEqual(['match-one', 'match-two', 'match-three'])
  })

  test('overflow with an EAGAIN-flavoured stderr does not retry with -j 1', async () => {
    // Arrange
    process.env.FAKE_RG_MODE = 'eagain-stderr-flood'
    const countFile = join(sandboxDir, 'eagain-invocations')
    const argsFile = join(sandboxDir, 'eagain-args')
    writeFileSync(countFile, '')
    writeFileSync(argsFile, '')
    process.env.FAKE_RG_COUNT_FILE = countFile
    process.env.FAKE_RG_ARGS_FILE = argsFile

    // Act
    const error = await ripGrep(['--files'], sandboxDir, new AbortController().signal, {
      rejectOnInputError: true,
    }).then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines)}`)
      },
      (e: unknown) => e,
    )

    // Assert — one spawn only: the truncated stderr still contains "os error
    // 11", so without the overflow guard this retried single-threaded.
    expect(readFileSync(countFile, 'utf8')).toBe('x')
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(error).toBeInstanceOf(RipgrepOutputTooLargeError)
    expect((error as Error).message).toBe(STDERR_CAP_MESSAGE)
  })

  test('a genuine EAGAIN failure still retries single-threaded', async () => {
    // Arrange — exit 2 + "os error 11", well under the cap.
    process.env.FAKE_RG_MODE = 'eagain-then-ok'
    const countFile = join(sandboxDir, 'eagain-retry-invocations')
    const argsFile = join(sandboxDir, 'eagain-retry-args')
    writeFileSync(countFile, '')
    writeFileSync(argsFile, '')
    process.env.FAKE_RG_COUNT_FILE = countFile
    process.env.FAKE_RG_ARGS_FILE = argsFile

    // Act
    const lines = await ripGrep(['--files'], sandboxDir, new AbortController().signal)

    // Assert — first spawn fails with EAGAIN, the -j 1 retry succeeds.
    expect(readFileSync(countFile, 'utf8')).toBe('xx')
    const invocations = readFileSync(argsFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(invocations[0]).not.toContain('-j')
    expect(invocations[1]?.slice(0, 2)).toEqual(['-j', '1'])
    expect(lines).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('stderr flood without rejectOnInputError still resolves (Glob/@-file semantics)', async () => {
    // Arrange
    process.env.FAKE_RG_MODE = 'stderr-flood'

    // Act
    const lines = await ripGrep(['--files'], sandboxDir, new AbortController().signal)

    // Assert — unchanged for callers that do not opt into input-error rejection.
    expect(lines).toEqual([])
  })

  test('a throwing result handler rejects instead of hanging (RangeError)', async () => {
    // Arrange — exit 3 reaches logError inside handleResult.
    process.env.FAKE_RG_MODE = 'exit-3'
    logErrorThrow = new RangeError('Invalid string length')

    // Act
    const error = await ripGrep(['--files'], sandboxDir, new AbortController().signal).then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines)}`)
      },
      (e: unknown) => e,
    )

    // Assert — binary: `he instanceof RangeError ? Xjt(he) : ue(he)`
    expect(error).toBeInstanceOf(RipgrepOutputError)
    expect((error as Error).message).toBe(
      'Failed to collect ripgrep output: Invalid string length. ' +
        'If the search matches a very large amount of text, try a more specific path or pattern.',
    )
  })

  test('a throwing result handler rejects with the original non-RangeError', async () => {
    // Arrange
    process.env.FAKE_RG_MODE = 'exit-3'
    const thrown = new TypeError('handleResult exploded')
    logErrorThrow = thrown

    // Act
    const error = await ripGrep(['--files'], sandboxDir, new AbortController().signal).then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines)}`)
      },
      (e: unknown) => e,
    )

    // Assert
    expect(error).toBe(thrown)
  })

  test('normal searches are unaffected: matches, no matches, and real rg output', async () => {
    // Arrange
    writeFileSync(join(sandboxDir, 'haystack.txt'), 'first\nneedle here\nlast\n')
    process.env.FAKE_RG_MODE = 'lines'

    // Act
    const lines = await ripGrep(['--files'], sandboxDir, new AbortController().signal)
    process.env.FAKE_RG_MODE = 'no-matches'
    const none = await ripGrep(['--files'], sandboxDir, new AbortController().signal)
    process.env.FAKE_RG_MODE = 'passthrough'
    const real = await ripGrep(
      ['--line-number', '--no-heading', '--color', 'never', '-e', 'needle'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )

    // Assert
    expect(lines).toEqual(['alpha', 'beta', 'gamma'])
    expect(none).toEqual([])
    expect(real.some(line => line.includes('needle here'))).toBe(true)
  })
})
