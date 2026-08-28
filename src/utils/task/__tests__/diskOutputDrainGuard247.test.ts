import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as REAL_FS_NS from 'fs/promises'
import * as REAL_FS_OPS_NS from '../../fsOperations.js'
import { _resetErrorLogForTesting, getInMemoryErrors } from '../../log.js'
import { TaskOutput } from '../TaskOutput.js'
import {
  DiskTaskOutput,
  OUTPUT_OMITTED_MARKER_FOR_TEST,
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  appendTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputPath,
  getTaskOutputSize,
} from '../diskOutput.js'

/**
 * 2.1.247 Gap-107a: task-output drain-failure guard.
 *
 * Official 2.1.247 changelog entries this pins:
 *  - "Fixed a hook or background agent that printed megabytes of error output
 *    being able to overflow the conversation and wedge the session on
 *    'Prompt is too long'"
 *  - "Fixed unbounded memory growth when a hook's or background task's output
 *    file could not be written; the file now notes where output was lost"
 *
 * Recovered verbatim from the 2.1.247 linux-x64 binary: DiskTaskOutput (Boe)
 * drain driver (#g), retry-once + errno classification (#y), cancel-race
 * marker unshift (#p inner catch), 16MB drop threshold (hlo = 16777216),
 * omission marker RTe, eviction discard log, read-side errno-classified logs,
 * TaskOutput getStdout failing/lostOutput notice.
 *
 * fs failures are injected via mock.module('fs/promises') with controllable
 * fakes (chmod-based EACCES is unusable — tests run as root, DAC override).
 *
 * Bun mock.module gotchas encoded here (probe-verified on bun 1.3.14):
 *  - `import * as ns` namespaces are LIVE bindings — once mocked, `ns.open`
 *    IS the fake (wrapping `ns.open` recurses). Snapshot export values at
 *    module load into plain objects instead (REAL_FS / REAL_FS_OPS).
 *  - mock.restore() does NOT undo mock.module — restore by re-mocking with
 *    the load-time snapshot (restoreRealFs / restoreRealFsOps).
 */

const MARKER = OUTPUT_OMITTED_MARKER_FOR_TEST

// Load-time snapshots of the real export values (before any mock exists).
const REAL_FS: typeof REAL_FS_NS = { ...REAL_FS_NS }
const REAL_FS_OPS: typeof REAL_FS_OPS_NS = { ...REAL_FS_OPS_NS }

type FsPromises = typeof import('fs/promises')

async function installFsFake(fake: {
  open?: FsPromises['open']
  stat?: FsPromises['stat']
}): Promise<void> {
  await mock.module('fs/promises', () => ({
    ...REAL_FS,
    ...(fake.open ? { open: fake.open } : {}),
    ...(fake.stat ? { stat: fake.stat } : {}),
  }))
}

async function restoreRealFs(): Promise<void> {
  await mock.module('fs/promises', () => ({ ...REAL_FS }))
}

