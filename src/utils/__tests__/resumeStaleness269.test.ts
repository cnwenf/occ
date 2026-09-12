import { afterEach, describe, expect, test } from 'bun:test'
import { deserializeMessagesWithInterruptDetection } from '../conversationRecovery.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '../messages.js'
import type { Message } from '../../types/message.js'

/**
 * Official Claude Code 2.1.269 (OCC-123 E40): resume staleness gates on the
 * interrupted-turn detection. Binary v269 evidence:
 *
 * ```js
 * // env parser (sHn):
 * function sHn(){let e=a.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS;
 *   if(!e)return;                                   // unset → undefined
 *   let n=Number(e);
 *   if(n===0)return 0;                              // 0 disables the check
 *   return Number.isFinite(n)&&n>0?n:3600000}       // garbage → 1 h
 * // default bound (W6o, statsig gate trimmed): 21600000 (6 h)
 * // row staleness (G6o): !Number.isFinite(t)||Math.abs(Date.now()-t)>=maxAge
 * // gates (De/et) suppress a detected interruption to {kind:"none"}:
 * //   De = qUn(messages) — env-gated TAIL staleness (false when env unset/0)
 * //   et = skipped api-error tail row vs the W6o bound (default 6 h)
 * if(Ze||De||et)mt={kind:"none"}
 * ```
 *
 * OCC surface: `applyResumeStalenessGates()` inside
 * `deserializeMessagesWithInterruptDetection` (src/utils/conversationRecovery.ts).
 * These tests drive the exported entry point — no private-function access.
 */

const ENV_KEY = 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS'

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function userAt(content: string, timestamp: string): Message {
  return {
    ...(createUserMessage({ content }) as unknown as Message),
    timestamp,
  } as Message
}

function assistantAt(content: string, timestamp: string): Message {
  return {
    ...(createAssistantMessage({ content }) as unknown as Message),
    timestamp,
  } as Message
}

function apiErrorAt(content: string, timestamp: string): Message {
  return {
    ...(createAssistantAPIErrorMessage({ content }) as unknown as Message),
    timestamp,
  } as Message
}

function detectKind(transcript: Message[]): string {
  return deserializeMessagesWithInterruptDetection(transcript)
    .turnInterruptionState.kind
}

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('2.1.269 E40 De gate — env-gated tail staleness', () => {
  test('env unset: stale tail (48 h) is NOT suppressed (De is env-gated)', () => {
    // Arrange — the default 6 h bound applies only to the et api-error gate;
    // with the env unset the tail gate is inert no matter how old the tail is.
    const transcript = [
      assistantAt('hi there', isoAgo(48 * 3600_000)),
      userAt('do the task', isoAgo(48 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('interrupted_prompt')
  })

  test('env=0: disables the age check — stale tail (48 h) still resumes', () => {
    // Arrange — binary sHn: `if(n===0)return 0` and qUn: `if(!maxAge)return!1`.
    process.env[ENV_KEY] = '0'
    const transcript = [
      assistantAt('hi there', isoAgo(48 * 3600_000)),
      userAt('do the task', isoAgo(48 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('interrupted_prompt')
  })

  test('env=1000: tail 2 s old → suppressed to none', () => {
    // Arrange — Date.now() - t >= 1000 ms.
    process.env[ENV_KEY] = '1000'
    const transcript = [
      assistantAt('hi there', isoAgo(2000)),
      userAt('do the task', isoAgo(2000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('none')
  })

  test('env=1000: fresh tail → not suppressed', () => {
    // Arrange
    process.env[ENV_KEY] = '1000'
    const transcript = [
      assistantAt('hi there', new Date().toISOString()),
      userAt('do the task', new Date().toISOString()),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('interrupted_prompt')
  })

  test('env=abc (garbage → 1 h bound): tail 2 h old → suppressed', () => {
    // Arrange — binary sHn: non-finite/non-positive → 3600000.
    process.env[ENV_KEY] = 'abc'
    const transcript = [
      assistantAt('hi there', isoAgo(2 * 3600_000)),
      userAt('do the task', isoAgo(2 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('none')
  })

  test('env=abc (garbage → 1 h bound): tail 10 min old → not suppressed', () => {
    // Arrange
    process.env[ENV_KEY] = 'abc'
    const transcript = [
      assistantAt('hi there', isoAgo(10 * 60_000)),
      userAt('do the task', isoAgo(10 * 60_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('interrupted_prompt')
  })
})

describe('2.1.269 E40 et gate — skipped api-error tail row vs the 6 h default bound', () => {
  test('env unset: api-error tail 7 h old → suppressed to none', () => {
    // Arrange — detectTurnInterruption skips the synthetic api-error
    // assistant (last relevant = the user prompt → interrupted_prompt);
    // findSkippedTailApiErrorRow then finds the api-error row and the et gate
    // compares it against W6o's 21_600_000 ms default.
    const transcript = [
      userAt('do the task', isoAgo(7 * 3600_000)),
      apiErrorAt('API Error: connection reset', isoAgo(7 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('none')
  })

  test('env unset: api-error tail 1 h old → not suppressed', () => {
    // Arrange
    const transcript = [
      userAt('do the task', isoAgo(3600_000)),
      apiErrorAt('API Error: connection reset', isoAgo(3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('interrupted_prompt')
  })

  test('env=0: De gate disabled, but et bound falls through to the 6 h default', () => {
    // Arrange — binary W6o: `let e=sHn();if(e)return{maxAgeMs:e,source:"env"}`
    // — sHn()===0 is FALSY, so the et bound falls through to B6o=21600000
    // (NOT 0). A 7 h old api-error tail is therefore still stale under env=0.
    process.env[ENV_KEY] = '0'
    const transcript = [
      userAt('do the task', isoAgo(7 * 3600_000)),
      apiErrorAt('API Error: connection reset', isoAgo(7 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('none')
  })

  test('env=abc (garbage → 1 h env bound): api-error tail 2 h old → suppressed', () => {
    // Arrange — sHn('abc') → 3600000, truthy → W6o returns {3600000,'env'};
    // G6o: |now - t| >= 3600000 for a 2 h old row → stale.
    process.env[ENV_KEY] = 'abc'
    const transcript = [
      userAt('do the task', isoAgo(2 * 3600_000)),
      apiErrorAt('API Error: connection reset', isoAgo(2 * 3600_000)),
    ]

    // Act / Assert
    expect(detectKind(transcript)).toBe('none')
  })
})
