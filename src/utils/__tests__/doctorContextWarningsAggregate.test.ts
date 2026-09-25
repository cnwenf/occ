import { describe, expect, test } from 'bun:test'
import {
  buildClaudeMdWarningMessage,
  computeInstructionFilesAggregate,
  type InstructionFilesAggregate,
} from '../doctorContextWarnings.js'
import { formatNumber } from '../format.js'
import {
  getMemoryCharThreshold,
  getMemoryTotalCharThreshold,
} from '../memoryThreshold.js'

/**
 * Pinning tests for the CC 2.1.281 #119 aggregate instruction-files notice
 * (src/utils/doctorContextWarnings.ts).
 *
 * Official v281 evidence (byte-verified against the linux-x64 ELF):
 *   `t2r` @217358179 pushes ONE aggregate line before the per-file lines:
 *     `Instruction files will impact performance: ${fileCount} files,
 *       ${ns(totalChars)} chars in total > ${ns(totalLimitChars)}`
 *   `Rwt` @201061197: gate = sum of files NOT over the per-file limit,
 *     fired when that sum > totalLimitChars; `ret` @201060858: displayed
 *     fileCount/totalChars span ALL files. `Jbn` @201041784:
 *     totalLimitChars = max(120000, perFileLimit). v280 `qOr` @215479719 had
 *     per-file lines only (the aggregate string is 0 hits in v280, 2 in v281).
 *   `ns` @193879912 ≡ OCC formatNumber (compact, lowercased).
 */

// A 200k-token context → per-file threshold 40000, aggregate floor 120000.
const PER_FILE = getMemoryCharThreshold(200000)

function files(sizes: number[]): { path: string; content: string }[] {
  return sizes.map((n, i) => ({ path: `f${i}.md`, content: 'x'.repeat(n) }))
}

describe('#119 computeInstructionFilesAggregate — Rwt/Jbn port', () => {
  test('per-file threshold and aggregate floor match official constants', () => {
    expect(PER_FILE).toBe(40000)
    expect(getMemoryTotalCharThreshold(PER_FILE)).toBe(120000)
    // The aggregate floor never drops below the per-file limit.
    expect(getMemoryTotalCharThreshold(200000)).toBe(200000)
  })

  test('returns null when the aggregate is under the total limit', () => {
    // 2 files × 30000 = 60000 <= 120000 → no aggregate notice.
    expect(computeInstructionFilesAggregate(files([30000, 30000]), PER_FILE)).toBeNull()
  })

  test('returns null right at the total limit (boundary is strictly >)', () => {
    // 4 files × 30000 = 120000, NOT > 120000 → null (official `<= → null`).
    expect(
      computeInstructionFilesAggregate(files([30000, 30000, 30000, 30000]), PER_FILE),
    ).toBeNull()
  })

  test('fires when files together exceed the total limit', () => {
    // 5 files × 30000 = 150000 > 120000.
    const result = computeInstructionFilesAggregate(
      files([30000, 30000, 30000, 30000, 30000]),
      PER_FILE,
    )
    expect(result).not.toBeNull()
    expect(result!.fileCount).toBe(5)
    expect(result!.totalChars).toBe(150000)
    expect(result!.totalLimitChars).toBe(120000)
  })

  test('gate EXCLUDES per-file-over files but display INCLUDES them', () => {
    // One 50000 file (> 40000 per-file limit) + five sub-limit files.
    // Gate sum = 30000*4 + 20000 = 140000 > 120000 → fires.
    // Displayed totalChars = 50000 + 140000 = 190000 (ALL files), fileCount=6.
    const result = computeInstructionFilesAggregate(
      files([50000, 30000, 30000, 30000, 30000, 20000]),
      PER_FILE,
    )
    expect(result).not.toBeNull()
    expect(result!.fileCount).toBe(6)
    expect(result!.totalChars).toBe(190000)
    expect(result!.totalLimitChars).toBe(120000)
  })

  test('a single huge file does NOT trigger the aggregate on its own', () => {
    // One file over the per-file limit, nothing else: gate sum = 0 (the only
    // file is excluded) → 0 <= 120000 → null. It gets its own per-file warning.
    expect(computeInstructionFilesAggregate(files([50000]), PER_FILE)).toBeNull()
  })
})

describe('#119 buildClaudeMdWarningMessage — aggregate line placement', () => {
  const AGGREGATE: InstructionFilesAggregate = {
    fileCount: 6,
    totalChars: 190000,
    totalLimitChars: 120000,
  }
  const AGGREGATE_LINE = `Instruction files will impact performance: 6 files, ${formatNumber(190000)} chars in total > ${formatNumber(120000)}`

  test('emits the aggregate line BEFORE the per-file line when over limit', () => {
    const largeFiles = files([50000])
    const message = buildClaudeMdWarningMessage(largeFiles, 0, AGGREGATE, PER_FILE)
    expect(message).toContain('Instruction files will impact performance')
    // Aggregate first, per-file after.
    expect(message.indexOf('Instruction files will impact performance')).toBeLessThan(
      message.indexOf('Large CLAUDE.md file'),
    )
    expect(message.startsWith(AGGREGATE_LINE)).toBe(true)
    // Per-file line is unchanged and still present, joined by '; '.
    expect(message).toContain(
      `Large CLAUDE.md file detected (${(50000).toLocaleString()} chars > ${(40000).toLocaleString()})`,
    )
  })

  test('aggregate line precedes derivable-sections line too', () => {
    const message = buildClaudeMdWarningMessage([], 2, AGGREGATE, PER_FILE)
    expect(message.indexOf('Instruction files will impact performance')).toBeLessThan(
      message.indexOf('content Claude could derive'),
    )
  })

  test('no aggregate line when under limit (aggregate === null)', () => {
    const message = buildClaudeMdWarningMessage(files([50000]), 0, null, PER_FILE)
    expect(message).not.toContain('Instruction files will impact performance')
    expect(message).toContain('Large CLAUDE.md file detected')
  })

  test('uses formatNumber (≡ official ns) for the aggregate char counts', () => {
    expect(AGGREGATE_LINE).toContain(`${formatNumber(190000)} chars in total`)
    expect(AGGREGATE_LINE).toContain(`> ${formatNumber(120000)}`)
    // Sanity: formatNumber renders compact lowercased ("190.0k", "120.0k").
    expect(formatNumber(190000)).toBe('190.0k')
    expect(formatNumber(120000)).toBe('120.0k')
  })
})