async function restoreRealFsOps(): Promise<void> {
  await mock.module('../../fsOperations.js', () => ({ ...REAL_FS_OPS }))
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

let taskCounter = 0
function freshTaskId(): string {
  taskCounter += 1
  return `drain-guard-247-${taskCounter}`
}

beforeEach(() => {
  _resetErrorLogForTesting()
  _resetTaskOutputDirForTest()
})

afterEach(async () => {
  await restoreRealFs()
  await restoreRealFsOps()
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
})

describe('2.1.247 DiskTaskOutput drain-failure guard', () => {
  test('happy path: content lands on disk, getters clean', async () => {
    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('hello ')
    out.append('world')
    await out.flush()

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('hello world')
    expect(out.failing).toBe(false)
    expect(out.lostOutput).toBe(false)
    expect(out.unwrittenChars).toBe(0)
  })

  test('write-level failure: marker unshifted, retry writes marker, lost output noted', async () => {
    // First appendFile call fails (ENOSPC), later calls succeed — the driver's
    // retry-once recovers within the same drain cycle.
    let failingWrites = 1
    await installFsFake({
      open: (async (path: any, flags: any) => {
        const fh = await REAL_FS.open(path, flags)
        const realAppend = fh.appendFile.bind(fh)
        ;(fh as any).appendFile = async (data: any) => {
          if (failingWrites > 0) {
            failingWrites -= 1
            throw errnoError('no space left on device', 'ENOSPC')
          }
          return realAppend(data)
        }
        return fh
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('hello')
    await out.flush()

    // The 'hello' chunk was spliced into the write buffer that failed — it is
    // gone; the marker notes where output was lost. Retry wrote the marker.
    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(MARKER)
    expect(out.lostOutput).toBe(true)
    expect(out.failing).toBe(false) // successful retry clears the episode
    expect(out.unwrittenChars).toBe(0)

    // Subsequent output keeps appending after the marker.
    out.append('world')
    await out.flush()
    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      `${MARKER}world`,
    )
    expect(getInMemoryErrors().some(e =>
      e.error.includes('Task output drain failed (will retry once)'),
    )).toBe(true)
  })

  test('open-level exhaustion failure >16MB queued: drops queue, keeps only marker', async () => {
    // Every open fails with ENOSPC (disk exhaustion). The queue therefore keeps
    // the appended data (no splice happens) and crosses the 16MB drop threshold.
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    const bigChunk = 'x'.repeat(17 * 1024 * 1024)
    out.append(bigChunk)
    await out.flush()

    expect(out.failing).toBe(true)
    expect(out.lostOutput).toBe(true)
    // Queue collapsed to just the marker — memory cannot grow unbounded.
    expect(out.unwrittenChars).toBe(MARKER.length)

    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l => l.includes('Task output drain retry failed (ENOSPC)')),
    ).toBe(true)
    expect(
      logs.some(l =>
        l.includes(
          'Task output still cannot be written (ENOSPC); dropped',
        ),
      ),
    ).toBe(true)
    expect(
      logs.some(l => l.includes('chars of unwritten output')),
    ).toBe(true)

    // Recovery: disk is writable again → a new drain writes marker + new data.
    await restoreRealFs()
    out.append('after')
    await out.flush()
    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      `${MARKER}after`,
    )
    expect(out.lostOutput).toBe(true) // loss is permanent for this writer
    expect(out.failing).toBe(false)
  })

  test('open-level unexpected failure (EACCES): queue retained, no exhaustion log', async () => {
    await installFsFake({
      open: (async () => {
        throw errnoError('permission denied', 'EACCES')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('x')
    await out.flush()

    expect(out.failing).toBe(true)
    expect(out.lostOutput).toBe(false)
    expect(out.unwrittenChars).toBe(1) // 'x' retained — no drop under threshold

    const logs = getInMemoryErrors().map(e => e.error)
    // EACCES is not disk exhaustion → reported as unexpected (raw error), not
    // the terse exhaustion message.
    expect(logs.some(l => l.includes('Task output drain retry failed'))).toBe(
      false,
    )
    expect(logs.some(l => l.includes('permission denied'))).toBe(true)
    expect(
      logs.some(l => l.includes('Task output drain failed (will retry once)')),
    ).toBe(true)

    // Recovery writes the retained queue content (no marker — nothing was lost
    // at the write level).
    await restoreRealFs()
    out.append('y')
    await out.flush()
    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('xy')
    expect(out.failing).toBe(false)
  })

  test('cancel clears queue and unwrittenChars', async () => {
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })
    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('pending')
    await out.flush()
    expect(out.unwrittenChars).toBe('pending'.length)

    out.cancel()
    expect(out.unwrittenChars).toBe(0)
    // Nothing queued → recovery writes nothing for the cancelled data.
    await restoreRealFs()
    await out.flush()
    out.append('fresh')
    await out.flush()
    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('fresh')
  })

  test('evictTaskOutput logs discarded unwritten chars when evicted while failing', async () => {
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'doomed')
    await flushTaskOutput(taskId)

    await evictTaskOutput(taskId)

    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l =>
        l.includes(
          'Task output writer evicted while failing; discarded 6 chars of unwritten output',
        ),
      ),
    ).toBe(true)
  })

  test('drain failure logs once per episode even across repeated append cycles', async () => {
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })
    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('a')
    await out.flush()
    out.append('b')
    await out.flush()

    const logs = getInMemoryErrors().map(e => e.error)
    // 'will retry once' fires only while failing was false (first cycle);
    // 'retry failed (ENOSPC)' is deduped by kind+errno within the episode.
    expect(
      logs.filter(l => l.includes('Task output drain failed (will retry once)')),
    ).toHaveLength(1)
    expect(
      logs.filter(l => l.includes('Task output drain retry failed (ENOSPC)')),
    ).toHaveLength(1)
  })
})

