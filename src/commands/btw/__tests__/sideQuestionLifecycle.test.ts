// Official v299 (#105 + #166) — non-interactive /btw side-question lifecycle:
//   #166: unanswered for 11 minutes (official `two=660000`) → timeout with the
//         official message `side_question timed out: the host did not answer in time`
//   #105a: pending side questions are aborted at session end
//   #105b: an identical in-flight question is adopted, never run twice
// Uses a manual fake clock (injected setTimeoutFn/clearTimeoutFn) — same
// pattern as components/__tests__/deferredRowCollapse.test.ts.

import { describe, expect, test } from 'bun:test'
import {
  cancelAllPendingSideQuestions,
  getPendingSideQuestionCount,
  runTrackedSideQuestion,
  SIDE_QUESTION_CANCELLED_MESSAGE,
  SIDE_QUESTION_TIMEOUT_MESSAGE,
  SIDE_QUESTION_TIMEOUT_MS,
  type SideQuestionOutcome,
} from '../sideQuestionLifecycle.js'

type FakeTimer = { cb: () => void; dueAt: number; id: number; cleared: boolean }

function createFakeClock() {
  const timers: FakeTimer[] = []
  let nextId = 1
  let now = 0
  return {
    setTimeoutFn: (cb: () => void, ms: number) => {
      const timer: FakeTimer = { cb, dueAt: now + ms, id: nextId++, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      const timer = handle as unknown as FakeTimer
      timer.cleared = true
    },
    advance(ms: number) {
      const target = now + ms
      // Fire due timers in (dueAt, id) order, like the real event loop.
      for (;;) {
        const due = timers
          .filter(t => !t.cleared && t.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0]
        if (!due) break
        now = due.dueAt
        due.cleared = true
        due.cb()
      }
      now = target
    },
    get liveTimers() {
      return timers.filter(t => !t.cleared).length
    },
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('sideQuestionLifecycle constants (#166 forensics)', () => {
  test('timeout is the official two=660000 (11 minutes)', () => {
    expect(SIDE_QUESTION_TIMEOUT_MS).toBe(660000)
    expect(SIDE_QUESTION_TIMEOUT_MS).toBe(11 * 60 * 1000)
  })

  test('timeout message is the official _Ht byte-for-byte', () => {
    expect(SIDE_QUESTION_TIMEOUT_MESSAGE).toBe(
      'side_question timed out: the host did not answer in time',
    )
  })

  test('cancelled message is the official response text', () => {
    expect(SIDE_QUESTION_CANCELLED_MESSAGE).toBe('Side question cancelled')
  })
})

describe('runTrackedSideQuestion — #166 timeout', () => {
  test('times out exactly at 660000ms and aborts the run', async () => {
    const clock = createFakeClock()
    let aborted = false
    const pending = runTrackedSideQuestion<string>({
      question: 'timeout-q',
      run: controller => {
        controller.signal.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<string>(() => {}) // never answers
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    clock.advance(SIDE_QUESTION_TIMEOUT_MS - 1)
    await flush()
    expect(aborted).toBe(false)

    clock.advance(1)
    const outcome = await pending
    expect(outcome).toEqual({ type: 'timeout' })
    expect(aborted).toBe(true)
    expect(getPendingSideQuestionCount()).toBe(0)
  })

  test('an answer before the deadline wins and the timer is cleared', async () => {
    const clock = createFakeClock()
    let resolveRun!: (v: string) => void
    const pending = runTrackedSideQuestion<string>({
      question: 'answered-q',
      run: () =>
        new Promise<string>(resolve => {
          resolveRun = resolve
        }),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    clock.advance(600000) // 10 min — under the deadline
    resolveRun('the answer')
    const outcome = await pending
    expect(outcome).toEqual({ type: 'answer', value: 'the answer' })
    expect(clock.liveTimers).toBe(0)
    expect(getPendingSideQuestionCount()).toBe(0)
  })
})

describe('runTrackedSideQuestion — #105b in-flight dedupe', () => {
  test('an identical in-flight question is adopted, not run twice', async () => {
    const clock = createFakeClock()
    let runCount = 0
    let resolveRun!: (v: string) => void
    const deps = {
      question: 'dedupe-q',
      run: () => {
        runCount++
        return new Promise<string>(resolve => {
          resolveRun = resolve
        })
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    }
    const first = runTrackedSideQuestion<string>(deps)
    const second = runTrackedSideQuestion<string>(deps)

    resolveRun('shared answer')
    const [a, b] = await Promise.all([first, second])
    expect(runCount).toBe(1) // second request did NOT start a second run
    expect(a).toEqual({ type: 'answer', value: 'shared answer' })
    expect(b).toEqual(a) // adopter awaits the in-flight outcome
    expect(getPendingSideQuestionCount()).toBe(0)
  })

  test('a different question runs separately', async () => {
    const clock = createFakeClock()
    const started: string[] = []
    const resolvers: Array<(v: string) => void> = []
    const make = (question: string) =>
      runTrackedSideQuestion<string>({
        question,
        run: () => {
          started.push(question)
          return new Promise<string>(resolve => {
            resolvers.push(resolve)
          })
        },
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      })
    const p1 = make('q-one')
    const p2 = make('q-two')
    expect(started).toEqual(['q-one', 'q-two'])
    expect(getPendingSideQuestionCount()).toBe(2)
    resolvers[0]!('a1')
    resolvers[1]!('a2')
    expect(await p1).toEqual({ type: 'answer', value: 'a1' })
    expect(await p2).toEqual({ type: 'answer', value: 'a2' })
  })

  test('after settling, the same question runs again (registry cleared)', async () => {
    const clock = createFakeClock()
    let runCount = 0
    const make = () =>
      runTrackedSideQuestion<string>({
        question: 'reuse-q',
        run: () => {
          runCount++
          return Promise.resolve(`run-${runCount}`)
        },
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      })
    expect(await make()).toEqual({ type: 'answer', value: 'run-1' })
    expect(await make()).toEqual({ type: 'answer', value: 'run-2' })
    expect(runCount).toBe(2)
  })
})

describe('cancelAllPendingSideQuestions — #105a session end', () => {
  test('aborts a pending run → cancelled outcome, registry emptied', async () => {
    const clock = createFakeClock()
    let aborted = false
    const pending = runTrackedSideQuestion<string>({
      question: 'cancel-q',
      run: controller => {
        controller.signal.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<string>(() => {}) // ignores abort, never resolves
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })
    expect(getPendingSideQuestionCount()).toBe(1)

    cancelAllPendingSideQuestions()
    const outcome: SideQuestionOutcome<string> = await pending
    expect(outcome).toEqual({ type: 'cancelled' })
    expect(aborted).toBe(true)
    expect(clock.liveTimers).toBe(0) // timeout timer cleared
    expect(getPendingSideQuestionCount()).toBe(0)
  })

  test('a run rejecting with an abort error maps to cancelled, not error', async () => {
    const clock = createFakeClock()
    const pending = runTrackedSideQuestion<string>({
      question: 'abort-reject-q',
      run: controller =>
        new Promise<string>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('This operation was aborted'))
          })
        }),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })
    cancelAllPendingSideQuestions()
    expect(await pending).toEqual({ type: 'cancelled' })
  })

  test('cancels ALL pending questions across different questions', async () => {
    const clock = createFakeClock()
    const make = (question: string) =>
      runTrackedSideQuestion<string>({
        question,
        run: () => new Promise<string>(() => {}),
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      })
    const p1 = make('multi-a')
    const p2 = make('multi-b')
    expect(getPendingSideQuestionCount()).toBe(2)
    cancelAllPendingSideQuestions()
    expect(await p1).toEqual({ type: 'cancelled' })
    expect(await p2).toEqual({ type: 'cancelled' })
    expect(getPendingSideQuestionCount()).toBe(0)
  })
})

describe('runTrackedSideQuestion — error passthrough', () => {
  test('a non-abort run failure surfaces as error', async () => {
    const clock = createFakeClock()
    const boom = new Error('api exploded')
    const outcome = await runTrackedSideQuestion<string>({
      question: 'error-q',
      run: () => Promise.reject(boom),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })
    expect(outcome).toEqual({ type: 'error', error: boom })
    expect(getPendingSideQuestionCount()).toBe(0)
  })
})
