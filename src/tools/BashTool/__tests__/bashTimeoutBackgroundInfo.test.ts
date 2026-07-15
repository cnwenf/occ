import { describe, expect, test } from 'bun:test'
import { BashTool, type Out } from '../BashTool.js'

/**
 * #26 (2.1.210): "Improved Bash/PowerShell tool message when command hits
 * timeout and is auto-backgrounded."
 *
 * Verified against the official 2.1.210 binary chain (variable `p`, the main
 * renderer; `y` is the identical second renderer):
 *   if(a) p = `Command was manually backgrounded by user...`     // a = backgroundedByUser
 *   else if(l!==void 0) p = `Command did not complete within its ${...}s timeout...`  // l = timedOutAfterMs (NEW)
 *   else p = `Command running in background with ID...`          // generic
 * So precedence: backgroundedByUser > timedOutAfterMs > generic.
 *
 * Full timeout message (binary, Mi="Read"):
 *   "Command did not complete within its ${Math.max(1,Math.round(l/1000))}s
 *   timeout and was moved to the background (ID: ${s}). Output is being written
 *   to: ${f}. You will be notified when it completes. To check interim output,
 *   use Read on that file path."
 *
 * This UT calls the real mapToolResultToToolResultBlockParam (not source-grep):
 * it exercises the actual branch chain + Math.max(1,...) guard + precedence.
 */

const TIMEOUT_PHRASE = 'did not complete within its'
const MANUAL_PHRASE = 'was manually backgrounded by user'
const GENERIC_PHRASE = 'Command running in background with ID'

type MappedResult = { content: string; is_error: boolean }

function mapResult(over: Partial<Out> = {}): MappedResult {
  // Build a full Out with the minimum required fields; override with the test
  // case's values. Cast through unknown because Out has many optional fields
  // the mapper doesn't read for the backgroundInfo branch.
  const full = {
    stdout: '',
    stderr: '',
    interrupted: false,
    ...over,
  } as unknown as Out
  return (BashTool as {
    mapToolResultToToolResultBlockParam: (r: Out, id: string) => MappedResult
  }).mapToolResultToToolResultBlockParam(full, 'tu-test-26')
}

describe('2.1.210 #26 — Bash timeout auto-background message', () => {
  test('emits the timeout message when timedOutAfterMs is set', () => {
    // Arrange — command timed out after 3000ms and was auto-backgrounded.
    // Act
    const result = mapResult({
      backgroundTaskId: 'bash_test_bg',
      timedOutAfterMs: 3000,
    })
    // Assert — model sees the timeout-specific message (not the generic one).
    expect(result.content).toContain(TIMEOUT_PHRASE)
    expect(result.content).toContain('3s timeout')
    expect(result.content).toContain('(ID: bash_test_bg)')
    // "use Read on that file path" — the Mi="Read" reference in the binary.
    expect(result.content).toContain('use Read on that file path')
    // Generic message suppressed (timeout branch won, not the else).
    expect(result.content).not.toContain(GENERIC_PHRASE)
  })

  test('floors sub-second timeout to 1s via Math.max(1, round(ms/1000))', () => {
    // Arrange — 100ms timeout. Binary: Math.max(1, Math.round(100/1000))
    // = Math.max(1, 0) = 1. Never "0s" — the floor guard prevents a "0s
    // timeout" message that would confuse the model.
    const result = mapResult({
      backgroundTaskId: 'bg',
      timedOutAfterMs: 100,
    })
    expect(result.content).toContain('1s timeout')
    expect(result.content).not.toContain('0s timeout')
  })

  test('rounds 1500ms up to 2s', () => {
    // Arrange — Math.round(1500/1000) = Math.round(1.5) = 2
    const result = mapResult({
      backgroundTaskId: 'bg',
      timedOutAfterMs: 1500,
    })
    expect(result.content).toContain('2s timeout')
  })

  test('backgroundedByUser takes precedence over timedOutAfterMs (binary order)', () => {
    // Arrange — both flags set. Binary chain checks backgroundedByUser FIRST
    // (if(a) ... else if(l!==void 0) ...), so the manual message wins.
    const result = mapResult({
      backgroundTaskId: 'bg',
      backgroundedByUser: true,
      timedOutAfterMs: 3000,
    })
    // Assert — manual message, timeout + generic suppressed.
    expect(result.content).toContain(MANUAL_PHRASE)
    expect(result.content).not.toContain(TIMEOUT_PHRASE)
    expect(result.content).not.toContain(GENERIC_PHRASE)
  })

  test('falls through to generic message when backgrounded without timeout', () => {
    // Arrange — backgrounded (e.g. explicit run_in_background) but neither by
    // user nor timeout.
    const result = mapResult({
      backgroundTaskId: 'bg',
    })
    // Assert — generic message; no timeout phrase.
    expect(result.content).toContain(GENERIC_PHRASE)
    expect(result.content).not.toContain(TIMEOUT_PHRASE)
    expect(result.content).not.toContain(MANUAL_PHRASE)
  })

  test('no backgroundInfo when not backgrounded (no backgroundTaskId)', () => {
    // Arrange — normal completion. timedOutAfterMs is ignored because the
    // whole backgroundInfo block is guarded by `if (backgroundTaskId)`.
    const result = mapResult({
      backgroundTaskId: undefined,
      timedOutAfterMs: 3000,
    })
    // Assert — none of the background messages appear.
    expect(result.content).not.toContain(TIMEOUT_PHRASE)
    expect(result.content).not.toContain(GENERIC_PHRASE)
    expect(result.content).not.toContain(MANUAL_PHRASE)
  })
})
