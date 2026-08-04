import { describe, expect, test } from 'bun:test'
import { monitorCompletedSummary } from '../LocalShellTask.js'

/**
 * 2.1.221: "Changed Monitor: a watch that exits without producing any output
 * now says so instead of reporting 'stream ended'". Official binary qZs:
 *   completed → o === 0
 *     ? `Monitor "${t}" ended without producing output${i}`  // i = ` (exit N)` or ''
 *     : `Monitor "${t}" stream ended`
 */
describe('2.1.221: Monitor no-output completion message', () => {
  test('zero output → says so (no exit code known)', () => {
    expect(monitorCompletedSummary('deploy.log watch', undefined, 0)).toBe(
      'Monitor "deploy.log watch" ended without producing output',
    )
  })
  test('zero output with exit code → carries the exit suffix', () => {
    expect(monitorCompletedSummary('ci checks', 3, 0)).toBe(
      'Monitor "ci checks" ended without producing output (exit 3)',
    )
  })
  test('zero exit code is still reported (exit 0 suffix)', () => {
    expect(monitorCompletedSummary('w', 0, 0)).toBe(
      'Monitor "w" ended without producing output (exit 0)',
    )
  })
  test('nonzero output → plain "stream ended" (no exit suffix)', () => {
    expect(monitorCompletedSummary('deploy.log watch', 0, 128)).toBe(
      'Monitor "deploy.log watch" stream ended',
    )
  })
  test('unknown output (undefined) → plain "stream ended"', () => {
    expect(monitorCompletedSummary('w', 1, undefined)).toBe(
      'Monitor "w" stream ended',
    )
  })
})
