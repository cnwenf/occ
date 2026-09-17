/**
 * CC 2.1.274 review P2-2 (docs/upstream-version-gap-occ128.md): the
 * `occ mcp login --no-browser` paste prompt must RETRY on a rejected
 * (wrong-state) URL — the 274 submitter returns false and the flow keeps
 * waiting. The pre-fix single-shot question discarded the boolean and
 * closed the readline, silently hanging until the 5-minute flow timeout.
 */
import { describe, expect, test } from 'bun:test'

import {
  CALLBACK_REJECTED_RETRY_HINT,
  promptForCallbackUrlWithRetry,
  type CallbackPromptIO,
} from '../mcpOAuthPrompt.js'

/** Scripted IO: answers are consumed one per question; an empty queue stops the loop. */
function makeFakeIO(answers: readonly string[]): {
  io: CallbackPromptIO
  asked: string[]
  notified: string[]
  closeCount: () => number
} {
  const queue = [...answers]
  const asked: string[] = []
  const notified: string[] = []
  let closeCount = 0
  const io: CallbackPromptIO = {
    question: (prompt, onAnswer) => {
      asked.push(prompt)
      const next = queue.shift()
      if (next !== undefined) {
        onAnswer(next)
      }
      // Queue exhausted: simulate the user not typing — the loop must simply
      // stay pending (flow still waiting), never close on its own.
    },
    close: () => {
      closeCount += 1
    },
    notify: message => {
      notified.push(message)
    },
  }
  return { io, asked, notified, closeCount: () => closeCount }
}

describe('2.1.274 mcp login --no-browser paste prompt (review P2-2)', () => {
  test('accepted URL closes the prompt with no retry hint', () => {
    // Arrange
    const fake = makeFakeIO(['  http://localhost:9/cb?code=a&state=S  '])
    const submitted: string[] = []

    // Act
    promptForCallbackUrlWithRetry(fake.io, url => {
      submitted.push(url)
      return true
    })

    // Assert: trimmed URL passed through, closed exactly once, no hint.
    expect(submitted).toEqual(['http://localhost:9/cb?code=a&state=S'])
    expect(fake.closeCount()).toBe(1)
    expect(fake.notified).toEqual([])
    expect(fake.asked).toEqual(['> '])
  })

  test('rejected URL re-prompts with the retry hint and keeps the flow waiting', () => {
    // Arrange: first paste wrong-state (rejected), second paste accepted.
    const fake = makeFakeIO([
      'http://localhost:9/cb?code=a&state=WRONG',
      'http://localhost:9/cb?code=a&state=RIGHT',
    ])
    const submitted: string[] = []

    // Act
    promptForCallbackUrlWithRetry(fake.io, url => {
      submitted.push(url)
      return url.includes('state=RIGHT')
    })

    // Assert: both URLs reached the submitter, hint shown once between them,
    // prompt closed only after acceptance.
    expect(submitted).toEqual([
      'http://localhost:9/cb?code=a&state=WRONG',
      'http://localhost:9/cb?code=a&state=RIGHT',
    ])
    expect(fake.notified).toEqual([CALLBACK_REJECTED_RETRY_HINT])
    expect(fake.asked).toEqual(['> ', '> '])
    expect(fake.closeCount()).toBe(1)
  })

  test('repeated rejections never close the prompt (no silent hang regression)', () => {
    // Arrange: every paste rejected, then input stops.
    const fake = makeFakeIO([
      'http://x/cb?code=a&state=1',
      'http://x/cb?code=a&state=2',
    ])

    // Act
    promptForCallbackUrlWithRetry(fake.io, () => false)

    // Assert: re-prompted after each rejection with the hint each time;
    // close() NEVER called — pre-fix this is where the readline closed and
    // the flow hung silently until the 5-minute timeout.
    expect(fake.asked).toEqual(['> ', '> ', '> '])
    expect(fake.notified).toEqual([
      CALLBACK_REJECTED_RETRY_HINT,
      CALLBACK_REJECTED_RETRY_HINT,
    ])
    expect(fake.closeCount()).toBe(0)
  })
})
