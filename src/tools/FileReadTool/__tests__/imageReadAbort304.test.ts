import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'
import { AbortError, isAbortError } from '../../../utils/errors.js'
import {
  readImageBytesCapped,
  readImageBytesFromHandle,
  type ReadableHandle,
} from '../imageRead.js'

/**
 * CC 2.1.304 #32 — interrupt now ends a Read waiting on an idle pipe/device
 * named like an image.
 *
 * Official evidence (v304 linux-x64 ELF, see docs/gap-research-304/
 * research-R2-bash-perms.md §#32):
 *   - `Mbn` chunked reader gains a 3rd signal param: top-of-loop
 *     `if(r?.aborted)throw new Ye` plus per-read race
 *     `await(r===void 0?H:$i(H,r,()=>new Ye))` (@248595300–248596600).
 *   - `$i` (@236274849) is the abort-race helper: pre-aborted → throw +
 *     swallow source rejection; `{once:true}` listener; `finally`
 *     removeEventListener.
 *   - Read-tool image-branch call site passes
 *     `pdfRenderSignal ?? signal` (@248585955); the background watch path
 *     stays unthreaded (@248745435).
 *
 * OCC port: `raceAbort` in imageRead.ts (faithful `$i` port) + optional
 * `signal` on readNonRegularCapped / readImageBytesFromHandle /
 * readImageBytesCapped; FileReadTool threads
 * `context.abortController.signal` via readImageWithTokenBudget's new 4th
 * param. attachments.ts stays unthreaded (official background-path parity).
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Non-regular handle whose `read` never settles — stands in for an idle FIFO
 * or char device named like an image (the hang scenario #32 fixes).
 * `settlePending` lets the test reject the in-flight read LATER to prove the
 * race swallows the source rejection (no unhandled rejection).
 */
function fakeIdleHandle(): {
  handle: ReadableHandle
  readCalls: () => number
  closed: () => boolean
  settlePending: (error: unknown) => void
} {
  let reads = 0
  let closed = false
  let pendingReject: ((error: unknown) => void) | undefined
  const handle: ReadableHandle = {
    async stat() {
      return { isFile: () => false, size: 0 }
    },
    read() {
      reads += 1
      return new Promise<{ bytesRead: number }>((_resolve, reject) => {
        pendingReject = reject
      })
    },
    async close() {
      closed = true
    },
  }
  return {
    handle,
    readCalls: () => reads,
    closed: () => closed,
    settlePending: (error: unknown) => pendingReject?.(error),
  }
}

/** Non-regular handle that dribbles 1 byte per read — for between-chunk abort. */
function fakeDribbleHandle(): { handle: ReadableHandle; readCalls: () => number } {
  let reads = 0
  const handle: ReadableHandle = {
    async stat() {
      return { isFile: () => false, size: 0 }
    },
    async read(buffer: Buffer, offset: number) {
      reads += 1
      buffer[offset] = 0x41
      return { bytesRead: 1 }
    },
    async close() {},
  }
  return { handle, readCalls: () => reads }
}

/** Let microtasks + the unhandledRejection bookkeeping flush. */
async function flushTicks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

// ---------------------------------------------------------------------------
// Unhandled-rejection monitor (proves `$i`-faithful rejection swallowing)
// ---------------------------------------------------------------------------

let unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason)
}

beforeEach(() => {
  unhandledRejections = []
  process.on('unhandledRejection', onUnhandledRejection)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandledRejection)
  setOriginalFsImplementation()
})

// ---------------------------------------------------------------------------
// readImageBytesFromHandle — signal on the non-regular chunked path
// ---------------------------------------------------------------------------

describe('CC 2.1.304 #32: pre-aborted signal throws before any read', () => {
  test('an already-aborted signal rejects with AbortError and issues zero reads', async () => {
    // Arrange
    const fake = fakeIdleHandle()
    const controller = new AbortController()
    controller.abort()

    // Act
    let caught: unknown
    try {
      await readImageBytesFromHandle(
        fake.handle,
        'idle.png',
        100000,
        controller.signal,
      )
    } catch (e) {
      caught = e
    }

    // Assert — official `if(r?.aborted)throw new Ye` at the top of the loop:
    // the pending read is never even issued.
    expect(caught).toBeInstanceOf(AbortError)
    expect(isAbortError(caught)).toBe(true)
    expect(fake.readCalls()).toBe(0)
  })
})

