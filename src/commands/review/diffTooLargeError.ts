/**
 * CC 2.1.216 #32 — `/ultrareview` diff-too-large error.
 *
 * The bare "Repo is too large" message gave the user nothing actionable.
 * The improved error surfaces:
 *   1. the configured size limit (the bundle max bytes — the only size limit
 *      OCC enforces on this path, GrowthBook-tunable via
 *      `tengu_ccr_bundle_max_bytes`),
 *   2. the measured diff size (files changed + insertions/deletions against
 *      the fork point), and
 *   3. the largest contributing files (by changed lines), so the user knows
 *      what to split out before retrying.
 *
 * Pure formatter + git-collecting helper (dependency-injected exec). The git
 * collector uses only `--shortstat` / `--numstat` (tiny output) — never reads
 * the full diff into memory, which would OOM on the very diffs that trigger
 * this error.
 */

import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { gitExe } from '../../utils/git.js'
import {
  DEFAULT_BUNDLE_MAX_BYTES,
  getBundleMaxBytes,
} from '../../utils/teleport/gitBundle.js'

export { DEFAULT_BUNDLE_MAX_BYTES }

export const DIFF_TOO_LARGE_TOP_FILES = 5

export type DiffFileContribution = { path: string; linesChanged: number }

export type DiffTooLargeStats = {
  filesChanged: number
  insertions: number
  deletions: number
  largestFiles: DiffFileContribution[]
}

export type DiffTooLargeDeps = {
  /** Run a git subcommand and return its stdout + exit code. */
  exec?: (args: string[]) => Promise<{ stdout: string; code: number }>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/**
 * Format the diff-too-large error message. Pure — no git, no I/O.
 */
export function formatDiffTooLargeError(opts: {
  configuredLimitBytes: number
  stats: DiffTooLargeStats
}): string {
  const { configuredLimitBytes, stats } = opts
  const lines: string[] = [
    `Ultrareview cannot launch: the diff is too large.`,
    `Configured limit: ${formatBytes(configuredLimitBytes)} (tengu_ccr_bundle_max_bytes).`,
    `Measured diff: ${stats.filesChanged} files changed, ${stats.insertions} insertions(+), ${stats.deletions} deletions(-).`,
  ]
  if (stats.largestFiles.length > 0) {
    lines.push('Largest contributing files:')
    for (const f of stats.largestFiles) {
      lines.push(`  ${f.path} (${f.linesChanged} changed lines)`)
    }
  }
  lines.push(
    'Push a PR and use `/ultrareview <PR#>` instead, or split the branch into smaller commits.',
  )
  return lines.join('\n')
}

/**
 * Parse `git diff --numstat <sha>` output into per-file changed-line counts,
 * sorted largest-first, capped at `DIFF_TOO_LARGE_TOP_FILES`.
 *
 * numstat lines look like `<added>\t<deleted>\t<path>` (binary files show
 * `-`\t`-`\t`<path>`).
 */
export function parseNumstatTopFiles(
  numstatStdout: string,
  limit = DIFF_TOO_LARGE_TOP_FILES,
): DiffFileContribution[] {
  const rows: DiffFileContribution[] = []
  for (const line of numstatStdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = Number(parts[0])
    const deleted = Number(parts[1])
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue
    rows.push({ path: parts.slice(2).join('\t'), linesChanged: added + deleted })
  }
  rows.sort((a, b) => b.linesChanged - a.linesChanged)
  return rows.slice(0, limit)
}

/**
 * Parse `git diff --shortstat` output: "X files changed, Y insertions(+), Z deletions(-)".
 * Returns zeros on a non-matching line (defensive).
 */
export function parseShortstat(stdout: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  const filesMatch = stdout.match(/(\d+) files? changed/)
  const insMatch = stdout.match(/(\d+) insertions?\(\+\)/)
  const delMatch = stdout.match(/(\d+) deletions?\(-\)/)
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  }
}

/**
 * Measure the diff against the fork point using only small-output git
 * commands (`--shortstat` + `--numstat`). Never reads the full diff into
 * memory. Dependency-injected for tests.
 */
export async function collectDiffTooLargeStats(
  mergeBaseSha: string,
  deps: DiffTooLargeDeps = {},
): Promise<DiffTooLargeStats> {
  const exec =
    deps.exec ??
    (async (args: string[]) => {
      const r = await execFileNoThrow(gitExe(), args, {
        preserveOutputOnError: false,
      })
      return { stdout: r.stdout, code: r.code }
    })

  const shortRes = await exec(['diff', '--shortstat', mergeBaseSha])
  const { filesChanged, insertions, deletions } =
    shortRes.code === 0 ? parseShortstat(shortRes.stdout) : { filesChanged: 0, insertions: 0, deletions: 0 }

  const numstatRes = await exec(['diff', '--numstat', mergeBaseSha])
  const largestFiles =
    numstatRes.code === 0 ? parseNumstatTopFiles(numstatRes.stdout) : []

  return { filesChanged, insertions, deletions, largestFiles }
}

export function configuredDiffLimitBytes(): number {
  return getBundleMaxBytes()
}
