import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  monitorCompletedSummary,
  readMonitorOutputBytes,
} from '../LocalShellTask.js'

/**
 * 2.1.221: "Changed Monitor: a watch that exits without producing any output
 * now says so instead of reporting 'stream ended'". Official binary qZs:
 *   completed → o === 0
 *     ? `Monitor "${t}" ended without producing output${i}`  // i = ` (exit N)` or ''
 *     : `Monitor "${t}" stream ended`
 *
 * CONTRACT tests of the faithful qZs port. Note (acceptance follow-up): the
 * `kind === 'monitor'` branch these back is STRUCTURAL-ONLY / dormant in the
 * shipped build — OCC's MonitorTool uses a side-channel emitter and does not
 * register a LocalShellTask, so no production path reaches it yet. These tests
 * pin the contract so it is ready when a producer is wired.
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

describe('2.1.221: readMonitorOutputBytes (output-count signal)', () => {
  test('existing file → its byte size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-monitor-out-'))
    try {
      const p = join(dir, 'out.txt')
      writeFileSync(p, 'hello\n') // 6 bytes
      expect(readMonitorOutputBytes(p)).toBe(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('missing file (ENOENT) → 0 (genuinely zero output)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-monitor-out-'))
    try {
      expect(readMonitorOutputBytes(join(dir, 'does-not-exist.txt'))).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('empty file → 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-monitor-out-'))
    try {
      const p = join(dir, 'empty.txt')
      writeFileSync(p, '')
      expect(readMonitorOutputBytes(p)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
