import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as REAL_FS_NS from 'fs/promises'
import * as REAL_PLATFORM_NS from '../../platform.js'
import { _resetErrorLogForTesting, getInMemoryErrors } from '../../log.js'
import {
  DiskTaskOutput,
  OUTPUT_OMITTED_MARKER_FOR_TEST,
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  appendTaskOutput,
  appendTaskTrailer,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutputPath,
} from '../diskOutput.js'

/**
 * CC 2.1.301 #39 — typed output-file trailer for stopped background shells.
 *
 * Official v301 additions (byte-verified against the 2.1.301 linux-x64 ELF;
 * `appendTrailer` = 0 hits in v300, 4 in v301):
 *
 *   class _Wn (DiskTaskOutput):
 *     appendTrailer(e,n){if(!this.#o)this.#s=n;this.append(e)}
 *     — records the pending trailer kind (#s) unless the disk cap was hit,
 *       then delegates to the normal append/drain queue.
 *     #y (queueToBuffers): clears #s when the queue is spliced into the
 *       write buffer.
 *     cancel(): clears #s and aborts the EBUSY retry controller (#a).
 *     #g(e): `O()==="windows"&&E(e)==="EBUSY"?this.#s:null` — the trailer
 *       kind gates the Windows EBUSY backoff-retry loop in #O (#drain):
 *       tt=[50,100,200,400,800,1600] (G=3150ms total), abortable, then #k.
 *     #k (final failure): kind = exhaustion errno ? "exhaustion"
 *       : trailerKind ?? "unexpected", with per-kind logs:
 *         exited → warn "Task output closing line not written (EBUSY): the
 *                  file was still busy after 3150 ms"
 *         killed → logError "closing line of a stopped shell command not
 *                  written: output file still busy after 3150 ms"
 *       and the >16MB drop branch additionally clears #s.
 *
 *   module level (bWn @222257169):
 *     function bWn(e,n){let i=pt(e);
 *       if(n==="killed")i.appendTrailer("\n[killed]\n","killed");
 *       else i.appendTrailer(`\n[exited with code ${n.exitCode??"unknown"}]\n`,"exited")}
 *
 * v300 wrote `\n[killed]\n` only on the non-adopted path; v301 routes every
 * stop through the typed appendTrailer. OCC previously wrote NO trailer on
 * any platform (killShellTasks.ts → straight to evictTaskOutput).
 *
 * fs-failure injection follows diskOutputDrainGuard247.test.ts (mock.module
 * with load-time snapshots; live bindings).
 */

const MARKER = OUTPUT_OMITTED_MARKER_FOR_TEST

const REAL_FS: typeof REAL_FS_NS = { ...REAL_FS_NS }
const REAL_PLATFORM: typeof REAL_PLATFORM_NS = { ...REAL_PLATFORM_NS }

type FsPromises = typeof import('fs/promises')

async function installFsFake(fake: {
  open?: FsPromises['open']
}): Promise<void> {
  await mock.module('fs/promises', () => ({
    ...REAL_FS,
    ...(fake.open ? { open: fake.open } : {}),
  }))
}

async function restoreRealFs(): Promise<void> {
  await mock.module('fs/promises', () => ({ ...REAL_FS }))
}

async function installWindowsPlatform(): Promise<void> {
  await mock.module('../../platform.js', () => ({
    ...REAL_PLATFORM,
    getPlatform: () => 'windows',
  }))
}

