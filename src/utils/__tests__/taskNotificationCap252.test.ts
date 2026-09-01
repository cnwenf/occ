import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearCommandQueue,
  enqueue,
  enqueuePendingNotification,
  getCommandQueueSnapshot,
} from '../messageQueueManager.js'

// Official Claude Code 2.1.252 (OCC-112 Gap-112c / changelog item 4):
// background task notifications carrying very large failure output could
// push the conversation past the API request size limit. The official queue
// caps task-notification STRING values (mode === 'task-notification') at
// 100k chars with a middle-truncation marker BEFORE enqueueing.

const CAP = 100_000
const SLACK = 1024

describe('enqueuePendingNotification task-notification cap (2.1.252)', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  afterEach(() => {
    clearCommandQueue()
  })

  test('caps an oversized task-notification value with the marker', () => {
    // Arrange — a very large failure output (e.g. git error on full disk)
    const oversized = `fatal: unable to write\n` + 'E'.repeat(200_000)

    // Act
    enqueuePendingNotification({ value: oversized, mode: 'task-notification' })

    // Assert
    const snapshot = getCommandQueueSnapshot()
    expect(snapshot).toHaveLength(1)
    const queued = snapshot[0]!
    expect(typeof queued.value).toBe('string')
    const queuedValue = queued.value as string
    expect(queuedValue.length).toBeLessThan(oversized.length)
    // head + tail + marker shape
    expect(queuedValue.startsWith('fatal: unable to write\n')).toBe(true)
    expect(queuedValue).toMatch(/\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/)
    expect(queuedValue.endsWith('EEEEE')).toBe(true)
    // close to the cap (cap + marker length)
    expect(queuedValue.length).toBeLessThanOrEqual(CAP + 60)
    // priority still defaults to 'later'
    expect(queued.priority).toBe('later')
  })

  test('leaves a within-slack task-notification untouched', () => {
    // Arrange — exactly cap + slack passes through
    const withinSlack = 'x'.repeat(CAP + SLACK)

    // Act
    enqueuePendingNotification({ value: withinSlack, mode: 'task-notification' })

    // Assert
    const snapshot = getCommandQueueSnapshot()
    expect(snapshot[0]!.value).toBe(withinSlack)
  })

  test('does not touch non-task-notification modes', () => {
    // Arrange — a user prompt with the same oversized value
    const oversized = 'p'.repeat(200_000)

    // Act
    enqueue({ value: oversized, mode: 'prompt' })

    // Assert — raw value preserved (only task-notifications are capped)
    expect(getCommandQueueSnapshot()[0]!.value).toBe(oversized)
  })

  test('does not touch non-string task-notification values', () => {
    // Arrange — structured content blocks pass through untouched
    const blocks = [{ type: 'text', text: 'E'.repeat(200_000) }]

    // Act
    enqueuePendingNotification({
      value: blocks as never,
      mode: 'task-notification',
    })

    // Assert — reference-identical content blocks
    expect(getCommandQueueSnapshot()[0]!.value).toEqual(blocks)
  })

  test('keeps the original command object immutable when capping', () => {
    // Arrange
    const oversized = 'z'.repeat(200_000)
    const command = { value: oversized, mode: 'task-notification' as const }

    // Act
    enqueuePendingNotification(command)

    // Assert — the caller's command is not mutated in place
    expect(command.value).toBe(oversized)
    expect(getCommandQueueSnapshot()[0]!.value).not.toBe(oversized)
  })
})