describe('2.1.247 read-side errno-classified logs', () => {
  test('getTaskOutputSize: exhaustion errno → terse classified log, returns 0', async () => {
    await installFsFake({
      stat: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['stat'],
    })
    const size = await getTaskOutputSize('read-side-enospc')
    expect(size).toBe(0)
    const logs = getInMemoryErrors().map(e => e.error)
    expect(logs.some(l => l.includes('getTaskOutputSize failed (ENOSPC)'))).toBe(
      true,
    )
  })

  test('getTaskOutputDelta: exhaustion errno → classified log, empty delta', async () => {
    await mock.module('../../fsOperations.js', () => ({
      ...REAL_FS_OPS,
      readFileRange: async () => {
        throw errnoError('disk quota exceeded', 'EDQUOT')
      },
    }))
    const delta = await getTaskOutputDelta('read-side-edquot', 0)
    expect(delta).toEqual({ content: '', newOffset: 0 })
    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l => l.includes('getTaskOutputDelta failed (EDQUOT)')),
    ).toBe(true)
  })

  test('getTaskOutput: exhaustion errno (EMFILE) → classified log, returns empty', async () => {
    await mock.module('../../fsOperations.js', () => ({
      ...REAL_FS_OPS,
      tailFile: async () => {
        throw errnoError('too many open files in process', 'EMFILE')
      },
    }))
    const content = await getTaskOutput('read-side-emfile')
    expect(content).toBe('')
    const logs = getInMemoryErrors().map(e => e.error)
    expect(logs.some(l => l.includes('getTaskOutput failed (EMFILE)'))).toBe(
      true,
    )
  })

  test('getTaskOutput: non-exhaustion errno → raw error, no classified prefix', async () => {
    await mock.module('../../fsOperations.js', () => ({
      ...REAL_FS_OPS,
      tailFile: async () => {
        throw errnoError('input/output error', 'EIO')
      },
    }))
    const content = await getTaskOutput('read-side-eio')
    expect(content).toBe('')
    const logs = getInMemoryErrors().map(e => e.error)
    expect(logs.some(l => l.includes('getTaskOutput failed (EIO)'))).toBe(false)
    expect(logs.some(l => l.includes('input/output error'))).toBe(true)
  })
})

describe('2.1.247 TaskOutput.getStdout failing/lostOutput notice', () => {
  test('healthy spill → "Full output saved to: <path>"', async () => {
    const taskId = freshTaskId()
    const taskOutput = new TaskOutput(taskId, null, false, 10)
    taskOutput.writeStdout('line one\nline two\nline three\n')
    await taskOutput.flush()

    const stdout = await taskOutput.getStdout()
    expect(stdout).toContain('Output truncated (0KB total). Full output saved to: ')
    expect(stdout).toContain(getTaskOutputPath(taskId))
    expect(stdout).not.toContain('could not all be saved')
  })

  test('failing disk writer → "could not all be saved ... may be missing or incomplete"', async () => {
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })
    const taskId = freshTaskId()
    const taskOutput = new TaskOutput(taskId, null, false, 10)
    taskOutput.writeStdout('line one\nline two\nline three\n')
    await taskOutput.flush()

    const stdout = await taskOutput.getStdout()
    expect(stdout).toContain('Output truncated (0KB total)')
    expect(stdout).toContain(
      `The full output could not all be saved to ${getTaskOutputPath(taskId)}; that file may be missing or incomplete.`,
    )
    expect(stdout).not.toContain('Full output saved to:')
  })
})