describe('CC 2.1.304 #32: abort during a pending read', () => {
  test('aborting while the read is in flight rejects with AbortError', async () => {
    // Arrange — idle FIFO: the read never settles on its own
    const fake = fakeIdleHandle()
    const controller = new AbortController()
    const readPromise = readImageBytesFromHandle(
      fake.handle,
      'idle.png',
      100000,
      controller.signal,
    )

    // Act — let the read go pending, then interrupt (Esc)
    await flushTicks()
    expect(fake.readCalls()).toBe(1)
    controller.abort()

    // Assert
    let caught: unknown
    try {
      await readPromise
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AbortError)
    expect(isAbortError(caught)).toBe(true)
  })

  test('the losing read promise rejecting later is swallowed (no unhandled rejection)', async () => {
    // Arrange — same mid-read abort, but the source read REJECTS afterwards
    const fake = fakeIdleHandle()
    const controller = new AbortController()
    const readPromise = readImageBytesFromHandle(
      fake.handle,
      'idle.png',
      100000,
      controller.signal,
    )
    await flushTicks()
    controller.abort()
    try {
      await readPromise
    } catch {
      // expected AbortError — asserted by the sibling test
    }

    // Act — the pending read settles with an error AFTER the race was lost
    fake.settlePending(new Error('late EIO from the idle pipe'))
    await flushTicks()

    // Assert — official `$i` attaches `t.catch(()=>{})` to the source promise
    // in its catch path, so the late rejection cannot surface as unhandled.
    expect(unhandledRejections).toEqual([])
  })

  test('an abort between chunks throws before the next read is issued', async () => {
    // Arrange — dribble handle: 1 byte per read, loop re-checks the signal
    const fake = fakeDribbleHandle()
    const controller = new AbortController()
    const readPromise = readImageBytesFromHandle(
      fake.handle,
      'idle.png',
      100000,
      controller.signal,
    )
    // Abort after the first read completes (top-of-next-iteration check)
    queueMicrotask(() => controller.abort())

    // Act
    let caught: unknown
    try {
      await readPromise
    } catch (e) {
      caught = e
    }

    // Assert — threw AbortError at `if (signal?.aborted)` without issuing
    // another read (at most the first one had completed).
    expect(caught).toBeInstanceOf(AbortError)
    expect(fake.readCalls()).toBeLessThanOrEqual(1)
  })
})

describe('CC 2.1.304 #32: unthreaded path is unchanged (official `r===void 0?H` branch)', () => {
  test('no signal still blocks on the idle read (the official pre-fix behavior)', async () => {
    // Arrange — idle handle, NO signal: plain await, nothing can interrupt
    const fake = fakeIdleHandle()
    let settled = false
    const readPromise = readImageBytesFromHandle(
      fake.handle,
      'idle.png',
      100000,
    ).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    // Act — settle the pending read manually; until then the call must hang
    await flushTicks()
    expect(settled).toBe(false)
    expect(fake.readCalls()).toBe(1)
    fake.settlePending(new Error('EIO'))
    await readPromise

    // Assert — the promise only settled because the source read did
    expect(settled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readImageBytesCapped — signal threading + handle close on the abort path
// ---------------------------------------------------------------------------

describe('CC 2.1.304 #32: readImageBytesCapped threads the signal', () => {
  test('a mid-read abort rejects with AbortError and still closes the handle', async () => {
    // Arrange — route open() through the fs seam to the idle fake
    const fake = fakeIdleHandle()
    setFsImplementation({
      ...getFsImplementation(),
      open: async () => fake.handle as never,
    })
    const controller = new AbortController()

    // Act
    const readPromise = readImageBytesCapped(
      'idle.png',
      100000,
      controller.signal,
    )
    await flushTicks()
    controller.abort()

    // Assert
    let caught: unknown
    try {
      await readPromise
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AbortError)
    // Fix #9 (2.1.302 acceptance): close runs on the error path too.
    expect(fake.closed()).toBe(true)
    await flushTicks()
    expect(unhandledRejections).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// readImageWithTokenBudget — FileReadTool wiring (new 4th param)
// ---------------------------------------------------------------------------

describe('CC 2.1.304 #32: readImageWithTokenBudget accepts and threads a signal', () => {
  test('a pre-aborted signal rejects with AbortError through the token-budget wrapper', async () => {
    // Arrange
    const { readImageWithTokenBudget } = await import('../FileReadTool.js')
    const fake = fakeIdleHandle()
    setFsImplementation({
      ...getFsImplementation(),
      open: async () => fake.handle as never,
    })
    const controller = new AbortController()
    controller.abort()

    // Act
    let caught: unknown
    try {
      await readImageWithTokenBudget('idle.png', 1000, 100000, controller.signal)
    } catch (e) {
      caught = e
    }

    // Assert
    expect(isAbortError(caught)).toBe(true)
    expect(fake.readCalls()).toBe(0)
    expect(fake.closed()).toBe(true)
  })
})