async function restoreRealPlatform(): Promise<void> {
  await mock.module('../../platform.js', () => ({ ...REAL_PLATFORM }))
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

let taskCounter = 0
function freshTaskId(): string {
  taskCounter += 1
  return `trailer-301-${taskCounter}`
}

beforeEach(() => {
  _resetErrorLogForTesting()
  _resetTaskOutputDirForTest()
})

afterEach(async () => {
  await restoreRealFs()
  await restoreRealPlatform()
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
})

describe('2.1.301 #39: DiskTaskOutput.appendTrailer', () => {
  test('appendTrailer lands the trailer text after queued content', async () => {
    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('partial stream output')
    out.appendTrailer('\n[killed]\n', 'killed')
    await out.flush()

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      'partial stream output\n[killed]\n',
    )
  })

  test('appendTaskTrailer("killed") writes the official killed trailer', async () => {
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'echo hello\n')
    appendTaskTrailer(taskId, 'killed')
    await flushTaskOutput(taskId)

    const content = readFileSync(getTaskOutputPath(taskId), 'utf8')
    expect(content.endsWith('\n[killed]\n')).toBe(true)
  })

  test('appendTaskTrailer({exitCode}) writes the official exited trailer', async () => {
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'done\n')
    appendTaskTrailer(taskId, { exitCode: 3 })
    await flushTaskOutput(taskId)

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      'done\n\n[exited with code 3]\n',
    )
  })

  test('appendTaskTrailer({exitCode: 0}) keeps the zero exit code', async () => {
    const taskId = freshTaskId()
    appendTaskTrailer(taskId, { exitCode: 0 })
    await flushTaskOutput(taskId)

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      '\n[exited with code 0]\n',
    )
  })

  test('appendTaskTrailer with unknown exit code prints "unknown" (official ??)', async () => {
    const taskId = freshTaskId()
    appendTaskTrailer(taskId, { exitCode: undefined })
    await flushTaskOutput(taskId)

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      '\n[exited with code unknown]\n',
    )
  })

  test('trailer participates in the drain-failure subsystem (exhaustion classification wins)', async () => {
    // Open always fails with ENOSPC → retry-once → final failure classified
    // as "exhaustion" (errno set beats the trailer kind, official #k).
    await installFsFake({
      open: (async () => {
        throw errnoError('no space left on device', 'ENOSPC')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('x'.repeat(17 * 1024 * 1024))
    out.appendTrailer('\n[killed]\n', 'killed')
    await out.flush()

    expect(out.failing).toBe(true)
    expect(out.lostOutput).toBe(true)
    // Queue collapsed to the omission marker (drop threshold).
    expect(out.unwrittenChars).toBe(MARKER.length)
    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l => l.includes('Task output drain retry failed (ENOSPC)')),
    ).toBe(true)
    expect(
      logs.some(l => l.includes('Task output still cannot be written (ENOSPC)')),
    ).toBe(true)
  })

  test('non-Windows EBUSY on a trailer write stays an "unexpected" failure (no retry loop)', async () => {
    // Linux/macos: #g returns null for EBUSY (platform gate) → the normal
    // retry-once path runs and the final classification is "unexpected".
    await installFsFake({
      open: (async () => {
        throw errnoError('resource busy or locked', 'EBUSY')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.appendTrailer('\n[killed]\n', 'killed')
    await out.flush()

    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l => l.includes('Task output drain failed (will retry once)')),
    ).toBe(true)
    expect(
      logs.some(l =>
        l.includes('closing line of a stopped shell command not written'),
      ),
    ).toBe(false)
  })

  test('Windows EBUSY: trailer write is retried with backoff and lands once the file frees up', async () => {
    await installWindowsPlatform()
    let openCalls = 0
    await installFsFake({
      open: (async (path: any, flags: any) => {
        openCalls += 1
        // First two opens fail EBUSY (file busy); third succeeds.
        if (openCalls <= 2) {
          throw errnoError('resource busy or locked', 'EBUSY')
        }
        return REAL_FS.open(path, flags)
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.append('stream\n')
    out.appendTrailer('\n[killed]\n', 'killed')
    await out.flush()

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      'stream\n\n[killed]\n',
    )
    expect(openCalls).toBeGreaterThanOrEqual(3)
    expect(out.failing).toBe(false)
  })

  test('Windows EBUSY persistent, killed trailer: logs the official closing-line error after 3150ms of retries', async () => {
    await installWindowsPlatform()
    await installFsFake({
      open: (async () => {
        throw errnoError('resource busy or locked', 'EBUSY')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.appendTrailer('\n[killed]\n', 'killed')
    await out.flush()

    expect(out.failing).toBe(true)
    const logs = getInMemoryErrors().map(e => e.error)
    expect(
      logs.some(l =>
        l.includes(
          'closing line of a stopped shell command not written: output file still busy after 3150 ms',
        ),
      ),
    ).toBe(true)
    // The exhaustion/unexpected messages must NOT fire for the trailer kind.
    expect(
      logs.some(l => l.includes('Task output drain retry failed')),
    ).toBe(false)
  }, 10_000)

  test('cancel() aborts the EBUSY retry loop', async () => {
    await installWindowsPlatform()
    await installFsFake({
      open: (async () => {
        throw errnoError('resource busy or locked', 'EBUSY')
      }) as FsPromises['open'],
    })

    const taskId = freshTaskId()
    const out = new DiskTaskOutput(taskId)
    out.appendTrailer('\n[killed]\n', 'killed')
    const flushed = out.flush()
    // Cancel while the first backoff sleep is running — the loop must exit
    // promptly (well before the 3150ms full backoff) without a final-failure
    // killed log.
    out.cancel()
    await flushed

    expect(
      getInMemoryErrors().some(e =>
        e.error.includes(
          'closing line of a stopped shell command not written',
        ),
      ),
    ).toBe(false)
    expect(existsSync(getTaskOutputPath(taskId))).toBe(false)
  })
})

describe('2.1.301 #39: trailer survives eviction (killTask ordering contract)', () => {
  test('appendTaskTrailer before evictTaskOutput lands in the file readers see', async () => {
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'background output\n')
    appendTaskTrailer(taskId, 'killed')
    await evictTaskOutput(taskId)

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      'background output\n\n[killed]\n',
    )
  })
})
